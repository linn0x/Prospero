use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::error::{Error, Result};

pub const FRAME_TYPE_CONTROL: i32 = 0;
pub const FRAME_TYPE_DATA: i32 = 1;

pub const HEADER_TIMESTAMP: &str = "timestamp";
pub const HEADER_TYPE: &str = "type";
pub const HEADER_MESSAGE_ID: &str = "message_id";
pub const HEADER_SUM: &str = "sum";
pub const HEADER_SEQ: &str = "seq";
pub const HEADER_TRACE_ID: &str = "trace_id";
pub const HEADER_BIZ_RT: &str = "biz_rt";

pub const MESSAGE_TYPE_EVENT: &str = "event";
pub const MESSAGE_TYPE_CARD: &str = "card";
pub const MESSAGE_TYPE_PING: &str = "ping";
pub const MESSAGE_TYPE_PONG: &str = "pong";

const MAX_CHUNK_ENTRIES: usize = 128;
const MAX_CHUNK_PARTS: usize = 64;
const MAX_ASSEMBLED_BYTES: usize = 4 * 1024 * 1024;
const CHUNK_TTL: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PbbpHeader {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PbbpFrame {
    pub seq_id: u64,
    pub log_id: u64,
    pub service: i32,
    pub method: i32,
    pub headers: Vec<PbbpHeader>,
    pub payload_encoding: Option<String>,
    pub payload_type: Option<String>,
    pub payload: Option<Vec<u8>>,
    pub log_id_new: Option<String>,
}

impl PbbpFrame {
    pub fn new_ping(service_id: i32) -> Self {
        Self {
            seq_id: 0,
            log_id: 0,
            service: service_id,
            method: FRAME_TYPE_CONTROL,
            headers: vec![PbbpHeader {
                key: HEADER_TYPE.into(),
                value: MESSAGE_TYPE_PING.into(),
            }],
            payload_encoding: None,
            payload_type: None,
            payload: None,
            log_id_new: None,
        }
    }

    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|header| header.key == key)
            .map(|header| header.value.as_str())
    }

    pub fn header_usize(&self, key: &str) -> Option<usize> {
        self.header(key)
            .and_then(|value| value.parse::<usize>().ok())
    }

    pub fn into_event_ack(mut self, code: i32, biz_rt_ms: u64) -> Self {
        self.headers.push(PbbpHeader {
            key: HEADER_BIZ_RT.into(),
            value: biz_rt_ms.to_string(),
        });
        self.payload = serde_json::to_vec(&json!({ "code": code })).ok();
        self
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(128);
        // Tags 1..=4 are proto2 `required` on `pbbp2.Frame`: always emit them even when zero.
        encode_tag(&mut out, 1, 0);
        encode_varint(&mut out, self.seq_id);
        encode_tag(&mut out, 2, 0);
        encode_varint(&mut out, self.log_id);
        encode_tag(&mut out, 3, 0);
        encode_varint(&mut out, i64::from(self.service) as u64);
        encode_tag(&mut out, 4, 0);
        encode_varint(&mut out, i64::from(self.method) as u64);
        for header in &self.headers {
            let mut hbuf = Vec::with_capacity(header.key.len() + header.value.len() + 8);
            encode_bytes_field(&mut hbuf, 1, header.key.as_bytes());
            encode_bytes_field(&mut hbuf, 2, header.value.as_bytes());
            encode_bytes_field(&mut out, 5, &hbuf);
        }
        if let Some(encoding) = self.payload_encoding.as_deref() {
            encode_bytes_field(&mut out, 6, encoding.as_bytes());
        }
        if let Some(payload_type) = self.payload_type.as_deref() {
            encode_bytes_field(&mut out, 7, payload_type.as_bytes());
        }
        if let Some(payload) = self.payload.as_deref() {
            encode_bytes_field(&mut out, 8, payload);
        }
        if let Some(log_id_new) = self.log_id_new.as_deref() {
            encode_bytes_field(&mut out, 9, log_id_new.as_bytes());
        }
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let mut cursor = 0usize;
        let mut frame = Self::default();
        while cursor < bytes.len() {
            let key = decode_varint(bytes, &mut cursor)?;
            let field = key >> 3;
            let wire = (key & 0x7) as u8;
            match (field, wire) {
                (1, 0) => frame.seq_id = decode_varint(bytes, &mut cursor)?,
                (2, 0) => frame.log_id = decode_varint(bytes, &mut cursor)?,
                (3, 0) => frame.service = decode_varint(bytes, &mut cursor)? as i64 as i32,
                (4, 0) => frame.method = decode_varint(bytes, &mut cursor)? as i64 as i32,
                (5, 2) => {
                    let slice = decode_length_delimited(bytes, &mut cursor)?;
                    frame.headers.push(decode_header(slice)?);
                }
                (6, 2) => {
                    let slice = decode_length_delimited(bytes, &mut cursor)?;
                    frame.payload_encoding = Some(decode_utf8(slice)?);
                }
                (7, 2) => {
                    let slice = decode_length_delimited(bytes, &mut cursor)?;
                    frame.payload_type = Some(decode_utf8(slice)?);
                }
                (8, 2) => {
                    let slice = decode_length_delimited(bytes, &mut cursor)?;
                    frame.payload = Some(slice.to_vec());
                }
                (9, 2) => {
                    let slice = decode_length_delimited(bytes, &mut cursor)?;
                    frame.log_id_new = Some(decode_utf8(slice)?);
                }
                (9, 0) => {
                    let value = decode_varint(bytes, &mut cursor)?;
                    frame.log_id_new = Some(value.to_string());
                }
                _ => skip_field(bytes, &mut cursor, wire)?,
            }
        }
        Ok(frame)
    }
}

