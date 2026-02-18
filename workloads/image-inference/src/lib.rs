//! `image-inference` workload: classifies images with a small embedded MLP.
//!
//! Runs inside Wasmtime with no imports at all: no files, network, clock or
//! environment. The host copies image bytes into this module's memory; the module
//! decodes (PNG/JPEG only, bounded dimensions and allocations), preprocesses and
//! classifies. Untrusted image parsing therefore happens inside the sandbox.
//!
//! ABI (all offsets are into this module's linear memory):
//! - `alloc(len) -> ptr`, `dealloc(ptr, len)`
//! - `preprocess(img_ptr, img_len, out_ptr) -> status`   writes 64 f32 (8x8, 0..1)
//! - `forward(in_ptr, out_ptr)`                           64 f32 → 10 f32 probabilities
//! - `model_ptr() / model_len()`                          raw weights (for the host GPU path)
//!
//! Status codes: 0 ok, -1 unsupported format, -2 decode error, -3 image too large.

use std::io::Cursor;

use image::{ImageFormat, ImageReader, Limits};

pub const INPUT: usize = 64;
pub const HIDDEN: usize = 128;
pub const CLASSES: usize = 10;
pub const MAX_DIM: u32 = 4096;

static MODEL: &[u8] = include_bytes!("../model/digits-mlp.bin");
const HEADER: usize = 8 + 12;

fn weights() -> &'static [f32] {
    // Header: "GHMLP1\0\0" + 3×u32 dims, then f32 LE. wasm32 is little-endian;
    // include_bytes gives no alignment guarantee, so copy once into an aligned Vec.
    static mut CACHE: Option<Vec<f32>> = None;
    unsafe {
        let c = &mut *core::ptr::addr_of_mut!(CACHE);
        c.get_or_insert_with(|| {
            MODEL[HEADER..].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect()
        })
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    let mut v = vec![0u8; len.max(0) as usize];
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p as i32
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: i32, len: i32) {
    if ptr != 0 && len > 0 {
        unsafe { drop(Vec::from_raw_parts(ptr as *mut u8, len as usize, len as usize)) }
    }
}

#[no_mangle]
pub extern "C" fn model_ptr() -> i32 {
    MODEL.as_ptr() as i32
}

#[no_mangle]
pub extern "C" fn model_len() -> i32 {
    MODEL.len() as i32
}

/// Decodes and reduces an image to the model's 8x8 input.
pub fn preprocess_bytes(bytes: &[u8]) -> Result<[f32; INPUT], i32> {
    let format = match image::guess_format(bytes) {
        Ok(f @ (ImageFormat::Png | ImageFormat::Jpeg)) => f,
        _ => return Err(-1),
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIM);
    limits.max_image_height = Some(MAX_DIM);
    limits.max_alloc = Some(64 << 20);
    reader.limits(limits);
    let img = match reader.decode() {
        Ok(i) => i,
        Err(image::ImageError::Limits(_)) => return Err(-3),
        Err(_) => return Err(-2),
    };
    let g = img.to_luma8();
    let (w, h) = g.dimensions();
    if w == 0 || h == 0 {
        return Err(-2);
    }
    let px = g.as_raw();
    // Dark ink on light paper is the common case; the model expects bright ink.
    let mean = px.iter().map(|&p| p as u64).sum::<u64>() as f64 / px.len() as f64;
    let invert = mean > 127.0;
    let mut out = [0f32; INPUT];
    for cy in 0..8u32 {
        for cx in 0..8u32 {
            // Area average over the block (integer bounds cover the whole image).
            let (x0, x1) = (cx * w / 8, ((cx + 1) * w / 8).max(cx * w / 8 + 1));
            let (y0, y1) = (cy * h / 8, ((cy + 1) * h / 8).max(cy * h / 8 + 1));
            let mut sum = 0u64;
            let mut n = 0u64;
            for y in y0..y1.min(h) {
                for x in x0..x1.min(w) {
                    let v = px[(y * w + x) as usize];
                    sum += if invert { 255 - v } else { v } as u64;
                    n += 1;
                }
            }
            out[(cy * 8 + cx) as usize] = if n == 0 { 0.0 } else { sum as f32 / n as f32 / 255.0 };
        }
    }
    Ok(out)
}

