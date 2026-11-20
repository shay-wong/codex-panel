// Adapt native speed controls only for a known local custom provider.
import { sourceAst, property, propertyName, propertyValue, unwrap, isFunction, applyEdits } from "./codex-source-ast.mjs";
import { absoluteModuleImports, esmFunction, esmOwnNodes, esmSameBinding, esmProviderReader, readCodexEsmModules } from "./codex-provider-quota.mjs";

export function customProviderUltrafastAccess(hostId, provider, access, model) {
  // 已支持的模型同时开放快速和超快；其他模型保留原生快速权限。
  const supported = /^(?:gpt-6[- ]astra|gpt-6\.1[- ]sol|gpt-6\.2[- ](?:astra|sol))$/i.test(model);
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


function settingsSignature(ast) {
  const results = [];
  for (const output of ast.all(node => node.type === "ObjectExpression" && property(node,"hasManagedNewThreadSettings") && property(node,"serviceTierSettings"))) {
    const fn = esmFunction(ast,output);
    if (!fn || !property(propertyValue(output,"serviceTierSettings"),"serviceTierForRequest")) continue;
    const accesses = esmOwnNodes(ast,fn,node => node.type === "VariableDeclarator" && property(node.id,"serviceTierAccess"));
    const selected = esmOwnNodes(ast,fn,node => node.type === "CallExpression" && propertyName(unwrap(node.arguments[0])) === "models"
      && propertyName(unwrap(node.arguments[1])) === "model");
    const contexts = esmOwnNodes(ast,fn,node => node.type === "MemberExpression" && propertyName(node) === "hostId")
      .filter(member => {const value=ast.value(member.object);return value?.type === "CallExpression" && value.arguments.length === 1 && esmSameBinding(ast,value.arguments[0],fn.params[0]);});
    const queries = esmOwnNodes(ast,fn,node => node.type === "CallExpression" && node.arguments.length === 2 && esmSameBinding(ast,node.arguments[1],fn.params[0]));
    const hooks = esmOwnNodes(ast,fn,node => node.type === "CallExpression" && ["use","useState","useSyncExternalStore"].includes(propertyName(unwrap(node.callee))));
    const context = contexts[0]?.object, query = queries[0]?.callee, react = hooks[0] && unwrap(hooks[0].callee).object;
    const model = selected.length === 1 && ast.parent(selected[0]);
    if (accesses.length !== 1 || selected.length !== 1 || model?.type !== "VariableDeclarator" || model.id.type !== "Identifier" || !context || !query || !react
      || contexts.some(member=>!esmSameBinding(ast,member.object,context)) || queries.some(call=>!esmSameBinding(ast,call.callee,query))) continue;
    const wrappers = ast.all(isFunction).filter(candidate => candidate !== fn && esmOwnNodes(ast,candidate,node => node.type === "CallExpression"
      && node.callee.type === "Identifier" && esmSameBinding(ast,node.callee,fn.id)).length);
    const wrapperMatches=[];
    for(const wrapper of wrappers){
      const patterns=esmOwnNodes(ast,wrapper,node=>node.type === "ObjectPattern" && property(node,"serviceTierAccess") && node.properties.some(item=>item.type === "RestElement"));
      for(const pattern of patterns){
        const rest=pattern.properties.find(item=>item.type === "RestElement").argument;
        const outputs=esmOwnNodes(ast,wrapper,node=>node.type === "ObjectExpression" && property(node,"setServiceTier")
          && node.properties.some(item=>item.type === "SpreadElement" && esmSameBinding(ast,item.argument,rest)));
        if(outputs.length === 1)wrapperMatches.push({output:outputs[0],access:propertyValue(pattern,"serviceTierAccess")});
      }
    }
    if(wrapperMatches.length === 1)results.push({fn,access:accesses[0],selected:selected[0],model:model.id,context,query,react,wrapper:wrapperMatches[0]});
  }
  return results.length === 1 ? results[0] : null;
}

function menuSignature(ast) {
  const results=[];
  for(const fn of ast.all(isFunction)){
    if(!esmOwnNodes(ast,fn,node=>node.value === "composer.openModelPicker" || node.type === "TemplateLiteral" && node.quasis[0]?.value.cooked === "composer.openModelPicker").length)continue;
    const settings=esmOwnNodes(ast,fn,node=>node.type === "VariableDeclarator" && property(node.id,"serviceTierSettings") && property(node.id,"setServiceTier"));
    const access=esmOwnNodes(ast,fn,node=>node.type === "VariableDeclarator" && property(node.id,"serviceTierAccess"));
    if(settings.length !== 1 || access.length !== 1)continue;
    const setting=propertyValue(settings[0].id,"serviceTierSettings");
    const selected=esmOwnNodes(ast,fn,node=>node.type === "VariableDeclarator" && node.init?.type === "MemberExpression"
      && propertyName(node.init) === "selectedServiceTier" && esmSameBinding(ast,node.init.object,setting));
    if(selected.length !== 1)continue;
    const icons=esmOwnNodes(ast,fn,node=>node.type === "CallExpression" && node.arguments.length === 2 && esmSameBinding(ast,node.arguments[1],selected[0].id)
      && ast.parent(node)?.type === "LogicalExpression" && ast.parent(node).operator === "&&");
    if(icons.length === 1)results.push({settings:settings[0],access:access[0],selected:selected[0].id,setting,icon:icons[0]});
  }
  return results.length === 1 ? results[0] : null;
}

function rewriteSettings(source) {
  const ast=sourceAst(source),signature=settingsSignature(ast),reader=esmProviderReader(ast,{store:false});
  if(!signature || !reader)return null;
  const {fn,access,selected,model,context,query,react,wrapper}=signature;
  const runtime="globalThis.__codexPanelProviderUltrafastV1__",native=ast.text(access.init);
  const provider=`const panelEnabled=(0,${ast.text(react)}.useSyncExternalStore)(${runtime}.subscribe,${runtime}.getSnapshot);const panelThreadProvider=${ast.text(query)}(${ast.text(reader.provider)},${ast.text(fn.params[0])});const panelConfig=${ast.text(query)}(${ast.text(reader.config)},${ast.text(context)});const panelProvider=panelThreadProvider??panelConfig.data?.model_provider;`;
  const wrapped=`(()=>{const panelNative=${native};${provider}const panelAccess=panelEnabled?(${customProviderUltrafastAccess.toString()})(${ast.text(context)}.hostId,panelProvider,panelNative.serviceTierAccess,${ast.text(selected.arguments[1])}):panelNative.serviceTierAccess;panelCustomUltrafast=panelAccess!==panelNative.serviceTierAccess&&panelAccess.ultrafast;return {...panelNative,serviceTierAccess:panelAccess};})()`;
  return applyEdits(source,[
    {start:fn.body.start+1,end:fn.body.start+1,text:`let panelCustomUltrafast=false;const panelUltrafastModel=model=>panelCustomUltrafast?(${withUltrafastTier.toString()})(model):model;`},
    {start:access.init.start,end:access.init.end,text:wrapped},
    // Resolve tiers at each native model consumer, even when selection was hoisted before access.
    ...ast.references(ast.binding(model)).map(node=>({start:node.start,end:node.end,text:`panelUltrafastModel(${ast.text(node)})`})),
    {start:wrapper.output.start+1,end:wrapper.output.start+1,text:`serviceTierAccess:${ast.text(wrapper.access)},`},
  ]);
}

function rewriteMenu(source) {
  const ast=sourceAst(source),signature=menuSignature(ast);
  if(!signature)return null;
  const {settings,access,selected,setting,icon}=signature;
  return applyEdits(source,[
    {start:settings.id.start+1,end:settings.id.start+1,text:"serviceTierAccess:panelServiceTierAccess,"},
    {start:access.init.start,end:access.init.end,text:`({...${ast.text(access.init)},serviceTierAccess:panelServiceTierAccess})`},
    {start:icon.start,end:icon.end,text:`(${ast.text(selected)}==="ultrafast"&&${ast.text(setting)}.availableOptions.some(option=>option.value==="ultrafast")||${ast.text(icon)})`},
  ]);
}

function rewriteParts(source) {
  try {
    const settings=rewriteSettings(source),menu=rewriteMenu(settings??source);
    return {source:menu??settings,settings:settings!==null,menu:menu!==null};
  }catch{return {source:null,settings:false,menu:false};}
}

export function rewriteCodexProviderUltrafast(source, sourceUrl) {
  const result=rewriteParts(source);
  return result.source===null?null:absoluteModuleImports(result.source,sourceUrl);
}

export async function prepareCodexProviderUltrafast(cdp, report = console.error) {
  try {
    const sources=await readCodexEsmModules(cdp,[],modules=>{
      const parts=modules.map(module=>rewriteParts(module.source));
      return parts.filter(part=>part.settings).length===1&&parts.filter(part=>part.menu).length===1;
    });
    const parts=sources.map(module=>({...module,...rewriteParts(module.source)}));
    if(parts.filter(part=>part.settings).length!==1||parts.filter(part=>part.menu).length!==1)throw Error("unsupported or ambiguous native speed controls");
    const modules=parts.filter(part=>part.source!==null).map(({url,source})=>({url,source:absoluteModuleImports(source,url)}));
    report("Panel custom-provider Ultrafast modules prepared for the next renderer load.");
    return modules;
  } catch (error) {
    report(`Panel custom-provider Ultrafast unavailable: ${error.message}`);
    return [];
  }
}
