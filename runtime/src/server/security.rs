use super::config::Config;
use crate::ApiError;
use axum::http::{HeaderMap, HeaderValue};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::net::IpAddr;

pub fn private_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

pub fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

pub fn assert_request(config: &Config, headers: &HeaderMap) -> Result<bool, ApiError> {
    let host = header(headers, "host").ok_or_else(|| {
        ApiError::new(
            403,
            "INVALID_HOST",
            "Request Host must be local, private, or explicitly trusted",
        )
    })?;
    if host != host.trim() {
        return Err(ApiError::new(
            403,
            "INVALID_HOST",
            "Request Host is invalid",
        ));
    }
    let url = url::Url::parse(&format!("https://{host}"))
        .map_err(|_| ApiError::new(403, "INVALID_HOST", "Request Host is invalid"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::new(
            403,
            "INVALID_HOST",
            "Request Host is invalid",
        ));
    }
    let trusted_network = url.host_str().is_some_and(private_host);
    let configured_host = !trusted_network
        && config
            .trusted_origins
            .contains(&url.origin().ascii_serialization());
    if !trusted_network && !configured_host {
        return Err(ApiError::new(
            403,
            "INVALID_HOST",
            "Request Host must be local, private, or explicitly trusted",
        ));
    }
    let origin = header(headers, "origin");
    let configured_origin = origin.is_some_and(|v| config.trusted_origins.contains(v));
    if let Some(origin) = origin {
        if !configured_origin
            && origin != "app://-"
            && !(origin == "null" && !config.instance_token.is_empty())
        {
            let valid = url::Url::parse(origin)
                .ok()
                .and_then(|url| url.host_str().map(private_host))
                .unwrap_or(false);
            if !valid {
                return Err(ApiError::new(
                    403,
                    "INVALID_ORIGIN",
                    "Request Origin must be local or private",
                ));
            }
        }
    }
    Ok(configured_host || configured_origin)
}

pub fn proof(config: &Config, headers: &HeaderMap) -> Result<String, ApiError> {
    let challenge = header(headers, "x-codex-panel-challenge")
        .or_else(|| header(headers, "x-codex-taskboard-challenge"))
        .unwrap_or_default();
    if !(32..=128).contains(&challenge.len()) || !challenge.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::new(
            401,
            "INVALID_INSTANCE_CHALLENGE",
            "Launcher challenge is required",
        ));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(config.instance_secret.as_bytes())
        .expect("HMAC accepts keys of any length");
    mac.update(challenge.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn response_headers(config: &Config, request: &HeaderMap) -> Result<HeaderMap, ApiError> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    let origin = header(request, "origin");
    if origin == Some("app://-") || (origin == Some("null") && !config.instance_token.is_empty()) {
        headers.insert(
            "access-control-allow-origin",
            HeaderValue::from_str(origin.unwrap()).unwrap(),
        );
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
        );
        headers.insert(
            "access-control-allow-headers",
            request
                .get("access-control-request-headers")
                .cloned()
                .unwrap_or_else(|| HeaderValue::from_static("content-type")),
        );
        headers.insert(
            "access-control-expose-headers",
            HeaderValue::from_static("x-codex-panel-proof"),
        );
        headers.insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
        headers.insert("vary", HeaderValue::from_static("origin"));
    }
    if !config.instance_token.is_empty() && origin == Some("app://-") {
        headers.insert(
            "x-codex-panel-proof",
            HeaderValue::from_str(&proof(config, request)?).unwrap(),
        );
    }
    Ok(headers)
}
