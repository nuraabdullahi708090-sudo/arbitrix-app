#!/usr/bin/env node
'use strict';

/**
 * Generate (or check) a Telegram-compatible webhook secret.
 *
 * Telegram's setWebhook `secret_token` accepts ONLY:
 *     A-Z  a-z  0-9  _  -
 * for 1-256 characters. Anything else is rejected with
 * "Bad Request: secret token contains illegal characters" - and Telegram then
 * keeps the PREVIOUS registration, so the bot silently stops receiving updates
 * while getMe/setWebhook look healthy. That is the exact failure this script
 * exists to prevent.
 *
 * Usage:
 *   node scripts/generate-telegram-secret.js                 # print a new secret
 *   node scripts/generate-telegram-secret.js --length 64     # 32..256 chars
 *   node scripts/generate-telegram-secret.js --check <value> # validate only
 *   node scripts/generate-telegram-secret.js --check-env     # validate the env
 *
 * `--check`/`--check-env` print SAFE METADATA ONLY (valid or not, length, how
 * many characters are disallowed) and never echo the value.
 *
 * The generated value is printed to stdout on purpose: this is the one artifact
 * an operator must copy into the host's environment. Never log it, and never
 * paste it into an issue, a report or a chat.
 */

const {
  generateTelegramWebhookSecret,
  describeTelegramWebhookSecret,
  isValidTelegramWebhookSecret
} = require('../services/TelegramSupportService');

function parseArgs(argv) {
  const args = { check: null, checkEnv: false, length: 48 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      args.check = argv[i + 1] === undefined ? '' : String(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--check=')) {
      args.check = arg.slice('--check='.length);
    } else if (arg === '--check-env') {
      args.checkEnv = true;
    } else if (arg === '--length') {
      args.length = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--length=')) {
      args.length = Number(arg.slice('--length='.length));
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.checkEnv) {
    const info = describeTelegramWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET);
    console.log('TELEGRAM_WEBHOOK_SECRET validity (no value is printed):');
    console.log(JSON.stringify(info, null, 2));
    if (!info.present) {
      console.error('\nTELEGRAM_WEBHOOK_SECRET is not set.');
      return 2;
    }
    if (!info.validFormat) {
      console.error('\nINVALID: Telegram will reject setWebhook with this value.');
      console.error('Generate a compliant replacement with:');
      console.error('  node scripts/generate-telegram-secret.js');
      return 1;
    }
    console.log('\nVALID: Telegram-compatible.');
    return 0;
  }

  if (args.check !== null) {
    const info = describeTelegramWebhookSecret(args.check);
    console.log('Secret validity check (no value is printed):');
    console.log(JSON.stringify(info, null, 2));
    console.log(isValidTelegramWebhookSecret(args.check) ? 'VALID: Telegram-compatible.' : 'INVALID: not Telegram-compatible.');
    return isValidTelegramWebhookSecret(args.check) ? 0 : 1;
  }

  // Default: emit a fresh, guaranteed-compatible secret.
  process.stdout.write(generateTelegramWebhookSecret(args.length) + '\n');
  return 0;
}

process.exitCode = main();
