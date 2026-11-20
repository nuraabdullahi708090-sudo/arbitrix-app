'use strict';
/**
 * Structural checks for the repository's GitHub Actions workflows.
 *
 * WHY THIS EXISTS: the workflow that runs this file cannot validate itself, and
 * a bad workflow fails only when it next runs. These checks are deliberately
 * dependency-free (the project ships no YAML parser) and assert the properties
 * that matter for a test-only pipeline:
 *
 *   1. the triggers are the intended ones (PRs to main, pushes to main and the
 *      relaunch branch, manual dispatch),
 *   2. least privilege: `contents: read`, no write scope, no `secrets.*` use -
 *      so no production credential is ever available to a test job,
 *   3. every job is bounded (`timeout-minutes`) and runs on a GitHub-hosted
 *      runner,
 *   4. dependencies come from the lockfile (`npm ci`, never `npm install`),
 *   5. the suite is actually run (`npm test`),
 *   6. NO deployment: no deploy action and no deploy/edit command, checked
 *      against an explicit deny-list.
 *
 * Real YAML well-formedness is proven by GitHub parsing the file when the
 * workflow runs; this script additionally rejects tabs and inconsistent line
 * endings, which are the two encoding mistakes YAML parsers reject with a
 * confusing message.
 *
 * LINE ENDINGS: the rule is "consistent endings", not "LF in this working tree".
 * A Windows checkout with core.autocrlf=true converts the whole file to CRLF
 * without changing a single character of the committed content - that is a
 * local transport artefact, not a defect. What IS a defect is a file that mixes
 * CRLF and LF lines (or carries a lone CR), which no checkout produces. The
 * committed bytes are kept LF by .gitattributes (`* text=auto eol=lf`) and
 * asserted separately by tests/line_endings.test.js via `git ls-files --eol`.
 */
const fs = require('node:fs');
const path = require('node:path');

// The directory can be overridden (argv[2]) so the checks can be exercised
// against fixtures; CI runs it with no argument, against the real workflows.
const DEFAULT_WORKFLOWS_DIR = path.join(__dirname, '..', '.github', 'workflows');
const WORKFLOWS_DIR = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_WORKFLOWS_DIR;
const BRANCHES = ['main', 'relaunch/rebrand-payment-commercial'];

/** Actions that deploy, publish or otherwise change infrastructure. */
const FORBIDDEN_ACTIONS = [
  'actions/deploy-pages',
  'actions/upload-pages-artifact',
  'akhileshns/heroku-deploy',
  'appleboy/ssh-action',
  'aws-actions/',
  'azure/webapps-deploy',
  'azure/aks-set-context',
  'google-github-actions/deploy',
  'google-github-actions/auth',
  'cloudflare/pages-action',
  'cloudflare/wrangler-action',
  'render-inc/',
  'vercel/action',
  'superfly/flyctl-actions',
  'digitalocean/action-doctl',
  'docker/build-push-action',
  'docker/login-action',
  'peaceiris/actions-gh-pages'
];

/** Commands that would deploy, apply a schema, publish a package or push code. */
const FORBIDDEN_COMMANDS = [
  /(^|\s)git\s+push\b/i,
  /\brender\s+(deploy|deploys)\b/i,
  /\bvercel\b/i,
  /\bnetlify\s+deploy\b/i,
  /\bkubectl\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bhelm\s+(install|upgrade)\b/i,
  /\bsupabase\s+(db|migration|functions)\s+(push|deploy)\b/i,
  /\bpsql\b/i,
  /\bnpm\s+publish\b/i,
  /\bnpx\s+wrangler\b/i
];

const problems = [];
function fail(message) {
  problems.push(message);
}

/** Collect a `key: |` block body (the lines after it that are more indented). */
function blockBodies(lines) {
  const bodies = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*-?\s*)(run|script|with):\s*[|>][-+]?\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) { body.push(line); continue; }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      body.push(line);
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

