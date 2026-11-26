//! 旧版 ESM 宿主模块的原生语义适配；不执行源码来发现结构。
use super::source_ast::{edits, Ast, Edit, Id};
use crate::ApiError;
use serde_json::{json, Value};

fn one(items: Vec<Id>) -> Option<Id> {
    if items.len() == 1 {
        items.first().copied()
    } else {
        None
    }
}
fn owner(ast: &Ast, node: Id) -> Option<Id> {
    if ast.is_function(node) {
        Some(node)
    } else {
        ast.enclosing(node, |id| ast.is_function(id))
    }
}
fn own(ast: &Ast, function: Id, predicate: impl Fn(Id) -> bool) -> Vec<Id> {
    ast.all(function, |id| {
        owner(ast, id) == Some(function) && predicate(id)
    })
}
fn same(ast: &Ast, left: Id, right: Id) -> bool {
    let (left, right) = (ast.unwrap(left), ast.unwrap(right));
    ast.kind(left) == "Identifier"
        && ast.kind(right) == "Identifier"
        && if ast.binding(left).is_some() {
            ast.same_binding(left, right)
        } else {
            ast.name(left) == ast.name(right)
        }
}
fn literal(ast: &Ast, id: Id, text: &str) -> bool {
    let id = ast.unwrap(id);
    ast.field(id, "value") == text
        || (ast.kind(id) == "TemplateLiteral"
            && ast.array(id, "expressions").is_empty()
            && ast
                .array(id, "quasis")
                .first()
                .is_some_and(|id| ast.field(*id, "value")["cooked"] == text))
}
fn member(ast: &Ast, id: Id, name: &str) -> bool {
    ast.kind(ast.unwrap(id)) == "MemberExpression"
        && ast.name(ast.unwrap(id)).as_deref() == Some(name)
}
fn call(ast: &Ast, id: Id, name: &str) -> bool {
    ast.kind(id) == "CallExpression"
        && ast
            .child(id, "callee")
            .is_some_and(|id| ast.name(ast.unwrap(id)).as_deref() == Some(name))
}
fn terms(ast: &Ast, id: Id) -> Vec<Id> {
    if ast.kind(id) == "LogicalExpression" && ast.field(id, "operator") == "||" {
        ["left", "right"]
            .into_iter()
            .flat_map(|name| {
                ast.child(id, name)
                    .map(|id| terms(ast, id))
                    .unwrap_or_default()
            })
            .collect()
    } else {
        vec![id]
    }
}
fn equal(ast: &Ast, id: Id, name: &str, value: &str) -> bool {
    if ast.kind(id) != "BinaryExpression"
        || !matches!(ast.field(id, "operator").as_str(), Some("===" | "=="))
    {
        return false;
    }
    let (Some(left), Some(right)) = (ast.child(id, "left"), ast.child(id, "right")) else {
        return false;
    };
    member(ast, left, name) && literal(ast, right, value)
        || member(ast, right, name) && literal(ast, left, value)
}

#[derive(Clone, Copy)]
struct Provider {
    target: Option<Id>,
    config: Id,
    provider: Id,
}
fn provider_reader(ast: &Ast, store: bool) -> Option<Provider> {
    let mut found = Vec::new();
    for function in ast.all(ast.root, |id| ast.is_function(id)) {
        let members = own(ast, function, |id| member(ast, id, "model_provider"));
        if members.is_empty() || own(ast, function, |id| literal(ast, id, "openai")).is_empty() {
            continue;
        }
        let calls = own(ast, function, |id| ast.kind(id) == "CallExpression");
        if store {
            for declaration in own(ast, function, |id| {
                ast.kind(id) == "VariableDeclarator"
                    && ast
                        .child(id, "id")
                        .is_some_and(|id| ast.kind(id) == "ObjectPattern")
            }) {
                let pattern = ast.child(declaration, "id")?;
                let (Some(cwd), Some(host), Some(target)) = (
                    ast.property_value(pattern, "cwd"),
                    ast.property_value(pattern, "hostId"),
                    ast.child(declaration, "init").map(|id| ast.unwrap(id)),
                ) else {
                    continue;
                };
                let args = ast.array(target, "arguments");
                if !call(ast, target, "get") || args.len() != 2 {
                    continue;
                }
                if own(ast, function, |id| {
                    ast.kind(id) == "BinaryExpression"
                        && ["left", "right"]
                            .into_iter()
                            .any(|side| ast.child(id, side).is_some_and(|id| same(ast, id, host)))
                        && ["left", "right"].into_iter().any(|side| {
                            ast.child(id, side)
                                .is_some_and(|id| literal(ast, id, "local"))
                        })
                })
                .is_empty()
                {
                    continue;
                }
                let object = ast.child(ast.unwrap(ast.child(target, "callee")?), "object")?;
                let matching = |id: Id| {
                    call(ast, id, "get")
                        && ast
                            .child(id, "callee")
                            .map(|id| ast.unwrap(id))
                            .and_then(|id| ast.child(id, "object"))
                            .is_some_and(|id| same(ast, id, object))
                };
                let configs = calls
                    .iter()
                    .copied()
                    .filter(|id| {
                        matching(*id)
                            && ast.array(*id, "arguments").get(1).is_some_and(|id| {
                                ast.property_value(*id, "cwd")
                                    .is_some_and(|id| same(ast, id, cwd))
                                    && ast
                                        .property_value(*id, "hostId")
                                        .is_some_and(|id| same(ast, id, host))
                            })
                    })
                    .collect();
                let providers = calls
                    .iter()
                    .copied()
                    .filter(|id| {
                        *id != target
                            && matching(*id)
                            && ast
                                .array(*id, "arguments")
                                .get(1)
                                .is_some_and(|id| same(ast, *id, args[1]))
                    })
                    .collect();
                if let (Some(config), Some(provider)) = (one(configs), one(providers)) {
                    found.push(Provider {
                        target: Some(args[0]),
                        config: ast.array(config, "arguments")[0],
                        provider: ast.array(provider, "arguments")[0],
                    });
                }
            }
        } else {
            for member in members {
                let data = ast.value(ast.child(member, "object")?);
                if !self::member(ast, data, "data") {
                    continue;
                }
                let config = ast.unwrap(ast.child(data, "object")?);
                let args = ast.array(config, "arguments");
                if ast.kind(config) != "CallExpression"
                    || args.get(1).is_none_or(|id| {
                        ast.property(*id, "cwd").is_none() || ast.property(*id, "hostId").is_none()
                    })
                {
                    continue;
                }
                let callee = ast.child(config, "callee")?;
                let providers = calls
                    .iter()
                    .copied()
                    .filter(|id| {
                        *id != config
                            && ast
                                .child(*id, "callee")
                                .is_some_and(|id| same(ast, id, callee))
                            && ast.array(*id, "arguments").len() == 2
                            && ast
                                .property(ast.array(*id, "arguments")[1], "cwd")
                                .is_none()
                    })
                    .collect();
                if let Some(provider) = one(providers) {
                    found.push(Provider {
                        target: None,
                        config: args[0],
                        provider: ast.array(provider, "arguments")[0],
                    });
                }
            }
        }
    }
    if found.len() == 1 {
        found.pop()
    } else {
        None
    }
}

