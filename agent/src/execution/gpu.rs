//! GPU path for `image-inference`: the dense layers only, with our fixed WGSL shader.
//!
//! Runs inside the sandbox process. Nothing from the job reaches the GPU except the
//! 64-float feature vectors produced by the WebAssembly preprocessor; the shader and
//! the weights (read from the hash-pinned module) are ours. Any failure → CPU fallback.

use wgpu::util::DeviceExt;

use super::inference::{CLASSES, INPUT, Weights};

const NVIDIA: u32 = 0x10DE;
const WORKGROUP: u32 = 64;

const SHADER: &str = r#"
struct Dims { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> w: array<f32>;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> dims: Dims;

const IN: u32 = 64u;
const HID: u32 = 128u;
const OUT: u32 = 10u;
const B1: u32 = 8192u;   // IN * HID
const W2: u32 = 8320u;   // B1 + HID
const B2: u32 = 9600u;   // W2 + HID * OUT

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let s = gid.x;
    if (s >= dims.n) { return; }
    var z: array<f32, 10>;
    for (var k = 0u; k < OUT; k++) { z[k] = w[B2 + k]; }
    for (var j = 0u; j < HID; j++) {
        var h = w[B1 + j];
        for (var i = 0u; i < IN; i++) { h += x[s * IN + i] * w[i * HID + j]; }
        h = max(h, 0.0);
        for (var k = 0u; k < OUT; k++) { z[k] += h * w[W2 + j * OUT + k]; }
    }
    for (var k = 0u; k < OUT; k++) { y[s * OUT + k] = z[k]; }
}
"#;

pub struct Dense {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    weights: wgpu::Buffer,
    /// e.g. "NVIDIA GeForce RTX 3060 (Dx12)".
    pub device_name: String,
    pub vendor_nvidia: bool,
}

/// Picks the adapter (NVIDIA first) and opens a device.
/// `allow_software`: accept CPU-emulated adapters (tests only; production wants real GPUs).
fn open_device(allow_software: bool) -> Result<(wgpu::Device, wgpu::Queue, wgpu::AdapterInfo), String> {
    let backends = wgpu::Backends::DX12 | wgpu::Backends::VULKAN;
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    desc.backends = backends;
    let instance = wgpu::Instance::new(desc);
    let mut adapters: Vec<_> = pollster::block_on(instance.enumerate_adapters(backends))
        .into_iter()
        .filter(|a| allow_software || a.get_info().device_type != wgpu::DeviceType::Cpu)
        .collect();
    // NVIDIA first, then discrete, then integrated, then anything else allowed.
    adapters.sort_by_key(|a| {
        let i = a.get_info();
        let rank = match i.device_type {
            wgpu::DeviceType::DiscreteGpu => 0,
            wgpu::DeviceType::IntegratedGpu => 1,
            wgpu::DeviceType::VirtualGpu => 2,
            _ => 3,
        };
        (i.vendor != NVIDIA, rank)
    });
    let adapter = adapters.into_iter().next().ok_or("no usable GPU adapter")?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("ghost"),
        required_limits: wgpu::Limits::downlevel_defaults(),
        ..Default::default()
    }))
    .map_err(|e| format!("request device: {e}"))?;
    Ok((device, queue, info))
}

fn device_name(info: &wgpu::AdapterInfo) -> String {
    format!("{} ({:?})", info.name.chars().take(80).collect::<String>(), info.backend)
}

