#!/usr/bin/env node
'use strict';

/**
 * Operator console for the Telegram marketing publisher.
 *
 * WHY THIS EXISTS: the pause / dry-run switches live in
 * public.telegram_marketing_control (singleton row 1, service_role-only RLS) and
 * are normally written through POST /api/admin/marketing/control, which needs an
 * admin browser session. This script performs the SAME two writes with the
 * service credential the service already holds, from the host shell (Render:
 * the web or worker service -> Shell tab), so nobody has to extract a browser
 * token. It reuses the production code paths - createMarketingStore(),
 * resolveMarketingConfig(), buildStartHereRow() - and invents no new access.
 *
 * Usage (run where SUPABASE_URL + SUPABASE_SERVICE_KEY are set):
 *   node scripts/marketing-control.js status
 *   node scripts/marketing-control.js status --json
 *   node scripts/marketing-control.js enable --confirm
 *   node scripts/marketing-control.js enable --confirm --allow-backlog
 *   node scripts/marketing-control.js pause
 *   node scripts/marketing-control.js start-here
 *   node scripts/marketing-control.js start-here --dry
 *   node scripts/marketing-control.js start-here --scheduled-for 2026-10-31T10:00:00.000Z
 *
 * SAFETY
 *   * Never prints a Supabase key, a bot token, a chat id or a message body.
 *   * `enable` refuses without --confirm, and refuses while any queued post is
 *     already due (that backlog would publish on the first worker tick) unless
 *     --allow-backlog is passed after reviewing the list it prints.
 *   * `pause` is always allowed: it only ever removes publishing capability.
 *   * `start-here` only QUEUES (status 'scheduled'); it never sends or pins.
 *   * No SQL, no schema change, no new endpoint, no other table touched.
 *
 * EXIT CODES
 *   0  success
 *   1  usage or environment error
 *   2  refused by a safety precondition
 *   3  database/API error
 */

const { createMarketingStore } = require('../services/MarketingStore');
const {
  resolveMarketingConfig,
  describeMarketingConfig,
  workerHealth
} = require('../services/TelegramBroadcast');
const { buildStartHereRow } = require('../services/MarketingOnboarding');

const USAGE = [
  'usage: node scripts/marketing-control.js <status|enable|pause|start-here> [options]',
  '',
  '  status [--json]                    read-only: control row, queue, destinations',
  '  enable --confirm [--allow-backlog] live publishing (paused=false, dry_run=false)',
  '  pause                              stop publishing (paused=true)',
  '  start-here [--dry] [--locale en] [--scheduled-for ISO] [--created-by ID]',
  '                                     queue the Start Here guide (idempotent)'
].join('\n');

function envFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return { present: false, value: undefined };
  return { present: true, value: raw === 'true' };
}

function envLabel(name) {
  const flag = envFlag(name);
  if (!flag.present) return 'unset';
  return flag.value ? 'true' : 'false';
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token === '--confirm') args.confirm = true;
    else if (token === '--allow-backlog') args.allowBacklog = true;
    else if (token === '--dry') args.dry = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--locale') args.locale = argv[++i];
    else if (token === '--scheduled-for') args.scheduledFor = argv[++i];
    else if (token === '--created-by') args.createdBy = argv[++i];
    else args._.push(token);
  }
  return args;
}

function databaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  ).trim();
  return { url, key, ok: Boolean(url && key) };
}

function marketingFacts() {
  return {
    minDeposit: Number(process.env.MARKETING_FACT_MIN_DEPOSIT || 100),
    referralPercent: Number(process.env.MARKETING_FACT_REFERRAL_PERCENT || 20),
    promoCredit: Number(process.env.MARKETING_FACT_PROMO_CREDIT || 50)
  };
}

function buildStore(db) {
  // Required lazily so --help works even without the dependency installed.
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(db.url, db.key, { auth: { persistSession: false } });
  return createMarketingStore({ admin });
}

async function readState(store) {
  const control = await store.getControl();
  if (!control.ok) return { ok: false, reason: control.reason };

  const counts = await store.countByStatus();
  const posts = await store.listPosts({ limit: 200 });
  const due = await store.countDue();
  if (!posts.ok) return { ok: false, reason: posts.reason };

  return {
    ok: true,
    control: control.data,
    health: workerHealth(control.data),
    counts: counts.ok ? counts.data : null,
    countsError: counts.ok ? null : counts.reason,
    due: due.ok ? due.count : null,
    scheduled: posts.data.filter((p) => p.status === 'scheduled'),
    startHere: posts.data.filter((p) => p.kind === 'startHere'),
    total: posts.data.length
  };
}