fn imported(ast: &Ast, node: Id, base: &str) -> Option<(String, String)> {
    let binding = ast.binding(node)?;
    let declaration = ast.binding_declaration(binding);
    if ast.kind(declaration) != "ImportSpecifier" {
        return None;
    }
    let name = ast.name(ast.child(declaration, "imported")?)?;
    let statement = ast.parent(declaration)?;
    let path = ast.name(ast.child(statement, "source")?)?;
    let url = url::Url::parse(base).ok()?.join(&path).ok()?.to_string();
    Some((name, url))
}

pub fn quota(
    source: &str,
    _url: &str,
    provider_source: &str,
    provider_url: &str,
) -> Result<Option<String>, ApiError> {
    let ast = Ast::parse(source, false)?;
    let provider = Ast::parse(provider_source, false)?;
    let Some(reader) = provider_reader(&provider, true) else {
        return Ok(None);
    };
    let mut candidates = Vec::new();
    for prop in ast.all(ast.root, |id| {
        ast.kind(id) == "Property" && ast.name(id).as_deref() == Some("submitDisabled")
    }) {
        let Some(reference) = ast.child(prop, "value").map(|id| ast.unwrap(id)) else {
            continue;
        };
        let Some(binding) = ast.binding(reference) else {
            continue;
        };
        let (Some(function), Some(init)) = (owner(&ast, prop), ast.binding_init(binding)) else {
            continue;
        };
        if ast.kind(init) != "LogicalExpression" || ast.field(init, "operator") != "||" {
            continue;
        }
        let parts = terms(&ast, init);
        if !parts.iter().any(|id| {
            let id = ast.value(*id);
            !ast.all(id, |id| member(&ast, id, "codexErrorInfo"))
                .is_empty()
                && !ast
                    .all(id, |id| literal(&ast, id, "misalignmentPolicyViolation"))
                    .is_empty()
        }) {
            continue;
        }
        for &work in &parts {
            let value = ast.value(work);
            let local = one(ast.all(value, |id| {
                ast.kind(id) == "BinaryExpression"
                    && matches!(ast.field(id, "operator").as_str(), Some("===" | "=="))
                    && ["left", "right"].into_iter().any(|side| {
                        ast.child(id, side)
                            .is_some_and(|id| literal(&ast, id, "local"))
                    })
            }));
            let Some(local) = local else {
                continue;
            };
            let left = ast.child(local, "left").unwrap();
            let host = if literal(&ast, left, "local") {
                ast.child(local, "right").unwrap()
            } else {
                left
            };
            let host_call = ast.value(host);
            let args = ast.array(host_call, "arguments");
            if ast.kind(host_call) != "CallExpression"
                || args.len() != 2
                || ast
                    .all(value, |id| ast.kind(id) == "CallExpression")
                    .is_empty()
            {
                continue;
            }
            let callee = ast.child(host_call, "callee").unwrap();
            let quotas = parts
                .iter()
                .copied()
                .filter(|id| *id != work)
                .filter(|id| {
                    let value = ast.value(*id);
                    ast.kind(value) == "CallExpression"
                        && ast.array(value, "arguments").len() == 2
                        && ast
                            .child(value, "callee")
                            .is_some_and(|id| same(&ast, id, callee))
                        && same(&ast, ast.array(value, "arguments")[1], host)
                })
                .collect();
            let hooks = own(&ast, function, |id| {
                call(&ast, id, "useState") || call(&ast, id, "useSyncExternalStore")
            });
            if let (Some(quota), Some(react)) = (
                one(quotas),
                hooks
                    .first()
                    .and_then(|id| ast.child(*id, "callee"))
                    .map(|id| ast.unwrap(id))
                    .and_then(|id| ast.child(id, "object")),
            ) {
                candidates.push((
                    function,
                    init,
                    parts.clone(),
                    quota,
                    work,
                    host,
                    host_call,
                    react,
                ));
            }
        }
    }
    if candidates.len() != 1 {
        return Ok(None);
    }
    let (function, init, parts, quota, work, host, host_call, react) = candidates.remove(0);
    let thread = ast.array(host_call, "arguments")[1];
    let runtime = "globalThis.__codexPanelProviderQuotaV1__";
    let mut imports = String::new();
    let before;
    let gate;
    if source == provider_source {
        let stores = own(&ast, function, |id| {
            call(&ast, id, "get")
                && ast
                    .array(id, "arguments")
                    .get(1)
                    .is_some_and(|id| same(&ast, *id, thread))
        })
        .into_iter()
        .filter_map(|id| ast.child(id, "callee"))
        .map(|id| ast.unwrap(id))
        .filter_map(|id| ast.child(id, "object"))
        .collect::<Vec<_>>();
        let Some(store) = stores.first() else {
            return Ok(None);
        };
        if stores.iter().any(|id| !same(&ast, *id, *store)) {
            return Ok(None);
        }
        let read=format!("const panelQuotaTarget={}.get({},{});const panelQuotaProvider={}.get({},{})??{}.get({},panelQuotaTarget).data?.model_provider;",ast.text(*store),provider.text(reader.target.unwrap()),ast.text(thread),ast.text(*store),provider.text(reader.provider),ast.text(thread),ast.text(*store),provider.text(reader.config));
        before = String::new();
        gate=format!("(()=>{{{read}return {}===\"local\"&&typeof panelQuotaProvider===\"string\"&&panelQuotaProvider!==\"\"&&panelQuotaProvider!==\"openai\"}})()",ast.text(host));
    } else {
        let atoms = [reader.target.unwrap(), reader.config, reader.provider]
            .map(|id| imported(&provider, id, provider_url));
        let [Some(target), Some(config), Some(provider)] = atoms else {
            return Ok(None);
        };
        if target.1 != config.1 || target.1 != provider.1 {
            return Ok(None);
        }
        imports=format!("import{{{} as panelQuotaTargetAtom,{} as panelQuotaConfigAtom,{} as panelQuotaProviderAtom}}from {};",target.0,config.0,provider.0,json!(target.1));
        let read = ast.text(ast.unwrap(ast.child(host_call, "callee").unwrap()));
        before=format!("const panelQuotaTarget={read}(panelQuotaTargetAtom,{});const panelQuotaThreadProvider={read}(panelQuotaProviderAtom,{});const panelQuotaConfig={read}(panelQuotaConfigAtom,panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;",ast.text(thread),ast.text(thread));
        gate=format!("{}===\"local\"&&typeof panelQuotaProvider===\"string\"&&panelQuotaProvider!==\"\"&&panelQuotaProvider!==\"openai\"",ast.text(host));
    }
    let mut gates = parts
        .into_iter()
        .filter(|id| *id != quota && *id != work)
        .map(|id| ast.text(id).to_owned())
        .collect::<Vec<_>>();
    gates.push(format!(
        "(({}||{})&&!(panelQuotaEnabled&&{gate}))",
        ast.text(quota),
        ast.text(work)
    ));
    let value = gates.join("||");
    let value = if before.is_empty() {
        value
    } else {
        format!("(()=>{{{before}return {value}}})()")
    };
    let body = ast.child(function, "body").unwrap();
    Ok(Some(format!("{imports}{}",edits(source,vec![Edit{start:ast.start(body)+1,end:ast.start(body)+1,text:format!("const panelQuotaEnabled=(0,{}.useSyncExternalStore)({runtime}.subscribe,{runtime}.getSnapshot);",ast.text(react))},Edit{start:ast.start(init),end:ast.end(init),text:value}])?)))
}

