use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagedMetadata {
    version: u32,
    available_version: String,
    available_build_version: String,
}

#[derive(Clone, Debug, PartialEq)]
struct BundleVersion {
    version: String,
    build: String,
}

pub(super) struct StagedUpdate {
    source: PathBuf,
    work_directory: PathBuf,
    expected_version: BundleVersion,
}

impl Drop for StagedUpdate {
    fn drop(&mut self) {
        // A failed rollback leaves the previous App here for recovery.
        if !self.work_directory.join("previous.app").exists() {
            let _ = fs::remove_dir_all(&self.work_directory);
        }
    }
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err(format!(
            "拒绝 Codex 更新路径中的符号链接：{}",
            path.display()
        ));
    }
    Ok(())
}

fn bundle_version(app: &Path) -> Result<BundleVersion, String> {
    let plist = app.join("Contents/Info.plist");
    reject_symlink(&app.join("Contents"))?;
    reject_symlink(&plist)?;
    let read = |key: &str| -> Result<String, String> {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(&plist)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!("无法读取 Codex 更新版本：{key}"));
        }
        let value = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        let value = value.trim();
        if value.is_empty() {
            return Err(format!("Codex 更新缺少版本：{key}"));
        }
        Ok(value.into())
    };
    Ok(BundleVersion {
        version: read("CFBundleShortVersionString")?,
        build: read("CFBundleVersion")?,
    })
}

fn build_number(value: &str) -> Result<Vec<u64>, String> {
    value
        .split('.')
        .map(|part| {
            part.parse::<u64>()
                .map_err(|_| "Codex 更新构建号无效".into())
        })
        .collect()
}

fn verify_staged_app(
    app: &Path,
    expected: &BundleVersion,
    verify: &impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    reject_symlink(app)?;
    verify(app)?;
    if bundle_version(app)? != *expected {
        return Err("Codex 更新版本与下载记录不一致，请重新下载".into());
    }
    Ok(())
}

