mod community;

use crate::ApiError;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

const STATES: [&str; 9] = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
];
const IMAGE_LIMIT: usize = 32 * 1024 * 1024;
const AUDIO_LIMIT: usize = 16 * 1024 * 1024;
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "INVALID_PET_ANIMATION", message)
}
fn filename(value: &str, extensions: &[&str]) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 240
        && !value
            .chars()
            .any(|c| "\\/:".contains(c) || c.is_ascii_control())
        && Path::new(value)
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| extensions.contains(&v.to_lowercase().as_str()))
}

pub fn validate_manifest(value: &Value) -> Result<Value, ApiError> {
    if value["version"] != 1 {
        return Err(invalid("动画清单版本必须为 1"));
    }
    for key in ["petId", "name"] {
        if value[key].as_str().is_none_or(|s| {
            s.trim().is_empty()
                || s.encode_utf16().count() > 240
                || s.chars().any(|c| c.is_ascii_control())
        }) {
            return Err(invalid(format!("动画清单 {key} 无效")));
        }
    }
    if value["spritesheet"]
        .as_str()
        .is_none_or(|s| !filename(s, &["png", "webp"]))
    {
        return Err(invalid("spritesheet 必须是同目录的 PNG 或 WebP 文件名"));
    }
    let columns = value["columns"]
        .as_u64()
        .filter(|n| (1..=64).contains(n))
        .ok_or_else(|| invalid("columns 必须在 1–64 之间"))?;
    let rows = value["rows"]
        .as_u64()
        .filter(|n| (1..=64).contains(n))
        .ok_or_else(|| invalid("rows 必须在 1–64 之间"))?;
    let cell = |value: &Value| value.as_u64().is_some_and(|n| n < columns * rows);
    let animations = value["animations"]
        .as_object()
        .filter(|v| v.contains_key("idle"))
        .ok_or_else(|| invalid("动画清单必须包含 idle 动作"))?;
    let mut cleaned = Map::new();
    let mut count = 0usize;
    for (state, animation) in animations {
        if !STATES.contains(&state.as_str()) {
            return Err(invalid(format!("不支持的动画状态：{state}")));
        }
        let frames = animation["frames"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 10000)
            .ok_or_else(|| invalid(format!("{state} 动作无效")))?;
        if animation.get("loop").is_some_and(|v| !v.is_boolean()) {
            return Err(invalid(format!("{state} 动作无效")));
        }
        if animation.get("audio").is_some_and(|v| {
            v.as_str()
                .is_none_or(|s| !filename(s, &["m4a", "mp3", "wav", "ogg"]))
        }) {
            return Err(invalid(format!(
                "{state} audio 必须是同目录的 M4A、MP3、WAV 或 Ogg 文件名"
            )));
        }
        for frame in frames {
            if frame.as_array().is_none_or(|a| {
                a.len() != 2
                    || !cell(&a[0])
                    || a[1].as_u64().is_none_or(|n| !(1..=60000).contains(&n))
            }) {
                return Err(invalid(format!("{state} 帧须为有效的 [格子序号, 毫秒]")));
            }
        }
        count += frames.len();
        let mut clip = json!({"frames":frames,"loop":animation.get("loop").cloned().unwrap_or(json!(state=="idle"))});
        if let Some(audio) = animation.get("audio") {
            clip["audio"] = audio.clone();
        }
        cleaned.insert(state.clone(), clip);
    }
    if count > 10000 {
        return Err(invalid("动画总帧数不能超过 10000"));
    }
    if value.get("lookFrames").is_some_and(|v| {
        v.as_array()
            .is_none_or(|a| a.len() != 16 || !a.iter().all(cell))
    }) {
        return Err(invalid("lookFrames 必须包含 16 个有效格子序号"));
    }
    let mut result = json!({"version":1,"petId":value["petId"],"name":value["name"],"spritesheet":value["spritesheet"],"columns":columns,"rows":rows,"animations":cleaned});
    if let Some(frames) = value.get("lookFrames") {
        result["lookFrames"] = frames.clone();
    }
    Ok(result)
}

