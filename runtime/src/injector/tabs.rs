use super::{
    features::Context,
    source_ast::{edits, unique, Ast, Edit, Id},
};
use crate::ApiError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Reference {
    module: String,
    node: Id,
}
fn error(label: &str) -> ApiError {
    ApiError::new(
        422,
        "NATIVE_TABS",
        format!("Native {label} missing or ambiguous"),
    )
}
fn reference(module: &str, node: Id) -> Reference {
    Reference {
        module: module.into(),
        node,
    }
}
fn one(values: Vec<Reference>, label: &str) -> Result<Reference, ApiError> {
    let values = values.into_iter().collect::<BTreeSet<_>>();
    if values.len() == 1 {
        Ok(values.into_iter().next().unwrap())
    } else {
        Err(error(label))
    }
}
fn member(ast: &Ast, node: Id, name: &str) -> bool {
    let node = ast.unwrap(node);
    ast.kind(node) == "MemberExpression" && ast.name(node).as_deref() == Some(name)
}
fn object(ast: &Ast, node: Id, names: &[&str]) -> bool {
    ast.kind(node) == "ObjectExpression"
        && names.iter().all(|name| ast.property(node, name).is_some())
}
fn function(ast: &Ast, node: Id) -> Option<Id> {
    ast.enclosing(node, |node| ast.is_function(node))
}
fn calls(ast: &Ast, node: Id) -> Vec<Id> {
    ast.all(node, |node| ast.kind(node) == "CallExpression")
}
fn own_calls(ast: &Ast, node: Id) -> Vec<Id> {
    calls(ast, node)
        .into_iter()
        .filter(|call| function(ast, *call) == Some(node))
        .collect()
}
fn literal(ast: &Ast, node: Id, value: &str) -> bool {
    !ast.all(node, |node| {
        ast.kind(node) == "Literal" && ast.field(node, "value") == value
    })
    .is_empty()
}
fn get(ast: &Ast, node: Id) -> bool {
    ast.kind(node) == "CallExpression"
        && ast
            .child(node, "callee")
            .is_some_and(|callee| member(ast, callee, "get"))
}
fn resolved(context: &Context, module: &str, node: Id) -> Result<Reference, ApiError> {
    let value = context.resolve(module, node)?;
    Ok(reference(&value.module, value.node))
}
fn same(context: &Context, left: &Reference, right: &Reference) -> Result<bool, ApiError> {
    if left.module == right.module {
        let ast = context.ast(&left.module)?;
        if ast.kind(ast.unwrap(left.node)) == "Identifier"
            && ast.kind(ast.unwrap(right.node)) == "Identifier"
            && (ast.same_binding(ast.unwrap(left.node), ast.unwrap(right.node))
                || ast.binding(ast.unwrap(left.node)).is_none()
                    && ast.name(left.node) == ast.name(right.node))
        {
            return Ok(true);
        }
    }
    let a = context.resolve(&left.module, left.node)?;
    let b = context.resolve(&right.module, right.node)?;
    Ok(a.module == b.module && (a.node == b.node || a.ast.same_binding(a.node, b.node)))
}
fn export(context: &Context, value: &Reference) -> Result<Value, ApiError> {
    let value = context.resolve(&value.module, value.node)?;
    let descriptor = context
        .export_of(&value.module, value.node)?
        .ok_or_else(|| error("thread export"))?;
    Ok(json!([descriptor["id"], descriptor["exportName"]]))
}
fn has_export(context: &Context, value: &Reference) -> Option<Value> {
    export(context, value).ok()
}
fn immediate(ast: &Ast, node: Id, function: Id) -> Option<Id> {
    let body = ast.child(function, "body")?;
    let mut node = node;
    loop {
        let parent = ast.parent(node)?;
        if parent == body {
            return Some(node);
        }
        node = parent;
    }
}

struct RouteChain {
    value: Reference,
    owner: Id,
    route: Id,
    route_id: Id,
    id_read: Id,
    thread_scope: Id,
}

