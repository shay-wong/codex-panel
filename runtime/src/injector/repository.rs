use super::{
    features::Context,
    source_ast::{edits, unique, Ast, Edit, Id},
};
use crate::ApiError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const RUNTIME: &str = "globalThis.__codexPanelRepositoryBranchPrefixV1__";
fn error(message: &str) -> ApiError {
    ApiError::new(422, "NATIVE_CONTRACT", message)
}
fn member(ast: &Ast, node: Id, name: &str) -> bool {
    let node = ast.unwrap(node);
    ast.kind(node) == "MemberExpression" && ast.name(node).as_deref() == Some(name)
}
fn owner(ast: &Ast, node: Id) -> Option<Id> {
    ast.enclosing(node, |node| ast.is_function(node))
}
fn own(ast: &Ast, function: Id, check: impl Fn(Id) -> bool) -> Vec<Id> {
    ast.all(function, |node| {
        owner(ast, node) == Some(function) && check(node)
    })
}
fn parameters(ast: &Ast, function: Id) -> Vec<Id> {
    let Some(parameter) = ast
        .array(function, "params")
        .first()
        .copied()
        .map(|node| ast.unwrap(node))
    else {
        return Vec::new();
    };
    if ast.kind(parameter) == "ObjectPattern" {
        return vec![parameter];
    }
    own(ast, function, |node| {
        ast.kind(node) == "VariableDeclarator"
            && ast
                .child(node, "id")
                .is_some_and(|id| ast.kind(id) == "ObjectPattern")
            && ast
                .child(node, "init")
                .is_some_and(|init| ast.same_binding(ast.value(init), parameter))
    })
    .into_iter()
    .filter_map(|node| ast.child(node, "id"))
    .collect()
}
fn body_start(ast: &Ast, function: Id) -> Result<usize, ApiError> {
    let body = ast
        .child(function, "body")
        .filter(|body| ast.kind(*body) == "BlockStatement")
        .ok_or_else(|| error("Native function body is unsupported"))?;
    Ok(ast
        .array(body, "body")
        .into_iter()
        .filter(|node| ast.field(*node, "directive").is_string())
        .last()
        .map(|node| ast.end(node))
        .unwrap_or(ast.start(body) + 1))
}

fn membership(context: &Context) -> Result<(Value, Value, Value), ApiError> {
    let mut candidates = BTreeMap::new();
    for id in context.modules_containing("readMemberships") {
        let ast = context.ast(&id)?;
        let mut keys = BTreeMap::new();
        for node in ast.all(ast.root, |node| {
            member(&ast, node, "THREAD_PROJECT_ASSIGNMENTS")
        }) {
            if let Some(object) = ast.child(node, "object") {
                if let Some(reference) = context.export_of(&id, object)? {
                    keys.insert(reference.to_string(), reference);
                }
            }
        }
        if keys.is_empty()
            || ast
                .all(ast.root, |node| {
                    ast.kind(node) == "CallExpression"
                        && ast
                            .child(node, "callee")
                            .is_some_and(|callee| member(&ast, callee, "readMemberships"))
                })
                .is_empty()
        {
            continue;
        }
        if keys.len() != 1 {
            return Err(error("Native repository membership key is ambiguous"));
        }
        let key = keys.into_values().next().unwrap();
        for (_, exported) in ast.exports() {
            let function = ast.value(exported);
            if !ast.is_function(function) || ast.array(function, "params").len() != 2 {
                continue;
            }
            let Some(result) = ast
                .return_value(function)
                .filter(|node| ast.kind(*node) == "CallExpression")
            else {
                continue;
            };
            if !ast
                .child(result, "callee")
                .is_some_and(|callee| ast.same_binding(callee, ast.array(function, "params")[0]))
            {
                continue;
            }
            let Some(parsed) = ast.array(result, "arguments").first().copied() else {
                continue;
            };
            let mut data = Vec::new();
            for field in ast.all(ast.root, |node| {
                ast.kind(node) == "Property"
                    && ast.name(node).as_deref() == Some("data")
                    && ast.child(node, "value").is_some_and(|value| {
                        ast.kind(value) == "CallExpression"
                            && ast
                                .array(value, "arguments")
                                .iter()
                                .any(|argument| ast.same_binding(*argument, parsed))
                    })
            }) {
                if let Some(declaration) = ast
                    .enclosing(field, |node| ast.kind(node) == "VariableDeclarator")
                    .and_then(|node| ast.child(node, "id"))
                {
                    if let Some(reference) = context.export_of(&id, declaration)? {
                        data.push(reference);
                    }
                }
            }
            if data.len() == 1 {
                if let Some(read) = context.export_of(&id, exported)? {
                    let data = data.pop().unwrap();
                    candidates.insert(
                        json!([read, data, key]).to_string(),
                        (read, data, key.clone()),
                    );
                }
            }
        }
    }
    if candidates.len() != 1 {
        return Err(error("Native repository membership signal is unavailable"));
    }
    Ok(candidates.into_values().next().unwrap())
}