pub fn dot(source: &str) -> Result<Option<String>, ApiError> {
    let ast = Ast::parse(source, false)?;
    let mut candidates = Vec::new();
    for function in ast.all(ast.root, |id| ast.is_function(id)) {
        let parameters = ast.array(function, "params");
        if parameters.len() != 2
            || ast
                .child(function, "body")
                .is_none_or(|id| ast.kind(id) != "BlockStatement")
        {
            continue;
        }
        let request = parameters[0];
        let Some(get) = ast.property_value(parameters[1], "get") else {
            continue;
        };
        if ast.kind(request) != "Identifier" || ast.kind(get) != "Identifier" {
            continue;
        }
        let Some(parent) = ast.parent(function).filter(|id| {
            ast.kind(*id) == "CallExpression"
                && ast.array(*id, "arguments").get(1) == Some(&function)
        }) else {
            continue;
        };
        for declaration in own(&ast, function, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast
                    .child(id, "id")
                    .is_some_and(|id| ast.kind(id) == "Identifier")
        }) {
            let id = ast.child(declaration, "id").unwrap();
            let Some(init) = ast.child(declaration, "init") else {
                continue;
            };
            if ast.kind(init) != "MemberExpression" || !ast.boolean(init, "computed") {
                continue;
            }
            let Some(property) = ast.child(init, "property") else {
                continue;
            };
            if !member(&ast, property, "name")
                || !ast
                    .child(property, "object")
                    .is_some_and(|id| same(&ast, id, request))
            {
                continue;
            }
            if own(&ast, function, |node| {
                member(&ast, node, "requiresFirstPartyInference")
                    && ast
                        .child(node, "object")
                        .is_some_and(|node| same(&ast, node, id))
            })
            .is_empty()
            {
                continue;
            }
            let first = ast.array(parent, "arguments")[0];
            let signals = ast.all(ast.root, |node| {
                ast.kind(node) == "CallExpression"
                    && ast.array(node, "arguments").len() == 3
                    && same(&ast, ast.array(node, "arguments")[0], first)
                    && ast
                        .property(ast.array(node, "arguments")[2], "getServerSnapshot")
                        .is_some()
                    && ast
                        .property(ast.array(node, "arguments")[2], "onMount")
                        .is_some()
            });
            if let Some(signal) = one(signals) {
                candidates.push((parent, declaration, request, get, signal));
            }
        }
    }
    if candidates.len() != 1 {
        return Ok(None);
    }
    let (parent, declaration, request, get, signal) = candidates[0];
    let statement = ast
        .parent(declaration)
        .filter(|id| ast.kind(*id) == "VariableDeclaration")
        .unwrap();
    let runtime = "globalThis.__codexPanelDotEntryV1__";
    let atom = format!("{runtime}.preference");
    let initialize=format!("{atom}={}({},()=>{runtime}.getSnapshot(),{{onMount(set){{set({runtime}.getSnapshot());return {runtime}.subscribe(()=>set({runtime}.getSnapshot()))}}}})",ast.text(ast.child(signal,"callee").unwrap()),ast.text(ast.array(parent,"arguments")[0]));
    let check=format!(";if({}!=null&&({}.name===\"orbit\"||{}.name===\"orbit.navigation\")&&{}({atom},void 0))return{{isLoading:false,isError:false,isCapable:true}};",ast.text(ast.child(declaration,"id").unwrap()),ast.text(request),ast.text(request),ast.text(get));
    Ok(Some(edits(
        source,
        vec![
            Edit {
                start: ast.start(parent),
                end: ast.start(parent),
                text: format!("({initialize},"),
            },
            Edit {
                start: ast.end(parent),
                end: ast.end(parent),
                text: ")".into(),
            },
            Edit {
                start: ast.end(statement),
                end: ast.end(statement),
                text: check,
            },
        ],
    )?))
}

fn speed_settings(source: &str) -> Result<Option<String>, ApiError> {
    let ast = Ast::parse(source, false)?;
    let Some(reader) = provider_reader(&ast, false) else {
        return Ok(None);
    };
    let mut candidates = Vec::new();
    for output in ast.all(ast.root, |id| {
        ast.kind(id) == "ObjectExpression"
            && ast.property(id, "hasManagedNewThreadSettings").is_some()
            && ast.property(id, "serviceTierSettings").is_some()
    }) {
        let Some(function) = owner(&ast, output) else {
            continue;
        };
        let params = ast.array(function, "params");
        let Some(param) = params.first() else {
            continue;
        };
        if ast
            .property_value(output, "serviceTierSettings")
            .is_none_or(|id| ast.property(id, "serviceTierForRequest").is_none())
        {
            continue;
        }
        let access = one(own(&ast, function, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast
                    .child(id, "id")
                    .is_some_and(|id| ast.property(id, "serviceTierAccess").is_some())
        }));
        let selected = one(own(&ast, function, |id| {
            let args = ast.array(id, "arguments");
            ast.kind(id) == "CallExpression"
                && args.len() > 1
                && ast.name(ast.unwrap(args[0])).as_deref() == Some("models")
                && ast.name(ast.unwrap(args[1])).as_deref() == Some("model")
        }));
        let contexts = own(&ast, function, |id| {
            member(&ast, id, "hostId")
                && ast
                    .child(id, "object")
                    .map(|id| ast.value(id))
                    .is_some_and(|id| {
                        ast.kind(id) == "CallExpression"
                            && ast.array(id, "arguments").len() == 1
                            && same(&ast, ast.array(id, "arguments")[0], *param)
                    })
        });
        let queries = own(&ast, function, |id| {
            ast.kind(id) == "CallExpression"
                && ast.array(id, "arguments").len() == 2
                && same(&ast, ast.array(id, "arguments")[1], *param)
        });
        let hooks = own(&ast, function, |id| {
            call(&ast, id, "use")
                || call(&ast, id, "useState")
                || call(&ast, id, "useSyncExternalStore")
        });
        let (Some(access), Some(selected), Some(context), Some(query), Some(react)) = (
            access,
            selected,
            contexts.first().and_then(|id| ast.child(*id, "object")),
            queries.first().and_then(|id| ast.child(*id, "callee")),
            hooks
                .first()
                .and_then(|id| ast.child(*id, "callee"))
                .map(|id| ast.unwrap(id))
                .and_then(|id| ast.child(id, "object")),
        ) else {
            continue;
        };
        let Some(model) = ast
            .parent(selected)
            .filter(|id| ast.kind(*id) == "VariableDeclarator")
            .and_then(|id| ast.child(id, "id"))
            .filter(|id| ast.kind(*id) == "Identifier")
        else {
            continue;
        };
        if contexts.iter().any(|id| {
            ast.child(*id, "object")
                .is_none_or(|id| !same(&ast, id, context))
        }) || queries.iter().any(|id| {
            ast.child(*id, "callee")
                .is_none_or(|id| !same(&ast, id, query))
        }) {
            continue;
        }
        let Some(name) = ast.child(function, "id") else {
            continue;
        };
        let mut wrappers = Vec::new();
        for wrapper in ast.all(ast.root, |id| ast.is_function(id) && id != function) {
            if own(&ast, wrapper, |id| {
                ast.kind(id) == "CallExpression"
                    && ast
                        .child(id, "callee")
                        .is_some_and(|id| same(&ast, id, name))
            })
            .is_empty()
            {
                continue;
            }
            for pattern in own(&ast, wrapper, |id| {
                ast.kind(id) == "ObjectPattern"
                    && ast.property(id, "serviceTierAccess").is_some()
                    && ast
                        .array(id, "properties")
                        .iter()
                        .any(|id| ast.kind(*id) == "RestElement")
            }) {
                let rest = ast
                    .array(pattern, "properties")
                    .into_iter()
                    .find(|id| ast.kind(*id) == "RestElement")
                    .and_then(|id| ast.child(id, "argument"))
                    .unwrap();
                let outputs = own(&ast, wrapper, |id| {
                    ast.kind(id) == "ObjectExpression"
                        && ast.property(id, "setServiceTier").is_some()
                        && ast.array(id, "properties").iter().any(|id| {
                            ast.kind(*id) == "SpreadElement"
                                && ast
                                    .child(*id, "argument")
                                    .is_some_and(|id| same(&ast, id, rest))
                        })
                });
                if let Some(output) = one(outputs) {
                    wrappers.push((
                        output,
                        ast.property_value(pattern, "serviceTierAccess").unwrap(),
                    ));
                }
            }
        }
        if wrappers.len() == 1 {
            candidates.push((
                function,
                access,
                selected,
                model,
                context,
                query,
                react,
                wrappers[0],
            ));
        }
    }
    if candidates.len() != 1 {
        return Ok(None);
    }
    let (function, access, selected, model, context, query, react, (wrapper, wrapper_access)) =
        candidates[0];
    let native = ast.child(access, "init").unwrap();
    let runtime = "globalThis.__codexPanelProviderUltrafastV1__";
    let read=format!("const panelEnabled=(0,{}.useSyncExternalStore)({runtime}.subscribe,{runtime}.getSnapshot);const panelThreadProvider={}({},{});const panelConfig={}({},{});const panelProvider=panelThreadProvider??panelConfig.data?.model_provider;",ast.text(react),ast.text(query),ast.text(reader.provider),ast.text(ast.array(function,"params")[0]),ast.text(query),ast.text(reader.config),ast.text(context));
    let wrapped=format!("(()=>{{const panelNative={};{read}const panelAccess=panelEnabled?({})({}.hostId,panelProvider,panelNative.serviceTierAccess,{}):panelNative.serviceTierAccess;panelCustomUltrafast=panelAccess!==panelNative.serviceTierAccess&&panelAccess.ultrafast;return{{...panelNative,serviceTierAccess:panelAccess}};}})()",ast.text(native),include_str!("assets/legacy_ultrafast_access.js"),ast.text(context),ast.text(ast.array(selected,"arguments")[1]));
    let body = ast.child(function, "body").unwrap();
    let mut changes=vec![Edit{start:ast.start(body)+1,end:ast.start(body)+1,text:format!("let panelCustomUltrafast=false;const panelUltrafastModel=model=>panelCustomUltrafast?({})(model):model;",include_str!("assets/legacy_ultrafast_model.js"))},Edit{start:ast.start(native),end:ast.end(native),text:wrapped},Edit{start:ast.start(wrapper)+1,end:ast.start(wrapper)+1,text:format!("serviceTierAccess:{},",ast.text(wrapper_access))}];
    if let Some(binding) = ast.binding(model) {
        for reference in ast.references(binding) {
            changes.push(Edit {
                start: ast.start(*reference),
                end: ast.end(*reference),
                text: format!("panelUltrafastModel({})", ast.text(*reference)),
            });
        }
    }
    Ok(Some(edits(source, changes)?))
}

