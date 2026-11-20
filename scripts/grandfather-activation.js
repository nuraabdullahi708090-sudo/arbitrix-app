#!/usr/bin/env node
'use strict';

/**
 * grandfather-activation.js - operator tool for migration 054.
 *
 * Grants a COMPLIMENTARY Live activation to customers who had already funded an
 * account before the Payhip gate is switched on. It never moves money: a grant
 * is an entitlement row with source 'grandfathered_funded_customer', no
 * purchase, no licence key and no revenue.
 *
 * Four modes, in the order you use them:
 *
 *   --preview                     READ-ONLY. Evaluates the criteria now.
 *   --snapshot --key=<cutover>    Freezes the eligible set (two new tables only).
 *   --apply --snapshot-id=<id>    Grants entitlements for the frozen set.
 *   --report                      READ-ONLY. Snapshots + grants so far.
 *
 * Every write mode needs its own confirmation flag; without it the script only
 * prints what it would do. Requires SUPABASE_URL and SUPABASE_SERVICE_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY) - normally run in the Render shell.
 *
 * Exit codes: 0 ok, 2 bad usage / missing credentials, 3 migration 054 missing,
 *             4 the database call failed.
 */

const HOST_PREVIEW = 'grandfather_activation_preview';
const HOST_SNAPSHOT = 'grandfather_activation_snapshot';
const HOST_APPLY = 'grandfather_activation_apply';
const HOST_REPORT = 'grandfather_activation_report';

function parseArgs(argv) {
  const args = {
    mode: 'preview',
    key: '',
    note: '',
    snapshotId: null,
    confirmSnapshot: false,
    confirmApply: false,
    showIds: false,
    json: false,
    url: process.env.SUPABASE_URL || '',
    key_secret: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--preview') args.mode = 'preview';
    else if (a === '--snapshot') args.mode = 'snapshot';
    else if (a === '--apply') args.mode = 'apply';
    else if (a === '--report') args.mode = 'report';
    else if (a === '--key') args.key = String(argv[++i] || '');
    else if (a.startsWith('--key=')) args.key = a.slice(6);
    else if (a === '--note') args.note = String(argv[++i] || '');
    else if (a.startsWith('--note=')) args.note = a.slice(7);
    else if (a === '--snapshot-id') args.snapshotId = Number(argv[++i]);
    else if (a.startsWith('--snapshot-id=')) args.snapshotId = Number(a.slice(14));
    else if (a === '--confirm-snapshot') args.confirmSnapshot = true;
    else if (a === '--confirm-apply') args.confirmApply = true;
    else if (a === '--show-ids') args.showIds = true;
    else if (a === '--json') args.json = true;
    else if (a === '--url') args.url = String(argv[++i] || '');
    else if (a.startsWith('--url=')) args.url = a.slice(6);
  }
  return args;
}

/**
 * Decide whether a mode may write. Pure, so the rule is testable without a
 * database: a write needs its own confirmation flag, and nothing else counts.
 */
function checkMode(args) {
  if (args.mode === 'preview' || args.mode === 'report') return { ok: true, write: false };
  if (args.mode === 'snapshot') {
    if (!args.key || !String(args.key).trim()) {
      return { ok: false, reason: 'missing --key (the cutover identifier, e.g. --key=2026-11-cutover)' };
    }
    if (!args.confirmSnapshot) {
      return { ok: false, reason: 'refusing to freeze a snapshot without --confirm-snapshot' };
    }
    return { ok: true, write: true, rpc: HOST_SNAPSHOT, params: { p_snapshot_key: String(args.key).trim(), p_note: args.note || null } };
  }
  if (args.mode === 'apply') {
    if (!Number.isInteger(args.snapshotId) || args.snapshotId <= 0) {
      return { ok: false, reason: 'missing --snapshot-id (from the --snapshot output)' };
    }
    if (!args.confirmApply) {
      return { ok: false, reason: 'refusing to grant without --confirm-apply' };
    }
    return { ok: true, write: true, rpc: HOST_APPLY, params: { p_snapshot_id: args.snapshotId } };
  }
  return { ok: false, reason: 'unknown mode ' + args.mode };
}

