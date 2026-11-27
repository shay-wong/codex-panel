use super::{image_dimensions, invalid, save, validate_manifest, Audio, IMAGE_LIMIT, STATES};
use crate::ApiError;
use reqwest::{Client, Url};
use serde_json::{json, Map, Value};
use std::{path::Path, time::Duration};

const PETDEX: &str = "https://assets.petdex.dev";
const GALLERY: &str = "https://codex-pets.net";
const PAGE_SIZE: usize = 12;
const CATALOG_LIMIT: usize = 4 * 1024 * 1024;

struct Pet {
    id: String,
    name: String,
    description: Option<String>,
    sheet: Url,
    manifest: Url,
    poster: Option<Url>,
    version: u64,
}

fn client() -> Result<Client, ApiError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(network_error)
}

fn network_error(error: reqwest::Error) -> ApiError {
    invalid(format!("社区资源下载失败：{error}"))
}

async fn download(client: &Client, url: Url, limit: usize) -> Result<Vec<u8>, ApiError> {
    let mut response = client.get(url).send().await.map_err(network_error)?;
    if !response.status().is_success() {
        return Err(invalid(format!(
            "社区资源下载失败（HTTP {}）",
            response.status()
        )));
    }
    let mut bytes = Vec::new();
    // 按实际收到的字节限制体积，远端声明的长度只能作为提示。
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > limit - bytes.len() {
            return Err(invalid("社区资源超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_json(client: &Client, url: Url, limit: usize) -> Result<Value, ApiError> {
    Ok(serde_json::from_slice(
        &download(client, url, limit).await?,
    )?)
}

fn valid_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
}

fn name(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| {
        !value.trim().is_empty()
            && value.encode_utf16().count() <= 240
            && !value.chars().any(|character| character.is_ascii_control())
    })
}

fn asset_url(value: &Value, base: &Url, prefix: &str) -> Option<Url> {
    let url = base.join(value.as_str()?).ok()?;
    (url.origin() == base.origin()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path().starts_with(prefix))
    .then_some(url)
}

fn image_url(value: &Value, base: &Url, prefix: &str) -> Option<Url> {
    let url = asset_url(value, base, prefix)?;
    let extension = Path::new(url.path())
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "webp").then_some(url)
}

impl Pet {
    fn summary(&self) -> Value {
        let mut summary = json!({"id": self.id, "name": self.name});
        if let Some(description) = &self.description {
            summary["description"] = json!(description);
        }
        if let Some(poster) = &self.poster {
            summary["thumbnailUrl"] = json!(poster.as_str());
        } else {
            summary["preview"] = json!({
                "spritesheetUrl": self.sheet.as_str(), "columns": 8,
                "rows": if self.version == 2 { 11 } else { 9 }, "frame": 0,
                "aspectRatio": 192.0 / 208.0,
            });
        }
        summary
    }
}

async fn petdex_directory(client: &Client) -> Result<Vec<Pet>, ApiError> {
    let base = Url::parse(PETDEX).unwrap();
    let directory = read_json(
        client,
        base.join("/manifests/petdex-v2.json").unwrap(),
        CATALOG_LIMIT,
    )
    .await?;
    let fields = directory["fields"]
        .as_array()
        .filter(|_| directory["v"] == 2)
        .ok_or_else(|| invalid("Petdex 目录格式无效"))?;
    let position = |key: &str| {
        fields
            .iter()
            .position(|field| field == key)
            .ok_or_else(|| invalid("Petdex 目录缺少资源字段"))
    };
    let slug = position("slug")?;
    let display_name = position("displayName")?;
    let sheet = position("spritesheet")?;
    let manifest = position("petJson")?;
    let version = position("spriteVersionNumber")?;
    let pets = directory["pets"]
        .as_array()
        .ok_or_else(|| invalid("Petdex 目录格式无效"))?;
    Ok(pets
        .iter()
        .filter_map(|row| {
            let id = row[slug].as_str().filter(|id| valid_id(id))?;
            Some(Pet {
                id: id.into(),
                name: name(&row[display_name])?.into(),
                description: None,
                sheet: image_url(&row[sheet], &base, "/pets/")?,
                manifest: asset_url(&row[manifest], &base, "/pets/")?,
                poster: None,
                version: row[version].as_u64().unwrap_or(1),
            })
        })
        .collect())
}

fn gallery_pet(entry: &Value, base: &Url) -> Option<Pet> {
    let id = entry["id"].as_str().filter(|id| valid_id(id))?;
    let sheet = image_url(&entry["spritesheetUrl"], base, "/assets/pets/")?;
    Some(Pet {
        id: id.into(),
        name: name(&entry["displayName"])?.into(),
        description: entry["description"]
            .as_str()
            .map(|text| text.chars().take(500).collect()),
        manifest: sheet.join("pet.json").ok()?,
        sheet,
        poster: image_url(&entry["posterUrl"], base, "/assets/pets/"),
        version: entry["spriteVersionNumber"].as_u64().unwrap_or(1),
    })
}

