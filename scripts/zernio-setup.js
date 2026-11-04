#!/usr/bin/env node
'use strict';

/**
 * Zernio WhatsApp setup and inspection.
 *
 *   node scripts/zernio-setup.js            # read-only inspection (default)
 *   node scripts/zernio-setup.js --json     # read-only, machine-readable
 *   node scripts/zernio-setup.js --apply    # create missing fields/templates/sequences
 *   node scripts/zernio-setup.js --apply --apply-webhook
 *
 * WHAT --apply DOES (idempotent, additive only)
 *   1. creates the contact custom fields the automation reads/writes
 *   2. submits the missing pt-BR (and English) templates to Meta
 *   3. creates and activates one follow-up sequence per language
 *   4. only with --apply-webhook, registers the delivery endpoint
 *
 * WHAT IT NEVER DOES
 *   - delete or edit an existing template, sequence or field
 *   - send a message to a customer
 *   - print the API key, the webhook secret or any phone number
 *
 * REQUIRES (set by the operator, never committed):
 *   ZERNIO_API_KEY, ZERNIO_PROFILE_ID, ZERNIO_WHATSAPP_ACCOUNT_ID,
 *   ZERNIO_WEBHOOK_SECRET (only for --apply-webhook), BASE_URL
 *
 * NOTE ON TEMPLATE STATUS: a created template is PENDING until Meta reviews it.
 * This script can submit it; it cannot approve it. Until Meta returns APPROVED
 * the automation's approval gate refuses to send it. Exit code 0 therefore does
 * NOT mean "the Portuguese templates are live" - it means "submitted".
 */

const { createZernioClient } = require('../services/whatsapp/ZernioClient');
const { createContactPreferences } = require('../services/whatsapp/ContactPreferences');
const {
  requiredTemplates,
  planProvisioning
} = require('../services/whatsapp/WhatsAppTemplates');
const { sequenceSpec, sequenceNameFor } = require('../services/whatsapp/FollowUpRouter');
const { ACTIVE_LANGUAGES, toMetaLocale } = require('../services/whatsapp/Languages');

