use super::source_ast::{self, Ast};
use super::{cdp::Connection, config::Environment};
use crate::ApiError;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Variant {
    pub source: String,
    pub chunks: Vec<Value>,
    pub asset_size: usize,
}
pub struct Module {
    pub source: String,
    pub exports: Vec<String>,
    pub variants: Vec<Variant>,
}
pub struct Catalog {
    pub main_url_path: String,
    pub main_source: String,
    pub digest: String,
    pub modules: BTreeMap<String, Module>,
    pub unreadable: Vec<Value>,
}

fn identity(path: &Path) -> Result<String, ApiError> {
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    let mut digest = Sha256::new();
    let mut bytes = [0; 64 * 1024];
    loop {
        let length = file.read(&mut bytes)?;
        if length == 0 {
            break;
        }
        digest.update(&bytes[..length]);
    }
    let after = file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(ApiError::new(
            409,
            "ASAR_CHANGED",
            "Codex app.asar 在读取期间发生变化",
        ));
    }
    Ok(hex::encode(digest.finalize()))
}

fn planner_revision() -> String {
    let mut hash = Sha256::new();
    for source in [
        include_str!("adapters.rs"),
        include_str!("source_ast.rs"),
        include_str!("features.rs"),
        include_str!("tabs.rs"),
        include_str!("pets.rs"),
        include_str!("repository.rs"),
        include_str!("update_bindings.rs"),
    ] {
        hash.update(source.as_bytes());
    }
    hash.update(b"rust-rspack-cache-v1");
    hex::encode(hash.finalize())
}

fn cache_valid(plan: &Value, pets_only: bool) -> bool {
    (if pets_only {
        &["pets"][..]
    } else {
        &IMPLEMENTED_FEATURES[..]
    })
    .iter()
    .all(|name| plan["prepared"][*name] == true)
        && plan["errors"]
            .as_object()
            .is_some_and(|errors| errors.is_empty())
        && plan["patches"].as_object().is_some_and(|patches| {
            patches.values().all(|variants| {
                variants.as_array().is_some_and(|variants| {
                    variants.iter().all(|variant| {
                        variant["before"].is_string()
                            && variant["after"].is_string()
                            && variant["features"].is_array()
                    })
                })
            })
        })
        && plan["chunks"].is_object()
        && plan["nativeServices"].is_object()
        && plan["nativeUpdate"].is_object()
}

fn cached_plan(
    path: &Path,
    directory: &Path,
    pets_only: bool,
) -> Result<Option<(Catalog, Value)>, ApiError> {
    let digest = identity(path)?;
    let revision = planner_revision();
    let key = hex::encode(Sha256::digest(
        format!("{digest}:{revision}:{pets_only}").as_bytes(),
    ));
    let cached = directory.join(format!("rust-{key}.json"));
    if let Ok(metadata) = std::fs::metadata(&cached) {
        if metadata.is_file() && metadata.len() <= 256 * 1024 * 1024 {
            if let Ok(value) = std::fs::read(&cached)
                .map_err(ApiError::from)
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(ApiError::from))
            {
                let expected = hex::encode(Sha256::digest(
                    json!([value["main"], value["plan"]]).to_string().as_bytes(),
                ));
                if value["format"] == 1
                    && value["key"] == key
                    && value["checksum"] == expected
                    && cache_valid(&value["plan"], pets_only)
                {
                    if let (Some(main), Some(source)) = (
                        value["main"]["urlPath"].as_str(),
                        value["main"]["source"].as_str(),
                    ) {
                        return Ok(Some((
                            Catalog {
                                main_url_path: main.into(),
                                main_source: source.into(),
                                digest,
                                modules: BTreeMap::new(),
                                unreadable: Vec::new(),
                            },
                            value["plan"].clone(),
                        )));
                    }
                }
            }
        }
    }
    let Some(catalog) = read_catalog(path)? else {
        return Ok(None);
    };
    let plan = if pets_only {
        build_plan_selected(&catalog, &["pets"], true)?
    } else {
        build_plan(&catalog)?
    };
    if catalog.digest != digest {
        return Err(ApiError::new(
            409,
            "ASAR_CHANGED",
            "Codex app.asar 在准备适配期间发生变化",
        ));
    }
    if cache_valid(&plan, pets_only) {
        let main = json!({"urlPath":catalog.main_url_path,"source":catalog.main_source});
        let checksum = hex::encode(Sha256::digest(json!([main, plan]).to_string().as_bytes()));
        let value = json!({"format":1,"key":key,"main":main,"plan":plan,"checksum":checksum});
        std::fs::create_dir_all(directory)?;
        let temporary = directory.join(format!(".rust-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<(), ApiError> {
            use std::io::Write;
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&value)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &cached)?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&temporary);
        result?;
    }
    Ok(Some((catalog, plan)))
}

