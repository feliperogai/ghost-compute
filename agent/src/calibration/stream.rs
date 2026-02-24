//! Deterministic network test data: SHA-256 in counter mode over the server's nonce.
//! Byte i = byte (i mod 32) of sha256(nonce || u64le(i / 32)). Same function as the
//! control plane (`control-plane/src/performance/stream.ts`), same test vectors.

use sha2::{Digest, Sha256};

pub fn stream_bytes(nonce: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut i: u64 = 0;
    while out.len() < len {
        let mut h = Sha256::new();
        h.update(nonce.as_bytes());
        h.update(i.to_le_bytes());
        out.extend_from_slice(&h.finalize());
        i += 1;
    }
    out.truncate(len);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_control_plane_vectors() {
        assert_eq!(
            hex::encode(stream_bytes("ghost-test-vector", 40)),
            "8cc68a445b6b23d09e5966ebadd30f23bf0983491f267ca81a85ea617f470198e49049142a6d5989"
        );
        assert_eq!(
            hex::encode(Sha256::digest(stream_bytes("ghost-test-vector", 100_000))),
            "b9ac005dd52e78d2e9f37aec4768d388c0538943faef2d95a5fc60fd3d3cf01d"
        );
    }
}
