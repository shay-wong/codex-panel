use super::{
    features::Context,
    source_ast::{edits, unique, Ast, Edit, Id},
};
use crate::ApiError;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const RUNTIME: &str = "globalThis.__codexPanelBottomTerminalV1__";
const MARKER: &str = "/* codex-panel-bottom-terminal */";

fn failure(message: &str) -> ApiError {
    ApiError::new(422, "NATIVE_TERMINAL", message)
}
fn need(value: Option<Id>, message: &str) -> Result<Id, ApiError> {
    value.ok_or_else(|| failure(message))
}
fn argument(ast: &Ast, node: Id, index: usize) -> Option<Id> {
    ast.array(node, "arguments").get(index).copied()
}
fn callee(ast: &Ast, node: Id) -> Option<Id> {
    ast.child(node, "callee").map(|node| ast.unwrap(node))
}
fn call_name(ast: &Ast, node: Id) -> Option<String> {
    ast.name(callee(ast, node)?)
}
fn function(ast: &Ast, node: Id) -> Option<Id> {
    ast.enclosing(node, |node| ast.is_function(node))
}
fn calls(ast: &Ast, within: Id) -> Vec<Id> {
    ast.all(within, |node| ast.kind(node) == "CallExpression")
}
fn literal(ast: &Ast, node: Id, value: &Value) -> bool {
    let node = ast.unwrap(node);
    if ast.kind(node) == "Literal" {
        return ast.field(node, "value") == value;
    }
    if ast.kind(node) == "UnaryExpression" && ast.field(node, "operator") == "!" {
        return ast.child(node, "argument").is_some_and(|argument| {
            ast.kind(argument) == "Literal"
                && value.as_bool().is_some_and(|expected| {
                    let value = ast.field(argument, "value");
                    let truthy = match value {
                        Value::Null => false,
                        Value::Bool(value) => *value,
                        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.),
                        Value::String(value) => !value.is_empty(),
                        _ => true,
                    };
                    !truthy == expected
                })
        });
    }
    false
}
fn member(ast: &Ast, node: Id, name: &str) -> bool {
    let node = ast.unwrap(node);
    ast.kind(node) == "MemberExpression" && ast.name(node).as_deref() == Some(name)
}
fn has_property(ast: &Ast, node: Id, names: &[&str]) -> bool {
    names.iter().all(|name| ast.property(node, name).is_some())
}
fn replace(ast: &Ast, node: Id, text: String) -> Edit {
    Edit {
        start: ast.start(node),
        end: ast.end(node),
        text,
    }
}
fn body_start(ast: &Ast, function: Id) -> Result<usize, ApiError> {
    let body = need(
        ast.child(function, "body"),
        "Native function body is unavailable",
    )?;
    if ast.kind(body) != "BlockStatement" {
        return Err(failure("Native terminal function body is not a block"));
    }
    Ok(ast
        .array(body, "body")
        .iter()
        .filter(|node| {
            ast.kind(**node) == "ExpressionStatement" && ast.field(**node, "directive").is_string()
        })
        .last()
        .map(|node| ast.end(*node))
        .unwrap_or(ast.start(body) + 1))
}
fn outer_binding(ast: &Ast, node: Id, function: Id) -> bool {
    ast.binding(ast.unwrap(node)).is_some_and(|binding| {
        let node = ast.binding_node(binding);
        ast.start(node) < ast.start(function) || ast.end(node) > ast.end(function)
    })
}
fn imported(context: &Context, module: &str, node: Id, require: &str) -> Result<String, ApiError> {
    let descriptor = context
        .export_of(module, node)?
        .ok_or_else(|| failure("Native bottom terminal dependency is unavailable"))?;
    Ok(format!(
        "{require}({})[{}]",
        descriptor["id"], descriptor["exportName"]
    ))
}
fn react(ast: &Ast, function: Id) -> Result<String, ApiError> {
    let names = ast
        .all(function, |node| {
            ast.kind(node) == "MemberExpression"
                && matches!(
                    ast.name(node).as_deref(),
                    Some("useState" | "use" | "useSyncExternalStore")
                )
        })
        .into_iter()
        .filter_map(|node| ast.child(node, "object"))
        .map(|node| ast.text(node).to_owned())
        .collect::<BTreeSet<_>>();
    if names.len() != 1 {
        return Err(failure("Native React hooks are unavailable"));
    }
    Ok(names.into_iter().next().unwrap())
}
fn legacy(context: &Context) -> Result<bool, ApiError> {
    if let Some(value) = context.metadata("terminal.legacy") {
        return Ok(value == true);
    }
    let mut found = false;
    for module in context.modules_containing("terminalBottomPanelOpen$") {
        if context
            .ast(&module)?
            .exports()
            .contains_key("terminalBottomPanelOpen$")
        {
            found = true;
            break;
        }
    }
    context.remember("terminal.legacy", json!(found));
    Ok(found)
}
fn legacy_terminal(ast: &Ast) -> Result<Option<String>, ApiError> {
    let exports = ast.exports();
    let Some(launch) = exports.get("terminalLaunchPanel$").copied() else {
        return Ok(None);
    };
    let signal = ast.value(launch);
    let callback = unique(
        ast.array(signal, "arguments")
            .into_iter()
            .filter(|node| ast.is_function(*node))
            .collect(),
        "Native terminal layout reader is unavailable",
    )?;
    let result = need(
        ast.return_value(callback),
        "Native terminal layout setting is unavailable",
    )?;
    let params = need(
        ast.array(callback, "params").first().copied(),
        "Native terminal layout scope is unavailable",
    )?;
    let scope = need(
        ast.property_value(params, "scope"),
        "Native terminal layout scope is unavailable",
    )?;
    let get = need(
        ast.property_value(params, "get"),
        "Native terminal layout scope is unavailable",
    )?;
    if ast.kind(scope) != "Identifier" || ast.kind(get) != "Identifier" {
        return Err(failure("Native terminal layout scope is unavailable"));
    }
    let visibility = |name: &str| -> Result<(Id, Id), ApiError> {
        let init = ast.value(need(
            exports.get(name).copied(),
            "Native terminal visibility reader is unavailable",
        )?);
        let read = unique(
            ast.array(init, "arguments")
                .into_iter()
                .filter(|node| ast.is_function(*node))
                .collect(),
            "Native terminal visibility reader is unavailable",
        )?;
        let params = need(
            ast.array(read, "params").first().copied(),
            "Native terminal visibility reader is unavailable",
        )?;
        let get = need(
            ast.property_value(params, "get"),
            "Native terminal visibility reader is unavailable",
        )?;
        let reads = calls(ast, read)
            .into_iter()
            .filter(|node| {
                callee(ast, *node).is_some_and(|node| ast.same_binding(node, get))
                    && argument(ast, *node, 0)
                        .is_some_and(|node| ast.kind(ast.unwrap(node)) == "MemberExpression")
            })
            .collect::<Vec<_>>();
        let active = unique(
            reads
                .iter()
                .copied()
                .filter(|node| {
                    argument(ast, *node, 0).is_some_and(|node| member(ast, node, "activeTab$"))
                })
                .collect(),
            "Native terminal controller is unavailable",
        )?;
        let open = unique(
            reads.into_iter().filter(|node| *node != active).collect(),
            "Native terminal visibility signal is unavailable",
        )?;
        Ok((
            need(
                ast.child(ast.unwrap(argument(ast, active, 0).unwrap()), "object"),
                "Native terminal controller is unavailable",
            )?,
            argument(ast, open, 0).unwrap(),
        ))
    };
    let (bottom_controller, bottom_open) = visibility("terminalBottomPanelOpen$")?;
    let (right_controller, right_open) = visibility("terminalRightPanelOpen$")?;
    let namespace = need(
        ast.child(callee(ast, signal).unwrap(), "object"),
        "Native terminal layout signal is unavailable",
    )?;
    let atom = unique(
        calls(ast, ast.root)
            .into_iter()
            .filter(|node| {
                ast.array(*node, "arguments").len() == 2
                    && argument(ast, *node, 1).is_some_and(|node| literal(ast, node, &json!(false)))
                    && callee(ast, *node)
                        .and_then(|node| ast.child(node, "object"))
                        .is_some_and(|node| ast.same_binding(node, namespace))
            })
            .collect(),
        "Native terminal layout signal is unavailable",
    )?;
    let show = unique(
        calls(
            ast,
            ast.value(need(
                exports.get("openTerminalBottomPanelWhenReady").copied(),
                "Native terminal show action is unavailable",
            )?),
        )
        .into_iter()
        .filter(|node| {
            argument(ast, *node, 1).is_some_and(|node| literal(ast, node, &json!("bottom")))
                && argument(ast, *node, 2)
                    .is_some_and(|node| ast.property(node, "allowEmpty").is_some())
        })
        .collect(),
        "Native terminal show action is unavailable",
    )?;
    let hide = unique(
        calls(
            ast,
            ast.value(need(
                exports.get("toggleTerminalBottomPanel").copied(),
                "Native terminal hide action is unavailable",
            )?),
        )
        .into_iter()
        .filter(|node| {
            ast.array(*node, "arguments").len() == 2
                && argument(ast, *node, 1).is_some_and(|node| literal(ast, node, &json!("bottom")))
        })
        .collect(),
        "Native terminal hide action is unavailable",
    )?;
    let terminal = need(
        exports.get("terminalTabType").copied(),
        "Native terminal session action is unavailable",
    )?;
    let open = ast.value(need(
        argument(ast, ast.value(terminal), 0).and_then(|node| ast.property_value(node, "open")),
        "Native terminal session action is unavailable",
    )?);
    let open_scope = need(
        ast.array(open, "params").first().copied(),
        "Native terminal session action is unavailable",
    )?;
    if !ast.is_function(open) || ast.kind(open_scope) != "Identifier" {
        return Err(failure("Native terminal session action is unavailable"));
    }
    // Preserve native capability gates; override only the default location preference.
    let target = if ast.kind(result) == "ConditionalExpression"
        && ast
            .child(result, "consequent")
            .is_some_and(|node| literal(ast, node, &json!("right")))
    {
        need(
            ast.child(result, "alternate"),
            "Native terminal layout setting is unavailable",
        )?
    } else {
        result
    };
    let configure = format!("{RUNTIME}.configureLegacy({{signal:{},routeScope:{},bottomController:{},rightController:{},bottomOpen$:{},rightOpen$:{},showPanel:(scope,panel)=>({})(scope,panel),hidePanel:(scope,panel)=>({})(scope,panel),getLayout:scope=>scope.get({}),isTerminalTab:tab=>tab.tabType.kind==={}.kind}});", ast.text(callee(ast, atom).unwrap()), ast.text(argument(ast, atom, 0).unwrap()), ast.text(bottom_controller), ast.text(right_controller), ast.text(bottom_open), ast.text(right_open), ast.text(callee(ast, show).unwrap()), ast.text(callee(ast, hide).unwrap()), ast.text(launch), ast.text(terminal));
    let open_start = body_start(ast, open)?;
    let factory_end = ast.end(ast.child(ast.root, "body").unwrap()) - 1;
    Ok(Some(edits(
        &ast.source,
        vec![
            replace(
                ast,
                target,
                format!(
                    "{RUNTIME}.legacyLayout({},{},{})",
                    ast.text(scope),
                    ast.text(get),
                    ast.text(target)
                ),
            ),
            Edit {
                start: open_start,
                end: open_start,
                text: format!("{RUNTIME}.trackScope({});", ast.text(open_scope)),
            },
            Edit {
                start: factory_end,
                end: factory_end,
                text: format!(";{configure}"),
            },
        ],
    )?))
}

