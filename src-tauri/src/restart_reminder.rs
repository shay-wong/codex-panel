use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) struct CodexProcess {
    pub identity: String,
    pub started_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reminder {
    label: String,
    saved_at: u64,
    codex_process_identity: Option<String>,
}

pub(super) fn mark(
    data_directory: &Path,
    label: &str,
    process: Option<CodexProcess>,
) -> Result<(), String> {
    let reminder = Reminder {
        label: label.into(),
        saved_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as u64,
        codex_process_identity: process.map(|process| process.identity),
    };
    fs::create_dir_all(data_directory).map_err(|error| error.to_string())?;
    let path = data_directory.join("restart-required.json");
    let temporary = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(&reminder).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub(super) fn pending(
    data_directory: &Path,
    process: impl FnOnce() -> Option<CodexProcess>,
) -> Result<Option<String>, String> {
    let path = data_directory.join("restart-required.json");
    let reminder: Reminder = match read(data_directory)? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string())?,
        None => return Ok(None),
    };
    if process().is_some_and(|current| {
        current.started_at > reminder.saved_at
            && Some(current.identity.as_str()) != reminder.codex_process_identity.as_deref()
    }) {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        return Ok(None);
    }
    Ok(Some(reminder.label))
}

pub(super) fn read(data_directory: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(data_directory.join("restart-required.json")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn clear_if_unchanged(data_directory: &Path, expected: &[u8]) -> Result<(), String> {
    if read(data_directory)?.as_deref() == Some(expected) {
        fs::remove_file(data_directory.join("restart-required.json"))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_relaunch_and_unknown_process_keep_pending_until_new_codex_starts() {
        let root = std::env::temp_dir().join(format!(
            "panel-reminder-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let process = || {
            Some(CodexProcess {
                identity: "original".into(),
                started_at: 1,
            })
        };
        mark(&root, "模型上下文", process()).unwrap();
        assert_eq!(
            pending(&root, process).unwrap().as_deref(),
            Some("模型上下文")
        );
        assert_eq!(
            pending(&root, || Some(CodexProcess {
                identity: "original".into(),
                started_at: u64::MAX
            }))
            .unwrap()
            .as_deref(),
            Some("模型上下文")
        );
        assert_eq!(
            pending(&root, || None).unwrap().as_deref(),
            Some("模型上下文")
        );
        assert_eq!(
            pending(&root, || Some(CodexProcess {
                identity: "other-old".into(),
                started_at: 1
            }))
            .unwrap()
            .as_deref(),
            Some("模型上下文")
        );
        assert_eq!(
            pending(&root, || Some(CodexProcess {
                identity: "restarted".into(),
                started_at: u64::MAX
            }))
            .unwrap(),
            None
        );
        assert!(!root.join("restart-required.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmed_restart_clears_only_the_reminder_it_started_with() {
        let root = std::env::temp_dir().join(format!(
            "panel-restart-ack-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        mark(&root, "模型上下文", None).unwrap();
        let original = read(&root).unwrap().unwrap();
        assert_eq!(pending(&root, || None).unwrap().as_deref(), Some("模型上下文"));
        clear_if_unchanged(&root, &original).unwrap();
        assert_eq!(pending(&root, || None).unwrap(), None);
        clear_if_unchanged(&root, &original).unwrap();

        mark(&root, "Ultrafast", None).unwrap();
        clear_if_unchanged(&root, &original).unwrap();
        assert_eq!(pending(&root, || None).unwrap().as_deref(), Some("Ultrafast"));
        fs::remove_dir_all(root).unwrap();
    }
}