pub fn rewrite(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if !["paneItems", "dataAttributes", "navigationState"]
        .iter()
        .any(|term| source.contains(term))
    {
        return Ok(None);
    }
    let ast = context.ast(module)?;
    let notifications = ast
        .all(ast.root, |node| {
            object(
                &ast,
                node,
                &["scope", "navigate", "thread", "navigationState"],
            )
        })
        .into_iter()
        .filter(|node| {
            ast.property_value(*node, "navigationState")
                .is_some_and(|state| member(&ast, state, "state"))
        })
        .filter(|node| {
            let request = ast
                .property_value(*node, "navigationState")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .unwrap();
            let owner = ast
                .binding(request)
                .and_then(|binding| function(&ast, ast.binding_declaration(binding)))
                .or_else(|| function(&ast, *node));
            owner.is_some_and(|owner| {
                ast.all(owner, |node| {
                    member(&ast, node, "notificationThread")
                        && ast
                            .child(node, "object")
                            .is_some_and(|object| ast.same_binding(object, request))
                })
                .len()
                    > 0
            })
        })
        .collect::<Vec<_>>();
    if !notifications.is_empty() {
        let notification = unique(
            notifications,
            "Native notification conversation context is ambiguous",
        )?;
        let root = ast.property_value(notification, "scope").unwrap();
        let navigate = ast.property_value(notification, "navigate").unwrap();
        let thread = ast.property_value(notification, "thread").unwrap();
        let request = ast
            .property_value(notification, "navigationState")
            .map(|node| ast.unwrap(node))
            .and_then(|node| ast.child(node, "object"))
            .unwrap();
        let owner = function(&ast, notification).ok_or_else(|| error("notification owner"))?;
        let mut navigation = Vec::new();
        for call in own_calls(&ast, owner) {
            let args = ast.array(call, "arguments");
            if args.len() < 2 {
                continue;
            }
            let Some(callee) = ast.child(call, "callee") else {
                continue;
            };
            if same(
                context,
                &reference(module, callee),
                &reference(module, navigate),
            )? && object(&ast, ast.value(args[1]), &["replace", "state"])
            {
                navigation.push(call);
            }
        }
        if navigation.is_empty() {
            return Err(error("notification conversation navigation"));
        }
        let guard=format!("{}&&null=={}.state&&globalThis.__codexPanelRspackTabsV1__.focusExisting({},{{conversationId:{}.threadId,hostId:{}.hostId}})",ast.text(thread),ast.text(request),ast.text(root),ast.text(thread),ast.text(thread));
        let changes = if navigation.len() == 1 {
            let call = navigation[0];
            vec![Edit {
                start: ast.start(call),
                end: ast.end(call),
                text: format!("({guard}||{})", ast.text(call)),
            }]
        } else {
            let entries = navigation
                .iter()
                .map(|node| immediate(&ast, *node, owner))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| error("notification control flow"))?;
            let start = entries.iter().map(|node| ast.start(*node)).min().unwrap();
            vec![Edit {
                start,
                end: start,
                text: format!("if({guard})return;"),
            }]
        };
        return Ok(Some(edits(source, changes)?));
    }
    let menus = ast.all(ast.root, |node| {
        ast.kind(node) == "ObjectPattern"
            && ["scope", "target", "surface", "paneItems"]
                .iter()
                .all(|name| ast.property(node, name).is_some())
            && function(&ast, node).is_some_and(|function| ast.boolean(function, "async"))
    });
    let sidebars = ast.all(ast.root, |node| {
        ast.kind(node) == "ObjectPattern"
            && ["conversationId", "isActive", "dataAttributes"]
                .iter()
                .all(|name| ast.property(node, name).is_some())
    });
    if menus.is_empty() && sidebars.is_empty() {
        return Ok(None);
    }
    let menu = if menus.is_empty() {
        None
    } else {
        Some(unique(menus, "Native thread menu is ambiguous")?)
    };
    let bindings = native_bindings(context)?;
    let target = &bindings["navigateThread"];
    let target_module = target[0]
        .as_str()
        .ok_or_else(|| error("local conversation navigation"))?;
    let target_ast = context.ast(target_module)?;
    let target_node = target_ast
        .exports()
        .get(target[1].as_str().unwrap_or(""))
        .copied()
        .ok_or_else(|| error("local conversation navigation"))?;
    let navigate_thread = reference(target_module, target_node);
    let start = ast
        .child(ast.root, "body")
        .map(|node| ast.start(node) + 1)
        .ok_or_else(|| error("factory body"))?;
    let mut changes=vec![Edit{start,end:start,text:format!("const panelThreadTabs=globalThis.__codexPanelRspackTabsV1__;panelThreadTabs.configure({bindings});panelThreadTabs.mark({});",json!(if menu.is_some(){"menu"}else{"sidebar"}))}];
    if let Some(menu) = menu {
        let owner = function(&ast, menu).ok_or_else(|| error("menu owner"))?;
        let panes = ast.property_value(menu, "paneItems").unwrap();
        let spread = unique(
            ast.all(owner, |node| {
                ast.kind(node) == "SpreadElement"
                    && !ast
                        .all(node, |node| {
                            ast.kind(node) == "Identifier" && ast.same_binding(node, panes)
                        })
                        .is_empty()
            })
            .into_iter()
            .filter(|node| {
                ast.parent(*node).is_some_and(|parent| {
                    ast.kind(parent) == "ArrayExpression"
                        || ast
                            .child(parent, "callee")
                            .is_some_and(|callee| member(&ast, callee, "push"))
                })
            })
            .collect(),
            "Native sidebar menu insertion changed",
        )?;
        changes.push(Edit {
            start: ast.start(spread),
            end: ast.start(spread),
            text: format!(
                "...await panelThreadTabs.menu({},{},{}),",
                ast.text(ast.property_value(menu, "scope").unwrap()),
                ast.text(ast.property_value(menu, "target").unwrap()),
                ast.text(ast.property_value(menu, "surface").unwrap())
            ),
        });
    } else {
        sidebar_edits(
            context,
            module,
            &ast,
            unique(sidebars, "Native sidebar component is ambiguous")?,
            &navigate_thread,
            &mut changes,
        )?;
    }
    Ok(Some(edits(source, changes)?))
}