struct Archive {
    file: File,
    length: u64,
    base: u64,
    entries: BTreeMap<String, Value>,
}
impl Archive {
    fn open(path: &Path) -> Result<Self, ApiError> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let mut prefix = [0u8; 16];
        file.read_exact(&mut prefix)?;
        let header = u32::from_le_bytes(prefix[4..8].try_into().unwrap()) as u64;
        let json_len = u32::from_le_bytes(prefix[12..16].try_into().unwrap()) as u64;
        if json_len > header || header + 8 > length {
            return Err(ApiError::new(422, "ASAR_INDEX", "Codex app.asar 索引无效"));
        }
        let mut bytes = vec![0; json_len as usize];
        file.read_exact(&mut bytes)?;
        let tree: Value = serde_json::from_slice(&bytes)?;
        let mut entries = BTreeMap::new();
        fn walk(tree: &Value, parent: &str, entries: &mut BTreeMap<String, Value>) {
            for (name, entry) in tree["files"].as_object().into_iter().flatten() {
                let key = if parent.is_empty() {
                    name.clone()
                } else {
                    format!("{parent}/{name}")
                };
                if entry["files"].is_object() {
                    walk(entry, &key, entries);
                } else {
                    entries.insert(key, entry.clone());
                }
            }
        }
        walk(&tree, "", &mut entries);
        Ok(Self {
            file,
            length,
            base: header + 8,
            entries,
        })
    }
    fn source(&mut self, name: &str) -> Result<String, ApiError> {
        let entry = self
            .entries
            .get(name)
            .ok_or_else(|| ApiError::new(422, "ASAR_ENTRY", format!("Codex 资源缺失：{name}")))?;
        if entry["unpacked"] == true || entry.get("link").is_some() {
            return Err(ApiError::new(
                422,
                "ASAR_ENTRY",
                format!("Codex 资源不可读取：{name}"),
            ));
        }
        let offset = entry["offset"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .or_else(|| entry["offset"].as_u64())
            .ok_or_else(|| ApiError::new(422, "ASAR_ENTRY", "Invalid ASAR offset"))?;
        let size = entry["size"]
            .as_u64()
            .ok_or_else(|| ApiError::new(422, "ASAR_ENTRY", "Invalid ASAR entry size"))?;
        let end = self
            .base
            .checked_add(offset)
            .and_then(|value| value.checked_add(size))
            .ok_or_else(|| ApiError::new(422, "ASAR_ENTRY", "ASAR entry overflow"))?;
        if end > self.length {
            return Err(ApiError::new(
                422,
                "ASAR_ENTRY",
                "ASAR entry exceeds archive bounds",
            ));
        }
        self.file.seek(SeekFrom::Start(self.base + offset))?;
        let mut bytes = vec![0; size as usize];
        self.file.read_exact(&mut bytes)?;
        String::from_utf8(bytes)
            .map_err(|_| ApiError::new(422, "ASAR_ENTRY", "Codex source is not UTF-8"))
    }
}

pub fn archive_path(app: &Path) -> PathBuf {
    if app.extension().is_some_and(|extension| extension == "app") {
        app.join("Contents/Resources/app.asar")
    } else if app == Path::new("/usr/bin/chatgpt") {
        PathBuf::from("/usr/lib/chatgpt/resources/app.asar")
    } else {
        app.parent().unwrap_or(app).join("resources/app.asar")
    }
}