fn speed_menu(source: &str) -> Result<Option<String>, ApiError> {
    let ast = Ast::parse(source, false)?;
    let mut candidates = Vec::new();
    for function in ast.all(ast.root, |id| ast.is_function(id)) {
        let settings = one(own(&ast, function, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast.child(id, "id").is_some_and(|id| {
                    ast.property(id, "serviceTierSettings").is_some()
                        && ast.property(id, "setServiceTier").is_some()
                        && ast.property(id, "serviceTierAccess").is_none()
                })
        }));
        let access = one(own(&ast, function, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast
                    .child(id, "id")
                    .is_some_and(|id| ast.property(id, "serviceTierAccess").is_some())
        }));
        let (Some(settings), Some(access)) = (settings, access) else {
            continue;
        };
        let pattern = ast.child(settings, "id").unwrap();
        let setting = ast.property_value(pattern, "serviceTierSettings").unwrap();
        let selected = one(own(&ast, function, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast.child(id, "init").is_some_and(|id| {
                    member(&ast, id, "selectedServiceTier")
                        && ast
                            .child(id, "object")
                            .is_some_and(|id| same(&ast, id, setting))
                })
        }))
        .and_then(|id| ast.child(id, "id"));
        let icon = selected.and_then(|selected| {
            one(own(&ast, function, |id| {
                ast.kind(id) == "CallExpression"
                    && ast.array(id, "arguments").len() == 2
                    && same(&ast, ast.array(id, "arguments")[1], selected)
                    && ast.parent(id).is_some_and(|id| {
                        ast.kind(id) == "LogicalExpression" && ast.field(id, "operator") == "&&"
                    })
            }))
        });
        candidates.push((pattern, access, selected, setting, icon));
    }
    if candidates.len() != 1 {
        return Ok(None);
    }
    let (pattern, access, selected, setting, icon) = candidates[0];
    let init = ast.child(access, "init").unwrap();
    // 沿用原生菜单布局，只将独立权限读取替换为设置 hook 已计算的权限。
    let mut changes = vec![
        Edit {
            start: ast.start(pattern) + 1,
            end: ast.start(pattern) + 1,
            text: "serviceTierAccess:panelServiceTierAccess,".into(),
        },
        Edit {
            start: ast.start(init),
            end: ast.end(init),
            text: format!(
                "({{...{},serviceTierAccess:panelServiceTierAccess}})",
                ast.text(init)
            ),
        },
    ];
    if let (Some(icon), Some(selected)) = (icon, selected) {
        changes.push(Edit{start:ast.start(icon),end:ast.end(icon),text:format!("({}===\"ultrafast\"&&{}.availableOptions.some(option=>option.value===\"ultrafast\")||{})",ast.text(selected),ast.text(setting),ast.text(icon))});
    }
    Ok(Some(edits(source, changes)?))
}

fn ultrafast(source: &str) -> Result<(Option<String>, bool, bool), ApiError> {
    let settings = speed_settings(source)?;
    let menu = speed_menu(settings.as_deref().unwrap_or(source))?;
    let prepared = (settings.is_some(), menu.is_some());
    Ok((menu.or(settings), prepared.0, prepared.1))
}

