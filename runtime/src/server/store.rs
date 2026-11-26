use crate::ApiError;
use serde_json::{json, Value};
use std::path::Path;

pub async fn read(path: &Path, default: Value) -> Result<Value, ApiError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default),
        Err(error) => Err(error.into()),
    }
}

pub async fn write(path: &Path, value: &Value) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).await?;
    use tokio::io::AsyncWriteExt;
    let result = async {
        file.write_all(format!("{}\n", serde_json::to_string(value)?).as_bytes())
            .await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&temporary, path).await?;
        Ok::<(), ApiError>(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

pub fn empty_cloud() -> Value {
    json!({"version":1,"remoteUrl":null,"actorName":null,"sharedKey":null,"projectMappings":{}})
}
pub fn cloud_url(value: &Value) -> Result<String, ApiError> {
    let raw = value.as_str().ok_or_else(|| {
        ApiError::new(
            400,
            "INVALID_CLOUD_URL",
            "Cloud panel URL must be a valid URL",
        )
    })?;
    let url = url::Url::parse(raw).map_err(|_| {
        ApiError::new(
            400,
            "INVALID_CLOUD_URL",
            "Cloud panel URL must be a valid URL",
        )
    })?;
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::new(
            400,
            "INVALID_CLOUD_URL",
            "Cloud panel URL must be an HTTPS origin (loopback HTTP is allowed for development)",
        ));
    }
    Ok(url.origin().ascii_serialization())
}
