//! image-inference through the real sandbox process: accuracy, GPU path, hostile images,
//! manifest enforcement, partial inputs (resume) and limits.

use std::time::Duration;

use ghost_agent::execution::inference::InferenceItem;
use ghost_agent::execution::protocol::GpuMode;
use ghost_agent::execution::registry::{Accelerator, ImageInferenceParams, ImageRef, Workload};
use ghost_agent::execution::sandbox::{Input, Sandbox, SandboxError, SandboxLimits, Update};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

const EXE: &str = env!("CARGO_BIN_EXE_ghost-sandbox");
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../workloads/image-inference/testdata");

fn limits(gpu: bool) -> SandboxLimits {
    SandboxLimits {
        wasm_memory_bytes: 256 << 20,
        process_memory_bytes: if gpu { (5u64 << 30) + (512 << 20) } else { 768 << 20 },
        cpu_percent: 50,
        deadline: Duration::from_secs(60),
    }
}

/// (bytes, expected label) for every fixture.
fn fixtures() -> Vec<(Vec<u8>, Option<u8>)> {
    let mut v: Vec<_> = std::fs::read_dir(FIXTURES)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "png" || e == "jpg"))
        .collect();
    v.sort();
    v.into_iter()
        .map(|p| {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let label = name.split("label").nth(1).and_then(|s| s.chars().next()).map(|c| c as u8 - b'0');
            (std::fs::read(&p).unwrap(), label)
        })
        .collect()
}

fn params(images: &[Vec<u8>], accelerator: Accelerator) -> ImageInferenceParams {
    ImageInferenceParams {
        images: images
            .iter()
            .enumerate()
            .map(|(i, b)| ImageRef {
                index: i as u32 * 10,
                sha256: hex::encode(Sha256::digest(b)),
                size: b.len() as u32,
            })
            .collect(),
        accelerator,
        top_k: 3,
    }
}

struct Run {
    result: Result<Value, SandboxError>,
    items: Vec<InferenceItem>,
}

/// Feeds `send` (index, bytes) frames for the announced `inputs`.
async fn run(
    p: &ImageInferenceParams,
    inputs: Vec<u32>,
    send: Vec<(u32, Vec<u8>)>,
    gpu: GpuMode,
    l: SandboxLimits,
) -> Run {
    let root = tempfile::tempdir().unwrap();
    let sb = Sandbox::new(EXE.into(), root.path().to_path_buf());
    let (tx, rx) = tokio::sync::mpsc::channel(2);
    tokio::spawn(async move {
        for f in send {
            if tx.send(f).await.is_err() {
                break;
            }
        }
    });
    let mut items = Vec::new();
    let result = sb
        .run_with(
            &Workload::ImageInference(p.clone()),
            l,
            Input { inputs, frames: Some(rx), gpu },
            |u| {
                if let Update::Item(i) = u {
                    items.push(i)
                }
            },
            CancellationToken::new(),
        )
        .await;
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "work directory left behind");
    Run { result, items }
}

fn all(p: &ImageInferenceParams, images: &[Vec<u8>]) -> (Vec<u32>, Vec<(u32, Vec<u8>)>) {
    let idx: Vec<u32> = p.images.iter().map(|i| i.index).collect();
    (idx.clone(), idx.into_iter().zip(images.iter().cloned()).collect())
}

#[tokio::test]
async fn classifies_png_and_jpeg_on_cpu() {
    let fx = fixtures();
    let images: Vec<_> = fx.iter().map(|f| f.0.clone()).collect();
    let p = params(&images, Accelerator::Cpu);
    let (inputs, frames) = all(&p, &images);
    let r = run(&p, inputs, frames, GpuMode::Any, limits(false)).await;
    let out = r.result.unwrap();
    assert_eq!(out["accelerator"], "cpu");
    assert_eq!(out["processed"], 24);
    assert_eq!(r.items.len(), 24);
    for (it, (_, label)) in r.items.iter().zip(&fx) {
        assert_eq!(it.label, *label, "image {}", it.index);
        assert_eq!(it.top_k.len(), 3);
        assert!(it.confidence_bp.unwrap() > 3000);
    }
}

