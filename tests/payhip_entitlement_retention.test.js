'use strict';

/**
 * Deleting a customer who holds a CLAIMED licence must not:
 *   - destroy the purchase record,
 *   - make the licence reusable by someone else,
 *   - or fail (which is what the original FK + CHECK combination did).
 *
 * The design under test: a BEFORE UPDATE trigger stamps owner_detached_at as the
 * FK nulls user_id, and a three-state CHECK makes exactly one of unclaimed /
 * claimed / detached legal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const M050 = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '050_payhip_live_activation.sql'), 'utf8');
const POSTCHECK = fs.readFileSync(path.join(ROOT, 'docs', 'sql', 'payhip_050_postcheck.sql'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'relaunch', '050-APPLY-AND-VERIFY.md'), 'utf8');

test('the entitlement table records a detach stamp', () => {
  assert.match(M050, /owner_detached_at\s+TIMESTAMPTZ/);
  assert.match(M050, /ADD COLUMN IF NOT EXISTS owner_detached_at/, 'a draft apply must converge');
  assert.match(M050, /COMMENT ON COLUMN public\.payhip_entitlements\.owner_detached_at/);
});

test('exactly three claim states are legal', () => {
  const check = M050.slice(M050.indexOf('ADD CONSTRAINT payhip_entitlement_claim_shape'));
  const body = check.slice(0, check.indexOf(');'));
  assert.match(body, /claimed_at IS NULL\s+AND user_id IS NULL\s+AND owner_detached_at IS NULL/);
  assert.match(body, /claimed_at IS NOT NULL AND user_id IS NOT NULL AND owner_detached_at IS NULL/);
  assert.match(body, /claimed_at IS NOT NULL AND user_id IS NULL\s+AND owner_detached_at IS NOT NULL/);
  assert.strictEqual((body.match(/OR \(/g) || []).length, 2, 'exactly three alternatives');
  // Dropped first so a re-run replaces rather than duplicates it.
  assert.match(M050, /DROP CONSTRAINT IF EXISTS payhip_entitlement_claim_shape/);
});

test('a BEFORE UPDATE trigger stamps the detach only when the owner disappears', () => {
  const fn = M050.slice(M050.indexOf('CREATE OR REPLACE FUNCTION public.payhip_entitlement_note_detach'));
  const body = fn.slice(0, fn.indexOf('END $$;'));
  assert.match(body, /IF OLD\.user_id IS NOT NULL AND NEW\.user_id IS NULL AND NEW\.owner_detached_at IS NULL/);
  assert.match(body, /NEW\.owner_detached_at := NOW\(\)/);
  assert.match(body, /RETURN NEW/);
  assert.match(M050, /SET search_path = public, pg_temp AS \$\$\nBEGIN\n  IF OLD\.user_id/,
    'the trigger body must pin search_path like every other definer function');
  assert.match(M050, /DROP TRIGGER IF EXISTS payhip_entitlement_detach_note/);
  assert.match(M050, /CREATE TRIGGER payhip_entitlement_detach_note\s+BEFORE UPDATE OF user_id/);
});

test('the trigger function is not executable outside service_role', () => {
  assert.match(M050, /'public\.payhip_entitlement_note_detach\(\)'/,
    'must be in the REVOKE/GRANT loop');
  const loopStart = M050.indexOf('FOREACH f IN ARRAY');
  const loop = M050.slice(loopStart, M050.indexOf('END LOOP', loopStart));
  assert.match(loop, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(loop, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});

test('a detached licence can never be claimed again', () => {
  const redeem = M050.slice(M050.indexOf('CREATE OR REPLACE FUNCTION public.redeem_payhip_entitlement_safe'));
  const body = redeem.slice(0, redeem.indexOf('END $$;'));
  // The guard that covers a detached row: owner is NULL, claimed_at is set.
  assert.match(body, /IF v_row\.claimed_at IS NOT NULL AND v_row\.user_id IS DISTINCT FROM p_user_id THEN/);
  assert.match(body, /'claimed_by_other_account'/);
  // And the claim UPDATE only runs when the row was not claimed yet.
  assert.match(body, /IF v_row\.claimed_at IS NOT NULL THEN\s+RETURN jsonb_build_object\('success', true, 'duplicate', true/);
});

test('nothing in the migration deletes purchase or entitlement evidence', () => {
  const sql = M050.replace(/--[^\n]*/g, '');
  assert.ok(!/DELETE\s+FROM\s+(public\.)?payhip_(purchases|entitlements)/i.test(sql),
    'the migration must never delete a paid record');
  assert.ok(!/TRUNCATE/i.test(sql), 'no truncation either');
});

test('the self-check and the postcheck both require the detach machinery', () => {
  assert.match(M050, /missing := missing \|\| ' col:owner_detached_at'/);
  assert.match(M050, /missing := missing \|\| ' trg:detach'/);
  assert.match(POSTCHECK, /detach_col/);
  assert.match(POSTCHECK, /detach_trg/);
  assert.match(POSTCHECK, /deleting an account stamps the detach marker/);
  assert.match(POSTCHECK, /or \(select detach_col from facts\) <> 1/);
});

test('the runbook documents the behaviour that was implemented, not options', () => {
  assert.match(DOC, /Deleting a customer who holds a claimed licence/);
  assert.match(DOC, /owner_detached_at/);
  assert.match(DOC, /claimed_by_other_account/);
  assert.match(DOC, /DELETE 1/, 'the verified rehearsal result is recorded');
  assert.ok(!/Two coherent designs, for a decision/.test(DOC), 'the open-question wording must be gone');
});
