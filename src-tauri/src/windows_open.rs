fn check_result(target: &str, code: isize) -> Result<(), String> {
    // ShellExecute 的值大于 32 才表示系统已接受请求，不是 Explorer 进程退出码。
    if code > 32 {
        Ok(())
    } else {
        Err(format!("无法打开 {target}（Windows Shell 错误码：{code}）"))
    }
}

#[cfg(target_os = "windows")]
pub fn open(target: &str) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 拒绝内嵌 NUL，避免系统只打开被截断的路径或 URL。
    if target.contains('\0') {
        return Err("无法打开包含空字符的路径或链接".into());
    }
    let wide: Vec<u16> = target.encode_utf16().chain(Some(0)).collect();
    // UTF-16 缓冲区覆盖整个调用生命周期；返回的 HINSTANCE 是状态值，无须关闭。
    let result = unsafe {
        ShellExecuteW(None, w!("open"), PCWSTR(wide.as_ptr()), None, None, SW_SHOWNORMAL)
    };
    check_result(target, result.0 as isize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_status_is_not_a_process_exit_code() {
        assert!(check_result("Codex.exe", 33).is_ok());
        for code in [0, 2, 3, 5, 31, 32] {
            let error = check_result("Codex.exe", code).unwrap_err();
            assert!(error.contains(&format!("错误码：{code}")));
        }
    }
}
