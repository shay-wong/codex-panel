use super::{
    adapters::Catalog,
    source_ast::{edits, unique, Ast, Edit, Id},
};
use crate::ApiError;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashSet},
    sync::Arc,
};

pub struct Context<'a> {
    catalog: &'a Catalog,
    asts: RefCell<BTreeMap<String, Arc<Ast>>>,
    overridden: RefCell<BTreeSet<String>>,
    metadata: RefCell<BTreeMap<String, Value>>,
    pub selected: RefCell<BTreeSet<String>>,
}
pub struct Resolved {
    pub module: String,
    pub ast: Arc<Ast>,
    pub node: Id,
}
impl<'a> Context<'a> {
    pub fn new(catalog: &'a Catalog) -> Self {
        Self {
            catalog,
            asts: RefCell::new(BTreeMap::new()),
            overridden: RefCell::new(BTreeSet::new()),
            metadata: RefCell::new(BTreeMap::new()),
            selected: RefCell::new(BTreeSet::new()),
        }
    }
    pub fn metadata(&self, key: &str) -> Option<Value> {
        self.metadata.borrow().get(key).cloned()
    }
    pub fn remember(&self, key: &str, value: Value) {
        self.metadata.borrow_mut().insert(key.into(), value);
    }
    fn cache(&self, module: &str, ast: Arc<Ast>) {
        let mut cache = self.asts.borrow_mut();
        cache.insert(module.into(), ast);
        // 绑定追踪只需当前依赖；限制常驻 AST，避免大型第三方模块累积占满内存。
        while cache.values().map(|ast| ast.source.len()).sum::<usize>() > 4 * 1024 * 1024
            && cache.len() > 1
        {
            let pinned = self.overridden.borrow();
            // 正在参与本次绑定追踪的树不能逐出，否则递归解析会同时复制同一个大模块。
            let Some(key) = cache
                .iter()
                .find(|(key, ast)| {
                    key.as_str() != module && !pinned.contains(*key) && Arc::strong_count(ast) == 1
                })
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            cache.remove(&key);
        }
    }
    pub fn set_source(&self, module: &str, source: &str) -> Result<(), ApiError> {
        if self
            .asts
            .borrow()
            .get(module)
            .is_some_and(|ast| ast.source == source)
        {
            return Ok(());
        }
        // 默认模块按需解析；遍历九项能力时不为未命中的模块重复创建整棵 AST。
        if self
            .catalog
            .modules
            .get(module)
            .is_some_and(|entry| entry.source == source)
        {
            if self.overridden.borrow_mut().remove(module) {
                self.metadata.borrow_mut().clear();
            }
            self.asts.borrow_mut().remove(module);
            return Ok(());
        }
        self.metadata.borrow_mut().clear();
        self.overridden.borrow_mut().insert(module.into());
        self.cache(module, Arc::new(Ast::parse(source, true)?));
        Ok(())
    }
    pub fn ast(&self, module: &str) -> Result<Arc<Ast>, ApiError> {
        if let Some(ast) = self.asts.borrow().get(module) {
            return Ok(ast.clone());
        }
        let source = &self
            .catalog
            .modules
            .get(module)
            .ok_or_else(|| failure("Native dependency is unavailable"))?
            .source;
        #[cfg(test)]
        if source.len() > 200_000 && std::env::var_os("CODEX_PANEL_AST_TRACE").is_some() {
            eprintln!("large module: {module}; {} bytes", source.len());
        }
        let ast = Arc::new(Ast::parse(source, true)?);
        self.cache(module, ast.clone());
        Ok(ast)
    }
    fn imported(&self, ast: &Ast, id: Id) -> Option<(String, String)> {
        let mut id = ast.unwrap(id);
        if ast.kind(id) == "Identifier" {
            id = ast.value(id);
        }
        if ast.kind(id) != "MemberExpression" {
            return None;
        }
        let namespace = ast.value(ast.child(id, "object")?);
        if ast.kind(namespace) != "CallExpression" {
            return None;
        }
        let args = ast.array(namespace, "arguments");
        let params = ast.array(ast.root, "params");
        if args.len() != 1 || params.len() < 3 || ast.kind(args[0]) != "Literal" {
            return None;
        }
        let callee = ast.value(ast.child(namespace, "callee")?);
        if !ast.same_binding(callee, params[2]) {
            return None;
        }
        Some((ast.name(args[0])?, ast.name(id)?))
    }
    pub fn resolve(&self, module: &str, id: Id) -> Result<Resolved, ApiError> {
        let mut module = module.to_owned();
        let mut ast = self.ast(&module)?;
        let mut node = id;
        let mut seen = HashSet::new();
        loop {
            if let Some((dependency, name)) = self.imported(&ast, node) {
                if !seen.insert(format!("{dependency}:{name}")) {
                    break;
                }
                if self.catalog.modules.contains_key(&dependency) {
                    let target = self.ast(&dependency)?;
                    let exported = target.exports().get(&name).copied();
                    if let Some(value) = exported {
                        module = dependency;
                        ast = target;
                        node = value;
                        continue;
                    }
                }
            }
            let value = ast.value(node);
            if value == node {
                break;
            }
            node = value;
        }
        Ok(Resolved { module, ast, node })
    }
    pub fn export_of(&self, module: &str, id: Id) -> Result<Option<Value>, ApiError> {
        let ast = self.ast(module)?;
        if let Some((dependency, name)) = self.imported(&ast, id) {
            if !self.catalog.modules.contains_key(&dependency) {
                return Ok(None);
            }
            self.selected.borrow_mut().insert(dependency.clone());
            return Ok(Some(json!({"id":dependency,"exportName":name})));
        }
        if let Some(name) = ast.export_name(id) {
            self.selected.borrow_mut().insert(module.into());
            return Ok(Some(json!({"id":module,"exportName":name})));
        }
        let resolved = self.resolve(module, id)?;
        if resolved.module != module {
            return self.export_of(&resolved.module, resolved.node);
        }
        Ok(None)
    }
    pub fn modules_containing(&self, term: &str) -> Vec<String> {
        self.catalog
            .modules
            .iter()
            .filter(|(_, module)| module.source.contains(term))
            .map(|(id, _)| id.clone())
            .collect()
    }
    pub fn importers(&self, module: &str) -> Vec<String> {
        let value = regex::escape(module);
        let pattern =
            regex::Regex::new(&format!(r#"\(\s*(?:"{value}"|'{value}'|{value})\s*\)"#)).unwrap();
        self.catalog
            .modules
            .iter()
            .filter(|(_, entry)| pattern.is_match(&entry.source))
            .map(|(id, _)| id.clone())
            .collect()
    }
}

fn failure(message: &str) -> ApiError {
    ApiError::new(422, "NATIVE_CONTRACT", message)
}
fn declaration(ast: &Ast, id: Id) -> Option<Id> {
    ast.enclosing(id, |node| ast.kind(node) == "VariableDeclarator")
}
fn function(ast: &Ast, id: Id) -> Option<Id> {
    ast.enclosing(id, |node| ast.is_function(node))
}
fn call(ast: &Ast, id: Id) -> bool {
    ast.kind(ast.unwrap(id)) == "CallExpression"
}
fn body_start(ast: &Ast, id: Id) -> Result<usize, ApiError> {
    let body = ast
        .child(id, "body")
        .ok_or_else(|| failure("Native function body is unavailable"))?;
    if ast.kind(body) != "BlockStatement" {
        return Err(failure("Native function body is not a block"));
    }
    Ok(ast
        .array(body, "body")
        .iter()
        .filter(|id| {
            ast.kind(**id) == "ExpressionStatement" && ast.field(**id, "directive").is_string()
        })
        .last()
        .map(|id| ast.end(*id))
        .unwrap_or(ast.start(body) + 1))
}
fn react(ast: &Ast, id: Id) -> Result<String, ApiError> {
    let names = ast
        .all(id, |node| {
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
fn after_declaration(ast: &Ast, id: Id, text: String) -> Result<Edit, ApiError> {
    let parent = ast
        .parent(id)
        .filter(|node| ast.kind(*node) == "VariableDeclaration")
        .ok_or_else(|| failure("Native hook declaration is unsupported"))?;
    let declarations = ast.array(parent, "declarations");
    let index = declarations.iter().position(|node| *node == id).unwrap();
    if let Some(next) = declarations.get(index + 1) {
        Ok(Edit {
            start: ast.end(id),
            end: ast.start(*next),
            text: format!(
                ";{text}{} ",
                ast.field(parent, "kind").as_str().unwrap_or("const")
            ),
        })
    } else {
        Ok(Edit {
            start: ast.end(parent),
            end: ast.end(parent),
            text: format!(
                "{}{text}",
                if ast.text(parent).ends_with(';') {
                    ""
                } else {
                    ";"
                }
            ),
        })
    }
}

fn native_provider(context: &Context) -> Result<[Value; 3], ApiError> {
    if let Some(value) = context.metadata("provider") {
        return Ok([value[0].clone(), value[1].clone(), value[2].clone()]);
    }
    let mut candidates = BTreeMap::<String, [Value; 3]>::new();
    for module in context.modules_containing("model_provider") {
        let ast = context.ast(&module)?;
        for field in ast.all(ast.root, |node| {
            ast.kind(node) == "MemberExpression"
                && ast.name(node).as_deref() == Some("model_provider")
        }) {
            let Some(object) = ast.child(field, "object") else {
                continue;
            };
            let Some(binding) = ast.binding(object) else {
                continue;
            };
            let Some(data) = declaration(&ast, ast.binding_node(binding)) else {
                continue;
            };
            let (Some(pattern), Some(config)) = (ast.child(data, "id"), ast.child(data, "init"))
            else {
                continue;
            };
            if ast.kind(pattern) != "ObjectPattern"
                || ast.property(pattern, "data").is_none()
                || !call(&ast, config)
            {
                continue;
            }
            let config = ast.unwrap(config);
            let config_args = ast.array(config, "arguments");
            if config_args.len() != 2
                || ast
                    .child(config, "callee")
                    .and_then(|node| ast.name(ast.unwrap(node)))
                    .as_deref()
                    != Some("get")
            {
                continue;
            }
            let target = ast.value(config_args[1]);
            if ast.kind(target) != "ObjectExpression" {
                continue;
            }
            let (Some(cwd), Some(host)) = (
                ast.property_value(target, "cwd"),
                ast.property_value(target, "hostId"),
            ) else {
                continue;
            };
            let Some(scope_decl) = ast
                .binding(cwd)
                .and_then(|binding| declaration(&ast, ast.binding_node(binding)))
            else {
                continue;
            };
            let (Some(scope_pattern), Some(scope_call)) =
                (ast.child(scope_decl, "id"), ast.child(scope_decl, "init"))
            else {
                continue;
            };
            if ast.kind(scope_pattern) != "ObjectPattern"
                || ast.property(scope_pattern, "cwd").is_none()
                || ast.property(scope_pattern, "hostId").is_none()
                || !call(&ast, scope_call)
            {
                continue;
            }
            if !ast
                .property_value(scope_pattern, "hostId")
                .is_some_and(|value| ast.same_binding(value, host))
            {
                continue;
            }
            let scope_call = ast.unwrap(scope_call);
            let scope_args = ast.array(scope_call, "arguments");
            if scope_args.len() != 2 {
                continue;
            }
            let Some(scope_callee) = ast.child(scope_call, "callee").map(|node| ast.unwrap(node))
            else {
                continue;
            };
            if ast.name(scope_callee).as_deref() != Some("get") {
                continue;
            }
            let Some(mut chain) = ast.enclosing(field, |node| {
                ast.kind(node) == "LogicalExpression" && ast.field(node, "operator") == "??"
            }) else {
                continue;
            };
            while let Some(parent) = ast.parent(chain).filter(|node| {
                ast.kind(*node) == "LogicalExpression" && ast.field(*node, "operator") == "??"
            }) {
                chain = parent;
            }
            let calls = ast.all(chain, |node| {
                if ast.kind(node) != "CallExpression" {
                    return false;
                }
                let args = ast.array(node, "arguments");
                let Some(callee) = ast.child(node, "callee").map(|node| ast.unwrap(node)) else {
                    return false;
                };
                args.len() == 2
                    && ast.name(callee).as_deref() == Some("get")
                    && ast.same_binding(args[1], scope_args[1])
                    && ast
                        .child(callee, "object")
                        .zip(ast.child(scope_callee, "object"))
                        .is_some_and(|(left, right)| ast.same_binding(left, right))
            });
            if calls.len() != 1 {
                continue;
            }
            let provider = ast.array(calls[0], "arguments")[0];
            let descriptors =
                [scope_args[0], config_args[0], provider].map(|id| context.export_of(&module, id));
            let [Ok(Some(target)), Ok(Some(config)), Ok(Some(provider))] = descriptors else {
                continue;
            };
            let values = [target, config, provider];
            candidates.insert(json!(values).to_string(), values);
        }
    }
    if candidates.len() != 1 {
        return Err(failure("Native custom-provider reader is unavailable"));
    }
    let value = candidates.into_values().next().unwrap();
    context.remember("provider", json!(value));
    Ok(value)
}

fn binding_values(ast: &Ast, id: Id, seen: &mut HashSet<Id>) -> Vec<Id> {
    let id = ast.unwrap(id);
    if !seen.insert(id) {
        return Vec::new();
    }
    if ast.kind(id) != "Identifier" {
        return vec![id];
    }
    let Some(binding) = ast.binding(id) else {
        return vec![id];
    };
    let mut values = ast.binding_init(binding).into_iter().collect::<Vec<_>>();
    for reference in ast.references(binding) {
        if let Some(parent) = ast.parent(*reference).filter(|parent| {
            ast.kind(*parent) == "AssignmentExpression"
                && ast.field(*parent, "operator") == "="
                && ast.child(*parent, "left") == Some(*reference)
        }) {
            if let Some(right) = ast.child(parent, "right") {
                values.push(right);
            }
        }
    }
    values
        .into_iter()
        .flat_map(|id| binding_values(ast, id, seen))
        .collect()
}
fn dependencies(ast: &Ast, roots: Vec<Id>) -> HashSet<Id> {
    let mut visited = HashSet::new();
    let mut bindings = HashSet::new();
    let mut pending = roots;
    while let Some(expression) = pending.pop() {
        if visited.contains(&expression) {
            continue;
        }
        for node in ast.all(expression, |_| true) {
            visited.insert(node);
            let Some(binding) = ast.binding(node) else {
                continue;
            };
            if !bindings.insert(binding) {
                continue;
            }
            if let Some(init) = ast.binding_init(binding) {
                pending.push(init);
            }
            for reference in ast.references(binding) {
                if let Some(parent) = ast.parent(*reference).filter(|parent| {
                    ast.kind(*parent) == "AssignmentExpression"
                        && ast.field(*parent, "operator") == "="
                        && ast.child(*parent, "left") == Some(*reference)
                }) {
                    if let Some(right) = ast.child(parent, "right") {
                        pending.push(right);
                    }
                }
            }
        }
    }
    visited
}
fn quota_signal(context: &Context, module: &str, id: Id) -> Result<bool, ApiError> {
    let resolved = context.resolve(module, id)?;
    let ast = &resolved.ast;
    let node = ast.value(resolved.node);
    if !call(ast, node) {
        return Ok(false);
    }
    for callback in ast
        .array(node, "arguments")
        .into_iter()
        .filter(|node| ast.is_function(*node))
    {
        let Some(returned) = ast.return_value(callback) else {
            continue;
        };
        for array in ast.all(returned, |node| ast.kind(node) == "ArrayExpression") {
            let reasons = ast
                .array(array, "elements")
                .into_iter()
                .map(|mut node| {
                    node = ast.unwrap(node);
                    while ast.kind(node) == "LogicalExpression" {
                        if let Some(right) = ast.child(node, "right") {
                            node = ast.unwrap(right);
                        } else {
                            break;
                        }
                    }
                    ast.field(node, "value").clone()
                })
                .collect::<Vec<_>>();
            if reasons.len() == 2
                && reasons.contains(&json!("reserve-limit"))
                && reasons.contains(&json!("usage-limit"))
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn quota(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if !source.contains("data-codex-composer-root") || source.contains("panelQuotaEnabled") {
        return Ok(None);
    }
    let ast = context.ast(module)?;
    let roots = ast.all(ast.root, |node| {
        ast.kind(node) == "Property"
            && ast.name(node).as_deref() == Some("data-codex-composer-root")
    });
    if roots.is_empty() {
        return Ok(None);
    }
    let mut functions = roots
        .iter()
        .filter_map(|node| function(&ast, *node))
        .collect::<Vec<_>>();
    functions.sort();
    functions.dedup();
    let candidates = functions
        .into_iter()
        .filter_map(|function| {
            let submitted = ast.all(function, |node| {
                ast.kind(node) == "Property"
                    && matches!(
                        ast.name(node).as_deref(),
                        Some("submitDisabledReasons" | "submitDisabled")
                    )
                    && self::function(&ast, node) == Some(function)
            });
            (!submitted.is_empty()).then_some((function, submitted))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() != 1 {
        return Err(failure("Native composer is ambiguous"));
    }
    let (function, submitted) = &candidates[0];
    let active = dependencies(
        &ast,
        submitted
            .iter()
            .filter_map(|node| ast.child(*node, "value"))
            .collect(),
    );
    let calls = ast.all(*function, |node| {
        ast.kind(node) == "CallExpression" && active.contains(&node)
    });
    let mut signals = Vec::new();
    for call in &calls {
        let args = ast.array(*call, "arguments");
        if args.len() == 2 && quota_signal(context, module, args[0])? {
            signals.push(*call);
        }
    }
    let reasons = ast.all(*function, |node| {
        active.contains(&node)
            && ast.kind(node) == "LogicalExpression"
            && ast.child(node, "right").is_some_and(|node| {
                matches!(
                    ast.field(ast.unwrap(node), "value").as_str(),
                    Some("reserve-limit" | "usage-limit")
                )
            })
    });
    let (host, host_quota, work_quota) = if !signals.is_empty() {
        let read = unique(signals.clone(), "Native quota signal read is ambiguous")?;
        (ast.array(read, "arguments")[1], None, None)
    } else if !reasons.is_empty() {
        let reserve = unique(
            reasons
                .iter()
                .copied()
                .filter(|node| {
                    ast.child(*node, "right").is_some_and(|right| {
                        ast.field(ast.unwrap(right), "value") == "reserve-limit"
                    })
                })
                .collect(),
            "Native reserve quota reason is ambiguous",
        )?;
        let left = ast.child(reserve, "left").unwrap();
        let read = unique(
            binding_values(&ast, left, &mut HashSet::new())
                .into_iter()
                .filter(|node| call(&ast, *node))
                .collect(),
            "Native reserve quota reader is unavailable",
        )?;
        let args = ast.array(read, "arguments");
        if args.len() < 2 {
            return Err(failure("Native reserve quota reader is unavailable"));
        }
        (args[1], Some(read), None)
    } else {
        let work = unique(
            calls
                .iter()
                .copied()
                .filter(|node| {
                    let args = ast.array(*node, "arguments");
                    args.len() == 1
                        && !ast
                            .all(args[0], |node| {
                                ast.kind(node) == "BinaryExpression"
                                    && matches!(
                                        ast.field(node, "operator").as_str(),
                                        Some("===" | "==")
                                    )
                                    && ["left", "right"].iter().any(|key| {
                                        ast.child(node, key).is_some_and(|node| {
                                            ast.field(ast.unwrap(node), "value") == "local"
                                        })
                                    })
                            })
                            .is_empty()
                })
                .collect(),
            "Native composer quota gate is unsupported",
        )?;
        let local = unique(
            ast.all(ast.array(work, "arguments")[0], |node| {
                ast.kind(node) == "BinaryExpression"
                    && ["left", "right"].iter().any(|key| {
                        ast.child(node, key)
                            .is_some_and(|node| ast.field(ast.unwrap(node), "value") == "local")
                    })
            }),
            "Native quota host is ambiguous",
        )?;
        let left = ast.child(local, "left").unwrap();
        let host = if ast.field(ast.unwrap(left), "value") == "local" {
            ast.child(local, "right").unwrap()
        } else {
            left
        };
        let work_object = ast
            .child(work, "callee")
            .map(|node| ast.unwrap(node))
            .and_then(|node| ast.child(node, "object"));
        let read = unique(
            calls
                .iter()
                .copied()
                .filter(|node| {
                    let args = ast.array(*node, "arguments");
                    args.len() == 2
                        && ast.same_binding(args[1], host)
                        && ast
                            .child(*node, "callee")
                            .map(|node| ast.unwrap(node))
                            .and_then(|node| ast.child(node, "object"))
                            .zip(work_object)
                            .is_some_and(|(a, b)| ast.same_binding(a, b))
                })
                .collect(),
            "Native host quota reader is unsupported",
        )?;
        (host, Some(read), Some(work))
    };
    let host_declaration = ast
        .binding(host)
        .and_then(|binding| declaration(&ast, ast.binding_node(binding)))
        .ok_or_else(|| failure("Native host quota reader is unsupported"))?;
    let host_read = ast
        .child(host_declaration, "init")
        .map(|node| ast.value(node))
        .ok_or_else(|| failure("Native host quota reader is unsupported"))?;
    let host_args = ast.array(host_read, "arguments");
    if !call(&ast, host_read) || host_args.len() != 2 {
        return Err(failure("Native host quota reader is unsupported"));
    }
    let hook = ast
        .child(host_read, "callee")
        .map(|node| ast.text(ast.unwrap(node)))
        .ok_or_else(|| failure("Native quota hook is unavailable"))?;
    let provider = native_provider(context)?;
    let atoms = provider.map(|descriptor| {
        format!(
            "panelQuotaRequire({})[{}]",
            descriptor["id"], descriptor["exportName"]
        )
    });
    let runtime = "globalThis.__codexPanelProviderQuotaV1__";
    let read=format!("const panelQuotaEnabled=(0,{}.useSyncExternalStore)({runtime}.subscribe,{runtime}.getSnapshot);const panelQuotaTarget=(0,{hook})({},{});const panelQuotaThreadProvider=(0,{hook})({},{});const panelQuotaConfig=(0,{hook})({},panelQuotaTarget);const panelQuotaProvider=panelQuotaThreadProvider??panelQuotaConfig.data?.model_provider;const panelCustomQuota=panelQuotaEnabled&&{}===\"local\"&&typeof panelQuotaProvider===\"string\"&&panelQuotaProvider!==\"\"&&panelQuotaProvider!==\"openai\";",react(&ast,*function)?,atoms[0],ast.text(host_args[1]),atoms[2],ast.text(host_args[1]),atoms[1],ast.text(host));
    let start = body_start(&ast, ast.root)?;
    let params = ast.array(ast.root, "params");
    if params.len() < 3 {
        return Err(failure("Native factory require is unavailable"));
    }
    let mut changes = vec![
        Edit {
            start,
            end: start,
            text: format!("const panelQuotaRequire={};", ast.text(params[2])),
        },
        after_declaration(&ast, host_declaration, read)?,
    ];
    if !signals.is_empty() {
        let node = signals[0];
        changes.push(Edit {
            start: ast.start(node),
            end: ast.end(node),
            text: format!("((value)=>panelCustomQuota?null:value)({})", ast.text(node)),
        });
    } else if !reasons.is_empty() {
        for node in reasons {
            changes.push(Edit {
                start: ast.start(node),
                end: ast.end(node),
                text: format!(
                    "({})&&!panelCustomQuota&&{}",
                    ast.text(ast.child(node, "left").unwrap()),
                    ast.text(ast.child(node, "right").unwrap())
                ),
            });
        }
    } else {
        let gate = unique(
            submitted
                .iter()
                .copied()
                .filter(|node| ast.name(*node).as_deref() == Some("submitDisabled"))
                .collect(),
            "Native composer quota gate is unsupported",
        )?;
        let init = binding_values(&ast, ast.child(gate, "value").unwrap(), &mut HashSet::new());
        let bindings = [host_quota, work_quota]
            .into_iter()
            .flatten()
            .filter_map(|node| {
                declaration(&ast, node)
                    .and_then(|node| ast.child(node, "id"))
                    .and_then(|node| ast.binding(node))
            })
            .collect::<Vec<_>>();
        let references = init
            .into_iter()
            .flat_map(|root| {
                ast.all(root, |node| {
                    ast.kind(node) == "Identifier"
                        && ast
                            .binding(node)
                            .is_some_and(|binding| bindings.contains(&binding))
                })
            })
            .collect::<Vec<_>>();
        if references.len() != 2 {
            return Err(failure("Native composer quota gate is unsupported"));
        }
        for node in references {
            changes.push(Edit {
                start: ast.start(node),
                end: ast.end(node),
                text: format!("({}&&!panelCustomQuota)", ast.text(node)),
            });
        }
    }
    Ok(Some(edits(source, changes)?))
}

pub fn dot(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if !source.contains("isCapable") || source.contains("panelDotPreference") {
        return Ok(None);
    }
    let ast = context.ast(module)?;
    let mut candidates = Vec::new();
    for function in ast.all(ast.root, |node| ast.is_function(node)) {
        let parameters = ast.array(function, "params");
        let Some(request) = parameters
            .first()
            .copied()
            .filter(|node| ast.kind(*node) == "Identifier")
        else {
            continue;
        };
        let Some(reader) = parameters
            .iter()
            .copied()
            .find(|node| ast.kind(*node) == "ObjectPattern" && ast.property(*node, "get").is_some())
            .and_then(|node| ast.property_value(node, "get"))
        else {
            continue;
        };
        let lookups = ast.all(function, |node| {
            if ast.kind(node) != "VariableDeclarator" {
                return false;
            }
            let Some(init) = ast.child(node, "init").map(|node| ast.unwrap(node)) else {
                return false;
            };
            if ast.kind(init) != "MemberExpression" || !ast.boolean(init, "computed") {
                return false;
            }
            let Some(property) = ast.child(init, "property").map(|node| ast.unwrap(node)) else {
                return false;
            };
            ast.kind(property) == "MemberExpression"
                && ast.name(property).as_deref() == Some("name")
                && ast
                    .child(property, "object")
                    .is_some_and(|node| ast.same_binding(node, request))
        });
        if lookups.len() != 1
            || ast
                .all(function, |node| {
                    ast.kind(node) == "ObjectExpression"
                        && ast.property(node, "isCapable").is_some()
                })
                .is_empty()
        {
            continue;
        }
        if let Some(call) = ast
            .parent(function)
            .filter(|node| ast.kind(*node) == "CallExpression")
        {
            candidates.push((function, call, lookups[0], request, reader));
        }
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() != 1 {
        return Err(failure("Unsupported Rspack Dot capability structure"));
    }
    let (function, call, lookup, request, reader) = candidates[0];
    let family = ast
        .child(call, "callee")
        .ok_or_else(|| failure("Native reactive namespace for Dot unavailable"))?;
    let namespace = context
        .export_of(module, family)?
        .ok_or_else(|| failure("Native reactive namespace for Dot unavailable"))?;
    let namespace_id = namespace["id"]
        .as_str()
        .ok_or_else(|| failure("Native reactive namespace for Dot unavailable"))?;
    let native = context.ast(namespace_id)?;
    let mut signals = BTreeMap::<String, Value>::new();
    for (name, target) in native.exports() {
        let resolved = context.resolve(namespace_id, target)?;
        let function = resolved.ast.value(resolved.node);
        if !resolved.ast.is_function(function) {
            continue;
        }
        let Some(returned) = resolved
            .ast
            .return_value(function)
            .map(|node| resolved.ast.value(node))
        else {
            continue;
        };
        if !call_node(&resolved.ast, returned) {
            continue;
        }
        let args = resolved.ast.array(returned, "arguments");
        if !args
            .first()
            .is_some_and(|node| resolved.ast.field(resolved.ast.unwrap(*node), "value") == "signal")
        {
            continue;
        }
        let identity = context.export_of(&resolved.module, function)?;
        let key = identity
            .map(|value| value.to_string())
            .unwrap_or_else(|| format!("{}:{}", resolved.module, resolved.ast.start(function)));
        let descriptor = json!({"id":namespace_id,"exportName":name});
        if !signals.contains_key(&key)
            || descriptor["exportName"].as_str() < signals[&key]["exportName"].as_str()
        {
            signals.insert(key, descriptor);
        }
    }
    if signals.len() != 1 {
        return Err(failure("Native signal helper for Dot unavailable"));
    }
    let signal = signals.into_values().next().unwrap();
    let scope = ast
        .array(call, "arguments")
        .into_iter()
        .find(|node| *node != function)
        .ok_or_else(|| failure("Native Dot scope is unavailable"))?;
    let lookup_id = ast
        .child(lookup, "id")
        .ok_or_else(|| failure("Native Dot lookup is unavailable"))?;
    let check=format!("if({}!=null&&({}.name===\"orbit\"||{}.name===\"orbit.navigation\")&&{}(panelDotPreference))return{{isLoading:false,isError:false,isCapable:true}};",ast.text(lookup_id),ast.text(request),ast.text(request),ast.text(reader));
    let insertion = after_declaration(&ast, lookup, check)?;
    let changed = edits(
        ast.text(call),
        vec![Edit {
            start: insertion.start - ast.start(call),
            end: insertion.end - ast.start(call),
            text: insertion.text,
        }],
    )?;
    let runtime = "globalThis.__codexPanelDotEntryV1__";
    let preference=format!("panelDotRequire({})[{}]({},()=>{runtime}.getSnapshot(),{{getServerSnapshot:()=>false,onMount(set){{set({runtime}.getSnapshot());return {runtime}.subscribe(()=>set({runtime}.getSnapshot()))}}}})",signal["id"],signal["exportName"],ast.text(scope));
    let start = body_start(&ast, ast.root)?;
    let params = ast.array(ast.root, "params");
    if params.len() < 3 {
        return Err(failure("Native factory require is unavailable"));
    }
    Ok(Some(edits(
        source,
        vec![
            Edit {
                start,
                end: start,
                text: format!("const panelDotRequire={};", ast.text(params[2])),
            },
            Edit {
                start: ast.start(call),
                end: ast.end(call),
                text: format!("((panelDotPreference)=>{changed})({preference})"),
            },
        ],
    )?))
}

fn call_node(ast: &Ast, node: Id) -> bool {
    ast.kind(ast.unwrap(node)) == "CallExpression"
}

pub fn queue(source: &str, module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if source.contains("data-codex-panel-queued-messages") || source.contains("panelQueueRequire") {
        return Ok(None);
    }
    if let Some(rail) = super::source_ast::queue_rail(source)? {
        return Ok(Some(rail));
    }
    if !source.contains("queuedMessages") {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let subscriptions = ast.all(ast.root, |node| {
        if ast.kind(node) != "CallExpression"
            || ast
                .child(node, "callee")
                .and_then(|node| ast.name(ast.unwrap(node)))
                .as_deref()
                != Some("subscribe")
        {
            return false;
        }
        ast.array(node, "arguments")
            .first()
            .and_then(|node| ast.property_value(*node, "field"))
            .is_some_and(|node| ast.field(node, "value") == "queuedMessages")
    });
    let candidates = subscriptions
        .into_iter()
        .filter_map(|node| {
            let callback = function(&ast, node)?;
            let subscription = ast.enclosing(callback, |node| {
                ast.kind(node) == "CallExpression"
                    && ast.array(node, "arguments").contains(&callback)
            })?;
            let callee = ast
                .child(subscription, "callee")
                .map(|node| ast.unwrap(node))?;
            (ast.kind(callee) == "MemberExpression"
                && ast.array(subscription, "arguments").len() >= 3)
                .then_some((subscription, callee))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() != 1 {
        return Err(failure("Native queued-follow-up subscription is ambiguous"));
    }
    let (subscription, callee) = candidates[0];
    let mut signals = BTreeMap::<String, Value>::new();
    for id in context.modules_containing("statsigEvaluations") {
        let tree = context.ast(&id)?;
        for member in tree.all(tree.root, |node| {
            tree.kind(node) == "MemberExpression"
                && tree.name(node).as_deref() == Some("statsigEvaluations")
        }) {
            let mount = tree.enclosing(member, |node| {
                tree.kind(node) == "Property" && tree.name(node).as_deref() == Some("onMount")
            });
            let create = mount.and_then(|mount| {
                tree.enclosing(mount, |node| tree.kind(node) == "CallExpression")
            });
            let declaration = create
                .and_then(|create| declaration(&tree, create))
                .and_then(|node| tree.child(node, "id"));
            if let Some(declaration) = declaration {
                if let Some(reference) = context.export_of(&id, declaration)? {
                    signals.insert(reference.to_string(), reference);
                }
            }
        }
    }
    let mut versions = BTreeMap::<String, Value>::new();
    for id in context.modules_containing("appServerVersion$") {
        let tree = context.ast(&id)?;
        for member in tree.all(tree.root, |node| {
            tree.kind(node) == "MemberExpression"
                && tree.name(node).as_deref() == Some("appServerVersion$")
        }) {
            let Some(read) = tree.parent(member).filter(|node| {
                tree.kind(*node) == "CallExpression"
                    && tree.array(*node, "arguments").contains(&member)
            }) else {
                continue;
            };
            let Some(callback) = function(&tree, read) else {
                continue;
            };
            let Some(mut result) = tree.return_value(callback).map(|node| tree.value(node)) else {
                continue;
            };
            if tree.kind(result) == "LogicalExpression"
                && tree.field(result, "operator") == "??"
                && tree.child(result, "right").is_some_and(|node| {
                    tree.kind(node) == "Literal" && tree.field(node, "value").is_null()
                })
            {
                result = tree.value(tree.child(result, "left").unwrap());
            }
            if result != read {
                continue;
            }
            let Some(create) = tree.parent(callback).filter(|node| {
                tree.kind(*node) == "CallExpression"
                    && tree.array(*node, "arguments").contains(&callback)
            }) else {
                continue;
            };
            if let Some(declaration) =
                declaration(&tree, create).and_then(|node| tree.child(node, "id"))
            {
                if let Some(reference) = context.export_of(&id, declaration)? {
                    versions.insert(reference.to_string(), reference);
                }
            }
        }
    }
    if signals.len() != 1 {
        return Err(failure("Native settings publication is unsupported"));
    }
    if versions.len() != 1 {
        return Err(failure("Native core version signal is unsupported"));
    }
    let publication = signals.into_values().next().unwrap();
    let version = versions.into_values().next().unwrap();
    let load = |reference: &Value| {
        format!(
            "panelQueueRequire({})[{}]",
            reference["id"], reference["exportName"]
        )
    };
    let reactive=format!("((...panelQueueArgs)=>panelQueueArgs[0].watch(({{get:panelQueueGet}})=>{{panelQueueGet({});panelQueueGet({},panelQueueArgs[1].hostId);return ({}) (...panelQueueArgs)}}))",load(&publication),load(&version),ast.text(ast.child(subscription,"callee").unwrap()));
    let start = body_start(&ast, ast.root)?;
    let parameters = ast.array(ast.root, "params");
    if parameters.len() < 3 {
        return Err(failure("Native queue factory require is unsupported"));
    }
    let _ = module;
    Ok(Some(edits(
        source,
        vec![
            Edit {
                start,
                end: start,
                text: format!("const panelQueueRequire={};", ast.text(parameters[2])),
            },
            Edit {
                start: ast.start(callee),
                end: ast.end(callee),
                text: reactive,
            },
        ],
    )?))
}

fn result_access_edits(ast: &Ast) -> Vec<Edit> {
    let mut changes = Vec::new();
    for object in ast.all(ast.root, |node| {
        ast.kind(node) == "ObjectExpression"
            && ast.property(node, "setServiceTier").is_some()
            && ast.property(node, "serviceTierAccess").is_none()
    }) {
        let Some(owner) = function(ast, object) else {
            continue;
        };
        let binding = ast
            .all(owner, |node| {
                ast.kind(node) == "VariableDeclarator"
                    && function(ast, node) == Some(owner)
                    && ast.child(node, "id").is_some_and(|pattern| {
                        ast.kind(pattern) == "ObjectPattern"
                            && ast.property(pattern, "serviceTierAccess").is_some()
                    })
            })
            .into_iter()
            .find(|node| {
                let pattern = ast.child(*node, "id").unwrap();
                let tier = ast.property_value(pattern, "serviceTierSettings");
                let target = ast.property_value(object, "serviceTierSettings");
                tier.zip(target)
                    .is_some_and(|(a, b)| ast.same_binding(a, b))
                    || ast
                        .array(pattern, "properties")
                        .into_iter()
                        .find(|node| ast.kind(*node) == "RestElement")
                        .and_then(|node| ast.child(node, "argument"))
                        .is_some_and(|rest| {
                            ast.array(object, "properties").into_iter().any(|node| {
                                ast.kind(node) == "SpreadElement"
                                    && ast
                                        .child(node, "argument")
                                        .is_some_and(|arg| ast.same_binding(arg, rest))
                            })
                        })
            });
        if let Some(binding) = binding {
            let access = ast
                .child(binding, "id")
                .and_then(|pattern| ast.property_value(pattern, "serviceTierAccess"))
                .unwrap();
            changes.push(Edit {
                start: ast.end(object) - 1,
                end: ast.end(object) - 1,
                text: format!(
                    "{}serviceTierAccess:{}",
                    if ast.array(object, "properties").is_empty() {
                        ""
                    } else {
                        ","
                    },
                    ast.text(access)
                ),
            });
        }
    }
    changes
}

fn model_menu(ast: &Ast) -> Result<Vec<Edit>, ApiError> {
    let candidates = ast.all(ast.root, |node| {
        ast.kind(node) == "VariableDeclarator"
            && ast.child(node, "id").is_some_and(|pattern| {
                ast.kind(pattern) == "ObjectPattern"
                    && ast.property(pattern, "serviceTierSettings").is_some()
                    && ast.property(pattern, "setServiceTier").is_some()
                    && ast.property(pattern, "serviceTierAccess").is_none()
            })
    });
    let mut changes = Vec::new();
    for settings in candidates {
        let Some(owner) = function(ast, settings) else {
            continue;
        };
        let pattern = ast.child(settings, "id").unwrap();
        let tier = ast.property_value(pattern, "serviceTierSettings").unwrap();
        let access = ast.all(owner, |node| {
            node != settings
                && ast.kind(node) == "VariableDeclarator"
                && function(ast, node) == Some(owner)
                && ast.child(node, "id").is_some_and(|pattern| {
                    ast.kind(pattern) == "ObjectPattern"
                        && ast.property(pattern, "serviceTierAccess").is_some()
                })
        });
        if access.len() != 1 {
            continue;
        }
        let allowed = ast
            .child(access[0], "id")
            .and_then(|pattern| ast.property_value(pattern, "serviceTierAccess"))
            .unwrap();
        // 菜单权限跟随设置返回值，不依赖 selectedServiceTier 的缓存次数或图标结构。
        changes.push(Edit {
            start: ast.start(pattern) + 1,
            end: ast.start(pattern) + 1,
            text: "serviceTierAccess:panelServiceTierAccess,".into(),
        });
        if let Some(binding) = ast.binding(allowed) {
            for reference in ast.references(binding) {
                let shorthand = ast.parent(*reference).filter(|parent| {
                    ast.kind(*parent) == "Property" && ast.boolean(*parent, "shorthand")
                });
                changes.push(match shorthand {
                    Some(parent) => Edit {
                        start: ast.start(parent),
                        end: ast.end(parent),
                        text: format!("{}:panelServiceTierAccess", ast.text(*reference)),
                    },
                    None => Edit {
                        start: ast.start(*reference),
                        end: ast.end(*reference),
                        text: "panelServiceTierAccess".into(),
                    },
                });
            }
        }
        let selected = ast.all(owner, |node| {
            ast.kind(node) == "MemberExpression"
                && ast.name(node).as_deref() == Some("selectedServiceTier")
                && ast
                    .child(node, "object")
                    .is_some_and(|object| ast.same_binding(object, tier))
        });
        if selected.len() != 1 {
            continue;
        }
        let value = declaration(ast, selected[0])
            .and_then(|node| ast.child(node, "id"))
            .unwrap_or(selected[0]);
        let icons = ast.all(owner, |node| {
            ast.kind(node) == "CallExpression"
                && ast
                    .array(node, "arguments")
                    .iter()
                    .any(|node| ast.same_binding(*node, value))
                && ast
                    .enclosing(node, |node| {
                        ast.kind(node) == "LogicalExpression" && ast.field(node, "operator") == "&&"
                    })
                    .is_some()
        });
        if icons.len() != 1 {
            continue;
        }
        let icon = icons[0];
        changes.push(Edit{start:ast.start(icon),end:ast.end(icon),text:format!("({}===\"ultrafast\"&&{}.availableOptions.some(option=>option.value===\"ultrafast\")||{})",ast.text(value),ast.text(tier),ast.text(icon))});
    }
    Ok(changes)
}

pub fn ultrafast(
    source: &str,
    module: &str,
    context: &Context,
) -> Result<Option<String>, ApiError> {
    if !source.contains("serviceTierSettings")
        || source.contains("panelSpeedEnabled")
        || source.contains("panelServiceTierAccess")
    {
        return Ok(None);
    }
    let ast = context.ast(module)?;
    let mut candidates = Vec::new();
    for model in ast.all(ast.root, |node| {
        if ast.kind(node) != "CallExpression" {
            return false;
        }
        let args = ast.array(node, "arguments");
        args.len() >= 2
            && ast.name(ast.unwrap(args[0])).as_deref() == Some("models")
            && ast.name(ast.unwrap(args[1])).as_deref() == Some("model")
    }) {
        let Some(owner) = function(&ast, model) else {
            continue;
        };
        let access = ast.all(owner, |node| {
            ast.kind(node) == "VariableDeclarator"
                && function(&ast, node) == Some(owner)
                && ast.child(node, "id").is_some_and(|pattern| {
                    ast.kind(pattern) == "ObjectPattern"
                        && ast.property(pattern, "serviceTierAccess").is_some()
                })
                && ast.child(node, "init").is_some_and(|node| call(&ast, node))
        });
        if access.len() != 1 {
            continue;
        }
        let targets = ast.all(owner, |node| {
            ast.kind(node) == "VariableDeclarator"
                && function(&ast, node) == Some(owner)
                && ast
                    .child(node, "init")
                    .is_some_and(|node| ast.name(ast.unwrap(node)).as_deref() == Some("hostId"))
        });
        if targets.len() != 1 {
            continue;
        }
        let target = ast
            .child(targets[0], "init")
            .map(|node| ast.unwrap(node))
            .and_then(|node| ast.child(node, "object"))
            .unwrap();
        let Some(scope) = ast
            .binding(target)
            .and_then(|binding| declaration(&ast, ast.binding_node(binding)))
        else {
            continue;
        };
        let Some(scope_call) = ast.child(scope, "init").map(|node| ast.unwrap(node)) else {
            continue;
        };
        let args = ast.array(scope_call, "arguments");
        if !call(&ast, scope_call) || args.len() != 1 {
            continue;
        }
        let thread = args[0];
        let readers = ast.all(owner, |node| {
            ast.kind(node) == "CallExpression"
                && function(&ast, node) == Some(owner)
                && ast.array(node, "arguments").len() == 2
                && ast.same_binding(ast.array(node, "arguments")[1], thread)
                && ast
                    .child(node, "callee")
                    .is_some_and(|node| ast.kind(ast.unwrap(node)) == "MemberExpression")
        });
        let mut hooks = readers
            .into_iter()
            .filter_map(|node| ast.child(node, "callee"))
            .collect::<Vec<_>>();
        hooks.sort_by_key(|node| ast.text(*node).to_owned());
        hooks.dedup_by_key(|node| ast.text(*node).to_owned());
        if hooks.len() == 1 {
            candidates.push((owner, model, access[0], scope_call, thread, hooks[0]));
        }
    }
    if candidates.is_empty() {
        let changes = model_menu(&ast)?;
        if !changes.is_empty() {
            return Ok(Some(edits(source, changes)?));
        }
        if !ast
            .all(ast.root, |node| {
                ast.kind(node) == "ObjectExpression"
                    && [
                        "hasManagedNewThreadSettings",
                        "serviceTierSettings",
                        "serviceTierAccess",
                    ]
                    .iter()
                    .all(|name| ast.property(node, name).is_some())
            })
            .is_empty()
        {
            return Err(failure("Unsupported Rspack Ultrafast settings structure"));
        }
        return Ok(None);
    }
    if candidates.len() != 1 {
        return Err(failure("Ambiguous Rspack Ultrafast settings"));
    }
    let (owner, model, access, scope, thread, hook) = candidates[0];
    let provider = native_provider(context)?;
    let atoms = provider.map(|descriptor| {
        format!(
            "panelSpeedRequire({})[{}]",
            descriptor["id"], descriptor["exportName"]
        )
    });
    let runtime = "globalThis.__codexPanelProviderUltrafastV1__";
    let hook = ast.text(ast.unwrap(hook));
    let args = ast.array(model, "arguments");
    let read=format!("const panelSpeedScope={};const panelSpeedEnabled=(0,{}.useSyncExternalStore)({runtime}.subscribe,{runtime}.getSnapshot);const panelSpeedTarget=(0,{hook})({},{});const panelSpeedConfig=(0,{hook})({},panelSpeedTarget);const panelSpeedThreadProvider=(0,{hook})({},{});const panelSpeedProvider=panelSpeedThreadProvider??panelSpeedConfig.data?.model_provider??\"openai\";const panelCustomSpeed=panelSpeedEnabled&&panelSpeedScope.hostId===\"local\"&&typeof panelSpeedProvider===\"string\"&&panelSpeedProvider.trim()!==\"\";const panelUltrafastModel=/^(?:gpt-6[- ]astra|gpt-6\\.1[- ]sol|gpt-6\\.2[- ](?:astra|sol))$/i.test({});",ast.text(scope),react(&ast,owner)?,atoms[0],ast.text(thread),atoms[1],atoms[2],ast.text(thread),ast.text(args[1]));
    let access_call = ast
        .child(access, "init")
        .map(|node| ast.unwrap(node))
        .unwrap();
    let access_text=format!("((native)=>({{...native,serviceTierAccess:panelCustomSpeed?{{...native.serviceTierAccess,fast:panelUltrafastModel||native.serviceTierAccess?.fast===true,ultrafast:panelUltrafastModel}}:native.serviceTierAccess}}))({})",ast.text(access_call));
    let model_text=format!("(panelCustomSpeed&&panelUltrafastModel?(model=>{{if(!model)return model;const missing=[{{id:\"priority\",name:\"Fast\",description:\"\"}},{{id:\"ultrafast\",name:\"Ultrafast\",description:\"\"}}].filter(tier=>!model.serviceTiers?.some(existing=>existing.id===tier.id));return missing.length?{{...model,serviceTiers:[...(model.serviceTiers??[]),...missing]}}:model}})({}):{})",ast.text(model),ast.text(model));
    let start = body_start(&ast, ast.root)?;
    let owner_start = body_start(&ast, owner)?;
    let parameters = ast.array(ast.root, "params");
    if parameters.len() < 3 {
        return Err(failure("Native factory require is unavailable"));
    }
    let mut changes = vec![
        Edit {
            start,
            end: start,
            text: format!("const panelSpeedRequire={};", ast.text(parameters[2])),
        },
        Edit {
            start: owner_start,
            end: owner_start,
            text: read,
        },
        Edit {
            start: ast.start(scope),
            end: ast.end(scope),
            text: "panelSpeedScope".into(),
        },
        Edit {
            start: ast.start(access_call),
            end: ast.end(access_call),
            text: access_text,
        },
        Edit {
            start: ast.start(model),
            end: ast.end(model),
            text: model_text,
        },
    ];
    changes.extend(result_access_edits(&ast));
    let _ = module;
    Ok(Some(edits(source, changes)?))
}

#[cfg(test)]
mod tests {
    use super::super::adapters::{Module, Variant};
    use super::*;
    fn fixture(name: &str) -> String {
        let source = include_str!("../../../test/codex-rspack-quota.test.mjs");
        let marker = format!("const {name} = `");
        let start = source.find(&marker).unwrap() + marker.len();
        source[start..start + source[start..].find('`').unwrap()].to_owned()
    }
    fn catalog(sources: Vec<(&str, String)>) -> Catalog {
        let modules = sources
            .into_iter()
            .map(|(id, source)| {
                (
                    id.into(),
                    Module {
                        source: source.clone(),
                        exports: Vec::new(),
                        variants: vec![Variant {
                            source,
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
    fn run_js(script: String) {
        let output = std::process::Command::new("node")
            .args(["-e", &script])
            .output()
            .expect("Frontend build toolchain must provide Node for differential checks");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn queue_recovery_keeps_single_active_subscription() {
        let file = include_str!("../../../test/codex-rspack-queue.test.mjs");
        let get = |name: &str| {
            let marker = format!("const {name} = '");
            let start = file.find(&marker).unwrap() + marker.len();
            file[start..start + file[start..].find("';").unwrap()].to_owned()
        };
        let queue_source = get("queueSource");
        let publication = get("publicationSource");
        let version = get("versionSource");
        let other = get("otherSource");
        let catalog = catalog(vec![
            ("MYVk", queue_source.clone()),
            ("jMec", publication.clone()),
            ("CfsC", version.clone()),
            ("other", other.clone()),
        ]);
        let context = Context::new(&catalog);
        let rewritten = queue(&queue_source, "MYVk", &context).unwrap().unwrap();
        Ast::parse(&rewritten, true).unwrap();
        let scope_start = file.find("function scopeFixture()").unwrap();
        let scope_end = file[scope_start..].find("\nfunction harness").unwrap() + scope_start;
        let harness_start = scope_end + 1;
        let harness_end = file[harness_start..].find("\ntest(").unwrap() + harness_start;
        let harness=file[harness_start..harness_end].replace("const plan = buildRspackPlan({ factories }, adapt ? { queue: rewriteRspackQueue } : {});","const plan = {patches:{MYVk:[{before:queueSource,after:rewritten,features:['queue']}]},prepared:{queue:true},chunks:{},nativeServices:{},nativeUpdate:{}};");
        let script = format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const queueSource={},publicationSource={},versionSource={},otherSource={},rewritten={};const createCodexRspackRuntime={};{}{}const adapted=harness(true);assert.equal(adapted.messages().length,0);adapted.publish(true);assert.equal(adapted.messages().length,1);adapted.publish(false);assert.equal(adapted.messages().length,0);adapted.publish(true);assert.equal(adapted.active.size,1);adapted.stop();assert.equal(adapted.active.size,0);assert.equal(adapted.published.listeners.size,0);"#,
            json!(queue_source),
            json!(publication),
            json!(version),
            json!(other),
            json!(rewritten),
            include_str!("assets/rspack_runtime.js"),
            &file[scope_start..scope_end],
            harness
        );
        run_js(script);
    }
    #[test]
    fn dot_preserves_other_capabilities_and_tracks_preference() {
        let source = r#"function(module,exports,load){load.d(exports,{capability:()=>capability});var reactive=load("reactive"),scope=load("scope");let definitions={orbit:{},"orbit.navigation":{},other:{}},capability=(0,reactive.family)(scope.value,(request,{get:read})=>{let config=definitions[request.name];if(config==null)return{isLoading:false,isError:false,isCapable:false};return {isLoading:false,isError:false,isCapable:false}})}"#;
        let catalog=catalog(vec![("subject",source.into()),("reactive",r#"function(module,exports,load){var state=load("state");load.d(exports,{signal:()=>state.value});}"#.into()),("state",r#"function(module,exports,load){load.d(exports,{}, {value:function(scope,read,options){let atom=(0,other.build)("signal",scope,read);return atom}})}"#.into())]);
        let context = Context::new(&catalog);
        let rewritten = dot(source, "subject", &context).unwrap().unwrap();
        Ast::parse(&rewritten, true).unwrap();
        run_js(format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');let enabled=true;const dependencies={{state:{{value:(_,read)=>({{read}})}},reactive:{{signal:(_,read)=>({{read}}),family:(_,read)=>request=>read(request,{{get:atom=>atom.read()}})}},scope:{{value:'scope'}}}},exports={{}},load=id=>dependencies[id];load.d=(exports,getters,values)=>{{for(const[name,get]of Object.entries(getters))Object.defineProperty(exports,name,{{get}});Object.assign(exports,values)}};vm.runInNewContext('('+{}+')',{{__codexPanelDotEntryV1__:{{getSnapshot:()=>enabled,subscribe(){{}}}}}})({{}},exports,load);assert.equal(exports.capability({{name:'orbit'}}).isCapable,true);assert.equal(exports.capability({{name:'other'}}).isCapable,false);enabled=false;assert.equal(exports.capability({{name:'orbit.navigation'}}).isCapable,false);"#,
            json!(rewritten)
        ));
    }
    #[test]
    fn ultrafast_keeps_provider_and_model_scope() {
        let file = include_str!("../../../test/codex-rspack-capabilities.test.mjs");
        let get = |name: &str| {
            let marker = format!("const {name} = `");
            let start = file.find(&marker).unwrap() + marker.len();
            file[start..start + file[start..].find('`').unwrap()].to_owned()
        };
        let source = get("hookSource");
        let catalog = catalog(vec![
            ("subject", source.clone()),
            ("reader", get("providerSource")),
            ("target-module", "function(){}".into()),
            ("config-module", "function(){}".into()),
            ("provider-module", "function(){}".into()),
        ]);
        let context = Context::new(&catalog);
        let rewritten = ultrafast(&source, "subject", &context).unwrap().unwrap();
        Ast::parse(&rewritten, true).unwrap();
        run_js(format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');let enabled=true;const options={{model:'gpt-6-astra',hostId:'local',threadProvider:'custom',configProvider:'custom',models:[{{model:'gpt-6-astra',serviceTiers:[{{id:'standard'}}]}}]}};const dependencies={{react:{{use(){{}},useSyncExternalStore:(_,read)=>read()}},signal:{{read(atom){{if(atom==='target')return{{hostId:options.hostId,cwd:'/tmp'}};if(atom==='config')return{{data:{{model_provider:options.configProvider}}}};if(atom==='provider')return options.threadProvider;}}}},scope:{{target:()=>({{hostId:options.hostId}})}},access:{{read:()=>({{serviceTierAccess:{{ultrafast:false,standard:true}}}})}},model:{{select:(models,name)=>models.find(model=>model.model===name)}},extra:{{atom:'extra'}},'target-module':{{atom:'target'}},'config-module':{{atom:'config'}},'provider-module':{{atom:'provider'}}}},exports={{}},load=id=>dependencies[id];load.d=(exports,getters)=>{{for(const[name,get]of Object.entries(getters))Object.defineProperty(exports,name,{{get}})}};vm.runInNewContext('('+{}+')',{{__codexPanelProviderUltrafastV1__:{{subscribe(){{}},getSnapshot:()=>enabled}}}})({{}},exports,load);const settings=()=>exports.settings('thread',options);assert.equal(settings().serviceTierAccess.fast,true);assert.equal(settings().setServiceTier('ultrafast'),true);options.threadProvider='openai';assert.equal(settings().setServiceTier('ultrafast'),true);options.threadProvider=undefined;options.configProvider=undefined;assert.equal(settings().setServiceTier('ultrafast'),true);for(const invalid of['',' ',false,7,{{}},[]]){{options.threadProvider=invalid;assert.equal(settings().setServiceTier('ultrafast'),false);}}options.threadProvider='custom';options.hostId='remote';assert.equal(settings().setServiceTier('ultrafast'),false);options.hostId='local';enabled=false;assert.equal(settings().setServiceTier('ultrafast'),false);"#,
            json!(rewritten)
        ));
    }
    #[test]
    fn openai_ultrafast_reaches_compiled_menu_and_request() {
        let file = include_str!("../../../test/codex-rspack-capabilities.test.mjs");
        let get = |name: &str| {
            let marker = format!("const {name} = `");
            let start = file.find(&marker).unwrap() + marker.len();
            file[start..start + file[start..].find('`').unwrap()].to_owned()
        };
        let source = get("hookSource")
            .replace("serviceTierForRequest:available.some(t=>t.value===\"ultrafast\")?\"ultrafast\":null", "serviceTierForRequest:selection.serviceTier!==\"ultrafast\"||allowed.ultrafast?selection.serviceTier:null")
            .replace("setServiceTier:t=>t!==\"ultrafast\"||allowed.ultrafast", "setServiceTier:t=>{if(t===\"ultrafast\"&&!allowed.ultrafast)return false;selection.serviceTier=t;return true}")
            .replace("let set=value=>value!==\"ultrafast\"||chosen.ultrafast;", "let set=value=>(value!==\"ultrafast\"||chosen.ultrafast)&&rest.setServiceTier(value);");
        let menu = get("modernMenuSource");
        let catalog = catalog(vec![
            ("settings", source.clone()),
            ("menu", menu.clone()),
            ("reader", get("providerSource")),
            ("target-module", "function(){}".into()),
            ("config-module", "function(){}".into()),
            ("provider-module", "function(){}".into()),
        ]);
        let context = Context::new(&catalog);
        let patched_source = ultrafast(&source, "settings", &context).unwrap().unwrap();
        let patched_menu = ultrafast(&menu, "menu", &context).unwrap().unwrap();
        let fixtures = json!({source:patched_source,menu:patched_menu});
        // 使用同一套端到端夹具执行 Rust 生成的浏览器函数，检查菜单选中后序列化的 serviceTier。
        let body = file
            .lines()
            .filter(|line| !line.starts_with("import "))
            .collect::<Vec<_>>()
            .join("\n");
        run_js(format!("const assert=require('node:assert/strict'),vm=require('node:vm');const fixtures={fixtures};const rspackSourceContext=()=>({{}});const rewriteRspackUltrafast=source=>{{assert.ok(source in fixtures);return fixtures[source]}};let ran=0;const test=(name,callback)=>{{if(name==='compiled native menu selects OpenAI Ultrafast and produces the request service tier'){{callback();ran++}}}};{body};assert.equal(ran,1);"));
    }
    #[test]
    fn quota_preserves_non_quota_blockers_and_provider_boundary() {
        for shape in ["composer", "composerWithReasons", "composerWithQuotaSignal"] {
            let source = fixture(shape);
            let mut modules = BTreeMap::new();
            for (id, source) in [
                ("composer", source.clone()),
                ("reader", fixture("reader")),
                ("quota-signal", fixture("quotaSignal")),
                ("targets", "function(){}".into()),
                ("config", "function(){}".into()),
                ("providers", "function(){}".into()),
            ] {
                modules.insert(
                    id.into(),
                    Module {
                        source: source.clone(),
                        exports: Vec::new(),
                        variants: vec![Variant {
                            source,
                            chunks: Vec::new(),
                            asset_size: 0,
                        }],
                    },
                );
            }
            let catalog = Catalog {
                main_url_path: String::new(),
                main_source: String::new(),
                digest: String::new(),
                modules,
                unreadable: Vec::new(),
            };
            let context = Context::new(&catalog);
            let rewritten = quota(&source, "composer", &context).unwrap().unwrap();
            Ast::parse(&rewritten, true).unwrap();
            // 构建测试仍可使用 Node；交付运行时不调用它。这里实际执行改写后的浏览器函数以核对领域边界。
            let script = format!(
                r#"
const assert=require('node:assert/strict'),vm=require('node:vm');
const state={{enabled:true,host:'local',provider:'custom',configProvider:'openai',hostQuota:true,workQuota:true}};
const runtime={{subscribe:()=>()=>{{}},getSnapshot:()=>state.enabled}},memo=[];
const dependencies={{react:{{useState:()=>[null],useSyncExternalStore:(_,get)=>get()}},memo:{{c:()=>memo}},
hooks:{{read(atom){{if(atom==='thread-host')return state.host;if(atom==='host-quota')return state.hostQuota;if(atom==='scope')return{{cwd:'/isolated',hostId:state.host}};if(atom==='provider')return state.provider;if(atom==='config')return{{data:{{model_provider:state.configProvider}}}};if(atom==='quota-reason')return[state.hostQuota&&'reserve-limit',state.host==='local'&&state.workQuota&&'usage-limit'].filter(Boolean).join(',');throw Error(atom)}},atom:value=>value&&state.workQuota}},
thread:{{host:'thread-host'}},quota:{{host:'host-quota',work:'work-quota'}},targets:{{scope:'scope'}},config:{{options:'config'}},providers:{{name:'provider'}},'quota-signal':{{value:'quota-reason'}}}};
const exports={{}},load=id=>dependencies[id];load.d=(object,values)=>{{for(const[name,get]of Object.entries(values))Object.defineProperty(object,name,{{get}})}};
vm.runInNewContext('('+{}+')',{{__codexPanelProviderQuotaV1__:runtime}})({{}},exports,load);
const render=options=>exports.CodexComposerAdapter({{threadId:'test',...options}});
assert.equal(render().onSubmit(),true);state.enabled=false;assert.equal(render().onSubmit(),false);state.enabled=true;
for(const options of[{{external:true}},{{loading:true}},{{status:'failed',error:{{codexErrorInfo:'misalignmentPolicyViolation'}}}}])assert.equal(render(options).onSubmit(),false);
state.provider='openai';assert.equal(render().onSubmit(),false);state.provider='custom';state.host='remote';assert.equal(render().onSubmit(),false);
"#,
                json!(rewritten)
            );
            let output = std::process::Command::new("node")
                .args(["-e", &script])
                .output()
                .expect("Frontend build toolchain must provide Node for differential checks");
            assert!(
                output.status.success(),
                "{shape}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}
