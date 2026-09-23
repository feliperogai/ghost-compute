//! Shared pieces of the `image-inference` workload: result types, the model layout
//! and the binary frames that carry image bytes from the agent to the sandbox.

use std::io::Read;

use serde::{Deserialize, Serialize};

use super::registry::MAX_IMAGE_BYTES;

pub const INPUT: usize = 64;
pub const HIDDEN: usize = 128;
pub const CLASSES: usize = 10;
const MAGIC: &[u8; 8] = b"GHMLP1\0\0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prediction {
    pub label: u8,
    /// Probability in basis points (0..=10000). Integers only: the output is hashed as JSON.
    pub confidence_bp: u32,
}

/// Result for one image. Either a prediction or an error code (bad image), never both.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceItem {
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence_bp: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_k: Vec<Prediction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InferenceItem {
    pub fn predicted(index: u32, probs: &[f32; CLASSES], k: u8) -> Self {
        let mut order: Vec<usize> = (0..CLASSES).collect();
        // Highest probability first; ties by label, so the order is deterministic.
        order.sort_by(|&a, &b| probs[b].total_cmp(&probs[a]).then(a.cmp(&b)));
        let bp = |p: f32| (p.clamp(0.0, 1.0) * 10_000.0).round() as u32;
        let top_k: Vec<_> = order
            .iter()
            .take(k.clamp(1, CLASSES as u8) as usize)
            .map(|&l| Prediction { label: l as u8, confidence_bp: bp(probs[l]) })
            .collect();
        Self { index, label: Some(top_k[0].label), confidence_bp: Some(top_k[0].confidence_bp), top_k, error: None }
    }

    pub fn failed(index: u32, code: &str) -> Self {
        Self { index, label: None, confidence_bp: None, top_k: vec![], error: Some(code.into()) }
    }

    /// Structural check for items read back from a sandbox or a checkpoint.
    pub fn is_well_formed(&self, max_k: u8) -> bool {
        match (&self.label, &self.confidence_bp, &self.error) {
            (Some(l), Some(c), None) => {
                (*l as usize) < CLASSES
                    && *c <= 10_000
                    && !self.top_k.is_empty()
                    && self.top_k.len() <= max_k as usize
                    && self.top_k[0].label == *l
                    && self.top_k.iter().all(|p| (p.label as usize) < CLASSES && p.confidence_bp <= 10_000)
            }
            (None, None, Some(e)) => self.top_k.is_empty() && !e.is_empty() && e.len() <= 32,
            _ => false,
        }
    }
}

pub fn softmax(z: &[f32; CLASSES]) -> [f32; CLASSES] {
    let m = z.iter().cloned().fold(f32::MIN, f32::max);
    let mut out = [0f32; CLASSES];
    let mut sum = 0.0;
    for (o, v) in out.iter_mut().zip(z) {
        *o = (v - m).exp();
        sum += *o;
    }
    for o in out.iter_mut() {
        *o /= sum;
    }
    out
}

/// Dense weights, as read from the (hash-pinned) module's memory.
pub struct Weights {
    /// W1 [64×128] | b1 [128] | W2 [128×10] | b2 [10], row-major f32.
    pub packed: Vec<f32>,
}

impl Weights {
    pub const LEN: usize = INPUT * HIDDEN + HIDDEN + HIDDEN * CLASSES + CLASSES;
    pub const W1: usize = 0;
    pub const B1: usize = INPUT * HIDDEN;
    pub const W2: usize = Self::B1 + HIDDEN;
    pub const B2: usize = Self::W2 + HIDDEN * CLASSES;

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != 20 + Self::LEN * 4 || &bytes[..8] != MAGIC {
            return Err("unexpected model layout".into());
        }
        let dim = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()) as usize;
        if (dim(8), dim(12), dim(16)) != (INPUT, HIDDEN, CLASSES) {
            return Err("unexpected model dimensions".into());
        }
        let packed = bytes[20..].chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
        Ok(Self { packed })
    }

    /// Reference forward pass on the host (logits). Used by tests.
    pub fn logits(&self, x: &[f32; INPUT]) -> [f32; CLASSES] {
        let w = &self.packed;
        let mut z = [0f32; CLASSES];
        z.copy_from_slice(&w[Self::B2..Self::B2 + CLASSES]);
        for j in 0..HIDDEN {
            let mut h = w[Self::B1 + j];
            for i in 0..INPUT {
                h += x[i] * w[Self::W1 + i * HIDDEN + j];
            }
            let h = h.max(0.0);
            for k in 0..CLASSES {
                z[k] += h * w[Self::W2 + j * CLASSES + k];
            }
        }
        z
    }
}

/// Frame on the sandbox's stdin after the request line: u32 LE index, u32 LE length, bytes.
pub fn encode_frame(index: u32, bytes: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(8 + bytes.len());
    f.extend_from_slice(&index.to_le_bytes());
    f.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    f.extend_from_slice(bytes);
    f
}

#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("input ended early")]
    Eof,
    #[error("frame too large")]
    TooLarge,
    #[error("read error: {0}")]
    Io(String),
}

pub fn read_frame(r: &mut impl Read) -> Result<(u32, Vec<u8>), FrameError> {
    let mut head = [0u8; 8];
    r.read_exact(&mut head).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => FrameError::Eof,
        _ => FrameError::Io(e.to_string()),
    })?;
    let index = u32::from_le_bytes(head[..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..].try_into().unwrap());
    if len > MAX_IMAGE_BYTES {
        return Err(FrameError::TooLarge);
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).map_err(|e| match e.kind() {
        std::io::ErrorKind::UnexpectedEof => FrameError::Eof,
        _ => FrameError::Io(e.to_string()),
    })?;
    Ok((index, buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_k_is_ordered_and_deterministic() {
        let mut p = [0.0f32; CLASSES];
        p[7] = 0.6;
        p[1] = 0.2;
        p[4] = 0.2;
        let it = InferenceItem::predicted(5, &p, 3);
        assert_eq!(it.label, Some(7));
        assert_eq!(it.confidence_bp, Some(6000));
        assert_eq!(it.top_k.iter().map(|p| p.label).collect::<Vec<_>>(), vec![7, 1, 4]);
        assert!(it.is_well_formed(3));
        assert!(!it.is_well_formed(2));
        assert!(InferenceItem::failed(1, "DECODE").is_well_formed(3));
        let mut forged = it.clone();
        forged.label = Some(12);
        assert!(!forged.is_well_formed(3));
    }

    #[test]
    fn frames_round_trip_and_are_bounded() {
        let f = encode_frame(9, b"abc");
        assert_eq!(read_frame(&mut &f[..]).unwrap(), (9, b"abc".to_vec()));
        assert!(matches!(read_frame(&mut &f[..6]), Err(FrameError::Eof)));
        let mut huge = 1u32.to_le_bytes().to_vec();
        huge.extend_from_slice(&(MAX_IMAGE_BYTES + 1).to_le_bytes());
        assert!(matches!(read_frame(&mut &huge[..]), Err(FrameError::TooLarge)));
    }

    #[test]
    fn model_layout_is_checked() {
        assert!(Weights::parse(b"GHMLP1\0\0short").is_err());
        let mut b = MAGIC.to_vec();
        for d in [64u32, 128, 10] {
            b.extend_from_slice(&d.to_le_bytes());
        }
        b.resize(20 + Weights::LEN * 4, 0);
        assert!(Weights::parse(&b).is_ok());
        b[8] = 65;
        assert!(Weights::parse(&b).is_err());
    }
}