fn exported_owner(ast: &Ast, node: Id) -> Option<Id> {
    ast.enclosing(node, |id| {
        ast.is_function(id) && ast.export_name(id).is_some()
    })
}
fn assigned(ast: &Ast, node: Id) -> Option<Id> {
    let parent = ast.parent(node)?;
    match ast.kind(parent) {
        "VariableDeclarator" => ast.child(parent, "id"),
        "AssignmentExpression" => ast.child(parent, "left"),
        _ => None,
    }
}
fn native_tabs(ast: &Ast) -> Option<Vec<Option<String>>> {
    let registration = one(ast.all(ast.root, |id| {
        ast.kind(id) == "CallExpression"
            && ast
                .array(id, "arguments")
                .first()
                .is_some_and(|id| literal(ast, *id, "orbit-activity"))
            && ast
                .array(id, "arguments")
                .get(2)
                .is_some_and(|id| ast.property(*id, "open").is_some())
    }))?;
    let open = ast.value(ast.property_value(ast.array(registration, "arguments")[2], "open")?);
    if !ast.is_function(open) {
        return None;
    }
    let controller = one(own(ast, open, |id| call(ast, id, "openTab")))
        .and_then(|id| ast.child(id, "callee"))
        .map(|id| ast.unwrap(id))
        .and_then(|id| ast.child(id, "object"))?;
    let init = exported_owner(ast, registration)?;
    let layout = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").len() == 3
            && !own(ast, id, |node| equal(ast, node, "mode", "full")).is_empty()
            && !own(ast, id, |node| equal(ast, node, "kind", "chat")).is_empty()
    }))?;
    let focus = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").len() == 2
            && !own(ast, id, |node| equal(ast, node, "kind", "chat")).is_empty()
            && !own(ast, id, |node| member(ast, node, "tabId")).is_empty()
    }))?;
    let navigate = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").len() == 2
            && ast.kind(ast.array(id, "params")[1]) == "RestElement"
            && !own(ast, id, |node| call(ast, node, "navigate")).is_empty()
    }))?;
    let host = one(ast
        .all(ast.root, |id| {
            ast.kind(id) == "CallExpression"
                && ast.array(id, "arguments").get(1).is_some_and(|id| {
                    ast.is_function(*id)
                        && ast
                            .return_value(*id)
                            .is_some_and(|id| member(ast, id, "hostId"))
                })
        })
        .into_iter()
        .filter_map(|id| assigned(ast, id))
        .collect())?;
    let layout_call = one(ast.all(ast.root, |id| {
        ast.kind(id) == "CallExpression"
            && ast.array(id, "arguments").get(1).is_some_and(|id| {
                ast.is_function(*id)
                    && ["full", "split"].into_iter().all(|mode| {
                        !own(ast, *id, |node| {
                            ast.kind(node) == "ObjectExpression"
                                && ast
                                    .property_value(node, "mode")
                                    .is_some_and(|node| literal(ast, node, mode))
                        })
                        .is_empty()
                    })
            })
    }))?;
    let layout_state = assigned(ast, layout_call)?;
    let layout_init = exported_owner(ast, layout_call);
    if layout_init.is_none() && owner(ast, layout_call).is_some() {
        return None;
    }
    let input = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && !own(ast, id, |node| {
                ast.kind(node) == "ObjectExpression"
                    && ["composerId", "expiresTimeoutId", "focusAnimationFrameId"]
                        .into_iter()
                        .all(|name| ast.property(node, name).is_some())
            })
            .is_empty()
    }))?;
    let snapshot = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").is_empty()
            && !own(ast, id, |node| member(ast, node, "composerId")).is_empty()
    }))?;
    let subscribe = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").len() == 1
            && ["add", "delete"].into_iter().all(|name| {
                !ast.all(id, |node| {
                    call(ast, node, name)
                        && ast
                            .array(node, "arguments")
                            .first()
                            .is_some_and(|node| same(ast, *node, ast.array(id, "params")[0]))
                })
                .is_empty()
            })
    }))?;
    let client = one(ast.all(ast.root, |id| {
        if !ast.is_function(id) || ast.array(id, "params").len() != 2 {
            return false;
        }
        let parameters = ast.array(id, "params");
        let Some(value) = ast.return_value(id) else {
            return false;
        };
        let args = ast.array(value, "arguments");
        call(ast, value, "get")
            && ast
                .child(value, "callee")
                .map(|id| ast.unwrap(id))
                .and_then(|id| ast.child(id, "object"))
                .is_some_and(|node| same(ast, node, parameters[0]))
            && args.get(1).is_some_and(|id| {
                ast.kind(*id) == "CallExpression"
                    && ast
                        .array(*id, "arguments")
                        .first()
                        .is_some_and(|node| same(ast, *node, parameters[1]))
            })
    }))?;
    let local = ast.child(
        ast.array(ast.return_value(client)?, "arguments")[1],
        "callee",
    )?;
    let nodes = [
        Some(init),
        Some(open),
        Some(controller),
        layout_init,
        Some(layout),
        Some(focus),
        Some(host),
        Some(navigate),
        Some(layout_state),
        Some(input),
        Some(snapshot),
        Some(subscribe),
        Some(client),
        Some(local),
    ];
    let names = nodes
        .into_iter()
        .map(|node| node.and_then(|node| ast.export_name(node)))
        .collect::<Vec<_>>();
    if names
        .iter()
        .enumerate()
        .all(|(index, name)| index == 3 || name.is_some())
    {
        Some(names)
    } else {
        None
    }
}

struct Sidebar {
    active: Id,
    menu: Id,
    push: Id,
    navigation: Id,
    root: Id,
    conversation: Id,
    highlighted: Id,
    resolved: Id,
    react: Id,
    presentation: Id,
    declaration: Id,
    statement: Id,
}
fn sidebar(ast: &Ast) -> Option<Sidebar> {
    let active = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.array(id, "params").len() == 1
            && !own(ast, id, |node| equal(ast, node, "routeKind", "other")).is_empty()
            && !own(ast, id, |node| {
                ast.kind(node) == "ObjectExpression" && ast.property(node, "pathname").is_some()
            })
            .is_empty()
    }))?;
    let menu = one(ast.all(ast.root, |id| {
        ast.is_function(id)
            && ast.boolean(id, "async")
            && ast.array(id, "params").len() == 1
            && ["scope", "target", "surface", "paneItems"]
                .into_iter()
                .all(|name| ast.property(ast.array(id, "params")[0], name).is_some())
    }))?;
    let pane = ast.property_value(ast.array(menu, "params")[0], "paneItems")?;
    let push = one(own(ast, menu, |id| {
        if !call(ast, id, "push") {
            return false;
        }
        let args = ast.array(id, "arguments");
        if args.len() != 1 || ast.kind(args[0]) != "SpreadElement" {
            return false;
        }
        let Some(value) = ast.child(args[0], "argument") else {
            return false;
        };
        ast.kind(value) == "LogicalExpression"
            && ast.field(value, "operator") == "??"
            && ast
                .child(value, "left")
                .is_some_and(|node| same(ast, node, pane))
    }))?;
    let navigation = one(ast.all(ast.root, |id| {
        ast.kind(id) == "CallExpression"
            && ast.array(id, "arguments").len() == 4
            && !ast
                .all(ast.array(id, "arguments")[3], |id| {
                    ast.kind(id) == "ObjectExpression"
                        && ast.property(id, "state").is_some()
                        && ast.property(id, "threadAccess").is_some()
                })
                .is_empty()
    }))?;
    let row = owner(ast, navigation)?;
    let root = ast.array(navigation, "arguments")[0];
    let conversation = ast.array(navigation, "arguments")[1];
    let native_active = one(own(ast, row, |id| {
        ast.kind(id) == "ObjectPattern" && ast.property(id, "isActive").is_some()
    }))
    .and_then(|id| ast.property_value(id, "isActive"))?;
    let highlighted = one(own(ast, row, |id| {
        if ast.kind(id) != "VariableDeclarator" {
            return false;
        }
        let Some(init) = ast.child(id, "init") else {
            return false;
        };
        ast.kind(init) == "LogicalExpression"
            && ast.field(init, "operator") == "&&"
            && ast
                .child(init, "right")
                .is_some_and(|node| same(ast, node, native_active))
            && ast.child(init, "left").is_some_and(|node| {
                ast.kind(node) == "BinaryExpression"
                    && ast
                        .child(node, "left")
                        .is_some_and(|node| same(ast, node, native_active))
            })
    }))?;
    let resolved = one(own(ast, row, |id| {
        ast.kind(id) == "VariableDeclarator"
            && ast.child(id, "init").is_some_and(|id| {
                ast.kind(id) == "LogicalExpression"
                    && ast.field(id, "operator") == "??"
                    && !ast.all(id, |id| member(ast, id, "hostId")).is_empty()
            })
    }))?;
    let react = one(own(ast, row, |id| call(ast, id, "startTransition")))
        .and_then(|id| ast.child(id, "callee"))
        .map(|id| ast.unwrap(id))
        .and_then(|id| ast.child(id, "object"))?;
    let highlighted_id = ast.child(highlighted, "id")?;
    let presentation = one(own(ast, row, |id| {
        ast.kind(id) == "ObjectExpression"
            && ast
                .property_value(id, "isActive")
                .is_some_and(|id| same(ast, id, highlighted_id))
            && ast.property(id, "dataAttributes").is_some()
    }))?;
    let declaration = ast
        .parent(resolved)
        .filter(|id| ast.kind(*id) == "VariableDeclaration")?;
    let statement = ast.enclosing(presentation, |id| {
        matches!(
            ast.kind(id),
            "ReturnStatement" | "VariableDeclaration" | "ExpressionStatement"
        )
    })?;
    Some(Sidebar {
        active,
        menu,
        push,
        navigation,
        root,
        conversation,
        highlighted,
        resolved,
        react,
        presentation,
        declaration,
        statement,
    })
}