fn native_bindings(context: &Context) -> Result<Value, ApiError> {
    if let Some(value) = context.metadata("tabs-bindings") {
        return Ok(value);
    }
    let mut openings = Vec::new();
    for id in context.modules_containing("orbit-activity") {
        let tree = context.ast(&id)?;
        for call in calls(&tree, tree.root) {
            let args = tree.array(call, "arguments");
            if !args
                .iter()
                .any(|node| tree.field(tree.unwrap(*node), "value") == "orbit-activity")
            {
                continue;
            }
            for argument in args {
                let options = tree.value(tree.unwrap(argument));
                if !object(&tree, options, &["open"]) {
                    continue;
                }
                let open = tree.property_value(options, "open").unwrap();
                let target = resolved(context, &id, open)?;
                if context.ast(&target.module)?.is_function(target.node) {
                    openings.push(target);
                }
            }
        }
    }
    let opening = one(openings, "conversation tab registration")?;
    let open_ast = context.ast(&opening.module)?;
    let open_call = unique(
        own_calls(&open_ast, opening.node)
            .into_iter()
            .filter(|call| {
                open_ast
                    .child(*call, "callee")
                    .is_some_and(|callee| member(&open_ast, callee, "openTab"))
            })
            .collect(),
        "Native conversation tab controller changed",
    )?;
    let tabs_object = open_ast
        .child(open_call, "callee")
        .map(|node| open_ast.unwrap(node))
        .and_then(|node| open_ast.child(node, "object"))
        .unwrap();
    let mut layouts = Vec::new();
    for id in context.modules_containing("onEnterFullWidth") {
        let tree = context.ast(&id)?;
        for call in calls(&tree, tree.root) {
            if !tree
                .child(call, "callee")
                .is_some_and(|callee| member(&tree, callee, "onEnterFullWidth"))
            {
                continue;
            }
            let Some(function) = function(&tree, call) else {
                continue;
            };
            let parameters = tree.array(function, "params");
            if parameters.len() == 3
                && literal(&tree, function, "chat")
                && !tree
                    .all(function, |node| {
                        member(&tree, node, "mode")
                            && tree
                                .child(node, "object")
                                .is_some_and(|object| tree.same_binding(object, parameters[2]))
                    })
                    .is_empty()
            {
                layouts.push(reference(&id, function));
            }
        }
    }
    let layout = one(layouts, "conversation layout")?;
    let layout_ast = context.ast(&layout.module)?;
    let layout_calls = own_calls(&layout_ast, layout.node);
    let root = layout_ast.array(layout.node, "params")[0];
    let mut primary = Vec::new();
    for call in &layout_calls {
        let args = layout_ast.array(*call, "arguments");
        let callee = layout_ast.child(*call, "callee").unwrap();
        if args.len() == 1
            && layout_ast.same_binding(args[0], root)
            && !member(&layout_ast, callee, "get")
            && !member(&layout_ast, callee, "set")
        {
            primary.push(resolved(context, &layout.module, callee)?);
        }
    }
    let mut focus_modules = BTreeSet::from([layout.module.clone()]);
    for target in &primary {
        focus_modules.insert(target.module.clone());
        if let Some(exported) = has_export(context, target) {
            for id in context.importers(exported[0].as_str().unwrap()) {
                focus_modules.insert(id);
            }
        }
    }
    let mut focuses = Vec::new();
    for id in focus_modules {
        let tree = context.ast(&id)?;
        for branch in tree.all(tree.root, |node| {
            matches!(tree.kind(node), "ConditionalExpression" | "IfStatement")
        }) {
            let Some(function) = function(&tree, branch) else {
                continue;
            };
            let params = tree.array(function, "params");
            let Some(test) = tree.child(branch, "test") else {
                continue;
            };
            if params.len() != 2
                || !literal(&tree, test, "chat")
                || tree
                    .all(test, |node| {
                        tree.kind(node) == "Identifier" && tree.same_binding(node, params[1])
                    })
                    .is_empty()
            {
                continue;
            }
            let (Some(a), Some(b)) = (
                tree.child(branch, "consequent"),
                tree.child(branch, "alternate"),
            ) else {
                continue;
            };
            let calls_a = calls(&tree, a)
                .into_iter()
                .filter(|call| self::function(&tree, *call) == Some(function))
                .collect::<Vec<_>>();
            let calls_b = calls(&tree, b)
                .into_iter()
                .filter(|call| self::function(&tree, *call) == Some(function))
                .collect::<Vec<_>>();
            if calls_a.len() != 1 || calls_b.len() != 1 {
                continue;
            }
            let first = calls_a[0];
            let second = calls_b[0];
            let single = if tree.array(first, "arguments").len() == 1 {
                Some(first)
            } else if tree.array(second, "arguments").len() == 1 {
                Some(second)
            } else {
                None
            };
            let pair = if tree.array(first, "arguments").len() == 2 {
                Some(first)
            } else if tree.array(second, "arguments").len() == 2 {
                Some(second)
            } else {
                None
            };
            let (Some(single), Some(pair)) = (single, pair) else {
                continue;
            };
            let one_args = tree.array(single, "arguments");
            let two_args = tree.array(pair, "arguments");
            if !tree.same_binding(one_args[0], params[0])
                || !tree.same_binding(two_args[0], params[0])
            {
                continue;
            }
            let tab = tree.unwrap(two_args[1]);
            if !tree.same_binding(tab, params[1])
                && !(member(&tree, tab, "tabId")
                    && tree
                        .child(tab, "object")
                        .is_some_and(|object| tree.same_binding(object, params[1])))
            {
                continue;
            }
            let callee = tree.child(single, "callee").unwrap();
            for target in &primary {
                if same(context, &reference(&id, callee), target)? {
                    focuses.push(reference(&id, function));
                    break;
                }
            }
        }
    }
    let focus = one(focuses, "conversation focus")?;
    let route = route_chain(context)?;
    let route_ast = context.ast(&route.value.module)?;
    let parsed_route = route_ast.value(route_ast.unwrap(route.route));
    if route_ast.kind(parsed_route) != "CallExpression" {
        return Err(error("active conversation route"));
    }
    let route_args = route_ast.array(parsed_route, "arguments");
    let input = route_args
        .first()
        .map(|node| route_ast.value(*node))
        .filter(|node| object(&route_ast, *node, &["pathname", "search", "routeTemplate"]))
        .ok_or_else(|| error("active conversation route input"))?;
    let pathname = route_ast
        .property_value(input, "pathname")
        .map(|node| route_ast.unwrap(node))
        .unwrap();
    let location = route_ast
        .child(pathname, "object")
        .map(|node| route_ast.value(node))
        .filter(|node| get(&route_ast, *node))
        .ok_or_else(|| error("active conversation location"))?;
    let route_scope_args = route_ast.array(route.value.node, "arguments");
    let key_call = route_ast.value(route_scope_args[1]);
    let mut key = reference(
        &route.value.module,
        route_ast
            .child(key_call, "callee")
            .ok_or_else(|| error("route key"))?,
    );
    if member(&route_ast, key.node, "getKey") {
        let descriptor = resolved(
            context,
            &route.value.module,
            route_ast
                .child(route_ast.unwrap(key.node), "object")
                .unwrap(),
        )?;
        let tree = context.ast(&descriptor.module)?;
        if tree.kind(descriptor.node) != "CallExpression" {
            return Err(error("route descriptor"));
        }
        let options = tree
            .array(descriptor.node, "arguments")
            .into_iter()
            .map(|node| tree.value(node))
            .find(|node| object(&tree, *node, &["key", "parent"]))
            .ok_or_else(|| error("route key"))?;
        key = reference(
            &descriptor.module,
            tree.property_value(options, "key").unwrap(),
        );
    }
    let blocked = blocked_scope(context, &route)?;
    let mapped = unique(
        own_calls(&route_ast, route.owner)
            .into_iter()
            .filter(|call| {
                let args = route_ast.array(*call, "arguments");
                get(&route_ast, *call)
                    && args.len() > 1
                    && member(&route_ast, args[1], "conversationId")
                    && route_ast
                        .child(route_ast.unwrap(args[1]), "object")
                        .is_some_and(|object| route_ast.same_binding(object, route.route))
            })
            .collect(),
        "Native ChatGPT conversation identity changed",
    )?;
    let chat_id = route_ast.array(mapped, "arguments")[0];
    let route_id = resolved(
        context,
        &route.value.module,
        route_ast.child(route.route_id, "callee").unwrap(),
    )?;
    let identity_ast = context.ast(&route_id.module)?;
    let local = unique(
        identity_ast.all(route_id.node, |node| {
            identity_ast.kind(node) == "SwitchCase"
                && identity_ast.child(node, "test").is_some_and(|node| {
                    identity_ast.field(identity_ast.unwrap(node), "value") == "local-thread"
                })
        }),
        "Native local thread identity changed",
    )?;
    let local_call = unique(
        calls(&identity_ast, local)
            .into_iter()
            .filter(|call| {
                identity_ast
                    .array(*call, "arguments")
                    .iter()
                    .any(|argument| member(&identity_ast, *argument, "conversationId"))
            })
            .collect(),
        "Native local thread identity changed",
    )?;
    let local_identity = resolved(
        context,
        &route_id.module,
        identity_ast.child(local_call, "callee").unwrap(),
    )?;
    let thread_id = resolved(
        context,
        &route.value.module,
        route_ast.array(route.id_read, "arguments")[0],
    )?;
    let thread_ref = export(context, &thread_id)?;
    let mut identity_modules = BTreeSet::from([thread_id.module.clone()]);
    for id in context.importers(thread_ref[0].as_str().unwrap()) {
        identity_modules.insert(id);
    }
    let mut mains = Vec::new();
    for id in identity_modules {
        let tree = context.ast(&id)?;
        for call in calls(&tree, tree.root)
            .into_iter()
            .filter(|call| get(&tree, *call))
        {
            let args = tree.array(call, "arguments");
            if args.len() < 2 {
                continue;
            }
            let inner = tree.value(tree.unwrap(args[1]));
            if tree.kind(inner) != "CallExpression" {
                continue;
            }
            if !same(context, &reference(&id, args[0]), &thread_id)?
                || !same(
                    context,
                    &reference(&id, tree.child(inner, "callee").unwrap()),
                    &local_identity,
                )?
            {
                continue;
            }
            let Some(function) = function(&tree, call) else {
                continue;
            };
            if tree.array(function, "params").len() == 2
                && tree
                    .return_value(function)
                    .is_some_and(|value| tree.value(value) == call)
                && has_export(context, &reference(&id, function)).is_some()
            {
                mains.push(reference(&id, function));
            }
        }
    }
    let main = one(mains, "main conversation identity")?;
    let layout_state = layout_state(context, &layout, &layout_calls)?;
    let full_width = full_width(context, &layout, &layout_calls, root)?;
    let (request_focus, current_focus, subscription) = composer_focus(context)?;
    let navigate = navigation(context, "navigate")?;
    let navigate_thread = navigation(context, "navigateToLocalConversation")?;
    let mut bindings = json!({"open":export(context,&opening)?,"tabs":export(context,&reference(&opening.module,tabs_object))?,
        "layout":export(context,&layout)?,"focus":export(context,&focus)?,"mainId":export(context,&main)?,"localId":export(context,&local_identity)?,
        "location":export(context,&reference(&route.value.module,route_ast.array(location,"arguments")[0]))?,
        "parseRoute":export(context,&reference(&route.value.module,route_ast.child(parsed_route,"callee").unwrap()))?,
        "threadScope":export(context,&reference(&route.value.module,route_ast.child(route.thread_scope,"callee").unwrap()))?,"threadId":thread_ref,
        "routeId":export(context,&route_id)?,"routeScope":export(context,&reference(&route.value.module,route_ast.child(route.value.node,"callee").unwrap()))?,"routeKey":export(context,&key)?,
        "blockedScope":export(context,&blocked)?,"chatGptId":export(context,&reference(&route.value.module,chat_id))?,"layoutState":export(context,&layout_state)?,
        "focusComposer":export(context,&request_focus)?,"currentFocus":export(context,&current_focus)?,"subscribeFocus":export(context,&subscription)?,"navigate":export(context,&navigate)?,"navigateThread":export(context,&navigate_thread)?});
    if let Some(full) = full_width {
        bindings["fullWidth"] = export(context, &full)?;
    }
    context.remember("tabs-bindings", bindings.clone());
    Ok(bindings)
}

