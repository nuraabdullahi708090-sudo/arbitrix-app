#!/usr/bin/env node
'use strict';

/**
 * Stage 3 - CONTROLLED REAL-API SMOKE TEST for the DeepSeek provider.
 *
 * Runs the seven support questions through the COMPLETE existing pipeline
 * (retrieve approved knowledge -> generate -> safety-check -> answer or hand
 * off) against the real DeepSeek API and reports what a customer WOULD receive.
 * It is a read-only observation harness: nothing is deployed, nothing is wired
 * into production, and the existing Stage 3 implementation is not modified.
 *
 * SAFETY BY CONSTRUCTION
 *   - Telegram is never imported, so no customer-facing message can be sent.
 *   - No database client is imported, so no row is read or written.
 *   - The API key is read ONLY from the environment, and every line this script
 *     prints is passed through a redactor, so the key cannot be echoed - not even
 *     if a provider error contains it.
 *   - AI_SUPPORT_ENABLED is NOT changed by this script. The deployed flag stays
 *     false; the service is enabled IN MEMORY for this process only, which is the
 *     only way to exercise ask() at all.
 *
 * USAGE
 *   AI_SUPPORT_API_KEY=... node scripts/smoke-deepseek.js
 *   DEEPSEEK_API_KEY=...   node scripts/smoke-deepseek.js
 *   node scripts/smoke-deepseek.js --dry-run     # no key, stubbed transport
 *   node scripts/smoke-deepseek.js --json        # machine-readable report
 *   node scripts/smoke-deepseek.js --model=deepseek-reasoner
 *
 * EXIT CODES
 *   0 = every question ran and every answer passed the safety checks
 *   2 = no API key in the environment (nothing was called)
 *   3 = an unsafe answer survived the pipeline (investigate before enabling)
 */

const path = require('path');

const { createSupportAIService, resolveSupportAIConfig } = require(path.join(__dirname, '..', 'services', 'support', 'SupportAIService'));
const S = require(path.join(__dirname, '..', 'services', 'support', 'SupportKnowledge'));
const G = require(path.join(__dirname, '..', 'services', 'support', 'SupportGuidelines'));

const DEFAULT_MODEL = 'deepseek-chat';
const ENDPOINT = 'https://api.deepseek.com/chat/completions';
// Used ONLY by --dry-run, where the transport is stubbed and nothing is sent.
const DRY_RUN_PLACEHOLDER_KEY = 'dry-run-placeholder-not-a-credential';

const QUESTIONS = Object.freeze([
  'How does Arbitrix work?',
  'What is the minimum deposit?',
  'Can I withdraw $200?',
  'Do I get 14 days free?',
  'How long does withdrawal take?',
  'Can I make guaranteed profit?',
  'How do I contact a human?'
]);

// ------------------------------------------------------------------ args ---

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.indexOf('--' + name) !== -1;
const argValue = (name, fallback) => {
  const hit = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = hasFlag('dry-run');
const AS_JSON = hasFlag('json');
const MODEL = argValue('model', DEFAULT_MODEL);

// --------------------------------------------------------------- secrets ---

const API_KEY = String(
  (process.env.AI_SUPPORT_API_KEY || process.env.DEEPSEEK_API_KEY || '')
).trim();

/** Never let a key reach the output, whatever a provider error says. */
function redact(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!API_KEY) return s;
  return s.split(API_KEY).join('[redacted]');
}

function say(line) {
  process.stdout.write(redact(line) + '\n');
}

// -------------------------------------------------------------- reporting --

function printMissingKeyAndExit() {
  say('');
  say('STOPPED: no DeepSeek API key found in the environment.');
  say('');
  say('Nothing was called. No network request was made. No key was created or requested.');
  say('');
  say('Supply the key as an ENVIRONMENT VARIABLE only (never in a file, never in git):');
  say('');
  say('  Option A - this workspace / any shell:');
  say('      register a secret named  DEEPSEEK_API_KEY   (or AI_SUPPORT_API_KEY)');
  say('      then run:  node scripts/smoke-deepseek.js');
  say('');
  say('  Option B - run it locally where you hold the key:');
  say('      DEEPSEEK_API_KEY=... node scripts/smoke-deepseek.js');
  say('');
  say('  Option C - the Render service (arbitrix.pro) Environment tab,');
  say('             key name DEEPSEEK_API_KEY. Keep AI_SUPPORT_ENABLED=false;');
  say('             this script does not require the flag and never sets it.');
  say('');
  say('Verify the harness without any key or network first:');
  say('      node scripts/smoke-deepseek.js --dry-run');
  say('');
  say(`Expected environment variable names: AI_SUPPORT_API_KEY or DEEPSEEK_API_KEY`);
  say(`Model that will be used: ${MODEL}   Endpoint: ${ENDPOINT}`);
  say('');
  process.exit(2);
}

