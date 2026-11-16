use serde::Deserialize;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const TOKEN_ENV: &str = "CODEX_PANEL_SHARED_CLI_TOKEN";

#[derive(Deserialize)]
struct Descriptor {
    version: u32,
    executable: PathBuf,
    port: u16,
    token: String,
}

fn read_descriptor(path: &Path) -> Result<Descriptor, String> {
    let bytes = fs::read(path)
        .map_err(|_| "共享会话尚未就绪，请开启共享会话并连接 Codex 后重试。".to_string())?;
    let descriptor: Descriptor = serde_json::from_slice(&bytes)
        .map_err(|_| "共享会话连接信息无效，请重新连接 Codex。".to_string())?;
    if descriptor.version != 1
        || !descriptor.executable.is_absolute()
        || descriptor.port == 0
        || descriptor.token.len() != 64
        || !descriptor
            .token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("共享会话连接信息无效，请重新连接 Codex。".into());
    }
    Ok(descriptor)
}

fn cli_arguments(arguments: &[OsString], port: u16) -> Result<Vec<OsString>, String> {
    // 连接地址必须来自本机描述文件，避免把共享凭据发往用户覆盖的远程地址。
    if arguments.iter().any(|argument| {
        let argument = argument.to_string_lossy();
        argument == "--"
            || argument == "--remote"
            || argument.starts_with("--remote=")
            || argument == "--remote-auth-token-env"
            || argument.starts_with("--remote-auth-token-env=")
    }) {
        return Err("共享 CLI 已固定连接当前 Codex，请不要另传远程连接参数或 --。".into());
    }
    let mut result = if arguments.is_empty() {
        vec!["resume".into()]
    } else {
        arguments.to_vec()
    };
    result.extend([
        "--remote".into(),
        format!("ws://127.0.0.1:{port}").into(),
        "--remote-auth-token-env".into(),
        TOKEN_ENV.into(),
    ]);
    Ok(result)
}

fn quote(value: &str, windows: bool) -> String {
    if windows {
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }
}

fn shell_command(executable: &Path, descriptor: &Path, windows: bool) -> String {
    if windows {
        // PowerShell 不等待 GUI 程序，显式等待才能避免提示符抢占 CLI 的输入。
        let arguments = format!("--shared-cli \"{}\"", descriptor.to_string_lossy());
        format!(
            "Start-Process -FilePath {} -ArgumentList {} -NoNewWindow -Wait",
            quote(&executable.to_string_lossy(), true),
            quote(&arguments, true),
        )
    } else {
        format!(
            "{} --shared-cli {}",
            quote(&executable.to_string_lossy(), false),
            quote(&descriptor.to_string_lossy(), false),
        )
    }
}

pub(super) fn command(executable: &Path, descriptor: &Path) -> Result<String, String> {
    read_descriptor(descriptor)?;
    Ok(shell_command(executable, descriptor, cfg!(windows)))
}

#[cfg(windows)]
fn attach_parent_console() -> Result<Vec<fs::File>, String> {
    use std::{ffi::c_void, os::windows::io::AsRawHandle};

    #[link(name = "kernel32")]
    extern "system" {
        fn AttachConsole(process_id: u32) -> i32;
        fn GetStdHandle(handle: u32) -> *mut c_void;
        fn GetFileType(handle: *mut c_void) -> u32;
        fn SetStdHandle(handle: u32, value: *mut c_void) -> i32;
    }
    // 启动器是 GUI 程序；交互 CLI 复用调用它的终端，不能再弹出新黑框。
    if unsafe { AttachConsole(u32::MAX) } == 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(5) {
            return Err("无法连接终端，请在 PowerShell 或命令提示符中运行共享 CLI 命令。".into());
        }
    }
    let mut console_files = Vec::new();
    for (identifier, input) in [(-10i32, true), (-11, false), (-12, false)] {
        let handle = unsafe { GetStdHandle(identifier as u32) };
        if !handle.is_null() && handle as isize != -1 && unsafe { GetFileType(handle) } != 0 {
            continue;
        }
        // 保留已有管道或重定向，只补齐 GUI 启动时缺失的控制台句柄。
        let file = fs::OpenOptions::new()
            .read(input)
            .write(!input)
            .open(if input { "CONIN$" } else { "CONOUT$" })
            .map_err(|error| format!("无法打开终端输入输出：{error}"))?;
        if unsafe { SetStdHandle(identifier as u32, file.as_raw_handle()) } == 0 {
            return Err(format!(
                "无法设置终端输入输出：{}",
                std::io::Error::last_os_error()
            ));
        }
        console_files.push(file);
    }
    Ok(console_files)
}