fn route_chain(context: &Context) -> Result<RouteChain, ApiError> {
    let mut candidates = Vec::new();
    for id in context.modules_containing("getThreadScopeRouteId") {
        let ast = context.ast(&id)?;
        for route_id in calls(&ast, ast.root) {
            if !ast
                .child(route_id, "callee")
                .is_some_and(|callee| member(&ast, callee, "getThreadScopeRouteId"))
            {
                continue;
            }
            let Some(owner) = function(&ast, route_id) else {
                continue;
            };
            let Some(route) = ast.array(route_id, "arguments").first().copied() else {
                continue;
            };
            let mut kinds = BTreeSet::new();
            for node in ast.all(owner, |node| {
                ast.kind(node) == "BinaryExpression"
                    && matches!(ast.field(node, "operator").as_str(), Some("===" | "=="))
            }) {
                let (Some(left), Some(right)) = (ast.child(node, "left"), ast.child(node, "right"))
                else {
                    continue;
                };
                for (field, value) in [(left, right), (right, left)] {
                    if member(&ast, field, "routeKind")
                        && ast
                            .child(ast.unwrap(field), "object")
                            .is_some_and(|object| ast.same_binding(object, route))
                    {
                        if let Some(kind) = ast.field(ast.unwrap(value), "value").as_str() {
                            kinds.insert(kind.to_owned());
                        }
                    }
                }
            }
            if !["other", "home", "new-thread-panel"]
                .iter()
                .all(|kind| kinds.contains(*kind))
            {
                continue;
            }
            let scope_calls = own_calls(&ast, owner);
            for id_read in scope_calls.iter().copied().filter(|call| get(&ast, *call)) {
                let read_args = ast.array(id_read, "arguments");
                if read_args.len() < 2
                    || !same(
                        context,
                        &reference(&id, read_args[1]),
                        &reference(&id, route_id),
                    )?
                {
                    continue;
                }
                let object = ast
                    .child(id_read, "callee")
                    .map(|node| ast.unwrap(node))
                    .and_then(|node| ast.child(node, "object"))
                    .unwrap();
                for thread_scope in scope_calls.iter().copied().filter(|call| *call != id_read) {
                    let args = ast.array(thread_scope, "arguments");
                    if args.len() < 2
                        || !same(context, &reference(&id, args[0]), &reference(&id, object))?
                        || !same(context, &reference(&id, args[1]), &reference(&id, id_read))?
                    {
                        continue;
                    }
                    for route_scope in scope_calls
                        .iter()
                        .copied()
                        .filter(|call| *call != thread_scope)
                    {
                        let args = ast.array(route_scope, "arguments");
                        if args.len() < 2
                            || !same(
                                context,
                                &reference(&id, args[0]),
                                &reference(&id, thread_scope),
                            )?
                            || ast.kind(ast.value(ast.unwrap(args[1]))) != "CallExpression"
                        {
                            continue;
                        }
                        candidates.push(RouteChain {
                            value: reference(&id, route_scope),
                            owner,
                            route,
                            route_id,
                            id_read,
                            thread_scope,
                        });
                    }
                }
            }
        }
    }
    if candidates.len() != 1 {
        return Err(error("active conversation scope"));
    }
    Ok(candidates.remove(0))
}

