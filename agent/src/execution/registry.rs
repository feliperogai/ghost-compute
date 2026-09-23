//! The closed list of workload types this agent runs.
//!
//! A job from the network carries a type name and JSON parameters, never code.
//! The code for each type is a WebAssembly module compiled into this binary and
//! pinned by SHA-256. Anything not in this list is refused.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The benchmark module, built by `workloads/build.sh`.
pub const BENCHMARK_WASM: &[u8] = include_bytes!("../../workloads/benchmark.wasm");
/// Pinned hash: a tampered or rebuilt module is refused until this is updated deliberately.
pub const BENCHMARK_SHA256: &str = "e1edf2895c4b0f19fdd28d88617f764ecc3cca5ee963315353f75dfdb9dc8896";

/// The image classifier module (decoder + digits MLP), built by `workloads/build.sh`.
pub const IMAGE_INFERENCE_WASM: &[u8] = include_bytes!("../../workloads/image-inference.wasm");
pub const IMAGE_INFERENCE_SHA256: &str = "278ff8489860c136549ee92c36f98feff6a9531fe516eeec6bce15558eeffa30";
/// Model identity reported with every result (weights are embedded in the module).
pub const IMAGE_MODEL: &str = "digits-mlp-8x8";

/// Every registered type. The scheduler only sends these (the agent declares them).
pub const TYPES: &[&str] = &["benchmark", "image-inference"];

/// Limits for one image-inference batch. The control plane enforces the same values.
pub const MAX_BATCH_IMAGES: usize = 256;
pub const MAX_IMAGE_BYTES: u32 = 8 << 20;
pub const MAX_BATCH_BYTES: u64 = 64 << 20;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum Rejection {
    #[error("workload type '{0}' is not registered on this agent")]
    UnknownType(String),
    #[error("invalid parameters for '{ty}': {msg}")]
    InvalidParams { ty: &'static str, msg: String },
    #[error("module integrity check failed for '{0}'")]
    Integrity(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BenchmarkKind {
    /// Iterated SHA-256.
    Hash,
    /// Count primes up to `size` (segmented sieve).
    Primes,
    /// `size`×`size` f64 matrix product.
    Matmul,
}

impl BenchmarkKind {
    pub fn code(self) -> i32 {
        match self {
            BenchmarkKind::Hash => 0,
            BenchmarkKind::Primes => 1,
            BenchmarkKind::Matmul => 2,
        }
    }
}

/// Strict: unknown fields are an error, so `{"command": ...}` never slips through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BenchmarkParams {
    pub kind: BenchmarkKind,
    #[serde(default)]
    pub size: i64,
    pub iterations: i64,
    #[serde(default)]
    pub seed: i64,
}

impl BenchmarkParams {
    fn validate(&self) -> Result<(), String> {
        if !(1..=50_000_000).contains(&self.iterations) {
            return Err("iterations must be 1..=50000000".into());
        }
        match self.kind {
            BenchmarkKind::Hash if self.size != 0 => Err("size is not used by kind 'hash'".into()),
            BenchmarkKind::Primes if !(2..=50_000_000).contains(&self.size) => Err("size must be 2..=50000000".into()),
            BenchmarkKind::Matmul if !(1..=256).contains(&self.size) => Err("size must be 1..=256".into()),
            BenchmarkKind::Matmul if self.iterations > 1000 => Err("iterations must be ≤ 1000 for matmul".into()),
            _ => Ok(()),
        }
    }
}

/// Where the dense layers run. The image is always decoded inside WebAssembly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Accelerator {
    /// WebAssembly on the CPU.
    Cpu,
    /// GPU if the owner allows it and one is usable, else CPU.
    #[default]
    Auto,
    /// Placed on a GPU worker; still falls back to CPU if the device fails.
    Gpu,
}

/// One image of the batch: the agent downloads it by index and checks size and hash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRef {
    pub index: u32,
    pub sha256: String,
    pub size: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ImageInferenceParams {
    pub images: Vec<ImageRef>,
    #[serde(default)]
    pub accelerator: Accelerator,
    #[serde(default = "default_top_k")]
    pub top_k: u8,
}

fn default_top_k() -> u8 {
    3
}

impl ImageInferenceParams {
    fn validate(&self) -> Result<(), String> {
        if self.images.is_empty() || self.images.len() > MAX_BATCH_IMAGES {
            return Err(format!("images must have 1..={MAX_BATCH_IMAGES} entries"));
        }
        if !(1..=10).contains(&self.top_k) {
            return Err("topK must be 1..=10".into());
        }
        let mut seen = std::collections::HashSet::new();
        let mut total = 0u64;
        for i in &self.images {
            if !seen.insert(i.index) {
                return Err(format!("duplicate image index {}", i.index));
            }
            if i.sha256.len() != 64 || !i.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err("sha256 must be 64 lowercase hex characters".into());
            }
            if i.size == 0 || i.size > MAX_IMAGE_BYTES {
                return Err(format!("image size must be 1..={MAX_IMAGE_BYTES}"));
            }
            total += i.size as u64;
        }
        if total > MAX_BATCH_BYTES {
            return Err(format!("batch exceeds {MAX_BATCH_BYTES} bytes"));
        }
        Ok(())
    }

    pub fn image(&self, index: u32) -> Option<&ImageRef> {
        self.images.iter().find(|i| i.index == index)
    }
}