impl Dense {
    pub fn new(weights: &Weights, allow_software: bool) -> Result<Self, String> {
        let (device, queue, info) = open_device(allow_software)?;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dense"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("dense"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        let weights = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("weights"),
            contents: bytemuck::cast_slice(&weights.packed),
            usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self {
            device,
            queue,
            pipeline,
            weights,
            device_name: device_name(&info),
            vendor_nvidia: info.vendor == NVIDIA,
        })
    }

    /// Logits for each input vector.
    pub fn logits(&self, xs: &[[f32; INPUT]]) -> Result<Vec<[f32; CLASSES]>, String> {
        if xs.is_empty() {
            return Ok(vec![]);
        }
        let n = xs.len() as u32;
        let flat: Vec<f32> = xs.iter().flatten().copied().collect();
        let out_bytes = (xs.len() * CLASSES * 4) as u64;
        let d = &self.device;
        let x = d.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("x"),
            contents: bytemuck::cast_slice(&flat),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let dims = d.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("dims"),
            contents: bytemuck::cast_slice(&[n, 0, 0, 0]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let y = d.create_buffer(&wgpu::BufferDescriptor {
            label: Some("y"),
            size: out_bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let staging = d.create_buffer(&wgpu::BufferDescriptor {
            label: Some("staging"),
            size: out_bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("dense"),
            layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.weights.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: x.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: y.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: dims.as_entire_binding() },
            ],
        });
        let mut enc = d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("dense") });
        {
            let mut pass =
                enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("dense"), timestamp_writes: None });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind, &[]);
            pass.dispatch_workgroups(n.div_ceil(WORKGROUP), 1, 1);
        }
        enc.copy_buffer_to_buffer(&y, 0, &staging, 0, out_bytes);
        self.queue.submit([enc.finish()]);

        let (tx, rx) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        d.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e}"))?;
        rx.recv().map_err(|_| "map callback dropped".to_string())?.map_err(|e| format!("map: {e}"))?;
        let data = staging.slice(..).get_mapped_range().map_err(|e| format!("map range: {e}"))?;
        let vals: &[f32] = bytemuck::cast_slice(&data);
        let out = vals.as_chunks::<CLASSES>().0.to_vec();
        drop(data);
        staging.unmap();
        Ok(out)
    }
}

// ---- calibration probe ------------------------------------------------------------------

const MATMUL: &str = r#"
struct Dims { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> dims: Dims;
var<workgroup> ta: array<array<f32, 16>, 16>;
var<workgroup> tb: array<array<f32, 16>, 16>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
    let n = dims.n;
    var acc = 0.0;
    for (var t = 0u; t < n; t += 16u) {
        ta[l.y][l.x] = a[g.y * n + t + l.x];
        tb[l.y][l.x] = b[(t + l.y) * n + g.x];
        workgroupBarrier();
        for (var k = 0u; k < 16u; k++) { acc += ta[l.y][k] * tb[k][l.x]; }
        workgroupBarrier();
    }
    c[g.y * n + g.x] = acc;
}
"#;

pub struct MatmulProbe {
    pub device: String,
    pub nvidia: bool,
    pub iterations: u32,
    pub elapsed: std::time::Duration,
    /// Σ C[i][j]·(((31i + j) mod 17) + 1); exact (small integers in f32).
    pub checksum: i64,
}

/// Inputs of the probe; the control plane computes the same checksum.
pub fn probe_inputs(n: usize) -> (Vec<f32>, Vec<f32>) {
    let mut a = vec![0f32; n * n];
    let mut b = vec![0f32; n * n];
    for i in 0..n {
        for k in 0..n {
            a[i * n + k] = ((i + k) % 7) as f32 - 3.0;
            b[i * n + k] = ((i * k) % 5) as f32 - 2.0;
        }
    }
    (a, b)
}

pub fn probe_checksum(c: &[f32], n: usize) -> i64 {
    let mut s = 0i64;
    for i in 0..n {
        for j in 0..n {
            s += c[i * n + j].round() as i64 * (((31 * i + j) % 17) + 1) as i64;
        }
    }
    s
}

