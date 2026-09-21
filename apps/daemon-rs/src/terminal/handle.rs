use super::*;

#[derive(Clone)]
pub(crate) enum Handle {
    Local(Terminal),
    Hosted(host::Host),
}
impl Handle {
    pub fn lost(&self) -> bool {
        matches!(self, Self::Hosted(h) if host::owner_alive(&h.directory).is_ok_and(|alive| !alive))
    }
    pub fn hosted(&self) -> bool {
        matches!(self, Self::Hosted(_))
    }
    pub async fn read(&self, q: TerminalQuery) -> Result<TerminalPage> {
        match self {
            Self::Local(t) => t.read(q).await,
            Self::Hosted(h) => {
                h.get(&format!(
                    "output?afterSeq={}&waitMs={}",
                    q.after_seq.unwrap_or(0),
                    q.wait_ms.unwrap_or(0)
                ))
                .await
            }
        }
    }
    pub async fn snapshot(&self) -> Result<Option<TerminalSnapshot>> {
        match self {
            Self::Local(t) => {
                let t = t.clone();
                tokio::task::spawn_blocking(move || t.snapshot())
                    .await
                    .map_err(|_| Error::Closed)?
            }
            Self::Hosted(h) => h.get("snapshot").await,
        }
    }
    pub async fn checkpoint(&self, after: Option<i64>) -> Result<Option<Archive>> {
        match self {
            Self::Local(t) => {
                let t = t.clone();
                tokio::task::spawn_blocking(move || t.checkpoint(after))
                    .await
                    .map_err(|_| Error::Closed)?
            }
            Self::Hosted(h) => {
                h.get(
                    &after
                        .map(|n| format!("checkpoint?after={n}"))
                        .unwrap_or_else(|| "checkpoint".into()),
                )
                .await
            }
        }
    }
    pub async fn archive(&self) -> Result<Archive> {
        self.checkpoint(None).await?.ok_or(Error::Conflict)
    }
    pub async fn activity(&self) -> Result<TerminalActivity> {
        match self {
            Self::Local(t) => t.activity(),
            Self::Hosted(h) => h.get("activity").await,
        }
    }
    pub async fn input(&self, i: TerminalInput) -> Result<()> {
        match self {
            Self::Local(t) => t.input(i).await,
            Self::Hosted(h) => h.post("input", &i).await,
        }
    }
    pub async fn resize(&self, s: TerminalSize) -> Result<()> {
        match self {
            Self::Local(t) => t.resize(s).await,
            Self::Hosted(h) => h.post("resize", &s).await,
        }
    }
    pub async fn stop(&self) -> Result<()> {
        match self {
            Self::Local(t) => {
                t.stop();
                Ok(())
            }
            Self::Hosted(h) => h.post("close", &true).await,
        }
    }
    pub async fn release(&self) -> Result<()> {
        if let Self::Hosted(h) = self {
            h.post("release", &true).await?;
        }
        Ok(())
    }
    pub async fn wait_exited(&self) {
        match self {
            Self::Local(t) => t.wait_exited().await,
            Self::Hosted(h) => while let Ok(false) = h.get::<bool>("exited").await {},
        }
    }
    pub async fn wait_output(&self, seq: i64) {
        match self {
            Self::Local(t) => t.wait_output(seq).await,
            Self::Hosted(_) => {
                let _ = self
                    .read(TerminalQuery {
                        after_seq: Some(seq),
                        wait_ms: Some(5000),
                    })
                    .await;
            }
        }
    }
    pub async fn wait_activity(&self, version: u64, timeout: Duration) {
        match self {
            Self::Local(t) => t.wait_activity(version, timeout).await,
            Self::Hosted(_) => tokio::time::sleep(timeout.min(Duration::from_secs(2))).await,
        }
    }
}
