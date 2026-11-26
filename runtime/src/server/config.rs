use crate::ApiError;
use std::{collections::HashSet, env, path::PathBuf};

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub project_root: PathBuf,
    pub host: String,
    pub port: u16,
    pub instance_token: String,
    pub instance_secret: String,
    pub version: String,
    pub trusted_origins: HashSet<String>,
    pub codex_home: PathBuf,
    pub listen_fd: Option<i32>,
}

fn environment(primary: &str, legacy: &str) -> Option<String> {
    env::var(primary).ok().or_else(|| env::var(legacy).ok())
}

impl Config {
    pub fn from_args(args: &[String]) -> Result<Self, ApiError> {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| ApiError::new(500, "MISSING_HOME", "Home directory is unavailable"))?;
        let support = env::var_os("CODEX_PANEL_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(target_os = "macos") {
                    home.join("Library/Application Support/Codex Panel")
                } else if cfg!(windows) {
                    env::var_os("LOCALAPPDATA")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join("AppData/Local"))
                        .join("Codex Panel")
                } else {
                    env::var_os("XDG_DATA_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".local/share"))
                        .join("codex-panel")
                }
            });
        let root = env::var_os("CODEX_PANEL_APP_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .to_path_buf()
            });
        let mut config = Self {
            data_dir: environment("CODEX_PANEL_DATA_DIR", "CODEX_TASKBOARD_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| support.join("data")),
            static_dir: root.join("dist/web"),
            project_root: root,
            host: environment("CODEX_PANEL_HOST", "CODEX_TASKBOARD_HOST")
                .unwrap_or_else(|| "0.0.0.0".into()),
            port: environment("CODEX_PANEL_PORT", "CODEX_TASKBOARD_PORT")
                .unwrap_or_else(|| "47823".into())
                .parse()
                .map_err(|_| {
                    ApiError::new(
                        400,
                        "INVALID_PORT",
                        "Port must be an integer between 1 and 65535",
                    )
                })?,
            instance_token: environment(
                "CODEX_PANEL_INSTANCE_TOKEN",
                "CODEX_TASKBOARD_INSTANCE_TOKEN",
            )
            .unwrap_or_default(),
            instance_secret: environment(
                "CODEX_PANEL_INSTANCE_SECRET",
                "CODEX_TASKBOARD_INSTANCE_SECRET",
            )
            .unwrap_or_default(),
            version: environment("CODEX_PANEL_VERSION", "CODEX_TASKBOARD_VERSION")
                .unwrap_or_else(|| "development".into()),
            trusted_origins: parse_trusted_origins(environment(
                "CODEX_PANEL_TRUSTED_ORIGINS",
                "CODEX_TASKBOARD_TRUSTED_ORIGINS",
            ))?,
            codex_home: env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex")),
            listen_fd: environment("CODEX_PANEL_LISTEN_FD", "CODEX_TASKBOARD_LISTEN_FD")
                .map(|v| v.parse())
                .transpose()
                .map_err(|_| {
                    ApiError::new(
                        400,
                        "INVALID_LISTEN_FD",
                        "Listener file descriptor must be an integer",
                    )
                })?,
        };
        let mut index = 0;
        while index < args.len() {
            let key = &args[index];
            if key == "--dev" {
                index += 1;
                continue;
            }
            let value = args.get(index + 1).ok_or_else(|| {
                ApiError::new(400, "INVALID_ARGUMENT", format!("Missing value for {key}"))
            })?;
            match key.as_str() {
                "--data-dir" => config.data_dir = PathBuf::from(value),
                "--static-dir" => config.static_dir = PathBuf::from(value),
                "--app-root" => config.project_root = PathBuf::from(value),
                "--host" => config.host = value.clone(),
                "--port" => {
                    config.port = value.parse().map_err(|_| {
                        ApiError::new(
                            400,
                            "INVALID_PORT",
                            "Port must be an integer between 1 and 65535",
                        )
                    })?
                }
                _ => {
                    return Err(ApiError::new(
                        400,
                        "INVALID_ARGUMENT",
                        format!("Unknown server argument: {key}"),
                    ))
                }
            }
            index += 2;
        }
        if !["127.0.0.1", "0.0.0.0"].contains(&config.host.as_str()) || config.port == 0 {
            return Err(ApiError::new(
                400,
                "INVALID_LISTENER",
                "Host must be 127.0.0.1 or 0.0.0.0, and port must be between 1 and 65535",
            ));
        }
        let token = config.instance_token.trim();
        if !token.is_empty()
            && (!(16..=128).contains(&token.len())
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        {
            return Err(ApiError::new(
                400,
                "INVALID_INSTANCE_TOKEN",
                "CODEX_PANEL_INSTANCE_TOKEN must be an identifier",
            ));
        }
        if !token.is_empty()
            && (!(32..=128).contains(&config.instance_secret.len())
                || !config
                    .instance_secret
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() || b == b'-'))
        {
            return Err(ApiError::new(
                400,
                "INVALID_INSTANCE_SECRET",
                "CODEX_PANEL_INSTANCE_SECRET must be set in launcher mode",
            ));
        }
        let cwd = env::current_dir()?;
        if config.data_dir.is_relative() {
            config.data_dir = cwd.join(&config.data_dir);
        }
        if config.static_dir.is_relative() {
            config.static_dir = cwd.join(&config.static_dir);
        }
        Ok(config)
    }

    pub fn route_prefix(&self) -> String {
        if self.instance_token.is_empty() {
            String::new()
        } else {
            format!("/{}", self.instance_token)
        }
    }
}

fn parse_trusted_origins(raw: Option<String>) -> Result<HashSet<String>, ApiError> {
    let Some(raw) = raw else {
        return Ok(HashSet::new());
    };
    let mut origins = HashSet::new();
    for item in raw.split(',') {
        let url = url::Url::parse(item.trim()).map_err(|_| {
            ApiError::new(
                400,
                "INVALID_TRUSTED_ORIGIN",
                "Trusted origins must be exact HTTPS origins",
            )
        })?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || item.contains('*')
            || !origins.insert(url.origin().ascii_serialization())
        {
            return Err(ApiError::new(
                400,
                "INVALID_TRUSTED_ORIGIN",
                "Trusted origins must be unique HTTPS origins without paths or credentials",
            ));
        }
    }
    Ok(origins)
}