async fn limited(path: &Path, limit: usize) -> Result<Vec<u8>, ApiError> {
    let details = tokio::fs::metadata(path).await?;
    if !details.is_file() || details.len() > limit as u64 {
        return Err(invalid(format!(
            "文件无效或超过大小限制：{}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    let bytes = tokio::fs::read(path).await?;
    if bytes.len() > limit {
        return Err(invalid("文件超过大小限制"));
    }
    Ok(bytes)
}

pub fn image_dimensions(bytes: &[u8], name: &str) -> Result<(u32, u32), ApiError> {
    let extension = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    if extension == "png"
        && bytes.len() >= 33
        && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10]
        && bytes[8..12] == 13u32.to_be_bytes()
        && &bytes[12..16] == b"IHDR"
    {
        return Ok((
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        ));
    }
    if extension == "webp"
        && bytes.len() >= 20
        && &bytes[..4] == b"RIFF"
        && &bytes[8..12] == b"WEBP"
        && u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 == bytes.len()
    {
        let mut offset = 12;
        let mut canvas = None;
        let mut image = None;
        while offset + 8 <= bytes.len() {
            let kind = &bytes[offset..offset + 4];
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let start = offset + 8;
            let end = start
                .checked_add(length)
                .filter(|n| *n <= bytes.len())
                .ok_or_else(|| invalid("WebP 图片内容不完整"))?;
            if kind == b"VP8X" && length >= 10 {
                if bytes[start] & 2 != 0 {
                    return Err(invalid("请使用静态 WebP 图集"));
                }
                let width =
                    u32::from_le_bytes([bytes[start + 4], bytes[start + 5], bytes[start + 6], 0])
                        + 1;
                let height =
                    u32::from_le_bytes([bytes[start + 7], bytes[start + 8], bytes[start + 9], 0])
                        + 1;
                canvas = Some((width, height));
            } else if kind == b"VP8L" && length >= 5 && bytes[start] == 0x2f {
                let bits = u32::from_le_bytes(bytes[start + 1..start + 5].try_into().unwrap());
                image = Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            } else if kind == b"VP8 "
                && length >= 10
                && bytes[start + 3..start + 6] == [0x9d, 0x01, 0x2a]
            {
                image = Some((
                    (u16::from_le_bytes(bytes[start + 6..start + 8].try_into().unwrap()) & 0x3fff)
                        as u32,
                    (u16::from_le_bytes(bytes[start + 8..start + 10].try_into().unwrap()) & 0x3fff)
                        as u32,
                ));
            }
            offset = end + length % 2;
        }
        if let Some(image) = image {
            return Ok(canvas.unwrap_or(image));
        }
    }
    Err(invalid("图集不是有效的 PNG 或静态 WebP 图片"))
}
fn audio_type(bytes: &[u8], name: &str) -> Result<&'static str, ApiError> {
    let ext = Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = match ext.as_str() {
        "m4a"
            if bytes.len() >= 16
                && &bytes[4..8] == b"ftyp"
                && (16..=bytes.len() as u32)
                    .contains(&u32::from_be_bytes(bytes[..4].try_into().unwrap())) =>
        {
            "audio/mp4"
        }
        "mp3"
            if bytes.len() >= 4
                && (&bytes[..3] == b"ID3"
                    || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0 && bytes[1] & 6 != 0)) =>
        {
            "audio/mpeg"
        }
        "wav" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" => {
            "audio/wav"
        }
        "ogg" if bytes.len() >= 27 && &bytes[..4] == b"OggS" && bytes[4] == 0 => "audio/ogg",
        _ => return Err(invalid(format!("音频内容与格式不符：{name}"))),
    };
    Ok(kind)
}