fn blocked_scope(context: &Context, route: &RouteChain) -> Result<Reference, ApiError> {
    let ast = context.ast(&route.value.module)?;
    let mut reads = Vec::new();
    for call in own_calls(&ast, route.owner) {
        if !get(&ast, call) {
            continue;
        }
        let object = ast
            .child(call, "callee")
            .map(|node| ast.unwrap(node))
            .and_then(|node| ast.child(node, "object"))
            .unwrap();
        if same(
            context,
            &reference(&route.value.module, object),
            &route.value,
        )? {
            reads.push(call);
        }
    }
    if !reads.is_empty() {
        let call = unique(reads, "Native blocked route scope changed")?;
        let node = *ast
            .array(call, "arguments")
            .first()
            .ok_or_else(|| error("blocked route scope"))?;
        return Ok(reference(&route.value.module, node));
    }
    let scope = resolved(
        context,
        &route.value.module,
        ast.child(route.value.node, "callee").unwrap(),
    )?;
    let tree = context.ast(&scope.module)?;
    let mut descriptors = Vec::new();
    for call in calls(&tree, scope.node) {
        for argument in tree.array(call, "arguments") {
            let target = resolved(context, &scope.module, argument)?;
            let ast = context.ast(&target.module)?;
            if ast.kind(target.node) == "CallExpression"
                && ast
                    .array(target.node, "arguments")
                    .iter()
                    .any(|argument| ast.field(ast.unwrap(*argument), "value") == "RouteScope")
            {
                descriptors.push(target);
            }
        }
    }
    let descriptor = one(descriptors, "route scope descriptor")?;
    let tree = context.ast(&descriptor.module)?;
    let mut atoms = Vec::new();
    for call in calls(&tree, tree.root) {
        let args = tree.array(call, "arguments");
        let false_value = args.iter().any(|node| {
            let node = tree.unwrap(*node);
            tree.kind(node) == "Literal" && tree.field(node, "value") == false
                || tree.kind(node) == "UnaryExpression"
                    && tree.field(node, "operator") == "!"
                    && tree
                        .child(node, "argument")
                        .is_some_and(|node| tree.field(tree.unwrap(node), "value") == 1)
        });
        if !false_value {
            continue;
        }
        for argument in args {
            if same(
                context,
                &reference(&descriptor.module, argument),
                &descriptor,
            )? {
                atoms.push(reference(&descriptor.module, call));
                break;
            }
        }
    }
    one(atoms, "blocked route scope")
}

fn layout_state(
    context: &Context,
    layout: &Reference,
    layout_calls: &[Id],
) -> Result<Reference, ApiError> {
    let ast = context.ast(&layout.module)?;
    let atoms = layout_calls
        .iter()
        .filter(|call| {
            ast.child(**call, "callee")
                .is_some_and(|callee| member(&ast, callee, "get") || member(&ast, callee, "set"))
        })
        .filter_map(|call| ast.array(*call, "arguments").first().copied())
        .map(|node| reference(&layout.module, node))
        .collect::<Vec<_>>();
    let mut states = Vec::new();
    for id in context.modules_containing("contentSide") {
        let tree = context.ast(&id)?;
        for function in tree.all(tree.root, |node| tree.is_function(node)) {
            let reader = tree
                .array(function, "params")
                .iter()
                .find_map(|node| tree.property_value(tree.unwrap(*node), "get"));
            let Some(reader) = reader else {
                continue;
            };
            let full = tree.all(function, |node| {
                object(&tree, node, &["mode"])
                    && tree
                        .property_value(node, "mode")
                        .is_some_and(|mode| tree.field(tree.unwrap(mode), "value") == "full")
            });
            let split = tree.all(function, |node| {
                object(&tree, node, &["mode", "contentSide"])
                    && tree
                        .property_value(node, "mode")
                        .is_some_and(|mode| tree.field(tree.unwrap(mode), "value") == "split")
            });
            if full.is_empty() || split.is_empty() {
                continue;
            }
            let mut reads_atom = false;
            for call in own_calls(&tree, function) {
                let callee = tree.child(call, "callee").unwrap();
                if !same(context, &reference(&id, callee), &reference(&id, reader))? {
                    continue;
                }
                for argument in tree.array(call, "arguments") {
                    for atom in &atoms {
                        if same(context, &reference(&id, argument), atom)? {
                            reads_atom = true;
                        }
                    }
                }
            }
            if reads_atom {
                if let Some(constructor) = tree
                    .parent(function)
                    .filter(|node| tree.kind(*node) == "CallExpression")
                {
                    let value = reference(&id, constructor);
                    if has_export(context, &value).is_some() {
                        states.push(value);
                    }
                }
            }
        }
    }
    one(states, "conversation layout state")
}

fn full_width(
    context: &Context,
    layout: &Reference,
    layout_calls: &[Id],
    root: Id,
) -> Result<Option<Reference>, ApiError> {
    let ast = context.ast(&layout.module)?;
    let enter = unique(
        layout_calls
            .iter()
            .copied()
            .filter(|call| {
                ast.child(*call, "callee")
                    .is_some_and(|callee| member(&ast, callee, "onEnterFullWidth"))
            })
            .collect(),
        "Native full width transition changed",
    )?;
    let mut guards = Vec::new();
    let mut parent = ast.parent(enter);
    while let Some(node) = parent {
        if node == layout.node {
            break;
        }
        let key = match ast.kind(node) {
            "LogicalExpression" => Some("left"),
            "IfStatement" | "ConditionalExpression" => Some("test"),
            _ => None,
        };
        if let Some(key) = key {
            if let Some(guard) = ast.child(node, key) {
                guards.push(guard);
            }
        }
        parent = ast.parent(node);
    }
    let mut reads = Vec::new();
    for guard in guards {
        let mut expressions = vec![guard];
        expressions.extend(
            ast.all(guard, |node| ast.kind(node) == "Identifier")
                .iter()
                .map(|node| ast.value(*node)),
        );
        for expression in expressions {
            for call in calls(&ast, expression)
                .into_iter()
                .filter(|call| get(&ast, *call))
            {
                let object = ast
                    .child(call, "callee")
                    .map(|node| ast.unwrap(node))
                    .and_then(|node| ast.child(node, "object"))
                    .unwrap();
                if same(
                    context,
                    &reference(&layout.module, object),
                    &reference(&layout.module, root),
                )? {
                    if let Some(argument) = ast.array(call, "arguments").first() {
                        reads.push(resolved(context, &layout.module, *argument)?);
                    }
                }
            }
        }
    }
    if reads.is_empty() {
        Ok(None)
    } else {
        Ok(Some(one(reads, "full width state")?))
    }
}

fn composer_fields(ast: &Ast, node: Id) -> Vec<Id> {
    let node = ast.value(ast.unwrap(node));
    if member(ast, node, "composerId") {
        return vec![node];
    }
    let keys = match ast.kind(node) {
        "ConditionalExpression" => ["consequent", "alternate"],
        "LogicalExpression" => ["left", "right"],
        _ => return Vec::new(),
    };
    keys.iter()
        .filter_map(|key| ast.child(node, key))
        .flat_map(|node| composer_fields(ast, node))
        .collect()
}