fn controller(ast: &Ast) -> Result<Option<String>, ApiError> {
    let constructions = calls(ast, ast.root)
        .into_iter()
        .filter(|node| {
            callee(ast, *node).is_some_and(|node| ast.is_function(node))
                && ast.array(*node, "arguments").iter().any(|arg| {
                    ast.property_value(*arg, "panelId")
                        .is_some_and(|node| literal(ast, node, &json!("right")))
                        && has_property(ast, *arg, &["getPanelOpenSignal", "setPanelOpen"])
                })
        })
        .collect::<Vec<_>>();
    if constructions.is_empty() {
        return Ok(None);
    }
    let construction = unique(constructions, "Native panel controller is ambiguous")?;
    let builder = callee(ast, construction).unwrap();
    let options = need(
        ast.array(builder, "params").first().copied(),
        "Native panel controller parameters are unavailable",
    )?;
    let panel = need(
        ast.property_value(options, "panelId"),
        "Native panel controller parameters are unavailable",
    )?;
    let set_open = need(
        ast.property_value(options, "setPanelOpen"),
        "Native panel controller parameters are unavailable",
    )?;
    if ast.kind(panel) != "Identifier" || ast.kind(set_open) != "Identifier" {
        return Err(failure(
            "Native panel controller parameters are unavailable",
        ));
    }
    let contract = unique(
        ast.all(builder, |node| {
            ast.kind(node) == "ObjectExpression"
                && has_property(
                    ast,
                    node,
                    &["openTab", "activeTab$", "closeEmptyPanel", "panelId"],
                )
        }),
        "Native panel controller contract is unavailable",
    )?;
    let close_empty = ast.value(ast.property_value(contract, "closeEmptyPanel").unwrap());
    let reconcile = unique(
        calls(ast, close_empty)
            .into_iter()
            .filter(|node| {
                ast.array(*node, "arguments").len() == 2
                    && argument(ast, *node, 1)
                        .is_some_and(|node| ast.kind(ast.unwrap(node)) == "ArrayExpression")
                    && callee(ast, *node).is_some_and(|node| outer_binding(ast, node, builder))
            })
            .collect(),
        "Native panel reconciliation is unavailable",
    )?;
    let close_functions = ast
        .all(builder, |node| ast.is_function(node))
        .into_iter()
        .filter(|node| {
            calls(ast, *node).iter().any(|call| {
                callee(ast, *call).is_some_and(|node| ast.same_binding(node, set_open))
                    && argument(ast, *call, 1).is_some_and(|node| literal(ast, node, &json!(false)))
            }) && !ast
                .all(*node, |node| literal(ast, node, &json!("right-panel")))
                .is_empty()
        })
        .collect::<Vec<_>>();
    let close = unique(
        close_functions
            .iter()
            .copied()
            .filter(|node| {
                !close_functions.iter().any(|other| {
                    other != node
                        && ast.start(*other) > ast.start(*node)
                        && ast.end(*other) < ast.end(*node)
                })
            })
            .collect(),
        "Native panel close action is unavailable",
    )?;
    let activate = ast.value(ast.property_value(contract, "activateTab").unwrap());
    let focus_call = unique(
        calls(ast, activate)
            .into_iter()
            .filter(|call| {
                argument(ast, *call, 1)
                    .is_some_and(|node| literal(ast, node, &json!("right-panel")))
            })
            .collect(),
        "Native panel focus action is unavailable",
    )?;
    let focus_callee = callee(ast, focus_call).unwrap();
    let focus_namespace = need(
        ast.child(focus_callee, "object"),
        "Native panel focus action is unavailable",
    )?;
    let focus_read = unique(
        calls(ast, close)
            .into_iter()
            .filter(|call| {
                call_name(ast, *call).as_deref() == Some("get")
                    && argument(ast, *call, 0).is_some_and(|node| {
                        let node = ast.unwrap(node);
                        ast.kind(node) == "MemberExpression"
                            && ast
                                .child(node, "object")
                                .is_some_and(|node| ast.same_binding(node, focus_namespace))
                    })
                    && !ast
                        .all(close, |node| {
                            ast.kind(node) == "ConditionalExpression"
                                && ast.child(node, "test").is_some_and(|test| {
                                    !ast.all(test, |node| node == *call).is_empty()
                                })
                        })
                        .is_empty()
            })
            .collect(),
        "Native panel focus signal is unavailable",
    )?;
    let signal = unique(
        calls(ast, builder)
            .into_iter()
            .filter(|call| {
                let args = ast.array(*call, "arguments");
                args.len() == 2
                    && ast.kind(ast.unwrap(args[1])) == "ArrayExpression"
                    && ast.array(ast.unwrap(args[1]), "elements").is_empty()
                    && callee(ast, *call).is_some_and(|node| ast.kind(node) == "MemberExpression")
                    && ast
                        .parent(*call)
                        .filter(|node| ast.kind(*node) == "VariableDeclarator")
                        .and_then(|node| ast.child(node, "id"))
                        .is_some_and(|node| {
                            ast.text(node)
                                == ast.text(ast.property_value(contract, "tabIds$").unwrap())
                        })
            })
            .collect(),
        "Native panel signals are unavailable",
    )?;
    let right_options = need(
        ast.array(construction, "arguments").into_iter().find(|arg| {
            ast.property_value(*arg, "panelId")
                .is_some_and(|node| literal(ast, node, &json!("right")))
        }),
        "Native right panel options are unavailable",
    )?;
    let right_controller = need(
        ast.enclosing(construction, |node| ast.kind(node) == "VariableDeclarator")
            .and_then(|node| ast.child(node, "id")),
        "Native right panel controller is unavailable",
    )?;
    let mut panel_name = "panelTerminalPanelId".to_owned();
    while !ast
        .all(ast.root, |node| {
            ast.kind(node) == "Identifier" && ast.name(node).as_deref() == Some(panel_name.as_str())
        })
        .is_empty()
    {
        panel_name.push('_');
    }
    let guard = format!("{panel_name}===\"right\"");
    let start = body_start(ast, builder)?;
    let mut changes = vec![Edit {
        start,
        end: start,
        text: format!("const {panel_name}={};", ast.text(panel)),
    }];
    let mut gated = BTreeSet::new();
    for call in calls(ast, builder) {
        let target = callee(ast, call).unwrap();
        let right_reconcile = ast.same_binding(target, callee(ast, reconcile).unwrap());
        let right_layout = outer_binding(ast, target, builder)
            && argument(ast, call, 1).is_some_and(|node| literal(ast, node, &json!(true)))
            && (argument(ast, call, 2)
                .is_some_and(|node| ast.property(node, "notifyTab").is_some())
                || ast
                    .enclosing(call, |node| {
                        ast.kind(node) == "LogicalExpression"
                            && !ast
                                .all(node, |node| member(ast, node, "isWorkspaceHome"))
                                .is_empty()
                    })
                    .is_some());
        let right_write = call_name(ast, call).as_deref() == Some("set")
            && argument(ast, call, 0).is_some_and(|node| {
                let node = ast.unwrap(node);
                ast.kind(node) == "MemberExpression"
                    && ast
                        .child(node, "object")
                        .is_some_and(|node| ast.same_binding(node, focus_namespace))
            })
            && (function(ast, call) == Some(activate)
                || ast
                    .enclosing(call, |node| {
                        ast.kind(node) == "LogicalExpression"
                            && !ast
                                .all(node, |node| member(ast, node, "exitFullWidthOnClose"))
                                .is_empty()
                    })
                    .is_some());
        let right_analytics = ast.kind(target) == "MemberExpression"
            && ast
                .child(target, "object")
                .is_some_and(|node| !ast.same_binding(node, focus_namespace))
            && !ast
                .all(activate, |node| literal(ast, node, &json!("auto_open")))
                .is_empty()
            && function(ast, call) == Some(activate)
            && ast.array(call, "arguments").len() == 3
            && argument(ast, call, 1).is_some_and(|node| member(ast, node, "tabId"))
            && call_name(ast, call).as_deref() != Some("set");
        if (right_reconcile || right_layout || right_write || right_analytics) && gated.insert(call)
        {
            changes.push(replace(ast, call, format!("({guard}&&{})", ast.text(call))));
        }
    }
    for node in ast.all(builder, |node| literal(ast, node, &json!("right-panel"))) {
        if ast.start(node) >= ast.start(close) && ast.end(node) <= ast.end(close) {
            continue;
        }
        changes.push(replace(ast, node, format!("({panel_name}+\"-panel\")")));
    }
    let close_start = body_start(ast, close)?;
    let scope = need(
        ast.array(close, "params").first().copied(),
        "Native panel close scope is unavailable",
    )?;
    changes.push(Edit {
        start: close_start,
        end: close_start,
        text: format!(
            "if({panel_name}!==\"right\"){{{}({},false);return;}}",
            ast.text(set_open),
            ast.text(scope)
        ),
    });
    let patched_builder = edits(
        ast.text(builder),
        changes
            .into_iter()
            .map(|edit| Edit {
                start: edit.start - ast.start(builder),
                end: edit.end - ast.start(builder),
                text: edit.text,
            })
            .collect(),
    )?;
    let configure = format!("{RUNTIME}.configureController({{createController:panelTerminalCreateController,rightController:{},rightOpen$:({})(),rightSetOpen:{},signal:{},routeScope:{},focus:(scope,area)=>(0,{})(scope,area),getFocus:scope=>scope.get({})}});", ast.text(right_controller), ast.text(ast.property_value(right_options, "getPanelOpenSignal").unwrap()), ast.text(ast.property_value(right_options, "setPanelOpen").unwrap()), ast.text(callee(ast, signal).unwrap()), ast.text(argument(ast, signal, 0).unwrap()), ast.text(focus_callee), ast.text(argument(ast, focus_read, 0).unwrap()));
    let start = body_start(ast, ast.root)?;
    let end = ast.end(ast.child(ast.root, "body").unwrap()) - 1;
    Ok(Some(edits(
        &ast.source,
        vec![
            replace(
                ast,
                builder,
                format!("(panelTerminalCreateController={patched_builder})"),
            ),
            Edit {
                start,
                end: start,
                text: "let panelTerminalCreateController;".into(),
            },
            Edit {
                start: end,
                end,
                text: format!(";{configure}"),
            },
        ],
    )?))
}

