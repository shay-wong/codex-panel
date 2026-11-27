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
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[path = "adapters/cache.rs"]
mod cache;

pub type ProgressCallback = Arc<dyn Fn(Value) + Send + Sync>;

struct ModuleProgress<'a> {
    callback: &'a ProgressCallback,
    phase: &'a str,
    feature: Option<&'a str>,
    total: usize,
    last: Instant,
}
impl<'a> ModuleProgress<'a> {
    fn new(
        callback: &'a ProgressCallback,
        phase: &'a str,
        feature: Option<&'a str>,
        total: usize,
    ) -> Self {
        callback(json!({"phase":phase,"feature":feature,"completed":0,"total":total}));
        Self {
            callback,
            phase,
            feature,
            total,
            last: Instant::now(),
        }
    }
    fn advance(&mut self, completed: usize, module: &str) {
        if completed == self.total || self.last.elapsed() >= Duration::from_millis(100) {
            (self.callback)(
                json!({"phase":self.phase,"feature":self.feature,"moduleId":module,"completed":completed,"total":self.total}),
            );
            self.last = Instant::now();
        }
    }
}

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

fn cache_valid(plan: &Value, pets_only: bool) -> bool {
    selected_features(pets_only)
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

#[cfg(test)]
fn cached_plan(
    path: &Path,
    directory: &Path,
    pets_only: bool,
) -> Result<Option<(Catalog, Value)>, ApiError> {
    let progress: ProgressCallback = Arc::new(|_| {});
    cached_plan_progress(path, directory, pets_only, &progress)
}

fn selected_features(pets_only: bool) -> Vec<&'static str> {
    if pets_only {
        vec!["pets", "nativeServices"]
    } else {
        IMPLEMENTED_FEATURES
            .into_iter()
            .chain(["nativeServices", "nativeUpdate"])
            .collect()
    }
}

fn cached_plan_progress(
    path: &Path,
    directory: &Path,
    pets_only: bool,
    progress: &ProgressCallback,
) -> Result<Option<(Catalog, Value)>, ApiError> {
    cached_plan_revisions(
        path,
        directory,
        pets_only,
        progress,
        &super::revisions::revisions(),
    )
}

fn cached_plan_revisions(
    path: &Path,
    directory: &Path,
    pets_only: bool,
    progress: &ProgressCallback,
    revisions: &super::revisions::Revisions,
) -> Result<Option<(Catalog, Value)>, ApiError> {
    progress(json!({"phase":"cache","completed":0,"total":1}));
    let digest = identity(path)?;
    let cache = cache::Cache::new(directory, &digest, &revisions.catalog);
    let selected = selected_features(pets_only);
    let selected_revisions = selected
        .iter()
        .map(|feature| (*feature, &revisions.features[*feature]))
        .collect::<BTreeMap<_, _>>();
    let combined_revision = hex::encode(Sha256::digest(
        json!([revisions.compose, selected_revisions])
            .to_string()
            .as_bytes(),
    ));
    let mut plans = BTreeMap::new();
    let mut missing = Vec::new();
    for &feature in &selected {
        match cache
            .feature(feature, &revisions.features[feature])
            .filter(|plan| feature_plan_valid(plan, feature))
        {
            Some(plan) => {
                progress(json!({"phase":"feature","feature":feature,"plan":plan,"cached":true}));
                plans.insert(feature.to_owned(), plan);
            }
            None => missing.push(feature),
        }
    }
    progress(
        json!({"phase":"cache","completed":selected.len()-missing.len(),"total":selected.len(),"percent":(selected.len()-missing.len())*100/selected.len()}),
    );
    let main = cache
        .main()
        .filter(|main| main["urlPath"].is_string() && main["source"].is_string());
    if missing.is_empty() {
        if let (Some(main), Some(plan)) = (
            &main,
            cache
                .combined(&combined_revision)
                .filter(|plan| cache_valid(plan, pets_only)),
        ) {
            progress(
                json!({"phase":"prepared","completed":selected.len(),"total":selected.len(),"percent":100,"cached":true}),
            );
            return Ok(Some((catalog_from_main(main, digest), plan)));
        }
    }
    let needs_catalog = !missing.is_empty() || main.is_none() || overlapping_plans(&plans);
    let catalog = if needs_catalog {
        let Some(catalog) = read_catalog_progress(path, progress)? else {
            return Ok(None);
        };
        if catalog.digest != digest {
            return Err(ApiError::new(
                409,
                "ASAR_CHANGED",
                "Codex app.asar 在准备适配期间发生变化",
            ));
        }
        progress(json!({"phase":"write","moduleId":"main","completed":0,"total":1}));
        if let Err(error) = cache.save_main(&json!({"urlPath":catalog.main_url_path,"source":catalog.main_source,"unreadable":catalog.unreadable})) {
            eprintln!("Panel Rspack cache unavailable: {}", error.message);
        }
        progress(json!({"phase":"write","moduleId":"main","completed":1,"total":1}));
        catalog
    } else {
        catalog_from_main(main.as_ref().unwrap(), digest)
    };
    if !missing.is_empty() {
        let adaptation = feature_progress(progress, &selected, &plans);
        let built = build_missing_features(&catalog, &missing, &adaptation, |feature, plan| {
            if feature_plan_valid(plan, feature) {
                progress(json!({"phase":"write","feature":feature,"completed":0,"total":1}));
                if let Err(error) = cache.save_feature(feature, &revisions.features[feature], plan)
                {
                    eprintln!("Panel Rspack cache unavailable: {}", error.message);
                }
                progress(json!({"phase":"write","feature":feature,"completed":1,"total":1}));
            }
            Ok(())
        })?;
        plans.extend(built);
    }
    let plan = compose_plans(&catalog, &selected, &plans, progress)?;
    if cache_valid(&plan, pets_only) {
        progress(json!({"phase":"write","moduleId":"combined","completed":0,"total":1}));
        if let Err(error) = cache.save_combined(&combined_revision, &plan) {
            eprintln!("Panel Rspack cache unavailable: {}", error.message);
        }
        progress(json!({"phase":"write","moduleId":"combined","completed":1,"total":1}));
    }
    progress(
        json!({"phase":"prepared","completed":selected.len(),"total":selected.len(),"percent":100}),
    );
    Ok(Some((catalog, plan)))
}

