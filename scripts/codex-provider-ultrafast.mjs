// Adapt native speed controls only for a known local custom provider.
const id = "[A-Za-z_$][\\w$]*";
const pattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function customProviderUltrafastAccess(hostId, provider, access, model) {
  // 已支持的模型同时开放快速和超快；其他模型保留原生快速权限。
  const supported = /^(?:gpt-6[- ]astra|gpt-6\.1[- ]sol)$/i.test(model);
  return hostId === "local" && typeof provider === "string" && provider !== "" && provider !== "openai"
    ? { ...access, fast: supported || access?.fast === true, ultrafast: supported }
    : access;
}

export function withUltrafastTier(model) {
  if (!model) return model;
  const missing = [{ id: "priority", name: "Fast", description: "" }, { id: "ultrafast", name: "Ultrafast", description: "" }]
    .filter(tier => !model.serviceTiers?.some(existing => existing.id === tier.id));
  return missing.length ? { ...model, serviceTiers: [...(model.serviceTiers ?? []), ...missing] } : model;
}

function functions(source) {
  const entries = [...source.matchAll(/function [\w$]+\([^)]*\)\{/g)];
  return entries.map((entry, index) => ({ entry: entry[0], body: source.slice(entry.index, entries[index + 1]?.index) }));
}

export function rewriteCodexProviderUltrafast(source, sourceUrl) {
  let patched;
  if (/\/app-initial-[\w-]+\.js$/.test(new URL(sourceUrl).pathname)) {
    const hooks = functions(source).filter(({ body }) => body.includes("serviceTierForRequest:") && body.includes("hasManagedNewThreadSettings:"));
    const readers = [...source.matchAll(new RegExp(`let (${id})=(${id})\\((${id}),\\{hostId:(${id}),cwd:(${id})\\}\\)\\.data;return \\1==null\\|\\|\\(\\2\\((${id}),(${id})\\)\\?\\?\\1\\.model_provider\\?\\?\x60openai\x60\\)!==\x60openai\x60`, "g"))];
    if (hooks.length !== 1 || readers.length !== 1) return null;
    const { entry, body } = hooks[0], reader = readers[0];
    const thread = entry.match(/\(([^,]+)/)?.[1];
    const context = body.match(new RegExp(`(${id})=(${id})\\(${pattern(thread)}\\),(${id})=`));
    const access = body.match(new RegExp(`let\\{serviceTierAccess:(${id})\\}=(${id})\\((${id})\\),`));
    const query = body.match(new RegExp(`=(${id})\\(${id},${pattern(thread)}\\)`))?.[1];
    const selected = body.match(new RegExp(`let (${id})=(${id})\\((${id})\\?\\.models,(${id})\\.model\\),`));
    const react = body.match(/\(0,([\w$]+)\.use\)\(/)?.[1];
    if (!context || !access || !query || !selected || !react) return null;
    const accessName = access[1];
    // Subscribe through the native query hook so changing project/provider also recomputes memoized settings.
    const replacement = `${access[0].slice(0, -1)};const panelEnabled=(0,${react}.useSyncExternalStore)(globalThis.__codexPanelProviderUltrafastV1__.subscribe,globalThis.__codexPanelProviderUltrafastV1__.getSnapshot);const panelThreadProvider=${query}(${reader[6]},${thread});const panelConfig=${query}(${reader[3]},${context[1]});const panelProvider=panelThreadProvider??panelConfig.data?.model_provider;const panelAccess=panelEnabled?(${customProviderUltrafastAccess.toString()})(${context[1]}.hostId,panelProvider,${accessName},${selected[4]}.model):${accessName};const panelCustomUltrafast=panelAccess!==${accessName}&&panelAccess.ultrafast;${accessName}=panelAccess;let `;
    const modelCall = `${selected[2]}(${selected[3]}?.models,${selected[4]}.model)`;
    const nextBody = body.replace(access[0], replacement).replace(modelCall, `(panelCustomUltrafast?(${withUltrafastTier.toString()})(${modelCall}):${modelCall})`);
    // OWi consumes the access for its setter; expose the same access to the menu as well.
    const wrappers = functions(source).filter(({body: candidate}) => candidate !== body && candidate.includes(`${entry.match(/function ([\w$]+)/)[1]}(`) && candidate.includes("serviceTierAccess:"));
    if (wrappers.length !== 1) return null;
    const wrapper = wrappers[0].body;
    const fields = wrapper.match(new RegExp(`\\(\\{serviceTierAccess:(${id}),\\.\\.\\.(${id})\\}=`));
    if (!fields) return null;
    const output = new RegExp(`\\{\\.\\.\\.${pattern(fields[2])},setServiceTier:(${id})\\}`);
    if (!output.test(wrapper)) return null;
    patched = source.replace(body, nextBody).replace(wrapper, wrapper.replace(output, `{...${fields[2]},serviceTierAccess:${fields[1]},setServiceTier:$1}`));
  } else if (/\/app-primary-[\w-]+\.js$/.test(new URL(sourceUrl).pathname)) {
    const menus = functions(source).filter(({body}) => body.includes("availableOptions.length>1") && body.includes("composer.openModelPicker"));
    if (menus.length !== 1) return null;
    const body = menus[0].body;
    const settings = body.match(new RegExp(`\\{serviceTierSettings:(${id}),setServiceTier:(${id})\\}=(${id})\\(([^)]*)\\)`));
    const access = body.match(new RegExp(`let\\{serviceTierAccess:(${id})\\}=${id}\\(${id}\\),`));
    const selected = body.match(new RegExp(`(${id})=${settings ? pattern(settings[1]) : "(?!)"}\\.selectedServiceTier`));
    const icon = selected && body.match(new RegExp(`&&(${id})\\((${id}),${pattern(selected[1])}\\),`));
    if (!settings || !access || !icon) return null;
    const next = body.replace(settings[0], settings[0].replace("{serviceTierSettings:", "{serviceTierAccess:panelServiceTierAccess,serviceTierSettings:"))
      .replace(access[0], `let ${access[1]}=panelServiceTierAccess,`)
      .replace(icon[0], `&&(${selected[1]}===\x60ultrafast\x60&&${settings[1]}.availableOptions.some(option=>option.value===\x60ultrafast\x60)||${icon[1]}(${icon[2]},${selected[1]})),`);
    patched = source.replace(body, next);
  } else return null;
  return patched
    .replace(/\bfrom(["'`])(\.\/?[^"'`\n]+)\1/g, (_, quote, specifier) => `from${JSON.stringify(new URL(specifier, sourceUrl).href)}`)
    .replace(/\bimport\((["'`])(\.\/?[^"'`\n]+)\1\)/g, (_, quote, specifier) => `import(${JSON.stringify(new URL(specifier, sourceUrl).href)})`)
    .replaceAll("import.meta.url", JSON.stringify(sourceUrl));
}

export async function prepareCodexProviderUltrafast(cdp, report = console.error) {
  try {
    const result = await cdp.send("Runtime.evaluate", {
      expression: `(async()=>{
        const urls=[...new Set([
          ...performance.getEntriesByType("resource").map(e=>e.name),
          ...[...document.querySelectorAll('script[type="importmap"]')].flatMap(e=>{try{return Object.keys(JSON.parse(e.textContent).imports??{})}catch{return []}}),
          ...[...document.querySelectorAll("script[src],link[rel=modulepreload][href]")].map(e=>e.src||e.href)
        ])];
        return Promise.all(["initial","primary"].map(async kind=>{
          const url=urls.find(url=>new RegExp("/app-"+kind+"-[\\\\w-]+\\\\.js$").test(new URL(url,location.href).pathname));
          if(!url)throw Error("Native speed module missing: "+kind);
          const response=await fetch(url,{cache:"no-store"});
          if(!response.ok)throw Error("Native speed module unreadable: "+kind);
          return {url,source:await response.text()};
        }));
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails || !Array.isArray(result.result?.value)) throw Error("native speed modules could not be read");
    const modules = result.result.value.map(({url, source}) => ({url, source: rewriteCodexProviderUltrafast(source, url)}));
    if (modules.length !== 2 || modules.some(module => module.source === null)) throw Error("unsupported native speed controls");
    report("Panel custom-provider Ultrafast modules prepared for the next renderer load.");
    return modules;
  } catch (error) {
    report(`Panel custom-provider Ultrafast unavailable: ${error.message}`);
    return [];
  }
}
