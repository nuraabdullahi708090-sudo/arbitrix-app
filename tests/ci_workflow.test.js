'use strict';
/**
 * CI workflow contract.
 *
 * The workflow cannot test itself, so this suite pins what it must and must not
 * do, and proves scripts/validate-workflows.js actually rejects the mistakes it
 * claims to catch (each mutation below would otherwise be a silent rubber stamp).
 *
 * No YAML dependency is available in this project (the suite is deliberately
 * dependency-free), so the real assertions are structural, plus a real parse is
 * proven by GitHub running the file on push.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const WORKFLOW = path.join(WORKFLOWS_DIR, 'ci.yml');
const VALIDATOR = path.join(ROOT, 'scripts', 'validate-workflows.js');
const SRC = fs.readFileSync(WORKFLOW, 'utf8');

function runValidator(dir) {
  const result = spawnSync(process.execPath, [VALIDATOR, ...(dir ? [dir] : [])], {
    encoding: 'utf8',
    cwd: ROOT
  });
  return { code: result.status, out: (result.stdout || '') + (result.stderr || '') };
}

function withFixture(name, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, mutate(SRC), 'utf8');
  return dir;
}

test('the workflow directory holds exactly one workflow, and it is the CI file', () => {
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.deepStrictEqual(files, ['ci.yml'],
    'one workflow only: a second file could add a deploy path nobody reviews');
});

test('triggers: PRs to main, pushes to main and the working branch, manual dispatch', () => {
  assert.match(SRC, /^on:\n/m);
  assert.match(SRC, / {2}pull_request:\n {4}branches: \[main\]/, 'pull requests must target main');
  assert.match(SRC, / {2}push:\n {4}branches: \[main, relaunch\/rebrand-payment-commercial\]/,
    'pushes to main and the relaunch branch');
  assert.match(SRC, /^ {2}workflow_dispatch:\s*$/m, 'manual execution');
  assert.ok(!/branches-ignore/.test(SRC), 'an allow-list, not a deny-list');
  assert.ok(!/pull_request_target/.test(SRC), 'fork code never gets a write token');
});

test('least privilege: contents: read, no write scope, no secrets', () => {
  assert.match(SRC, /^permissions:\n {2}contents: read$/m);
  const jobPermissions = SRC.match(/ {4}permissions:\n {6}contents: read/g) || [];
  assert.strictEqual(jobPermissions.length, 2, 'both jobs declare their own read-only permission');
  assert.ok(!/:\s*write\s*$/m.test(SRC), 'no write permission anywhere');
  assert.ok(!/secrets\./.test(SRC), 'a test job must need no secret');
});

test('bounded and cancellable: timeouts plus concurrency cancellation', () => {
  const timeouts = [...SRC.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.strictEqual(timeouts.length, 2, 'one timeout per job');
  timeouts.forEach((minutes) => assert.ok(minutes > 0 && minutes <= 30, `sane timeout, got ${minutes}`));
  assert.match(SRC, /^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
});

test('Node 24 from the lockfile, with dependency caching', () => {
  assert.match(SRC, /uses: actions\/setup-node@v4/);
  assert.match(SRC, /node-version: '24'/);
  assert.match(SRC, /cache: npm/);
  assert.match(SRC, /cache-dependency-path: package-lock\.json/);
  assert.match(SRC, /run: npm ci --no-audit --no-fund/);
  assert.ok(!/npm install|npm i\b/.test(SRC.replace(/npm ci/g, '')), 'the lockfile is enforced');
  assert.match(SRC, /run: npm test/);
});

test('the Node major matches what the project actually runs', () => {
  // The suite is developed on Node 24; a mismatch here is how CI starts failing
  // for reasons unrelated to the change under review.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.express, 'express is the runtime, as expected');
  assert.ok(!pkg.engines || !pkg.engines.node || /24/.test(pkg.engines.node),
    'if an engines field is added it must agree with the workflow');
  assert.match(SRC, /node-version: '24'/);
});

test('no deployment action and no deployment command', () => {
  const uses = [...SRC.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual(uses.sort(), ['actions/checkout@v4', 'actions/checkout@v4', 'actions/setup-node@v4', 'actions/setup-node@v4'],
    'only the two official setup actions, each pinned to a major version');
  const forbidden = [/git push/i, /\brender\b/i, /vercel/i, /kubectl/i, /terraform/i, /psql/i,
    /supabase db push/i, /npm publish/i, /wrangler/i, /docker (build|push)/i];
  forbidden.forEach((pattern) => {
    assert.ok(!pattern.test(SRC.replace(/^#.*$/gm, '')),
      `the workflow must not run a deployment command (${pattern})`);
  });
});

test('every JavaScript file is parsed, including files the tests never import', () => {
  // Driven by `git ls-files '*.js'` rather than a hand-written glob list: the
  // earlier list missed nested service directories (services/support/providers),
  // so a syntax error there could reach a deploy with every test still green.
  assert.match(SRC, /git ls-files '\*\.js'/, 'the file list comes from git');
  assert.match(SRC, /node --check "\$f"/, 'each file is parsed');
  assert.ok(SRC.includes("grep -vE '^(tests|node_modules)/'"),
    'tests/ is excluded (the suite already imports them) and node_modules is not scanned');
  const entries = ['server.js', 'worker.js', 'marketing-worker.js', 'conversion-worker.js'];
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(ROOT, entry)), `${entry} exists and is parsed by CI`);
    assert.match(entry, /\.js$/, 'and matches the parsed extension');
  }
  // Every one of those entrypoints really is reachable by the glob.
  const listed = require('node:child_process')
    .execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n');
  for (const entry of entries) {
    assert.ok(listed.includes(entry), `${entry} is tracked and therefore parsed`);
  }
});

test('the real workflow passes the repository validator', () => {
  const { code, out } = runValidator();
  assert.strictEqual(code, 0, out);
  assert.match(out, /workflow validation passed: ci\.yml/);
});

test('the validator rejects a deploy action', () => {
  const dir = withFixture('ci.yml', (src) => src.replace(
    '      - name: Run the test suite',
    '      - uses: akhileshns/heroku-deploy@v3.12.14\n\n      - name: Run the test suite'));
  const { code, out } = runValidator(dir);
  assert.notStrictEqual(code, 0);
  assert.match(out, /deployment action|third-party action/);
});

test('the validator rejects a git push, a psql call and a supabase schema push', () => {
  const push = runValidator(withFixture('ci.yml', (src) => src.replace('run: npm test', 'run: npm test && git push origin main')));
  assert.notStrictEqual(push.code, 0);
  assert.match(push.out, /deployment command "git push"/);

  const psql = runValidator(withFixture('ci.yml', (src) => src.replace('run: npm ci --no-audit --no-fund', 'run: psql "$DATABASE_URL" -f schema.sql')));
  assert.notStrictEqual(psql.code, 0);
  assert.match(psql.out, /deployment command "psql"/);

  const supabase = runValidator(withFixture('ci.yml', (src) => src.replace('run: npm test', 'run: supabase db push')));
  assert.notStrictEqual(supabase.code, 0);
  assert.match(supabase.out, /deployment command/);
});

test('the validator rejects npm install, a write permission, a missing timeout, secrets and tabs', () => {
  const install = runValidator(withFixture('ci.yml', (src) => src.replace('run: npm ci --no-audit --no-fund', 'run: npm install')));
  assert.notStrictEqual(install.code, 0);
  assert.match(install.out, /must not use npm install/);

  const write = runValidator(withFixture('ci.yml', (src) => src.replace('  contents: read', '  contents: write')));
  assert.notStrictEqual(write.code, 0);
  assert.match(write.out, /write permission/);

  const timeout = runValidator(withFixture('ci.yml', (src) => src.replace('    timeout-minutes: 20\n', '')));
  assert.notStrictEqual(timeout.code, 0);
  assert.match(timeout.out, /needs timeout-minutes/);

  const secrets = runValidator(withFixture('ci.yml', (src) => src.replace('run: npm test', 'run: npm test\n        env:\n          KEY: ${{ secrets.PAYHIP_API_KEY }}')));
  assert.notStrictEqual(secrets.code, 0);
  assert.match(secrets.out, /references secrets/);

  const tabs = runValidator(withFixture('ci.yml', (src) => src.replace('    runs-on: ubuntu-latest', '\truns-on: ubuntu-latest')));
  assert.notStrictEqual(tabs.code, 0);
  assert.match(tabs.out, /tab character/);
});

test('the validator rejects a fork-triggered workflow and a wrong trigger set', () => {
  const target = runValidator(withFixture('ci.yml', (src) => src.replace('  pull_request:', '  pull_request_target:')));
  assert.notStrictEqual(target.code, 0);
  assert.match(target.out, /pull_request_target is forbidden/);

  const prOnlyMain = runValidator(withFixture('ci.yml', (src) => src.replace(
    '    branches: [main, relaunch/rebrand-payment-commercial]',
    '    branches: [main]')));
  assert.notStrictEqual(prOnlyMain.code, 0);
  assert.match(prOnlyMain.out, /push must cover relaunch\/rebrand-payment-commercial/);

  const manual = runValidator(withFixture('ci.yml', (src) => src.replace('  workflow_dispatch:\n', '')));
  assert.notStrictEqual(manual.code, 0);
  assert.match(manual.out, /manual dispatch/);
});

test('an empty workflow directory is a hard failure, not a silent pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-empty-'));
  const { code, out } = runValidator(dir);
  assert.notStrictEqual(code, 0);
  assert.match(out, /no workflow files found/);
});

test('no local path or machine-specific value leaked into the workflow', () => {
  assert.ok(!/\/home\/|\/tmp\/|C:\\\\/.test(SRC), 'no local paths');
  assert.ok(!/self-hosted/.test(SRC), 'hosted runners only');
  assert.ok(!/continue-on-error:\s*true/.test(SRC), 'a failing step must fail the run');
  assert.ok(!/if:\s*always\(\)/.test(SRC), 'no step that runs past a failure in the test job');
});
