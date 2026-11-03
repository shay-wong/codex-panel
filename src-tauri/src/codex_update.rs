use std::{fs, path::Path, thread, time::{Duration, Instant}};

// Sparkle installs on normal quit. Do not reopen the old or partially replaced bundle.
pub(super) fn wait_for_installation(
    app_path: &Path,
    original_info: &[u8],
    timeout: Duration,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if fs::read(app_path.join("Contents/Info.plist"))
            .is_ok_and(|info| info != original_info)
            && verify(app_path).is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("等待 Codex 安装更新超时，未自动启动。请确认官方安装是否完成，再点击打开 Codex。".into());
        }
        thread::sleep(Duration::from_millis(200));
    }
}