fn scope_for_prefix(ast: &Ast, function: Id, hook: Id) -> Option<(String, String)> {
    let available = |node| {
        ast.all(node, |node| ast.kind(node) == "Identifier")
            .iter()
            .all(|node| {
                ast.binding(*node).is_none_or(|binding| {
                    ast.start(ast.binding_declaration(binding)) < ast.start(hook)
                })
            })
    };
    let mut contexts = BTreeSet::new();
    for node in own(ast, function, |node| {
        matches!(ast.kind(node), "ObjectPattern" | "ObjectExpression")
            && ast.property_value(node, "cwd").is_some()
            && ast.property_value(node, "hostConfig").is_some()
    }) {
        let cwd = ast.property_value(node, "cwd").unwrap();
        let host = ast.property_value(node, "hostConfig").unwrap();
        if available(cwd) && available(host) {
            contexts.insert((ast.text(cwd).to_owned(), format!("{}.id", ast.text(host))));
        }
    }
    if contexts.is_empty() {
        if let Some(parameter) = ast
            .array(function, "params")
            .first()
            .copied()
            .filter(|node| ast.kind(*node) == "Identifier")
        {
            let scoped = !ast
                .all(hook, |node| {
                    member(ast, node, "scope")
                        && ast
                            .child(node, "object")
                            .is_some_and(|object| ast.same_binding(object, parameter))
                })
                .is_empty();
            let function_id = ast.child(function, "id");
            let callers = ast.all(ast.root, |node| {
                ast.kind(node) == "CallExpression"
                    && ast
                        .child(node, "callee")
                        .zip(function_id)
                        .is_some_and(|(callee, function)| ast.same_binding(callee, function))
            });
            if scoped
                && !callers.is_empty()
                && callers.iter().all(|call| {
                    let Some(argument) = ast
                        .array(*call, "arguments")
                        .first()
                        .copied()
                        .filter(|node| ast.kind(*node) == "Identifier")
                    else {
                        return false;
                    };
                    let Some(owner) = owner(ast, *call) else {
                        return false;
                    };
                    ["cwd", "hostConfig"].iter().all(|name| {
                        !ast.all(owner, |node| {
                            member(ast, node, name)
                                && ast
                                    .child(node, "object")
                                    .is_some_and(|object| ast.same_binding(object, argument))
                        })
                        .is_empty()
                    })
                })
            {
                contexts.insert((
                    format!("{}.cwd", ast.text(parameter)),
                    format!("{}.hostConfig.id", ast.text(parameter)),
                ));
            }
        }
    }
    if contexts.len() == 1 {
        contexts.into_iter().next()
    } else {
        None
    }
}

