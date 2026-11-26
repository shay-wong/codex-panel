use crate::ApiError;
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub type Id = usize;

#[derive(Clone)]
struct Node {
    data: Map<String, Value>,
    parent: Option<Id>,
    scope: usize,
}
struct Scope {
    parent: Option<usize>,
    function: bool,
    names: HashMap<String, usize>,
}
struct Binding {
    node: Id,
    init: Option<Id>,
    declaration: Id,
    references: Vec<Id>,
}

/// 扁平 AST 只保留一份节点，避免跨模块查询反复克隆整棵语法树。
pub struct Ast {
    pub source: String,
    pub root: Id,
    pub factory: bool,
    nodes: Vec<Node>,
    original_nodes: usize,
    scopes: Vec<Scope>,
    bindings: Vec<Binding>,
    declarations: HashMap<Id, usize>,
}

impl Ast {
    pub fn parse(source: &str, factory: bool) -> Result<Self, ApiError> {
        #[cfg(test)]
        if source.len() > 200_000 && std::env::var_os("CODEX_PANEL_AST_TRACE").is_some() {
            eprintln!("large AST: {} bytes; factory={factory}", source.len());
        }
        let parsed_source = if factory {
            format!("({source})")
        } else {
            source.to_owned()
        };
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, &parsed_source, SourceType::mjs())
            .with_options(ParseOptions {
                preserve_parens: false,
                ..ParseOptions::default()
            })
            .parse();
        if let Some(error) = parsed.errors.first() {
            return Err(ApiError::new(
                422,
                "NATIVE_SOURCE",
                format!("Cannot parse native source: {error}"),
            ));
        }
        let serialized = parsed.program.to_estree_js_json(false);
        drop(parsed);
        drop(allocator);
        drop(parsed_source);
        // 编译后的合法条件表达式可能超过 JSON 默认的 128 层，不能把它当作源码损坏。
        let mut deserializer = serde_json::Deserializer::from_str(&serialized);
        deserializer.disable_recursion_limit();
        let mut value: Value = serde::Deserialize::deserialize(&mut deserializer)?;
        drop(deserializer);
        drop(serialized);
        // 移出 factory，不能克隆整个 ESTree 再构建扁平树，峰值会同时持有两份节点。
        let value = if factory {
            std::mem::take(&mut value["body"][0]["expression"])
        } else {
            value
        };
        let mut ast = Self {
            source: source.to_owned(),
            root: 0,
            factory,
            nodes: Vec::new(),
            original_nodes: 0,
            scopes: vec![Scope {
                parent: None,
                function: true,
                names: HashMap::new(),
            }],
            bindings: Vec::new(),
            declarations: HashMap::new(),
        };
        ast.root = ast.flatten(value, None, factory)?;
        ast.original_nodes = ast.nodes.len();
        if factory && !ast.is_function(ast.root) {
            return Err(ApiError::new(
                422,
                "NATIVE_SOURCE",
                "Native factory is not a function",
            ));
        }
        ast.visit(ast.root, 0);
        for id in 0..ast.original_nodes {
            if ast.kind(id) != "Identifier" || ast.declarations.contains_key(&id) {
                continue;
            }
            let parent = ast.nodes[id].parent;
            if parent.is_some_and(|parent| {
                (ast.kind(parent) == "MemberExpression"
                    && ast.child(parent, "property") == Some(id)
                    && !ast.boolean(parent, "computed"))
                    || (ast.kind(parent) == "Property"
                        && ast.child(parent, "key") == Some(id)
                        && !ast.boolean(parent, "computed"))
                    || matches!(
                        ast.kind(parent),
                        "ImportSpecifier"
                            | "ImportDefaultSpecifier"
                            | "ImportNamespaceSpecifier"
                            | "LabeledStatement"
                            | "BreakStatement"
                            | "ContinueStatement"
                    )
            }) {
                continue;
            }
            if let Some(binding) = ast.binding(id) {
                ast.bindings[binding].references.push(id);
            }
        }
        Ok(ast)
    }

    fn flatten(&mut self, value: Value, parent: Option<Id>, offset: bool) -> Result<Id, ApiError> {
        let Value::Object(mut data) = value else {
            return Err(ApiError::new(
                422,
                "NATIVE_SOURCE",
                "Native AST node must be an object",
            ));
        };
        if offset {
            for key in ["start", "end"] {
                if let Some(n) = data.get(key).and_then(Value::as_u64) {
                    data.insert(key.into(), json!(n.saturating_sub(1)));
                }
            }
        }
        let id = self.nodes.len();
        self.nodes.push(Node {
            data: Map::new(),
            parent,
            scope: 0,
        });
        for (_, value) in data.iter_mut() {
            self.flatten_field(value, id, offset)?;
        }
        self.nodes[id].data = data;
        Ok(id)
    }
    fn flatten_field(
        &mut self,
        value: &mut Value,
        parent: Id,
        offset: bool,
    ) -> Result<(), ApiError> {
        if value.is_object() && value.get("type").is_some_and(Value::is_string) {
            let id = self.flatten(std::mem::take(value), Some(parent), offset)?;
            *value = json!({"$node":id});
        } else if let Value::Array(values) = value {
            for value in values {
                self.flatten_field(value, parent, offset)?;
            }
        }
        Ok(())
    }
    pub fn kind(&self, id: Id) -> &str {
        self.nodes[id]
            .data
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
    }
    pub fn field(&self, id: Id, key: &str) -> &Value {
        self.nodes[id].data.get(key).unwrap_or(&Value::Null)
    }
    pub fn boolean(&self, id: Id, key: &str) -> bool {
        self.field(id, key) == true
    }
    pub fn child(&self, id: Id, key: &str) -> Option<Id> {
        self.field(id, key)
            .get("$node")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
    }
    pub fn array(&self, id: Id, key: &str) -> Vec<Id> {
        self.field(id, key)
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["$node"].as_u64().map(|n| n as usize))
            .collect()
    }
    fn children(&self, id: Id) -> Vec<Id> {
        self.nodes[id]
            .data
            .values()
            .flat_map(|value| {
                let mut ids = Vec::new();
                if let Some(id) = value["$node"].as_u64() {
                    ids.push(id as usize);
                }
                if let Some(values) = value.as_array() {
                    ids.extend(
                        values
                            .iter()
                            .filter_map(|v| v["$node"].as_u64().map(|n| n as usize)),
                    );
                }
                ids
            })
            .collect()
    }
    pub fn start(&self, id: Id) -> usize {
        self.field(id, "start").as_u64().unwrap_or(0) as usize
    }
    pub fn end(&self, id: Id) -> usize {
        self.field(id, "end").as_u64().unwrap_or(0) as usize
    }
    pub fn text(&self, id: Id) -> &str {
        self.source.get(self.start(id)..self.end(id)).unwrap_or("")
    }
    pub fn parent(&self, id: Id) -> Option<Id> {
        self.nodes[id].parent
    }
    pub fn is_function(&self, id: Id) -> bool {
        matches!(
            self.kind(id),
            "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression"
        )
    }
    pub fn unwrap(&self, mut id: Id) -> Id {
        loop {
            match self.kind(id) {
                "ParenthesizedExpression" | "ChainExpression" => {
                    if let Some(next) = self.child(id, "expression") {
                        id = next;
                    } else {
                        return id;
                    }
                }
                "SequenceExpression" => {
                    if let Some(next) = self.array(id, "expressions").last() {
                        id = *next;
                    } else {
                        return id;
                    }
                }
                _ => return id,
            }
        }
    }
    pub fn name(&self, id: Id) -> Option<String> {
        match self.kind(id) {
            "Identifier" => self.field(id, "name").as_str().map(str::to_owned),
            "Literal" => match self.field(id, "value") {
                Value::String(v) => Some(v.clone()),
                Value::Null => Some("null".into()),
                v => Some(v.to_string()),
            },
            "MemberExpression" | "OptionalMemberExpression" => {
                let key = self.child(id, "property")?;
                if self.kind(key) == "Literal" || !self.boolean(id, "computed") {
                    self.name(key)
                } else {
                    None
                }
            }
            _ => {
                let key = self.child(id, "key")?;
                if self.kind(key) == "Literal" || !self.boolean(id, "computed") {
                    self.name(key)
                } else {
                    None
                }
            }
        }
    }
    pub fn property(&self, id: Id, name: &str) -> Option<Id> {
        self.array(self.unwrap(id), "properties")
            .into_iter()
            .find(|id| self.kind(*id) == "Property" && self.name(*id).as_deref() == Some(name))
    }
    pub fn property_value(&self, id: Id, name: &str) -> Option<Id> {
        self.child(self.property(id, name)?, "value")
    }
    pub fn all(&self, within: Id, check: impl Fn(Id) -> bool) -> Vec<Id> {
        (0..self.original_nodes)
            .filter(|id| {
                (*id == within
                    || (self.start(*id) >= self.start(within) && self.end(*id) <= self.end(within)))
                    && check(*id)
            })
            .collect()
    }
    pub fn enclosing(&self, id: Id, check: impl Fn(Id) -> bool) -> Option<Id> {
        let mut parent = self.parent(id);
        while let Some(id) = parent {
            if check(id) {
                return Some(id);
            }
            parent = self.parent(id);
        }
        None
    }
    pub fn return_value(&self, id: Id) -> Option<Id> {
        let id = self.unwrap(id);
        if !self.is_function(id) {
            return None;
        }
        let body = self.child(id, "body")?;
        if self.kind(body) != "BlockStatement" {
            return Some(self.unwrap(body));
        }
        let returns = self.all(body, |node| {
            self.kind(node) == "ReturnStatement"
                && self.enclosing(node, |node| self.is_function(node)) == Some(id)
        });
        if returns.len() == 1 {
            self.child(returns[0], "argument")
                .map(|node| self.unwrap(node))
        } else {
            None
        }
    }
    fn visit(&mut self, id: Id, mut scope: usize) {
        let kind = self.kind(id).to_owned();
        if matches!(kind.as_str(), "FunctionDeclaration" | "ClassDeclaration") {
            if let Some(name) = self.child(id, "id") {
                self.declare(name, scope, Some(id), id);
            }
        }
        if self.is_function(id) {
            scope = self.add_scope(scope, true);
            if kind == "FunctionExpression" {
                if let Some(name) = self.child(id, "id") {
                    self.declare(name, scope, Some(id), id);
                }
            }
            for parameter in self.array(id, "params") {
                self.declare(parameter, scope, None, parameter);
            }
        } else if matches!(
            kind.as_str(),
            "BlockStatement"
                | "CatchClause"
                | "ForStatement"
                | "ForInStatement"
                | "ForOfStatement"
                | "SwitchStatement"
        ) {
            scope = self.add_scope(scope, false);
            if kind == "CatchClause" {
                if let Some(parameter) = self.child(id, "param") {
                    self.declare(parameter, scope, None, id);
                }
            }
        }
        self.nodes[id].scope = scope;
        if kind == "VariableDeclarator" {
            let mut target = scope;
            if self
                .parent(id)
                .is_some_and(|parent| self.field(parent, "kind") == "var")
            {
                while !self.scopes[target].function {
                    target = self.scopes[target].parent.unwrap();
                }
            }
            if let Some(name) = self.child(id, "id") {
                self.declare(name, target, self.child(id, "init"), id);
            }
        }
        if kind == "ImportDeclaration" {
            for specifier in self.array(id, "specifiers") {
                if let Some(name) = self.child(specifier, "local") {
                    self.declare(name, scope, None, specifier);
                }
            }
        }
        for child in self.children(id) {
            self.visit(child, scope);
        }
    }
    fn add_scope(&mut self, parent: usize, function: bool) -> usize {
        let index = self.scopes.len();
        self.scopes.push(Scope {
            parent: Some(parent),
            function,
            names: HashMap::new(),
        });
        index
    }
    fn declare(&mut self, id: Id, scope: usize, init: Option<Id>, declaration: Id) {
        match self.kind(id) {
            "Identifier" => {
                let name = self.field(id, "name").as_str().unwrap_or("").to_owned();
                let binding = if let Some(binding) = self.scopes[scope].names.get(&name).copied() {
                    if self.bindings[binding].init.is_none() && init.is_some() {
                        self.bindings[binding].init = init;
                        self.bindings[binding].declaration = declaration;
                    }
                    binding
                } else {
                    let index = self.bindings.len();
                    self.bindings.push(Binding {
                        node: id,
                        init,
                        declaration,
                        references: Vec::new(),
                    });
                    self.scopes[scope].names.insert(name, index);
                    index
                };
                self.declarations.insert(id, binding);
            }
            "AssignmentPattern" => {
                if let Some(left) = self.child(id, "left") {
                    self.declare(
                        left,
                        scope,
                        init.or_else(|| self.child(id, "right")),
                        declaration,
                    );
                }
            }
            "RestElement" => {
                if let Some(argument) = self.child(id, "argument") {
                    self.declare(argument, scope, None, declaration);
                }
            }
            "ObjectPattern" => {
                for field in self.array(id, "properties") {
                    if self.kind(field) == "RestElement" {
                        if let Some(argument) = self.child(field, "argument") {
                            self.declare(argument, scope, None, declaration);
                        }
                    } else if let Some(value) = self.child(field, "value") {
                        let member = init.zip(self.child(field, "key")).map(|(object, key)| {
                            self.synthetic_member(
                                object,
                                key,
                                self.boolean(field, "computed"),
                                scope,
                            )
                        });
                        self.declare(value, scope, member, declaration);
                    }
                }
            }
            "ArrayPattern" => {
                for (index, element) in self.array(id, "elements").into_iter().enumerate() {
                    let member=init.map(|object|{let key=self.nodes.len();self.nodes.push(Node{data:json!({"type":"Literal","value":index,"start":self.start(object),"end":self.end(object)}).as_object().unwrap().clone(),parent:None,scope});self.synthetic_member(object,key,true,scope)});
                    self.declare(element, scope, member, declaration);
                }
            }
            _ => {}
        }
    }
    fn synthetic_member(&mut self, object: Id, key: Id, computed: bool, scope: usize) -> Id {
        let id = self.nodes.len();
        self.nodes.push(Node{data:json!({"type":"MemberExpression","object":{"$node":object},"property":{"$node":key},"computed":computed,"start":self.start(object),"end":self.end(object)}).as_object().unwrap().clone(),parent:None,scope});
        id
    }
    pub fn binding(&self, id: Id) -> Option<usize> {
        if self.kind(id) != "Identifier" {
            return None;
        }
        if let Some(binding) = self.declarations.get(&id) {
            return Some(*binding);
        }
        let name = self.field(id, "name").as_str()?;
        let mut scope = Some(self.nodes[id].scope);
        while let Some(index) = scope {
            if let Some(binding) = self.scopes[index].names.get(name) {
                return Some(*binding);
            }
            scope = self.scopes[index].parent;
        }
        None
    }
    pub fn binding_node(&self, binding: usize) -> Id {
        self.bindings[binding].node
    }
    pub fn binding_declaration(&self, binding: usize) -> Id {
        self.bindings[binding].declaration
    }
    pub fn binding_init(&self, binding: usize) -> Option<Id> {
        self.bindings[binding].init
    }
    pub fn references(&self, binding: usize) -> &[Id] {
        &self.bindings[binding].references
    }
    pub fn same_binding(&self, left: Id, right: Id) -> bool {
        left == right
            || self
                .binding(left)
                .is_some_and(|binding| self.binding(right) == Some(binding))
    }
    pub fn value(&self, id: Id) -> Id {
        self.resolve_value(id, &mut HashSet::new())
    }
    fn resolve_value(&self, id: Id, seen: &mut HashSet<Id>) -> Id {
        let id = self.unwrap(id);
        if !seen.insert(id) {
            return id;
        }
        if self.kind(id) == "Identifier" {
            if let Some(init) = self
                .binding(id)
                .and_then(|binding| self.bindings[binding].init)
            {
                return self.resolve_value(init, seen);
            }
        }
        if self.kind(id) == "MemberExpression" {
            if let (Some(object), Some(name)) = (self.child(id, "object"), self.name(id)) {
                let object = self.resolve_value(object, seen);
                if let Some(value) = self.property_value(object, &name) {
                    return self.resolve_value(value, seen);
                }
                if self.kind(object) == "ArrayExpression" && self.boolean(id, "computed") {
                    if let Ok(index) = name.parse::<usize>() {
                        if let Some(value) = self
                            .field(object, "elements")
                            .get(index)
                            .and_then(|v| v["$node"].as_u64())
                        {
                            return self.resolve_value(value as usize, seen);
                        }
                    }
                }
            }
        }
        id
    }
    pub fn exports(&self) -> BTreeMap<String, Id> {
        let mut exports = BTreeMap::new();
        for id in 0..self.original_nodes {
            if self.factory && self.kind(id) == "CallExpression" {
                let Some(callee) = self.child(id, "callee").map(|id| self.unwrap(id)) else {
                    continue;
                };
                let args = self.array(id, "arguments");
                let params = self.array(self.root, "params");
                if params.len() < 3 || args.is_empty() || self.name(callee).as_deref() != Some("d")
                {
                    continue;
                }
                if !self
                    .child(callee, "object")
                    .is_some_and(|object| self.same_binding(object, params[2]))
                    || !self.same_binding(args[0], params[1])
                {
                    continue;
                }
                for (index, arg) in args.iter().enumerate().skip(1) {
                    for field in self.array(self.value(*arg), "properties") {
                        if self.kind(field) != "Property" {
                            continue;
                        }
                        let Some(name) = self.name(field) else {
                            continue;
                        };
                        let Some(mut value) = self.child(field, "value") else {
                            continue;
                        };
                        if index == 1
                            && self.is_function(value)
                            && self.array(value, "params").is_empty()
                        {
                            if let Some(returned) = self.return_value(value) {
                                value = returned;
                            }
                        }
                        exports.insert(name, value);
                    }
                }
            } else if !self.factory && self.kind(id) == "ExportNamedDeclaration" {
                for specifier in self.array(id, "specifiers") {
                    if let (Some(exported), Some(local)) = (
                        self.child(specifier, "exported"),
                        self.child(specifier, "local"),
                    ) {
                        if let Some(name) = self.name(exported) {
                            exports.insert(name, local);
                        }
                    }
                }
                if let Some(declaration) = self.child(id, "declaration") {
                    if self.kind(declaration) == "VariableDeclaration" {
                        for item in self.array(declaration, "declarations") {
                            if let Some(name) = self.child(item, "id") {
                                if self.kind(name) == "Identifier" {
                                    exports.insert(self.name(name).unwrap(), name);
                                }
                            }
                        }
                    } else if let Some(name) = self.child(declaration, "id") {
                        exports.insert(self.name(name).unwrap(), name);
                    }
                }
            } else if !self.factory && self.kind(id) == "ExportDefaultDeclaration" {
                if let Some(value) = self.child(id, "declaration") {
                    exports.insert("default".into(), value);
                }
            }
        }
        exports
    }
    pub fn export_name(&self, id: Id) -> Option<String> {
        let value = self.value(id);
        let names = self
            .exports()
            .into_iter()
            .filter(|(_, target)| {
                *target == id || self.same_binding(*target, id) || self.value(*target) == value
            })
            .map(|(name, _)| name)
            .collect::<Vec<_>>();
        if names.len() == 1 {
            names.into_iter().next()
        } else {
            None
        }
    }
}