/// A validated, runnable workload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "params", rename_all = "lowercase")]
pub enum Workload {
    Benchmark(BenchmarkParams),
    #[serde(rename = "image-inference")]
    ImageInference(ImageInferenceParams),
}

impl Workload {
    /// The only way to obtain a `Workload`: registered type + strictly valid parameters.
    pub fn parse(ty: &str, input: &serde_json::Value) -> Result<Self, Rejection> {
        match ty {
            "benchmark" => {
                let p: BenchmarkParams = serde_json::from_value(input.clone())
                    .map_err(|e| Rejection::InvalidParams { ty: "benchmark", msg: e.to_string() })?;
                p.validate().map_err(|msg| Rejection::InvalidParams { ty: "benchmark", msg })?;
                Ok(Workload::Benchmark(p))
            }
            "image-inference" => {
                let ty = "image-inference";
                let p: ImageInferenceParams = serde_json::from_value(input.clone())
                    .map_err(|e| Rejection::InvalidParams { ty, msg: e.to_string() })?;
                p.validate().map_err(|msg| Rejection::InvalidParams { ty, msg })?;
                Ok(Workload::ImageInference(p))
            }
            other => Err(Rejection::UnknownType(other.chars().take(64).collect())),
        }
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Workload::Benchmark(_) => "benchmark",
            Workload::ImageInference(_) => "image-inference",
        }
    }

    /// Module bytes, after verifying the pinned hash.
    pub fn module(&self) -> Result<&'static [u8], Rejection> {
        let (bytes, pinned) = match self {
            Workload::Benchmark(_) => (BENCHMARK_WASM, BENCHMARK_SHA256),
            Workload::ImageInference(_) => (IMAGE_INFERENCE_WASM, IMAGE_INFERENCE_SHA256),
        };
        if hex::encode(Sha256::digest(bytes)) != pinned {
            return Err(Rejection::Integrity(self.type_name()));
        }
        Ok(bytes)
    }

    pub fn module_sha256(&self) -> &'static str {
        match self {
            Workload::Benchmark(_) => BENCHMARK_SHA256,
            Workload::ImageInference(_) => IMAGE_INFERENCE_SHA256,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_module_matches_pinned_hash() {
        let w = Workload::parse("benchmark", &json!({ "kind": "hash", "iterations": 1 })).unwrap();
        assert_eq!(w.module().unwrap().len(), BENCHMARK_WASM.len());
    }

    #[test]
    fn only_registered_types() {
        for ty in
            ["shell", "powershell", "cmd", "exec", "script", "python", "wasm", "native", "BENCHMARK", "benchmark "]
        {
            assert!(matches!(Workload::parse(ty, &json!({})), Err(Rejection::UnknownType(_))), "{ty}");
        }
    }

    #[test]
    fn parameters_are_strict() {
        let bad = [
            json!({ "kind": "hash", "iterations": 1, "command": "calc.exe" }),
            json!({ "kind": "hash", "iterations": 1, "script": "Remove-Item C:\\ -Recurse" }),
            json!({ "kind": "hash", "iterations": 1, "module": "AGFzbQEAAAA=" }),
            json!({ "kind": "hash", "iterations": 1, "path": "C:\\Windows\\System32" }),
            json!({ "kind": "hash", "iterations": 1, "url": "http://evil" }),
            json!({ "kind": "exec", "iterations": 1 }),
            json!({ "kind": "hash", "iterations": 0 }),
            json!({ "kind": "hash", "iterations": 100_000_000 }),
            json!({ "kind": "hash", "iterations": "1; rm -rf /" }),
            json!({ "kind": "primes", "iterations": 1, "size": 1 }),
            json!({ "kind": "matmul", "iterations": 1, "size": 100_000 }),
            json!({ "kind": "matmul", "iterations": 5000, "size": 8 }),
            json!("benchmark --shell"),
            json!(null),
        ];
        for b in bad {
            assert!(matches!(Workload::parse("benchmark", &b), Err(Rejection::InvalidParams { .. })), "{b}");
        }
        Workload::parse("benchmark", &json!({ "kind": "matmul", "size": 64, "iterations": 2, "seed": 7 })).unwrap();
    }

    fn img(index: u32) -> serde_json::Value {
        json!({ "index": index, "sha256": "ab".repeat(32), "size": 1000 })
    }

    #[test]
    fn image_inference_parameters_are_strict() {
        let ok =
            Workload::parse("image-inference", &json!({ "images": [img(0), img(1)], "accelerator": "gpu", "topK": 2 }))
                .unwrap();
        assert_eq!(ok.module().unwrap().len(), IMAGE_INFERENCE_WASM.len());
        let Workload::ImageInference(p) = ok else { panic!() };
        assert_eq!((p.accelerator, p.top_k), (Accelerator::Gpu, 2));

        let too_many: Vec<_> = (0..=MAX_BATCH_IMAGES as u32).map(img).collect();
        let bad = [
            json!({ "images": [] }),
            json!({ "images": too_many }),
            json!({ "images": [img(0), img(0)] }),
            json!({ "images": [img(0)], "topK": 0 }),
            json!({ "images": [img(0)], "topK": 11 }),
            json!({ "images": [img(0)], "accelerator": "cuda-native" }),
            json!({ "images": [img(0)], "model": "https://evil/model.onnx" }),
            json!({ "images": [img(0)], "command": "nvidia-smi" }),
            json!({ "images": [{ "index": 0, "sha256": "ab".repeat(32), "size": 1000, "url": "file:///etc/passwd" }] }),
            json!({ "images": [{ "index": 0, "sha256": "../../etc/passwd", "size": 1000 }] }),
            json!({ "images": [{ "index": 0, "sha256": "AB".repeat(32), "size": 1000 }] }),
            json!({ "images": [{ "index": 0, "sha256": "ab".repeat(32), "size": 0 }] }),
            json!({ "images": [{ "index": 0, "sha256": "ab".repeat(32), "size": MAX_IMAGE_BYTES + 1 }] }),
            json!({ "images": (0..9).map(|i| json!({ "index": i, "sha256": "ab".repeat(32), "size": MAX_IMAGE_BYTES })).collect::<Vec<_>>() }),
        ];
        for b in bad {
            assert!(matches!(Workload::parse("image-inference", &b), Err(Rejection::InvalidParams { .. })), "{b}");
        }
    }

    #[test]
    fn workload_round_trips_through_the_sandbox_request() {
        let w = Workload::parse("image-inference", &json!({ "images": [img(3)] })).unwrap();
        let v = serde_json::to_value(&w).unwrap();
        assert_eq!(v["type"], "image-inference");
        assert_eq!(Workload::parse("image-inference", &v["params"]).unwrap(), w);
    }
}
