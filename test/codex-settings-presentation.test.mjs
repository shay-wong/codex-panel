import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { createSettingsPresentationRuntime, rewriteRspackSettingsPresentation } from '../scripts/codex-settings-presentation.mjs';

test('settings presentation follows live preferences and can restore the native choice', () => {
  const runtime = createSettingsPresentationRuntime();
  let changes = 0;
  const unsubscribe = runtime.subscribe(() => changes++);
  assert.equal(runtime.getSnapshot(), 'system');
  runtime.setMode('dialog');
  runtime.setMode('dialog');
  assert.equal(runtime.getSnapshot(), 'dialog');
  assert.equal(changes, 1);
  runtime.setMode('page');
  assert.equal(runtime.getSnapshot(), 'page');
  runtime.setMode('system');
  assert.equal(runtime.getSnapshot(), 'system');
  unsubscribe();
  runtime.setMode('dialog');
  assert.equal(changes, 3);
});

test('only the native settings gate is overridden without skipping either hook', () => {
  const source = `function(module,exports,require){
    const react=require('react'),flags=require('flags');
    exports.Settings=function(){
      react.useContext({});
      const unrelated=flags.useGate('other-gate');
      const enabled=flags.useGate('3561799561');
      return {view:enabled?'dialog':'page',unrelated};
    };
  }`;
  const rewritten = rewriteRspackSettingsPresentation(source);
  assert.ok(rewritten);
  const runtime = createSettingsPresentationRuntime();
  let nativeEnabled = false;
  const calls = [];
  const module = { exports: {} };
  const factory = vm.runInNewContext(`(${rewritten})`, { __codexPanelSettingsPresentationV1__: runtime });
  factory(module, module.exports, name => name === 'react' ? {
    useContext() {},
    useSyncExternalStore(_subscribe, snapshot) { calls.push('subscription'); return snapshot(); },
  } : {
    useGate(id) { calls.push(id); return id === '3561799561' ? nativeEnabled : true; },
  });
  const view = () => {
    calls.length = 0;
    const result = module.exports.Settings();
    assert.equal(result.unrelated, true);
    assert.deepEqual(calls, ['other-gate', '3561799561', 'subscription']);
    return result.view;
  };
  assert.equal(view(), 'page');
  runtime.setMode('dialog');
  assert.equal(view(), 'dialog');
  nativeEnabled = true;
  runtime.setMode('page');
  assert.equal(view(), 'page');
  runtime.setMode('system');
  assert.equal(view(), 'dialog');
  nativeEnabled = false;
  assert.equal(view(), 'page');
});