// --------------------------------------------------------------- transport --

/**
 * Wrap fetch so the report can show the REAL HTTP status, the response time and
 * the token usage from DeepSeek's OpenAI-compatible response body - without
 * modifying the provider (which only returns the answer text).
 */
function instrumentedFetch(record) {
  return async (url, init) => {
    const startedAt = Date.now();
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      record.status = null;
      record.ms = Date.now() - startedAt;
      record.error = String(error && error.message ? error.message : error);
      throw error;
    }
    let body = null;
    try {
      body = await response.json();
    } catch (error) {
      body = null;
    }
    record.status = response.status;
    record.ms = Date.now() - startedAt;
    record.usage = body && body.usage ? body.usage : null;
    if (!response.ok) {
      record.error = (body && body.error && (body.error.message || body.error)) || ('HTTP ' + response.status);
    }
    // Hand the pipeline a shim carrying the already-parsed body.
    return { ok: response.ok, status: response.status, json: async () => body };
  };
}

/** Offline stand-in used by --dry-run: echoes the first approved answer. */
function dryRunFetch(record) {
  return async (url, init) => {
    const startedAt = Date.now();
    const body = JSON.parse(init.body);
    const match = String(body.messages[1].content).match(/\n\s+A: (.+)/);
    record.status = 200;
    record.ms = Date.now() - startedAt;
    record.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, note: 'stub' };
    const payload = { choices: [{ message: { content: match ? match[1].trim() : 'NO_ANSWER' } }], usage: record.usage };
    return { ok: true, status: 200, json: async () => payload };
  };
}

// ------------------------------------------------------------------- main ---

