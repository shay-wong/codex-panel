use crate::ApiError;
use std::{env, path::PathBuf};

#[derive(Clone, Debug)]
pub struct Options {
    pub port: u16,
    pub port_explicit: bool,
    pub pipe: bool,
    pub launch: bool,
    pub watch: bool,
    pub open: bool,
    pub refresh: bool,
    pub refresh_if_running: bool,
    pub attach_existing: bool,
    pub discover_port: bool,
    pub open_existing: bool,
    pub status: bool,
    pub daemon: bool,
    pub stop_residents: bool,
    pub stop_managed: bool,
    pub control: Option<String>,
    pub startup_token: Option<String>,
    pub screenshot: Option<PathBuf>,
    pub app_path: PathBuf,
    pub app_executable: Option<PathBuf>,
}

impl Options {
    pub fn parse(args: &[String]) -> Result<Self, ApiError> {
        let mut options = Self {
            port: 9229,
            port_explicit: false,
            pipe: false,
            launch: false,
            watch: false,
            open: false,
            refresh: false,
            refresh_if_running: false,
            attach_existing: false,
            discover_port: false,
            open_existing: false,
            status: false,
            daemon: false,
            stop_residents: false,
            stop_managed: false,
            control: None,
            startup_token: None,
            screenshot: None,
            app_path: if cfg!(target_os = "linux") {
                "/usr/bin/chatgpt".into()
            } else {
                "/Applications/ChatGPT.app".into()
            },
            app_executable: None,
        };
        let mut index = 0;
        while index < args.len() {
            let flag = args[index].as_str();
            let mut value = || -> Result<String, ApiError> {
                index += 1;
                args.get(index)
                    .cloned()
                    .ok_or_else(|| invalid(format!("{flag} requires a value")))
            };
            match flag {
                "--launch" => options.launch = true,
                "--cdp-pipe" => options.pipe = true,
                "--watch" => options.watch = true,
                "--open" => options.open = true,
                "--refresh" => options.refresh = true,
                "--refresh-if-running" => options.refresh_if_running = true,
                "--attach-existing" => options.attach_existing = true,
                "--discover-port" => options.discover_port = true,
                "--open-existing" => options.open_existing = true,
                "--status" => options.status = true,
                "--daemon" => options.daemon = true,
                "--stop-residents" => options.stop_residents = true,
                "--stop-managed" => options.stop_managed = true,
                "--startup-token" => {
                    let token = value()?;
                    if !identifier(&token, 100) {
                        return Err(invalid("--startup-token must be an identifier"));
                    }
                    options.startup_token = Some(token);
                }
                "--control" => {
                    let action = value()?;
                    if !matches!(action.as_str(), "status" | "open" | "shutdown") {
                        return Err(invalid("--control must be status, open, or shutdown"));
                    }
                    options.control = Some(action);
                }
                "--port" => {
                    options.port = value()?
                        .parse::<u16>()
                        .ok()
                        .filter(|port| *port > 0)
                        .ok_or_else(|| invalid("--port must be an integer between 1 and 65535"))?;
                    options.port_explicit = true;
                }
                "--screenshot" => options.screenshot = Some(PathBuf::from(value()?)),
                "--app-path" => options.app_path = value()?.into(),
                "--app-executable" => options.app_executable = Some(value()?.into()),
                _ => return Err(invalid(format!("Unknown option: {flag}"))),
            }
            index += 1;
        }
        if cfg!(target_os = "linux") && options.launch {
            options.pipe = true;
        }
        if options.pipe && !options.launch {
            return Err(invalid("--cdp-pipe requires --launch"));
        }
        Ok(options)
    }
}

#[derive(Clone, Debug)]
pub struct Environment {
    pub app_root: PathBuf,
    pub data_dir: PathBuf,
    pub runtime_file: Option<PathBuf>,
    pub preferences_file: Option<PathBuf>,
    pub profile: PathBuf,
    pub panel_port: u16,
    pub token: Option<String>,
    pub secret: Option<String>,
    pub version: String,
    pub capability: String,
}

impl Environment {
    pub fn read() -> Result<Self, ApiError> {
        let root = setting("APP_ROOT").map(PathBuf::from).unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_owned()
        });
        let token = setting("INSTANCE_TOKEN");
        let secret = setting("INSTANCE_SECRET");
        if token.is_some() != secret.is_some() {
            return Err(invalid(
                "Panel instance token and secret must be configured together",
            ));
        }
        if token
            .as_deref()
            .is_some_and(|s| !(16..=128).contains(&s.len()) || !identifier(s, 128))
        {
            return Err(invalid("CODEX_PANEL_INSTANCE_TOKEN must be an identifier"));
        }
        if secret.as_deref().is_some_and(|s| {
            !(32..=128).contains(&s.len()) || !s.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
        }) {
            return Err(invalid(
                "CODEX_PANEL_INSTANCE_SECRET must be set in launcher mode",
            ));
        }
        let panel_port = setting("PORT")
            .unwrap_or_else(|| "47823".into())
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| invalid("CODEX_PANEL_PORT must be between 1 and 65535"))?;
        Ok(Self {
            data_dir: setting("DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".data")),
            runtime_file: setting("RUNTIME_FILE").map(PathBuf::from),
            preferences_file: setting("PREFERENCES_FILE").map(PathBuf::from),
            profile: setting("CODEX_PROFILE")
                .map(PathBuf::from)
                .unwrap_or_else(|| env::temp_dir().join("codex-panel-independent-profile-v2")),
            app_root: root,
            panel_port,
            token,
            secret,
            version: setting("VERSION").unwrap_or_else(|| "development".into()),
            capability: uuid::Uuid::new_v4().to_string(),
        })
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.panel_port)
    }
    pub fn base_url(&self) -> String {
        self.token.as_ref().map_or_else(
            || self.origin(),
            |token| format!("{}/{token}", self.origin()),
        )
    }
    pub fn page_url(&self) -> String {
        format!("{}/?host=codex", self.base_url())
    }
}

pub fn setting(name: &str) -> Option<String> {
    [
        format!("CODEX_PANEL_{name}"),
        format!("CODEX_TASKBOARD_{name}"),
    ]
    .iter()
    .find_map(|key| {
        env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|s| s.trim().to_owned())
    })
}

pub fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

pub fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "INVALID_INJECTOR_ARGUMENT", message)
}
