//! DXGI adapter enumeration.

use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND, IDXGIFactory1,
};

use super::gpu::{Gpu, vendor_name};

pub fn dxgi_adapters() -> windows::core::Result<Vec<Gpu>> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    let mut out = Vec::new();
    for i in 0.. {
        let adapter = match unsafe { factory.EnumAdapters1(i) } {
            Ok(a) => a,
            Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(e) => return Err(e),
        };
        let desc = unsafe { adapter.GetDesc1()? };
        // Skip "Microsoft Basic Render Driver" and other software rasterizers.
        if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
            continue;
        }
        let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
        let name = String::from_utf16_lossy(&desc.Description[..len]).trim().to_string();
        let vram = desc.DedicatedVideoMemory as u64 / (1024 * 1024);
        out.push(Gpu {
            name: super::truncate(name, 200),
            vendor: vendor_name(desc.VendorId).map(String::from),
            vram_mb: (vram > 0).then_some(vram),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    /// Real Windows: adapters have names. Headless environments (Wine, some VMs)
    /// may have no DXGI: inventory must then degrade to an empty list, not fail.
    #[test]
    fn dxgi_enumeration_or_graceful_fallback() {
        match super::dxgi_adapters() {
            Ok(gpus) => assert!(gpus.iter().all(|g| !g.name.is_empty())),
            Err(_) => assert!(super::super::gpu::detect().is_empty()),
        }
    }
}