function parseArgs(argv) {
  const args = {
    apply: false,
    json: false,
    applyWebhook: false,
    activateSequences: false,
    help: false
  };
  for (const value of argv) {
    if (value === '--apply') args.apply = true;
    else if (value === '--json') args.json = true;
    else if (value === '--apply-webhook') args.applyWebhook = true;
    else if (value === '--activate-sequences') args.activateSequences = true;
    else if (value === '--help' || value === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Zernio WhatsApp setup

  node scripts/zernio-setup.js                 inspect (read-only)
  node scripts/zernio-setup.js --json          inspect, JSON output
  node scripts/zernio-setup.js --apply         create missing fields/templates/sequences
  node scripts/zernio-setup.js --apply --apply-webhook
                                               also register the webhook endpoint
  node scripts/zernio-setup.js --apply --activate-sequences
                                               activate sequences ONLY if every
                                               template for that language is APPROVED

Environment: ZERNIO_API_KEY, ZERNIO_PROFILE_ID, ZERNIO_WHATSAPP_ACCOUNT_ID,
             ZERNIO_WEBHOOK_SECRET (only for --apply-webhook), BASE_URL`);
}

function requireEnv(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const apiKey = requireEnv('ZERNIO_API_KEY');
  if (!apiKey) {
    console.error('ZERNIO_API_KEY is not set. Export it in the shell; never commit it.');
    return 2;
  }
  const profileId = requireEnv('ZERNIO_PROFILE_ID');
  const accountId = requireEnv('ZERNIO_WHATSAPP_ACCOUNT_ID');

  const client = createZernioClient({ apiKey, profileId, accountId });
  const report = {
    mode: args.apply ? (args.activateSequences ? 'apply+activate' : 'apply') : 'inspect',
    profileIdConfigured: Boolean(profileId),
    accountIdConfigured: Boolean(accountId),
    languages: ACTIVE_LANGUAGES,
    accounts: null,
    customFields: null,
    templates: null,
    sequences: null,
    webhooks: null,
    actions: [],
    warnings: []
  };

  if (!profileId) report.warnings.push('ZERNIO_PROFILE_ID is not set; profile-scoped calls will fail.');
  if (!accountId) report.warnings.push('ZERNIO_WHATSAPP_ACCOUNT_ID is not set; template and send calls will fail.');

  // ---- Accounts (inspection only) -----------------------------------------
  try {
    const accounts = await client.listAccounts({ platform: 'whatsapp' });
    const list = (accounts && (accounts.accounts || accounts.data)) || [];
    report.accounts = Array.isArray(list)
      ? list.map((account) => ({
        id: account.id || account._id,
        name: account.name || account.username || null,
        platform: account.platform || 'whatsapp',
        status: account.status || account.state || null
      }))
      : null;
    if (!accountId && report.accounts && report.accounts.length) {
      report.warnings.push(
        'ZERNIO_WHATSAPP_ACCOUNT_ID is not set. Candidate account ids (set the one you use): '
        + report.accounts.map((account) => account.id).filter(Boolean).join(', ')
      );
    }
  } catch (error) {
    report.accounts = { error: error.code || error.message };
    report.warnings.push('Could not list accounts: ' + (error.code || 'error'));
  }

  // ---- Custom fields -------------------------------------------------------
  const preferences = createContactPreferences({ client });
  try {
    const plan = await preferences.planFields();
    report.customFields = {
      existing: plan.existing.map((field) => field.slug),
      missing: plan.create.map((field) => field.slug)
    };
    if (args.apply && plan.create.length) {
      for (const field of plan.create) {
        await client.createCustomField({
          profileId: profileId || undefined,
          name: field.name,
          slug: field.slug,
          type: field.type
        });
        report.actions.push({ action: 'custom_field_created', slug: field.slug });
      }
    }
  } catch (error) {
    report.customFields = { error: error.code || error.message };
    report.warnings.push('Custom field inspection failed: ' + (error.code || 'error'));
  }

  // ---- Templates -----------------------------------------------------------
  try {
    const response = await client.listTemplates({ accountId: accountId || undefined });
    const existing = (response && (response.templates || response.data)) || [];
    report.templates = Array.isArray(existing)
      ? existing.map((template) => ({
        name: template.name,
        language: template.language,
        status: template.status,
        category: template.category
      }))
      : [];

    if (accountId) {
      const plan = planProvisioning({ accountId, existing: Array.isArray(existing) ? existing : [] });
      report.templatesRequired = requiredTemplates(accountId).map((entry) => ({
        name: entry.name,
        language: entry.metaLocale,
        status: (plan.present.find((present) => present.name === entry.name) || {}).status || 'MISSING'
      }));
      if (args.apply) {
        for (const entry of plan.create) {
          const created = await client.createTemplate(entry.payload);
          const template = (created && created.template) || {};
          report.actions.push({
            action: 'template_submitted',
            name: entry.name,
            language: entry.metaLocale,
            status: template.status || 'PENDING'
          });
        }
      }
    } else {
      report.warnings.push('Template planning skipped: ZERNIO_WHATSAPP_ACCOUNT_ID is not set.');
    }
  } catch (error) {
    report.templates = { error: error.code || error.message };
    report.warnings.push('Template inspection failed: ' + (error.code || 'error'));
  }

  // ---- Sequences -----------------------------------------------------------
  try {
    const response = await client.listSequences({ profileId: profileId || undefined });
    const existing = (response && (response.sequences || response.data)) || [];
    report.sequences = Array.isArray(existing)
      ? existing.map((sequence) => ({
        id: sequence.id,
        name: sequence.name,
        status: sequence.status,
        platform: sequence.platform,
        steps: sequence.stepsCount
      }))
      : [];

    const templateStatusByLanguage = {};
    for (const entry of report.templatesRequired || []) {
      if (!templateStatusByLanguage[entry.language]) templateStatusByLanguage[entry.language] = [];
      templateStatusByLanguage[entry.language].push(entry.status);
    }

    if (args.apply && profileId && accountId && Array.isArray(existing)) {
      for (const language of ACTIVE_LANGUAGES) {
        const name = sequenceNameFor(language);
        const metaLanguage = toMetaLocale(language);
        const statuses = templateStatusByLanguage[metaLanguage] || [];
        const allApproved = statuses.length > 0 && statuses.every((status) => status === 'APPROVED');

        let target = existing.find((sequence) => sequence.name === name);
        if (target) {
          report.actions.push({ action: 'sequence_exists', name, id: target.id, status: target.status });
        } else {
          const created = await client.createSequence(sequenceSpec({ language, profileId, accountId }));
          const sequence = (created && created.sequence) || {};
          target = { ...sequence, name, status: 'draft' };
          report.actions.push({ action: 'sequence_created_draft', name, id: sequence.id });
        }

        // AN APPROVAL GATE, NOT A CONVENIENCE: a sequence that sends a PENDING
        // template is a delivery failure at the worst possible moment (hours
        // after the customer's message). It is activated only when every
        // template for that language is APPROVED.
        if (!args.activateSequences) {
          report.actions.push({
            action: 'sequence_left_draft',
            name,
            hint: 're-run with --activate-sequences once every template is APPROVED'
          });
          continue;
        }
        if (!allApproved) {
          report.warnings.push(
            `Sequence ${name} was NOT activated: templates are not all APPROVED (${statuses.join(', ') || 'unknown'}).`
          );
          continue;
        }
        if (target && target.id && target.status !== 'active') {
          await client.activateSequence(target.id);
          report.actions.push({ action: 'sequence_activated', name, id: target.id });
        } else {
          report.actions.push({ action: 'sequence_already_active', name, id: target && target.id });
        }
      }
    }
    if (args.apply && (!profileId || !accountId)) {
      report.warnings.push('Sequences were NOT created: profile id and account id are required.');
    }
  } catch (error) {
    report.sequences = { error: error.code || error.message };
    report.warnings.push('Sequence inspection failed: ' + (error.code || 'error'));
  }

  // ---- Webhook (opt-in) ----------------------------------------------------
  try {
    const response = await client.listWebhookSettings();
    const existing = (response && (response.webhooks || response.endpoints || response.data)) || [];
    report.webhooks = Array.isArray(existing)
      ? existing.map((hook) => ({
        id: hook._id || hook.id,
        name: hook.name,
        url: hook.url,
        events: hook.events,
        isActive: hook.isActive
      }))
      : [];

    if (args.applyWebhook) {
      const secret = requireEnv('ZERNIO_WEBHOOK_SECRET');
      const baseUrl = requireEnv('BASE_URL');
      if (!args.apply) {
        report.warnings.push('--apply-webhook also needs --apply.');
      } else if (!secret || !baseUrl) {
        report.warnings.push('Webhook not registered: ZERNIO_WEBHOOK_SECRET and BASE_URL are required.');
      } else {
        const url = `${baseUrl.replace(/\/+$/, '')}/api/zernio/webhook`;
        const already = Array.isArray(existing) ? existing.find((hook) => hook.url === url) : null;
        if (already) {
          report.actions.push({ action: 'webhook_exists', url, id: already._id || already.id });
        } else {
          const created = await client.createWebhookSettings({
            name: 'Arbitrix WhatsApp automation',
            url,
            secret,
            events: [
              'message.received',
              'message.sent',
              'conversation.control_changed',
              'contact.field_changed',
              'whatsapp.template.status_updated'
            ]
          });
          const hook = (created && created.webhook) || {};
          report.actions.push({ action: 'webhook_created', url, id: hook._id || hook.id });
        }
      }
    }
  } catch (error) {
    report.webhooks = { error: error.code || error.message };
    report.warnings.push('Webhook inspection failed: ' + (error.code || 'error'));
  }

  // ---- Output --------------------------------------------------------------
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Zernio WhatsApp setup - ' + report.mode.toUpperCase());
    console.log('  languages: ' + report.languages.join(', '));
    console.log('  profile:   ' + (report.profileIdConfigured ? 'configured' : 'MISSING'));
    console.log('  account:   ' + (report.accountIdConfigured ? 'configured' : 'MISSING'));

    if (report.accounts) {
      console.log('\nAccounts:');
      if (Array.isArray(report.accounts) && report.accounts.length) {
        for (const account of report.accounts) {
          console.log(`  - ${account.id}  ${account.name || ''}  ${account.status || ''}`.trimEnd());
        }
      } else {
        console.log('  (none returned)');
      }
    }

    if (report.customFields) {
      console.log('\nCustom fields:');
      console.log('  existing: ' + ((report.customFields.existing || []).join(', ') || '(none)'));
      console.log('  missing:  ' + ((report.customFields.missing || []).join(', ') || '(none)'));
    }

    if (report.templatesRequired) {
      console.log('\nTemplates:');
      for (const template of report.templatesRequired) {
        console.log(`  - ${template.name} (${template.language}): ${template.status}`);
      }
    }

    if (report.sequences) {
      console.log('\nSequences:');
      if (Array.isArray(report.sequences) && report.sequences.length) {
        for (const sequence of report.sequences) {
          console.log(`  - ${sequence.name} (${sequence.status}) id=${sequence.id}`);
        }
      } else {
        console.log('  (none)');
      }
      console.log('\nFollow-up schedule (must be confirmed against the live account):');
      console.log('  6h, 1d, 3d after enrollment (steps 360 / 1080 / 2880 minutes).');
    }

    if (report.webhooks) {
      console.log('\nWebhook endpoints:');
      if (Array.isArray(report.webhooks) && report.webhooks.length) {
        for (const hook of report.webhooks) {
          console.log(`  - ${hook.url} active=${hook.isActive}`);
        }
      } else {
        console.log('  (none)');
      }
    }

    if (report.actions.length) {
      console.log('\nActions taken:');
      for (const action of report.actions) {
        console.log('  - ' + JSON.stringify(action));
      }
    }

    if (report.warnings.length) {
      console.log('\nWarnings:');
      for (const warning of report.warnings) console.log('  ! ' + warning);
    }

    console.log('\nNOTE: a submitted template stays PENDING until Meta approves it.');
    console.log('      Nothing is sent to a customer by this script.');
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Zernio setup failed: ' + (error && error.code ? error.code : 'error'));
    process.exit(3);
  });