#[tokio::test]
async fn gpu_path_matches_cpu_results() {
    // Uses any Vulkan adapter here (Mesa lavapipe in CI); production allows real GPUs only.
    let fx = fixtures();
    let images: Vec<_> = fx.iter().map(|f| f.0.clone()).collect();
    let p = params(&images, Accelerator::Gpu);
    let (inputs, frames) = all(&p, &images);
    let r = run(&p, inputs, frames, GpuMode::Any, limits(true)).await;
    let out = r.result.unwrap();
    if out["accelerator"] != "gpu" {
        eprintln!("no GPU adapter on this machine, fallback verified instead: {}", out["note"]);
        assert!(out["note"].as_str().unwrap().contains("used cpu"));
    } else {
        assert!(out["device"].is_string());
    }
    assert_eq!(r.items.len(), 24);
    for (it, (_, label)) in r.items.iter().zip(&fx) {
        assert_eq!(it.label, *label, "image {}", it.index);
    }
}

#[tokio::test]
async fn gpu_off_means_cpu_even_if_the_job_asks() {
    let images: Vec<_> = fixtures().into_iter().take(2).map(|f| f.0).collect();
    let p = params(&images, Accelerator::Gpu);
    let (inputs, frames) = all(&p, &images);
    let out = run(&p, inputs, frames, GpuMode::Off, limits(false)).await.result.unwrap();
    assert_eq!(out["accelerator"], "cpu");
    assert!(out.get("device").is_none());
}

#[tokio::test]
async fn hostile_images_fail_individually() {
    let good = fixtures().remove(0);
    let mut bomb = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bomb.extend_from_slice(&100_000u32.to_be_bytes());
    bomb.extend_from_slice(&100_000u32.to_be_bytes());
    bomb.extend_from_slice(&[8, 0, 0, 0, 0, 0, 0, 0, 0]);
    let images = vec![
        b"MZ\x90\0\x03\0\0\0 this is a windows executable".to_vec(),
        b"#!/bin/sh\nrm -rf /\n".to_vec(),
        b"GIF89a\x01\0\x01\0".to_vec(),
        b"\x89PNG\r\n\x1a\ntruncated".to_vec(),
        b"\xff\xd8\xff\xe0 broken jpeg".to_vec(),
        bomb,
        good.0.clone(),
    ];
    let p = params(&images, Accelerator::Cpu);
    let (inputs, frames) = all(&p, &images);
    let r = run(&p, inputs, frames, GpuMode::Off, limits(false)).await;
    r.result.unwrap();
    let errs: Vec<_> = r.items.iter().map(|i| i.error.clone()).collect();
    assert_eq!(errs[0].as_deref(), Some("UNSUPPORTED_FORMAT"));
    assert_eq!(errs[1].as_deref(), Some("UNSUPPORTED_FORMAT"));
    assert_eq!(errs[2].as_deref(), Some("UNSUPPORTED_FORMAT"));
    assert_eq!(errs[3].as_deref(), Some("DECODE_ERROR"));
    assert_eq!(errs[4].as_deref(), Some("DECODE_ERROR"));
    assert!(matches!(errs[5].as_deref(), Some("IMAGE_TOO_LARGE" | "DECODE_ERROR")), "{:?}", errs[5]);
    assert_eq!(r.items[6].label, good.1, "a good image after bad ones still works");
}

