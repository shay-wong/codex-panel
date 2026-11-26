use crate::ApiError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

pub(super) struct Cache {
    directory: PathBuf,
    archive: String,
    catalog: String,
}

impl Cache {
    pub(super) fn new(directory: &Path, archive: &str, catalog: &str) -> Self {
        Self {
            directory: directory.to_owned(),
            archive: archive.into(),
            catalog: catalog.into(),
        }
    }

    fn key(&self, kind: &str, revision: &str) -> String {
        hex::encode(Sha256::digest(
            json!(["rust-rspack-v2", self.archive, self.catalog, kind, revision])
                .to_string()
                .as_bytes(),
        ))
    }

    fn read(&self, kind: &str, revision: &str) -> Option<Value> {
        let key = self.key(kind, revision);
        let path = self.directory.join(format!("rust-v2-{kind}-{key}.json"));
        let metadata = std::fs::metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > 256 * 1024 * 1024 {
            return None;
        }
        let value: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
        let checksum = hex::encode(Sha256::digest(value["payload"].to_string().as_bytes()));
        (value["format"] == 2 && value["key"] == key && value["checksum"] == checksum)
            .then(|| value["payload"].clone())
    }

    fn write(&self, kind: &str, revision: &str, payload: &Value) -> Result<(), ApiError> {
        let key = self.key(kind, revision);
        let checksum = hex::encode(Sha256::digest(payload.to_string().as_bytes()));
        let value = json!({"format":2,"key":key,"payload":payload,"checksum":checksum});
        std::fs::create_dir_all(&self.directory)?;
        let destination = self.directory.join(format!("rust-v2-{kind}-{key}.json"));
        let temporary = self
            .directory
            .join(format!(".rust-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<(), ApiError> {
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&value)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, destination)?;
            Ok(())
        })();
        let _ = std::fs::remove_file(temporary);
        result
    }

    pub(super) fn main(&self) -> Option<Value> {
        self.read("main", "entry")
    }
    pub(super) fn save_main(&self, main: &Value) -> Result<(), ApiError> {
        self.write("main", "entry", main)
    }
    pub(super) fn feature(&self, feature: &str, revision: &str) -> Option<Value> {
        self.read(&format!("feature-{feature}"), revision)
    }
    pub(super) fn save_feature(
        &self,
        feature: &str,
        revision: &str,
        plan: &Value,
    ) -> Result<(), ApiError> {
        self.write(&format!("feature-{feature}"), revision, plan)
    }
    pub(super) fn combined(&self, revision: &str) -> Option<Value> {
        self.read("combined", revision)
    }
    pub(super) fn save_combined(&self, revision: &str, plan: &Value) -> Result<(), ApiError> {
        self.write("combined", revision, plan)
    }
}
