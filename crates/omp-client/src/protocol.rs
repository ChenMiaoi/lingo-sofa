use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};

pub const MAX_FRAME: usize = 64 * 1024;
pub const MAX_PENDING: usize = 16;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub v: u32,
    pub instance: String,
    pub kind: String,
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(default)]
    pub payload: Value,
}

pub fn read_frame(reader: &mut impl Read) -> Result<Frame> {
    let mut length = [0; 4];
    reader.read_exact(&mut length).map_err(|_| "worker_eof")?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("invalid_frame_length");
    }
    let mut body = zeroize::Zeroizing::new(vec![0; length]);
    reader
        .read_exact(&mut body)
        .map_err(|_| "truncated_frame")?;
    serde_json::from_slice(&body).map_err(|_| "invalid_frame_json")
}

pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> Result<()> {
    let body =
        zeroize::Zeroizing::new(serde_json::to_vec(frame).map_err(|_| "frame_encode_failed")?);
    if body.is_empty() || body.len() > MAX_FRAME {
        return Err("invalid_frame_length");
    }
    writer
        .write_all(&(body.len() as u32).to_le_bytes())
        .and_then(|()| writer.write_all(&body))
        .and_then(|()| writer.flush())
        .map_err(|_| "worker_write_failed")
}
