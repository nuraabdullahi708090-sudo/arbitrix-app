'use strict';

/**
 * The rehearsal script DELETEs marketing rows, so it is only safe because of its
 * opt-in guard. These tests exist to keep that property from being refactored
 * away: the guard must stay, and it must run before anything destructive.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'docs', 'sql', 'marketing_rpc_rehearsal.sql');
const sql = fs.readFileSync(FILE, 'utf8');
const lines = sql.split('\n');

function indexOfFirst(re) {
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i]) && !/^\s*--/.test(lines[i])) return i;
  }
  return -1;
}

test('the rehearsal script declares itself destructive and throwaway-only', () => {
  assert.match(sql, /DESTRUCTIVE/i);
  assert.match(sql, /THROWAWAY DATABASE ONLY/i);
  assert.match(sql, /never production/i);
});

test('it refuses to run without the explicit session opt-in', () => {
  assert.match(sql, /current_setting\('arbitrix\.rehearsal', true\)/);
  assert.match(sql, /raise exception 'refusing to run/);
  assert.match(sql, /arbitrix\.rehearsal = ''yes''/);
});

test('the guard runs before the first destructive statement', () => {
  const guard = indexOfFirst(/current_setting\('arbitrix\.rehearsal'/);
  const firstDelete = indexOfFirst(/^\s*delete\s+from/i);
  const firstUpdate = indexOfFirst(/^\s*update\s+/i);
  const firstInsert = indexOfFirst(/^\s*insert\s+into/i);
  assert.ok(guard > -1, 'guard is present');
  for (const [name, idx] of [['delete', firstDelete], ['update', firstUpdate], ['insert', firstInsert]]) {
    if (idx === -1) continue;
    assert.ok(guard < idx, 'guard must precede the first ' + name);
  }
});

test('it touches only telegram_marketing_* tables', () => {
  const statements = sql
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
  const tables = new Set();
  const re = /\b(?:delete\s+from|insert\s+into|update|from)\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = re.exec(statements)) !== null) {
    const name = match[1].toLowerCase();
    if (['select', 'set', 'values', 'where', 't'].includes(name)) continue;
    if (!name.startsWith('telegram_marketing_') && !/^claim_marketing_posts|^finish_marketing_post|^block_marketing_post/.test(name)) {
      tables.add(name);
    }
  }
  assert.deepStrictEqual([...tables], [], 'unexpected table(s): ' + [...tables].join(', '));
});

test('it never drops, truncates or alters schema', () => {
  assert.doesNotMatch(sql, /^\s*(drop|truncate|alter)\s/im);
  assert.doesNotMatch(sql, /create\s+or\s+replace\s+function/i);
});

test('it asserts the full 038 + 043 + 044 contract', () => {
  for (const check of [
    /PASS claim:/,
    /PASS second claim:/,
    /PASS fencing:/,
    /PASS finish:/,
    /PASS heartbeat: written, gates untouched/,
    /PASS block:/,
    /PASS audit:/,
    /PASS reclaim:/,
    /ALL REHEARSAL CHECKS PASSED/
  ]) {
    assert.match(sql, check);
  }
});

test('the documented invocation opts in before loading the file', () => {
  const optIn = sql.indexOf("-c \"set arbitrix.rehearsal = 'yes';\"");
  const load = sql.indexOf('-f docs/sql/marketing_rpc_rehearsal.sql');
  assert.ok(optIn > -1 && load > -1, 'both flags are documented');
  assert.ok(optIn < load, 'psql runs flags in order: the SET must come before the -f');
});
