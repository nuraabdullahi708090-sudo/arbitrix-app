#!/usr/bin/env node
'use strict';

/**
 * check-payhip-readiness.js - one command that answers "can the paid activation
 * rail be switched on, and if not, which single thing is missing?".
 *
 * It never prints a secret: every environment value is reported as a boolean or
 * a length. It never mutates anything:
 *   * a POST to the webhook with an empty body and no token is a refused
 *     delivery (404 / 503 / 401) - no purchase is recorded and no licence is
 *     granted;
 *   * the other calls are GETs of public or auth-gated routes.
 *
 * Usage:
 *   node scripts/check-payhip-readiness.js                     # local env + probe
 *   node scripts/check-payhip-readiness.js --base https://arbitrix.pro
 *   node scripts/check-payhip-readiness.js --no-probe          # env only
 *   node scripts/check-payhip-readiness.js --json
 *
 * Exit codes: 0 ready, 2 not deployed, 3 configured but not usable,
 *             4 the probe itself failed (network).
 */

const { resolvePayhipConfig, describePayhipConfig } = require('../services/PayhipEntitlements');

const DEFAULT_BASE = 'https://arbitrix.pro';

function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, probe: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-probe') args.probe = false;
    else if (a === '--probe') args.probe = true;
    else if (a === '--base') args.base = String(argv[++i] || DEFAULT_BASE).replace(/\/+$/, '');
    else if (a.startsWith('--base=')) args.base = a.slice(7).replace(/\/+$/, '');
  }
  return args;
}

// Interpret one webhook probe. Pure, so the mapping itself is testable.
function interpretWebhookProbe(httpStatus, body) {
  const error = body && typeof body === 'object' ? String(body.error || '') : '';
  const reason = body && typeof body === 'object' ? String(body.reason || '') : '';
  if (httpStatus === 404) {
    return {
      state: 'not-deployed',
      detail: 'the route does not exist in the running build - merge/deploy the branch before expecting deliveries',
      action: 'deploy the relaunch build, then re-run this script'
    };
  }
  if (httpStatus === 503 && error === 'payhip-not-configured') {
    return {
      state: 'deployed-not-configured',
      detail: 'the route exists and refuses deliveries: missing ' + (reason || 'configuration'),
      action: {
        disabled: 'set PAYHIP_ENABLED=true',
        'no-products-configured': 'set PAYHIP_PRODUCTS=dLXuU',
        'missing-api-key': 'set PAYHIP_API_KEY to the Payhip store API key',
        'missing-webhook-token': 'set PAYHIP_WEBHOOK_TOKEN (>= 16 chars, no whitespace)',
        'weak-webhook-token': 'PAYHIP_WEBHOOK_TOKEN is too weak: >= 16 chars and no whitespace'
      }[reason] || 'complete the PAYHIP_* configuration'
    };
  }
  if (httpStatus === 401 && error === 'invalid_token') {
    return {
      state: 'deployed-token-mismatch',
      detail: 'the route is configured and rejected this unauthenticated probe, which is correct',
      action: 'register https://<host>/api/payhip/webhook?token=<PAYHIP_WEBHOOK_TOKEN> in Payhip - a URL without the token always answers 401'
    };
  }
  if (httpStatus === 200) {
    return {
      state: 'unexpected-accept',
      detail: 'an unauthenticated empty POST was accepted - investigate before enabling anything',
      action: 'do not enable PAYHIP_ACTIVATION_REQUIRED until this is explained'
    };
  }
  return {
    state: 'unexpected',
    detail: 'HTTP ' + httpStatus + (error ? ' ' + error : ''),
    action: 'read the server log for the [Payhip] webhook line'
  };
}

