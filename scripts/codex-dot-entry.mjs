// Restore Dot through the local capability gate; server authorization is unchanged.
const id = "[A-Za-z_$][\\w$]*";

export function rewriteCodexDotEntry(source, sourceUrl) {
  const capabilities = [...source.matchAll(new RegExp(`(${id})=(${id})\\((${id}),\\((${id}),\\{get:(${id})\\}\\)=>\\{let (${id})=${id}\\[\\4\\.name\\];`, "g"))];
  const states = [...source.matchAll(new RegExp(`let ${id}=(${id})\\((${id}),${id}=>${id}\\(${id}\\(${id}\\),${id}\\),\\{getServerSnapshot:\\(\\)=>${id},onMount\\(`, "g"))];
  if (capabilities.length !== 1 || states.length !== 1 || capabilities[0][3] !== states[0][2]
    || !source.includes('orbit:{accessPolicy:`orbit`,requiresFirstPartyInference:!0}')) return null;
  const [entry, , , scope, request, get, config] = capabilities[0];
  const gate = `if(${config}.requiresFirstPartyInference&&${get}(`;
  if (source.split(gate).length !== 2) return null;
  // 订阅原生 atom，使侧栏、路由和快捷键共用同一能力值，开关变化不需要刷新页面。
  const runtime = 'globalThis.__codexPanelDotEntryV1__';
  const atom = `${runtime}.preference`;
  const initialize = `${atom}=${states[0][1]}(${scope},()=>${runtime}.getSnapshot(),{onMount(set){set(${runtime}.getSnapshot());return ${runtime}.subscribe(()=>set(${runtime}.getSnapshot()))}}),`;
  // signal family 必须显式传 key；省略会将返回的布尔值当作 atom，导致主界面崩溃。
  const patched = source.replace(entry, initialize + entry
    + `if(${request}.name===\`orbit\`&&${get}(${atom},void 0))return{isLoading:false,isError:false,isCapable:true};`);
  return patched
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, sourceUrl).href)}`)
    .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, specifier) => `import(${JSON.stringify(new URL(specifier, sourceUrl).href)})`)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl));
}

export async function prepareCodexDotEntry(cdp, modules, report = console.error) {
  try {
    let initial = modules.find(module => /\/app-initial-[\w-]+\.js$/.test(new URL(module.url).pathname));
    if (!initial) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: `(async()=>{
          const urls=[...performance.getEntriesByType("resource").map(e=>e.name),
            ...[...document.querySelectorAll('script[type="importmap"]')].flatMap(e=>{try{return Object.keys(JSON.parse(e.textContent).imports??{})}catch{return []}}),
            ...[...document.querySelectorAll("script[src],link[rel=modulepreload][href]")].map(e=>e.src||e.href)];
          const url=urls.find(url=>/\\/app-initial-[\\w-]+\\.js$/.test(new URL(url,location.href).pathname));
          if(!url)throw Error("Native Dot module missing");
          const response=await fetch(url,{cache:"no-store"});
          if(!response.ok)throw Error("Native Dot module unreadable");
          return {url,source:await response.text()};
        })()`, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails || typeof result.result?.value?.source !== "string") throw Error("native Dot module could not be read");
      initial = result.result.value;
    }
    const source = rewriteCodexDotEntry(initial.source, initial.url);
    if (source === null) throw Error("unsupported native Dot capability structure");
    report("Panel custom-provider Dot entry module prepared for the next renderer load.");
    return { modules: [...modules.filter(module => module.url !== initial.url), { url: initial.url, source }], prepared: true };
  } catch (error) {
    report(`Panel custom-provider Dot entry unavailable: ${error.message}`);
    return { modules, prepared: false };
  }
}
