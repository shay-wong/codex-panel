// Runs in the renderer, so keep dependencies inside the function.
export function rewriteRspackQuota(source, context) {
  if (!source.includes("CodexComposerAdapter") || !source.includes("data-codex-composer-root") || source.includes("panelQuotaEnabled")) return null;
  const id = "[A-Za-z_$][\\w$]*";
  const escape = value => value.replaceAll("$", "\\$");
  const requireParameter = text => text.match(/^function(?:\s+[\w$]+)?\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*([\w$]+)\s*\)/)?.[1];
  const imports = text => {
    const require = requireParameter(text);
    if (!require) throw new Error("Native quota factory signature is unsupported");
    return new Map([...text.matchAll(new RegExp(`(${id})=${escape(require)}\\((["'\x60])([^"'\x60]+)\\2\\)`, "g"))].map(match => [match[1], match[3]]));
  };
  const require = requireParameter(source);
  if (!require) throw new Error("Native composer factory signature is unsupported");
  const gates = [...source.matchAll(new RegExp(`let (${id})=([^;]+?)\\|\\|(${id})\\|\\|(${id})(?=[,;])`, "g"))]
    .filter(match => source.includes(`submitDisabled:${match[1]},`));
  if (gates.length !== 1) throw new Error("Native composer quota gate is unsupported");
  const gate = gates[0];
  const hostQuota = source.match(new RegExp(`${escape(gate[3])}=\\(0,(${id})\\.(${id})\\)\\((${id})\\.(${id}),(${id})\\)`));
  if (!hostQuota) throw new Error("Native host quota reader is unsupported");
  const [hook, family, host] = [hostQuota[1], hostQuota[2], hostQuota[5]];
  const workQuota = new RegExp(`${escape(gate[4])}=\\(0,${escape(hook)}\\.${id}\\)\\("local"===${escape(host)}&&${id}\\.${id}\\)`);
  const thread = source.match(new RegExp(`${escape(host)}=\\(0,${escape(hook)}\\.${escape(family)}\\)\\(${id}\\.${id},(${id})\\)`))?.[1];
  const policy = source.match(new RegExp(`(${id})=(?:"failed"===${id}|${id}==="failed")&&${id}\\?\\.codexErrorInfo==="misalignmentPolicyViolation"`))?.[1];
  const react = [...new Set([...source.matchAll(/\(0,([\w$]+)\.useState\)/g)].map(match => match[1]))];
  if (!workQuota.test(source) || !thread || !policy || !gate[2].split("||").includes(policy) || react.length !== 1) {
    throw new Error("Native composer quota boundaries are unsupported");
  }
  const reader = context.findModule(["model_picker_upsell", "model_provider", "let{cwd:"]);
  if (!reader) throw new Error("Native custom-provider reader is unavailable");
  const signature = reader.source.match(new RegExp(`let\\{cwd:(${id}),hostId:(${id})\\}=(${id})\\.get\\((${id})\\.(${id}),(${id})\\);if\\("local"!==\\2\\)return null;let\\{data:(${id})\\}=\\3\\.get\\((${id})\\.(${id}),\\{cwd:\\1,hostId:\\2\\}\\);return null==\\7\\|\\|\\(\\3\\.get\\((${id})\\.(${id}),\\6\\)\\?\\?\\7\\.model_provider\\?\\?"openai"\\)!=="openai"`));
  if (!signature) throw new Error("Native custom-provider reader is unsupported");
  const dependencies = imports(reader.source);
  const atoms = [[signature[4], signature[5]], [signature[8], signature[9]], [signature[10], signature[11]]].map(([alias, name]) => {
    const module = dependencies.get(alias);
    if (!module || !context.moduleSource(module)) throw new Error("Native custom-provider dependency is unavailable");
    return `panelQuotaRequire(${JSON.stringify(module)}).${name}`;
  });
  const runtime = "globalThis.__codexPanelProviderQuotaV1__";
  const read = `const panelQuotaEnabled=(0,${react[0]}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);const panelQuotaTarget=(0,${hook}.${family})(${atoms[0]},${thread});const panelQuotaThreadProvider=(0,${hook}.${family})(${atoms[2]},${thread});const panelQuotaConfig=(0,${hook}.${family})(${atoms[1]},panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;`;
  const custom = `panelQuotaEnabled&&${host}==="local"&&typeof panelQuotaProvider==="string"&&panelQuotaProvider!==""&&panelQuotaProvider!=="openai"`;
  // The composer also declares a local with the minified require parameter name.
  return source.replace(/^(function(?:\s+[\w$]+)?\s*\([^)]*\)\{)/, `$1const panelQuotaRequire=${require};`)
    .replace(gate[0], `${read}let ${gate[1]}=${gate[2]}||((${gate[3]}||${gate[4]})&&!(${custom}))`);
}
