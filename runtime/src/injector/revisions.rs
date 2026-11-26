use proc_macro2::{TokenStream, TokenTree};
use quote::ToTokens;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use syn::{
    visit::{self, Visit},
    Item, UseTree,
};

pub struct Revisions {
    pub catalog: String,
    pub features: BTreeMap<String, String>,
    pub compose: String,
}

const FEATURE_NAMES: [&str; 12] = [
    "quota",
    "ultrafast",
    "dot",
    "tabs",
    "queue",
    "pets",
    "projectlessChat",
    "repositoryBranchPrefix",
    "settingsPresentation",
    "terminal",
    "nativeUpdate",
    "nativeServices",
];

fn sources() -> BTreeMap<String, String> {
    [
        ("adapters", include_str!("adapters.rs")),
        ("features", include_str!("features.rs")),
        ("source_ast", include_str!("source_ast.rs")),
        ("tabs", include_str!("tabs.rs")),
        ("pets", include_str!("pets.rs")),
        ("repository", include_str!("repository.rs")),
        ("terminal", include_str!("terminal.rs")),
        ("update_bindings", include_str!("update_bindings.rs")),
    ]
    .into_iter()
    .map(|(name, source)| (name.into(), source.into()))
    .collect()
}

fn test_item(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path().is_ident("cfg") && attr.meta.to_token_stream().to_string() == "cfg (test)"
    })
}
fn semantic_attrs(attrs: &mut Vec<syn::Attribute>) {
    attrs.retain(|attr| !attr.path().is_ident("doc"));
}
fn item_attrs(item: &Item) -> Option<&[syn::Attribute]> {
    Some(match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        _ => return None,
    })
}
fn strip_docs(item: &mut Item) {
    match item {
        Item::Const(item) => semantic_attrs(&mut item.attrs),
        Item::Enum(item) => {
            semantic_attrs(&mut item.attrs);
            for value in &mut item.variants {
                semantic_attrs(&mut value.attrs);
                for field in &mut value.fields {
                    semantic_attrs(&mut field.attrs);
                }
            }
        }
        Item::Fn(item) => semantic_attrs(&mut item.attrs),
        Item::Impl(item) => {
            semantic_attrs(&mut item.attrs);
            item.items.retain(|member| !match member {
                syn::ImplItem::Fn(member) => test_item(&member.attrs),
                syn::ImplItem::Const(member) => test_item(&member.attrs),
                syn::ImplItem::Type(member) => test_item(&member.attrs),
                syn::ImplItem::Macro(member) => test_item(&member.attrs),
                _ => false,
            });
            for member in &mut item.items {
                match member {
                    syn::ImplItem::Fn(member) => semantic_attrs(&mut member.attrs),
                    syn::ImplItem::Const(member) => semantic_attrs(&mut member.attrs),
                    syn::ImplItem::Type(member) => semantic_attrs(&mut member.attrs),
                    syn::ImplItem::Macro(member) => semantic_attrs(&mut member.attrs),
                    _ => {}
                }
            }
        }
        Item::Macro(item) => semantic_attrs(&mut item.attrs),
        Item::Mod(item) => semantic_attrs(&mut item.attrs),
        Item::Static(item) => semantic_attrs(&mut item.attrs),
        Item::Struct(item) => {
            semantic_attrs(&mut item.attrs);
            for field in &mut item.fields {
                semantic_attrs(&mut field.attrs);
            }
        }
        Item::Trait(item) => semantic_attrs(&mut item.attrs),
        Item::Type(item) => semantic_attrs(&mut item.attrs),
        Item::Union(item) => semantic_attrs(&mut item.attrs),
        Item::Use(item) => semantic_attrs(&mut item.attrs),
        _ => {}
    }
}
fn simple_type(ty: &syn::Type) -> Option<String> {
    let syn::Type::Path(path) = ty else {
        return None;
    };
    path.path
        .segments
        .last()
        .map(|segment| segment.ident.to_string())
}
fn item_name(item: &Item) -> Option<String> {
    Some(match item {
        Item::Const(item) => item.ident.to_string(),
        Item::Enum(item) => item.ident.to_string(),
        Item::Fn(item) => item.sig.ident.to_string(),
        Item::Static(item) => item.ident.to_string(),
        Item::Struct(item) => item.ident.to_string(),
        Item::Trait(item) => item.ident.to_string(),
        Item::Type(item) => item.ident.to_string(),
        Item::Union(item) => item.ident.to_string(),
        Item::Macro(item) => item.ident.as_ref()?.to_string(),
        _ => return None,
    })
}
fn imports(tree: &UseTree, prefix: &[String], out: &mut BTreeMap<String, Vec<String>>) {
    match tree {
        UseTree::Path(path) => {
            let mut path_prefix = prefix.to_vec();
            path_prefix.push(path.ident.to_string());
            imports(&path.tree, &path_prefix, out);
        }
        UseTree::Name(name) => {
            let mut path = prefix.to_vec();
            if name.ident != "self" {
                path.push(name.ident.to_string());
            }
            out.insert(name.ident.to_string(), path);
        }
        UseTree::Rename(rename) => {
            let mut path = prefix.to_vec();
            path.push(rename.ident.to_string());
            out.insert(rename.rename.to_string(), path);
        }
        UseTree::Group(group) => {
            for tree in &group.items {
                imports(tree, prefix, out);
            }
        }
        UseTree::Glob(_) => {}
    }
}
struct Module {
    items: BTreeMap<String, Item>,
    impls: BTreeMap<String, Vec<syn::ItemImpl>>,
    imports: BTreeMap<String, Vec<String>>,
}
impl Module {
    fn parse(source: &str) -> Self {
        let parsed = syn::parse_file(source).expect("Embedded injector source must parse as Rust");
        let mut module = Self {
            items: BTreeMap::new(),
            impls: BTreeMap::new(),
            imports: BTreeMap::new(),
        };
        for mut item in parsed.items {
            if item_attrs(&item).is_some_and(test_item) {
                continue;
            }
            strip_docs(&mut item);
            if let Item::Use(item) = item {
                imports(&item.tree, &[], &mut module.imports);
            } else if let Item::Impl(item) = item {
                if let Some(name) = simple_type(&item.self_ty) {
                    module.impls.entry(name).or_default().push(item);
                }
            } else if let Some(name) = item_name(&item) {
                module.items.insert(name, item);
            }
        }
        module
    }
}

