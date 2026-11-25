const SERVICE: &str = "com.shay.codex-panel.github";
const ACCOUNT: &str = "oauth";

#[cfg(target_os = "macos")]
pub(super) fn read() -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
        Ok(value) => String::from_utf8(value)
            .map(Some)
            .map_err(|_| "GitHub 登录凭据格式无效，请重新登录。".into()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("无法读取 GitHub 登录凭据，请检查系统钥匙串。".into()),
    }
}

#[cfg(target_os = "macos")]
pub(super) fn write(value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, value.as_bytes())
        .map_err(|_| "无法保存 GitHub 登录凭据，请检查系统钥匙串。".into())
}

#[cfg(target_os = "macos")]
pub(super) fn delete() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("无法删除 GitHub 登录凭据，请检查系统钥匙串。".into()),
    }
}

#[cfg(target_os = "windows")]
mod windows_store {
    use windows::{
        core::{HRESULT, PCWSTR, PWSTR},
        Win32::{
            Foundation::ERROR_NOT_FOUND,
            Security::Credentials::{
                CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW,
                CRED_MAX_CREDENTIAL_BLOB_SIZE, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
            },
        },
    };

    fn target() -> Vec<u16> {
        format!("{}/{}", super::SERVICE, super::ACCOUNT)
            .encode_utf16().chain(Some(0)).collect()
    }

    pub(crate) fn read() -> Result<Option<String>, String> {
        let target = target();
        let mut credential = std::ptr::null_mut();
        match unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut credential) } {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => return Ok(None),
            Err(_) => return Err("无法读取 GitHub 登录凭据，请检查 Windows 凭据管理器。".into()),
            Ok(()) => {}
        }
        let value = unsafe {
            let value = &*credential;
            let bytes = if value.CredentialBlobSize == 0 {
                Some(Vec::new())
            } else if value.CredentialBlob.is_null() {
                None
            } else {
                Some(std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize).to_vec())
            };
            CredFree(credential.cast());
            bytes
        }.ok_or("GitHub 登录凭据格式无效，请重新登录。")?;
        String::from_utf8(value).map(Some)
            .map_err(|_| "GitHub 登录凭据格式无效，请重新登录。".into())
    }

    pub(crate) fn write(value: &str) -> Result<(), String> {
        if value.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
            return Err("GitHub 登录凭据超出 Windows 凭据管理器的容量。".into());
        }
        let mut target = target();
        let mut account: Vec<u16> = super::ACCOUNT.encode_utf16().chain(Some(0)).collect();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            UserName: PWSTR(account.as_mut_ptr()),
            CredentialBlobSize: value.len() as u32,
            CredentialBlob: value.as_ptr().cast_mut(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&credential, 0) }
            .map_err(|_| "无法保存 GitHub 登录凭据，请检查 Windows 凭据管理器。".into())
    }

    pub(crate) fn delete() -> Result<(), String> {
        let target = target();
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            Err(error) if error.code() == HRESULT::from_win32(ERROR_NOT_FOUND.0) => Ok(()),
            Err(_) => Err("无法删除 GitHub 登录凭据，请检查 Windows 凭据管理器。".into()),
        }
    }
}

#[cfg(target_os = "windows")]
pub(super) use windows_store::{delete, read, write};