pub(super) async fn list(source: &str, query: &str, page: usize) -> Result<Value, ApiError> {
    if !(1..=10_000).contains(&page) || query.encode_utf16().count() > 120 {
        return Err(invalid("社区目录查询参数无效"));
    }
    let client = client()?;
    let query = query.trim();
    match source {
        "petdex" => {
            let keyword = query.to_lowercase();
            let matches: Vec<Pet> = petdex_directory(&client)
                .await?
                .into_iter()
                .filter(|pet| {
                    format!("{} {}", pet.name, pet.id)
                        .to_lowercase()
                        .contains(&keyword)
                })
                .collect();
            let pets: Vec<Value> = matches
                .iter()
                .skip((page - 1) * PAGE_SIZE)
                .take(PAGE_SIZE)
                .map(Pet::summary)
                .collect();
            Ok(
                json!({"pets": pets, "total": matches.len(), "totalPages": matches.len().div_ceil(PAGE_SIZE)}),
            )
        }
        "gallery" => {
            let base = Url::parse(GALLERY).unwrap();
            let mut url = base.join("/api/pets").unwrap();
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair("page", &page.to_string())
                .append_pair("pageSize", &PAGE_SIZE.to_string());
            let directory = read_json(&client, url, CATALOG_LIMIT).await?;
            let entries = directory["pets"]
                .as_array()
                .ok_or_else(|| invalid("Codex Pets Gallery 目录格式无效"))?;
            let (Some(total), Some(pages)) = (
                directory["total"].as_u64(),
                directory["totalPages"].as_u64(),
            ) else {
                return Err(invalid("Codex Pets Gallery 分页格式无效"));
            };
            let pets: Vec<Value> = entries
                .iter()
                .filter_map(|entry| gallery_pet(entry, &base))
                .map(|pet| pet.summary())
                .collect();
            Ok(json!({"pets": pets, "total": total, "totalPages": pages}))
        }
        _ => Err(invalid("不支持的宠物平台")),
    }
}

pub(super) async fn install(
    data: &Path,
    root: &Path,
    source: &str,
    id: &str,
) -> Result<Value, ApiError> {
    if !valid_id(id) {
        return Err(invalid("社区宠物 ID 无效"));
    }
    let client = client()?;
    let pet = match source {
        "petdex" => petdex_directory(&client)
            .await?
            .into_iter()
            .find(|pet| pet.id == id),
        "gallery" => {
            let base = Url::parse(GALLERY).unwrap();
            let url = base.join(&format!("/api/pets/{id}")).unwrap();
            gallery_pet(&read_json(&client, url, CATALOG_LIMIT).await?["pet"], &base)
                .filter(|pet| pet.id == id)
        }
        _ => return Err(invalid("不支持的宠物平台")),
    }
    .ok_or_else(|| invalid("找不到该社区宠物"))?;
    let extension = Path::new(pet.sheet.path())
        .extension()
        .unwrap()
        .to_string_lossy()
        .to_ascii_lowercase();
    let sheet = format!("spritesheet.{extension}");
    let (metadata, image) = tokio::try_join!(
        read_json(&client, pet.manifest, 1024 * 1024),
        download(&client, pet.sheet, IMAGE_LIMIT),
    )?;
    let display_name = name(&metadata["displayName"]).ok_or_else(|| invalid("社区宠物清单无效"))?;
    if !metadata["spritesheetPath"]
        .as_str()
        .is_some_and(|value| super::filename(value, &["png", "webp"]))
    {
        return Err(invalid("社区宠物清单无效"));
    }
    let (width, height) = image_dimensions(&image, &sheet)?;
    let (rows, version) = match (width, height) {
        (1536, 1872) => (9, 1),
        (1536, 2288) => (11, 2),
        _ => {
            return Err(invalid(
                "社区宠物图集须为 Codex v1（1536×1872）或 v2（1536×2288）",
            ))
        }
    };
    if metadata
        .get("spriteVersionNumber")
        .is_some_and(|value| value != version)
    {
        return Err(invalid("社区宠物清单版本与图集尺寸不符"));
    }
    // 保留 Codex 原生动作时长，已用的帧之后是空格，不能并入循环。
    const DURATIONS: [&[u32]; 9] = [
        &[1680, 660, 660, 840, 840, 1920],
        &[120, 120, 120, 120, 120, 120, 120, 220],
        &[120, 120, 120, 120, 120, 120, 120, 220],
        &[140, 140, 140, 280],
        &[140, 140, 140, 140, 280],
        &[140, 140, 140, 140, 140, 140, 140, 240],
        &[150, 150, 150, 150, 150, 260],
        &[120, 120, 120, 120, 120, 220],
        &[150, 150, 150, 150, 150, 280],
    ];
    let animations: Map<String, Value> = STATES
        .iter()
        .zip(DURATIONS)
        .enumerate()
        .map(|(row, (state, durations))| {
            let frames: Vec<Value> = durations
                .iter()
                .enumerate()
                .map(|(column, duration)| json!([row * 8 + column, duration]))
                .collect();
            (state.to_string(), json!({"frames": frames}))
        })
        .collect();
    let mut manifest = json!({
        "version": 1, "petId": format!("community-{source}-{id}"), "name": display_name,
        "spritesheet": sheet, "columns": 8, "rows": rows, "animations": animations,
    });
    if rows == 11 {
        manifest["lookFrames"] = json!((72..88).collect::<Vec<_>>());
    }
    save(
        data,
        root,
        validate_manifest(&manifest)?,
        image,
        Audio::new(),
    )
    .await
}