async fn local_file(directory: &Path, name: &str) -> Result<PathBuf, ApiError> {
    let root = tokio::fs::canonicalize(directory).await?;
    let file = tokio::fs::canonicalize(root.join(name)).await?;
    if file.parent() != Some(root.as_path()) {
        return Err(invalid("资源必须位于清单所在目录，不能链接到外部文件"));
    }
    Ok(file)
}
async fn image(directory: &Path, manifest: &Value) -> Result<Vec<u8>, ApiError> {
    let name = manifest["spritesheet"].as_str().unwrap();
    let bytes = limited(&local_file(directory, name).await?, IMAGE_LIMIT).await?;
    let (width, height) = image_dimensions(&bytes, name)?;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 64 * 1024 * 1024
        || u64::from(width) % manifest["columns"].as_u64().unwrap() != 0
        || u64::from(height) % manifest["rows"].as_u64().unwrap() != 0
    {
        return Err(invalid("图集尺寸不能按指定行列均分"));
    }
    Ok(bytes)
}
type Audio = BTreeMap<String, (Vec<u8>, &'static str)>;
async fn audio(directory: &Path, manifest: &Value) -> Result<Audio, ApiError> {
    let mut result = Audio::new();
    for clip in manifest["animations"].as_object().unwrap().values() {
        if let Some(name) = clip["audio"].as_str() {
            if !result.contains_key(name) {
                let bytes = limited(&local_file(directory, name).await?, AUDIO_LIMIT).await?;
                let kind = audio_type(&bytes, name)?;
                result.insert(name.into(), (bytes, kind));
            }
        }
    }
    Ok(result)
}
async fn index(directory: &Path) -> Result<Vec<Value>, ApiError> {
    let bytes = match limited(&directory.join("index.json"), 4 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) if e.code == "IO_ERROR" && !directory.join("index.json").try_exists()? => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(e),
    };
    let values: Value = serde_json::from_slice(&bytes)?;
    let values = values
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or_else(|| invalid("本地动画列表无效"))?;
    let mut result = Vec::new();
    for value in values {
        let cleaned = validate_manifest(value)?;
        if result
            .iter()
            .any(|v: &Value| v["petId"] == cleaned["petId"])
        {
            return Err(invalid("本地动画列表存在重复宠物"));
        }
        result.push(cleaned);
    }
    Ok(result)
}
fn animation_key(manifest: &Value, image: &[u8], audio: &Audio) -> String {
    json!([
        manifest["columns"],
        manifest["rows"],
        STATES
            .iter()
            .map(|state| {
                let clip = &manifest["animations"][*state];
                if clip.is_null() {
                    Value::Null
                } else {
                    json!([
                        clip["frames"],
                        clip["loop"],
                        clip["audio"]
                            .as_str()
                            .and_then(|name| audio.get(name))
                            .map(|(bytes, _)| hex::encode(Sha256::digest(bytes)))
                    ])
                }
            })
            .collect::<Vec<_>>(),
        manifest["lookFrames"],
        hex::encode(Sha256::digest(image))
    ])
    .to_string()
}
struct Builtin {
    manifest: Value,
    image: Vec<u8>,
    audio: Audio,
    keys: Vec<String>,
}
async fn builtin(root: &Path) -> Result<Builtin, ApiError> {
    let dir = root.join("inject/pets/lumi");
    let manifest = validate_manifest(&serde_json::from_slice(
        &tokio::fs::read(dir.join("animation.json")).await?,
    )?)?;
    let image = image(&dir, &manifest).await?;
    let audio = audio(&dir, &manifest).await?;
    let keys = vec![
        animation_key(&manifest, &image, &audio),
        animation_key(&manifest, &image, &Audio::new()),
    ];
    Ok(Builtin {
        manifest,
        image,
        audio,
        keys,
    })
}
fn matches(manifest: &Value, image: &[u8], audio: &Audio, builtin: &Builtin) -> bool {
    let key = animation_key(manifest, image, audio);
    builtin.keys.contains(&key)
        || hex::encode(Sha256::digest(key.as_bytes()))
            == "6d49a3d4e2afe659baaf02b16b7b3cb5911ed0d745c130a9d700bf26c26b9c8d"
}
async fn summaries(manifests: &[Value], directory: &Path, root: &Path) -> Result<Value, ApiError> {
    let builtin = builtin(root).await?;
    let mut result = Vec::new();
    for manifest in manifests {
        let image = image(directory, manifest).await?;
        let matched = matches(
            manifest,
            &image,
            &audio(directory, manifest).await?,
            &builtin,
        );
        if manifest["petId"] == builtin.manifest["petId"] && matched {
            continue;
        }
        let (width, height) = image_dimensions(&image, manifest["spritesheet"].as_str().unwrap())?;
        let pet_id = manifest["petId"].as_str().unwrap();
        result.push(json!({"petId":pet_id,"name":manifest["name"],"states":manifest["animations"].as_object().unwrap().keys().collect::<Vec<_>>(),"hasLookFrames":manifest.get("lookFrames").is_some(),"builtinLumi":manifest["petId"]==builtin.manifest["petId"]||matched,"selectable":!pet_id.starts_with("pet_")&&!pet_id.starts_with("custom:"),"preview":{"spritesheetUrl":image_url(manifest,&image),"columns":manifest["columns"],"rows":manifest["rows"],"frame":manifest["animations"]["idle"]["frames"][0][0],"aspectRatio":f64::from(width)/manifest["columns"].as_f64().unwrap()/(f64::from(height)/manifest["rows"].as_f64().unwrap())}}));
    }
    Ok(json!(result))
}
fn image_url(manifest: &Value, image: &[u8]) -> String {
    let kind = if manifest["spritesheet"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .ends_with(".png")
    {
        "png"
    } else {
        "webp"
    };
    format!("data:image/{kind};base64,{}", STANDARD.encode(image))
}
pub async fn list(data: &Path, root: &Path) -> Result<Value, ApiError> {
    let directory = data.join("pet-animations");
    summaries(&index(&directory).await?, &directory, root).await
}
pub async fn read(data: &Path, root: &Path) -> Result<Value, ApiError> {
    let directory = data.join("pet-animations");
    let mut manifests = index(&directory).await?;
    let builtin = builtin(root).await?;
    if !manifests
        .iter()
        .any(|v| v["petId"] == builtin.manifest["petId"])
    {
        manifests.push(builtin.manifest.clone());
    }
    let mut result = Vec::new();
    for mut manifest in manifests {
        let dir = if manifest == builtin.manifest {
            root.join("inject/pets/lumi")
        } else {
            directory.clone()
        };
        let mut image = image(&dir, &manifest).await?;
        let mut audio = audio(&dir, &manifest).await?;
        let matched = matches(&manifest, &image, &audio, &builtin);
        if matched {
            let id = manifest["petId"].clone();
            let name = manifest["name"].clone();
            manifest = builtin.manifest.clone();
            manifest["petId"] = id;
            manifest["name"] = name;
            image = builtin.image.clone();
            audio = builtin.audio.clone();
        }
        let source = image_url(&manifest, &image);
        for clip in manifest["animations"].as_object_mut().unwrap().values_mut() {
            if let Some(name) = clip["audio"].as_str() {
                let (bytes, kind) = audio.get(name).ok_or_else(|| invalid("音频资源缺失"))?;
                clip["audioUrl"] = json!(format!("data:{kind};base64,{}", STANDARD.encode(bytes)));
            }
        }
        manifest["builtinLumi"] = json!(manifest["petId"] == builtin.manifest["petId"] || matched);
        manifest["spritesheetUrl"] = json!(source);
        result.push(manifest);
    }
    Ok(json!(result))
}
pub async fn read_builtin(root: &Path) -> Result<Value, ApiError> {
    let directory = root.join("inject/pets/lumi");
    let manifest: Value =
        serde_json::from_slice(&tokio::fs::read(directory.join("pet.json")).await?)?;
    let name = manifest["spritesheetPath"]
        .as_str()
        .ok_or_else(|| invalid("内置宠物资源无效"))?;
    let image = limited(&local_file(&directory, name).await?, IMAGE_LIMIT).await?;
    Ok(
        json!({"id":manifest["id"],"displayName":manifest["displayName"],"description":manifest["description"],"spriteVersionNumber":manifest["spriteVersionNumber"],"spritesheetUrl":format!("data:image/webp;base64,{}",STANDARD.encode(image))}),
    )
}
async fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    use tokio::io::AsyncWriteExt;
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(path).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    Ok(())
}
async fn write_index(directory: &Path, values: &[Value]) -> Result<(), ApiError> {
    let mut bytes = serde_json::to_vec_pretty(values)?;
    bytes.push(b'\n');
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(invalid("动画清单总大小不能超过 4 MiB"));
    }
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        write_new(&temporary, &bytes).await?;
        tokio::fs::rename(&temporary, directory.join("index.json")).await?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}
