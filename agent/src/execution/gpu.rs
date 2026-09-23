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

impl Dense {
    /// `allow_software`: accept CPU-emulated adapters (tests only; production wants real GPUs).
    pub fn new(weights: &Weights, allow_software: bool) -> Result<Self, String> {
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
            label: Some("ghost-inference"),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        }))
        .map_err(|e| format!("request device: {e}"))?;

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
            device_name: format!("{} ({:?})", info.name.chars().take(80).collect::<String>(), info.backend),
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
        let out = vals.chunks_exact(CLASSES).map(|c| c.try_into().unwrap()).collect();
        drop(data);
        staging.unmap();
        Ok(out)
    }
}