fn terminal_api(ast: &Ast) -> Result<Option<String>, ApiError> {
    let exports = ast.exports();
    let (Some(toggle), Some(tab_type)) = (
        exports.get("toggleTerminalPanel"),
        exports.get("terminalTabType"),
    ) else {
        return Ok(None);
    };
    let mut changes = Vec::new();
    let toggle = ast.value(*toggle);
    if !ast.is_function(toggle) {
        return Err(failure("Native terminal action is unavailable"));
    }
    let toggle_scope = need(
        ast.array(toggle, "params").first().copied(),
        "Native terminal action scope is unavailable",
    )?;
    changes.push(replace(
        ast,
        ast.child(toggle, "body").unwrap(),
        format!("{{return {RUNTIME}.toggle({});}}", ast.text(toggle_scope)),
    ));
    let controller_members = ast.all(ast.root, |node| {
        ast.kind(node) == "MemberExpression"
            && matches!(
                ast.name(node).as_deref(),
                Some(
                    "tabs$" | "activeTab$" | "tabById$" | "updateTab" | "closeTab" | "activateTab"
                )
            )
    });
    let mut controllers = BTreeMap::new();
    for node in &controller_members {
        if let Some(object) = ast
            .child(*node, "object")
            .map(|node| ast.unwrap(node))
            .filter(|node| ast.kind(*node) == "MemberExpression")
        {
            controllers.insert(ast.text(object), object);
        }
    }
    let controller = unique(
        controllers
            .into_values()
            .filter(|base| {
                ["tabs$", "activeTab$"].iter().all(|name| {
                    controller_members.iter().any(|node| {
                        member(ast, *node, name)
                            && ast
                                .child(*node, "object")
                                .is_some_and(|node| ast.text(node) == ast.text(*base))
                    })
                })
            })
            .collect(),
        "Native terminal controller is unavailable",
    )?;
    for node in ast.all(ast.root, |node| {
        ast.kind(node) == "MemberExpression" && ast.text(node) == ast.text(controller)
    }) {
        changes.push(replace(ast, node, format!("{RUNTIME}.controller")));
    }
    let terminal = ast.value(*tab_type);
    let spec = need(
        argument(ast, terminal, 0),
        "Native terminal session action is unavailable",
    )?;
    let opener = need(
        ast.property_value(spec, "open"),
        "Native terminal session action is unavailable",
    )?;
    let open_function = ast.value(opener);
    let available = need(
        exports.get("canOpenTerminalPanelTab").copied(),
        "Native terminal availability action is unavailable",
    )?;
    if !ast.is_function(open_function) || !ast.is_function(ast.value(available)) {
        return Err(failure("Native terminal session action is unavailable"));
    }
    let calls = calls(ast, ast.root);
    let open_call = unique(
        calls
            .iter()
            .copied()
            .filter(|call| {
                ast.array(*call, "arguments").len() == 3
                    && argument(ast, *call, 2).is_some_and(|options| {
                        !ast.all(options, |node| {
                            ast.kind(node) == "Property"
                                && ast.name(node).as_deref() == Some("onUndoClose")
                        })
                        .is_empty()
                            && ast
                                .property_value(options, "target")
                                .is_some_and(|node| literal(ast, node, &json!("right")))
                    })
            })
            .collect(),
        "Native terminal tab creation is unavailable",
    )?;
    changes.push(replace(
        ast,
        ast.child(open_call, "callee").unwrap(),
        format!("{RUNTIME}.controller.openTab"),
    ));
    changes.push(replace(
        ast,
        ast.property_value(argument(ast, open_call, 2).unwrap(), "target")
            .unwrap(),
        format!("{RUNTIME}.panelId"),
    ));
    let derived = need(
        exports.get("terminalRightPanelOpen$").copied(),
        "Native terminal visibility signal is unavailable",
    )?;
    let derived = ast.value(derived);
    let visibility_callback = unique(
        ast.array(derived, "arguments")
            .into_iter()
            .filter(|node| ast.is_function(*node))
            .collect(),
        "Native terminal visibility reader is unavailable",
    )?;
    let scope_pattern = need(
        ast.array(visibility_callback, "params").first().copied(),
        "Native terminal visibility reader is unavailable",
    )?;
    let get = need(
        ast.property_value(scope_pattern, "get"),
        "Native terminal visibility reader is unavailable",
    )?;
    let scope_name = "panelTerminalScope";
    changes.push(Edit {
        start: ast.end(scope_pattern) - 1,
        end: ast.end(scope_pattern) - 1,
        text: format!(",scope:{scope_name}"),
    });
    let visibility_start = body_start(ast, visibility_callback)?;
    changes.push(Edit {
        start: visibility_start,
        end: visibility_start,
        text: format!("{RUNTIME}.readLayout({scope_name},{});", ast.text(get)),
    });
    let read = unique(
        calls
            .iter()
            .copied()
            .filter(|call| {
                ast.start(*call) >= ast.start(derived)
                    && ast.end(*call) <= ast.end(derived)
                    && ast.array(*call, "arguments").len() == 1
                    && callee(ast, *call).is_some_and(|node| ast.kind(node) == "Identifier")
                    && argument(ast, *call, 0).is_some_and(|node| {
                        ast.kind(ast.unwrap(node)) == "MemberExpression"
                            && !matches!(
                                ast.name(ast.unwrap(node)).as_deref(),
                                Some("activeTab$" | "tabs$")
                            )
                    })
            })
            .collect(),
        "Native terminal visibility signal is unavailable",
    )?;
    let right_signal = argument(ast, read, 0).unwrap();
    let signal_object = need(
        ast.child(right_signal, "object"),
        "Native terminal visibility signal is unavailable",
    )?;
    for node in ast.all(ast.root, |node| {
        ast.kind(node) == "MemberExpression"
            && ast.name(node) == ast.name(right_signal)
            && ast
                .child(node, "object")
                .is_some_and(|node| ast.same_binding(node, signal_object))
    }) {
        changes.push(replace(ast, node, format!("{RUNTIME}.open$")));
    }
    let show_calls = calls
        .iter()
        .copied()
        .filter(|call| {
            ast.array(*call, "arguments").len() == 2
                && argument(ast, *call, 1).is_some_and(|node| literal(ast, node, &json!("right")))
        })
        .collect::<Vec<_>>();
    let show = unique(
        show_calls
            .iter()
            .copied()
            .filter(|call| {
                ast.enclosing(*call, |node| {
                    ast.kind(node) == "LogicalExpression"
                        && !ast
                            .all(node, |node| member(ast, node, "activateTab"))
                            .is_empty()
                })
                .is_some()
            })
            .collect(),
        "Native terminal panel action is unavailable",
    )?;
    let show_object = need(
        ast.child(callee(ast, show).unwrap(), "object"),
        "Native terminal panel action is unavailable",
    )?;
    changes.push(replace(
        ast,
        ast.child(show, "callee").unwrap(),
        format!("{RUNTIME}.show"),
    ));
    changes.push(replace(ast, argument(ast, show, 1).unwrap(), "true".into()));
    for call in show_calls.into_iter().filter(|call| *call != show) {
        if callee(ast, call)
            .and_then(|callee| ast.child(callee, "object"))
            .is_some_and(|node| ast.same_binding(node, show_object))
        {
            changes.push(replace(
                ast,
                ast.child(call, "callee").unwrap(),
                format!("{RUNTIME}.setOpen"),
            ));
            changes.push(replace(
                ast,
                argument(ast, call, 1).unwrap(),
                "false".into(),
            ));
        }
    }
    for node in ast.all(ast.root, |node| literal(ast, node, &json!("right-panel"))) {
        changes.push(replace(ast, node, format!("({RUNTIME}.panelId+\"-panel\")")));
    }
    for template in ast.all(ast.root, |node| {
        ast.kind(node) == "TemplateLiteral"
            && ast.array(node, "quasis").iter().any(|part| {
                ast.field(*part, "value")["cooked"]
                    .as_str()
                    .is_some_and(|value| {
                        value.contains("data-app-shell-tab-panel-controller=\"right\"")
                    })
            })
    }) {
        changes.push(replace(
            ast,
            template,
            ast.text(template).replace(
                "data-app-shell-tab-panel-controller=\"right\"",
                &format!("data-app-shell-tab-panel-controller=\"${{{RUNTIME}.panelId}}\""),
            ),
        ));
    }
    let visibility = calls
        .iter()
        .copied()
        .filter(|call| {
            call_name(ast, *call).as_deref() == Some("get")
                && argument(ast, *call, 0).is_some_and(|node| {
                    ast.kind(ast.unwrap(node)) == "MemberExpression"
                        && ast.name(node) == ast.name(right_signal)
                        && ast
                            .child(node, "object")
                            .is_some_and(|node| ast.same_binding(node, signal_object))
                })
        })
        .collect::<Vec<_>>();
    let focus_actions = calls
        .iter()
        .copied()
        .filter(|call| {
            callee(ast, *call).is_some_and(|node| ast.kind(node) == "MemberExpression")
                && ast.array(*call, "arguments").len() == 1
                && ast
                    .parent(*call)
                    .filter(|node| ast.kind(*node) == "SequenceExpression")
                    .and_then(|node| ast.array(node, "expressions").last().copied())
                    .is_some_and(|node| literal(ast, node, &json!(true)))
                && ast
                    .enclosing(*call, |node| {
                        ast.kind(node) == "LogicalExpression"
                            && !ast
                                .all(node, |node| {
                                    ast.kind(node) == "CallExpression"
                                        && call_name(ast, node).as_deref() == Some("querySelector")
                                        && argument(ast, node, 0).is_some_and(|node| {
                                            literal(ast, node, &json!("textarea"))
                                        })
                                })
                                .is_empty()
                    })
                    .is_some()
        })
        .collect::<Vec<_>>();
    for action in focus_actions {
        let scope_read = unique(
            visibility
                .iter()
                .copied()
                .filter(|call| function(ast, *call) == function(ast, action))
                .collect(),
            "Native terminal focus scope is unavailable",
        )?;
        let scope = need(
            ast.child(callee(ast, scope_read).unwrap(), "object"),
            "Native terminal focus scope is unavailable",
        )?;
        changes.push(replace(
            ast,
            action,
            format!("{RUNTIME}.focus({})", ast.text(scope)),
        ));
    }
    let open_start = body_start(ast, open_function)?;
    let open_scope = need(
        ast.array(open_function, "params").first().copied(),
        "Native terminal session scope is unavailable",
    )?;
    changes.push(Edit {
        start: open_start,
        end: open_start,
        text: format!("{RUNTIME}.trackScope({});", ast.text(open_scope)),
    });
    let end = ast.end(ast.child(ast.root, "body").unwrap()) - 1;
    changes.push(Edit {
        start: end,
        end,
        text: format!(
            ";{RUNTIME}.registerLaunch({},{},{});",
            ast.text(ast.child(open_function, "id").unwrap_or(opener)),
            ast.text(available),
            ast.text(*tab_type)
        ),
    });
    Ok(Some(edits(&ast.source, changes)?))
}

