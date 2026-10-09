import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = await readFile(new URL("../inject/codex-panel.user.js", import.meta.url), "utf8");
const functions = source.slice(source.indexOf("  function buttonMatches("), source.indexOf("  function findPageHost("));
function fixture(markup) {
  const dom = new JSDOM(markup);
  let opened = 0;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return {top:100,bottom:130,height:this.hidden?0:30};
  };
  const api = vm.runInNewContext(`let entry=null; const destroyed=false, active=false;
    const OWNED_ATTRIBUTE="data-codex-panel-owned",ENTRY_ID="codex-panel-entry",EXPLORE_LABELS=["探索","explore"],PLUGIN_LABELS=["plugins","插件"];
    const normalizedLabel=value=>value.trim().toLowerCase();
    ${functions}
    ({ensureEntry,findReferenceButton})`, {
    document:dom.window.document,installStyles(){},openPanel(){opened++;},
  });
  return {dom,api,get opened(){return opened;}};
}

test("new sidebar destinations outside the scroll area mount exactly one functional entry", () => {
  for (const tag of ["button","a","div"]) {
    const f=fixture(`<main><div data-slate-sidebar-content><nav><${tag} class="sidebar-item" role="button" data-sidebar-destination="customize" href="/skills" aria-labelledby="native"><span class="text-fade-truncate" id="native">Plugins</span></${tag}></nav><div data-app-action-sidebar-scroll><section data-app-action-sidebar-section></section></div></div></main>`);
    f.api.ensureEntry();f.api.ensureEntry();
    const entry=f.dom.window.document.getElementById("codex-panel-entry");
    assert.ok(entry);
    assert.equal(f.dom.window.document.querySelectorAll("#codex-panel-entry").length,1);
    assert.equal(entry.textContent.trim(),"任务面板");
    assert.equal(entry.hasAttribute("href"),false);
    assert.equal(entry.hasAttribute("data-sidebar-destination"),false);
    assert.equal(entry.hasAttribute("aria-labelledby"),false);
    entry.click();assert.equal(f.opened,1);
    if(tag!=="button") {
      entry.dispatchEvent(new f.dom.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
      assert.equal(f.opened,2);
    }
    const nav=entry.parentElement;
    const replacement=nav.cloneNode(true);
    replacement.querySelector("#codex-panel-entry").remove();
    nav.replaceWith(replacement);f.api.ensureEntry();
    assert.equal(entry.isConnected,true);
    assert.equal(entry.parentElement,replacement);
  }
});

test("legacy scroll area accepts native link and role-button rows", () => {
  for(const row of ['<a class="sidebar-item" href="/skills">Plugins</a>','<div class="sidebar-item" role="button">Plugins</div>']) {
    const f=fixture(`<div data-app-action-sidebar-scroll>${row}</div>`);
    f.api.ensureEntry();assert.ok(f.dom.window.document.getElementById("codex-panel-entry"));
  }
});

test("Panel does not inherit the native sidebar notification dot", () => {
  const f = fixture('<div data-slate-sidebar-content><button data-sidebar-destination="plugins"><span class="icon-leading-slot"><svg></svg></span><span class="text-fade-truncate">Plugins</span><span data-native-dot style="background:blue;border-radius:50%"></span></button></div>');
  try {
    const { document } = f.dom.window;
    const reference = document.querySelector('[data-sidebar-destination]');
    const original = reference.outerHTML;
    f.api.ensureEntry();
    f.api.ensureEntry();
    const entry = document.getElementById('codex-panel-entry');
    assert.equal(entry.querySelector('[data-native-dot]'), null);
    assert.equal(entry.children.length, 2);
    assert.equal(entry.textContent.trim(), '任务面板');
    assert.ok(entry.querySelector('.icon-leading-slot svg rect'));
    assert.equal(reference.outerHTML, original);
    entry.click();
    assert.equal(f.opened, 1);
  } finally { f.dom.window.close(); }
});

test("Free sidebar mounts after New chat without plugins, pets or destination attributes", () => {
  for (const container of ['aside', 'div data-slate-sidebar-content']) {
    for (const label of ['新聊天', 'New chat']) {
      const tag = container.split(' ')[0];
      const f = fixture(`<${container}><a id="new-chat" href="/" class="sidebar-item"><svg></svg>${label}</a><div data-app-action-sidebar-scroll><section data-app-action-sidebar-section>没有项目</section></div></${tag}>`);
      try {
        f.api.ensureEntry();
        f.api.ensureEntry();
        const { document, KeyboardEvent } = f.dom.window;
        const entry = document.getElementById('codex-panel-entry');
        assert.equal(document.querySelectorAll('#codex-panel-entry').length, 1);
        assert.equal(entry.previousElementSibling.id, 'new-chat');
        assert.equal(entry.textContent.trim(), '任务面板');
        assert.ok(entry.querySelector('svg rect'));
        assert.equal(entry.hasAttribute('href'), false);
        entry.click();
        entry.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        assert.equal(f.opened, 2);
        assert.equal(document.getElementById('new-chat').getAttribute('href'), '/');
        const oldRoot = entry.parentElement;
        const newRoot = oldRoot.cloneNode(true);
        newRoot.querySelector('#codex-panel-entry').remove();
        oldRoot.replaceWith(newRoot);
        f.api.ensureEntry();
        assert.equal(entry.parentElement, newRoot);
      } finally { f.dom.window.close(); }
    }
  }
});

test("Free fallback ignores chat-area controls and hidden or inert sidebar rows", () => {
  const f = fixture('<main><button>新聊天</button></main><aside><button hidden>新聊天</button><div inert><button>New chat</button></div></aside>');
  try {
    f.api.ensureEntry();
    assert.equal(f.dom.window.document.getElementById('codex-panel-entry'), null);
  } finally { f.dom.window.close(); }
});


test("nested New chat row keeps original actions and mounts Panel as a separate row", () => {
  const f = fixture('<aside><div id="new-row" class="sidebar-item"><button class="sidebar-item"><span class="icon-leading-slot"><svg></svg></span><span class="text-fade-truncate">新聊天</span></button><button aria-label="快速聊天">+</button></div><div data-app-action-sidebar-scroll></div></aside>');
  try {
    const doc = f.dom.window.document;
    const row = doc.getElementById('new-row');
    const original = row.outerHTML;
    let newChats = 0;
    row.querySelector('button').addEventListener('click', () => newChats++);
    f.api.ensureEntry();
    f.api.ensureEntry();
    const entry = doc.getElementById('codex-panel-entry');
    assert.equal(row.outerHTML, original);
    assert.equal(entry.previousElementSibling, row);
    assert.equal(entry.parentElement, row.parentElement);
    assert.equal(entry.style.width, '100%');
    assert.equal(entry.querySelectorAll('button').length, 0);
    entry.click();
    assert.equal(f.opened, 1);
    assert.equal(newChats, 0);
    row.querySelector('button').click();
    assert.equal(newChats, 1);
  } finally { f.dom.window.close(); }
});


test("rail entry preserves the native icon wrapper and position before Explore", () => {
  const f = fixture('<aside><nav data-app-navigation-rail><button id="explore"><span class="native-icon-center"><svg class="size-5"></svg></span><span class="sr-only">探索</span></button></nav></aside>');
  try {
    const { document } = f.dom.window;
    const original = document.getElementById("explore").outerHTML;
    f.api.ensureEntry();
    const entry = document.getElementById("codex-panel-entry");
    assert.ok(entry.querySelector(".native-icon-center > svg.size-5"));
    assert.equal(entry.nextElementSibling.id, "explore");
    assert.equal(document.getElementById("explore").outerHTML, original);
  } finally { f.dom.window.close(); }
});

// 新版保留不可交互的侧边栏时，入口必须落在当前可用侧边栏而非第一个节点。
test("mount skips retained inert sidebars and follows the active sidebar", () => {
  const f = fixture(`<div data-slate-sidebar-content inert><button data-sidebar-destination="plugins">Plugins</button></div>
    <div data-slate-sidebar-content><button data-sidebar-destination="plugins">Plugins</button></div>`);
  try {
    const roots = f.dom.window.document.querySelectorAll('[data-slate-sidebar-content]');
    f.api.ensureEntry();
    const entry = f.dom.window.document.getElementById('codex-panel-entry');
    assert.ok(entry);
    assert.equal(entry.parentElement, roots[1]);
    roots[1].setAttribute('inert', '');
    roots[0].removeAttribute('inert');
    f.api.ensureEntry();
    assert.equal(entry.parentElement, roots[0]);
    assert.equal(f.dom.window.document.querySelectorAll('#codex-panel-entry').length, 1);
    entry.click();
    assert.equal(f.opened, 1);
  } finally { f.dom.window.close(); }
});

// 直接验证用户指定的位置：图标栏导航末尾、头像之前，内容侧边栏不再保留入口。
test("Panel lives in the navigation rail and opens when the content sidebar is collapsed", () => {
  const f = fixture(`<nav data-app-navigation-rail><div class="overflow-y-auto"><div><button class="native-icon" data-sidebar-destination="home"><svg></svg>Home</button></div></div><button id="avatar">Account</button></nav>
    <aside data-slate-sidebar-content><button data-sidebar-destination="plugins">Plugins</button></aside>`);
  try {
    const document = f.dom.window.document;
    f.api.ensureEntry();
    const entry = document.getElementById('codex-panel-entry');
    assert.equal(entry.parentElement, document.querySelector('.overflow-y-auto'));
    assert.equal(entry.textContent.trim(), '');
    assert.equal(entry.title, '任务面板');
    assert.equal(entry.getAttribute('aria-label'), '打开任务面板');
    assert.ok(entry.querySelector('svg rect'));
    document.querySelector('aside').setAttribute('inert', '');
    f.api.ensureEntry();
    assert.equal(document.querySelectorAll('#codex-panel-entry').length, 1);
    assert.equal(document.querySelector('aside #codex-panel-entry'), null);
    entry.click();
    assert.equal(f.opened, 1);
  } finally { f.dom.window.close(); }
});
