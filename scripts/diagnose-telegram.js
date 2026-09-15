#!/usr/bin/env node
'use strict';

/**
 * Safe Telegram configuration diagnostic.
 *
 * Purpose: explain a Telegram `setWebhook` / `getMe` HTTP 404 without ever
 * printing a secret.
 *
 * The Telegram Bot API returns 404 "Not Found" both when the bot token is
 * genuinely wrong AND when the token's VALUE is malformed (wrapped in quotes,
 * prefixed with `bot` from an API URL, or carrying stray whitespace). Those
 * cases are indistinguishable from the response alone, so this script reports
 * the token's SHAPE (presence / length / damage booleans) and the getMe result
 * (HTTP status, ok, error code, description, bot id, bot username).
 *
 * It reads the SAME process environment the server uses, so running it in the
 * host's shell (Render: Shell tab) proves which token the running deploy
 * actually loaded.
 *
 * Usage:
 *   node scripts/diagnose-telegram.js            # human-readable
 *   node scripts/diagnose-telegram.js --json     # machine-readable
 *
 * Never prints the bot token, the webhook secret, or any JWT.
 */

const {
  resolveTelegramConfig,
  describeTelegramToken,
  findTelegramTokenKeyVariants,
  probeTelegramMethod,
  summarizeTelegramBot,
  summarizeTelegramWebhook
} = require('../services/TelegramSupportService');

function redact(value, token) {
  const s = value === null || value === undefined ? '' : String(value);
  return token ? s.split(String(token)).join('***') : s;
}

async function buildReport(env, fetchImpl) {
  const config = resolveTelegramConfig(env);
  const tokenShape = describeTelegramToken(env.TELEGRAM_BOT_TOKEN);

  const me = await probeTelegramMethod({ token: config.token, method: 'getMe', fetchImpl });
  const bot = summarizeTelegramBot(me.result);

  let webhook = null;
  if (me.ok) {
    const info = await probeTelegramMethod({ token: config.token, method: 'getWebhookInfo', fetchImpl });
    const summary = summarizeTelegramWebhook(info.result);
    webhook = Object.assign(
      { httpStatus: info.httpStatus, ok: info.ok, description: redact(info.description, config.token) },
      summary ? {
        url: redact(summary.url, config.token),
        pendingUpdateCount: summary.pendingUpdateCount,
        lastErrorDate: summary.lastErrorDate,
        lastErrorMessage: redact(summary.lastErrorMessage, config.token)
      } : {}
    );
  }

  return {
    token: tokenShape,
    configPresent: {
      TELEGRAM_BOT_TOKEN: tokenShape.present,
      tokenKeyVariants: findTelegramTokenKeyVariants(env),
      TELEGRAM_WEBHOOK_SECRET: Boolean(config.webhookSecret),
      BASE_URL: Boolean(config.baseUrl),
      TELEGRAM_SUPPORT_CHAT_ID: Boolean(config.supportChatId),
      TELEGRAM_ADMIN_IDS: config.adminIds.length > 0
    },
    webhookUrlThatWouldBeRegistered: config.baseUrl ? config.baseUrl + '/api/telegram/webhook' : null,
    deployment: {
      render: Boolean(env.RENDER),
      gitCommit: env.RENDER_GIT_COMMIT || null,
      gitBranch: env.RENDER_GIT_BRANCH || null,
      nodeEnv: env.NODE_ENV || null
    },
    telegram: {
      httpStatus: me.httpStatus,
      ok: me.ok,
      errorCode: me.errorCode,
      description: redact(me.description, config.token),
      botId: bot.botId,
      botUsername: bot.botUsername
    },
    webhook
  };
}

/** Turn the raw report into a plain-language verdict (no secrets). */
function verdict(report) {
  const t = report.token;
  if (!t.present) return 'TELEGRAM_BOT_TOKEN is missing or empty in this environment.';
  if (t.hadSurroundingQuotes || t.hadBotPrefix || t.hadInnerWhitespace) {
    return 'The token VALUE is malformed (quotes / "bot" prefix / inner whitespace). This is the classic cause of a Telegram 404. Fix the env var formatting only; do not rotate the credential.';
  }
  if (!t.validFormat) return 'The token does not match the BotFather format "<digits>:<secret>". Likely a wrong or truncated value; re-paste it from BotFather.';
  if (report.telegram.ok) return 'Token is valid and accepted by Telegram (getMe ok). The 404 is not caused by the token.';
  if (report.telegram.httpStatus === 404) return 'Telegram answered 404 for a well-formed token: the request path was malformed (check the raw value for stray characters that were not normalized).';
  if (report.telegram.httpStatus === 401) return 'Telegram answered 401 Unauthorized: the token is well-formed but not recognised (wrong, revoked, or a deleted bot). Re-issue the token in BotFather.';
  return 'Telegram did not accept the token; see the description above.';
}

async function main() {
  const asJson = process.argv.slice(2).indexOf('--json') !== -1;
  let report;
  try {
    report = await buildReport(process.env);
  } catch (err) {
    console.error('Diagnostic failed:', redact(err && err.message ? err.message : err, process.env.TELEGRAM_BOT_TOKEN));
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(Object.assign({}, report, { verdict: verdict(report) }), null, 2));
    return;
  }
  {
    const t = report.token;
    console.log('=== Telegram diagnostic (no secrets shown) ===');
    console.log('token present            :', t.present);
    console.log('token length (normalized):', t.length);
    console.log('token raw length         :', t.rawLength);
    console.log('surrounding quotes       :', t.hadSurroundingQuotes);
    console.log('leading whitespace       :', t.hadLeadingWhitespace);
    console.log('trailing whitespace      :', t.hadTrailingWhitespace);
    console.log('inner whitespace         :', t.hadInnerWhitespace);
    console.log('leading "bot" prefix     :', t.hadBotPrefix);
    console.log('changed by normalization :', t.changedByNormalization);
    console.log('valid BotFather format   :', t.validFormat);
    console.log('--- getMe ---');
    console.log('HTTP status              :', report.telegram.httpStatus);
    console.log('ok                       :', report.telegram.ok);
    console.log('error code               :', report.telegram.errorCode);
    console.log('description              :', report.telegram.description);
    console.log('bot id                   :', report.telegram.botId);
    console.log('bot username             :', report.telegram.botUsername);
    console.log('--- config present ---');
    console.log('token set                :', report.configPresent.TELEGRAM_BOT_TOKEN);
    console.log('token key variants       :', JSON.stringify(report.configPresent.tokenKeyVariants));
    console.log('webhook secret set       :', report.configPresent.TELEGRAM_WEBHOOK_SECRET);
    console.log('BASE_URL set             :', report.configPresent.BASE_URL);
    console.log('support chat id set      :', report.configPresent.TELEGRAM_SUPPORT_CHAT_ID);
    console.log('admin ids set            :', report.configPresent.TELEGRAM_ADMIN_IDS);
    console.log('webhook URL (if set)     :', report.webhookUrlThatWouldBeRegistered);
    if (report.webhook) {
      console.log('--- getWebhookInfo ---');
      console.log('registered url           :', report.webhook.url);
      console.log('pending updates          :', report.webhook.pendingUpdateCount);
      console.log('last error message       :', report.webhook.lastErrorMessage);
    }
    console.log('--- deployment ---');
    console.log('render                   :', report.deployment.render);
    console.log('git commit               :', report.deployment.gitCommit);
    console.log('git branch               :', report.deployment.gitBranch);
  }

  console.log('VERDICT:', verdict(report));
}

if (require.main === module) {
  main();
}

module.exports = { buildReport, verdict };