#[cfg(any(target_os = "linux", test))]
fn secret_tool(
    executable: &std::path::Path,
    arguments: &[&str],
    input: Option<&str>,
    timeout: std::time::Duration,
) -> Result<Option<Vec<u8>>, String> {
    use std::{io::{Read, Write}, process::{Command, Stdio}, thread, time::Instant};
    let mut child = Command::new(executable).args(arguments)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|error| if error.kind() == std::io::ErrorKind::NotFound {
            "缺少 secret-tool，无法访问系统凭据库；请安装 libsecret 工具。".to_string()
        } else { "无法启动系统凭据库工具。".to_string() })?;
    let stdin = child.stdin.take();
    let input = input.map(str::to_owned);
    let writer = thread::spawn(move || match (stdin, input) {
        (Some(mut stdin), Some(value)) => stdin.write_all(value.as_bytes()),
        _ => Ok(()),
    });
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let reader = thread::spawn(move || {
        let mut value = Vec::new();
        stdout.read_to_end(&mut value).map(|_| value)
    });
    let errors = thread::spawn(move || {
        let mut value = Vec::new();
        stderr.read_to_end(&mut value).map(|_| value)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(std::time::Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("系统凭据库未响应，请解锁后重试。".to_string());
            }
        }
    };
    let status = status?;
    let written = writer.join();
    let output = reader.join();
    let error_output = errors.join();
    let output = output.ok().and_then(Result::ok).ok_or("无法读取系统凭据库响应。")?;
    let error_output = error_output.ok().and_then(Result::ok).ok_or("系统凭据库响应异常。")?;
    if !status.success() {
        if status.code() == Some(1) && error_output.is_empty() && arguments[0] != "store" {
            return Ok(None);
        }
        return Err("无法访问系统凭据库，请确认 Secret Service 已启动并解锁。".into());
    }
    written.ok().and_then(Result::ok).ok_or("无法写入系统凭据库。")?;
    Ok(Some(output))
}

#[cfg(target_os = "linux")]
pub(super) fn read() -> Result<Option<String>, String> {
    let Some(mut value) = secret_tool(std::path::Path::new("secret-tool"),
        &["lookup", "service", SERVICE, "account", ACCOUNT], None, std::time::Duration::from_secs(10))? else {
        return Ok(None);
    };
    if value.last() == Some(&b'\n') { value.pop(); }
    String::from_utf8(value).map(Some)
        .map_err(|_| "GitHub 登录凭据格式无效，请重新登录。".into())
}

#[cfg(target_os = "linux")]
pub(super) fn write(value: &str) -> Result<(), String> {
    secret_tool(std::path::Path::new("secret-tool"),
        &["store", "--label=Codex Panel GitHub", "service", SERVICE, "account", ACCOUNT],
        Some(value), std::time::Duration::from_secs(10)).map(|_| ())
}

#[cfg(target_os = "linux")]
pub(super) fn delete() -> Result<(), String> {
    secret_tool(std::path::Path::new("secret-tool"),
        &["clear", "service", SERVICE, "account", ACCOUNT], None, std::time::Duration::from_secs(10)).map(|_| ())
}

#[cfg(all(test, unix))]
mod tests {
    use super::secret_tool;
    use std::{fs, os::unix::fs::PermissionsExt, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};

    #[test]
    fn secret_tool_passes_the_secret_only_on_stdin_and_times_out() {
        let root = std::env::temp_dir().join(format!("panel-credentials-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&root).unwrap();
        let executable = root.join("secret-tool");
        fs::write(&executable, "#!/bin/sh\ncase \"$1\" in\nstore) [ \"$#\" -eq 1 ] || exit 2; cat > \"$(dirname \"$0\")/data\";;\nlookup) [ -f \"$(dirname \"$0\")/data\" ] || exit 1; cat \"$(dirname \"$0\")/data\";;\nclear) rm -f \"$(dirname \"$0\")/data\";;\nwait) exec sleep 10;;\nerror) printf 'secret must not escape' >&2; exit 1;;\nesac\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let timeout = Duration::from_secs(2);
        assert_eq!(secret_tool(&executable, &["lookup"], None, timeout).unwrap(), None);
        secret_tool(&executable, &["store"], Some("{\"token\":\"private\"}"), timeout).unwrap();
        assert_eq!(secret_tool(&executable, &["lookup"], None, timeout).unwrap().unwrap(), b"{\"token\":\"private\"}");
        secret_tool(&executable, &["clear"], None, timeout).unwrap();
        assert_eq!(secret_tool(&executable, &["lookup"], None, timeout).unwrap(), None);
        let error = secret_tool(&executable, &["error"], None, timeout).unwrap_err();
        assert!(!error.contains("secret must not escape"));
        let started = Instant::now();
        assert!(secret_tool(&executable, &["wait"], None, Duration::from_millis(75)).is_err());
        assert!(started.elapsed() < timeout);
        fs::remove_dir_all(root).unwrap();
    }
}