fn feature_progress(
    callback: &ProgressCallback,
    selected: &[&str],
    cached: &BTreeMap<String, Value>,
) -> ProgressCallback {
    let completed = Arc::new(Mutex::new(
        selected
            .iter()
            .map(|feature| {
                (
                    (*feature).to_owned(),
                    if cached.contains_key(*feature) {
                        1.0
                    } else {
                        0.0
                    },
                )
            })
            .collect::<BTreeMap<_, f64>>(),
    ));
    let callback = callback.clone();
    Arc::new(move |mut event| {
        if let Some(feature) = event["feature"].as_str() {
            let fraction = if event["phase"] == "feature" {
                Some(1.0)
            } else if event["phase"] == "adapt" {
                event["completed"]
                    .as_f64()
                    .zip(event["total"].as_f64())
                    .map(|(done, total)| if total == 0.0 { 1.0 } else { done / total })
            } else {
                None
            };
            if let Some(fraction) = fraction {
                let mut values = completed.lock().unwrap();
                values.insert(feature.into(), fraction);
                event["percent"] =
                    json!(values.values().sum::<f64>() * 100.0 / values.len() as f64);
                callback(event);
                return;
            }
        }
        callback(event);
    })
}

fn catalog_from_main(main: &Value, digest: String) -> Catalog {
    Catalog {
        main_url_path: main["urlPath"].as_str().unwrap().into(),
        main_source: main["source"].as_str().unwrap().into(),
        digest,
        modules: BTreeMap::new(),
        unreadable: main["unreadable"].as_array().cloned().unwrap_or_default(),
    }
}

fn build_missing_features(
    catalog: &Catalog,
    selected: &[&str],
    progress: &ProgressCallback,
    persist: impl Fn(&str, &Value) -> Result<(), ApiError> + Sync,
) -> Result<BTreeMap<String, Value>, ApiError> {
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    let workers = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .min(4)
        .min(selected.len());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let next = &next;
            let results = &results;
            let persist = &persist;
            scope.spawn(move || loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(&feature) = selected.get(index) else {
                    break;
                };
                let plan = build_feature(catalog, feature, progress)
                    .unwrap_or_else(|error| failed_plan(feature, &error.message));
                let result = persist(feature, &plan).map(|()| {
                    progress(
                        json!({"phase":"feature","feature":feature,"plan":plan,"cached":false}),
                    );
                    (feature.to_owned(), plan)
                });
                results.lock().unwrap().push(result);
            });
        }
    });
    results.into_inner().unwrap().into_iter().collect()
}