pub fn read_catalog(path: &Path) -> Result<Option<Catalog>, ApiError> {
    let mut archive = Archive::open(path)?;
    let before = archive.file.metadata()?;
    archive.file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = archive.file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = hex::encode(digest.finalize());
    let html = archive.source("webview/index.html")?;
    let script = regex::Regex::new(r#"<script\b[^>]*\bsrc=["']([^"']+\.js)["'][^>]*>"#).unwrap();
    let mut main = None;
    for capture in script.captures_iter(&html) {
        let url = &capture[1];
        let source = archive.source(&format!("webview/{}", url.trim_start_matches('/')))?;
        if source.contains("__webpack_require__")
            && Ast::parse(&source, false)?
                .exports()
                .contains_key("__webpack_require__")
        {
            main = Some((url.to_owned(), source));
        }
    }
    let Some((main_url_path, main_source)) = main else {
        return Ok(None);
    };
    let assets = archive
        .entries
        .keys()
        .filter(|name| name.starts_with("webview/") && name.ends_with(".js"))
        .cloned()
        .collect::<Vec<_>>();
    let mut modules = BTreeMap::<String, Module>::new();
    let mut unreadable = Vec::new();
    for name in assets {
        let source = archive.source(&name)?;
        if !source.contains("__webpack_modules__") {
            continue;
        }
        let parsed = parse_factories(&source);

        match parsed {
            Ok(entries) => {
                for (id, variant, exports) in entries {
                    if let Some(previous) = modules.get_mut(&id) {
                        previous.exports.extend(exports);
                        previous.exports.sort();
                        previous.exports.dedup();
                        if variant.asset_size
                            < previous
                                .variants
                                .iter()
                                .map(|variant| variant.asset_size)
                                .min()
                                .unwrap_or(usize::MAX)
                        {
                            previous.source = variant.source.clone();
                        }
                        if !previous
                            .variants
                            .iter()
                            .any(|old| old.source == variant.source)
                        {
                            previous.variants.push(variant);
                        }
                    } else {
                        modules.insert(
                            id,
                            Module {
                                source: variant.source.clone(),
                                exports,
                                variants: vec![variant],
                            },
                        );
                    }
                }
            }
            Err(error) => unreadable.push(json!({"name":name,"message":error.message})),
        }
    }
    let after = archive.file.metadata()?;
    if before.len() != after.len() || before.modified()? != after.modified()? {
        return Err(ApiError::new(
            409,
            "ASAR_CHANGED",
            "Codex app.asar 在读取期间发生变化",
        ));
    }
    Ok(Some(Catalog {
        main_url_path,
        main_source,
        digest,
        modules,
        unreadable,
    }))
}

pub(super) fn read_esm_sources(path: &Path) -> Result<Vec<(String, String)>, ApiError> {
    let mut archive = Archive::open(path)?;
    let names = archive
        .entries
        .keys()
        .filter(|name| name.starts_with("webview/") && name.ends_with(".js"))
        .cloned()
        .collect::<Vec<_>>();
    names
        .into_iter()
        .map(|name| {
            Ok((
                format!("/{}", name.trim_start_matches("webview/")),
                archive.source(&name)?,
            ))
        })
        .collect()
}

fn parse_factories(source: &str) -> Result<Vec<(String, Variant, Vec<String>)>, ApiError> {
    use oxc_ast::ast::{
        BindingPatternKind, Declaration, Expression, ObjectPropertyKind, Statement,
    };
    use oxc_span::{GetSpan, SourceType};
    let allocator = oxc_allocator::Allocator::default();
    let parsed = oxc_parser::Parser::new(&allocator, source, SourceType::mjs())
        .with_options(oxc_parser::ParseOptions {
            preserve_parens: false,
            ..oxc_parser::ParseOptions::default()
        })
        .parse();
    if let Some(error) = parsed.errors.first() {
        return Err(ApiError::new(
            422,
            "RSPACK_SOURCE",
            format!("Cannot parse native chunk: {error}"),
        ));
    }
    let mut table = None;
    let mut chunks = Vec::new();
    fn literal(value: &Expression<'_>) -> Option<Value> {
        match value {
            Expression::NumericLiteral(value) => Some(
                if value.value.fract() == 0.0
                    && value.value >= 0.0
                    && value.value <= u64::MAX as f64
                {
                    json!(value.value as u64)
                } else {
                    json!(value.value)
                },
            ),
            Expression::StringLiteral(value) => Some(json!(value.value.as_str())),
            _ => None,
        }
    }
    for statement in &parsed.program.body {
        let Statement::ExportNamedDeclaration(export) = statement else {
            continue;
        };
        let Some(Declaration::VariableDeclaration(declaration)) = &export.declaration else {
            continue;
        };
        for item in &declaration.declarations {
            let BindingPatternKind::BindingIdentifier(id) = &item.id.kind else {
                continue;
            };
            let Some(value) = &item.init else {
                continue;
            };
            match id.name.as_str() {
                "__webpack_modules__" => {
                    if let Expression::ObjectExpression(object) = value {
                        table = Some(object);
                    } else {
                        return Err(ApiError::new(
                            422,
                            "RSPACK_EXPORTS",
                            "Unsupported Rspack chunk exports",
                        ));
                    }
                }
                "__rspack_esm_ids" | "__rspack_esm_id" => {
                    chunks = if let Expression::ArrayExpression(array) = value {
                        array
                            .elements
                            .iter()
                            .map(|item| {
                                item.as_expression().and_then(literal).ok_or_else(|| {
                                    ApiError::new(
                                        422,
                                        "RSPACK_EXPORTS",
                                        "Unsupported Rspack chunk identifier",
                                    )
                                })
                            })
                            .collect::<Result<Vec<_>, _>>()?
                    } else {
                        vec![literal(value).ok_or_else(|| {
                            ApiError::new(
                                422,
                                "RSPACK_EXPORTS",
                                "Unsupported Rspack chunk identifier",
                            )
                        })?]
                    };
                }
                _ => {}
            }
        }
    }
    let Some(table) = table else {
        return Ok(Vec::new());
    };
    let mut result = Vec::new();
    // 索引阶段只读取 Oxc 的借用 AST 和源码范围，不把整个大型 chunk 转成 JSON 树。
    for property in &table.properties {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            continue;
        };
        if !matches!(
            &property.value,
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_)
        ) {
            continue;
        }
        let Some(id) = property.key.static_name() else {
            continue;
        };
        let span = property.value.span();
        let text = &source[span.start as usize..span.end as usize];
        let text = if property.method {
            format!("function{text}")
        } else {
            text.into()
        };
        let normalized = normalize_factory(&text);
        // 只有桌面服务扫描需要提前列出 export，其他模块在真正追踪绑定时按需解析。
        let exports = if normalized.contains("appServices") {
            Ast::parse(&normalized, true)?
                .exports()
                .into_keys()
                .collect()
        } else {
            Vec::new()
        };
        result.push((
            id.into_owned(),
            Variant {
                source: normalized,
                chunks: chunks.clone(),
                asset_size: source.len(),
            },
            exports,
        ));
    }
    Ok(result)
}

