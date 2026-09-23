//! Storage test: sequential write (flushed to disk), sequential read, small synced writes.
//! Runs in the agent's own scratch directory with a fixed file name; nothing from the
//! network decides paths or contents.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Instant;

pub const SYNC_SAMPLES: u32 = 16;

pub struct StorageResult {
    pub bytes: u64,
    pub write_ms: u64,
    pub read_ms: u64,
    pub sync_ms: u64,
}

pub fn measure(dir: &Path, bytes: u64) -> std::io::Result<StorageResult> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("ghost-storage-test.bin");
    let res = run(&path, bytes);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir(dir); // only if empty
    res
}

fn run(path: &Path, bytes: u64) -> std::io::Result<StorageResult> {
    // Incompressible-ish data so filesystems cannot shortcut it.
    let chunk: Vec<u8> = super::stream::stream_bytes("ghost-storage", 1 << 20);
    let t = Instant::now();
    let mut f = std::fs::OpenOptions::new().create(true).truncate(true).read(true).write(true).open(path)?;
    let mut left = bytes;
    while left > 0 {
        let n = left.min(chunk.len() as u64) as usize;
        f.write_all(&chunk[..n])?;
        left -= n as u64;
    }
    f.sync_all()?;
    let write_ms = t.elapsed().as_millis().max(1) as u64;

    // Note: the OS page cache may serve part of this read; reported as measured.
    f.seek(SeekFrom::Start(0))?;
    let t = Instant::now();
    let mut buf = vec![0u8; 1 << 20];
    let mut read = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        read += n as u64;
    }
    let read_ms = t.elapsed().as_millis().max(1) as u64;
    if read != bytes {
        return Err(std::io::Error::other("short read"));
    }

    let t = Instant::now();
    for i in 0..SYNC_SAMPLES as u64 {
        f.seek(SeekFrom::Start(i * 4096))?;
        f.write_all(&chunk[..4096])?;
        f.sync_data()?;
    }
    let sync_ms = t.elapsed().as_millis() as u64;
    Ok(StorageResult { bytes, write_ms, read_ms, sync_ms })
}

#[cfg(test)]
mod tests {
    #[test]
    fn measures_and_cleans_up() {
        let d = tempfile::tempdir().unwrap();
        let r = super::measure(&d.path().join("calibration"), 4 << 20).unwrap();
        assert_eq!(r.bytes, 4 << 20);
        assert!(r.write_ms >= 1 && r.read_ms >= 1);
        assert_eq!(std::fs::read_dir(d.path()).unwrap().count(), 0);
    }
}