function hostOf(url) {
  return String(url || '').replace(/^https?:\/\//, '').split('/')[0] || '(unset)';
}

async function callRpc(admin, fn, params) {
  const { data, error } = await admin.rpc(fn, params);
  if (error) {
    const missing = /could not find the function|does not exist|schema cache/i.test(error.message || '');
    const err = new Error(missing
      ? 'migration 054 is not applied on this database (function ' + fn + ' not found)'
      : 'rpc ' + fn + ' failed: ' + error.message);
    err.code = missing ? 'MIGRATION_MISSING' : 'RPC_FAILED';
    throw err;
  }
  return data;
}

function printPreview(summary, asJson) {
  if (asJson) return JSON.stringify(summary, null, 2);
  const s = summary || {};
  return [
    'Grandfathering preview (read-only, evaluated now)',
    '  accounts total          ' + s.totalAccounts,
    '  production              ' + s.productionAccounts,
    '  sandbox excluded        ' + s.sandboxAccounts,
    '  already licensed        ' + s.alreadyLicensed,
    '  funded (deposit >= ' + s.minDeposit + ')  ' + s.fundedTotal,
    '  already below minimum   ' + s.belowMinimum,
    '  promo / no deposit      ' + s.promoOrNoDeposit,
    '  WOULD BE GRANTED NOW    ' + s.eligibleNow,
  ].join('\n');
}

function printReport(report, showIds) {
  const r = report || {};
  const lines = ['Grandfathering report (read-only)'];
  lines.push('  active grants           ' + (r.activeGrants === undefined ? '?' : r.activeGrants));
  (r.snapshots || []).forEach((s) => {
    lines.push('  snapshot ' + s.id + ' "' + s.key + '" cutover ' + s.cutoverAt
      + ' -> eligible ' + s.eligibleCount + ', applied ' + s.appliedCount);
  });
  (r.grants || []).forEach((g) => {
    lines.push('  grant ' + (showIds ? 'user ' + g.userId : 'user <hidden>')
      + ' snapshot ' + g.snapshotId
      + (g.revokedAt ? ' REVOKED ' + g.revokedAt : ' active'));
  });
  if (!showIds) lines.push('  (user ids hidden; add --show-ids to display them)');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = checkMode(args);
  if (!plan.ok) {
    console.error('refused: ' + plan.reason);
    process.exitCode = 2;
    return;
  }
  if (!args.url || !args.key_secret) {
    console.error('refused: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required');
    process.exitCode = 2;
    return;
  }

  let createClient;
  try {
    ({ createClient } = require('@supabase/supabase-js'));
  } catch (e) {
    console.error('refused: @supabase/supabase-js is not installed');
    process.exitCode = 2;
    return;
  }
  const admin = createClient(args.url, args.key_secret, { auth: { persistSession: false } });

  console.log('project: ' + hostOf(args.url) + '   mode: ' + args.mode);
  try {
    if (args.mode === 'preview') {
      console.log(printPreview(await callRpc(admin, HOST_PREVIEW, {}), args.json));
    } else if (args.mode === 'report') {
      console.log(printReport(await callRpc(admin, HOST_REPORT, {}), args.showIds));
    } else {
      const out = await callRpc(admin, plan.rpc, plan.params);
      console.log(JSON.stringify(out, null, 2));
      if (args.mode === 'snapshot' && out && out.snapshotId) {
        console.log('\nnext: node scripts/grandfather-activation.js --apply --snapshot-id=' + out.snapshotId + ' --confirm-apply');
      }
    }
  } catch (e) {
    console.error('error: ' + e.message);
    process.exitCode = e.code === 'MIGRATION_MISSING' ? 3 : 4;
  }
}

module.exports = { parseArgs, checkMode, hostOf, printPreview, printReport };

if (require.main === module) main();