fn resources(values: &[Value]) -> Vec<String> {
    let mut names = Vec::new();
    for item in values {
        names.push(item["spritesheet"].as_str().unwrap().into());
        for clip in item["animations"].as_object().unwrap().values() {
            if let Some(name) = clip["audio"].as_str() {
                names.push(name.into());
            }
        }
    }
    names
}
async fn cleanup(directory: &Path, previous: &[Value], next: &[Value]) {
    let retained = resources(next);
    let managed = regex::Regex::new(r"^[\da-f-]{36}\.(?:png|webp|m4a|mp3|wav|ogg)$").unwrap();
    for name in resources(previous) {
        if managed.is_match(&name) && !retained.contains(&name) {
            let _ = tokio::fs::remove_file(directory.join(name)).await;
        }
    }
}
pub async fn remove(data: &Path, root: &Path, id: &str) -> Result<Value, ApiError> {
    let directory = data.join("pet-animations");
    let previous = index(&directory).await?;
    let next = previous
        .iter()
        .filter(|v| v["petId"] != id)
        .cloned()
        .collect::<Vec<_>>();
    if next.len() != previous.len() {
        write_index(&directory, &next).await?;
        cleanup(&directory, &previous, &next).await;
    }
    summaries(&next, &directory, root).await
}
pub async fn import(data: &Path, root: &Path, path: &Path) -> Result<Value, ApiError> {
    let path = std::path::absolute(path)?;
    let manifest = validate_manifest(&serde_json::from_slice(
        &limited(&path, 1024 * 1024).await?,
    )?)?;
    let source = path.parent().ok_or_else(|| invalid("清单路径无效"))?;
    let image = image(source, &manifest).await?;
    let audio = audio(source, &manifest).await?;
    save(data, root, manifest, image, audio).await
}

