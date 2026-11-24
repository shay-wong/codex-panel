use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::Mutex as AsyncMutex;

const CLIENT_ID: &str = "Ov23li0WSDXdESm72I8H";
const DEVICE_ENDPOINT: &str = "https://github.com/login/device/code";
const TOKEN_ENDPOINT: &str = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT: &str = "https://api.github.com/user";
const VERIFICATION_URI: &str = "https://github.com/login/device";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthStatus {
    pub login: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceLogin {
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LoginResult {
    pub status: &'static str,
    pub interval: u64,
    pub login: Option<String>,
}

impl LoginResult {
    fn pending(interval: u64) -> Self {
        Self {
            status: "pending",
            interval,
            login: None,
        }
    }
}

#[derive(Clone)]
struct PendingLogin {
    device_code: String,
    public: DeviceLogin,
    expires: Instant,
    next_poll: Instant,
}

#[derive(Default)]
struct Inner {
    generation: u64,
    session: Option<PendingLogin>,
}

#[derive(Default)]
pub(super) struct GitHubAuth {
    inner: Mutex<Inner>,
    request: AsyncMutex<()>,
    credential_marker: Option<PathBuf>,
}

#[derive(Deserialize)]
struct DeviceResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<u64>,
    error: Option<String>,
    interval: Option<u64>,
}

// The complete pair is replaced in one system-credential write when GitHub rotates it.
#[derive(Deserialize, Serialize)]
struct StoredToken {
    access_token: String,
    expires_at: Option<u64>,
    refresh_token: Option<String>,
    refresh_expires_at: Option<u64>,
    login: String,
}

impl StoredToken {
    fn from_response(response: TokenResponse, login: String, now: u64) -> Result<Self, String> {
        let token = response
            .access_token
            .filter(|value| !value.is_empty())
            .ok_or("GitHub 未返回有效的访问令牌，请重新登录。")?;
        if !response
            .token_type
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("bearer"))
            || response.expires_in == Some(0)
            || response
                .refresh_token
                .as_ref()
                .is_some_and(String::is_empty)
            || response.refresh_token_expires_in == Some(0)
        {
            return Err("GitHub 返回的登录凭据无效，请重新登录。".into());
        }
        Ok(Self {
            access_token: token,
            expires_at: response
                .expires_in
                .map(|seconds| now.saturating_add(seconds)),
            refresh_token: response.refresh_token,
            refresh_expires_at: response
                .refresh_token_expires_in
                .map(|seconds| now.saturating_add(seconds)),
            login,
        })
    }

    fn can_refresh(&self, now: u64) -> bool {
        self.refresh_token.is_some() && self.refresh_expires_at.is_none_or(|expiry| expiry > now)
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("codex-panel/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法创建 GitHub 登录连接。".into())
}

async fn post<T: serde::de::DeserializeOwned>(
    url: &'static str,
    fields: &[(&str, &str)],
) -> Result<T, String> {
    let mut form = reqwest::Url::parse("https://github.com/").unwrap();
    form.query_pairs_mut().extend_pairs(fields.iter().copied());
    let response = client()?
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form.query().unwrap_or_default().to_string())
        .send()
        .await
        .map_err(|_| "连接 GitHub 登录服务失败，请检查网络后重试。")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub 登录服务返回 HTTP {}。",
            response.status().as_u16()
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|_| "无法读取 GitHub 登录响应。")?;
    serde_json::from_str(&text).map_err(|_| "GitHub 登录响应格式无效。".into())
}

fn read_token() -> Result<Option<StoredToken>, String> {
    super::github_credentials::read()?
        .map(|value| {
            serde_json::from_str(&value)
                .map_err(|_| "GitHub 登录凭据格式无效，请退出后重新登录。".into())
        })
        .transpose()
}

fn save_token(token: &StoredToken) -> Result<(), String> {
    let value = serde_json::to_string(token).map_err(|_| "无法保存 GitHub 登录凭据。")?;
    super::github_credentials::write(&value)
}

impl GitHubAuth {
    pub fn new(data_directory: PathBuf) -> Self {
        Self { credential_marker: Some(data_directory.join("github-login-enabled")), ..Self::default() }
    }

