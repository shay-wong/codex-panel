use crate::ApiError;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowsProcess {
    pub pid: u32,
    pub parent_pid: u32,
    pub executable: PathBuf,
    pub command: String,
}

fn failed(message: impl Into<String>) -> ApiError {
    ApiError::new(502, "WINDOWS_CODEX", message)
}

fn powershell(script: &str, environment: &[(&str, String)]) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    for (key, _) in std::env::vars() {
        if key.starts_with("CODEX_PANEL_") || key.starts_with("CODEX_TASKBOARD_") {
            command.env_remove(key);
        }
    }
    // 路径通过环境变量传入固定脚本，避免引号或特殊字符变成 PowerShell 命令。
    command.envs(environment.iter().map(|(key, value)| (*key, value)));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn limited_output(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, ApiError> {
    let mut bytes = Vec::new();
    reader
        .take(OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(failed("Windows PowerShell output exceeded 4 MiB"));
    }
    Ok(bytes)
}

async fn run(script: &str, environment: &[(&str, String)]) -> Result<String, ApiError> {
    let mut child = powershell(script, environment).spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::try_join!(limited_output(stdout), limited_output(stderr), async {
        child.wait().await.map_err(ApiError::from)
    });
    let (stdout, stderr, status) = match result {
        Ok(result) => result,
        Err(error) => {
            let _ = child.kill().await;
            return Err(error);
        }
    };
    if !status.success() {
        let message = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(failed(if message.is_empty() {
            "Windows PowerShell command failed".into()
        } else {
            message
        }));
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_owned())
}

fn number(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|n| n.try_into().ok())
        .or_else(|| value.as_str()?.parse().ok())
}
fn processes(output: &str, app: &Path) -> Result<Vec<WindowsProcess>, ApiError> {
    if output.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(output)?;
    let rows = if let Some(rows) = value.as_array() {
        rows.clone()
    } else if value.is_null() {
        return Ok(Vec::new());
    } else {
        vec![value]
    };
    rows.iter()
        .map(|row| {
            let pid = number(&row["ProcessId"])
                .filter(|n| *n > 0)
                .ok_or_else(|| {
                    failed("Windows Codex process list returned an invalid process ID")
                })?;
            let executable = row["ExecutablePath"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| app.to_owned());
            let command = row["CommandLine"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| executable.to_string_lossy().into_owned());
            Ok(WindowsProcess {
                pid,
                parent_pid: number(&row["ParentProcessId"]).unwrap_or(0),
                executable,
                command,
            })
        })
        .collect()
}

pub async fn windows_codex_processes(app: &Path) -> Result<Vec<WindowsProcess>, ApiError> {
    let output = run(
        INSPECT_PROCESSES,
        &[(
            "CODEX_PANEL_CODEX_APP_PATH",
            app.to_string_lossy().into_owned(),
        )],
    )
    .await?;
    processes(&output, app)
}

pub async fn activate_windows_codex(
    app: &Path,
    profile: &Path,
    port: u16,
) -> Result<u32, ApiError> {
    let output = run(
        ACTIVATE_PACKAGED_APP,
        &[
            (
                "CODEX_PANEL_CODEX_APP_PATH",
                app.to_string_lossy().into_owned(),
            ),
            (
                "CODEX_PANEL_CODEX_PROFILE",
                profile.to_string_lossy().into_owned(),
            ),
            ("CODEX_PANEL_CODEX_PORT", port.to_string()),
        ],
    )
    .await?;
    output
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| {
            failed(format!(
                "Packaged Codex activation returned an invalid process ID: {output}"
            ))
        })
}

pub async fn activate_windows_window(pid: u32) -> Result<Value, ApiError> {
    if pid == 0 {
        return Err(failed(
            "Windows Codex window activation requires a positive process ID",
        ));
    }
    let output = run(
        ACTIVATE_WINDOW,
        &[("CODEX_PANEL_CODEX_APP_PID", pid.to_string())],
    )
    .await?;
    window_result(pid, &output)
}
fn window_result(pid: u32, output: &str) -> Result<Value, ApiError> {
    let result: Value = serde_json::from_str(output)?;
    if result["handle"].as_i64() == Some(0) {
        return Err(failed(format!(
            "Codex process {pid} has no main window to activate"
        )));
    }
    if result["foreground"] != true {
        return Err(failed(format!(
            "Windows refused to foreground the Codex window (pid {pid})"
        )));
    }
    Ok(result)
}