fn composer_focus(context: &Context) -> Result<(Reference, Reference, Reference), ApiError> {
    let mut requests = Vec::new();
    for id in context.modules_containing("expiresTimeoutId") {
        let ast = context.ast(&id)?;
        for node in ast.all(ast.root, |node| {
            object(
                &ast,
                node,
                &["composerId", "expiresTimeoutId", "focusAnimationFrameId"],
            )
        }) {
            let Some(function) = function(&ast, node) else {
                continue;
            };
            let parameters = ast.array(function, "params");
            if parameters.len() == 1
                && ast
                    .property_value(node, "composerId")
                    .is_some_and(|composer| ast.same_binding(composer, parameters[0]))
                && has_export(context, &reference(&id, function)).is_some()
            {
                requests.push(reference(&id, function));
            }
        }
    }
    let request = one(requests, "composer focus request")?;
    let mut current = BTreeMap::new();
    for id in context.modules_containing("composerId") {
        let ast = context.ast(&id)?;
        for function in ast.all(ast.root, |node| {
            ast.is_function(node) && ast.array(node, "params").is_empty()
        }) {
            if has_export(context, &reference(&id, function)).is_none() {
                continue;
            }
            for returned in ast.all(function, |node| {
                ast.kind(node) == "ReturnStatement" && self::function(&ast, node) == Some(function)
            }) {
                let Some(argument) = ast.child(returned, "argument") else {
                    continue;
                };
                for field in composer_fields(&ast, argument) {
                    let read = ast
                        .child(ast.unwrap(field), "object")
                        .map(|node| ast.value(ast.unwrap(node)));
                    let Some(read) = read.filter(|node| get(&ast, *node)) else {
                        continue;
                    };
                    let registry = ast
                        .child(read, "callee")
                        .map(|node| ast.unwrap(node))
                        .and_then(|node| ast.child(node, "object"))
                        .unwrap();
                    current.insert(reference(&id, function), reference(&id, registry));
                }
            }
        }
    }
    if current.len() != 1 {
        return Err(error("current composer focus"));
    }
    let (current, registry) = current.into_iter().next().unwrap();
    let registry = resolved(context, &registry.module, registry.node)?;
    let mut registries = BTreeSet::from([registry.module.clone()]);
    if let Some(exported) = has_export(context, &registry) {
        for id in context.importers(exported[0].as_str().unwrap()) {
            registries.insert(id);
        }
    }
    let mut emitters = Vec::new();
    for id in registries {
        let ast = context.ast(&id)?;
        for setter in calls(&ast, ast.root) {
            let args = ast.array(setter, "arguments");
            if args.len() < 2
                || !ast
                    .child(setter, "callee")
                    .is_some_and(|callee| member(&ast, callee, "set"))
            {
                continue;
            }
            let object_id = ast
                .child(setter, "callee")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .unwrap();
            if !same(context, &reference(&id, object_id), &registry)?
                || !object(&ast, ast.value(args[1]), &["composerId"])
            {
                continue;
            }
            let Some(writer) = function(&ast, setter) else {
                continue;
            };
            for call in own_calls(&ast, writer) {
                let target = resolved(context, &id, ast.child(call, "callee").unwrap())?;
                let tree = context.ast(&target.module)?;
                if !tree.is_function(target.node) {
                    continue;
                }
                for node in tree.all(target.node, |node| tree.kind(node) == "ForOfStatement") {
                    let body = tree.child(node, "body").unwrap();
                    if calls(&tree, body)
                        .iter()
                        .any(|call| tree.array(*call, "arguments").is_empty())
                    {
                        if let Some(right) = tree.child(node, "right") {
                            emitters.push(resolved(context, &target.module, right)?);
                        }
                    }
                }
            }
        }
    }
    let listeners = one(emitters, "composer focus subscription")?;
    let mut modules = BTreeSet::from([listeners.module.clone()]);
    if let Some(exported) = has_export(context, &listeners) {
        for id in context.importers(exported[0].as_str().unwrap()) {
            modules.insert(id);
        }
    }
    let mut subscriptions = Vec::new();
    for id in modules {
        let ast = context.ast(&id)?;
        for add in calls(&ast, ast.root) {
            if !ast
                .child(add, "callee")
                .is_some_and(|callee| member(&ast, callee, "add"))
            {
                continue;
            }
            let object = ast
                .child(add, "callee")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .unwrap();
            if !same(context, &reference(&id, object), &listeners)? {
                continue;
            }
            let Some(function) = function(&ast, add) else {
                continue;
            };
            let params = ast.array(function, "params");
            let args = ast.array(add, "arguments");
            if params.len() != 1
                || args.is_empty()
                || !same(
                    context,
                    &reference(&id, args[0]),
                    &reference(&id, params[0]),
                )?
            {
                continue;
            }
            let mut cleanup = false;
            for call in calls(&ast, function) {
                if !ast
                    .child(call, "callee")
                    .is_some_and(|callee| member(&ast, callee, "delete"))
                {
                    continue;
                }
                let object = ast
                    .child(call, "callee")
                    .map(|node| ast.unwrap(node))
                    .and_then(|node| ast.child(node, "object"))
                    .unwrap();
                let args = ast.array(call, "arguments");
                if !args.is_empty()
                    && same(context, &reference(&id, object), &listeners)?
                    && same(
                        context,
                        &reference(&id, args[0]),
                        &reference(&id, params[0]),
                    )?
                {
                    cleanup = true;
                }
            }
            if cleanup && has_export(context, &reference(&id, function)).is_some() {
                subscriptions.push(reference(&id, function));
            }
        }
    }
    Ok((
        request,
        current,
        one(subscriptions, "composer focus subscription")?,
    ))
}

fn navigation(context: &Context, name: &str) -> Result<Reference, ApiError> {
    let mut candidates = Vec::new();
    for id in context.modules_containing(name) {
        let ast = context.ast(&id)?;
        for call in calls(&ast, ast.root) {
            if !ast
                .child(call, "callee")
                .is_some_and(|callee| member(&ast, callee, name))
            {
                continue;
            }
            let Some(function) = function(&ast, call) else {
                continue;
            };
            let params = ast.array(function, "params");
            if params.len() < 2 || ast.kind(params[1]) != "RestElement" {
                continue;
            }
            let receiver = ast
                .child(call, "callee")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .map(|node| ast.value(node));
            let Some(receiver) = receiver.filter(|node| get(&ast, *node)) else {
                continue;
            };
            let object = ast
                .child(receiver, "callee")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .unwrap();
            if same(context, &reference(&id, object), &reference(&id, params[0]))?
                && has_export(context, &reference(&id, function)).is_some()
            {
                candidates.push(reference(&id, function));
            }
        }
    }
    one(
        candidates,
        if name == "navigate" {
            "conversation navigation"
        } else {
            "local conversation navigation"
        },
    )
}

