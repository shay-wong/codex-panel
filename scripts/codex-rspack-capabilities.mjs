// These functions are serialized into the native module loader; keep their helpers local.
export function rewriteRspackUltrafast(source, context) {
  const id = "[A-Za-z_$][\\w$]*";
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (source.includes("serviceTierForRequest:") && source.includes("hasManagedNewThreadSettings:")) {
    const args = source.match(/^function\s*[^\(]*\(([^)]*)\)/)?.[1].split(",");
    const requireName = args?.[2];
    const provider = context.findModule(["model_picker_upsell", "model_provider", "let{cwd:"]);
    const reader = provider?.source.match(new RegExp(`let\\{cwd:(${id}),hostId:(${id})\\}=(${id})\\.get\\((${id})\\.(${id}),(${id})\\);if\\(["\x60]local["\x60]!==\\2\\)return null;let\\{data:(${id})\\}=\\3\\.get\\((${id})\\.(${id}),\\{cwd:\\1,hostId:\\2\\}\\);return null==\\7\\|\\|\\(\\3\\.get\\((${id})\\.(${id}),\\6\\)\\?\\?\\7\\.model_provider\\?\\?["\x60]openai["\x60]\\)!==["\x60]openai["\x60]`));
    const dependency = (namespace, symbol) => {
      const pattern = new RegExp(`\\b${escape(namespace)}=${id}\\(["\x60]([^"\x60]+)["\x60]\\)`);
      const moduleId = provider?.source.match(pattern)?.[1];
      return moduleId ? `panelSpeedRequire(${JSON.stringify(moduleId)}).${symbol}` : null;
    };
    const atoms = reader && [dependency(reader[4], reader[5]), dependency(reader[8], reader[9]), dependency(reader[10], reader[11])];
    const host = source.match(new RegExp(`(${id})=\\(0,${id}\\.${id}\\)\\((${id})\\);\\(0,(${id})\\.use\\)\\([^;]+\\);let (${id})=\\1\\.hostId;`));
    const access = source.match(new RegExp(`let\\{serviceTierAccess:(${id})\\}=\\(0,${id}\\.${id}\\)\\(${id}\\);`));
    const query = source.match(new RegExp(`(${id})=\\(0,(${id})\\.(${id})\\)\\(${id}\\.${id},${id}\\);`));
    const model = source.match(new RegExp(`(${id})=\\(0,${id}\\.${id}\\)\\((${id})\\?\\.models,(${id})\\.model\\),`));
    const wrapper = source.match(new RegExp(`\\{serviceTierAccess:(${id}),\\.\\.\\.(${id})\\}=${id}`));
    if (!requireName || !atoms?.every(Boolean) || !host || !access || !query || !model || !wrapper) throw new Error("Unsupported Rspack Ultrafast settings structure");
    const output = new RegExp(`\\{\\.\\.\\.${escape(wrapper[2])},setServiceTier:(${id})\\}`);
    if ([...source.matchAll(new RegExp(output.source, "g"))].length !== 1) throw new Error("Ambiguous Rspack Ultrafast result");
    const runtime = "globalThis.__codexPanelProviderUltrafastV1__";
    // 此函数会被序列化；模型名称规则须与旧模块和目录适配保持一致。
    const read = `const panelSpeedEnabled=(0,${host[3]}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);const panelSpeedTarget=(0,${query[2]}.${query[3]})(${atoms[0]},${host[2]});const panelSpeedConfig=(0,${query[2]}.${query[3]})(${atoms[1]},panelSpeedTarget);const panelSpeedThreadProvider=(0,${query[2]}.${query[3]})(${atoms[2]},${host[2]});const panelSpeedProvider=panelSpeedThreadProvider??panelSpeedConfig.data?.model_provider;const panelCustomSpeed=panelSpeedEnabled&&${host[4]}==="local"&&typeof panelSpeedProvider==="string"&&panelSpeedProvider!==""&&panelSpeedProvider!=="openai";const panelUltrafastModel=/^(?:gpt-6[- ]astra|gpt-6\\.1[- ]sol)$/i.test(${model[3]}.model);if(panelCustomSpeed)${access[1]}={...${access[1]},fast:panelUltrafastModel||${access[1]}?.fast===true,ultrafast:panelUltrafastModel};`;
    const modelCall = model[0].slice(model[1].length + 1, -1);
    const extended = `(panelCustomSpeed&&panelUltrafastModel?(model=>{if(!model)return model;const missing=[{id:"priority",name:"Fast",description:""},{id:"ultrafast",name:"Ultrafast",description:""}].filter(tier=>!model.serviceTiers?.some(existing=>existing.id===tier.id));return missing.length?{...model,serviceTiers:[...(model.serviceTiers??[]),...missing]}:model})(${modelCall}):${modelCall})`;
    // The inner settings function also uses the minified require parameter name.
    return source.replace(/^(function\s*[^\(]*\([^)]*\)\{)/, `$1const panelSpeedRequire=${requireName};`)
      .replace(access[0], access[0] + read)
      .replace(model[0], `${model[1]}=${extended},`)
      .replace(output, `{...${wrapper[2]},serviceTierAccess:${wrapper[1]},setServiceTier:$1}`);
  }
  if (!source.includes("composer.openModelPicker") || !source.includes("availableOptions.length>1")) return null;
  const settings = source.match(new RegExp(`let\\{serviceTierSettings:(${id}),setServiceTier:(${id})\\}=\\(0,${id}\\.${id}\\)\\([^;]+\\);`));
  const access = source.match(new RegExp(`let\\{serviceTierAccess:(${id})\\}=(\\(0,${id}\\.${id}\\)\\(${id}\\)),`));
  const selected = settings && source.match(new RegExp(`(${id})=${escape(settings[1])}\\.selectedServiceTier;`));
  const icon = selected && source.match(new RegExp(`&&\\(0,${id}\\.${id}\\)\\(${id},${escape(selected[1])}\\)`));
  if (!settings || !access || !selected || !icon) throw new Error("Unsupported Rspack Ultrafast menu structure");
  return source.replace(settings[0], settings[0].replace("let{", "let{serviceTierAccess:panelServiceTierAccess,"))
    .replace(access[0], `let{serviceTierAccess:panelNativeServiceTierAccess}=${access[2]},${access[1]}=panelServiceTierAccess,`)
    .replace(icon[0], `&&(${selected[1]}==="ultrafast"&&${settings[1]}.availableOptions.some(option=>option.value==="ultrafast")||${icon[0].slice(2)})`);
}

export function rewriteRspackDot(source, context) {
  if (!source.includes("Duplicate capability name:") || !source.includes("Explicit-host capability requires hostId:")) return null;
  const id = "[A-Za-z_$][\\w$]*";
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const capabilities = [...source.matchAll(new RegExp(`(${id})=\\(0,(${id})\\.${id}\\)\\((${id}\\.${id}),\\((${id}),\\{get:(${id})\\}\\)=>\\{(?:var [^;]+;)?let (${id})=(${id})\\[\\4\\.name\\];`, "g"))];
  if (capabilities.length !== 1) throw new Error("Unsupported Rspack Dot capability structure");
  const capability = capabilities[0];
  const nativeModuleId = source.match(new RegExp(`\\b${escape(capability[2])}=${id}\\(["\x60]([^"\x60]+)["\x60]\\)`))?.[1];
  const native = nativeModuleId && context.moduleSource(nativeModuleId);
  let signal;
  for (const match of native?.matchAll(new RegExp(`(${id}):\\(\\)=>(${id})\\.(${id})`, "g")) ?? []) {
    const moduleId = native.match(new RegExp(`\\b${escape(match[2])}=${id}\\(["\x60]([^"\x60]+)["\x60]\\)`))?.[1];
    const implementation = moduleId && context.moduleSource(moduleId);
    if (implementation && new RegExp(`${escape(match[3])}:function\\([^)]*\\)\\{let ${id}=\\(0,${id}\\.${id}\\)\\(["\x60]signal["\x60]`).test(implementation)) {
      if (signal) throw new Error("Ambiguous native signal helper for Dot");
      signal = match[1];
    }
  }
  if (!signal) throw new Error("Native signal helper for Dot unavailable");
  const runtime = "globalThis.__codexPanelDotEntryV1__";
  const preference = `panelDotPreference=(0,${capability[2]}.${signal})(${capability[3]},()=>${runtime}.getSnapshot(),{getServerSnapshot:()=>false,onMount(set){set(${runtime}.getSnapshot());return ${runtime}.subscribe(()=>set(${runtime}.getSnapshot()))}}),`;
  const check = `if(${capability[6]}!=null&&(${capability[4]}.name==="orbit"||${capability[4]}.name==="orbit.navigation")&&${capability[5]}(panelDotPreference))return{isLoading:false,isError:false,isCapable:true};`;
  return source.replace(capability[0], preference + capability[0] + check);
}