fn thread_context(
    ast: &Ast,
    function: Id,
    hook: Id,
) -> Result<Option<(String, Vec<Edit>)>, ApiError> {
    let mut contexts = Vec::new();
    for pattern in parameters(ast, function) {
        let id = ast.property_value(pattern, "conversationId");
        if let Some(id) = id.filter(|id| ast.start(*id) < ast.start(hook)) {
            contexts.push((ast.text(id).to_owned(), Vec::new()));
        }
        if id.is_none() {
            if let Some(target) = ast.property_value(pattern, "target").filter(|node| {
                ast.kind(*node) == "Identifier" && ast.start(*node) < ast.start(hook)
            }) {
                if !own(ast, function, |node| {
                    member(ast, node, "conversationId")
                        && ast
                            .child(node, "object")
                            .is_some_and(|object| ast.same_binding(object, target))
                })
                .is_empty()
                {
                    contexts.push((format!("{}.conversationId", ast.text(target)), Vec::new()));
                }
            }
        }
    }
    if contexts.len() > 1 {
        return Err(error("Native repository conversation context is ambiguous"));
    }
    if !contexts.is_empty() {
        return Ok(contexts.pop());
    }
    let Some(parameter) = ast
        .array(function, "params")
        .first()
        .copied()
        .filter(|node| ast.kind(*node) == "Identifier")
    else {
        return Ok(None);
    };
    if !ast
        .all(function, |node| {
            member(ast, node, "threadId")
                && ast
                    .child(node, "object")
                    .is_some_and(|object| ast.same_binding(object, parameter))
        })
        .is_empty()
    {
        return Ok(Some((
            format!("{}.threadId", ast.text(parameter)),
            Vec::new(),
        )));
    }
    let scoped = !ast
        .all(hook, |node| {
            member(ast, node, "scope")
                && ast
                    .child(node, "object")
                    .is_some_and(|object| ast.same_binding(object, parameter))
        })
        .is_empty();
    if !scoped {
        if let Some(id) = ast.child(function, "id") {
            let callers = ast.all(ast.root, |node| {
                ast.kind(node) == "CallExpression"
                    && ast
                        .array(node, "arguments")
                        .first()
                        .is_some_and(|argument| ast.same_binding(*argument, id))
            });
            if callers.len() != 1 {
                return Ok(None);
            }
            let caller = callers[0];
            let Some(parent) = owner(ast, caller) else {
                return Ok(None);
            };
            let args = ast.array(caller, "arguments");
            if args.len() < 2 || ast.kind(args[1]) != "ObjectExpression" {
                return Ok(None);
            }
            let threads = parameters(ast, parent)
                .iter()
                .filter_map(|pattern| ast.property_value(*pattern, "localConversationId"))
                .collect::<Vec<_>>();
            if threads.is_empty() {
                return Ok(None);
            }
            let id = unique(threads, "Native branch dialog conversation is ambiguous")?;
            let Some(assignment) = ast.enclosing(caller, |node| {
                ast.kind(node) == "AssignmentExpression"
                    && ast
                        .child(node, "left")
                        .is_some_and(|left| ast.kind(left) == "Identifier")
            }) else {
                return Ok(None);
            };
            let left = ast.child(assignment, "left").unwrap();
            let Some(cache) = ast.enclosing(assignment, |node| {
                ast.kind(node) == "ConditionalExpression"
                    && ast
                        .child(node, "alternate")
                        .map(|node| ast.unwrap(node))
                        .is_some_and(|node| {
                            ast.kind(node) == "AssignmentExpression"
                                && ast
                                    .child(node, "left")
                                    .is_some_and(|other| ast.same_binding(other, left))
                        })
            }) else {
                return Ok(None);
            };
            return Ok(Some((format!("{}.panelRepositoryThreadId",ast.text(parameter)),vec![Edit{start:ast.start(cache),end:ast.end(cache),text:format!("{}=((panelBranchElement)=>(panelBranchElement?{{...panelBranchElement,props:{{...panelBranchElement.props,panelRepositoryThreadId:{}}}}}:panelBranchElement))({})",ast.text(left),ast.text(id),ast.text(cache))}])));
        }
    }
    Ok(None)
}