function printState(state, config) {
  const c = state.control;
  const flags = describeMarketingConfig(config);
  console.log('environment (this process)');
  console.log('  TELEGRAM_MARKETING_ENABLED : ' + envLabel('TELEGRAM_MARKETING_ENABLED'));
  console.log('  TELEGRAM_MARKETING_DRY_RUN : ' + envLabel('TELEGRAM_MARKETING_DRY_RUN'));
  console.log('  destinations               : group=' + Boolean(flags.groupConfigured) +
    ' channel=' + Boolean(flags.channelConfigured));
  console.log('  announcement link          : ' + Boolean(flags.announcementUrlConfigured));
  console.log('');
  console.log('control row (telegram_marketing_control id=1)');
  console.log('  paused                     : ' + c.paused);
  console.log('  dry_run                    : ' + c.dry_run);
  console.log('  updated_at                 : ' + c.updated_at);
  console.log('  worker heartbeat           : ' + (state.health.healthy ? 'healthy' : 'stale/absent') +
    (state.health.ageMs === null ? '' : ' (' + Math.round(state.health.ageMs / 1000) + 's ago)'));
  console.log('');
  console.log('queue');
  console.log('  rows                       : ' + state.total);
  if (state.counts) {
    const parts = Object.keys(state.counts).sort().map((k) => k + '=' + state.counts[k]);
    console.log('  by status                  : ' + parts.join(' '));
  } else {
    console.log('  by status                  : unreadable (' + state.countsError + ')');
  }
  console.log('  scheduled / due now        : ' + state.scheduled.length + ' / ' + (state.due === null ? 'unknown' : state.due));
  console.log('  startHere rows             : ' + state.startHere.length);
  if (state.scheduled.length) {
    console.log('');
    console.log('  scheduled posts:');
    for (const p of state.scheduled) {
      const overdue = p.scheduled_for && new Date(p.scheduled_for).getTime() <= Date.now();
      console.log('    #' + p.id + '  ' + p.kind + '  audience=' + p.audience + '  locale=' + p.locale +
        '  at=' + p.scheduled_for + (overdue ? '  [DUE]' : ''));
    }
  }
}

async function cmdStatus(store, config, args) {
  const state = await readState(store);
  if (!state.ok) {
    console.error('ERROR: control row unreadable (' + state.reason + ') - is migration 038 applied?');
    return 3;
  }
  if (args.json) {
    console.log(JSON.stringify({
      control: { paused: state.control.paused, dryRun: state.control.dry_run, updatedAt: state.control.updated_at },
      worker: state.health,
      counts: state.counts,
      due: state.due,
      scheduled: state.scheduled.map((p) => ({ id: p.id, kind: p.kind, audience: p.audience, locale: p.locale, scheduled_for: p.scheduled_for })),
      startHere: state.startHere.map((p) => ({ id: p.id, status: p.status, locale: p.locale, scheduled_for: p.scheduled_for }))
    }, null, 2));
    return 0;
  }
  printState(state, config);
  return 0;
}

async function cmdEnable(store, config, args) {
  const flags = describeMarketingConfig(config);
  if (!flags.groupConfigured && !flags.channelConfigured) {
    console.error('REFUSED: no usable destination. Set TELEGRAM_MARKETING_CHAT_ID and/or TELEGRAM_ANNOUNCEMENT_CHAT_ID (numeric -100... ids).');
    return 2;
  }
  const state = await readState(store);
  if (!state.ok) {
    console.error('REFUSED: control row unreadable (' + state.reason + ').');
    return 3;
  }

  console.log('pre-flight');
  printState(state, config);

  if (state.due && state.due > 0 && !args.allowBacklog) {
    console.error('');
    console.error('REFUSED: ' + state.due + ' queued post(s) are already due and would be published on the first worker tick.');
    console.error('Review the list above. Cancel or reschedule anything you do not want sent, then re-run;');
    console.error('or pass --allow-backlog to accept publishing them immediately.');
    return 2;
  }
  if (!args.confirm) {
    console.error('');
    console.error('REFUSED: enable changes live publishing. Re-run with --confirm once the queue above is what you want sent.');
    return 2;
  }

  const updated = await store.setControl({ paused: false, dryRun: false, updatedBy: null });
  if (!updated.ok) {
    console.error('ERROR: control update failed (' + updated.reason + ').');
    return 3;
  }
  console.log('');
  console.log('control updated: paused=' + updated.data.paused + ' dry_run=' + updated.data.dry_run);
  console.log('');
  console.log('remaining gates (all three must hold or nothing publishes):');
  console.log('  1. TELEGRAM_MARKETING_ENABLED=true on the WORKER service');
  console.log('  2. TELEGRAM_MARKETING_DRY_RUN=false on the WORKER service (env dry-run overrides this row)');
  console.log('  3. the worker process is running and its heartbeat is fresh');
  return 0;
}