    fn credentials_enabled(&self) -> bool {
        self.credential_marker.as_ref().is_none_or(|path| path.is_file())
    }

    fn store_token(&self, token: &StoredToken) -> Result<(), String> {
        save_token(token)?;
        if let Some(path) = &self.credential_marker {
            // This marker contains no credentials and keeps optional keychains off the anonymous path.
            fs::write(path, b"").map_err(|_| "无法保存 GitHub 登录状态，请重试。")?;
        }
        Ok(())
    }

    pub fn status(&self) -> Result<AuthStatus, String> {
        let _guard = self.inner.lock().unwrap();
        if !self.credentials_enabled() { return Ok(AuthStatus { login: None }); }
        let now = now_seconds();
        let login = read_token()?
            .filter(|token| {
                token.expires_at.is_none_or(|expiry| expiry > now) || token.can_refresh(now)
            })
            .map(|token| token.login);
        Ok(AuthStatus { login })
    }

    pub async fn start(&self) -> Result<DeviceLogin, String> {
        let _request = self.request.lock().await;
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(session) = &inner.session {
                if session.expires > Instant::now() {
                    return Ok(session.public.clone());
                }
            }
            inner.generation = inner.generation.wrapping_add(1);
            inner.session = None;
            inner.generation
        };
        let response: DeviceResponse = post(DEVICE_ENDPOINT, &[("client_id", CLIENT_ID)]).await?;
        if let Some(error) = response.error {
            return Err(match error.as_str() {
                "device_flow_disabled" => {
                    "此 GitHub OAuth 应用尚未启用 Device Flow，请联系维护者。"
                }
                "incorrect_client_credentials" => "GitHub OAuth 应用配置无效，请联系维护者。",
                _ => "无法开始 GitHub 登录，请稍后重试。",
            }
            .into());
        }
        let seconds = response
            .expires_in
            .filter(|value| *value > 0 && *value <= 3600)
            .ok_or("GitHub 登录有效期无效。")?;
        let interval = response.interval.unwrap_or(5);
        let code = response
            .device_code
            .filter(|value| !value.is_empty() && value.len() <= 2048)
            .ok_or("GitHub 未返回设备授权码。")?;
        let user_code = response
            .user_code
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 32
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
            .ok_or("GitHub 未返回有效的授权验证码。")?;
        if response.verification_uri.as_deref() != Some(VERIFICATION_URI)
            || interval == 0
            || interval > 3600
        {
            return Err("GitHub 设备授权响应无效。".into());
        }
        let public = DeviceLogin {
            user_code,
            verification_uri: VERIFICATION_URI.into(),
            interval,
            expires_at: now_seconds().saturating_add(seconds),
        };
        let now = Instant::now();
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return Err("GitHub 登录已取消。".into());
        }
        inner.session = Some(PendingLogin {
            device_code: code,
            public: public.clone(),
            expires: now + Duration::from_secs(seconds),
            next_poll: now + Duration::from_secs(interval),
        });
        Ok(public)
    }

    fn begin_poll(&self, now: Instant) -> Result<Result<(u64, PendingLogin), LoginResult>, String> {
        let mut inner = self.inner.lock().unwrap();
        let generation = inner.generation;
        let session = inner
            .session
            .as_mut()
            .ok_or("当前没有等待中的 GitHub 登录。")?;
        if session.expires <= now {
            inner.session = None;
            return Err("GitHub 授权码已过期，请重新登录。".into());
        }
        if session.next_poll > now {
            return Ok(Err(LoginResult::pending(
                session.next_poll.duration_since(now).as_secs().max(1),
            )));
        }
        session.next_poll = now + Duration::from_secs(session.public.interval);
        Ok(Ok((generation, session.clone())))
    }

    fn poll_error(
        &self,
        generation: u64,
        error: &str,
        interval: Option<u64>,
        now: Instant,
    ) -> Result<LoginResult, String> {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return Err("GitHub 登录已取消。".into());
        }
        let session = inner.session.as_mut().ok_or("GitHub 登录已取消。")?;
        match error {
            "authorization_pending" => Ok(LoginResult::pending(session.public.interval)),
            "slow_down" => {
                session.public.interval = interval
                    .unwrap_or(0)
                    .max(session.public.interval.saturating_add(5))
                    .min(3600);
                session.next_poll = now + Duration::from_secs(session.public.interval);
                Ok(LoginResult::pending(session.public.interval))
            }
            _ => {
                inner.session = None;
                Err(match error {
                    "access_denied" => "GitHub 授权已拒绝，可重新发起登录。",
                    "expired_token" => "GitHub 授权码已过期，请重新登录。",
                    "incorrect_device_code" => "GitHub 设备授权码无效，请重新登录。",
                    _ => "GitHub 登录未完成，请重新登录。",
                }
                .into())
            }
        }
    }

    pub async fn poll(&self) -> Result<LoginResult, String> {
        let _request = self.request.lock().await;
        let (generation, session) = match self.begin_poll(Instant::now())? {
            Ok(request) => request,
            Err(pending) => return Ok(pending),
        };
        let response: TokenResponse = post(
            TOKEN_ENDPOINT,
            &[
                ("client_id", CLIENT_ID),
                ("device_code", &session.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
        .await?;
        if let Some(error) = response.error.as_deref() {
            return self.poll_error(generation, error, response.interval, Instant::now());
        }
        let mut token = StoredToken::from_response(response, String::new(), now_seconds())?;
        let user = client()?
            .get(USER_ENDPOINT)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(&token.access_token)
            .send()
            .await
            .map_err(|_| "读取 GitHub 账号失败，请检查网络后重试。")?;
        if !user.status().is_success() {
            return Err(format!(
                "GitHub 账号验证返回 HTTP {}，请重新登录。",
                user.status().as_u16()
            ));
        }
        #[derive(Deserialize)]
        struct User {
            login: String,
        }
        let text = user
            .text()
            .await
            .map_err(|_| "无法读取 GitHub 账号信息。")?;
        let user: User = serde_json::from_str(&text).map_err(|_| "GitHub 账号信息格式无效。")?;
        if user.login.is_empty()
            || user.login.len() > 39
            || !user
                .login
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("GitHub 账号名称无效。".into());
        }
        token.login = user.login;
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || inner.session.is_none() {
            return Err("GitHub 登录已取消。".into());
        }
        if inner.session.as_ref().unwrap().expires <= Instant::now() {
            inner.session = None;
            return Err("GitHub 授权码已过期，请重新登录。".into());
        }
        self.store_token(&token)?;
        inner.session = None;
        Ok(LoginResult {
            status: "connected",
            interval: 0,
            login: Some(token.login),
        })
    }

    pub fn cancel(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1);
        inner.session = None;
    }

    pub fn logout(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1);
        inner.session = None;
        if self.credentials_enabled() { super::github_credentials::delete()?; }
        if let Some(path) = &self.credential_marker {
            match fs::remove_file(path) {
                Ok(()) => {},
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(_) => return Err("无法清除 GitHub 登录状态，请重试。".into()),
            }
        }
        Ok(())
    }

    pub async fn access_token(&self) -> Result<Option<String>, String> {
        let _request = self.request.lock().await;
        if !self.credentials_enabled() { return Ok(None); }
        let (generation, token) = {
            let inner = self.inner.lock().unwrap();
            (inner.generation, read_token()?)
        };
        let Some(token) = token else {
            return Ok(None);
        };
        let now = now_seconds();
        if token
            .expires_at
            .is_none_or(|expiry| expiry > now.saturating_add(60))
        {
            return Ok(Some(token.access_token));
        }
        if !token.can_refresh(now) {
            return Err("GitHub 登录已过期，请重新登录。".into());
        }
        let response: TokenResponse = post(
            TOKEN_ENDPOINT,
            &[
                ("client_id", CLIENT_ID),
                ("grant_type", "refresh_token"),
                ("refresh_token", token.refresh_token.as_deref().unwrap()),
            ],
        )
        .await?;
        if response.error.is_some() {
            return Err("GitHub 登录已过期或被撤销，请退出后重新登录。".into());
        }
        let refreshed = StoredToken::from_response(response, token.login, now_seconds())?;
        if refreshed.refresh_token.is_none() {
            return Err("GitHub 未返回更新后的刷新令牌，请重新登录。".into());
        }
        let inner = self.inner.lock().unwrap();
        if inner.generation != generation {
            return Err("GitHub 登录状态已改变，请重试。".into());
        }
        self.store_token(&refreshed)?;
        Ok(Some(refreshed.access_token))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anonymous_updates_do_not_open_an_optional_credential_store() {
        let directory = std::env::temp_dir().join(format!("panel-github-optional-{}-{}", std::process::id(), now_seconds()));
        let auth = GitHubAuth::new(directory);
        assert!(auth.status().unwrap().login.is_none());
        assert!(tauri::async_runtime::block_on(auth.access_token()).unwrap().is_none());
        auth.logout().unwrap();
    }

    fn pending(auth: &GitHubAuth, now: Instant) {
        auth.inner.lock().unwrap().session = Some(PendingLogin {
            device_code: "private-device-code".into(),
            public: DeviceLogin {
                user_code: "ABCD-EFGH".into(),
                verification_uri: VERIFICATION_URI.into(),
                interval: 5,
                expires_at: now_seconds() + 900,
            },
            expires: now + Duration::from_secs(900),
            next_poll: now + Duration::from_secs(5),
        });
    }

    #[test]
    fn device_poll_obeys_initial_interval_and_slow_down() {
        let auth = GitHubAuth::default();
        let now = Instant::now();
        pending(&auth, now);
        assert!(matches!(
            auth.begin_poll(now),
            Ok(Err(LoginResult {
                status: "pending",
                ..
            }))
        ));
        assert!(matches!(
            auth.begin_poll(now + Duration::from_secs(5)),
            Ok(Ok(_))
        ));
        let result = auth
            .poll_error(0, "authorization_pending", None, now)
            .unwrap();
        assert_eq!(result.interval, 5);
        let result = auth
            .poll_error(0, "slow_down", None, now + Duration::from_secs(5))
            .unwrap();
        assert_eq!(result.interval, 10);
        assert!(matches!(
            auth.begin_poll(now + Duration::from_secs(14)),
            Ok(Err(_))
        ));
        assert!(matches!(
            auth.begin_poll(now + Duration::from_secs(15)),
            Ok(Ok(_))
        ));
        let result = auth.poll_error(0, "slow_down", Some(30), now).unwrap();
        assert_eq!(result.interval, 30);
    }

    #[test]
    fn expired_denied_and_cancelled_sessions_cannot_complete() {
        let auth = GitHubAuth::default();
        let now = Instant::now();
        pending(&auth, now);
        assert!(auth.begin_poll(now + Duration::from_secs(900)).is_err());
        assert!(auth.inner.lock().unwrap().session.is_none());
        pending(&auth, now);
        assert!(auth.poll_error(0, "access_denied", None, now).is_err());
        assert!(auth.inner.lock().unwrap().session.is_none());
        pending(&auth, now);
        auth.cancel();
        pending(&auth, now);
        assert!(auth.poll_error(0, "expired_token", None, now).is_err());
        assert!(auth.inner.lock().unwrap().session.is_some());
    }

    #[test]
    fn public_results_hide_device_and_token_secrets_and_rotated_pair_keeps_expiry() {
        let auth = GitHubAuth::default();
        pending(&auth, Instant::now());
        let value =
            serde_json::to_string(&auth.inner.lock().unwrap().session.as_ref().unwrap().public)
                .unwrap();
        assert!(value.contains("ABCD-EFGH"));
        assert!(!value.contains("private-device-code"));
        let reply: TokenResponse = serde_json::from_str(r#"{"access_token":"new-access","token_type":"bearer","expires_in":28800,"refresh_token":"new-refresh","refresh_token_expires_in":15897600}"#).unwrap();
        let stored = StoredToken::from_response(reply, "octocat".into(), 100).unwrap();
        assert_eq!(stored.expires_at, Some(28900));
        assert_eq!(stored.refresh_expires_at, Some(15897700));
        assert!(stored.can_refresh(100));
        assert!(!stored.can_refresh(15897700));
        let status = serde_json::to_string(&AuthStatus {
            login: Some(stored.login),
        })
        .unwrap();
        assert_eq!(status, r#"{"login":"octocat"}"#);
    }
}