fn pattern_matches(pattern: &syn::Pat, feature: &str) -> bool {
    match pattern {
        syn::Pat::Lit(value) => {
            matches!(&value.lit, syn::Lit::Str(value) if value.value() == feature)
        }
        syn::Pat::Or(value) => value
            .cases
            .iter()
            .any(|value| pattern_matches(value, feature)),
        _ => false,
    }
}
struct FeatureSlice<'a> {
    feature: &'a str,
}
impl syn::fold::Fold for FeatureSlice<'_> {
    fn fold_expr_match(&mut self, mut expression: syn::ExprMatch) -> syn::ExprMatch {
        if matches!(expression.expr.as_ref(), syn::Expr::Path(path) if path.path.is_ident("feature"))
        {
            let selected = expression
                .arms
                .iter()
                .find(|arm| pattern_matches(&arm.pat, self.feature))
                .or_else(|| {
                    expression
                        .arms
                        .iter()
                        .find(|arm| matches!(arm.pat, syn::Pat::Wild(_)))
                })
                .cloned();
            if let Some(selected) = selected {
                expression.arms = vec![selected];
            }
        }
        syn::fold::fold_expr_match(self, expression)
    }
}

#[derive(Default)]
struct References {
    paths: BTreeSet<Vec<String>>,
}
impl References {
    fn tokens(&mut self, stream: TokenStream) {
        let tokens = stream.into_iter().collect::<Vec<_>>();
        for (index, token) in tokens.iter().enumerate() {
            match token {
                TokenTree::Group(group) => self.tokens(group.stream()),
                TokenTree::Ident(ident) => {
                    let mut path = vec![ident.to_string()];
                    let mut cursor = index;
                    while matches!(tokens.get(cursor+1),Some(TokenTree::Punct(value)) if value.as_char()==':')
                        && matches!(tokens.get(cursor+2),Some(TokenTree::Punct(value)) if value.as_char()==':')
                    {
                        let Some(TokenTree::Ident(value)) = tokens.get(cursor + 3) else {
                            break;
                        };
                        path.push(value.to_string());
                        cursor += 3;
                    }
                    self.paths.insert(path);
                }
                _ => {}
            }
        }
    }
}
impl<'ast> Visit<'ast> for References {
    fn visit_path(&mut self, path: &'ast syn::Path) {
        self.paths.insert(
            path.segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect(),
        );
        visit::visit_path(self, path);
    }
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        self.visit_path(&mac.path);
        self.tokens(mac.tokens.clone());
    }
}