/// MLP forward pass: 64 → 128 (ReLU) → 10 (softmax).
pub fn forward_vec(x: &[f32; INPUT]) -> [f32; CLASSES] {
    let w = weights();
    let (w1, rest) = w.split_at(INPUT * HIDDEN);
    let (b1, rest) = rest.split_at(HIDDEN);
    let (w2, b2) = rest.split_at(HIDDEN * CLASSES);
    let mut hid = [0f32; HIDDEN];
    for j in 0..HIDDEN {
        let mut s = b1[j];
        for i in 0..INPUT {
            s += x[i] * w1[i * HIDDEN + j];
        }
        hid[j] = s.max(0.0);
    }
    let mut z = [0f32; CLASSES];
    for k in 0..CLASSES {
        let mut s = b2[k];
        for j in 0..HIDDEN {
            s += hid[j] * w2[j * CLASSES + k];
        }
        z[k] = s;
    }
    softmax(z)
}

pub fn softmax(mut z: [f32; CLASSES]) -> [f32; CLASSES] {
    let m = z.iter().cloned().fold(f32::MIN, f32::max);
    let mut sum = 0.0;
    for v in z.iter_mut() {
        *v = (*v - m).exp();
        sum += *v;
    }
    for v in z.iter_mut() {
        *v /= sum;
    }
    z
}

#[no_mangle]
pub extern "C" fn preprocess(img_ptr: i32, img_len: i32, out_ptr: i32) -> i32 {
    let bytes = unsafe { std::slice::from_raw_parts(img_ptr as *const u8, img_len.max(0) as usize) };
    match preprocess_bytes(bytes) {
        Ok(v) => {
            let out = unsafe { std::slice::from_raw_parts_mut(out_ptr as *mut f32, INPUT) };
            out.copy_from_slice(&v);
            0
        }
        Err(code) => code,
    }
}

#[no_mangle]
pub extern "C" fn forward(in_ptr: i32, out_ptr: i32) {
    let x: [f32; INPUT] = unsafe { std::slice::from_raw_parts(in_ptr as *const f32, INPUT) }.try_into().unwrap();
    let p = forward_vec(&x);
    unsafe { std::slice::from_raw_parts_mut(out_ptr as *mut f32, CLASSES) }.copy_from_slice(&p);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_out_accuracy_matches_training_report() {
        let raw = include_bytes!("../testdata/digits-test.bin");
        let (mut ok, mut n) = (0, 0);
        for rec in raw.chunks_exact(65) {
            let mut x = [0f32; INPUT];
            for i in 0..INPUT {
                x[i] = rec[i] as f32 / 16.0;
            }
            let p = forward_vec(&x);
            let pred = (0..CLASSES).max_by(|a, b| p[*a].total_cmp(&p[*b])).unwrap();
            ok += (pred == rec[64] as usize) as u32;
            n += 1;
        }
        let acc = ok as f32 / n as f32;
        assert!(acc > 0.97, "accuracy {acc}");
    }

    #[test]
    fn png_and_jpeg_fixtures_classify_correctly() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata");
        let mut checked = 0;
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let Some(label) = name.split("label").nth(1).and_then(|s| s.chars().next()) else { continue };
            let x = preprocess_bytes(&std::fs::read(&p).unwrap()).unwrap();
            let probs = forward_vec(&x);
            let pred = (0..CLASSES).max_by(|a, b| probs[*a].total_cmp(&probs[*b])).unwrap();
            assert_eq!(pred.to_string(), label.to_string(), "{name}");
            checked += 1;
        }
        assert_eq!(checked, 24);
    }

    #[test]
    fn rejects_non_images_and_oversized_images() {
        assert_eq!(preprocess_bytes(b"MZ\x90\x00 not an image"), Err(-1));
        assert_eq!(preprocess_bytes(b"GIF89a....."), Err(-1));
        assert_eq!(preprocess_bytes(b"\x89PNG\r\n\x1a\n truncated"), Err(-2));
        // A valid PNG header claiming 100000x100000 pixels.
        let mut bomb = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bomb);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&100_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 0, 0, 0, 0]);
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(&ihdr);
        png.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        assert_eq!(preprocess_bytes(&png), Err(-3));
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut c = 0xFFFF_FFFFu32;
        for &b in data {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
}