async fn save(
    data: &Path,
    root: &Path,
    mut manifest: Value,
    image: Vec<u8>,
    audio: Audio,
) -> Result<Value, ApiError> {
    let builtin = builtin(root).await?;
    if manifest["petId"] == builtin.manifest["petId"]
        && matches(&manifest, &image, &audio, &builtin)
    {
        return remove(data, root, manifest["petId"].as_str().unwrap()).await;
    }
    let directory = data.join("pet-animations");
    tokio::fs::create_dir_all(&directory).await?;
    let previous = index(&directory).await?;
    let extension = Path::new(manifest["spritesheet"].as_str().unwrap())
        .extension()
        .unwrap()
        .to_string_lossy()
        .to_lowercase();
    let image_name = format!("{}.{extension}", uuid::Uuid::new_v4());
    manifest["spritesheet"] = json!(image_name);
    let mut files = vec![(image_name, image)];
    let mut mapping = BTreeMap::new();
    for (name, (bytes, _)) in audio {
        let extension = Path::new(&name)
            .extension()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        let file = format!("{}.{extension}", uuid::Uuid::new_v4());
        mapping.insert(name, file.clone());
        files.push((file, bytes));
    }
    for clip in manifest["animations"].as_object_mut().unwrap().values_mut() {
        if let Some(name) = clip["audio"].as_str() {
            clip["audio"] = json!(mapping[name]);
        }
    }
    let mut next = previous
        .iter()
        .filter(|v| v["petId"] != manifest["petId"])
        .cloned()
        .collect::<Vec<_>>();
    next.push(manifest);
    if next.len() > 128 {
        return Err(invalid("最多导入 128 个宠物动画包"));
    }
    let mut written = Vec::new();
    let result = async {
        for (name, bytes) in &files {
            let path = directory.join(name);
            write_new(&path, bytes).await?;
            written.push(path);
        }
        write_index(&directory, &next).await
    }
    .await;
    if let Err(error) = result {
        for path in written {
            let _ = tokio::fs::remove_file(path).await;
        }
        return Err(error);
    }
    cleanup(&directory, &previous, &next).await;
    summaries(&next, &directory, root).await
}
pub async fn run(args: &[String]) -> Result<Value, ApiError> {
    let operation = args.first().map(String::as_str).unwrap_or("");
    let data = args
        .get(1)
        .map(PathBuf::from)
        .ok_or_else(|| invalid("缺少数据目录"))?;
    let root = std::env::var_os("CODEX_PANEL_APP_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_owned()
        });
    let value = args.get(2).map(String::as_str);
    let argument = |index: usize| {
        args.get(index)
            .map(String::as_str)
            .ok_or_else(|| invalid("缺少社区目录参数"))
    };
    match operation {
        "list-community" => {
            let page = argument(4)?
                .parse::<usize>()
                .map_err(|_| invalid("社区目录页码无效"))?;
            community::list(argument(2)?, argument(3)?, page).await
        }
        "install-community" => community::install(&data, &root, argument(2)?, argument(3)?).await,
        "list" => list(&data, &root).await,
        "import" => {
            import(
                &data,
                &root,
                Path::new(value.ok_or_else(|| invalid("缺少清单路径"))?),
            )
            .await
        }
        "remove" => remove(&data, &root, value.ok_or_else(|| invalid("缺少宠物 ID"))?).await,
        "pet-selection" | "use-lumi" | "cancel-lumi" | "use-pet" | "cancel-pet" => {
            let payload = if ["use-pet", "cancel-pet"].contains(&operation) {
                json!({"petId":value.ok_or_else(||invalid("缺少宠物 ID"))?})
            } else {
                json!({})
            };
            crate::injector::control_request(
                &data.join("launcher-runtime.json"),
                operation,
                payload,
            )
            .await
        }
        _ => Err(invalid("未知宠物动画操作")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> Value {
        json!({"version":1,"petId":"test","name":"测试","spritesheet":"sheet.png","columns":2,"rows":2,"animations":{"idle":{"frames":[[0,100],[1,100]]}},"lookFrames":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]})
    }
    #[test]
    fn validates_frames_and_confines_files() {
        let mut value = manifest();
        assert_eq!(
            validate_manifest(&value).unwrap()["animations"]["idle"]["loop"],
            true
        );
        value["spritesheet"] = json!("../sheet.png");
        assert!(validate_manifest(&value).is_err());
        value = manifest();
        value["animations"]["idle"]["frames"][0][0] = json!(4);
        assert!(validate_manifest(&value).is_err());
    }
    #[test]
    fn detects_static_png_dimensions() {
        let mut bytes = vec![0; 33];
        bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        bytes[8..12].copy_from_slice(&13u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&32u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&64u32.to_be_bytes());
        assert_eq!(image_dimensions(&bytes, "a.png").unwrap(), (32, 64));
        assert!(image_dimensions(&bytes, "a.webp").is_err());
    }
    #[tokio::test]
    async fn import_accepts_a_manifest_filename_relative_to_current_directory() {
        use std::io::Write;
        let cwd = std::env::current_dir().unwrap();
        let mut image = tempfile::Builder::new()
            .prefix(".pet-test-")
            .suffix(".png")
            .tempfile_in(&cwd)
            .unwrap();
        let mut bytes = vec![0; 33];
        bytes[..8].copy_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        bytes[8..12].copy_from_slice(&13u32.to_be_bytes());
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&32u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&32u32.to_be_bytes());
        image.write_all(&bytes).unwrap();
        let mut value = manifest();
        value["spritesheet"] = json!(image.path().file_name().unwrap().to_str().unwrap());
        let mut file = tempfile::Builder::new()
            .prefix(".pet-test-")
            .suffix(".json")
            .tempfile_in(&cwd)
            .unwrap();
        file.write_all(&serde_json::to_vec(&value).unwrap())
            .unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let result = import(
            data.path(),
            root,
            Path::new(file.path().file_name().unwrap()),
        )
        .await
        .unwrap();
        assert_eq!(result[0]["petId"], "test");
    }
}
