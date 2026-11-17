import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { rewriteRspackProjectlessChat } from '../scripts/codex-rspack-capabilities.mjs';

// 固定原生目标选择与新建动作，不依赖测试机安装的 Codex 或用户会话。
const selectorSource = `function(e,t,n){var r=n("tl5a"),a=n("ndjw"),l=n("V3rO"),i=n("d6Ff"),o=n("QGyr");n.d(t,{},{Z:function(e,{canStartProjectlessChat:t,currentThreadKey:n,localProjectActionsEnabled:d,projectless:s=!1}){if(s)return{assignment:null,kind:"projectless"};let u=(0,i.OC)(n),c=null==u?null:e(l.ic,u),h=null==n?null:e(o.T8,n);if(h?.projectKind==="remote"&&null!=h.hostId||d&&h?.projectKind==="local")return{group:h,kind:"group"};let f=null==c?null:e(r.EL,c),p=null==c?null:e(r.hD,c);return t&&"projectless"===f&&(null==p||"default"===p)?{assignment:null==c?null:e(a.Gm)?.[c]??null,kind:"projectless"}:{kind:"selected"}}})}`;
const actionSource = `function(e,t,n){var r=n("QosV"),i=n("zTeN"),a=n("zd8w"),s=n("E8Sp"),o=n("hvSK"),l=n("ItIk"),u=n("iLYI"),d=n("CSxw"),c=n("knz1"),p=(n("S8De"),n("T8X0"));n("RsWy");var h=n("aOdE"),_=n("oArc"),m=n("yWTM"),f=n("nluz"),g=n("uwwd"),E=n("gPv1"),v=n("ad0f"),y=n("AGHv");n("GCVk"),n("TL6G");var I=n("gBBC"),T=n("OWtl"),C=n("ndjw"),A=n("V3rO"),S=n("B0R5"),b=n("pasN"),w=n("hZax"),O=n("OMIV");function R(e){let t=e.get(O.M9);return"work"===e.get(b.l)&&null!=t&&(0,w.XM)(t,"809615575").get("default_new_chats_to_work",!1)}function N(e,t){if(e.get(l.L)&&("/maps"===e.get(s.gM).pathname||"/maps/"===e.get(s.gM).pathname)){let n=e.get(s.gM).prepareNavigation("/maps",{replace:t?.replace});null!=n&&(t?.onNavigate?.(),n());return}let{activeProject:n,defaultCloudEnvironment:r,prefillComposerMode:i=null,startInSidebar:a,replace:o,onNavigate:T,selectChat:S,freshDraft:b,onFreshChatDraftCreated:w,...O}=t??{},N=null!=O.sitePreviewDraft?(0,m.Dl)(O.sitePreviewDraft):(0,m.w9)({entrypoint:"home"}),k=e.get(A.RH,N),D=(0,_.kk)(e,k),x=b||null!=O.aeonDraft||D?.location.pathname!=="/"?Date.now():D.location.state?.focusComposerNonce,M={...O,...void 0===n?{}:{project:(0,I.av)(n)},focusComposerNonce:x},L=(0,d.$t)(),U={replace:o,state:M},G=L?null:e.get(s.gM).prepareNavigation("/",U);(L||null!=G)&&((T?.(),t?.codexAppMode!=null)?(0,p.Ct)(e,t.codexAppMode):(t?.prefillChatGptSystemHints?.length??0)>0?(0,p.Ct)(e,"chat"):R(e)&&(0,p.Rm)(e,"work"),(0,h.d)(e),null!=x&&(0,c._l)(e,x,i),L||((0,y.dismissStaticEnterpriseOnboarding)(e),(0,g.dr)(e,"new_conversation",()=>e.get(E.Ix).refetch({cancelRefetch:!1})),void 0!==n&&(0,v.n)(e.get(s.gM).pathname)&&((0,I.yN)(e,n),delete M.project),r?((0,C.L6)(e,null),(0,f.A3)(e,null)):(0,f.Qt)(e,e.get(C.Gt)),(b||null!=e.get(A.Pt,k))&&(0,A.dW)(e,{clientNewThreadId:k,draftThreadLocationId:N}),null!=M.sitePreviewDraft&&(M.homeDraftClientThreadId=e.get(A.RH,N)),(b||null!=M.prefillChatGptSystemHints)&&(M.initialChatGptConversationId=(0,u.yD)(e,M.prefillChatGptSystemHints??[]),w?.(M.initialChatGptConversationId)),S?P(e,M,e=>(U.state=e,G?.())):G?.()))}function P(e,t,n){(0,o.hI)(e,{kind:"chat",clientThreadId:e.get(A.RH,t?.sitePreviewDraft!=null?(0,m.Dl)(t.sitePreviewDraft):(0,m.w9)({entrypoint:"home"})),routePath:"/",state:t??{chatGptProjectId:null},navigate:n})}n.d(t,{},{do:R,iK:P,p8:function(){let e,t=(0,r.c)(3),n=(0,i.gh)(T.u),{previewNavigationState:s}=(0,a.useContext)(S.I);return t[0]!==s||t[1]!==n?(e=e=>N(n,null==s?e:{...e,...s}),t[0]=s,t[1]=n,t[2]=e):e=t[2],e},startNewConversation:N})}`;