fn normalize_factory(source: &str) -> String {
    let function = regex::Regex::new(r"^(?:async\s+)?function\b").unwrap();
    if function.is_match(source) {
        return source.into();
    }
    regex::Regex::new(r"^(async\s+)?[^ (]+\s*\(")
        .unwrap()
        .replace(source, "${1}function(")
        .into_owned()
}

const IMPLEMENTED_FEATURES: [&str; 9] = [
    "quota",
    "ultrafast",
    "dot",
    "tabs",
    "queue",
    "pets",
    "projectlessChat",
    "repositoryBranchPrefix",
    "settingsPresentation",
];
fn candidate(feature: &str, source: &str) -> bool {
    match feature {
        "quota" => source.contains("data-codex-composer-root"),
        "ultrafast" => source.contains("serviceTierSettings"),
        "dot" => source.contains("isCapable"),
        "tabs" => ["paneItems", "dataAttributes", "navigationState"]
            .iter()
            .any(|term| source.contains(term)),
        "queue" => source.contains("queuedMessages") || source.contains("QueuedMessageList"),
        "pets" => [
            "The original Codex companion.",
            "/settings/account_user_setting",
            "data-codex-pet-state",
        ]
        .iter()
        .any(|term| source.contains(term)),
        "projectlessChat" => {
            source.contains("canStartProjectlessChat") || source.contains("startNewConversation")
        }
        "repositoryBranchPrefix" => [
            "branchPrefix",
            "readCreationInputs",
            "readDeveloperInstructions",
        ]
        .iter()
        .any(|term| source.contains(term)),
        "settingsPresentation" => source.contains("3561799561"),
        _ => false,
    }
}
fn transform(
    feature: &str,
    source: &str,
    module: &str,
    context: &super::features::Context,
) -> Result<Option<String>, ApiError> {
    match feature {
        "quota" => super::features::quota(source, module, context),
        "ultrafast" => super::features::ultrafast(source, module, context),
        "dot" => super::features::dot(source, module, context),
        "tabs" => super::tabs::rewrite(source, module, context),
        "queue" => super::features::queue(source, module, context),
        "pets" => super::pets::rewrite(source, module, context),
        "projectlessChat" => source_ast::projectless_chat(source),
        "repositoryBranchPrefix" => super::repository::rewrite(source, module, context),
        "settingsPresentation" => source_ast::settings_presentation(source),
        _ => Err(ApiError::new(
            500,
            "NATIVE_FEATURE",
            "Unknown native feature",
        )),
    }
}

pub fn build_plan(catalog: &Catalog) -> Result<Value, ApiError> {
    build_plan_selected(catalog, &IMPLEMENTED_FEATURES, false)
}

