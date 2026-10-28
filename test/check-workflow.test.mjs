import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['main-check-scope'].steps.find(step => step.id === 'native-scope');
const source = step.run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
function scope(event, paths, fail = false) {
  let output = '', args;
  vm.runInNewContext(source, {
    process: { env: { CHECK_EVENT: event, GITHUB_OUTPUT: '/fixture/output' } },
    console: { log() {} },
    require(name) {
      if (name === 'node:fs') return { appendFileSync(_path, value) { output += value; } };
      if (name === 'node:child_process') return { execFileSync(_command, value) {
        args = value;
        if (fail) throw Error('missing base');
        return paths.join('\0') + '\0';
      } };
      throw Error(name);
    },
  });
  return { native: output.trim() === 'run_native=true', args: args && Array.from(args) };
}

test('main pushes run types and tests without builds while PR and manual runs retain full checks', () => {
  const mainJob = workflow.jobs['main-check'];
  assert.equal(mainJob.if, "github.event_name == 'push'");
  assert.deepEqual(mainJob.steps.filter(step => step.run).map(step => step.run), ['npm ci', 'npm run typecheck', 'npm test']);
  for (const name of ['main-check-scope', 'check', 'macos-launcher', 'windows-launcher', 'linux-launcher']) {
    assert.ok(workflow.jobs[name].if.includes("github.event_name != 'push'"), name);
  }
  assert.ok(workflow.jobs.check.steps.some(step => step.run === 'npm run check'));
  const web = scope('pull_request', ['web/src/App.tsx', 'CHANGELOG.zh-CN.md']);
  assert.equal(web.native, false);
  assert.deepEqual(web.args.slice(-2), ['HEAD^1', 'HEAD']);
  assert.equal(scope('pull_request', ['src-tauri/src/main.rs']).native, true);
  assert.equal(scope('pull_request', ['README.md'], true).native, true);
  assert.equal(scope('workflow_dispatch', ['README.md']).native, true);
});

test('PR platform jobs retain path scope and compile without packaging', () => {
  for (const name of ['macos-launcher', 'windows-launcher', 'linux-launcher']) {
    const job = workflow.jobs[name];
    assert.ok(job.if.includes("needs['main-check-scope'].outputs.run_native != 'false'"));
    assert.ok(job.steps.some(step => step.run?.startsWith('cargo check ')));
    assert.ok(job.steps.filter(step => step.run?.startsWith('cargo check ')).every(step => step.run.includes('--all-targets') && step.run.includes('--locked')));
    const config = JSON.parse(job.env.TAURI_CONFIG);
    assert.equal(config.bundle.active, false);
    assert.deepEqual(config.bundle.externalBin, []);
    assert.deepEqual(config.bundle.resources, {});
    const commands = job.steps.map(step => step.run || '').join('\n');
    assert.doesNotMatch(commands, /app:prepare|tauri.*build|app:build|app:preflight|verify.*package|codesign/);
    assert.ok(!job.steps.some(step => step.uses?.startsWith('actions/upload-artifact@')));
  }
});