fn empty_plan() -> Value {
    json!({"patches":{},"prepared":{},"errors":{},"chunks":{},"nativeServices":{},"nativeUpdate":{}})
}

fn failed_plan(feature: &str, message: &str) -> Value {
    let mut plan = empty_plan();
    plan["prepared"][feature] = json!(false);
    plan["errors"][feature] = json!(message);
    plan
}

fn feature_plan_valid(plan: &Value, feature: &str) -> bool {
    plan["prepared"][feature] == true
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

fn overlapping_plans(plans: &BTreeMap<String, Value>) -> bool {
    let mut seen = std::collections::BTreeSet::new();
    for plan in plans.values() {
        for (id, variants) in plan["patches"].as_object().into_iter().flatten() {
            for variant in variants.as_array().into_iter().flatten() {
                if !seen.insert((id.as_str(), variant["before"].as_str().unwrap_or_default())) {
                    return true;
                }
            }
        }
    }
    false
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

#[cfg(test)]
pub fn read_catalog(path: &Path) -> Result<Option<Catalog>, ApiError> {
    let progress: ProgressCallback = Arc::new(|_| {});
    read_catalog_progress(path, &progress)
}

fn read_catalog_progress(
    path: &Path,
    progress: &ProgressCallback,
) -> Result<Option<Catalog>, ApiError> {
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
    let mut reading = ModuleProgress::new(progress, "read", None, assets.len());
    for (index, name) in assets.iter().enumerate() {
        let source = archive.source(&name)?;
        if !source.contains("__webpack_modules__") {
            reading.advance(index + 1, name);
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
        reading.advance(index + 1, name);
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

const IMPLEMENTED_FEATURES: [&str; 10] = [
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
];
fn candidate(feature: &str, source: &str) -> bool {
    match feature {
        "quota" => source.contains("data-codex-composer-root"),
        "ultrafast" => source.contains("serviceTierSettings") || source.contains("serviceTier.ultrafast.description"),
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
        "terminal" => [
            "toggleTerminal",
            "panelId",
            "MainContentLayout",
            "data-app-shell-tab-panel-controller",
        ]
        .iter()
        .any(|term| source.contains(term)),
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
        "terminal" => super::terminal::rewrite(source, module, context),
        _ => Err(ApiError::new(
            500,
            "NATIVE_FEATURE",
            "Unknown native feature",
        )),
    }
}

#[cfg(test)]
pub fn build_plan(catalog: &Catalog) -> Result<Value, ApiError> {
    build_plan_selected(catalog, &IMPLEMENTED_FEATURES, false)
}

#[cfg(test)]
fn build_plan_selected(
    catalog: &Catalog,
    selected: &[&str],
    pets_only: bool,
) -> Result<Value, ApiError> {
    let mut selected = selected.to_vec();
    selected.push("nativeServices");
    if !pets_only {
        selected.push("nativeUpdate");
    }
    let progress: ProgressCallback = Arc::new(|_| {});
    let plans = build_missing_features(catalog, &selected, &progress, |_, _| Ok(()))?;
    compose_plans(catalog, &selected, &plans, &progress)
}

fn build_feature(
    catalog: &Catalog,
    feature: &str,
    progress: &ProgressCallback,
) -> Result<Value, ApiError> {
    let context = super::features::Context::new(catalog);
    let mut plan = match feature {
        "nativeServices" => {
            progress(json!({"phase":"adapt","feature":feature,"completed":0,"total":1}));
            let plan = build_services(catalog, &context)?;
            progress(json!({"phase":"adapt","feature":feature,"completed":1,"total":1}));
            plan
        }
        "nativeUpdate" => {
            progress(json!({"phase":"adapt","feature":feature,"completed":0,"total":1}));
            let plan = build_update(catalog, &context)?;
            progress(json!({"phase":"adapt","feature":feature,"completed":1,"total":1}));
            plan
        }
        _ => {
            let mut plan = empty_plan();
            let mut count = 0;
            let mut modules =
                ModuleProgress::new(progress, "adapt", Some(feature), catalog.modules.len());
            for (index, (id, module)) in catalog.modules.iter().enumerate() {
                for variant in &module.variants {
                    if !candidate(feature, &variant.source) {
                        continue;
                    }
                    context.set_source(id, &variant.source)?;
                    if let Some(after) = transform(feature, &variant.source, id, &context)? {
                        Ast::parse(&after, true)?;
                        if !plan["patches"][id].is_array() {
                            plan["patches"][id] = json!([]);
                        }
                        plan["patches"][id].as_array_mut().unwrap().push(
                            json!({"before":variant.source,"after":after,"features":[feature]}),
                        );
                        plan["chunks"][id] = json!(variant.chunks);
                        count += 1;
                    }
                }
                context.set_source(id, &module.source)?;
                modules.advance(index + 1, id);
            }
            if count == 0 {
                return Ok(failed_plan(feature, "未找到兼容的原生模块"));
            }
            plan
        }
    };
    for id in context.selected.borrow().iter() {
        plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
    }
    plan["prepared"][feature] = json!(plan["errors"][feature].is_null());
    Ok(plan)
}

fn build_services(
    catalog: &Catalog,
    context: &super::features::Context,
) -> Result<Value, ApiError> {
    let mut plan = empty_plan();
    let mut desktop = Vec::new();
    for (id, module) in &catalog.modules {
        if !module.exports.iter().any(|name| name == "appServices") {
            continue;
        }
        let ast = context.ast(id)?;
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
    if desktop.len() == 1 {
        let id = desktop[0]["id"].as_str().unwrap();
        plan["nativeServices"]["desktopServices"] = desktop[0].clone();
        plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
    } else if desktop.len() > 1 {
        return Err(ApiError::new(
            422,
            "NATIVE_CONTRACT",
            "Native desktop service export is ambiguous",
        ));
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
    } else if pet_catalogs.len() > 1 {
        return Err(ApiError::new(
            422,
            "NATIVE_CONTRACT",
            "Native pet catalog export is ambiguous",
        ));
    }
    if plan["nativeServices"].as_object().unwrap().is_empty() {
        plan["errors"]["nativeServices"] = json!("未找到兼容的原生服务模块");
    }
    Ok(plan)
}

fn build_update(catalog: &Catalog, context: &super::features::Context) -> Result<Value, ApiError> {
    let mut plan = empty_plan();
    let native = super::update_bindings::build(catalog, context)?;
    for kind in ["subscription", "channel"] {
        if let Some(id) = native[kind]["id"].as_str() {
            plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
        }
    }
    if !native["subscription"].is_object() && !native["channel"].is_object() {
        plan["errors"]["nativeUpdate"] = json!("未找到兼容的原生更新模块");
    }
    plan["nativeUpdate"] = native;
    Ok(plan)
}

fn compose_plans(
    catalog: &Catalog,
    selected: &[&str],
    plans: &BTreeMap<String, Value>,
    progress: &ProgressCallback,
) -> Result<Value, ApiError> {
    let mut plan = empty_plan();
    let mut factories = BTreeMap::<String, BTreeMap<String, Vec<Value>>>::new();
    for &feature in selected {
        let item = &plans[feature];
        for key in [
            "prepared",
            "errors",
            "chunks",
            "nativeServices",
            "nativeUpdate",
        ] {
            plan[key].as_object_mut().unwrap().extend(
                item[key]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        if item["prepared"][feature] != true {
            continue;
        }
        for (id, variants) in item["patches"].as_object().into_iter().flatten() {
            for variant in variants.as_array().into_iter().flatten() {
                factories
                    .entry(id.clone())
                    .or_default()
                    .entry(variant["before"].as_str().unwrap().into())
                    .or_default()
                    .push(variant.clone());
            }
        }
    }
    let context = super::features::Context::new(catalog);
    let mut modules = ModuleProgress::new(progress, "compose", None, factories.len());
    for (index, (id, variants)) in factories.into_iter().enumerate() {
        let mut combined = Vec::new();
        for (before, patches) in variants {
            if patches.len() == 1 {
                combined.push(patches.into_iter().next().unwrap());
                continue;
            }
            let mut after = before.clone();
            let mut features = Vec::new();
            context.set_source(&id, &after)?;
            for &feature in selected {
                if plan["prepared"][feature] != true || !IMPLEMENTED_FEATURES.contains(&feature) {
                    continue;
                }
                if let Some(changed) = transform(feature, &after, &id, &context)? {
                    Ast::parse(&changed, true)?;
                    after = changed;
                    context.set_source(&id, &after)?;
                    features.push(feature);
                }
            }
            combined.push(json!({"before":before,"after":after,"features":features}));
        }
        plan["patches"][&id] = json!(combined);
        if let Some(module) = catalog.modules.get(&id) {
            context.set_source(&id, &module.source)?;
        }
        modules.advance(index + 1, &id);
    }
    for id in context.selected.borrow().iter() {
        plan["chunks"][id] = json!(catalog.modules[id].variants[0].chunks);
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
    if plan["prepared"]["terminal"] == true {
        source.push_str(&format!(
            "globalThis.__codexPanelBottomTerminalV1__??=({})({});",
            include_str!("assets/terminal_runtime.js"),
            preferences
                .get("terminalLayout")
                .cloned()
                .unwrap_or(json!("bottom"))
        ));
    }
    if plan["prepared"]["tabs"] == true {
        source.push_str(&format!(
            "globalThis.__codexPanelRspackTabsV1__??=({})();",
            include_str!("assets/tabs_runtime.js")
        ));
    }
    source.push_str(&format!("const plan={plan};if(globalThis.__codexPanelRspack__){{globalThis.__codexPanelRspack__.mergeDescriptors?.(plan);}}else{{globalThis.__codexPanelRspack__=({})(plan);}}}})();",include_str!("assets/rspack_runtime.js")));
    source
}

fn plan_revision(plan: &Value) -> String {
    let mut sources = vec![
        // 入口初始化方式变化也需要刷新，不能仅依据补丁内容复用旧页面。
        "entry-bootstrap-v1",
        include_str!("assets/rspack_runtime.js"),
        include_str!("assets/preference_runtime.js"),
        include_str!("assets/settings_runtime.js"),
    ];
    for (feature, source) in [
        ("tabs", include_str!("assets/tabs_runtime.js")),
        ("pets", include_str!("assets/pet_runtime.js")),
        ("repositoryBranchPrefix", include_str!("assets/repository_runtime.js")),
        ("terminal", include_str!("assets/terminal_runtime.js")),
    ] {
        if plan["prepared"][feature] == true { sources.push(source); }
    }
    application_revision(plan, &sources)
}

pub(super) fn application_revision(plan: &Value, sources: &[&str]) -> String {
    hex::encode(Sha256::digest(json!([plan, sources]).to_string().as_bytes()))
}

pub struct Prepared {
    pub source: String,
    pub handler: tokio::task::JoinHandle<()>,
    pub status: Value,
    pub revision: String,
}

pub async fn prepare_with_progress(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
    progress: ProgressCallback,
) -> Result<Option<Prepared>, ApiError> {
    prepare_mode(cdp, app, environment, false, progress).await
}
pub async fn prepare_pets(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
) -> Result<Option<Prepared>, ApiError> {
    prepare_mode(cdp, app, environment, true, Arc::new(|_| {})).await
}

async fn prepare_mode(
    cdp: &Connection,
    app: &Path,
    environment: &Environment,
    pets_only: bool,
    progress: ProgressCallback,
) -> Result<Option<Prepared>, ApiError> {
    let path = archive_path(app);
    let directory = environment.data_dir.join("codex-adapters");
    let prepared = tokio::task::spawn_blocking(move || {
        cached_plan_progress(&path, &directory, pets_only, &progress)
    })
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
    let rewritten = source_ast::rewrite_entry(&catalog.main_source, &url, &source)?;
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
    let features=plan["prepared"].as_object().into_iter().flatten().map(|(name,prepared)|json!({"id":name,"feature":name,"phase":if prepared==true{"prepared"}else{"failed"},"message":if prepared==true{"已适配，等待统一应用"}else{plan["errors"][name].as_str().unwrap_or("未找到兼容的原生模块")}})).collect::<Vec<_>>();
    let status = json!({"phase":if plan["errors"].as_object().is_some_and(|errors|errors.is_empty()){"prepared"}else{"partial"},"message":"原生模块适配已完成","features":features,"progress":100,"archiveDigest":catalog.digest,"unreadableChunks":catalog.unreadable});
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
    fn browser_runtime_changes_require_application_without_invalidating_plans() {
        let plan = empty_plan();
        assert_ne!(application_revision(&plan, &["before"]), application_revision(&plan, &["after"]));
        let source = browser_source(&plan, &json!({}), &json!([]), &Value::Null);
        assert!(source.contains(&format!("globalThis.__codexPanelNativeAdaptersRevision__={};", json!(plan_revision(&plan)))));
    }

    #[test]
    fn browser_entry_initializes_plan_before_native_factories() {
        let before = "function(m,e,r){m.exports='original'}";
        let mut plan = empty_plan();
        plan["prepared"]["tabs"] = json!(true);
        for id in ["menu", "sidebar"] {
            plan["patches"][id] = json!([{
                "before": before,
                "after": format!("function(m,e,r){{m.exports='adapted';globalThis.__codexPanelRspackTabsV1__.mark('{id}')}}"),
                "features": ["tabs"],
            }]);
        }
        let bootstrap = format!("globalThis.window=globalThis;globalThis.top=globalThis;{}", browser_source(&plan, &json!({}), &json!([]), &Value::Null));
        // 不预先执行文档注入，直接启动入口；同时验证初始模块和后续加载模块。
        let main = format!(r#"
            const table={{menu:{before}}},cache={{}};
            function load(id){{if(cache[id])return cache[id].exports;const m=cache[id]={{exports:null}};table[id](m,m.exports,load);return m.exports}}
            load.m=table;load.c=cache;
            if(load('menu')!=='adapted')throw Error('initial factory was not patched');
            table.sidebar={before};
            if(load('sidebar')!=='adapted')throw Error('lazy factory was not patched');
            if(!globalThis.__codexPanelThreadTabsReady__)throw Error('tabs are not ready');
            if(!globalThis.__codexPanelRspack__.entryWrapped)throw Error('entry was not wrapped');
            export{{load as __webpack_require__}};
        "#);
        let entry = source_ast::rewrite_entry(&main, &url::Url::parse("app://-/assets/main.js").unwrap(), &bootstrap).unwrap();
        let output = std::process::Command::new("node").args(["--input-type=module", "--eval", &entry]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn entry_bootstrap_applies_quota_without_a_new_document_script() {
        let original = "function(module){module.exports='blocked'}";
        let mut plan = empty_plan();
        plan["patches"]["composer"] = json!([{
            "before": original,
            "after": "function(module){module.exports='sendable'}",
            "features": ["quota"]
        }]);
        plan["prepared"]["quota"] = json!(true);
        let source = browser_source(&plan, &json!({"customProviderQuotaFix":true}), &json!([]), &Value::Null);
        let entry = format!("let table={{composer:{original}}};function load(id){{let module={{}};table[id](module);return module.exports}}load.m=table;globalThis.result=load('composer');");
        let url = url::Url::parse("app://-/assets/main.js").unwrap();
        let rewritten = source_ast::rewrite_entry(&entry, &url, "").unwrap();
        let initialized = source_ast::rewrite_entry(&entry, &url, &source).unwrap();
        // 不执行任何 new-document 脚本，复现入口先加载时的发送限制。
        let script = format!("const before={{}};before.window=before;before.top=before;require('node:vm').runInNewContext({},before);require('node:assert/strict').equal(before.result,'blocked');globalThis.window=globalThis;globalThis.top=globalThis;{initialized}\nrequire('node:assert/strict').equal(result,'sendable');require('node:assert/strict').equal(__codexPanelProviderQuotaV1__.applied,true);", json!(rewritten));
        let output = std::process::Command::new("node").args(["-e", &script]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn status_prefers_current_rspack_preparation_over_legacy_flags() {
        let source = include_str!("assets/injection_status_0.js");
        let script = format!(r#"const assert=require('node:assert/strict'),vm=require('node:vm');const state={{document:{{getElementById:()=>null}},__codexPanelRspack__:{{prepared:{{quota:true,dot:true,ultrafast:true}}}}}};state.window=state;const read=()=>vm.runInNewContext({},state);let value=read();for(const key of ['quotaBootstrapPrepared','providerModulesPrepared','dotBootstrapPrepared','ultrafastBootstrapPrepared'])assert.equal(value[key],true);state.__codexPanelRspack__.prepared.quota=false;state.__codexPanelQuotaBootstrapPrepared__=true;assert.equal(read().quotaBootstrapPrepared,false);delete state.__codexPanelRspack__;assert.equal(read().quotaBootstrapPrepared,true);"#, json!(source));
        let result = std::process::Command::new("node").args(["-e", &script]).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    }

    fn fixture_archive(directory: &Path) -> PathBuf {
        let path = directory.join("app.asar");
        let html = "<script type=\"module\" src=\"/assets/main.js\"></script>";
        let main = "function load(id){return table[id]}const table={};load.m=table;export{load as __webpack_require__}";
        let chunk = "export const __rspack_esm_ids=[42],__webpack_modules__={12:function(m,e,r){let appServices=null;function setAppServices(value){appServices=value}r.d(e,{appServices:()=>appServices,setAppServices:()=>setAppServices})},13:function(a,b,c){function Settings(){React.useState(0);return gate('3561799561')}}};";
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
        path
    }

    fn recorded_progress() -> (ProgressCallback, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let progress: ProgressCallback =
            Arc::new(move |event| captured.lock().unwrap().push(event));
        (progress, events)
    }

    #[test]
    fn successful_feature_cache_survives_failed_peers_and_retries_only_failures() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_archive(directory.path());
        let caches = directory.path().join("cache");
        let (progress, events) = recorded_progress();
        let (_, first) = cached_plan_progress(&path, &caches, false, &progress)
            .unwrap()
            .unwrap();
        assert_eq!(first["prepared"]["settingsPresentation"], true);
        assert_eq!(first["prepared"]["nativeServices"], true);
        assert_eq!(first["prepared"]["terminal"], false);
        events.lock().unwrap().clear();
        let (_, second) = cached_plan_progress(&path, &caches, false, &progress)
            .unwrap()
            .unwrap();
        assert_eq!(first, second);
        let events = events.lock().unwrap();
        for feature in ["settingsPresentation", "nativeServices"] {
            assert!(events.iter().any(|event| event["phase"] == "feature"
                && event["feature"] == feature
                && event["cached"] == true));
            assert!(!events
                .iter()
                .any(|event| event["phase"] == "adapt" && event["feature"] == feature));
        }
        assert!(events.iter().any(|event| event["phase"] == "feature"
            && event["feature"] == "terminal"
            && event["cached"] == false));
    }

    #[test]
    fn combined_cache_skips_catalog_and_one_revision_rebuilds_only_its_feature() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_archive(directory.path());
        let caches = directory.path().join("cache");
        let mut revisions = super::super::revisions::revisions();
        let cache = cache::Cache::new(&caches, &identity(&path).unwrap(), &revisions.catalog);
        for feature in selected_features(false)
            .into_iter()
            .filter(|feature| *feature != "settingsPresentation")
        {
            let mut plan = empty_plan();
            plan["prepared"][feature] = json!(true);
            cache
                .save_feature(feature, &revisions.features[feature], &plan)
                .unwrap();
        }
        let (progress, events) = recorded_progress();
        let (_, first) = cached_plan_revisions(&path, &caches, false, &progress, &revisions)
            .unwrap()
            .unwrap();
        assert!(cache_valid(&first, false));
        events.lock().unwrap().clear();
        let (hot, second) = cached_plan_revisions(&path, &caches, false, &progress, &revisions)
            .unwrap()
            .unwrap();
        assert!(hot.modules.is_empty());
        assert_eq!(first, second);
        assert!(!events.lock().unwrap().iter().any(|event| matches!(
            event["phase"].as_str(),
            Some("read" | "adapt" | "compose" | "write")
        )));
        events.lock().unwrap().clear();
        revisions
            .features
            .get_mut("settingsPresentation")
            .unwrap()
            .push_str("-changed");
        let (_, third) = cached_plan_revisions(&path, &caches, false, &progress, &revisions)
            .unwrap()
            .unwrap();
        assert_eq!(first, third);
        let events = events.lock().unwrap();
        let rebuilt = events
            .iter()
            .filter(|event| event["phase"] == "feature" && event["cached"] == false)
            .map(|event| event["feature"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rebuilt, vec!["settingsPresentation"]);
    }

    #[test]
    fn pets_and_main_share_persistent_feature_entries() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_archive(directory.path());
        let caches = directory.path().join("cache");
        let (progress, events) = recorded_progress();
        cached_plan_progress(&path, &caches, false, &progress)
            .unwrap()
            .unwrap();
        events.lock().unwrap().clear();
        cached_plan_progress(&path, &caches, true, &progress)
            .unwrap()
            .unwrap();
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["phase"] == "feature"
                && event["feature"] == "nativeServices"
                && event["cached"] == true));
    }

    #[test]
    fn independent_feature_jobs_publish_completion_from_bounded_workers() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_archive(directory.path());
        let catalog = read_catalog(&path).unwrap().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let progress: ProgressCallback = Arc::new(move |event| {
            captured
                .lock()
                .unwrap()
                .push((std::thread::current().id(), event));
        });
        let plans = build_missing_features(
            &catalog,
            &["settingsPresentation", "nativeServices", "terminal"],
            &progress,
            |_, _| Ok(()),
        )
        .unwrap();
        assert_eq!(plans.len(), 3);
        let events = events.lock().unwrap();
        let completions = events
            .iter()
            .filter(|(_, event)| event["phase"] == "feature")
            .collect::<Vec<_>>();
        assert_eq!(completions.len(), 3);
        assert!(completions
            .iter()
            .all(|(id, _)| *id != std::thread::current().id()));
        assert!(
            completions
                .iter()
                .map(|(id, _)| id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                <= 4
        );
    }

    #[test]
    fn native_services_accept_pet_catalog_without_desktop_and_reject_ambiguity() {
        let source = "function(m,e,r){const pets=[{assetRef:'codex',description:'The original Codex companion.'}];r.d(e,{pets:()=>pets})}";
        let mut catalog = Catalog {
            main_url_path: "/main.js".into(),
            main_source: String::new(),
            digest: "fixture".into(),
            unreadable: vec![],
            modules: [(
                "pet".into(),
                Module {
                    source: source.into(),
                    exports: vec![],
                    variants: vec![Variant {
                        source: source.into(),
                        chunks: vec![json!(7)],
                        asset_size: source.len(),
                    }],
                },
            )]
            .into_iter()
            .collect(),
        };
        let progress: ProgressCallback = Arc::new(|_| {});
        let plan = build_feature(&catalog, "nativeServices", &progress).unwrap();
        assert_eq!(plan["prepared"]["nativeServices"], true);
        assert_eq!(
            plan["nativeServices"]["petCatalog"],
            json!({"id":"pet","exportName":"pets"})
        );
        assert!(plan["nativeServices"]["desktopServices"].is_null());
        catalog.modules.insert(
            "other".into(),
            Module {
                source: source.into(),
                exports: vec![],
                variants: vec![Variant {
                    source: source.into(),
                    chunks: vec![json!(8)],
                    asset_size: source.len(),
                }],
            },
        );
        assert!(build_feature(&catalog, "nativeServices", &progress)
            .unwrap_err()
            .message
            .contains("ambiguous"));
    }

    #[test]
    fn unwritable_cache_keeps_successful_features_and_completion_notifications() {
        let directory = tempfile::tempdir().unwrap();
        let path = fixture_archive(directory.path());
        let blocked_cache = directory.path().join("cache-file");
        std::fs::write(&blocked_cache, "file blocks cache directory").unwrap();
        let (progress, events) = recorded_progress();
        let (_, plan) = cached_plan_progress(&path, &blocked_cache, false, &progress)
            .unwrap()
            .unwrap();
        assert_eq!(plan["prepared"]["settingsPresentation"], true);
        assert_eq!(plan["prepared"]["nativeServices"], true);
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event["phase"] == "feature")
                .count(),
            12
        );
        assert_eq!(events.last().unwrap()["phase"], "prepared");
    }

    #[test]
    fn terminal_browser_bootstrap_preserves_layout_preferences() {
        let mut plan = json!({"patches":{},"prepared":{"terminal":true},"errors":{},"chunks":{},"nativeServices":{},"nativeUpdate":{}});
        for (preferences, expected) in [
            (json!({}), "bottom"),
            (json!({"terminalLayout":"system"}), "system"),
            (json!({"terminalLayout":"right"}), "right"),
        ] {
            let source = browser_source(&plan, &preferences, &json!([]), &Value::Null);
            assert!(source.contains(&format!(
                "globalThis.__codexPanelBottomTerminalV1__??=({})({});",
                include_str!("assets/terminal_runtime.js"),
                json!(expected)
            )));
            Ast::parse(&source, false).unwrap();
        }
        plan["prepared"]["terminal"] = json!(false);
        assert!(!browser_source(&plan, &json!({}), &json!([]), &Value::Null)
            .contains("__codexPanelBottomTerminalV1__"));
        assert!(IMPLEMENTED_FEATURES.contains(&"terminal"));
        assert!(candidate("terminal", "toggleTerminal"));
        assert!(!candidate("terminal", "unrelated native feature"));
    }
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
        let bootstrap = browser_source(&plan, &json!({}), &json!([]), &Value::Null);
        let entry = source_ast::rewrite_entry(&catalog.main_source, &url, &bootstrap).unwrap();
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