#[derive(Clone, Copy)]
enum Mode<'a> {
    Feature(&'a str),
    Catalog,
    Compose,
}
struct Graph {
    modules: BTreeMap<String, Module>,
    parser: String,
}
impl Graph {
    fn new(sources: &BTreeMap<String, String>, lock: &str) -> Self {
        let modules = sources
            .iter()
            .map(|(name, source)| (name.clone(), Module::parse(source)))
            .collect();
        let lock: toml::Value = toml::from_str(lock).expect("Embedded runtime lockfile must parse");
        let versions = lock["package"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|package| {
                let name = package["name"].as_str()?;
                (name.starts_with("oxc_") || name == "serde_json").then(|| {
                    (
                        name.to_owned(),
                        package["version"].as_str().unwrap().to_owned(),
                    )
                })
            })
            .collect::<BTreeMap<_, _>>();
        Self {
            modules,
            parser: serde_json::to_string(&versions).unwrap(),
        }
    }
    fn resolve(&self, module: &str, path: &[String]) -> Option<(String, String)> {
        let source = self.modules.get(module)?;
        let first = path.first()?;
        let mut path = if let Some(alias) = source.imports.get(first) {
            let mut expanded = alias.clone();
            expanded.extend(path.iter().skip(1).cloned());
            expanded
        } else {
            path.to_vec()
        };
        while matches!(path.first().map(String::as_str), Some("super" | "self")) {
            path.remove(0);
        }
        if path
            .first()
            .is_some_and(|name| self.modules.contains_key(name))
        {
            return Some((path[0].clone(), path.get(1)?.clone()));
        }
        let local = path.first()?;
        if source.items.contains_key(local) || source.impls.contains_key(local) {
            return Some((module.into(), local.clone()));
        }
        None
    }
    fn digest(&self, roots: &[(&str, &str)], mode: Mode<'_>) -> String {
        let mut pending = roots
            .iter()
            .map(|(module, item)| (module.to_string(), item.to_string()))
            .collect::<Vec<_>>();
        let mut parts = BTreeMap::new();
        while let Some((module, name)) = pending.pop() {
            let key = format!("{module}::{name}");
            if parts.contains_key(&key) {
                continue;
            }
            let Some(source) = self.modules.get(&module) else {
                continue;
            };
            let mut tokens = TokenStream::new();
            let mut references = References::default();
            if let Some(item) = source.items.get(&name) {
                let mut item = item.clone();
                if let Mode::Feature(feature) = mode {
                    item = syn::fold::Fold::fold_item(&mut FeatureSlice { feature }, item);
                }
                references.visit_item(&item);
                item.to_tokens(&mut tokens);
            }
            if let Some(impls) = source.impls.get(&name) {
                for item in impls {
                    references.visit_item_impl(item);
                    item.to_tokens(&mut tokens);
                }
            }
            if tokens.is_empty() {
                continue;
            }
            parts.insert(key, tokens.to_string());
            for path in references.paths {
                let Some(target) = self.resolve(&module, &path) else {
                    continue;
                };
                // Progress reporting does not change native analysis or generated patches.
                if target.0 == "adapters"
                    && matches!(target.1.as_str(), "ModuleProgress" | "ProgressCallback")
                {
                    continue;
                }
                if matches!(mode, Mode::Compose)
                    && target.0 == "adapters"
                    && matches!(
                        target.1.as_str(),
                        "transform" | "candidate" | "build_feature"
                    )
                {
                    continue;
                }
                pending.push(target);
            }
        }
        let mut digest = Sha256::new();
        digest.update(b"rust-injector-source-closure-v1\0");
        digest.update(serde_json::to_vec(&parts).unwrap());
        if parts
            .keys()
            .any(|key| key.starts_with("source_ast::") || key == "adapters::parse_factories")
        {
            digest.update(self.parser.as_bytes());
        }
        hex::encode(digest.finalize())
    }
    fn revisions(&self) -> Revisions {
        let catalog = self.digest(&[("adapters", "read_catalog_progress")], Mode::Catalog);
        let mut features = BTreeMap::new();
        for feature in FEATURE_NAMES {
            let mut roots = vec![
                ("adapters", "candidate"),
                ("adapters", "transform"),
                ("adapters", "build_feature"),
            ];
            match feature {
                "nativeServices" => roots.push(("adapters", "build_services")),
                "nativeUpdate" => roots.push(("adapters", "build_update")),
                _ => {}
            }
            features.insert(feature.into(), self.digest(&roots, Mode::Feature(feature)));
        }
        let compose = self.digest(&[("adapters", "compose_plans")], Mode::Compose);
        Revisions {
            catalog,
            features,
            compose,
        }
    }
}