fn renderer(ast: &Ast) -> Result<Option<String>, ApiError> {
    let candidates = calls(ast, ast.root)
        .into_iter()
        .filter(|call| {
            argument(ast, *call, 1).is_some_and(|props| {
                ast.property_value(props, "target")
                    .is_some_and(|node| literal(ast, node, &json!("content")))
                    && ast
                        .property_value(props, "children")
                        .map(|node| ast.unwrap(node))
                        .filter(|node| ast.kind(*node) == "CallExpression")
                        .and_then(|node| argument(ast, node, 1))
                        .is_some_and(|node| has_property(ast, node, &["controller", "tabs"]))
            })
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    let call = unique(candidates, "Native terminal tab header is ambiguous")?;
    let inner = ast.unwrap(
        ast.property_value(argument(ast, call, 1).unwrap(), "children")
            .unwrap(),
    );
    let controller = ast
        .property_value(argument(ast, inner, 1).unwrap(), "controller")
        .unwrap();
    let component = need(
        argument(ast, call, 0),
        "Native terminal tab header is unavailable",
    )?;
    Ok(Some(edits(
        &ast.source,
        vec![replace(
            ast,
            component,
            format!(
                "({}.panelId===\"bottom\"?{RUNTIME}.Header:{})",
                ast.text(controller),
                ast.text(component)
            ),
        )],
    )?))
}

fn shell(ast: &Ast, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    let shells = ast.all(ast.root, |node| {
        ast.kind(node) == "ObjectExpression"
            && has_property(ast, node, &["Root", "MainContentLayout", "RightPanelTabs"])
    });
    if shells.is_empty() {
        return Ok(None);
    }
    let shell = unique(shells, "Native workspace shell is ambiguous")?;
    let memo = ast.value(ast.property_value(shell, "Root").unwrap());
    let root = if ast.is_function(memo) {
        memo
    } else {
        need(
            ast.array(memo, "arguments")
                .into_iter()
                .find(|node| ast.is_function(*node)),
            "Native workspace root is unavailable",
        )?
    };
    let workspace_prop = unique(
        ast.all(root, |node| {
            ast.kind(node) == "Property"
                && ast.name(node).as_deref() == Some("data-app-shell-workspace-layout")
        }),
        "Native workspace layout is unavailable",
    )?;
    let workspace = need(
        ast.enclosing(workspace_prop, |node| ast.kind(node) == "CallExpression"),
        "Native workspace layout is unavailable",
    )?;
    let declaration = need(
        ast.enclosing(workspace, |node| {
            matches!(
                ast.kind(node),
                "AssignmentExpression" | "VariableDeclarator"
            )
        }),
        "Native workspace layout is unavailable",
    )?;
    let workspace_value = need(
        ast.child(
            declaration,
            if ast.kind(declaration) == "AssignmentExpression" {
                "left"
            } else {
                "id"
            },
        ),
        "Native workspace layout is unavailable",
    )?;
    let container = unique(
        calls(ast, root)
            .into_iter()
            .filter(|call| {
                argument(ast, *call, 1)
                    .and_then(|node| ast.property_value(node, "children"))
                    .map(|node| ast.unwrap(node))
                    .is_some_and(|children| {
                        ast.kind(children) == "ArrayExpression"
                            && ast.array(children, "elements").len() == 2
                            && ast
                                .array(children, "elements")
                                .iter()
                                .any(|node| ast.same_binding(*node, workspace_value))
                    })
            })
            .collect(),
        "Native workspace container is unavailable",
    )?;
    let renderer_call = unique(
        calls(ast, ast.root)
            .into_iter()
            .filter(|call| {
                argument(ast, *call, 1).is_some_and(|node| {
                    has_property(ast, node, &["controller", "showTabStrip", "headerHeight"])
                })
            })
            .collect(),
        "Native panel renderer is unavailable",
    )?;
    let native_renderer = need(
        argument(ast, renderer_call, 0),
        "Native panel renderer is unavailable",
    )?;
    let native_controller = ast.unwrap(
        ast.property_value(argument(ast, renderer_call, 1).unwrap(), "controller")
            .unwrap(),
    );
    let controller_namespace = need(
        ast.child(native_controller, "object"),
        "Native panel renderer is unavailable",
    )?;
    let scope_reads = calls(ast, root)
        .into_iter()
        .filter(|call| {
            call_name(ast, *call).as_deref() == Some("get")
                && argument(ast, *call, 0).is_some_and(|node| {
                    member(ast, node, "activeTab$")
                        && ast
                            .child(ast.unwrap(node), "object")
                            .is_some_and(|node| ast.text(node) == ast.text(native_controller))
                })
        })
        .collect::<Vec<_>>();
    let scopes = scope_reads
        .into_iter()
        .filter_map(|read| ast.child(callee(ast, read)?, "object"))
        .map(|scope| (ast.binding(scope), scope))
        .collect::<BTreeMap<_, _>>();
    let scope = unique(
        scopes.into_values().collect(),
        "Native workspace scope is unavailable",
    )?;
    let signal_read = unique(
        calls(ast, ast.root)
            .into_iter()
            .filter(|call| {
                ast.array(*call, "arguments").len() == 1
                    && argument(ast, *call, 0).is_some_and(|node| {
                        member(ast, node, "singleTab$")
                            && ast
                                .child(ast.unwrap(node), "object")
                                .and_then(|node| ast.child(node, "object"))
                                .is_some_and(|node| ast.same_binding(node, controller_namespace))
                    })
            })
            .collect(),
        "Native reactive panel reader is unavailable",
    )?;
    let mut resizers = BTreeMap::new();
    for dependency in context.modules_containing("getCurrentSize") {
        let tree = context.ast(&dependency)?;
        let pane = tree
            .all(tree.root, |node| tree.is_function(node))
            .into_iter()
            .find(|function| {
                ["width", "getCurrentSize"].iter().all(|name| {
                    !tree
                        .all(*function, |node| {
                            tree.kind(node) == "Property"
                                && tree.name(node).as_deref() == Some(name)
                        })
                        .is_empty()
                })
            });
        let Some(pane) = pane else {
            continue;
        };
        for call in calls(&tree, pane) {
            if !argument(&tree, call, 1)
                .is_some_and(|node| has_property(&tree, node, &["currentSize", "getCurrentSize"]))
            {
                continue;
            }
            let Some(component) = argument(&tree, call, 0) else {
                continue;
            };
            let Some(descriptor) = context.export_of(&dependency, component)? else {
                continue;
            };
            let resolved = context.resolve(&dependency, component)?;
            let function = resolved.ast.value(resolved.node);
            if resolved.ast.is_function(function)
                && !resolved
                    .ast
                    .all(function, |node| {
                        resolved.ast.kind(node) == "Property"
                            && resolved.ast.name(node).as_deref() == Some("edge")
                    })
                    .is_empty()
                && resolved.ast.source.contains("ArrowUp")
            {
                resizers.insert(descriptor.to_string(), (dependency.clone(), component));
            }
        }
    }
    if resizers.len() != 1 {
        return Err(failure("Native vertical panel resizer is unavailable"));
    }
    let (_, (resizer_module, resizer_node)) = resizers.into_iter().next().unwrap();
    let require_name = "panelTerminalRequire";
    let configure = format!(
        "{RUNTIME}.configureView({{React:{},Renderer:{},Resizer:{},useSignal:{}}});",
        react(ast, root)?,
        imported(context, module, native_renderer, require_name)?,
        imported(context, &resizer_module, resizer_node, require_name)?,
        ast.text(callee(ast, signal_read).unwrap())
    );
    let start = body_start(ast, ast.root)?;
    let root_start = body_start(ast, root)?;
    let require = need(
        ast.array(ast.root, "params").get(2).copied(),
        "Native terminal module loader is unavailable",
    )?;
    Ok(Some(edits(
        &ast.source,
        vec![
            Edit {
                start,
                end: start,
                text: format!("const {require_name}={};", ast.text(require)),
            },
            Edit {
                start: root_start,
                end: root_start,
                text: configure,
            },
            replace(
                ast,
                container,
                format!(
                    "{RUNTIME}.wrap({},{})",
                    ast.text(scope),
                    ast.text(container)
                ),
            ),
        ],
    )?))
}

pub fn rewrite(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if source.contains(MARKER) {
        return Ok(None);
    }
    if legacy(context)? {
        if !source.contains("terminalLaunchPanel$") || !source.contains("toggleTerminalPanel") {
            return Ok(None);
        }
        let ast = context.ast(module)?;
        return Ok(legacy_terminal(&ast)?.map(|source| format!("{source}{MARKER}")));
    }
    if ![
        "toggleTerminalPanel",
        "panelId",
        "MainContentLayout",
        "data-app-shell-tab-panel-controller",
    ]
    .iter()
    .any(|term| source.contains(term))
    {
        return Ok(None);
    }
    let ast = context.ast(module)?;
    let changed = if let Some(changed) = terminal_api(&ast)? {
        Some(changed)
    } else if let Some(changed) = controller(&ast)? {
        Some(changed)
    } else if let Some(changed) = shell(&ast, module, context)? {
        Some(changed)
    } else {
        renderer(&ast)?
    };
    Ok(changed.map(|source| format!("{source}{MARKER}")))
}