fn tabs(source: &str, initial: &str, initial_url: &str) -> Result<Option<String>, ApiError> {
    let ast = Ast::parse(source, false)?;
    let initial = Ast::parse(initial, false)?;
    let (Some(names), Some(sidebar)) = (native_tabs(&initial), sidebar(&ast)) else {
        return Ok(None);
    };
    let Sidebar {
        active,
        menu,
        push,
        navigation,
        root,
        conversation,
        highlighted,
        resolved,
        react,
        presentation,
        declaration,
        statement,
    } = sidebar;
    let active = ast.text(ast.child(active, "id").unwrap());
    let navigate = ast.text(ast.child(navigation, "callee").unwrap());
    let pattern = ast.array(menu, "params")[0];
    let scope = ast.text(ast.property_value(pattern, "scope").unwrap());
    let target = ast.text(ast.property_value(pattern, "target").unwrap());
    let surface = ast.text(ast.property_value(pattern, "surface").unwrap());
    let list = ast.text(
        ast.child(ast.unwrap(ast.child(push, "callee").unwrap()), "object")
            .unwrap(),
    );
    let imports = format!(
        "import{{{}}}from {};",
        names
            .iter()
            .enumerate()
            .filter_map(|(index, name)| name
                .as_ref()
                .map(|name| format!("{name} as panelThreadTabs{index}")))
            .collect::<Vec<_>>()
            .join(","),
        json!(initial_url)
    );
    let helper = include_str!("assets/legacy_tabs_runtime.js")
        .replace("__ACTIVE_SCOPE__", active)
        .replace("__NAVIGATE__", navigate);
    let svg = |body: &str| {
        format!("data:image/svg+xml;utf8,{}",format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" stroke=\"black\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{body}</svg>").as_bytes().iter().map(|byte|format!("%{byte:02X}")).collect::<String>())
    };
    let icons=[svg("<path d=\"M7 3.5H4.5a1 1 0 0 0-1 1V13M7.5 6.5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z\"/><path d=\"M11.5 9v5m-2.5-2.5h5\"/>"),svg("<rect x=\"3\" y=\"4\" width=\"14\" height=\"12\" rx=\"1.5\"/><path d=\"M10 4v12\"/>"),svg("<rect x=\"3\" y=\"3\" width=\"14\" height=\"14\" rx=\"1.5\"/><path d=\"M3 7h14\"/>")];
    let items=format!("{surface}===\"sidebar\"&&{active}({scope})&&{list}.push(...[false,true].filter(split=>panelThreadModeAvailable({scope},{target},split)).map(split=>({{id:split?\"panel-thread-split\":\"panel-thread-tab\",icon:split?{}:{},message:{{id:split?\"panel.thread.openSplit\":\"panel.thread.openTab\",defaultMessage:document.documentElement.lang.startsWith(\"zh\")?(split?\"在右侧并排打开\":\"在新标签页中打开\"):(split?\"Open side by side\":\"Open in new tab\")}},selectAfterClose:true,onSelect:()=>panelOpenThreadTab({scope},{target},split)}})))",json!(icons[1]),json!(icons[0]));
    let restore=format!("{surface}===\"sidebar\"&&panelThreadCanRestore({scope},{target})&&{list}.push({{id:\"panel-thread-restore\",icon:{},message:{{id:\"panel.thread.restore\",defaultMessage:document.documentElement.lang.startsWith(\"zh\")?\"恢复为独立页面\":\"Restore as standalone page\"}},selectAfterClose:true,onSelect:()=>panelRestoreThread({scope},{target})}})",json!(icons[2]));
    let attribute = ast.property_value(presentation, "dataAttributes").unwrap();
    let active_id = ast.child(highlighted, "id").unwrap();
    let active_name = ast.text(active_id);
    let host = ast.text(ast.child(resolved, "id").unwrap());
    let mut changes=vec![Edit{start:ast.end(declaration),end:ast.end(declaration),text:format!(";const panelThreadRowActive=panelThreadIsActive({},{{conversationId:{},hostId:{host}??\"local\"}},{active_name},(0,{}.useSyncExternalStore)(panelThreadTabs11,panelThreadTabs10,panelThreadTabs10));",ast.text(root),ast.text(conversation),ast.text(react))},Edit{start:ast.start(attribute),end:ast.end(attribute),text:format!("panelThreadRowActive==={active_name}?{}:{{...{},\"data-app-action-sidebar-thread-active\":String(panelThreadRowActive),\"data-app-action-sidebar-thread-selected\":String(panelThreadRowActive)}}",ast.text(attribute),ast.text(attribute))},Edit{start:ast.start(push),end:ast.end(push),text:format!("({items},{restore},{})",ast.text(push))},Edit{start:ast.start(navigation),end:ast.end(navigation),text:format!("(panelFocusThread({},{{conversationId:{},hostId:{host}??\"local\"}})||{})",ast.text(root),ast.text(conversation),ast.text(navigation))}];
    if let Some(binding) = ast.binding(active_id) {
        for reference in ast.references(binding) {
            if ast.start(*reference) >= ast.start(statement)
                && ast.end(*reference) <= ast.end(statement)
            {
                changes.push(Edit {
                    start: ast.start(*reference),
                    end: ast.end(*reference),
                    text: "panelThreadRowActive".into(),
                });
            }
        }
    }
    let result = format!(
        "{imports}{}{}\n{helper}",
        if names[3].is_none() {
            "function panelThreadTabs3(){}"
        } else {
            ""
        },
        edits(source, changes)?
    );
    Ast::parse(&result, false)?;
    Ok(Some(result))
}

