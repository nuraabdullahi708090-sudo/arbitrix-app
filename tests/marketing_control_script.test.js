'use strict';

/**
 * The operator console that flips telegram_marketing_control without a browser
 * session. These tests pin the safety properties, not the wording:
 *   - `enable` cannot fire without --confirm, and cannot fire while overdue
 *     posts would publish on the first tick unless --allow-backlog is explicit
 *   - `pause` only ever removes publishing capability
 *   - `start-here` queues through the real builder + store (idempotent) and
 *     never publishes, sends or pins
 *   - the script prints no secret and writes no SQL
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'marketing-control.js');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const control = require('../scripts/marketing-control');

function fakeStore({ posts = [], due = 0, control: ctl = { paused: true, dry_run: true, updated_at: '2026-10-30T00:00:00Z' } } = {}) {
  const calls = { setControl: [], insertPost: [], getControl: 0 };
  return {
    calls,
    async getControl() { calls.getControl += 1; return { ok: true, data: ctl }; },
    async countByStatus() { return { ok: true, data: { scheduled: posts.filter((p) => p.status === 'scheduled').length, published: 0 } }; },
    async countDue() { return { ok: true, count: due }; },
    async listPosts() { return { ok: true, data: posts }; },
    async setControl(patch) { calls.setControl.push(patch); return { ok: true, data: Object.assign({ dry_run: true, paused: true }, { paused: patch.paused === undefined ? true : patch.paused, dry_run: patch.dryRun === undefined ? true : patch.dryRun }) }; },
    async insertPost(row) { calls.insertPost.push(row); return { ok: true, duplicate: false, data: Object.assign({ id: 42 }, row) }; }
  };
}

const CONFIG = {
  locale: 'en',
  timezone: 'UTC',
  groupChatId: '-1001234567890',
  channelChatId: '-1009876543210',
  announcementUrl: 'https://t.me/ArbitrixAnnouncements',
  supportUrl: 'https://t.me/ArbitrixSupportBot',
  partnerSupportAlexUrl: 'https://t.me/AlexArbitrix',
  partnerSupportOliviaUrl: 'https://t.me/OliviaArbitrix',
  registerUrl: 'https://arbitrix.pro/?action=create-account',
  howItWorksUrl: 'https://arbitrix.pro/how-it-works',
  facts: { minDeposit: 100, referralPercent: 20 }
};

function quiet(fn) {
  const log = console.log;
  const error = console.error;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  const done = () => { console.log = log; console.error = error; return lines.join('\n'); };
  return Promise.resolve(fn()).then((code) => ({ code, out: done() }), (err) => { done(); throw err; });
}

// ---------------------------------------------------------------- CLI guards

test('cli: --help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /usage: node scripts\/marketing-control\.js/);
  assert.match(r.stdout, /status/);
  assert.match(r.stdout, /enable --confirm/);
});

test('cli: missing database env exits 1 without printing any credential', () => {
  const env = Object.assign({}, process.env);
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_KEY;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const r = spawnSync(process.execPath, [SCRIPT, 'status'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /SUPABASE_URL and SUPABASE_SERVICE_KEY/);
});

test('cli: unknown command exits 1 and prints usage', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'frobnicate'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Unknown command/);
});

// ---------------------------------------------------------------- enable

test('enable: refused without --confirm, and nothing is written', async () => {
  const store = fakeStore();
  const { code, out } = await quiet(() => control.cmdEnable(store, CONFIG, {}));
  assert.strictEqual(code, 2);
  assert.match(out, /REFUSED/);
  assert.match(out, /--confirm/);
  assert.strictEqual(store.calls.setControl.length, 0);
});

test('enable: refused while overdue posts would publish, unless --allow-backlog', async () => {
  const posts = [{ id: 7, kind: 'weekly', status: 'scheduled', audience: 'group', locale: 'en', scheduled_for: '2026-10-01T09:00:00Z' }];
  const blocked = fakeStore({ posts, due: 1 });
  const first = await quiet(() => control.cmdEnable(blocked, CONFIG, { confirm: true }));
  assert.strictEqual(first.code, 2);
  assert.match(first.out, /already due/);
  assert.match(first.out, /#7/);
  assert.strictEqual(blocked.calls.setControl.length, 0);

  const allowed = fakeStore({ posts, due: 1 });
  const second = await quiet(() => control.cmdEnable(allowed, CONFIG, { confirm: true, allowBacklog: true }));
  assert.strictEqual(second.code, 0);
  assert.deepStrictEqual(allowed.calls.setControl, [{ paused: false, dryRun: false, updatedBy: null }]);
});

test('enable: with a clean queue and --confirm it clears both flags', async () => {
  const store = fakeStore({ due: 0 });
  const { code, out } = await quiet(() => control.cmdEnable(store, CONFIG, { confirm: true }));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(store.calls.setControl, [{ paused: false, dryRun: false, updatedBy: null }]);
  assert.match(out, /TELEGRAM_MARKETING_DRY_RUN=false on the WORKER service/);
});

test('enable: refuses when no destination is configured', async () => {
  const store = fakeStore();
  const { code } = await quiet(() => control.cmdEnable(store, Object.assign({}, CONFIG, { groupChatId: '', channelChatId: '' }), { confirm: true }));
  assert.strictEqual(code, 2);
  assert.strictEqual(store.calls.setControl.length, 0);
});

// ---------------------------------------------------------------- pause

test('pause: always allowed and only ever sets paused', async () => {
  const store = fakeStore({ control: { paused: false, dry_run: false, updated_at: 'x' } });
  const { code } = await quiet(() => control.cmdPause(store));
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(store.calls.setControl, [{ paused: true, updatedBy: null }]);
  assert.strictEqual(store.calls.setControl[0].dryRun, undefined, 'pause must not touch dry_run');
});

// ---------------------------------------------------------------- start-here

test('start-here: queues through the real builder with the requested schedule', async () => {
  const store = fakeStore();
  const args = control.parseArgs(['start-here', '--locale', 'en', '--scheduled-for', '2026-10-31T10:00:00.000Z']);
  const { code, out } = await quiet(() => control.cmdStartHere(store, CONFIG, args));
  assert.strictEqual(code, 0);
  assert.strictEqual(store.calls.insertPost.length, 1, 'exactly one insert');
  const row = store.calls.insertPost[0];
  assert.strictEqual(row.kind, 'startHere');
  assert.strictEqual(row.audience, 'group');
  assert.strictEqual(row.locale, 'en');
  assert.strictEqual(row.status, 'scheduled');
  assert.strictEqual(row.scheduled_for, '2026-10-31T10:00:00.000Z');
  assert.match(row.idempotency_key, /^starthere:group:en:\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(row.chat_id, null, 'destination must be resolved at send time');
  assert.ok(row.content.includes('https://t.me/ArbitrixAnnouncements'));
  assert.ok(row.content.includes('https://t.me/ArbitrixSupportBot'));
  assert.ok(row.content.includes('https://t.me/AlexArbitrix'));
  assert.match(out, /channel link  : present/);
});

test('start-here --dry builds but writes nothing', async () => {
  const store = fakeStore();
  const args = control.parseArgs(['start-here', '--dry']);
  const { code, out } = await quiet(() => control.cmdStartHere(store, CONFIG, args));
  assert.strictEqual(code, 0);
  assert.strictEqual(store.calls.insertPost.length, 0);
  assert.match(out, /nothing written/);
});

test('start-here: a duplicate key reports the existing row instead of a second post', async () => {
  const store = fakeStore();
  store.insertPost = async (row) => ({ ok: true, duplicate: true, data: Object.assign({ id: 7 }, row) });
  const args = control.parseArgs(['start-here']);
  const { code, out } = await quiet(() => control.cmdStartHere(store, CONFIG, args));
  assert.strictEqual(code, 0);
  assert.match(out, /duplicate     : true/);
  assert.match(out, /existing row returned/);
});

// ---------------------------------------------------------------- safety

test('safety: the script writes only the two control booleans', () => {
  assert.match(SOURCE, /store\.setControl\(\{ paused: true, updatedBy: null \}\)/);
  assert.match(SOURCE, /store\.setControl\(\{ paused: false, dryRun: false, updatedBy: null \}\)/);
  assert.strictEqual((SOURCE.match(/setControl\(/g) || []).length, 2, 'no other control write exists');
});

test('safety: no SQL, no schema change, no raw table writes', () => {
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\s+(INTO|FROM|public\.)/i.test(SOURCE), 'no SQL text');
  assert.ok(!/from\('(wallets|users|deposits|withdrawals|trades)'\)/.test(SOURCE), 'no money table access');
  assert.ok(!/sendMessage|pinChatMessage|sendPhoto/.test(SOURCE), 'never sends or pins');
});

test('safety: no secret is ever printed', () => {
  assert.ok(!/console\.(log|error)\([^)]*SUPABASE_SERVICE_KEY\)/.test(SOURCE));
  assert.ok(!/console\.(log|error)\([^)]*TELEGRAM_BOT_TOKEN\)/.test(SOURCE));
  assert.ok(!/process\.env\.(SUPABASE_SERVICE_KEY|SUPABASE_SERVICE_ROLE_KEY|TELEGRAM_BOT_TOKEN)\s*\)/.test(SOURCE));
  assert.match(SOURCE, /Never prints a Supabase key, a bot token, a chat id/);
});

test('safety: the doc names the shell path, not a token extraction', () => {
  assert.match(SOURCE, /Render:/);
  assert.match(SOURCE, /Shell/);
  assert.ok(!/localStorage|jwt_token|Bearer/.test(SOURCE), 'no browser token handling');
});