async function cmdPause(store) {
  const updated = await store.setControl({ paused: true, updatedBy: null });
  if (!updated.ok) {
    console.error('ERROR: control update failed (' + updated.reason + ').');
    return 3;
  }
  console.log('control updated: paused=' + updated.data.paused + ' dry_run=' + updated.data.dry_run);
  return 0;
}

async function cmdStartHere(store, config, args) {
  const built = buildStartHereRow({
    config: Object.assign({}, config, { facts: marketingFacts() }),
    locale: args.locale || config.locale,
    scheduledFor: args.scheduledFor || new Date().toISOString(),
    createdBy: args.createdBy ? Number(args.createdBy) : null
  });

  if (built.guard && built.guard.blocked) {
    console.error('REFUSED: content blocked by the safety guard: ' + JSON.stringify(built.guard.violations || []));
    return 2;
  }
  console.log('built startHere row');
  console.log('  status        : ' + built.row.status);
  console.log('  locale        : ' + built.row.locale);
  console.log('  audience      : ' + built.row.audience);
  console.log('  scheduled_for : ' + built.row.scheduled_for);
  console.log('  key           : ' + built.row.idempotency_key);
  console.log('  channel link  : ' + (built.row.content.includes('https://t.me/ArbitrixAnnouncements') ? 'present' : 'MISSING'));

  if (args.dry) {
    console.log('');
    console.log('--dry: nothing written.');
    return 0;
  }

  const inserted = await store.insertPost(built.row);
  if (!inserted.ok) {
    console.error('ERROR: insert failed (' + inserted.reason + ').');
    return 3;
  }
  const row = inserted.data || {};
  console.log('');
  console.log('saved');
  console.log('  id            : ' + row.id);
  console.log('  status        : ' + row.status);
  console.log('  locale        : ' + row.locale);
  console.log('  scheduled_for : ' + row.scheduled_for);
  console.log('  duplicate     : ' + Boolean(inserted.duplicate) +
    (inserted.duplicate ? ' (existing row returned, nothing created)' : ''));
  console.log('');
  console.log('nothing was published, sent or pinned. Publishing still requires both control flags and the worker env.');
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log(USAGE);
    return args.help ? 0 : 1;
  }
  if (!['status', 'enable', 'pause', 'start-here'].includes(command)) {
    console.error('Unknown command: ' + command);
    console.log(USAGE);
    return 1;
  }

  const db = databaseConfig();
  if (!db.ok) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set in this shell.');
    return 1;
  }

  const store = buildStore(db);
  const config = Object.assign(resolveMarketingConfig(process.env), { facts: marketingFacts() });

  try {
    if (command === 'status') return await cmdStatus(store, config, args);
    if (command === 'enable') return await cmdEnable(store, config, args);
    if (command === 'pause') return await cmdPause(store);
    return await cmdStartHere(store, config, args);
  } catch (error) {
    console.error('ERROR: ' + (error && error.message ? error.message : String(error)).slice(0, 300));
    return 3;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error('FATAL: ' + (error && error.message ? error.message : String(error)).slice(0, 300));
    process.exit(3);
  });
}

module.exports = {
  main,
  parseArgs,
  USAGE,
  // exported for tests: the command bodies take an injected store/config
  readState,
  printState,
  cmdStatus,
  cmdEnable,
  cmdPause,
  cmdStartHere
};