#[derive(Clone, Debug)]
pub struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

pub fn edits(source: &str, mut edits: Vec<Edit>) -> Result<String, ApiError> {
    edits.sort_by_key(|edit| (edit.start, edit.end));
    let mut end = 0;
    let mut result = String::new();
    for edit in edits {
        if edit.start < end
            || edit.end < edit.start
            || edit.end > source.len()
            || !source.is_char_boundary(edit.start)
            || !source.is_char_boundary(edit.end)
        {
            return Err(ApiError::new(
                422,
                "NATIVE_EDIT",
                "Overlapping or invalid native source edits",
            ));
        }
        result.push_str(&source[end..edit.start]);
        result.push_str(&edit.text);
        end = edit.end;
    }
    result.push_str(&source[end..]);
    Ok(result)
}

pub fn unique(values: Vec<Id>, message: &str) -> Result<Id, ApiError> {
    if values.len() == 1 {
        Ok(values[0])
    } else {
        Err(ApiError::new(422, "NATIVE_CONTRACT", message))
    }
}

pub fn settings_presentation(source: &str) -> Result<Option<String>, ApiError> {
    if !source.contains("3561799561") || source.contains("__codexPanelSettingsPresentationV1__") {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let calls = ast.all(ast.root, |id| {
        ast.kind(id) == "CallExpression"
            && ast
                .array(id, "arguments")
                .first()
                .is_some_and(|id| ast.field(ast.unwrap(*id), "value") == "3561799561")
    });
    if calls.is_empty() {
        return Ok(None);
    }
    let call = unique(calls, "Native settings presentation gate is ambiguous")?;
    let function = ast
        .enclosing(call, |id| ast.is_function(id))
        .ok_or_else(|| {
            ApiError::new(
                422,
                "NATIVE_CONTRACT",
                "Native settings gate has no function",
            )
        })?;
    let mut namespaces = ast
        .all(function, |id| {
            ast.kind(id) == "CallExpression"
                && ast.enclosing(id, |id| ast.is_function(id)) == Some(function)
                && ast.child(id, "callee").is_some_and(|callee| {
                    matches!(
                        ast.name(ast.unwrap(callee)).as_deref(),
                        Some(
                            "useContext"
                                | "useState"
                                | "useEffect"
                                | "useRef"
                                | "useSyncExternalStore"
                        )
                    )
                })
        })
        .into_iter()
        .filter_map(|call| {
            ast.child(call, "callee")
                .and_then(|callee| ast.child(ast.unwrap(callee), "object"))
        })
        .map(|id| ast.text(id).to_owned())
        .collect::<Vec<_>>();
    namespaces.sort();
    namespaces.dedup();
    if namespaces.len() != 1 {
        return Err(ApiError::new(
            422,
            "NATIVE_CONTRACT",
            "Native settings React hooks are unavailable",
        ));
    }
    let runtime = "globalThis.__codexPanelSettingsPresentationV1__";
    let replacement=format!("((native,mode)=>mode===\"system\"?native:mode===\"dialog\")({},(0,{}.useSyncExternalStore)({runtime}.subscribe,{runtime}.getSnapshot))",ast.text(call),namespaces[0]);
    Ok(Some(edits(
        source,
        vec![Edit {
            start: ast.start(call),
            end: ast.end(call),
            text: replacement,
        }],
    )?))
}

pub fn projectless_chat(source: &str) -> Result<Option<String>, ApiError> {
    if !source.contains("canStartProjectlessChat") && !source.contains("startNewConversation") {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let enabled = "globalThis.__codexPanelProjectlessChatV1__?.getSnapshot()===true";
    let selectors = ast.all(ast.root, |id| {
        ast.kind(id) == "ObjectPattern" && ast.property(id, "canStartProjectlessChat").is_some()
    });
    if !selectors.is_empty() {
        let mut functions = selectors
            .iter()
            .filter_map(|id| ast.enclosing(*id, |id| ast.is_function(id)))
            .collect::<Vec<_>>();
        functions.sort();
        functions.dedup();
        let function = unique(functions, "Unsupported default new-chat target")?;
        let branches = ast.all(function, |id| {
            if ast.kind(id) != "IfStatement" {
                return false;
            }
            let Some(body) = ast.child(id, "consequent") else {
                return false;
            };
            let statements = if ast.kind(body) == "BlockStatement" {
                ast.array(body, "body")
            } else {
                vec![body]
            };
            let returns = statements
                .into_iter()
                .filter(|id| ast.kind(*id) == "ReturnStatement")
                .collect::<Vec<_>>();
            if returns.len() != 1 {
                return false;
            }
            let Some(value) = ast.child(returns[0], "argument").map(|id| ast.value(id)) else {
                return false;
            };
            ast.kind(value) == "ObjectExpression"
                && ast
                    .property_value(value, "assignment")
                    .is_some_and(|id| ast.field(ast.unwrap(id), "value").is_null())
                && ast
                    .property_value(value, "kind")
                    .is_some_and(|id| ast.field(ast.unwrap(id), "value") == "projectless")
        });
        if !branches.is_empty() {
            let branch = unique(branches, "Unsupported default new-chat target")?;
            let condition = ast.child(branch, "test").unwrap();
            return Ok(Some(edits(
                source,
                vec![Edit {
                    start: ast.start(condition),
                    end: ast.end(condition),
                    text: format!("({})||{enabled}", ast.text(condition)),
                }],
            )?));
        }
    }
    let Some(action) = ast
        .exports()
        .get("startNewConversation")
        .copied()
        .map(|id| ast.value(id))
    else {
        return Ok(None);
    };
    let actions = ast.all(action, |id| {
        ast.kind(id) == "VariableDeclarator"
            && ast.child(id, "id").is_some_and(|id| {
                ast.kind(id) == "ObjectPattern" && ast.property(id, "activeProject").is_some()
            })
            && ast.enclosing(id, |id| ast.is_function(id)) == Some(action)
    });
    if actions.is_empty() {
        return Ok(None);
    }
    let target = unique(actions, "Unsupported native new-chat action")?;
    let init = ast.child(target, "init").ok_or_else(|| {
        ApiError::new(
            422,
            "NATIVE_CONTRACT",
            "Missing native new-chat initializer",
        )
    })?;
    let parameters = ast.array(action, "params");
    let options = unique(
        ast.all(init, |id| {
            ast.kind(id) == "Identifier"
                && parameters
                    .iter()
                    .any(|parameter| ast.same_binding(*parameter, id))
        }),
        "Unsupported native new-chat options",
    )?;
    let statement = ast
        .parent(target)
        .filter(|id| ast.kind(*id) == "VariableDeclaration")
        .ok_or_else(|| {
            ApiError::new(
                422,
                "NATIVE_CONTRACT",
                "Unsupported native new-chat declaration",
            )
        })?;
    let declarations = ast.array(statement, "declarations");
    let index = declarations.iter().position(|id| *id == target).unwrap();
    let insertion = format!(
        "if({enabled}&&{}?.activeProject===undefined){}={{...{},activeProject:null}};",
        ast.text(options),
        ast.text(options),
        ast.text(options)
    );
    let edit = if index == 0 {
        Edit {
            start: ast.start(statement),
            end: ast.start(statement),
            text: insertion,
        }
    } else {
        Edit {
            start: ast.end(declarations[index - 1]),
            end: ast.start(target),
            text: format!(
                ";{insertion}{} ",
                ast.field(statement, "kind").as_str().unwrap_or("const")
            ),
        }
    };
    Ok(Some(edits(source, vec![edit])?))
}

pub fn queue_rail(source: &str) -> Result<Option<String>, ApiError> {
    if !source.contains("QueuedMessageList") || source.contains("data-codex-panel-queued-messages")
    {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let Some(list) = ast.exports().get("QueuedMessageList").copied() else {
        return Ok(None);
    };
    let component = ast.value(list);
    let items = ast.all(component, |id| {
        if ast.kind(id) != "CallExpression" {
            return false;
        }
        let Some(callee) = ast.child(id, "callee") else {
            return false;
        };
        let args = ast.array(id, "arguments");
        ast.name(ast.unwrap(callee)).as_deref() == Some("jsx")
            && args.len() > 1
            && ast.name(ast.unwrap(args[0])).as_deref() == Some("Item")
            && ast.property_value(args[1], "initial").is_some()
    });
    let item = unique(items, "Native queued-message rail is unsupported")?;
    let props = ast.array(item, "arguments")[1];
    Ok(Some(edits(
        source,
        vec![Edit {
            start: ast.start(props) + 1,
            end: ast.start(props) + 1,
            text: "\"data-codex-panel-queued-messages\":\"\",".into(),
        }],
    )?))
}

pub fn rewrite_entry(source: &str, url: &url::Url) -> Result<String, ApiError> {
    let ast = Ast::parse(source, false)?;
    let registrations = ast.all(ast.root, |id| {
        if ast.kind(id) != "AssignmentExpression" || ast.field(id, "operator") != "=" {
            return false;
        }
        let (Some(left), Some(right)) = (ast.child(id, "left"), ast.child(id, "right")) else {
            return false;
        };
        if ast.kind(left) != "MemberExpression"
            || ast.name(left).as_deref() != Some("m")
            || ast.kind(right) != "Identifier"
        {
            return false;
        }
        let Some(require) = ast.child(left, "object").map(|id| ast.value(id)) else {
            return false;
        };
        ast.is_function(require)
            && !ast
                .all(require, |id| {
                    ast.kind(id) == "MemberExpression"
                        && ast.boolean(id, "computed")
                        && ast
                            .child(id, "object")
                            .is_some_and(|object| ast.same_binding(object, right))
                })
                .is_empty()
    });
    let registration = unique(registrations, "Codex Rspack 模块注册入口不唯一")?;
    let left = ast.child(registration, "left").unwrap();
    let right = ast.child(registration, "right").unwrap();
    let require = ast.child(left, "object").unwrap();
    let mut changes = vec![Edit {
        start: ast.start(registration),
        end: ast.end(registration),
        text: format!(
            "{}={}=globalThis.__codexPanelRspack__?.wrapFactories({},{})??{}",
            ast.text(left),
            ast.text(right),
            ast.text(right),
            ast.text(require),
            ast.text(right)
        ),
    }];
    if let Some(binding) = ast.binding(right) {
        if let Some(statement) = ast.parent(ast.binding_declaration(binding)) {
            if ast.kind(statement) == "VariableDeclaration"
                && ast.field(statement, "kind") == "const"
            {
                changes.push(Edit {
                    start: ast.start(statement),
                    end: ast.start(statement) + 5,
                    text: "let".into(),
                });
            }
        }
    }
    for id in 0..ast.original_nodes {
        if matches!(
            ast.kind(id),
            "ImportDeclaration" | "ExportNamedDeclaration" | "ExportAllDeclaration"
        ) {
            if let Some(target) = ast.child(id, "source") {
                if let Some(path) = ast
                    .field(target, "value")
                    .as_str()
                    .filter(|s| s.starts_with("./") || s.starts_with("../"))
                {
                    changes.push(Edit {
                        start: ast.start(target),
                        end: ast.end(target),
                        text: json!(url
                            .join(path)
                            .map_err(|e| ApiError::new(422, "NATIVE_URL", e.to_string()))?
                            .as_str())
                        .to_string(),
                    });
                }
            }
        } else if ast.kind(id) == "ImportExpression" {
            if let Some(target) = ast.child(id, "source") {
                let first = if ast.kind(target) == "BinaryExpression" {
                    ast.child(target, "left").unwrap_or(target)
                } else {
                    target
                };
                if ast
                    .field(first, "value")
                    .as_str()
                    .is_some_and(|s| s.starts_with("./") || s.starts_with("../"))
                {
                    changes.push(Edit {
                        start: ast.start(target),
                        end: ast.end(target),
                        text: format!("new URL({},{}).href", ast.text(target), json!(url.as_str())),
                    });
                }
            }
        } else if ast.kind(id) == "MemberExpression" && ast.name(id).as_deref() == Some("url") {
            if let Some(object) = ast.child(id, "object") {
                if ast.kind(object) == "MetaProperty"
                    && ast
                        .child(object, "meta")
                        .and_then(|id| ast.name(id))
                        .as_deref()
                        == Some("import")
                    && ast
                        .child(object, "property")
                        .and_then(|id| ast.name(id))
                        .as_deref()
                        == Some("meta")
                {
                    changes.push(Edit {
                        start: ast.start(id),
                        end: ast.end(id),
                        text: json!(url.as_str()).to_string(),
                    });
                }
            }
        }
    }
    edits(source, changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_bindings_exports_and_unicode_ranges() {
        let ast=Ast::parse("function(module,exports,require){const text='😀';const read=()=>text;require.d(exports,{read:()=>read})}",true).unwrap();
        let export = ast.exports()["read"];
        let function = ast.value(export);
        assert!(ast.is_function(function));
        let returned = ast.return_value(function).unwrap();
        let value = ast.value(returned);
        assert_eq!(ast.field(value, "value"), "😀");
        assert_eq!(ast.text(value), "'😀'");
        assert!(edits(
            "😀",
            vec![Edit {
                start: 1,
                end: 2,
                text: "x".into()
            }]
        )
        .is_err());
    }
    #[test]
    fn rewrites_only_settings_gate_and_preserves_native_subscription() {
        let source =
            "function(a,b,c){function Settings(){React.useState(0);return gate('3561799561')}}";
        let rewritten = settings_presentation(source).unwrap().unwrap();
        assert!(rewritten.contains("gate('3561799561')"));
        assert!(rewritten.contains("React.useSyncExternalStore"));
        Ast::parse(&rewritten, true).unwrap();
    }
}