/// Repeats an n×n product until `target` has passed or `max_iterations` ran.
pub fn matmul_probe(
    n: u32,
    max_iterations: u32,
    target: std::time::Duration,
    allow_software: bool,
) -> Result<MatmulProbe, String> {
    use std::time::{Duration, Instant};
    let (d, queue, info) = open_device(allow_software)?;
    let nn = n as usize;
    let (a, b) = probe_inputs(nn);
    let bytes = (nn * nn * 4) as u64;
    let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("matmul"),
        source: wgpu::ShaderSource::Wgsl(MATMUL.into()),
    });
    let pipeline = d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("matmul"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let init = |label, data: &[f32]| {
        d.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: bytemuck::cast_slice(data),
            usage: wgpu::BufferUsages::STORAGE,
        })
    };
    let (ba, bb) = (init("a", &a), init("b", &b));
    let bc = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("c"),
        size: bytes,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let dims = d.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("dims"),
        contents: bytemuck::cast_slice(&[n, 0, 0, 0]),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("matmul"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: ba.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: bb.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: bc.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: dims.as_entire_binding() },
        ],
    });
    let run = |k: u32| -> Result<Duration, String> {
        let t = Instant::now();
        let mut enc = d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("matmul") });
        {
            let mut pass =
                enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("matmul"), timestamp_writes: None });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &bind, &[]);
            for _ in 0..k {
                pass.dispatch_workgroups(n / 16, n / 16, 1);
            }
        }
        queue.submit([enc.finish()]);
        d.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e}"))?;
        Ok(t.elapsed())
    };
    run(1)?; // warm-up: pipeline compile, first allocation
    let (mut total, mut elapsed, mut k) = (0u32, Duration::ZERO, 1u32);
    while total < max_iterations && elapsed < target {
        let k_now = k.min(max_iterations - total);
        elapsed += run(k_now)?;
        total += k_now;
        k = k.saturating_mul(2);
    }

    let staging = d.create_buffer(&wgpu::BufferDescriptor {
        label: Some("staging"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut enc = d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("readback") });
    enc.copy_buffer_to_buffer(&bc, 0, &staging, 0, bytes);
    queue.submit([enc.finish()]);
    let (tx, rx) = std::sync::mpsc::channel();
    staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
        let _ = tx.send(r);
    });
    d.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| format!("poll: {e}"))?;
    rx.recv().map_err(|_| "map callback dropped".to_string())?.map_err(|e| format!("map: {e}"))?;
    let data = staging.slice(..).get_mapped_range().map_err(|e| format!("map range: {e}"))?;
    let checksum = probe_checksum(bytemuck::cast_slice(&data), nn);
    drop(data);
    staging.unmap();
    Ok(MatmulProbe { device: device_name(&info), nvidia: info.vendor == NVIDIA, iterations: total, elapsed, checksum })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads a GPU buffer back to the CPU (test helper).
    fn read_back(d: &wgpu::Device, q: &wgpu::Queue, src: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
        let staging = d.create_buffer(&wgpu::BufferDescriptor {
            label: Some("t-staging"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = d.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
        enc.copy_buffer_to_buffer(src, 0, &staging, 0, bytes);
        q.submit([enc.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        staging.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        d.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();
        let v = staging.slice(..).get_mapped_range().unwrap().to_vec();
        staging.unmap();
        v
    }

    /// GPU memory is not wiped by the hardware between users. A job must never read what
    /// an earlier job left in VRAM: every buffer we allocate starts zeroed (wgpu's
    /// zero-initialization), within one device and across devices (each job runs in its
    /// own sandbox process with its own device).
    #[test]
    fn fresh_gpu_buffers_never_expose_earlier_data() {
        let Ok((d, q, info)) = open_device(true) else {
            eprintln!("no GPU adapter: skipped");
            return;
        };
        let bytes: u64 = 1 << 20;
        let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST;
        let secret = vec![0xABu8; bytes as usize];
        for _ in 0..4 {
            let b = d.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("secret"),
                contents: &secret,
                usage,
            });
            assert!(read_back(&d, &q, &b, bytes).iter().all(|&x| x == 0xAB), "setup: pattern not written");
            drop(b);
            d.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            let fresh = d.create_buffer(&wgpu::BufferDescriptor {
                label: Some("fresh"),
                size: bytes,
                usage,
                mapped_at_creation: false,
            });
            assert!(
                read_back(&d, &q, &fresh, bytes).iter().all(|&x| x == 0),
                "fresh buffer exposed old data on {}",
                info.name
            );
        }
        drop(d);
        drop(q);
        let (d2, q2, _) = open_device(true).unwrap();
        let fresh = d2.create_buffer(&wgpu::BufferDescriptor {
            label: Some("fresh-2"),
            size: bytes,
            usage,
            mapped_at_creation: false,
        });
        assert!(read_back(&d2, &q2, &fresh, bytes).iter().all(|&x| x == 0), "new device exposed old data");
    }

    #[test]
    fn probe_checksum_matches_the_control_plane_vector() {
        // Reference on the CPU; the control plane expects -920 for n = 64.
        let n = 64;
        let (a, b) = probe_inputs(n);
        let mut c = vec![0f32; n * n];
        for i in 0..n {
            for k in 0..n {
                for j in 0..n {
                    c[i * n + j] += a[i * n + k] * b[k * n + j];
                }
            }
        }
        assert_eq!(probe_checksum(&c, n), -920);
    }
}