pub fn rewrite(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if source.contains("__codexPanelRepositoryBranchPrefixV1__")
        || ![
            "branchPrefix",
            "readCreationInputs",
            "readDeveloperInstructions",
        ]
        .iter()
        .any(|term| source.contains(term))
    {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let mut changes = Vec::new();
    let candidates = ast
        .all(ast.root, |node| {
            ast.kind(node) == "CallExpression"
                && ast
                    .child(node, "callee")
                    .is_some_and(|callee| member(&ast, callee, "startConversation"))
        })
        .into_iter()
        .filter_map(|call| {
            let function = owner(&ast, call)?;
            let parameters = ast.array(function, "params");
            if !ast.boolean(function, "async")
                || parameters.len() < 3
                || ast.kind(parameters[1]) != "Identifier"
                || ast.kind(parameters[2]) != "Identifier"
            {
                return None;
            }
            let args = ast.array(call, "arguments");
            if args.len() < 2 {
                return None;
            }
            let request = ast.unwrap(args[0]);
            let callbacks = ast.unwrap(args[1]);
            if ast.kind(request) != "ObjectExpression"
                || ast.kind(callbacks) != "ObjectExpression"
                || ast.property_value(callbacks, "worktreeInit").is_none()
            {
                return None;
            }
            let options = parameters[2];
            if !ast.array(request, "properties").iter().any(|field| {
                ast.kind(*field) == "SpreadElement"
                    && ast
                        .child(*field, "argument")
                        .is_some_and(|argument| ast.same_binding(ast.value(argument), options))
            }) {
                return None;
            }
            let reader = ast.property_value(callbacks, "readThreadCreationInputs")?;
            if ast
                .all(reader, |node| {
                    ast.kind(node) == "CallExpression"
                        && ast
                            .child(node, "callee")
                            .is_some_and(|callee| member(&ast, callee, "readCreationInputs"))
                })
                .is_empty()
            {
                return None;
            }
            if ast
                .all(function, |node| {
                    member(&ast, node, "projectAssignment")
                        && ast
                            .child(node, "object")
                            .is_some_and(|object| ast.same_binding(ast.value(object), options))
                })
                .is_empty()
            {
                return None;
            }
            Some((function, options, parameters[1]))
        })
        .collect::<Vec<_>>();
    if candidates.len() > 1 {
        return Err(error(
            "Native conversation creation for repository branch prefixes is ambiguous",
        ));
    }
    if let Some((function, options, host)) = candidates.first() {
        let start = body_start(&ast, *function)?;
        changes.push(Edit {
            start,
            end: start,
            text: format!(
                "{}={RUNTIME}?.prepareConversation({},{})??{};",
                ast.text(*options),
                ast.text(*options),
                ast.text(*host),
                ast.text(*options)
            ),
        });
    }
    let mut require = "panelRepositoryRequire".to_owned();
    while !ast
        .all(ast.root, |node| {
            ast.kind(node) == "Identifier" && ast.name(node).as_deref() == Some(require.as_str())
        })
        .is_empty()
    {
        require.push('_');
    }
    for hook in ast.all(ast.root, |node| {
        ast.kind(node) == "CallExpression"
            && ast
                .array(node, "arguments")
                .iter()
                .any(|argument| member(&ast, *argument, "branchPrefix"))
    }) {
        let Some(function) = owner(&ast, hook) else {
            continue;
        };
        let Some(declaration) = ast.enclosing(hook, |node| ast.kind(node) == "VariableDeclarator")
        else {
            continue;
        };
        let Some(id) = ast
            .child(declaration, "id")
            .filter(|id| ast.kind(*id) == "Identifier")
        else {
            continue;
        };
        if own(&ast, function, |node| {
            ast.kind(node) == "ObjectExpression"
                && ast.property_value(node, "conversationTitle").is_some()
                && ast
                    .property_value(node, "branchPrefix")
                    .is_some_and(|prefix| ast.same_binding(prefix, id))
        })
        .is_empty()
        {
            continue;
        }
        let Some((cwd, host)) = scope_for_prefix(&ast, function, hook) else {
            continue;
        };
        let mut assignment = None;
        if let Some((thread, thread_edits)) = thread_context(&ast, function, hook)? {
            let (read, data, key) = membership(context)?;
            let reference =
                |value: &Value| format!("{require}({})[{}]", value["id"], value["exportName"]);
            let parameter = ast.array(function, "params").first().copied();
            let scoped = parameter.is_some_and(|parameter| {
                ast.kind(parameter) == "Identifier"
                    && !ast
                        .all(hook, |node| {
                            member(&ast, node, "scope")
                                && ast
                                    .child(node, "object")
                                    .is_some_and(|object| ast.same_binding(object, parameter))
                        })
                        .is_empty()
            });
            assignment = Some(if scoped {
                format!(
                    "{}({}.scope.get,{}.THREAD_PROJECT_ASSIGNMENTS)?.[{thread}]",
                    reference(&read),
                    ast.text(parameter.unwrap()),
                    reference(&key)
                )
            } else {
                let callee = ast
                    .child(hook, "callee")
                    .ok_or_else(|| error("Native repository hook is unavailable"))?;
                let target = context.resolve(module, callee)?;
                let function = target.ast.value(target.node);
                let native = target
                    .ast
                    .return_value(function)
                    .map(|node| target.ast.unwrap(node))
                    .filter(|node| target.ast.kind(*node) == "CallExpression")
                    .ok_or_else(|| error("Native repository membership hook is unavailable"))?;
                let hook = target
                    .ast
                    .child(native, "callee")
                    .ok_or_else(|| error("Native repository membership hook is unavailable"))?;
                let reference_hook = context
                    .export_of(&target.module, hook)?
                    .ok_or_else(|| error("Native repository membership hook is unavailable"))?;
                format!(
                    "{}({},{}.THREAD_PROJECT_ASSIGNMENTS).data?.[{thread}]",
                    reference(&reference_hook),
                    reference(&data),
                    reference(&key)
                )
            });
            changes.extend(thread_edits);
        }
        changes.push(Edit{start:ast.start(hook),end:ast.end(hook),text:format!("((panelGlobalPrefix,panelAssignment)=>{RUNTIME}?.resolve({{cwd:{cwd},hostId:{host},assignment:panelAssignment}},panelGlobalPrefix)??panelGlobalPrefix)({}{})",ast.text(hook),assignment.map(|value|format!(",{value}")).unwrap_or_default())});
    }
    if changes
        .iter()
        .any(|edit| edit.text.contains(&format!("{require}(")))
    {
        let start = body_start(&ast, ast.root)?;
        let parameters = ast.array(ast.root, "params");
        if parameters.len() < 3 {
            return Err(error("Native factory require is unavailable"));
        }
        changes.push(Edit {
            start,
            end: start,
            text: format!("const {require}={};", ast.text(parameters[2])),
        });
    }
    let candidates = ast.all(ast.root, |node| {
        if ast.kind(node) != "CallExpression"
            || !ast
                .child(node, "callee")
                .is_some_and(|callee| member(&ast, callee, "readDeveloperInstructions"))
        {
            return false;
        }
        let Some(function) = owner(&ast, node) else {
            return false;
        };
        let parameters = ast.array(function, "params");
        let args = ast.array(node, "arguments");
        if parameters.len() != 1
            || ast.kind(parameters[0]) != "Identifier"
            || !args
                .first()
                .is_some_and(|argument| ast.same_binding(*argument, parameters[0]))
        {
            return false;
        }
        let Some(service) = ast
            .child(node, "callee")
            .map(|node| ast.unwrap(node))
            .and_then(|callee| ast.child(callee, "object"))
            .map(|node| ast.value(node))
        else {
            return false;
        };
        member(&ast, service, "threadConfiguration")
            && ast
                .child(service, "object")
                .is_some_and(|object| member(&ast, object, "appServices"))
            && ast
                .parent(node)
                .is_some_and(|parent| ast.kind(parent) == "ReturnStatement")
    });
    if candidates.len() > 1 {
        return Err(error(
            "Native developer instruction service for repository branch prefixes is ambiguous",
        ));
    }
    if let Some(call) = candidates.first() {
        let service = ast
            .child(*call, "callee")
            .map(|node| ast.unwrap(node))
            .and_then(|callee| ast.child(callee, "object"))
            .map(|node| ast.value(node))
            .unwrap();
        let services = ast.child(service, "object").unwrap();
        let request = ast.array(*call, "arguments")[0];
        changes.push(Edit{start:ast.start(*call),end:ast.end(*call),text:format!("Promise.resolve({}).then(async panelInstructions=>{{let panelMemberships;try{{if({}.threadId!=null)panelMemberships=await {}.threadProjectAssignments?.readMemberships()}}catch{{}}return {RUNTIME}?.prepareDeveloperInstructions({},panelInstructions,panelMemberships?.assignments?.[{}.threadId])??panelInstructions}})",ast.text(*call),ast.text(request),ast.text(services),ast.text(request),ast.text(request))});
    }
    if changes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(edits(source, changes)?))
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapters::{Catalog, Module, Variant};
    use super::*;
    fn catalog(source: &str) -> Catalog {
        Catalog {
            main_url_path: String::new(),
            main_source: String::new(),
            digest: String::new(),
            modules: [(
                "subject".into(),
                Module {
                    source: source.into(),
                    exports: Vec::new(),
                    variants: vec![Variant {
                        source: source.into(),
                        chunks: Vec::new(),
                        asset_size: 0,
                    }],
                },
            )]
            .into_iter()
            .collect(),
            unreadable: Vec::new(),
        }
    }
    #[test]
    fn repository_prefix_retains_global_fallback_and_host_boundary() {
        let source="function(module,exports,load){function branch({cwd,hostConfig}){const prefix=read(settings.branchPrefix);return{conversationTitle:'task',branchPrefix:prefix};}load.d(exports,{branch:()=>branch});}";
        let catalog = catalog(source);
        let rewritten = rewrite(source, "subject", &Context::new(&catalog))
            .unwrap()
            .unwrap();
        Ast::parse(&rewritten, true).unwrap();
        let script = format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const storage={{getItem:()=>null,setItem(){{}}}},runtime=({})({{storage}});runtime.set('repo',{{prefix:'work/',hostId:'local',rootPaths:['/repo']}});let reads=0;const exports={{}},load=()=>{{}};load.d=(exports,getters)=>{{for(const[name,get]of Object.entries(getters))Object.defineProperty(exports,name,{{get}})}};vm.runInNewContext('('+{}+')',{{__codexPanelRepositoryBranchPrefixV1__:runtime,read:value=>{{reads++;return value}},settings:{{branchPrefix:'global/'}}}})({{}},exports,load);assert.equal(exports.branch({{cwd:'/repo/subdir',hostConfig:{{id:'local'}}}}).branchPrefix,'work/');assert.equal(exports.branch({{cwd:'/other',hostConfig:{{id:'local'}}}}).branchPrefix,'global/');assert.equal(exports.branch({{cwd:'/repo',hostConfig:{{id:'remote'}}}}).branchPrefix,'global/');assert.equal(reads,3);"#,
            include_str!("assets/repository_runtime.js"),
            json!(rewritten)
        );
        let output = std::process::Command::new("node")
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn conversation_creation_preserves_original_options_and_adds_repository_instructions() {
        let source="function(module,exports,load){async function create(scope,host,options){const assignment=options.projectAssignment;return app.startConversation({...options},{worktreeInit:()=>{},readThreadCreationInputs:()=>app.readCreationInputs()});}load.d(exports,{create:()=>create})}";
        let catalog = catalog(source);
        let rewritten = rewrite(source, "subject", &Context::new(&catalog))
            .unwrap()
            .unwrap();
        Ast::parse(&rewritten, true).unwrap();
        let script = format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const runtime=({})({{storage:{{getItem:()=>null,setItem(){{}}}}}});runtime.set('repo',{{prefix:'',hostId:'local',rootPaths:['/repo']}});const exports={{}},load=()=>{{}};load.d=(exports,getters)=>{{for(const[name,get]of Object.entries(getters))Object.defineProperty(exports,name,{{get}})}};vm.runInNewContext('('+{}+')',{{__codexPanelRepositoryBranchPrefixV1__:runtime,app:{{startConversation:async options=>options}}}})({{}},exports,load);(async()=>{{const original={{cwd:'/repo',projectAssignment:{{projectId:'repo',projectKind:'local'}},additionalDeveloperInstructions:'retained'}};const result=await exports.create(null,'local',original);assert.equal(original.additionalDeveloperInstructions,'retained');assert.ok(result.additionalDeveloperInstructions.startsWith('retained'));assert.ok(result.additionalDeveloperInstructions.includes('without any prefix'));}})().catch(error=>{{console.error(error);process.exitCode=1}});"#,
            include_str!("assets/repository_runtime.js"),
            json!(rewritten)
        );
        let output = std::process::Command::new("node")
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