pub fn profile_argument(command: &str, profile: &Path) -> bool {
    let raw = profile.to_string_lossy().replace('/', "\\");
    let absolute = if cfg!(windows) {
        std::path::absolute(profile)
            .unwrap_or_else(|_| profile.to_owned())
            .to_string_lossy()
            .replace('/', "\\")
    } else if raw.starts_with('\\') || raw.as_bytes().get(1) == Some(&b':') {
        raw
    } else {
        format!(
            "{}\\{raw}",
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .replace('/', "\\")
        )
    };
    // 离线检查也按 Windows 分隔符规范化，不把构建机器的 POSIX 路径规则带入判断。
    let root_components = if absolute.starts_with("\\\\") {
        4
    } else if absolute.starts_with('\\') || absolute.as_bytes().get(1) == Some(&b':') {
        1
    } else {
        0
    };
    let mut components = Vec::new();
    for component in absolute.split('\\') {
        match component {
            "." => {}
            ".." => {
                if components.len() > root_components {
                    components.pop();
                }
            }
            _ => components.push(component),
        }
    }
    let resolved = components.join("\\").to_lowercase();
    let command = command.to_lowercase();
    command.contains("--user-data-dir") && command.contains(&resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn process_json_keeps_exact_executable_and_parent_identity() {
        let app = Path::new(r"C:\Program Files\Codex\Codex.exe");
        assert!(processes("", app).unwrap().is_empty());
        let one = processes(
            &json!({"ProcessId":42,"ParentProcessId":10,"ExecutablePath":app,"CommandLine":null})
                .to_string(),
            app,
        )
        .unwrap();
        assert_eq!(one[0].pid, 42);
        assert_eq!(one[0].parent_pid, 10);
        assert_eq!(one[0].executable, app);
        assert_eq!(one[0].command, app.to_string_lossy());
        let many=processes(&json!([{"ProcessId":43,"ParentProcessId":0,"ExecutablePath":app,"CommandLine":"Codex.exe --user-data-dir=C:\\Panel"},{"ProcessId":44,"ParentProcessId":43,"ExecutablePath":app,"CommandLine":"child"}]).to_string(),app).unwrap();
        assert_eq!(many.len(), 2);
        assert!(INSPECT_PROCESSES.contains("$_.ExecutablePath -eq $app"));
    }

    #[test]
    fn powershell_receives_paths_as_environment_values() {
        let path = r#"C:\Apps\a'b\Codex.exe"#;
        let command = powershell(
            INSPECT_PROCESSES,
            &[("CODEX_PANEL_CODEX_APP_PATH", path.into())],
        );
        let command = command.as_std();
        assert_eq!(command.get_program(), "powershell.exe");
        let args = command.get_args().collect::<Vec<_>>();
        assert_eq!(args[0], "-NoProfile");
        assert_eq!(args[1], "-NonInteractive");
        assert_eq!(args[2], "-Command");
        assert_eq!(args[3], INSPECT_PROCESSES);
        assert!(!INSPECT_PROCESSES.contains(path));
        assert!(command
            .get_envs()
            .any(|(key, value)| key == "CODEX_PANEL_CODEX_APP_PATH"
                && value == Some(std::ffi::OsStr::new(path))));
        assert!(ACTIVATE_PACKAGED_APP.contains("IApplicationActivationManager"));
        assert!(ACTIVATE_PACKAGED_APP.contains("--remote-debugging-address=127.0.0.1"));
        assert!(ACTIVATE_WINDOW.contains("Get-Process -Id $processId"));
        assert!(!ACTIVATE_WINDOW.contains("ActivateApplication"));
    }

    #[test]
    fn window_result_and_profile_matching_do_not_select_another_instance() {
        assert!(window_result(42, r#"{"handle":0,"foreground":false}"#).is_err());
        assert!(window_result(42, r#"{"handle":100,"foreground":false}"#).is_err());
        assert_eq!(
            window_result(42, r#"{"handle":100,"foreground":true,"minimized":false}"#).unwrap()
                ["handle"],
            100
        );
        assert!(profile_argument(
            r#"Codex.exe --user-data-dir="C:\Users\Name\Panel""#,
            Path::new(r"c:\users\name\Panel")
        ));
        assert!(profile_argument(
            r#"Codex.exe --user-data-dir="C:\Users\Name\Panel""#,
            Path::new(r"C:\Users\Name\other\..\Panel")
        ));
        assert!(!profile_argument(
            r#"Codex.exe --user-data-dir="C:\Users\Name\Personal""#,
            Path::new(r"C:\Users\Name\Panel")
        ));
        assert!(!profile_argument(
            r#"Codex.exe C:\Users\Name\Panel"#,
            Path::new(r"C:\Users\Name\Panel")
        ));
    }
}

const INSPECT_PROCESSES: &str = r###"
$ErrorActionPreference = 'Stop'
$app = $env:CODEX_PANEL_CODEX_APP_PATH
$name = [IO.Path]::GetFileName($app)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" |
  Where-Object { $_.ExecutablePath -eq $app } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
[Console]::Out.Write(($processes | ConvertTo-Json -Compress))
"###;
const ACTIVATE_PACKAGED_APP: &str = r###"
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class PackagedAppActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try
        {
            uint processId;
            var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally
        {
            Marshal.FinalReleaseComObject(manager);
        }
    }
}
'@
Add-Type -TypeDefinition $source

$app = $env:CODEX_PANEL_CODEX_APP_PATH
$profile = $env:CODEX_PANEL_CODEX_PROFILE
$port = $env:CODEX_PANEL_CODEX_PORT
$package = Get-AppxPackage | Where-Object {
  $app.StartsWith(($_.InstallLocation + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { throw "Unable to find the Codex package for $app" }

$relativeExecutable = $app.Substring($package.InstallLocation.Length).TrimStart('\', '/').Replace('\', '/')
$manifest = $package | Get-AppxPackageManifest
$application = @($manifest.Package.Applications.Application) | Where-Object {
  ([string]$_.Executable).Replace('\', '/') -eq $relativeExecutable
} | Select-Object -First 1
if ($null -eq $application) { throw "Unable to find the Codex application manifest entry" }

$appUserModelId = $package.PackageFamilyName + '!' + $application.Id
$escapedProfile = $profile.Replace('"', '\"')
$arguments = '--user-data-dir="' + $escapedProfile + '"' +
  ' --remote-debugging-address=127.0.0.1' +
  ' --remote-debugging-port=' + $port +
  ' --remote-allow-origins=http://127.0.0.1:' + $port +
  ' --disable-features=LocalNetworkAccessForSubframeNavigations'
$processId = [PackagedAppActivator]::Activate($appUserModelId, $arguments)
[Console]::Out.Write($processId)
"###;
const ACTIVATE_WINDOW: &str = r###"
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class CodexWindowActivator
{
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
Add-Type -TypeDefinition $source

$processId = [int]$env:CODEX_PANEL_CODEX_APP_PID
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$handle = if ($process) { $process.MainWindowHandle } else { [IntPtr]::Zero }

if ($handle -eq [IntPtr]::Zero) {
  [Console]::Out.Write((ConvertTo-Json -Compress @{
    handle = 0
    minimized = $false
    foreground = $false
    reason = 'no-main-window'
  }))
  exit 0
}

# Only restore when minimized: an unconditional SW_RESTORE would unmaximize a
# maximized window. ShowWindow reports the previous visibility, not success.
if ([CodexWindowActivator]::IsIconic($handle)) {
  [void][CodexWindowActivator]::ShowWindow($handle, 9)
}
$foreground = [CodexWindowActivator]::SetForegroundWindow($handle)
$reason = 'foreground-denied'
if ($foreground) { $reason = '' }

[Console]::Out.Write((ConvertTo-Json -Compress @{
  handle = $handle.ToInt64()
  minimized = [CodexWindowActivator]::IsIconic($handle)
  foreground = $foreground
  reason = $reason
}))
"###;