fn computation(ast: &Ast, node: Id, function: Id) -> Id {
    let body = ast.child(function, "body");
    let mut result = node;
    let mut parent = ast.parent(node);
    while let Some(node) = parent {
        if Some(node) == body || ast.is_function(node) {
            break;
        }
        if matches!(ast.kind(node), "ConditionalExpression" | "IfStatement") {
            return node;
        }
        if matches!(
            ast.kind(node),
            "VariableDeclarator" | "AssignmentExpression" | "ReturnStatement"
        ) {
            result = node;
        }
        parent = ast.parent(node);
    }
    result
}
fn trace(
    ast: &Ast,
    node: Id,
    function: Id,
    active: Id,
    roots: &mut BTreeSet<Id>,
    visited: &mut HashSet<usize>,
) {
    for identifier in ast.all(node, |node| ast.kind(node) == "Identifier") {
        let Some(binding) = ast.binding(identifier) else {
            continue;
        };
        if !ast.references(binding).contains(&identifier)
            || ast.same_binding(identifier, active)
            || !visited.insert(binding)
        {
            continue;
        }
        let mut definitions = ast.binding_init(binding).into_iter().collect::<Vec<_>>();
        for reference in ast.references(binding) {
            if let Some(parent) = ast.parent(*reference).filter(|node| {
                ast.kind(*node) == "AssignmentExpression"
                    && ast.child(*node, "left") == Some(*reference)
            }) {
                if let Some(right) = ast.child(parent, "right") {
                    definitions.push(right);
                }
            }
        }
        for definition in definitions {
            roots.insert(computation(ast, definition, function));
            trace(ast, definition, function, active, roots, visited);
        }
    }
}
fn sidebar_edits(
    context: &Context,
    module: &str,
    ast: &Ast,
    sidebar: Id,
    navigate: &Reference,
    changes: &mut Vec<Edit>,
) -> Result<(), ApiError> {
    let owner = function(ast, sidebar).ok_or_else(|| error("sidebar owner"))?;
    let presentation = unique(
        ast.all(owner, |node| {
            object(ast, node, &["isActive", "dataAttributes", "hostId"])
        }),
        "Native sidebar presentation changed",
    )?;
    let active = ast.property_value(presentation, "isActive").unwrap();
    let conversation = ast.property_value(sidebar, "conversationId").unwrap();
    let conversation = if ast.kind(conversation) == "AssignmentPattern" {
        ast.child(conversation, "left").unwrap()
    } else {
        conversation
    };
    let mut host = ast.property_value(presentation, "hostId").unwrap();
    loop {
        let next = ast.value(ast.unwrap(host));
        if ast.kind(next) == "LogicalExpression" && ast.field(next, "operator") == "??" {
            let right = ast.unwrap(ast.child(next, "right").unwrap());
            if ast.kind(right) == "UnaryExpression" && ast.field(right, "operator") == "void"
                || ast.kind(right) == "Identifier"
                    && ast.name(right).as_deref() == Some("undefined")
            {
                host = ast.child(next, "left").unwrap();
                continue;
            }
        }
        break;
    }
    let mut native_calls = Vec::new();
    for call in calls(ast, owner) {
        let args = ast.array(call, "arguments");
        if args.len() > 1
            && same(
                context,
                &reference(module, ast.child(call, "callee").unwrap()),
                navigate,
            )?
            && same(
                context,
                &reference(module, args[1]),
                &reference(module, conversation),
            )?
        {
            native_calls.push(call);
        }
    }
    let native = unique(
        native_calls,
        "Native sidebar conversation navigation changed",
    )?;
    let row_root = ast.array(native, "arguments")[0];
    let statements = [row_root, host, active, conversation]
        .iter()
        .filter_map(|node| ast.binding(ast.unwrap(*node)))
        .map(|binding| ast.binding_declaration(binding))
        .filter_map(|node| immediate(ast, node, owner))
        .collect::<Vec<_>>();
    let insertion = statements
        .iter()
        .map(|node| ast.end(*node))
        .max()
        .unwrap_or_else(|| ast.start(ast.child(owner, "body").unwrap()) + 1);
    let mut react = BTreeMap::new();
    for call in calls(ast, owner) {
        let callee = ast.child(call, "callee").unwrap();
        if member(ast, callee, "useSyncExternalStore") || member(ast, callee, "startTransition") {
            if let Some(object) = ast.child(ast.unwrap(callee), "object") {
                react.insert(ast.text(object).to_owned(), object);
            }
        }
    }
    if react.len() != 1 {
        return Err(error("sidebar React dependency"));
    }
    let react = react.into_values().next().unwrap();
    changes.push(Edit{start:insertion,end:insertion,text:format!(";const panelThreadRowActive=panelThreadTabs.isActive({},{{conversationId:{},hostId:{}??\"local\"}},{},(0,{}.useSyncExternalStore)(panelThreadTabs.subscribe,panelThreadTabs.getSnapshot,panelThreadTabs.getSnapshot));",ast.text(row_root),ast.text(conversation),ast.text(host),ast.text(active),ast.text(react))});
    let mut presentation_roots = BTreeSet::from([computation(ast, presentation, owner)]);
    let mut archive_roots = BTreeSet::new();
    let mut presentation_bindings = HashSet::new();
    let mut archive_bindings = HashSet::new();
    for key in ["isActive", "sidebarIndicators", "onClick", "onPointerClick"] {
        if let Some(input) = ast.property_value(presentation, key) {
            trace(
                ast,
                input,
                owner,
                active,
                &mut presentation_roots,
                &mut presentation_bindings,
            );
        }
    }
    for key in ["onArchive", "onArchiveRequest"] {
        if let Some(input) = ast.property_value(presentation, key) {
            if ast.is_function(ast.unwrap(input)) {
                archive_roots.insert(ast.unwrap(input));
            }
            trace(
                ast,
                input,
                owner,
                active,
                &mut archive_roots,
                &mut archive_bindings,
            );
        }
    }
    let within = |node: Id, roots: &BTreeSet<Id>| {
        roots
            .iter()
            .any(|root| ast.start(node) >= ast.start(*root) && ast.end(node) <= ast.end(*root))
    };
    if let Some(binding) = ast.binding(ast.unwrap(active)) {
        for reference in ast.references(binding) {
            if within(*reference, &presentation_roots) && !within(*reference, &archive_roots) {
                changes.push(Edit {
                    start: ast.start(*reference),
                    end: ast.end(*reference),
                    text: "panelThreadRowActive".into(),
                });
            }
        }
    }
    let attributes = ast.property_value(presentation, "dataAttributes").unwrap();
    changes.push(Edit{start:ast.start(attributes),end:ast.end(attributes),text:format!("{{...{},\"data-app-action-sidebar-thread-active\":String(panelThreadRowActive),\"data-app-action-sidebar-thread-selected\":String(panelThreadRowActive)}}",ast.text(attributes))});
    changes.push(Edit {
        start: ast.start(native),
        end: ast.end(native),
        text: format!(
            "(panelThreadTabs.focusExisting({},{{conversationId:{},hostId:{}??\"local\"}})||{})",
            ast.text(row_root),
            ast.text(conversation),
            ast.text(host),
            ast.text(native)
        ),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::adapters::{Catalog, Module, Variant};
    use super::*;
    fn fixtures() -> BTreeMap<String, String> {
        let file = include_str!("../../../test/codex-rspack-tabs.test.mjs");
        let start = file.find("const fixtures = {").unwrap();
        let stop = file[start..].find("\n};").unwrap() + start;
        file[start..stop]
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                let (key, value) = line.split_once(": '")?;
                Some((
                    key.to_owned(),
                    value
                        .strip_suffix("',")
                        .or_else(|| value.strip_suffix('\''))
                        .unwrap()
                        .replace("\\'", "'"),
                ))
            })
            .collect()
    }
    fn catalog(sources: &BTreeMap<String, String>) -> Catalog {
        let modules = sources
            .iter()
            .map(|(id, source)| {
                (
                    id.clone(),
                    Module {
                        source: source.clone(),
                        exports: Vec::new(),
                        variants: vec![Variant {
                            source: source.clone(),
                            chunks: Vec::new(),
                            asset_size: 0,
                        }],
                    },
                )
            })
            .collect();
        Catalog {
            main_url_path: String::new(),
            main_source: String::new(),
            digest: String::new(),
            modules,
            unreadable: Vec::new(),
        }
    }
    #[test]
    fn follows_native_tab_menu_sidebar_and_legacy_focus() {
        let mut sources = fixtures();
        for legacy in [false, true] {
            if legacy {
                let layout = sources.get_mut("layout").unwrap();
                *layout = layout.replace("Other.focus(e,t)", "Other.focus(e,t.tabId)");
            }
            let catalog = catalog(&sources);
            let context = Context::new(&catalog);
            let menu = rewrite(&sources["menu"], "menu", &context)
                .unwrap()
                .unwrap();
            assert!(menu.contains("await panelThreadTabs.menu(root,target,surface)"));
            assert!(menu.contains("\"focusComposer\":[\"focus\",\"te\"]"));
            assert!(menu.contains("\"focus\":[\"layout\",\"Mn\"]"));
            Ast::parse(&menu, true).unwrap();
            let sidebar = rewrite(&sources["sidebar"], "sidebar", &context)
                .unwrap()
                .unwrap();
            assert!(sidebar.contains("panelThreadTabs.focusExisting(root"));
            assert!(sidebar.contains("isActive:panelThreadRowActive"));
            Ast::parse(&sidebar, true).unwrap();
        }
    }
    #[test]
    fn resolves_route_descriptor_and_non_adjacent_scope() {
        let mut sources = fixtures();
        let scope = sources.get_mut("scope").unwrap();
        *scope = scope
            .replace(
                "let marker=\"open-page-on-right\"",
                "let marker=\"Library chat preview failed to open\"",
            )
            .replace("(0,Route.key)(r)", "Route.descriptor.getKey?.(r)")
            .replace("return null==v||v.get(Route.blocked)?null:v", "return v");
        let route = sources.get_mut("route").unwrap();
        *route = route.replace(
            "key:()=>key,blocked:()=>blocked",
            "hf:()=>key,Rj:()=>blocked",
        );
        let catalog = catalog(&sources);
        let context = Context::new(&catalog);
        let menu = rewrite(&sources["menu"], "menu", &context)
            .unwrap()
            .unwrap();
        assert!(menu.contains("\"routeKey\":[\"route\",\"hf\"]"));
        assert!(menu.contains("\"blockedScope\":[\"route\",\"Rj\"]"));
        Ast::parse(&menu, true).unwrap();
    }
    #[test]
    fn resolves_moved_focus_and_reordered_fields() {
        let mut sources = fixtures();
        let menu = sources.get_mut("menu").unwrap();
        *menu=menu.replace("scope:root,target:target,actions:actions,surface:surface,paneItems:panes","paneItems:panes,surface:surface,historyAccess:history,target:target,scope:root,actions:actions");
        let scope = sources.get_mut("scope").unwrap();
        *scope = scope
            .replace(
                "pathname:t.pathname,routeTemplate:t.pathname,search:t.search",
                "search:t.search,pathname:t.pathname,routeTemplate:t.pathname",
            )
            .replace(
                "))),v=(0,Route.scope)",
                ")));const unrelated=1;let v=(0,Route.scope)",
            );
        let layout = sources.get_mut("layout").unwrap();
        *layout = layout
            .replace(
                "function focus(e,t){\"chat\"===t?Primary.focus(e):Other.focus(e,t)}",
                "",
            )
            .replace(",Mn:()=>focus", "");
        sources.insert("detachedFocus".into(),"function(e,t,n){const Other=n(\"otherfocus\"),Primary=n(\"primary\");const focus=(root,view)=>{if(view!==\"chat\"){Other.focus(root,view)}else{Primary.focus(root)}};n.d(t,{moved:()=>focus})}".into());
        let catalog = catalog(&sources);
        let context = Context::new(&catalog);
        let menu = rewrite(&sources["menu"], "menu", &context)
            .unwrap()
            .unwrap();
        assert!(menu.contains("\"focus\":[\"detachedFocus\",\"moved\"]"));
        assert!(menu.contains("\"fullWidth\":[\"state\",\"fullWidth\"]"));
        Ast::parse(&menu, true).unwrap();
    }
    #[test]
    fn sidebar_focus_does_not_change_archive_scope() {
        let mut sources = fixtures();
        let source = sources["sidebar"]
            .replace("let result=", "const click=()=>{let result=")
            .replace(
                "React.startTransition(()=>{});let output=",
                "React.startTransition(()=>{});return result;};let output=",
            )
            .replace("};let output=", "};let archive=()=>highlighted,output=")
            .replace(
                "primaryAction:null,label:\"codex.localTaskRow.archiveTask\"",
                "primaryAction:click,onArchive:archive,archiveGroup:props.archiveGroup",
            )
            .replace("return output}}", "return output}t.row=row;}");
        sources.insert("sidebar".into(), source.clone());
        let catalog = catalog(&sources);
        let context = Context::new(&catalog);
        let rewritten = rewrite(&source, "sidebar", &context).unwrap().unwrap();
        let script = format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');let navigations=0;const runtime={{configure(){{}},mark(){{}},isActive:()=>true,subscribe:()=>()=>{{}},getSnapshot:()=>0,focusExisting:()=>true}},module={{exports:{{}}}},react={{useSyncExternalStore:(_,get)=>get(),startTransition:callback=>callback()}},load=id=>id==='navigation'?{{go(){{navigations++;return true}}}}:react;vm.runInNewContext('('+{}+')(module,module.exports,load)',{{module,load,__codexPanelRspackTabsV1__:runtime,provider:'local',summary:null,fallback:null,state:null,access:null}});const row=module.exports.row({{root:{{}},conversationId:'second',isActive:false,dataAttributes:{{}},archiveGroup:'archive'}});assert.equal(row.isActive,true);assert.equal(row.onArchive(),false);assert.equal(row.dataAttributes['data-app-action-sidebar-thread-selected'],'true');row.primaryAction();assert.equal(navigations,0);"#,
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