#[tokio::test]
async fn frames_must_match_the_manifest() {
    let images: Vec<_> = fixtures().into_iter().take(2).map(|f| f.0).collect();
    let p = params(&images, Accelerator::Cpu);
    // Swapped content: right index, wrong bytes.
    let r =
        run(&p, vec![0, 10], vec![(0, images[1].clone()), (10, images[0].clone())], GpuMode::Off, limits(false)).await;
    assert!(matches!(r.result, Err(SandboxError::Workload { ref code, .. }) if code == "INPUT"), "{:?}", r.result);
    // Index not in the batch.
    let r = run(&p, vec![0, 99], vec![], GpuMode::Off, limits(false)).await;
    assert!(
        matches!(r.result, Err(SandboxError::Workload { ref code, .. }) if code == "BAD_REQUEST"),
        "{:?}",
        r.result
    );
    // Input ends early (e.g. download failed).
    let r = run(&p, vec![0, 10], vec![(0, images[0].clone())], GpuMode::Off, limits(false)).await;
    assert!(matches!(r.result, Err(SandboxError::Workload { ref code, .. }) if code == "INPUT"), "{:?}", r.result);
    assert_eq!(r.items.len(), 1, "the finished image is still reported (checkpoint)");
}

#[tokio::test]
async fn resumes_with_only_the_missing_inputs() {
    let fx = fixtures();
    let images: Vec<_> = fx.iter().take(6).map(|f| f.0.clone()).collect();
    let p = params(&images, Accelerator::Cpu);
    // Indexes 0..=20 already in a checkpoint; only 30, 40, 50 are sent.
    let rest: Vec<_> = (3..6).map(|i| (i as u32 * 10, images[i].clone())).collect();
    let r = run(&p, vec![30, 40, 50], rest, GpuMode::Off, limits(false)).await;
    assert_eq!(r.result.unwrap()["processed"], 3);
    assert_eq!(r.items.iter().map(|i| i.index).collect::<Vec<_>>(), vec![30, 40, 50]);
    assert_eq!(r.items[0].label, fx[3].1);
}

#[tokio::test]
async fn tiny_memory_or_deadline_stop_the_batch() {
    let images: Vec<_> = fixtures().into_iter().take(1).map(|f| f.0).collect();
    let p = params(&images, Accelerator::Cpu);
    let (inputs, frames) = all(&p, &images);
    let mut l = limits(false);
    l.wasm_memory_bytes = 1 << 20; // module needs more than 1 MiB
    let r = run(&p, inputs.clone(), frames.clone(), GpuMode::Off, l).await;
    assert!(r.result.is_err(), "{:?}", r.result);

    // Nothing is ever sent: the sandbox waits for input until its deadline.
    let mut l = limits(false);
    l.deadline = Duration::from_millis(500);
    let t = std::time::Instant::now();
    let r = run(&p, inputs, vec![], GpuMode::Off, l).await;
    assert!(r.result.is_err());
    assert!(t.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn gpu_probe_returns_the_exact_checksum_the_server_expects() {
    let root = tempfile::tempdir().unwrap();
    let sb = Sandbox::new(EXE.into(), root.path().to_path_buf());
    let w = Workload::parse_local("gpu-probe", &serde_json::json!({ "size": 512, "maxIterations": 8 })).unwrap();
    let r = sb
        .run_with(&w, limits(true), Input { gpu: GpuMode::Any, ..Default::default() }, |_| {}, CancellationToken::new())
        .await;
    match r {
        // Same vector as control-plane/test/performance.test.ts.
        Ok(out) => {
            assert_eq!(out["checksum"], "213", "{out}");
            assert!(out["iterations"].as_u64().unwrap() >= 1);
        }
        Err(SandboxError::Workload { code, message }) => {
            assert_eq!(code, "GPU");
            eprintln!("no GPU adapter here: {message}");
        }
        Err(e) => panic!("{e}"),
    }
    // Owner does not share a GPU: refused.
    let off = sb.run_with(&w, limits(true), Input::default(), |_| {}, CancellationToken::new()).await;
    assert!(matches!(off, Err(SandboxError::Workload { ref code, .. }) if code == "GPU_OFF"), "{off:?}");
}