function checkWorkflow(file) {
  const onDisk = fs.readFileSync(file, 'utf8');
  const name = path.basename(file);

  // Consistent endings only (see the header): mixed CRLF/LF or a lone CR is a
  // real malformation; a uniformly-CRLF file is just a Windows checkout.
  const crlfCount = (onDisk.match(/\r\n/g) || []).length;
  const lfCount = (onDisk.match(/(?<!\r)\n/g) || []).length;
  if (crlfCount > 0 && lfCount > 0) {
    fail(`${name}: mixes CRLF and LF line endings (${crlfCount} CRLF, ${lfCount} LF)`);
  }
  if (/\r(?!\n)/.test(onDisk)) fail(`${name}: contains a lone carriage return`);
  // Everything below inspects content, so it runs on the normalised text.
  const raw = crlfCount > 0 ? onDisk.replace(/\r\n/g, '\n') : onDisk;

  if (/^\s*\t/m.test(raw)) fail(`${name}: contains a tab character (YAML forbids tabs for indentation)`);

  const lines = raw.split('\n');
  const inlineRunCommands = lines
    .filter((line) => /^\s*(-\s*)?run:\s+(?!\s*[|>])/.test(line))
    .map((line) => line.replace(/^\s*(-\s*)?run:\s+/, ''));

  // ---- 1. triggers -----------------------------------------------------------
  if (!/^name:\s*\S/m.test(raw)) fail(`${name}: missing a top-level name`);
  if (!/^on:/m.test(raw)) fail(`${name}: missing an "on:" trigger block`);
  if (!/^  pull_request:\s*$/m.test(raw)) fail(`${name}: does not run on pull_request`);
  if (!/^  push:\s*$/m.test(raw)) fail(`${name}: does not run on push`);
  if (!/^  workflow_dispatch:\s*$/m.test(raw)) fail(`${name}: does not support manual dispatch`);

  // Check each trigger's own branch list: a pull_request filter of [main] is
  // correct, while the push filter must also cover the working branch.
  const branchLists = (trigger) => {
    const start = raw.indexOf(`\n  ${trigger}:`);
    if (start === -1) return [];
    const rest = raw.slice(start + 1);
    const end = rest.slice(2).search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
    const block = end === -1 ? rest : rest.slice(0, end + 2);
    const lists = [...block.matchAll(/branches:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    return lists.join(',').split(',').map((v) => v.trim()).filter(Boolean);
  };
  const prBranches = branchLists('pull_request');
  const pushBranches = branchLists('push');
  if (!prBranches.includes('main')) fail(`${name}: pull_request must target main (found: ${prBranches.join(',') || 'none'})`);
  BRANCHES.forEach((branch) => {
    if (!pushBranches.includes(branch)) {
      fail(`${name}: push must cover ${branch} (found: ${pushBranches.join(',') || 'none'})`);
    }
  });
  if (/^\s+branches-ignore:/m.test(raw)) fail(`${name}: use an explicit branch allow-list, not branches-ignore`);

  // ---- 2. least privilege ----------------------------------------------------
  if (!/^permissions:\s*$/m.test(raw) || !/^  contents:\s*read\s*$/m.test(raw)) {
    fail(`${name}: workflow-level "permissions: contents: read" is required`);
  }
  // Scan only uncommented permission lines: the word "write" in a comment is
  // documentation, not a grant.
  const permissionLines = lines
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => /:/.test(line));
  if (permissionLines.some((line) => /:\s*(write|write-all)\s*$/.test(line.trim()))) {
    fail(`${name}: asks for a write permission`);
  }
  if (/\bsecrets\./.test(raw)) fail(`${name}: references secrets.* (a test job must need none)`);
  if (/pull_request_target/.test(raw)) fail(`${name}: pull_request_target is forbidden (it exposes write scope to fork code)`);

  // ---- 3. bounded jobs on hosted runners -------------------------------------
  if (!/^concurrency:\s*$/m.test(raw) || !/cancel-in-progress:\s*true/.test(raw)) {
    fail(`${name}: concurrency with cancel-in-progress: true is required`);
  }
  const jobsBlock = raw.split(/^jobs:\s*$/m)[1] || '';
  const jobNames = [...jobsBlock.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  if (!jobNames.length) fail(`${name}: no jobs found`);
  jobNames.forEach((job) => {
    const start = jobsBlock.indexOf(`\n  ${job}:`);
    const rest = jobsBlock.slice(start + 1);
    const nextJob = rest.slice(2).search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
    const body = nextJob === -1 ? rest : rest.slice(0, nextJob + 2);
    if (!/runs-on:\s*ubuntu-latest/.test(body)) fail(`${name}:${job}: must run on ubuntu-latest`);
    if (!/timeout-minutes:\s*\d+/.test(body)) fail(`${name}:${job}: needs timeout-minutes`);
    if (!/permissions:/.test(body) || !/contents:\s*read/.test(body)) {
      fail(`${name}:${job}: needs job-level "permissions: contents: read"`);
    }
    if (!/uses:\s*actions\/checkout@/.test(body)) fail(`${name}:${job}: must check out the repository`);
    if (/persist-credentials:\s*true/.test(body)) fail(`${name}:${job}: must not persist credentials`);
  });

  // ---- 4/5. dependencies and the suite --------------------------------------
  if (!/\bnpm ci\b/.test(raw)) fail(`${name}: must install with npm ci`);
  if (/\bnpm install\b|\bnpm i\b/.test(raw)) fail(`${name}: must not use npm install (the lockfile is enforced)`);
  if (!/\bnpm test\b/.test(raw)) fail(`${name}: must run npm test`);
  if (!/cache:\s*npm/.test(raw)) fail(`${name}: setup-node should cache npm downloads`);
  if (!/node-version:\s*'?24'?/.test(raw)) fail(`${name}: must pin the Node major the project runs (24)`);

  // ---- 6. no deployment ----------------------------------------------------
  const usesValues = [...raw.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
  usesValues.forEach((action) => {
    if (!action.startsWith('actions/')) {
      fail(`${name}: third-party action ${action} is not allowed in a test-only workflow`);
    }
    FORBIDDEN_ACTIONS.forEach((pattern) => {
      if (action.includes(pattern)) fail(`${name}: deployment action ${action} is forbidden`);
    });
  });
  const commands = blockBodies(lines).concat(inlineRunCommands).join('\n');
  FORBIDDEN_COMMANDS.forEach((pattern) => {
    const hit = pattern.exec(commands);
    if (hit) fail(`${name}: deployment command "${hit[0].trim()}" is forbidden`);
  });
}

function main() {
  if (!fs.existsSync(WORKFLOWS_DIR)) {
    console.error('no .github/workflows directory');
    process.exit(1);
  }
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  if (!files.length) {
    console.error('no workflow files found');
    process.exit(1);
  }
  files.forEach((f) => checkWorkflow(path.join(WORKFLOWS_DIR, f)));

  if (problems.length) {
    console.error(`workflow validation FAILED (${problems.length} problem(s)):`);
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }
  console.log(`workflow validation passed: ${files.join(', ')}`);
}

if (require.main === module) main();

module.exports = { checkWorkflow, FORBIDDEN_ACTIONS, FORBIDDEN_COMMANDS, BRANCHES };