fn build_plan_selected(
    catalog: &Catalog,
    selected: &[&str],
    pets_only: bool,
) -> Result<Value, ApiError> {
    let context = super::features::Context::new(catalog);
    let mut plan = json!({"patches":{},"prepared":{},"errors":{},"chunks":{},"nativeServices":{},"nativeUpdate":{}});
    for &feature in selected {
        plan["prepared"][feature] = json!(false);
        plan["errors"][feature] = json!("Rust adapter migration is incomplete");
    }
    let mut desktop = Vec::new();
    let mut counts = BTreeMap::<&str, usize>::new();
    let mut failures = BTreeMap::<&str, String>::new();
    for (id, module) in &catalog.modules {
        if module.exports.iter().any(|name| name == "appServices") {
            let ast = Ast::parse(&module.source, true)?;
            let exports = ast.exports();
            if let (Some(value), Some(setter)) =
                (exports.get("appServices"), exports.get("setAppServices"))
            {
                let setter = ast.value(*setter);
                let parameters = ast.array(setter, "params");
                if ast.is_function(setter)
                    && parameters.len() == 1
                    && !ast
                        .all(setter, |node| {
                            ast.kind(node) == "AssignmentExpression"
                                && ast.field(node, "operator") == "="
                                && ast
                                    .child(node, "left")
                                    .is_some_and(|left| ast.same_binding(left, *value))
                                && ast
                                    .child(node, "right")
                                    .is_some_and(|right| ast.same_binding(right, parameters[0]))
                        })
                        .is_empty()
                {
                    desktop.push(json!({"id":id,"exportName":"appServices"}));
                }
            }
        }
        for variant in &module.variants {
            if !selected
                .iter()
                .any(|feature| candidate(feature, &variant.source))
            {
                continue;
            }
            context.set_source(id, &variant.source)?;
            for &feature in selected {
                match transform(feature, &variant.source, id, &context) {
                    Ok(Some(changed)) => {
                        Ast::parse(&changed, true)?;
                        *counts.entry(feature).or_default() += 1;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        failures.insert(feature, error.message);
                    }
                }
            }
        }
        context.set_source(id, &module.source)?;
    }
    for &feature in selected {
        let enabled =
            counts.get(feature).copied().unwrap_or(0) > 0 && !failures.contains_key(feature);
        plan["prepared"][feature] = json!(enabled);
        if enabled {
            plan["errors"].as_object_mut().unwrap().remove(feature);
        } else {
            plan["errors"][feature] = json!(failures
                .get(feature)
                .cloned()
                .unwrap_or_else(|| "未找到兼容的原生模块".into()));
        }
    }
    // 任一模块的能力识别失败就整项停用，不能让局部改写破坏未覆盖的调用者。
    for (id, module) in &catalog.modules {
        for variant in &module.variants {
            if !selected.iter().any(|feature| {
                plan["prepared"][*feature] == true && candidate(feature, &variant.source)
            }) {
                continue;
            }
            let mut after = variant.source.clone();
            let mut features = Vec::new();
            context.set_source(id, &after)?;
            for &feature in selected {
                if plan["prepared"][feature] != true {
                    continue;
                }
                if let Some(changed) = transform(feature, &after, id, &context)? {
                    Ast::parse(&changed, true)?;
                    after = changed;
                    context.set_source(id, &after)?;
                    features.push(feature);
                }
            }
            if !features.is_empty() {
                if !plan["patches"][id].is_array() {
                    plan["patches"][id] = json!([]);
                }
                plan["patches"][id]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"before":variant.source,"after":after,"features":features}));
                plan["chunks"][id] = json!(variant.chunks);
            }
        }
        context.set_source(id, &module.source)?;
    }
    for id in context.selected.borrow().iter() {
        plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
    }
    if pets_only {
    } else if desktop.len() == 1 {
        let id = desktop[0]["id"].as_str().unwrap();
        plan["nativeServices"]["desktopServices"] = desktop[0].clone();
        plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
    } else {
        plan["errors"]["nativeServices"] = json!(if desktop.is_empty() {
            "Native desktop service export is unavailable"
        } else {
            "Native desktop service export is ambiguous"
        });
    }
    let native = if pets_only {
        json!({})
    } else {
        super::update_bindings::build(catalog, &super::features::Context::new(catalog))?
    };
    if native["subscription"].is_object() && native["channel"].is_object() {
        plan["nativeUpdate"] = native;
        plan["errors"]
            .as_object_mut()
            .unwrap()
            .remove("nativeUpdate");
        for kind in ["subscription", "channel"] {
            if let Some(id) = plan["nativeUpdate"][kind]["id"].as_str().map(str::to_owned) {
                plan["chunks"][&id] = json!(catalog.modules[&id].variants[0].chunks);
            }
        }
    } else if !pets_only {
        plan["nativeUpdate"] = native;
        plan["errors"]["nativeUpdate"] = json!("原生更新订阅或频道未完成识别");
    }
    let mut pet_catalogs = Vec::new();
    for id in context.modules_containing("The original Codex companion.") {
        let ast = context.ast(&id)?;
        for node in super::pets::catalogs(&ast) {
            if let Some(reference) = context.export_of(&id, node)? {
                pet_catalogs.push(reference);
            }
        }
    }
    if pet_catalogs.len() == 1 {
        let id = pet_catalogs[0]["id"].as_str().unwrap().to_owned();
        plan["nativeServices"]["petCatalog"] = pet_catalogs.remove(0);
        plan["chunks"][&id] = json!(catalog.modules[&id].variants[0].chunks);
    }
    Ok(plan)
}