function execute(source, modules, enabled) {
  const exports = {};
  const load = id => modules[id] ?? {};
  load.d = (target, getters, values = {}) => {
    for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get });
    Object.assign(target, values);
  };
  vm.runInNewContext(`(${rewriteRspackProjectlessChat(source)})`, {
    __codexPanelProjectlessChatV1__: { getSnapshot: () => enabled.value },
  })({}, exports, load);
  return exports;
}

function selector(enabled) {
  return execute(selectorSource, {
    tl5a: { EL: 'workspaceKind', hD: 'executionTarget' },
    ndjw: { Gm: 'assignments' }, V3rO: { ic: 'conversationId' },
    d6Ff: { OC: value => value }, QGyr: { T8: 'threadProject' },
  }, enabled).Z;
}

test('ordinary and recent new-chat targets stop inheriting projects only while enabled', () => {
  const enabled = { value: false }, select = selector(enabled);
  const current = { projectId: 'existing-project', projectKind: 'local' };
  const values = { conversationId: 'existing-thread', threadProject: current, workspaceKind: 'project' };
  const get = field => values[field];
  const options = { canStartProjectlessChat: true, currentThreadKey: 'existing-thread', localProjectActionsEnabled: true };
  assert.equal(select(get, options).group, current);
  enabled.value = true;
  const result = select(get, options);
  assert.equal(result.kind, 'projectless');
  assert.equal(result.assignment, null);
  enabled.value = false;
  assert.equal(select(get, options).group, current);
  // 显式 projectless 的原生入口不受开关关闭影响。
  assert.equal(select(get, { ...options, projectless: true }).kind, 'projectless');
  assert.deepEqual(current, { projectId: 'existing-project', projectKind: 'local' });
});

function actionHarness(enabled) {
  const current = { projectId: 'existing-project', projectKind: 'local' };
  const originalThread = Object.freeze({ id: 'existing-thread', cwd: '/original/project' });
  const values = new Map([
    ['selected', current], ['draftId', 'new-draft'], ['existingDraft', null],
    ['productMode', 'chat'], ['mapsEnabled', false], ['workGate', null],
  ]);
  const navigation = [], assignments = [], workspaceSelections = [], resets = [];
  const router = { pathname: '/', prepareNavigation(path, options) {
    return () => navigation.push({ path, options });
  } };
  values.set('router', router);
  const scope = { get: key => values.get(key), set() { throw Error('不能直接修改已有会话状态'); } };
  const modules = {
    E8Sp: { gM: 'router' }, ItIk: { L: 'mapsEnabled' }, CSxw: { $t: () => false },
    oArc: { kk: () => ({ location: { pathname: '/', state: { focusComposerNonce: 7 } } }) },
    yWTM: { w9: () => 'home-draft', Dl: () => 'preview-draft' },
    V3rO: { RH: 'draftId', Pt: 'existingDraft', dW: () => resets.push('draft') },
    ndjw: { Gt: 'selected', L6: (_scope, project) => values.set('selected', project) },
    gBBC: { av: project => project, yN: (_scope, project) => { values.set('selected', project); assignments.push(project); } },
    nluz: { Qt: (_scope, project) => workspaceSelections.push(project), A3: () => workspaceSelections.push(null) },
    ad0f: { n: path => path === '/' },
    aOdE: { d: () => resets.push('navigation') }, knz1: { _l: () => {} },
    AGHv: { dismissStaticEnterpriseOnboarding() {} }, uwwd: { dr() {} },
    gPv1: { Ix: 'list' }, pasN: { l: 'productMode' }, OMIV: { M9: 'workGate' },
  };
  const action = execute(actionSource, modules, enabled).startNewConversation;
  return { run: options => action(scope, options), current, originalThread, navigation, assignments, workspaceSelections };
}

test('native new-chat action clears only an omitted project and preserves explicit project entries', () => {
  const enabled = { value: false };
  const ordinary = actionHarness(enabled);
  ordinary.run();
  assert.equal(ordinary.assignments.length, 0);
  assert.equal(ordinary.workspaceSelections.at(-1), ordinary.current);
  enabled.value = true;
  const globalNew = actionHarness(enabled);
  const options = { prefillPrompt: 'keep this draft text', replace: true, selectChat: false };
  globalNew.run(options);
  assert.equal(globalNew.assignments.at(-1), null);
  assert.equal(globalNew.workspaceSelections.at(-1), null);
  assert.equal(globalNew.navigation.at(-1).options.state.prefillPrompt, options.prefillPrompt);
  assert.equal(globalNew.navigation.at(-1).options.replace, true);
  assert.equal(Object.hasOwn(options, 'activeProject'), false);
  assert.deepEqual(globalNew.originalThread, { id: 'existing-thread', cwd: '/original/project' });
  for (const projectKind of ['local', 'remote']) {
    const inProject = actionHarness(enabled);
    const project = { projectId: `${projectKind}-project`, projectKind };
    inProject.run({ activeProject: project, prefillPrompt: 'project draft' });
    assert.equal(inProject.assignments.at(-1), project);
    assert.equal(inProject.workspaceSelections.at(-1), project);
    assert.deepEqual(project, { projectId: `${projectKind}-project`, projectKind });
  }
});