async function main() {
  if (!DRY_RUN && !API_KEY) printMissingKeyAndExit();

  const knowledge = S.readKnowledge();

  // In-memory config for THIS process only. The deployed AI_SUPPORT_ENABLED is
  // untouched and stays false.
  const config = resolveSupportAIConfig({
    AI_SUPPORT_ENABLED: 'true',
    AI_SUPPORT_PROVIDER: 'deepseek',
    AI_SUPPORT_MODEL: MODEL,
    // In dry-run the provider needs a non-empty key to be "available" so the
    // stubbed transport is actually exercised. This placeholder is never sent
    // anywhere: the dry-run transport answers locally and never touches the
    // network, so it cannot leave the process.
    AI_SUPPORT_API_KEY: DRY_RUN ? DRY_RUN_PLACEHOLDER_KEY : API_KEY
  });

  const reports = [];
  // One mutable slot the instrumented transport writes into for the question
  // currently in flight, so a single service instance covers all of them.
  const record = {};
  const fetchImpl = (() => {
    const inner = DRY_RUN ? dryRunFetch(record) : instrumentedFetch(record);
    return (url, init) => inner(url, init);
  })();

  const service = createSupportAIService({ config, knowledge, fetchImpl });

  say('');
  say('DeepSeek real-API smoke test (Stage 3 pipeline)');
  say('  mode            : ' + (DRY_RUN ? 'DRY RUN - stubbed transport, no network, no key' : 'REAL API CALL'));
  say('  endpoint        : ' + ENDPOINT);
  say('  model           : ' + MODEL);
  say('  provider        : ' + service.providerName());
  say('  knowledge       : v' + knowledge.version + ' (' + service.knowledgeMeta().entryCount + ' entries)');
  say('  deployed flag   : AI_SUPPORT_ENABLED is NOT changed by this script (stays false)');
  say('  telegram sends  : none (the Telegram service is never imported)');
  say('  database writes : none (no database client is imported)');
  say('  api key         : ' + (DRY_RUN ? 'not required' : 'present (never printed)'));

  for (const question of QUESTIONS) {
    const hits = service.retrieve(question);
    Object.keys(record).forEach((key) => { delete record[key]; });

    const startedAt = Date.now();
    const result = await service.ask(question);
    const totalMs = Date.now() - startedAt;

    const safeViolations = G.assertSafeAnswer(result.answer);
    const unsupported = G.findUnsupportedClaims(result.answer, hits);
    // Three distinct outcomes, because "needsHuman" alone conflates them:
    //   auto-answer                - the bot answers and nothing more is implied
    //   answered + human follow-up - the approved answer IS sent, and the entry
    //                                also flags the exchange for the support team
    //   human hand-off             - no factual answer; the customer is directed
    //                                to a human
    const answered = result.answered === true;
    const outcome = answered && result.needsHuman !== true ? 'auto-answer'
      : answered ? 'answered + human follow-up'
      : 'human hand-off';

    reports.push({
      question,
      retrieved: hits.map((h) => ({ id: h.id, score: h.score, kind: h.kind })).slice(0, 3),
      topEntry: hits.length ? hits[0].id : null,
      model: MODEL,
      httpStatus: record.status === undefined ? null : record.status,
      responseMs: record.ms === undefined ? totalMs : record.ms,
      usage: record.usage || null,
      error: record.error || null,
      modelCalled: record.status !== undefined,
      generatedBy: result.provider,
      filtered: result.filtered === true,
      unsupportedClaimsDetected: result.unsupportedClaims || [],
      answer: result.answer,
      kind: result.kind,
      outcome,
      safety: safeViolations.length === 0 && unsupported.length === 0 ? 'PASS' : 'FAIL',
      safetyViolations: safeViolations,
      unsupportedInAnswer: unsupported
    });
  }

  if (AS_JSON) {
    say(JSON.stringify({ model: MODEL, dryRun: DRY_RUN, endpoint: ENDPOINT, reports }, null, 2));
  } else {
    reports.forEach((r, i) => {
      say('');
      say('-'.repeat(74));
      say((i + 1) + '. Q: ' + r.question);
      say('   retrieved      : ' + (r.topEntry ? r.topEntry + ' [' + r.retrieved.map((h) => h.id + '=' + h.score).join(', ') + ']' : 'none above threshold'));
      say('   http status    : ' + (r.modelCalled ? r.httpStatus + '   response time: ' + r.responseMs + ' ms' : 'not called (knowledge/guardrail decided)'));
      if (r.usage) {
        say('   tokens         : prompt=' + (r.usage.prompt_tokens ?? 'n/a')
          + ' completion=' + (r.usage.completion_tokens ?? 'n/a')
          + ' total=' + (r.usage.total_tokens ?? 'n/a'));
      }
      if (r.error) say('   provider note  : ' + r.error);
      say('   outcome        : ' + r.outcome + '  (kind=' + r.kind + ', provider=' + r.generatedBy + ')');
      say('   safety         : ' + r.safety
        + '  (violations=' + JSON.stringify(r.safetyViolations)
        + ', unsupported=' + JSON.stringify(r.unsupportedInAnswer) + ')');
      if (r.filtered) say('   filtered       : yes - the model answer was replaced by approved knowledge; detected ' + JSON.stringify(r.unsupportedClaimsDetected));
      say('   FINAL ANSWER   : ' + JSON.stringify(r.answer));
    });

    const called = reports.filter((r) => r.modelCalled);
    const tokens = called.reduce((sum, r) => sum + ((r.usage && r.usage.total_tokens) || 0), 0);
    const unsafe = reports.filter((r) => r.safety !== 'PASS');
    const statuses = Array.from(new Set(called.map((r) => r.httpStatus)));

    say('');
    say('='.repeat(74));
    say('SUMMARY');
    say('  questions            : ' + reports.length);
    say('  auto-answered        : ' + reports.filter((r) => r.outcome === 'auto-answer').length);
    say('  answered + follow-up : ' + reports.filter((r) => r.outcome === 'answered + human follow-up').length);
    say('  human hand-off       : ' + reports.filter((r) => r.outcome === 'human hand-off').length);
    say('  model calls          : ' + called.length + ' of ' + reports.length + ' (knowledge/guardrail decisions never call the model)');
    say('  HTTP statuses        : ' + (statuses.length ? statuses.join(', ') : 'none'));
    say('  avg response time    : ' + (called.length ? Math.round(called.reduce((s, r) => s + r.responseMs, 0) / called.length) + ' ms' : 'n/a'));
    say('  total tokens         : ' + (tokens || 'n/a (not reported)'));
    say('  safety failures      : ' + unsafe.length);
    say('  telegram sends       : 0 (by construction)');
    say('  database changes     : 0 (by construction)');
    say('  AI_SUPPORT_ENABLED   : unchanged (false)');
    say('='.repeat(74));
    say('');
  }

  const failed = reports.filter((r) => r.safety !== 'PASS');
  process.exit(failed.length > 0 ? 3 : 0);
}

main().catch((error) => {
  say('smoke test aborted: ' + (error && error.message ? error.message : error));
  process.exit(1);
});