pub fn browser_source(
    plan: &Value,
    preferences: &Value,
    pet_packs: &Value,
    builtin: &Value,
) -> String {
    let mut source = format!(
        "(()=>{{if(window!==window.top)return;const createState={};",
        include_str!("assets/preference_runtime.js")
    );
    source.push_str(&format!(
        "globalThis.__codexPanelNativeAdaptersRevision__={};",
        json!(plan_revision(plan))
    ));
    for (name, preference) in [
        ("ProviderQuota", "customProviderQuotaFix"),
        ("ProviderUltrafast", "customProviderUltrafast"),
        ("DotEntry", "showCustomProviderDot"),
        ("ProjectlessChat", "defaultProjectlessChat"),
    ] {
        let enabled = preferences[preference] == true;
        source.push_str(&format!(
            "(globalThis.__codexPanel{name}V1__??=createState({enabled})).setEnabled({enabled});"
        ));
    }
    source.push_str(&format!(
        "(globalThis.__codexPanelSettingsPresentationV1__??=({})({})).setMode({});",
        include_str!("assets/settings_runtime.js"),
        preferences
            .get("nativeSettingsMode")
            .cloned()
            .unwrap_or(json!("system")),
        preferences
            .get("nativeSettingsMode")
            .cloned()
            .unwrap_or(json!("system"))
    ));
    if plan["prepared"]["pets"] == true {
        source.push_str(&format!("const pets=globalThis.__codexPanelPetAnimations__??=({})([],{});pets.setSoundEnabled({});pets.setPacks({});",include_str!("assets/pet_runtime.js"),builtin,preferences["petSounds"]!=false,pet_packs));
    }
    if plan["prepared"]["repositoryBranchPrefix"] == true {
        source.push_str(&format!(
            "globalThis.__codexPanelRepositoryBranchPrefixV1__??=({})();",
            include_str!("assets/repository_runtime.js")
        ));
    }
    if plan["prepared"]["tabs"] == true {
        source.push_str(&format!(
            "globalThis.__codexPanelRspackTabsV1__??=({})();",
            include_str!("assets/tabs_runtime.js")
        ));
    }
    source.push_str(&format!("const plan={plan};if(globalThis.__codexPanelRspack__){{globalThis.__codexPanelRspack__.mergeDescriptors?.(plan);return;}}globalThis.__codexPanelRspack__=({})(plan);}})();",include_str!("assets/rspack_runtime.js")));
    source
}

fn plan_revision(plan: &Value) -> String {
    hex::encode(Sha256::digest(plan.to_string().as_bytes()))
}

pub struct Prepared {
    pub source: String,
    pub handler: tokio::task::JoinHandle<()>,
    pub status: Value,
    pub revision: String,
}

pub async fn prepare(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
) -> Result<Option<Prepared>, ApiError> {
    prepare_mode(cdp, app, environment, false).await
}
pub async fn prepare_pets(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
) -> Result<Option<Prepared>, ApiError> {
    prepare_mode(cdp, app, environment, true).await
}