fn run(arguments: &[OsString]) -> Result<i32, String> {
    let path = arguments.first().ok_or("共享 CLI 缺少连接信息路径。")?;
    let descriptor = read_descriptor(Path::new(path))?;
    let arguments = cli_arguments(&arguments[1..], descriptor.port)?;
    let status = Command::new(&descriptor.executable)
        .args(arguments)
        // 凭据只传给 CLI 子进程，不写进复制命令或命令行参数。
        .env(TOKEN_ENV, descriptor.token)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("无法启动共享 CLI：{error}"))?;
    Ok(status.code().unwrap_or(1))
}

pub(super) fn run_if_requested() -> Option<i32> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new("--shared-cli")) {
        return None;
    }
    let arguments: Vec<_> = arguments.collect();
    #[cfg(windows)]
    let _console_files = match attach_parent_console() {
        Ok(files) => files,
        Err(error) => {
            eprintln!("{error}");
            return Some(1);
        }
    };
    Some(match run(&arguments) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_cli_keeps_session_arguments_and_fixes_local_endpoint() {
        let arguments = cli_arguments(&["resume".into(), "thread-id".into()], 12345).unwrap();
        let expected: Vec<OsString> = [
            "resume",
            "thread-id",
            "--remote",
            "ws://127.0.0.1:12345",
            "--remote-auth-token-env",
            TOKEN_ENV,
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        assert_eq!(arguments, expected);
        assert_eq!(cli_arguments(&[], 12345).unwrap()[0], "resume");
        for arguments in [
            vec!["--remote", "wss://other"],
            vec!["--remote=wss://other"],
            vec!["--remote-auth-token-env=OTHER"],
            vec!["--", "--remote=wss://other"],
        ] {
            assert!(cli_arguments(
                &arguments
                    .into_iter()
                    .map(OsString::from)
                    .collect::<Vec<_>>(),
                12345
            )
            .is_err());
        }
    }

    #[test]
    fn command_quotes_paths_without_exposing_the_token() {
        assert_eq!(quote("/a b/o'k", false), "'/a b/o'\"'\"'k'");
        assert_eq!(quote("C:\\a b\\o'k", true), "'C:\\a b\\o''k'");
        assert_eq!(shell_command(Path::new("C:\\Panel.exe"), Path::new("C:\\a b\\state.json"), true),
            "Start-Process -FilePath 'C:\\Panel.exe' -ArgumentList '--shared-cli \"C:\\a b\\state.json\"' -NoNewWindow -Wait");
    }

    #[test]
    fn descriptor_rejects_nonlocal_executables_and_invalid_credentials() {
        let root = std::env::temp_dir().join(format!("panel-shared-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("shared-session.json");
        let executable = std::env::current_exe().unwrap();
        let mut value = serde_json::json!({ "version": 1, "executable": executable, "port": 12345, "token": "a".repeat(64) });
        fs::write(&path, value.to_string()).unwrap();
        assert!(read_descriptor(&path).is_ok());
        let copied = command(&executable, &path).unwrap();
        assert!(copied.contains("--shared-cli"));
        assert!(!copied.contains(&"a".repeat(64)));
        for (key, invalid) in [
            ("version", serde_json::json!(2)),
            ("executable", serde_json::json!("relative/codex")),
            ("port", serde_json::json!(0)),
            ("token", serde_json::json!("invalid")),
        ] {
            let previous = value[key].clone();
            value[key] = invalid;
            fs::write(&path, value.to_string()).unwrap();
            assert!(read_descriptor(&path).is_err());
            value[key] = previous;
        }
        fs::remove_dir_all(root).unwrap();
    }
}