pub async fn prepare(
    connection: &super::cdp::Connection,
    app: &std::path::Path,
    environment: &super::config::Environment,
) -> Result<super::adapters::Prepared, ApiError> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let path = super::adapters::archive_path(app);
    let entries = tokio::task::spawn_blocking(move || super::adapters::read_esm_sources(&path))
        .await
        .map_err(|error| ApiError::new(500, "NATIVE_ESM", error.to_string()))??;
    let href = connection.evaluate("location.href", None).await?;
    let base = url::Url::parse(href.as_str().unwrap_or("app://-/index.html"))
        .map_err(|error| ApiError::new(422, "NATIVE_ESM", error.to_string()))?;
    let entries = entries
        .into_iter()
        .map(|(path, source)| {
            Ok((
                base.join(&path)
                    .map_err(|error| ApiError::new(422, "NATIVE_ESM", error.to_string()))?
                    .to_string(),
                source,
            ))
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let (mut sources, prepared, errors) = tokio::task::spawn_blocking(move || build(&entries))
        .await
        .map_err(|error| ApiError::new(500, "NATIVE_ESM", error.to_string()))??;
    let revision = hex::encode(Sha256::digest(
        json!([sources, prepared]).to_string().as_bytes(),
    ));
    let preferences = match &environment.preferences_file {
        Some(path) => tokio::fs::read(path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null),
        None => Value::Null,
    };
    let mut source = format!(
        "(()=>{{if(window!==window.top)return;const createState={};",
        include_str!("assets/preference_runtime.js")
    );
    for (name, preference) in [
        ("ProviderQuota", "customProviderQuotaFix"),
        ("ProviderUltrafast", "customProviderUltrafast"),
        ("DotEntry", "showCustomProviderDot"),
    ] {
        source.push_str(&format!(
            "(globalThis.__codexPanel{name}V1__??=createState({})).setEnabled({});",
            preferences[preference] == true,
            preferences[preference] == true
        ));
    }
    source.push_str(&format!("globalThis.__codexPanelNativeAdaptersRevision__={};globalThis.__codexPanelNativeAdaptersPrepared__={};globalThis.__codexPanelQuotaBootstrapPrepared__={};globalThis.__codexPanelUltrafastBootstrapPrepared__={};globalThis.__codexPanelDotBootstrapPrepared__={};}})();",json!(revision),prepared,prepared["quota"]==true,prepared["ultrafast"]==true,prepared["dot"]==true));
    let mut events = connection.events();
    let active = connection.clone();
    let patterns = sources
        .keys()
        .map(|url| json!({"urlPattern":url,"resourceType":"Script","requestStage":"Response"}))
        .collect::<Vec<_>>();
    let handler = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if !active.owns_event(&event) || event["method"] != "Fetch.requestPaused" {
                continue;
            }
            let params = &event["params"];
            let id = params["requestId"].clone();
            let replacement = params["request"]["url"]
                .as_str()
                .and_then(|url| sources.get_mut(url));
            let result = if params["responseStatusCode"] == 200 && replacement.is_some() {
                let headers = params["responseHeaders"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|header| {
                        !matches!(
                            header["name"]
                                .as_str()
                                .unwrap_or("")
                                .to_ascii_lowercase()
                                .as_str(),
                            "content-length" | "content-encoding"
                        )
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                active.send("Fetch.fulfillRequest",json!({"requestId":id,"responseCode":200,"responseHeaders":headers,"body":base64::engine::general_purpose::STANDARD.encode(replacement.unwrap().as_bytes())})).await
            } else {
                active
                    .send("Fetch.continueRequest", json!({"requestId":id}))
                    .await
            };
            if let Err(error) = result {
                eprintln!("Panel ESM response: {error}");
                let _ = active
                    .send("Fetch.continueRequest", json!({"requestId":id}))
                    .await;
            }
        }
    });
    if let Err(error) = connection
        .send("Fetch.enable", json!({"patterns":patterns}))
        .await
    {
        handler.abort();
        return Err(error);
    }
    let features=prepared.as_object().into_iter().flatten().map(|(name,value)|json!({"id":name,"phase":if value==true{"prepared"}else{"failed"},"message":errors[name]})).collect::<Vec<_>>();
    let status = json!({"phase":if errors.as_object().is_some_and(|errors|errors.is_empty()){"prepared"}else{"partial"},"message":"旧版 ESM 模块已由 Rust 原生分析","features":features,"progress":null});
    Ok(super::adapters::Prepared {
        source,
        handler,
        status,
        revision,
    })
}