pub fn revisions() -> Revisions {
    Graph::new(&sources(), include_str!("../../Cargo.lock")).revisions()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute(sources: &BTreeMap<String, String>) -> Revisions {
        Graph::new(sources, include_str!("../../Cargo.lock")).revisions()
    }
    fn change_function(sources: &mut BTreeMap<String, String>, module: &str, name: &str) {
        let file = syn::parse_file(&sources[module]).unwrap();
        let mut changed = false;
        let items = file
            .items
            .into_iter()
            .map(|mut item| {
                if let Item::Fn(function) = &mut item {
                    if function.sig.ident == name {
                        function
                            .block
                            .stmts
                            .insert(0, syn::parse_quote!(let _revision_fixture_change = 1;));
                        changed = true;
                    }
                }
                item
            })
            .collect::<Vec<_>>();
        assert!(changed, "Missing fixture function {module}::{name}");
        sources.insert(module.into(), quote::quote!(#(#items)*).to_string());
    }
    #[test]
    fn unrelated_entry_changes_preserve_other_feature_caches() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        change_function(&mut changed, "features", "dot");
        let after = compute(&changed);
        assert_ne!(before.features["dot"], after.features["dot"]);
        for feature in ["quota", "ultrafast", "queue", "terminal"] {
            assert_eq!(
                before.features[feature], after.features[feature],
                "Unrelated {feature} invalidated"
            );
        }
        assert_eq!(before.catalog, after.catalog);
        assert_eq!(before.compose, after.compose);
    }
    #[test]
    fn shared_helper_changes_invalidate_only_dependent_entries() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        change_function(&mut changed, "features", "native_provider");
        let after = compute(&changed);
        for feature in ["quota", "ultrafast"] {
            assert_ne!(
                before.features[feature], after.features[feature],
                "Shared helper missing from {feature}"
            );
        }
        for feature in ["dot", "queue", "terminal"] {
            assert_eq!(
                before.features[feature], after.features[feature],
                "Unrelated {feature} invalidated"
            );
        }
    }
    #[test]
    fn terminal_changes_do_not_invalidate_other_modules() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        change_function(&mut changed, "terminal", "rewrite");
        let after = compute(&changed);
        for feature in FEATURE_NAMES {
            if feature == "terminal" {
                assert_ne!(before.features[feature], after.features[feature]);
            } else {
                assert_eq!(
                    before.features[feature], after.features[feature],
                    "Terminal edit invalidated {feature}"
                );
            }
        }
        assert_eq!(before.catalog, after.catalog);
        assert_eq!(before.compose, after.compose);
    }
    #[test]
    fn comments_tests_and_browser_runtime_are_not_planner_dependencies() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        changed.get_mut("features").unwrap().push_str("\n// unrelated comment\n#[cfg(test)] mod additional_test { #[test] fn new_assertion() { assert!(true); } }\n");
        changed.insert("browser_runtime".into(), "fn changed_animation() {}".into());
        let after = compute(&changed);
        assert_eq!(before.features, after.features);
        assert_eq!(before.catalog, after.catalog);
        assert_eq!(before.compose, after.compose);
    }
    #[test]
    fn progress_only_helper_changes_preserve_planner_caches() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        let mut file = syn::parse_file(&changed["adapters"]).unwrap();
        let mut found = false;
        for item in &mut file.items {
            let Item::Impl(item) = item else {
                continue;
            };
            if simple_type(&item.self_ty).as_deref() != Some("ModuleProgress") {
                continue;
            }
            for member in &mut item.items {
                let syn::ImplItem::Fn(function) = member else {
                    continue;
                };
                if function.sig.ident == "advance" {
                    function.block.stmts.insert(
                        0,
                        syn::parse_quote!(let _progress_display_change = "new label";),
                    );
                    found = true;
                }
            }
        }
        assert!(found, "Missing progress helper fixture");
        changed.insert("adapters".into(), file.to_token_stream().to_string());
        let after = compute(&changed);
        assert_eq!(before.catalog, after.catalog);
        assert_eq!(before.features, after.features);
        assert_eq!(before.compose, after.compose);
    }
    #[test]
    fn parser_core_and_version_are_catalog_dependencies() {
        let original = sources();
        let before = compute(&original);
        let mut changed = original.clone();
        changed.insert(
            "source_ast".into(),
            original["source_ast"].replacen(
                "let parsed_source =",
                "let _parser_fixture = 1; let parsed_source =",
                1,
            ),
        );
        let after = compute(&changed);
        assert_ne!(before.catalog, after.catalog);
        assert_ne!(before.features["quota"], after.features["quota"]);
        let lock = include_str!("../../Cargo.lock");
        let changed_lock = lock.replacen(
            "name = \"oxc_parser\"\nversion = \"0.75.1\"",
            "name = \"oxc_parser\"\nversion = \"0.75.2\"",
            1,
        );
        assert_ne!(
            before.catalog,
            Graph::new(&original, &changed_lock).revisions().catalog
        );
    }
}
