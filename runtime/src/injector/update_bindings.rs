use super::{
    adapters::Catalog,
    cdp::Connection,
    features::{Context, Resolved},
    source_ast::{Ast, Id},
};
use crate::ApiError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn calls(ast: &Ast, root: Id) -> Vec<Id> {
    ast.all(root, |node| ast.kind(node) == "CallExpression")
}
fn functions(
    context: &Context,
    module: &str,
    node: Id,
    visited: &mut BTreeSet<(String, Id)>,
) -> Result<Vec<Resolved>, ApiError> {
    let target = context.resolve(module, node)?;
    if !target.ast.is_function(target.node) || !visited.insert((target.module.clone(), target.node))
    {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for call in calls(&target.ast, target.node) {
        if let Some(callee) = target.ast.child(call, "callee") {
            result.extend(functions(context, &target.module, callee, visited)?);
        }
    }
    result.push(target);
    Ok(result)
}
fn same(
    context: &Context,
    left_module: &str,
    left: Id,
    right_module: &str,
    right: Id,
) -> Result<bool, ApiError> {
    let left = context.resolve(left_module, left)?;
    let right = context.resolve(right_module, right)?;
    Ok(left.module == right.module
        && (left.node == right.node || left.ast.same_binding(left.node, right.node)))
}
fn descriptor(context: &Context, module: &str, node: Id) -> Result<Option<Value>, ApiError> {
    Ok(context
        .export_of(module, node)?
        .map(|value| json!({"id":value["id"],"name":value["exportName"]})))
}

pub fn build(catalog: &Catalog, context: &Context) -> Result<Value, ApiError> {
    let mut related = BTreeSet::new();
    let mut changes = Vec::new();
    for (id, module) in &catalog.modules {
        if !module.source.contains("stateChanged") || !module.source.contains("getRestartBlockers")
        {
            continue;
        }
        let ast = context.ast(id)?;
        for function in ast.all(ast.root, |node| {
            ast.is_function(node)
                && ast
                    .child(node, "id")
                    .and_then(|id| ast.name(id))
                    .or_else(|| ast.parent(node).and_then(|parent| ast.name(parent)))
                    .as_deref()
                    == Some("stateChanged")
        }) {
            let owner = ast.parent(function).and_then(|parent| ast.parent(parent));
            let updater = owner.is_some_and(|owner| {
                ast.array(owner, "body")
                    .into_iter()
                    .chain(ast.array(owner, "properties"))
                    .any(|node| ast.name(node).as_deref() == Some("getRestartBlockers"))
            });
            // 文件下载等服务也有 stateChanged；只有更新器拥有重启阻塞检查。
            if !updater {
                continue;
            }
            for target in functions(context, id, function, &mut BTreeSet::new())? {
                related.insert(target.module.clone());
                if updater {
                    for node in target.ast.all(target.node, |node| {
                        target.ast.kind(node) == "AssignmentExpression"
                    }) {
                        if let Some(left) = target.ast.child(node, "left") {
                            changes.push((target.module.clone(), left));
                        }
                    }
                }
            }
        }
    }
    let mut subscriptions = BTreeMap::new();
    for id in related {
        let ast = context.ast(&id)?;
        for (name, value) in ast.exports() {
            let target = context.resolve(&id, value)?;
            let tree = &target.ast;
            let function = target.node;
            if !tree.is_function(function) {
                continue;
            }
            let params = tree.array(function, "params");
            if params.len() != 1 {
                continue;
            }
            let callback = params[0];
            let own = calls(tree, function)
                .into_iter()
                .filter(|node| {
                    tree.enclosing(*node, |node| tree.is_function(node)) == Some(function)
                })
                .collect::<Vec<_>>();
            let adds = own
                .iter()
                .copied()
                .filter(|node| {
                    tree.child(*node, "callee")
                        .and_then(|callee| tree.name(tree.unwrap(callee)))
                        .as_deref()
                        == Some("add")
                        && tree
                            .array(*node, "arguments")
                            .first()
                            .is_some_and(|argument| tree.same_binding(*argument, callback))
                })
                .collect::<Vec<_>>();
            if adds.len() != 1 {
                continue;
            }
            let Some(returned) = tree.return_value(function) else {
                continue;
            };
            let cleanup = context.resolve(&target.module, returned)?;
            if !cleanup.ast.is_function(cleanup.node) {
                continue;
            }
            let add_object = tree
                .child(adds[0], "callee")
                .map(|callee| tree.unwrap(callee))
                .and_then(|callee| tree.child(callee, "object"));
            let Some(add_object) = add_object else {
                continue;
            };
            let mut removes = 0;
            for node in calls(&cleanup.ast, cleanup.node) {
                let Some(callee) = cleanup
                    .ast
                    .child(node, "callee")
                    .map(|node| cleanup.ast.unwrap(node))
                else {
                    continue;
                };
                if cleanup.ast.name(callee).as_deref() != Some("delete") {
                    continue;
                }
                let Some(object) = cleanup.ast.child(callee, "object") else {
                    continue;
                };
                let Some(argument) = cleanup.ast.array(node, "arguments").first().copied() else {
                    continue;
                };
                if same(context, &target.module, add_object, &cleanup.module, object)?
                    && same(context, &target.module, callback, &cleanup.module, argument)?
                {
                    removes += 1;
                }
            }
            if removes != 1 {
                continue;
            }
            let snapshots = own
                .iter()
                .copied()
                .filter(|node| {
                    tree.child(*node, "callee")
                        .is_some_and(|callee| tree.same_binding(tree.unwrap(callee), callback))
                        && tree.array(*node, "arguments").len() == 1
                })
                .collect::<Vec<_>>();
            if snapshots.len() != 1 {
                continue;
            }
            let state = tree.array(snapshots[0], "arguments")[0];
            let state_value = context.resolve(&target.module, state)?;
            let shape = [
                "isUpdateReady",
                "lifecycleState",
                "downloadedUpdateAppBrand",
            ]
            .iter()
            .all(|name| {
                state_value
                    .ast
                    .property_value(state_value.node, name)
                    .is_some()
            });
            let mut changed = false;
            for (module, node) in &changes {
                if same(context, &target.module, state, module, *node)? {
                    changed = true;
                    break;
                }
            }
            if !shape && !changed {
                continue;
            }
            if let Some(reference) =
                descriptor(context, &target.module, function)?.or(descriptor(context, &id, value)?)
            {
                subscriptions.insert(format!("{}:{}", target.module, target.node), reference);
            } else {
                let _ = name;
            }
        }
    }
    let mut channels = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut pending = context.modules_containing("appBetaPreferencesByAccountId");
    while !pending.is_empty() {
        for id in &pending {
            seen.insert(id.clone());
            let ast = context.ast(id)?;
            for (_, value) in ast.exports() {
                let target = context.resolve(id, value)?;
                if target.ast.kind(target.node) != "CallExpression" {
                    continue;
                }
                let mut names = BTreeSet::new();
                for argument in target.ast.array(target.node, "arguments") {
                    for callback in
                        functions(context, &target.module, argument, &mut BTreeSet::new())?
                    {
                        for node in callback.ast.all(callback.node, |node| {
                            matches!(callback.ast.kind(node), "MemberExpression" | "Property")
                        }) {
                            if let Some(name) = callback.ast.name(node) {
                                names.insert(name);
                            }
                        }
                    }
                }
                if ["appBetaPreferencesByAccountId", "enabled", "isLoading"]
                    .iter()
                    .all(|name| names.contains(*name))
                {
                    if let Some(reference) = descriptor(context, &target.module, target.node)?
                        .or(descriptor(context, id, value)?)
                    {
                        channels.insert(format!("{}:{}", target.module, target.node), reference);
                    }
                }
            }
        }
        if !channels.is_empty() {
            break;
        }
        let previous = pending;
        pending = Vec::new();
        let importers = previous
            .iter()
            .flat_map(|dependency| context.importers(dependency))
            .collect::<BTreeSet<_>>();
        for id in catalog.modules.keys() {
            if seen.contains(id) || !importers.contains(id) {
                continue;
            }
            let ast = context.ast(id)?;
            let params = ast.array(ast.root, "params");
            if params.len() < 3 {
                continue;
            }
            if calls(&ast, ast.root).iter().any(|node| {
                ast.child(*node, "callee")
                    .is_some_and(|callee| ast.same_binding(ast.unwrap(callee), params[2]))
                    && ast
                        .array(*node, "arguments")
                        .first()
                        .and_then(|argument| ast.name(*argument))
                        .is_some_and(|name| previous.contains(&name))
            }) {
                pending.push(id.clone());
            }
        }
    }
    Ok(
        json!({"subscription":if subscriptions.len()==1{subscriptions.into_values().next()}else{None},"channel":if channels.len()==1{channels.into_values().next()}else{None}}),
    )
}

pub async fn read(cdp: &Connection, kind: &str) -> Result<Value, ApiError> {
    if !matches!(kind, "channel" | "subscription") {
        return Err(ApiError::new(
            400,
            "UPDATE_KIND",
            "Unsupported update binding",
        ));
    }
    let expression = format!(
        "(async()=>{{const findCodexRspackRequire={};return ({})({},null);}})()",
        include_str!("assets/find_require.js"),
        include_str!("assets/update_value.js"),
        json!(kind)
    );
    let result = cdp.evaluate(&expression, None).await?;
    if result["needsNativeUpdateBinding"] == true {
        return Err(ApiError::new(
            409,
            "UPDATE_BINDING",
            "Codex 原生更新接口尚未适配",
        ));
    }
    Ok(result)
}

pub async fn native_state(cdp: &Connection) -> Result<Value, ApiError> {
    let state = read(cdp, "subscription").await?;
    Ok(
        json!({"ready":state["isUpdateReady"]==true&&state["lifecycleState"]=="ready"&&matches!(state["downloadedUpdateAppBrand"].as_str(),Some("chatgpt"|"codex")),"downloading":state["lifecycleState"]=="downloading","progress":state["downloadProgressPercent"]}),
    )
}

#[cfg(test)]
mod tests {
    use super::super::adapters::{Module, Variant};
    use super::*;
    #[test]
    fn follows_native_subscription_and_channel_across_modules() {
        let sources=[
            ("feed","function(module,exports,load){load.d(exports,{watch:()=>subscribe,publish:()=>changed});const listeners=new Set();let state=null;function changed(value){state=value;for(const listener of listeners)listener(value)}function subscribe(callback){const cleanup=()=>listeners.delete(callback);listeners.add(callback);state!=null&&callback(state);return cleanup}}"),
            ("service","function(module,exports,load){const feed=load(\"feed\");const bridge={getRestartBlockers(){return []},stateChanged(next){feed.publish(next)}};load.d(exports,{bridge:()=>bridge})}"),
            ("policy","function(module,exports,load){function read(get){const settings={appBetaPreferencesByAccountId:\"beta\"};return {isLoading:false,enabled:get(settings.appBetaPreferencesByAccountId)}}load.d(exports,{read:()=>read})}"),
            ("channel","function(module,exports,load){load.d(exports,{selected:()=>choice});const policy=load(\"policy\");const choice=makeAtom(AppScope,({get})=>policy.read(get));}"),
            ("files","function(module,exports,load){let snapshot=null;const listeners=new Set();class Files{stateChanged(value){snapshot=value;for(const listener of listeners)listener(value)}}function watch(callback){listeners.add(callback);snapshot!=null&&callback(snapshot);return ()=>listeners.delete(callback)}load.d(exports,{watch:()=>watch})}"),
        ];
        let modules = sources
            .into_iter()
            .map(|(id, source)| {
                (
                    id.to_owned(),
                    Module {
                        source: source.into(),
                        exports: Vec::new(),
                        variants: vec![Variant {
                            source: source.into(),
                            chunks: Vec::new(),
                            asset_size: 0,
                        }],
                    },
                )
            })
            .collect();
        let mut catalog = Catalog {
            main_url_path: String::new(),
            main_source: String::new(),
            digest: String::new(),
            modules,
            unreadable: Vec::new(),
        };
        let result = build(&catalog, &Context::new(&catalog)).unwrap();
        assert_eq!(
            result,
            json!({"subscription":{"id":"feed","name":"watch"},"channel":{"id":"channel","name":"selected"}})
        );
        let source = &mut catalog.modules.get_mut("feed").unwrap().source;
        *source = source.replace("listeners.delete(callback)", "new Set().delete(callback)");
        assert!(build(&catalog, &Context::new(&catalog)).unwrap()["subscription"].is_null());
    }
}