async function probeBase(base, fetchImpl) {
  const out = {};
  const get = async (path) => {
    const r = await fetchImpl(base + path, { method: 'GET' });
    let body = null;
    try { body = await r.json(); } catch (_) { body = null; }
    return { status: r.status, body };
  };
  out.health = await get('/api/health');
  out.activation = await get('/api/live/activation');
  // Empty body, no token: a refused delivery. Nothing is recorded.
  const r = await fetchImpl(base + '/api/payhip/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  out.webhook = { status: r.status, body };
  out.webhookVerdict = interpretWebhookProbe(r.status, body);
  return out;
}

function envReport(env) {
  const config = resolvePayhipConfig(env || {});
  const described = describePayhipConfig(config);
  const has = (name) => typeof (env || {})[name] === 'string' && String(env[name]).trim() !== '';
  return {
    described,
    // Product codes are public (they appear in the buy URL), so they are safe to
    // print; secrets are not collected here at all.
    productCodes: Array.from(config.products || []),
    present: {
      PAYHIP_ENABLED: has('PAYHIP_ENABLED'),
      PAYHIP_API_KEY: has('PAYHIP_API_KEY'),
      PAYHIP_PRODUCTS: has('PAYHIP_PRODUCTS'),
      PAYHIP_PRODUCT_SECRET: has('PAYHIP_PRODUCT_SECRET'),
      PAYHIP_PRODUCT_SECRETS: has('PAYHIP_PRODUCT_SECRETS'),
      PAYHIP_STORE_URL: has('PAYHIP_STORE_URL'),
      PAYHIP_WEBHOOK_TOKEN: has('PAYHIP_WEBHOOK_TOKEN'),
      PAYHIP_ACTIVATION_REQUIRED: has('PAYHIP_ACTIVATION_REQUIRED')
    }
  };
}

function verdict(env, probe) {
  const config = resolvePayhipConfig(env || {});
  if (probe && probe.webhookVerdict) {
    const s = probe.webhookVerdict.state;
    if (s === 'not-deployed') return { code: 2, text: 'NOT DEPLOYED - the Payhip route is not in the running build' };
    if (s === 'unexpected-accept') return { code: 3, text: 'UNSAFE - an unauthenticated webhook was accepted' };
    if (s === 'unexpected') return { code: 4, text: 'PROBE FAILED - unexpected answer from the server' };
  }
  if (!config.enabled) return { code: 3, text: 'NOT ENABLED - set PAYHIP_ENABLED=true when the smoke test passes' };
  if (config.reason) return { code: 3, text: 'NOT USABLE - ' + config.reason };
  if (!config.redeemUsable) return { code: 3, text: 'REDEMPTION NOT USABLE - PAYHIP_PRODUCT_SECRET is required to verify a licence' };
  return { code: 0, text: 'READY - webhook and redemption are configured' };
}

async function buildReport({ env, probe, fetchImpl }) {
  const report = {
    env: envReport(env),
    probe: null,
    verdict: null
  };
  if (probe) {
    report.probe = await probeBase(probe.base, fetchImpl);
  }
  report.verdict = verdict(env, report.probe);
  return report;
}

function render(report) {
  const lines = [];
  const d = report.env.described;
  lines.push('== Payhip configuration (values are never printed)');
  for (const [k, v] of Object.entries(report.env.present)) {
    lines.push('  ' + k.padEnd(28) + (v ? 'set' : '-'));
  }
  lines.push('  enabled=' + d.enabled + '  products=' + (report.env.productCodes.join(',') || '-') +
    ' (' + d.productCount + ')  webhookUsable=' + d.webhookUsable + '  reason=' + (d.reason || 'none'));
  lines.push('  redeemUsable=' + d.redeemUsable + '  productSecrets=' + d.productSecretCount +
    '  activationRequired=' + d.activationRequired + '  storeUrlConfigured=' + d.storeUrlConfigured);
  if (report.probe) {
    lines.push('== Server probe');
    lines.push('  /api/health            HTTP ' + report.probe.health.status);
    lines.push('  /api/live/activation   HTTP ' + report.probe.activation.status +
      (report.probe.activation.status === 401 ? ' (auth-gated, correct)' : ''));
    lines.push('  POST /api/payhip/webhook HTTP ' + report.probe.webhook.status +
      '  -> ' + report.probe.webhookVerdict.state);
    lines.push('     ' + report.probe.webhookVerdict.detail);
    lines.push('     next: ' + report.probe.webhookVerdict.action);
  }
  lines.push('== Verdict: ' + report.verdict.text);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fetchImpl = global.fetch;
  if (typeof fetchImpl !== 'function') {
    console.error('this script needs Node 18+ (global fetch)');
    process.exit(4);
  }
  const report = await buildReport({
    env: process.env,
    probe: args.probe ? { base: args.base } : null,
    fetchImpl
  });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  process.exit(report.verdict.code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('probe failed: ' + (err && err.message ? err.message : err));
    process.exit(4);
  });
}

module.exports = { interpretWebhookProbe, envReport, verdict, buildReport, render, parseArgs };
