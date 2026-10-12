use rusqlite::{Connection, params};
use tempfile::TempDir;

#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};

use super::{PAGE_BYTES, TerminalEvent};
use crate::error::{Error, Result};

pub(crate) struct Replay {
    connection: Connection,
    _directory: TempDir,
}

fn unavailable() -> Error {
    Error::Feature(
        "terminal_replay_unavailable".into(),
        "Terminal replay journal is unavailable".into(),
    )
}

impl Replay {
    pub(crate) fn new() -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("prospero-terminal-replay-")
            .tempdir()
            .map_err(|_| unavailable())?;
        #[cfg(unix)]
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| unavailable())?;
        let path = directory.path().join("events.sqlite3");
        let connection = Connection::open(path).map_err(|_| unavailable())?;
        #[cfg(unix)]
        fs::set_permissions(
            directory.path().join("events.sqlite3"),
            fs::Permissions::from_mode(0o600),
        )
        .map_err(|_| unavailable())?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| unavailable())?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|_| unavailable())?;
        connection
            .pragma_update(None, "cache_size", -4096)
            .map_err(|_| unavailable())?;
        connection
            .pragma_update(None, "mmap_size", 0)
            .map_err(|_| unavailable())?;
        connection
            .execute_batch("CREATE TABLE events(seq INTEGER PRIMARY KEY, payload TEXT NOT NULL);")
            .map_err(|_| unavailable())?;
        Ok(Self {
            connection,
            _directory: directory,
        })
    }

    pub(crate) fn append(&mut self, seq: i64, event: &TerminalEvent) -> Result<()> {
        let payload = serde_json::to_string(event).map_err(|_| unavailable())?;
        self.connection
            .execute(
                "INSERT INTO events(seq,payload) VALUES(?1,?2)",
                params![seq, payload],
            )
            .map_err(|_| unavailable())?;
        Ok(())
    }

    pub(crate) fn page(&self, after: i64, latest: i64) -> Result<(i64, Vec<TerminalEvent>)> {
        if after < 0 || after >= latest {
            if after == latest {
                return Ok((0, Vec::new()));
            }
            return Err(unavailable());
        }
        let floor = self
            .connection
            .query_row("SELECT MIN(seq) FROM events", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .map_err(|_| unavailable())?
            .map(|seq| seq - 1)
            .unwrap_or(0);
        if floor != 0 {
            return Err(unavailable());
        }
        let mut statement = self
            .connection
            .prepare("SELECT seq,payload FROM events WHERE seq>?1 ORDER BY seq LIMIT 64")
            .map_err(|_| unavailable())?;
        let mut rows = statement.query([after]).map_err(|_| unavailable())?;
        let mut expected = after + 1;
        let mut bytes = 0;
        let mut events = Vec::new();
        while let Some(row) = rows.next().map_err(|_| unavailable())? {
            let seq: i64 = row.get(0).map_err(|_| unavailable())?;
            let payload: String = row.get(1).map_err(|_| unavailable())?;
            if seq != expected || seq > latest {
                return Err(unavailable());
            }
            if !events.is_empty() && bytes + payload.len() > PAGE_BYTES {
                break;
            }
            bytes += payload.len();
            events.push(serde_json::from_str(&payload).map_err(|_| unavailable())?);
            expected += 1;
        }
        if events.is_empty() {
            return Err(unavailable());
        }
        Ok((floor, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_reports_write_failure() {
        let mut replay = Replay::new().unwrap();
        replay
            .connection
            .execute_batch("DROP TABLE events")
            .unwrap();
        let event = TerminalEvent::Output {
            data_b64: "eA==".into(),
        };
        assert!(replay.append(1, &event).is_err());
    }

    #[test]
    fn journal_rejects_missing_and_unexpected_sequence_ranges() {
        let event = TerminalEvent::Output {
            data_b64: "eA==".into(),
        };
        let mut replay = Replay::new().unwrap();
        replay.append(1, &event).unwrap();
        assert!(replay.page(1, 2).is_err());
        replay.append(3, &event).unwrap();
        assert!(replay.page(0, 3).is_err());
        replay.append(2, &event).unwrap();
        assert!(replay.page(0, 2).is_err());
        replay
            .connection
            .execute("DELETE FROM events WHERE seq=1", [])
            .unwrap();
        assert!(replay.page(1, 3).is_err());
    }

    #[test]
    fn journal_cleans_database_and_sidecars_after_connection_closes() {
        let mut replay = Replay::new().unwrap();
        let directory = replay._directory.path().to_owned();
        replay
            .append(
                1,
                &TerminalEvent::Output {
                    data_b64: "eA==".into(),
                },
            )
            .unwrap();
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o077,
                0
            );
            for file in fs::read_dir(&directory).unwrap() {
                assert_eq!(
                    file.unwrap().metadata().unwrap().permissions().mode() & 0o077,
                    0
                );
            }
        }
        drop(replay);
        assert!(!directory.exists());
    }
}