async fn prepare_mode(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
    pets_only: bool,
) -> Result<Option<Prepared>, ApiError> {
    let path = archive_path(app);
    let directory = environment.data_dir.join("codex-adapters");
    let prepared = tokio::task::spawn_blocking(move || cached_plan(&path, &directory, pets_only))
        .await
        .map_err(|error| ApiError::new(500, "NATIVE_ADAPTER", error.to_string()))??;
    let Some((catalog, plan)) = prepared else {
        return Ok(None);
    };
    let urls=cdp.evaluate("[...document.querySelectorAll('script[type=\"module\"][src]')].map(script=>script.src)",None).await?;
    let url = urls
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|value| url::Url::parse(value).ok())
        .find(|url| url.path() == catalog.main_url_path)
        .ok_or_else(|| {
            ApiError::new(
                422,
                "NATIVE_ENTRY",
                "Codex main module URL does not match archive",
            )
        })?;
    let rewritten = source_ast::rewrite_entry(&catalog.main_source, &url)?;
    let preferences = match &environment.preferences_file {
        Some(path) => tokio::fs::read(path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or(Value::Null),
        None => Value::Null,
    };
    let (pet_packs, builtin) = if plan["prepared"]["pets"] == true {
        (
            crate::pets::read(&environment.data_dir, &environment.app_root).await?,
            crate::pets::read_builtin(&environment.app_root).await?,
        )
    } else {
        (Value::Null, Value::Null)
    };
    let source = browser_source(&plan, &preferences, &pet_packs, &builtin);
    let mut events = cdp.events();
    let connection = cdp.clone();
    let expected = url.to_string();
    let handler = tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            if !connection.owns_event(&event) || event["method"] != "Fetch.requestPaused" {
                continue;
            }
            let params = &event["params"];
            let id = params["requestId"].clone();
            let result = if params["request"]["url"] == expected
                && params["responseStatusCode"] == 200
            {
                let headers = params["responseHeaders"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|header| {
                        !matches!(
                            header["name"]
                                .as_str()
                                .unwrap_or("")
                                .to_lowercase()
                                .as_str(),
                            "content-length" | "content-encoding"
                        )
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                connection.send("Fetch.fulfillRequest",json!({"requestId":id,"responseCode":200,"responseHeaders":headers,"body":base64::engine::general_purpose::STANDARD.encode(rewritten.as_bytes())})).await
            } else {
                connection
                    .send("Fetch.continueRequest", json!({"requestId":id}))
                    .await
            };
            if let Err(error) = result {
                eprintln!("Panel native response: {error}");
                let _ = connection
                    .send("Fetch.continueRequest", json!({"requestId":id}))
                    .await;
            }
        }
    });
    if let Err(error)=cdp.send("Fetch.enable",json!({"patterns":[{"urlPattern":url.as_str(),"resourceType":"Script","requestStage":"Response"}]})).await{handler.abort();return Err(error);}
    let features=plan["prepared"].as_object().into_iter().flatten().map(|(name,prepared)|json!({"id":name,"phase":if prepared==true{"prepared"}else{"failed"},"message":plan["errors"][name]})).collect::<Vec<_>>();
    let status = json!({"phase":if plan["errors"].as_object().is_some_and(|errors|errors.is_empty()){"prepared"}else{"partial"},"message":"已完成 Rust 原生模块分析；未迁移能力保持明确失败状态","features":features,"progress":null,"archiveDigest":catalog.digest,"unreadableChunks":catalog.unreadable});
    Ok(Some(Prepared {
        source,
        handler,
        status,
        revision: plan_revision(&plan),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "需要独立 app.asar 副本，测量首次准备及持久缓存命中"]
    fn actual_archive_cached_preparation() {
        let path = std::env::var_os("CODEX_PANEL_ASAR_FIXTURE").expect("CODEX_PANEL_ASAR_FIXTURE");
        let directory = tempfile::tempdir().unwrap();
        let started = std::time::Instant::now();
        let (catalog, plan) = cached_plan(Path::new(&path), directory.path(), false)
            .unwrap()
            .unwrap();
        let cold = started.elapsed().as_secs_f64();
        assert!(cache_valid(&plan, false));
        let url = url::Url::parse("app://-/index.html")
            .unwrap()
            .join(&catalog.main_url_path)
            .unwrap();
        let entry = source_ast::rewrite_entry(&catalog.main_source, &url).unwrap();
        Ast::parse(&entry, false).unwrap();
        let revision = plan_revision(&plan);
        let digest = catalog.digest.clone();
        drop(plan);
        drop(catalog);
        let started = std::time::Instant::now();
        let (cached, plan) = cached_plan(Path::new(&path), directory.path(), false)
            .unwrap()
            .unwrap();
        let warm = started.elapsed().as_secs_f64();
        assert!(cached.modules.is_empty(), "缓存命中不应重新解析原生模块");
        assert_eq!(cached.digest, digest);
        assert_eq!(plan_revision(&plan), revision);
        println!(
            "{}",
            json!({"coldSeconds":cold,"cachedSeconds":warm,"prepared":plan["prepared"],"errors":plan["errors"]})
        );
    }
    #[test]
    fn accepts_parenthesized_factories_and_numeric_chunk_ids() {
        let entries=parse_factories("export const __rspack_esm_ids=[42],__webpack_modules__={12:(function(m,e,r){r.d(e,{value:()=>answer});const answer=1}),quoted:((m,e,r)=>{r.d(e,{value:()=>2})})};").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].1.chunks, vec![json!(42)]);
        for (_, variant, _) in entries {
            assert!(Ast::parse(&variant.source, true).is_ok());
        }
    }
    #[test]
    #[ignore = "需要独立 app.asar 静态副本，不连接用户 Codex"]
    fn actual_archive_preparation() {
        let path = std::env::var_os("CODEX_PANEL_ASAR_FIXTURE").expect("CODEX_PANEL_ASAR_FIXTURE");
        let started = std::time::Instant::now();
        let catalog = read_catalog(Path::new(&path))
            .unwrap()
            .expect("Rspack archive");
        eprintln!("catalog: {:.3}s", started.elapsed().as_secs_f64());
        if std::env::var_os("CODEX_PANEL_AST_TRACE").is_some() {
            for (id, module) in catalog
                .modules
                .iter()
                .filter(|(_, module)| module.source.len() > 200_000)
            {
                let candidates = IMPLEMENTED_FEATURES
                    .into_iter()
                    .filter(|feature| candidate(feature, &module.source))
                    .collect::<Vec<_>>();
                if !candidates.is_empty() {
                    eprintln!(
                        "candidate {id}: {} bytes; {:?}",
                        module.source.len(),
                        candidates
                    );
                }
            }
        }
        let plan_started = std::time::Instant::now();
        let plan = build_plan(&catalog).unwrap();
        eprintln!(
            "plan: {:.3}s; total: {:.3}s",
            plan_started.elapsed().as_secs_f64(),
            started.elapsed().as_secs_f64()
        );
        println!(
            "{}",
            json!({"digest":catalog.digest,"modules":catalog.modules.len(),"unreadable":catalog.unreadable,"prepared":plan["prepared"],"errors":plan["errors"],"nativeServices":plan["nativeServices"],"nativeUpdate":plan["nativeUpdate"]})
        );
        assert!(
            plan["errors"]
                .as_object()
                .is_some_and(|errors| errors.is_empty()),
            "原生整包能力未全部准备就绪"
        );
    }
    #[test]
    fn reads_factory_variants_without_executing_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.asar");
        let html = "<script type=\"module\" src=\"/assets/main.js\"></script>";
        let main="function load(id){return table[id]}const table={};load.m=table;export{load as __webpack_require__}";
        let chunk="export const __rspack_esm_ids=[42],__webpack_modules__={12:function(m,e,r){const appServices=null;function setAppServices(value){appServices=value}r.d(e,{appServices:()=>appServices,setAppServices:()=>setAppServices})}};";
        let mut files = json!({});
        let mut bytes = Vec::new();
        for (name, source) in [
            ("index.html", html),
            ("assets/main.js", main),
            ("assets/chunk.js", chunk),
        ] {
            let entry = json!({"offset":bytes.len().to_string(),"size":source.len()});
            bytes.extend_from_slice(source.as_bytes());
            if let Some((directory, file)) = name.split_once('/') {
                files[directory]["files"][file] = entry;
            } else {
                files[name] = entry;
            }
        }
        let header = serde_json::to_vec(&json!({"files":{"webview":{"files":files}}})).unwrap();
        let mut archive = vec![0u8; 16];
        archive[4..8].copy_from_slice(&((header.len() + 8) as u32).to_le_bytes());
        archive[12..16].copy_from_slice(&(header.len() as u32).to_le_bytes());
        archive.extend(header);
        archive.extend(bytes);
        std::fs::write(&path, archive).unwrap();
        let catalog = read_catalog(&path).unwrap().unwrap();
        assert_eq!(catalog.modules.len(), 1);
        assert!(catalog.modules["12"]
            .exports
            .contains(&"appServices".to_owned()));
        assert_eq!(catalog.modules["12"].variants[0].chunks, vec![json!(42)]);
        let plan = build_plan(&catalog).unwrap();
        assert_eq!(plan["nativeServices"]["desktopServices"]["id"], "12");
    }
}
