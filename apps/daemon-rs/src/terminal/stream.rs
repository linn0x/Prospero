//! Binary terminal-stream v1 framing.  This is deliberately independent of
//! axum so the daemon and the detached PTY owner cannot drift on the wire.
use crate::error::{Error, Result};

pub const VERSION: u8 = 1;
pub const HEADER: usize = 16;
pub const MAX_PAYLOAD: usize = 1024 * 1024;
pub const WINDOW_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    Snapshot = 2,
    Output = 3,
    Resize = 4,
    State = 5,
    Error = 6,
    Exit = 7,
    Ready = 8,
    Input = 16,
    Applied = 17,
    ResizeRequest = 18,
    Acquire = 19,
    Result = 20,
    Release = 21,
    Attach = 32,
}
impl TryFrom<u8> for Kind {
    type Error = Error;
    fn try_from(v: u8) -> Result<Self> {
        Ok(match v {
            1 => Self::Hello,
            2 => Self::Snapshot,
            3 => Self::Output,
            4 => Self::Resize,
            5 => Self::State,
            6 => Self::Error,
            7 => Self::Exit,
            8 => Self::Ready,
            16 => Self::Input,
            17 => Self::Applied,
            18 => Self::ResizeRequest,
            19 => Self::Acquire,
            20 => Self::Result,
            21 => Self::Release,
            32 => Self::Attach,
            _ => return Err(Error::Invalid("unknown terminal stream frame".into())),
        })
    }
}
#[derive(Debug, Clone)]
pub struct Frame {
    pub kind: Kind,
    pub sequence: u64,
    pub payload: Vec<u8>,
}
pub fn encode(frame: &Frame) -> Result<Vec<u8>> {
    validate(frame)?;
    if frame.payload.len() > MAX_PAYLOAD {
        return Err(Error::Invalid("terminal stream frame too large".into()));
    }
    let mut out = Vec::with_capacity(HEADER + frame.payload.len());
    out.extend_from_slice(&[VERSION, frame.kind as u8, 0, 0]);
    out.extend_from_slice(&frame.sequence.to_be_bytes());
    out.extend_from_slice(&(frame.payload.len() as u32).to_be_bytes());
    out.extend_from_slice(&frame.payload);
    Ok(out)
}
pub fn decode(bytes: &[u8]) -> Result<Frame> {
    if bytes.len() < HEADER {
        return Err(Error::Invalid("truncated terminal stream frame".into()));
    }
    if bytes[0] != VERSION || bytes[2] != 0 || bytes[3] != 0 {
        return Err(Error::Invalid("invalid terminal stream header".into()));
    }
    let n = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if n > MAX_PAYLOAD || bytes.len() != HEADER + n {
        return Err(Error::Invalid("invalid terminal stream length".into()));
    }
    let frame = Frame {
        kind: Kind::try_from(bytes[1])?,
        sequence: u64::from_be_bytes(bytes[4..12].try_into().unwrap()),
        payload: bytes[16..].to_vec(),
    };
    validate(&frame)?;
    Ok(frame)
}
fn validate(frame: &Frame) -> Result<()> {
    if frame.sequence > 9_007_199_254_740_991 || frame.payload.len() > MAX_PAYLOAD {
        return Err(Error::Invalid("terminal frame exceeds safe limits".into()));
    }
    match frame.kind {
        Kind::Input if frame.payload.is_empty() || frame.payload.len() > super::INPUT_BYTES => {
            return Err(Error::Invalid("invalid stream input length".into()));
        }
        Kind::Applied | Kind::Ready | Kind::Release if !frame.payload.is_empty() => {
            return Err(Error::Invalid("stream control must be empty".into()));
        }
        Kind::Resize | Kind::ResizeRequest => {
            if frame.payload.len() != 4 {
                return Err(Error::Invalid("invalid stream resize length".into()));
            }
            super::validate_size(super::TerminalSize {
                cols: u16::from_be_bytes([frame.payload[0], frame.payload[1]]),
                rows: u16::from_be_bytes([frame.payload[2], frame.payload[3]]),
            })?;
        }
        Kind::Hello
        | Kind::State
        | Kind::Error
        | Kind::Exit
        | Kind::Acquire
        | Kind::Result
        | Kind::Attach
            if frame.payload.len() > 4096
                || !serde_json::from_slice::<serde_json::Value>(&frame.payload)?.is_object() =>
        {
            return Err(Error::Invalid("invalid stream JSON control".into()));
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixture_round_trip_and_rejects_malformed() {
        let f = Frame {
            kind: Kind::Output,
            sequence: 9,
            payload: b"ok".to_vec(),
        };
        let wire = encode(&f).unwrap();
        assert_eq!(
            &wire[..16],
            &[1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0, 0, 2]
        );
        let d = decode(&wire).unwrap();
        assert_eq!(d.sequence, 9);
        assert_eq!(d.payload, b"ok");
        assert!(decode(&wire[..15]).is_err());
    }
}
