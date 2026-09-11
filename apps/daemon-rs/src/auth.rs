use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use subtle::ConstantTimeEq;

use crate::error::{Error, Result};

#[derive(Clone)]
pub struct Token(String);

impl Token {
    pub fn load(directory: &Path) -> Result<Self> {
        let path = directory.join("local.token");
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&path) {
            Ok(mut file) => {
                let metadata = file.metadata()?;
                if !metadata.is_file() || metadata.len() != 64 {
                    return Err(Error::Invalid("invalid local token file".into()));
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.nlink() != 1 || metadata.mode() & 0o077 != 0 {
                        return Err(Error::Invalid("local token is not private".into()));
                    }
                }
                let mut token = String::new();
                file.read_to_string(&mut token)?;
                Self::parse(token)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let token = format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                );
                let mut options = OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
                }
                let mut file = options.open(path)?;
                file.write_all(token.as_bytes())?;
                file.sync_all()?;
                Ok(Self(token))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn parse(value: String) -> Result<Self> {
        if value.len() != 64 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(Error::Invalid("invalid local token".into()));
        }
        Ok(Self(value))
    }

    pub fn accepts(&self, value: &str) -> bool {
        value
            .strip_prefix("Bearer ")
            .is_some_and(|supplied| bool::from(self.0.as_bytes().ct_eq(supplied.as_bytes())))
    }

    pub fn publish(&self, directory: &Path, base_url: &str) -> Result<()> {
        let destination = directory.join("connection.json");
        let temporary = directory.join(format!(".connection-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<()> {
            let mut file = options.open(&temporary)?;
            serde_json::to_writer(
                &mut file,
                &serde_json::json!({ "apiVersion": crate::protocol::API_VERSION, "pid": std::process::id(), "baseUrl": base_url, "token": self.0 }),
            )?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, destination)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
