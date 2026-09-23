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

/// Every registered type. The scheduler only sends these (the agent declares them).
pub const TYPES: &[&str] = &["benchmark"];

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

/// A validated, runnable workload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "params", rename_all = "lowercase")]
pub enum Workload {
    Benchmark(BenchmarkParams),
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
            other => Err(Rejection::UnknownType(other.chars().take(64).collect())),
        }
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            Workload::Benchmark(_) => "benchmark",
        }
    }

    /// Module bytes, after verifying the pinned hash.
    pub fn module(&self) -> Result<&'static [u8], Rejection> {
        let (bytes, pinned) = match self {
            Workload::Benchmark(_) => (BENCHMARK_WASM, BENCHMARK_SHA256),
        };
        if hex::encode(Sha256::digest(bytes)) != pinned {
            return Err(Rejection::Integrity(self.type_name()));
        }
        Ok(bytes)
    }

    pub fn module_sha256(&self) -> &'static str {
        match self {
            Workload::Benchmark(_) => BENCHMARK_SHA256,
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
}