fn decode_header(bytes: &[u8]) -> Result<PbbpHeader> {
    let mut cursor = 0usize;
    let mut key = String::new();
    let mut value = String::new();
    while cursor < bytes.len() {
        let tag = decode_varint(bytes, &mut cursor)?;
        let field = tag >> 3;
        let wire = (tag & 0x7) as u8;
        match (field, wire) {
            (1, 2) => key = decode_utf8(decode_length_delimited(bytes, &mut cursor)?)?,
            (2, 2) => value = decode_utf8(decode_length_delimited(bytes, &mut cursor)?)?,
            _ => skip_field(bytes, &mut cursor, wire)?,
        }
    }
    Ok(PbbpHeader { key, value })
}

fn decode_utf8(slice: &[u8]) -> Result<String> {
    String::from_utf8(slice.to_vec())
        .map_err(|_| Error::Invalid("invalid UTF-8 in pbbp2 frame".into()))
}

fn encode_tag(out: &mut Vec<u8>, field: u64, wire: u8) {
    encode_varint(out, (field << 3) | u64::from(wire));
}

fn encode_bytes_field(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    encode_tag(out, field, 2);
    encode_varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

fn encode_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push(((value as u8) & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn decode_varint(bytes: &[u8], cursor: &mut usize) -> Result<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let Some(&byte) = bytes.get(*cursor) else {
            return Err(Error::Invalid("truncated varint in pbbp2 frame".into()));
        };
        *cursor += 1;
        if shift >= 64 || (shift == 63 && byte > 1) {
            return Err(Error::Invalid("varint overflow in pbbp2 frame".into()));
        }
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
    }
}

fn decode_length_delimited<'a>(bytes: &'a [u8], cursor: &mut usize) -> Result<&'a [u8]> {
    let len = decode_varint(bytes, cursor)?;
    let len = usize::try_from(len)
        .map_err(|_| Error::Invalid("length exceeds platform bounds in pbbp2 frame".into()))?;
    let end = cursor
        .checked_add(len)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| Error::Invalid("truncated bytes field in pbbp2 frame".into()))?;
    let slice = &bytes[*cursor..end];
    *cursor = end;
    Ok(slice)
}

fn skip_field(bytes: &[u8], cursor: &mut usize, wire: u8) -> Result<()> {
    match wire {
        0 => {
            let _ = decode_varint(bytes, cursor)?;
            Ok(())
        }
        1 => {
            let end = cursor
                .checked_add(8)
                .filter(|end| *end <= bytes.len())
                .ok_or_else(|| Error::Invalid("truncated fixed64 in pbbp2 frame".into()))?;
            *cursor = end;
            Ok(())
        }
        2 => {
            let _ = decode_length_delimited(bytes, cursor)?;
            Ok(())
        }
        5 => {
            let end = cursor
                .checked_add(4)
                .filter(|end| *end <= bytes.len())
                .ok_or_else(|| Error::Invalid("truncated fixed32 in pbbp2 frame".into()))?;
            *cursor = end;
            Ok(())
        }
        _ => Err(Error::Invalid(format!(
            "unsupported protobuf wire type {wire} in pbbp2 frame"
        ))),
    }
}

struct ChunkBuffer {
    parts: Vec<Option<Vec<u8>>>,
    total_bytes: usize,
    created_at: Instant,
}

#[derive(Default)]
pub struct ChunkAssembler {
    entries: HashMap<String, ChunkBuffer>,
    order: VecDeque<String>,
}

impl ChunkAssembler {
    pub fn push(
        &mut self,
        message_id: &str,
        sum: usize,
        seq: usize,
        chunk: Vec<u8>,
    ) -> Option<Vec<u8>> {
        self.evict_expired();
        if sum <= 1 {
            return Some(chunk);
        }
        if message_id.is_empty() || sum > MAX_CHUNK_PARTS || seq >= sum {
            return None;
        }
        if !self.entries.contains_key(message_id) {
            while self.entries.len() >= MAX_CHUNK_ENTRIES {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                } else {
                    break;
                }
            }
            self.order.push_back(message_id.to_owned());
            self.entries.insert(
                message_id.to_owned(),
                ChunkBuffer {
                    parts: vec![None; sum],
                    total_bytes: 0,
                    created_at: Instant::now(),
                },
            );
        }

