import assert from 'node:assert/strict';
import test from 'node:test';
import { applyEdits, propertyValue, sourceAst } from '../scripts/codex-source-ast.mjs';
import { rspackSourceContext } from '../scripts/codex-rspack-source.mjs';

test('keeps lexical binding identity when names repeat and fields move', () => {
  const source = 'function(module,exports,load){const label="中文😀";let {hostId:host,cwd}=scope;function read(host){return host+label}return {cwd,host,label}}';
  const ast = sourceAst(source, { factory: true });
  const hosts = ast.all(node => node.type === 'Identifier' && node.name === 'host');
  const binding = ast.binding(hosts[0]);
  assert.equal(binding, ast.binding(hosts.at(-1)));
  assert.notEqual(binding, ast.binding(hosts[1]));
  assert.equal(ast.binding(hosts[1]), ast.binding(hosts[2]));
  assert.equal(ast.text(ast.value(ast.find(node => node.type === 'Identifier' && node.name === 'label'))), '"中文😀"');
  const returned = ast.find(node => node.type === 'ObjectExpression');
  assert.equal(ast.binding(propertyValue(returned, 'host')), binding);
  assert.equal(ast.references(binding).length, 1);
});

test('resolves moved modules through getter, direct and forwarded exports', () => {
  const sources = {
    consumer: 'function(m,e,r){let via=r("forward");e.use=()=>via.reader}',
    forward: 'function(m,e,r){r.d(e,{reader:()=>later.reader});let later=r("definition")}',
    definition: 'function(m,e,r){r.d(e,{}, {reader:renamed});const unused="reader:wrong";function renamed(input){return {kind:"native",input}}}',
  };
  const context = rspackSourceContext(new Map(Object.entries(sources).map(([id, source]) => [id, { id, source }])));
  const ast = context.moduleAst('consumer');
  const member = ast.find(node => node.type === 'MemberExpression' && node.property.name === 'reader');
  assert.deepEqual(context.exportOf(ast, member), { id: 'forward', exportName: 'reader' });
  const resolved = context.resolve(ast, member);
  assert.equal(resolved.node.type, 'FunctionDeclaration');
  assert.equal(resolved.node.id.name, 'renamed');
  assert.deepEqual(context.exportOf(resolved.ast, resolved.node), { id: 'definition', exportName: 'reader' });
  assert.equal(context.moduleAst('definition'), resolved.ast);
});

test('edits syntax ranges without changing matching text in comments or strings', () => {
  const source = '/* flag:false */ const title="flag:false";const value={flag:false,other:1};';
  const ast = sourceAst(source);
  const flag = propertyValue(ast.find(node => node.type === 'ObjectExpression'), 'flag');
  assert.equal(applyEdits(source, [{ start: flag.start, end: flag.end, text: 'true' }]), source.replace('{flag:false,', '{flag:true,'));
  assert.throws(() => applyEdits(source, [{ start: 1, end: 5, text: '' }, { start: 4, end: 6, text: '' }]), /Overlapping/);
  assert.throws(() => sourceAst('function(){', { factory: true }), /Cannot parse/);
});

test('a global call in a factory without require is not a module import', () => {
  const sources = {
    consumer: 'function(m,e){const namespace=arbitrary("remote");e.answer=namespace.value;}',
    remote: 'function(m,e,r){r.d(e,{}, {value:42})}',
  };
  const context = rspackSourceContext(new Map(Object.entries(sources).map(([id, source]) => [id, { id, source }])));
  const ast = context.moduleAst('consumer');
  const member = ast.find(node => node.type === 'MemberExpression' && node.property.name === 'value');
  const resolved = context.resolve(ast, member);
  assert.equal(resolved.ast, ast);
  assert.equal(resolved.node, member);
  assert.equal(context.exportOf(ast, member), null);
});