fn build(
    entries: &[(String, String)],
) -> Result<(std::collections::BTreeMap<String, String>, Value, Value), ApiError> {
    let mut updated = std::collections::BTreeMap::new();
    let mut prepared = json!({"quota":false,"ultrafast":false,"dot":false,"tabs":false});
    let mut errors = json!({});
    let mut quota_candidates = Vec::new();
    for (index, (url, source)) in entries
        .iter()
        .enumerate()
        .filter(|(_, (_, source))| source.contains("submitDisabled"))
    {
        if let Some(changed) = quota(source, url, source, url)? {
            quota_candidates.push((index, index, changed));
            continue;
        }
        for (other, (provider_url, provider)) in entries
            .iter()
            .enumerate()
            .filter(|(other, (_, source))| *other != index && source.contains("model_provider"))
        {
            if let Some(changed) = quota(source, url, provider, provider_url)? {
                if !quota_candidates
                    .iter()
                    .any(|(_, _, previous)| previous == &changed)
                {
                    quota_candidates.push((index, other, changed));
                }
            }
        }
    }
    if quota_candidates.len() == 1 {
        let (index, _, changed) = quota_candidates.remove(0);
        updated.insert(entries[index].0.clone(), changed);
        prepared["quota"] = json!(true);
    } else {
        errors["quota"] = json!("旧版配额模块缺失或存在歧义");
    }
    let mut speed = Vec::new();
    for (url, original) in entries
        .iter()
        .filter(|(_, source)| source.contains("serviceTierSettings"))
    {
        let source = updated.get(url).unwrap_or(original);
        let (changed, settings, menu) = ultrafast(source)?;
        if let Some(changed) = changed {
            speed.push((url.clone(), changed, settings, menu));
        }
    }
    if speed.iter().filter(|(_, _, settings, _)| *settings).count() == 1
        && speed.iter().filter(|(_, _, _, menu)| *menu).count() == 1
    {
        for (url, source, _, _) in speed {
            updated.insert(url, source);
        }
        prepared["ultrafast"] = json!(true);
    } else {
        errors["ultrafast"] = json!("旧版速度设置或菜单缺失或存在歧义");
    }
    let mut dots = Vec::new();
    for (url, original) in entries
        .iter()
        .filter(|(_, source)| source.contains("requiresFirstPartyInference"))
    {
        if let Some(changed) = dot(updated.get(url).unwrap_or(original))? {
            dots.push((url.clone(), changed));
        }
    }
    if dots.len() == 1 {
        let (url, source) = dots.remove(0);
        updated.insert(url, source);
        prepared["dot"] = json!(true);
    } else {
        errors["dot"] = json!("旧版 Dot 权限模块缺失或存在歧义");
    }
    let mut initials = Vec::new();
    let mut primaries = Vec::new();
    for (index, (_, source)) in entries.iter().enumerate() {
        if source.contains("orbit-activity") && source.contains("openTab") {
            let ast = Ast::parse(source, false)?;
            if native_tabs(&ast).is_some() {
                initials.push(index);
            }
        }
        if source.contains("paneItems") && source.contains("dataAttributes") {
            let ast = Ast::parse(source, false)?;
            if sidebar(&ast).is_some() {
                primaries.push(index);
            }
        }
    }
    if initials.len() == 1 && primaries.len() == 1 {
        let (url, original) = &entries[primaries[0]];
        let (initial_url, initial) = &entries[initials[0]];
        if let Some(source) = tabs(updated.get(url).unwrap_or(original), initial, initial_url)? {
            updated.insert(url.clone(), source);
            prepared["tabs"] = json!(true);
        }
    }
    if prepared["tabs"] != true {
        errors["tabs"] = json!("旧版会话标签模块缺失或存在歧义");
    }
    for source in updated.values() {
        Ast::parse(source, false)?;
    }
    Ok((updated, prepared, errors))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(file: &str, name: &str) -> String {
        let ast = Ast::parse(file, false).unwrap();
        let declaration = ast.all(ast.root, |id| {
            ast.kind(id) == "VariableDeclarator"
                && ast
                    .child(id, "id")
                    .is_some_and(|id| ast.name(id).as_deref() == Some(name))
        })[0];
        let init = ast.child(declaration, "init").unwrap();
        if let Some(value) = ast.field(init, "value").as_str() {
            return value.into();
        }
        let quasis = ast.array(init, "quasis");
        assert_eq!(quasis.len(), 1);
        ast.field(quasis[0], "value")["cooked"]
            .as_str()
            .unwrap()
            .into()
    }
    fn function(file: &str, name: &str) -> String {
        let ast = Ast::parse(file, false).unwrap();
        let node = ast.all(ast.root, |id| {
            ast.kind(id) == "FunctionDeclaration"
                && ast
                    .child(id, "id")
                    .is_some_and(|id| ast.name(id).as_deref() == Some(name))
        })[0];
        ast.text(node).into()
    }
    fn run(source: &str) {
        let output = std::process::Command::new("node")
            .args(["-e", source])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn legacy_quota_preserves_native_blockers_and_provider_boundary() {
        let file = include_str!("../../../test/codex-provider-quota.test.mjs");
        let begin = file.find("const source = `").unwrap();
        let end = file.find("const renamed = ").unwrap();
        let output = std::process::Command::new("node")
            .args([
                "-e",
                &format!(
                    "{};console.log(JSON.stringify(currentSource))",
                    &file[begin..end]
                ),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let source: String = serde_json::from_slice(&output.stdout).unwrap();
        let patched = quota(
            &source,
            "app://-/assets/composer.js",
            &source,
            "app://-/assets/composer.js",
        )
        .unwrap()
        .unwrap();
        run(&format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');let enabled=true;const fn=vm.runInNewContext({}+';h7',{{__codexPanelProviderQuotaV1__:{{subscribe(){{}},getSnapshot:()=>enabled}},g7:{{useState:()=>[],useSyncExternalStore:(_,read)=>read()}}}});assert.equal(fn({{threadProvider:'custom'}}).submit(),'hello');for(const option of[{{threadProvider:'openai'}},{{threadProvider:'custom',host:'remote'}},{{threadProvider:'custom',disabled:true}},{{threadProvider:'custom',policy:true}}])assert.equal(fn(option).submit(),false);enabled=false;assert.equal(fn({{threadProvider:'custom'}}).submit(),false);"#,
            json!(patched)
        ));
    }
    #[test]
    fn legacy_speed_settings_menu_and_switch_remain_coherent() {
        let file = include_str!("../../../test/codex-provider-ultrafast.test.mjs");
        let initial = fixture(file, "initial");
        let primary = fixture(file, "primary");
        let patched_initial = speed_settings(&initial).unwrap().unwrap();
        let patched_primary = speed_menu(&primary).unwrap().unwrap();
        let harness = function(file, "fixture");
        run(&format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const initial={},primary={};const createCodexProviderQuotaRuntime={};const rewriteCodexProviderUltrafast=source=>source===initial?{}:{};{};(async()=>{{const f=fixture(false);assert.equal(f.menu().options.some(o=>o.value==='ultrafast'),false);f.runtime.setEnabled(true);assert.equal(f.menu().options.some(o=>o.value==='ultrafast'),true);assert.equal(await f.menu().select('ultrafast'),true);assert.equal(f.settings().serviceTierSettings.serviceTierForRequest,'ultrafast');f.thread('openai');assert.equal(await f.menu().select('ultrafast'),true);f.thread(undefined);f.provider(undefined);assert.equal(await f.menu().select('ultrafast'),true);assert.equal(f.settings().serviceTierSettings.serviceTierForRequest,'ultrafast');for(const invalid of['',' ',false,7,{{}},[]]){{f.thread(invalid);assert.equal(await f.menu().select('ultrafast'),false);}}f.thread('custom');f.host('remote');assert.equal(await f.menu().select('ultrafast'),false);}})().catch(e=>{{console.error(e);process.exitCode=1}});"#,
            json!(initial),
            json!(primary),
            include_str!("assets/preference_runtime.js"),
            json!(patched_initial),
            json!(patched_primary),
            harness
        ));
    }
    #[test]
    fn legacy_dot_uses_explicit_signal_key_and_preserves_other_capabilities() {
        let source = fixture(
            include_str!("../../../test/codex-dot-entry.test.mjs"),
            "initial",
        );
        let patched = dot(&source).unwrap().unwrap();
        run(&format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');let enabled=true;const get=vm.runInNewContext({}+';capability',{{__codexPanelDotEntryV1__:{{getSnapshot:()=>enabled,subscribe(){{}}}},scope:{{}},account:'account',flag:'flag',providerConfig:'provider',signal:(_,read)=>({{read}}),derived:(_,read)=>name=>read({{name}},{{get:(atom,...key)=>{{if(atom==='account')return{{isCapable:false}};if(atom==='flag')return true;if(atom==='provider')return'custom';assert.equal(key.length,1);return atom.read()}}}})}});assert.equal(get('orbit').isCapable,true);assert.equal(get('cloud').isCapable,false);enabled=false;assert.equal(get('orbit').isCapable,false);"#,
            json!(patched)
        ));
    }
    #[test]
    fn legacy_tabs_use_native_ownership_and_sidebar_focus() {
        let file = include_str!("../../../test/codex-thread-tabs.test.mjs");
        let initial = fixture(file, "initial");
        let primary = fixture(file, "primary");
        let patched = tabs(&primary, &initial, "app://-/assets/tabs-core.js")
            .unwrap()
            .unwrap();
        let harness = function(file, "harness");
        run(&format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const initial={},primary={},rewriteCodexThreadTabs=()=>{};{};(async()=>{{const f=harness();let items=await f.menu({{scope:f.root,target:f.target,surface:'sidebar',paneItems:[]}});assert.equal(items.length,2);await items.find(i=>i.id==='panel-thread-tab').onSelect();assert.equal(f.opens.length,1);items=await f.menu({{scope:f.root,target:f.target,surface:'sidebar',paneItems:[]}});await items.find(i=>i.id==='panel-thread-split').onSelect();assert.equal(f.opens.length,1);f.sidebar(f.root,'second','local');await new Promise(r=>setImmediate(r));assert.equal(f.currentComposer(),'local:second');}})().catch(e=>{{console.error(e);process.exitCode=1}});"#,
            json!(initial),
            json!(primary),
            json!(patched),
            harness
        ));
    }
}