        let complete = {
            let buffer = self.entries.get_mut(message_id)?;
            if buffer.parts.len() != sum {
                return None;
            }
            let prev_len = buffer.parts[seq].as_ref().map_or(0, Vec::len);
            let next_total = buffer
                .total_bytes
                .saturating_sub(prev_len)
                .saturating_add(chunk.len());
            if next_total > MAX_ASSEMBLED_BYTES {
                self.entries.remove(message_id);
                return None;
            }
            buffer.total_bytes = next_total;
            buffer.parts[seq] = Some(chunk);
            buffer.parts.iter().all(Option::is_some)
        };

        if !complete {
            return None;
        }

        let buffer = self.entries.remove(message_id)?;
        let mut combined = Vec::with_capacity(buffer.total_bytes);
        for part in buffer.parts.into_iter().flatten() {
            combined.extend_from_slice(&part);
        }
        Some(combined)
    }

    fn evict_expired(&mut self) {
        let now = Instant::now();
        while let Some(front) = self.order.front() {
            let expired = self
                .entries
                .get(front)
                .is_none_or(|buf| now.duration_since(buf.created_at) >= CHUNK_TTL);
            if expired {
                if let Some(id) = self.order.pop_front() {
                    self.entries.remove(&id);
                }
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_frame_encodes_required_zero_fields_and_round_trips() {
        let frame = PbbpFrame::new_ping(32841);
        let bytes = frame.encode();
        // Field tags 1, 2, 3, 4 must all be present in the wire bytes (proto2 required).
        assert!(bytes.starts_with(&[0x08, 0x00, 0x10, 0x00, 0x18]));
        let decoded = PbbpFrame::decode(&bytes).expect("decode ping");
        assert_eq!(decoded, frame);
        assert_eq!(decoded.header(HEADER_TYPE), Some(MESSAGE_TYPE_PING));
    }

    #[test]
    fn data_frame_round_trip_and_negative_service() {
        let frame = PbbpFrame {
            seq_id: 99,
            log_id: 123456,
            service: -7,
            method: FRAME_TYPE_DATA,
            headers: vec![
                PbbpHeader {
                    key: HEADER_TYPE.into(),
                    value: MESSAGE_TYPE_EVENT.into(),
                },
                PbbpHeader {
                    key: HEADER_MESSAGE_ID.into(),
                    value: "msg_1".into(),
                },
            ],
            payload_encoding: Some("json".into()),
            payload_type: Some("event".into()),
            payload: Some(br#"{"schema":"2.0"}"#.to_vec()),
            log_id_new: Some("log-new-abc".into()),
        };
        let encoded = frame.encode();
        let decoded = PbbpFrame::decode(&encoded).expect("decode data frame");
        assert_eq!(decoded, frame);
    }

    #[test]
    fn skips_unknown_fields_and_builds_event_ack() {
        let frame = PbbpFrame {
            seq_id: 7,
            log_id: 8,
            service: 42,
            method: FRAME_TYPE_DATA,
            headers: vec![PbbpHeader {
                key: HEADER_TYPE.into(),
                value: MESSAGE_TYPE_EVENT.into(),
            }],
            payload_encoding: None,
            payload_type: None,
            payload: Some(b"hello".to_vec()),
            log_id_new: None,
        };
        let mut raw = frame.encode();
        // Append unknown field 15 (wire 0), field 16 (wire 1), field 17 (wire 5), field 18 (wire 2)
        encode_tag(&mut raw, 15, 0);
        encode_varint(&mut raw, 42);
        encode_tag(&mut raw, 16, 1);
        raw.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
        encode_tag(&mut raw, 17, 5);
        raw.extend_from_slice(&[9, 10, 11, 12]);
        encode_bytes_field(&mut raw, 18, b"extra");

        let decoded = PbbpFrame::decode(&raw).expect("decode with unknown fields");
        assert_eq!(decoded, frame);

        let ack = decoded.into_event_ack(200, 14);
        assert_eq!(ack.header(HEADER_BIZ_RT), Some("14"));
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(ack.payload.as_deref().unwrap()).unwrap(),
            json!({ "code": 200 })
        );
    }

    #[test]
    fn assembles_out_of_order_chunks() {
        let mut assembler = ChunkAssembler::default();
        assert!(assembler.push("m1", 3, 2, b"world!".to_vec()).is_none());
        assert!(assembler.push("m1", 3, 0, b"hello ".to_vec()).is_none());
        let done = assembler.push("m1", 3, 1, b"feishu ".to_vec()).unwrap();
        assert_eq!(done, b"hello feishu world!");
    }
}
