import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import yaml from 'js-yaml';

const workflow = yaml.load(readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['main-check-scope'].steps.find(step => step.id === 'native-scope');
const source = step.run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
function scope(event, paths, before = 'abc123', fail = false) {
  let output = '', args;
  vm.runInNewContext(source, {
    process: { env: { CHECK_EVENT: event, PUSH_BEFORE: before, GITHUB_OUTPUT: '/fixture/output' } },
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

test('main push filters the complete push range while retaining native and unknown-path checks', () => {
  const web = scope('push', ['web/src/App.tsx', 'CHANGELOG.zh-CN.md']);
  assert.equal(web.native, false);
  assert.deepEqual(web.args.slice(-2), ['abc123', 'HEAD']);
  for (const path of ['src-tauri/src/main.rs', 'scripts/codex-injector.mjs', 'package-lock.json', 'web/public/codex-app-icon.png', '.github/workflows/check.yml']) {
    assert.equal(scope('push', [path]).native, true, path);
  }
  assert.equal(scope('push', ['web/src/App.tsx'], 'missing', true).native, true);
  assert.equal(scope('push', [], '0000000000000000000000000000000000000000').native, true);
  assert.equal(scope('workflow_dispatch', ['README.md']).native, true);
  assert.deepEqual(scope('pull_request', ['README.md']).args.slice(-2), ['HEAD^1', 'HEAD']);
  assert.equal(scope('pull_request', ['README.md']).native, false);
});

test('all platform jobs honor path scope on main pushes and retain full-check reuse', () => {
  for (const name of ['macos-launcher', 'windows-launcher', 'linux-launcher']) {
    const job = workflow.jobs[name];
    assert.ok(job.if.includes("needs['main-check-scope'].outputs.run_native != 'false'"));
    assert.ok(!job.if.includes("github.event_name != 'pull_request'"));
    assert.ok(job.if.includes("needs['main-check-scope'].outputs.run_full != 'false'"));
    const cache = job.steps.find(step => step.name === 'Cache verified Node runtime archives');
    assert.ok(cache.with.path.includes('*.zip'));
    assert.ok(cache.with.path.includes('*.tar.gz'));
  }
  const windows = workflow.jobs['windows-launcher'].steps;
  assert.ok(windows.find(step => step.name === 'Prepare Windows runtime and assets'));
  assert.ok(!windows.find(step => step.name === 'Build the unsigned NSIS installer').run.includes('app:prepare'));
});