// Validate before asking the running App to quit, including write access to its parent.
pub(super) fn prepare_staged_installation(
    data_directory: &Path,
    app: &Path,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<Option<StagedUpdate>, String> {
    let update_root = data_directory.join("codex-update");
    let staged = update_root.join("staged");
    match fs::symlink_metadata(&staged) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let source = staged.join("ChatGPT.app");
    let metadata_path = staged.join("metadata.json");
    for path in [
        data_directory,
        &update_root,
        &staged,
        &source,
        &metadata_path,
        app,
    ] {
        reject_symlink(path)?;
    }
    let metadata: StagedMetadata =
        serde_json::from_slice(&fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Codex 更新下载记录无效：{error}"))?;
    if metadata.version != 1 {
        return Err("Codex 更新下载记录版本不受支持，请重新下载".into());
    }
    let expected_version = BundleVersion {
        version: metadata.available_version,
        build: metadata.available_build_version,
    };
    verify_staged_app(&source, &expected_version, &verify)?;
    if build_number(&expected_version.build)? <= build_number(&bundle_version(app)?.build)? {
        return Err("暂存的 Codex 更新不高于当前版本，请重新检查更新".into());
    }
    let parent = app.parent().ok_or("无法定位 Codex 安装目录")?;
    reject_symlink(parent)?;
    let work_directory = parent.join(format!(".codex-panel-update-{}", Uuid::new_v4()));
    fs::create_dir(&work_directory).map_err(|error| {
        format!(
            "无法写入 Codex 安装目录 {}，尚未退出 Codex：{error}",
            parent.display()
        )
    })?;
    Ok(Some(StagedUpdate {
        source,
        work_directory,
        expected_version,
    }))
}

fn replace_verified_app(
    app: &Path,
    work_directory: &Path,
    copy: impl FnOnce(&Path) -> Result<(), String>,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let incoming = work_directory.join("incoming.app");
    let previous = work_directory.join("previous.app");
    copy(&incoming)?;
    verify(&incoming)?;
    fs::rename(app, &previous).map_err(|error| format!("无法保留现有 Codex：{error}"))?;
    let promotion = fs::rename(&incoming, app)
        .map_err(|error| format!("无法替换 Codex 更新：{error}"))
        .and_then(|_| verify(app));
    if let Err(error) = promotion {
        let rollback = (|| {
            if fs::symlink_metadata(app).is_ok() {
                fs::rename(app, &incoming).map_err(|error| error.to_string())?;
            }
            fs::rename(&previous, app).map_err(|error| error.to_string())
        })();
        return match rollback {
            Ok(()) => Err(format!("{error}；已恢复原 Codex，未自动启动")),
            Err(rollback_error) => Err(format!(
                "{error}；恢复失败：{rollback_error}。原 Codex 保留在 {}",
                previous.display()
            )),
        };
    }
    // The copied and installed App both passed verification before removing the old one.
    let _ = fs::remove_dir_all(&previous);
    Ok(())
}

pub(super) fn install_staged_update(
    update: &StagedUpdate,
    app: &Path,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    // Sparkle may have completed the update while Codex was exiting.
    if build_number(&bundle_version(app)?.build)? >= build_number(&update.expected_version.build)? {
        verify(app)?;
        let _ = fs::remove_dir_all(
            update
                .source
                .parent()
                .ok_or("无法定位 Codex 更新暂存目录")?,
        );
        return Ok(());
    }
    verify_staged_app(&update.source, &update.expected_version, &verify)?;
    replace_verified_app(
        app,
        &update.work_directory,
        |incoming| {
            let output = Command::new("/usr/bin/ditto")
                .arg("--noqtn")
                .arg(&update.source)
                .arg(incoming)
                .output()
                .map_err(|error| error.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "复制 Codex 更新失败：{}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(())
        },
        |candidate| verify_staged_app(candidate, &update.expected_version, &verify),
    )?;
    // Remove only this exact download after the verified installation succeeds.
    let _ = fs::remove_dir_all(
        update
            .source
            .parent()
            .ok_or("无法定位 Codex 更新暂存目录")?,
    );
    Ok(())
}

// Sparkle installs on normal quit. Do not reopen the old or partially replaced bundle.
pub(super) fn wait_for_installation(
    app_path: &Path,
    original_info: &[u8],
    timeout: Duration,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if fs::read(app_path.join("Contents/Info.plist")).is_ok_and(|info| info != original_info)
            && verify(app_path).is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(
                "等待 Codex 安装更新超时，未自动启动。请确认官方安装是否完成，再点击打开 Codex。"
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(200));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("codex-update-swap-{}", Uuid::new_v4()));
        let app = root.join("ChatGPT.app");
        let work = root.join("work");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir(&work).unwrap();
        fs::write(app.join("version"), "old").unwrap();
        (root, app, work)
    }

    fn copy_fixture(incoming: &Path) -> Result<(), String> {
        fs::create_dir(incoming).map_err(|error| error.to_string())?;
        fs::write(incoming.join("version"), "new").map_err(|error| error.to_string())
    }

    #[test]
    fn staged_installation_reads_metadata_and_installs_disposable_bundle() {
        let (root, app, _) = fixture();
        let data = root.join("data");
        let staged = data.join("codex-update/staged");
        let source = staged.join("ChatGPT.app");
        let write_plist = |bundle: &Path, build: u32| {
            fs::create_dir_all(bundle.join("Contents")).unwrap();
            fs::write(bundle.join("Contents/Info.plist"), format!(
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>26.1.1</string><key>CFBundleVersion</key><string>{build}</string></dict></plist>"
            )).unwrap();
        };
        write_plist(&app, 1);
        write_plist(&source, 2);
        fs::write(
            staged.join("metadata.json"),
            r#"{"version":1,"availableVersion":"26.1.1","availableBuildVersion":"2"}"#,
        )
        .unwrap();
        let update = prepare_staged_installation(&data, &app, |_| Ok(()))
            .unwrap()
            .unwrap();
        install_staged_update(&update, &app, |_| Ok(())).unwrap();
        assert_eq!(bundle_version(&app).unwrap().build, "2");
        assert!(!staged.exists());
        drop(update);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_installation_completed_on_quit_keeps_the_newer_app() {
        for installed_build in [2, 3] {
            let (root, app, work) = fixture();
            fs::create_dir(app.join("Contents")).unwrap();
            fs::write(app.join("Contents/Info.plist"), format!(
                "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>26.1.1</string><key>CFBundleVersion</key><string>{installed_build}</string></dict></plist>"
            )).unwrap();
            let staged = root.join("staged");
            fs::create_dir(&staged).unwrap();
            let update = StagedUpdate {
                source: staged.join("ChatGPT.app"),
                work_directory: work,
                expected_version: BundleVersion {
                    version: "26.1.1".into(),
                    build: "2".into(),
                },
            };
            install_staged_update(&update, &app, |candidate| {
                assert_eq!(candidate, app);
                assert!(staged.exists());
                Ok(())
            })
            .unwrap();
            assert_eq!(
                bundle_version(&app).unwrap().build,
                installed_build.to_string()
            );
            assert_eq!(fs::read_to_string(app.join("version")).unwrap(), "old");
            assert!(!staged.exists());
            drop(update);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn staged_app_is_verified_before_swap_and_old_app_is_removed_after_success() {
        let (root, app, work) = fixture();
        replace_verified_app(&app, &work, copy_fixture, |candidate| {
            assert_eq!(
                fs::read_to_string(candidate.join("version")).unwrap(),
                "new"
            );
            if candidate != app {
                assert_eq!(fs::read_to_string(app.join("version")).unwrap(), "old");
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(app.join("version")).unwrap(), "new");
        assert!(!work.join("previous.app").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verification_failure_preserves_or_restores_original_app() {
        for fail_after_swap in [false, true] {
            let (root, app, work) = fixture();
            let result = replace_verified_app(&app, &work, copy_fixture, |candidate| {
                if (candidate == app) == fail_after_swap {
                    Err("invalid signature".into())
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(fs::read_to_string(app.join("version")).unwrap(), "old");
            assert!(!work.join("previous.app").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }
}
