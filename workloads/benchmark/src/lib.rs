//! `benchmark` workload. Runs inside Wasmtime with NO WASI: the only import is
//! `ghost.progress(f32)`. No clock, no files, no network, no environment,
//! no allocator. Output is a deterministic checksum; the host measures time.
//!
//! ABI: `run(kind, size, iterations, seed) -> i64 checksum`. Invalid arguments trap.
#![no_std]

use sha2::{Digest, Sha256};

#[link(wasm_import_module = "ghost")]
extern "C" {
    fn progress(fraction: f32);
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const KIND_HASH: i32 = 0;
const KIND_PRIMES: i32 = 1;
const KIND_MATMUL: i32 = 2;

/// Hard caps enforced again inside the module (the host validates first).
const MAX_ITERATIONS: i64 = 50_000_000;
const MAX_PRIME_LIMIT: i64 = 50_000_000;
const MAX_N: usize = 256;

fn report(done: i64, total: i64) {
    unsafe { progress(done as f32 / total.max(1) as f32) }
}

#[no_mangle]
pub extern "C" fn run(kind: i32, size: i64, iterations: i64, seed: i64) -> i64 {
    if iterations < 1 || iterations > MAX_ITERATIONS {
        core::arch::wasm32::unreachable()
    }
    let out = match kind {
        KIND_HASH => hash_chain(iterations, seed),
        KIND_PRIMES => primes(size, iterations),
        KIND_MATMUL => matmul(size, iterations, seed),
        _ => core::arch::wasm32::unreachable(),
    };
    unsafe { progress(1.0) };
    out
}

/// SHA-256 applied `iterations` times to a 32-byte state seeded from `seed`.
fn hash_chain(iterations: i64, seed: i64) -> i64 {
    let mut state = [0u8; 32];
    state[..8].copy_from_slice(&seed.to_le_bytes());
    let step = (iterations / 100).max(1);
    for i in 0..iterations {
        let next = Sha256::digest(state);
        state.copy_from_slice(&next);
        if i % step == 0 {
            report(i, iterations);
        }
    }
    i64::from_le_bytes([state[0], state[1], state[2], state[3], state[4], state[5], state[6], state[7]])
}

/// Counts primes ≤ `limit` with a segmented sieve (fixed 32 KiB segment), `iterations` times.
fn primes(limit: i64, iterations: i64) -> i64 {
    if !(2..=MAX_PRIME_LIMIT).contains(&limit) {
        core::arch::wasm32::unreachable()
    }
    static mut BASE: [u32; 1024] = [0; 1024]; // primes ≤ sqrt(50e6) ≈ 7071 (there are 900)
    static mut SEG: [bool; 32768] = [false; 32768];
    let base = unsafe { &mut *core::ptr::addr_of_mut!(BASE) };
    let seg = unsafe { &mut *core::ptr::addr_of_mut!(SEG) };
    let limit = limit as u64;
    let root = isqrt(limit);

    let mut nbase = 0;
    let mut k = 2u64;
    while k <= root {
        if (2..k).take_while(|d| d * d <= k).all(|d| k % d != 0) {
            base[nbase] = k as u32;
            nbase += 1;
        }
        k += 1;
    }

    let mut count = 0i64;
    for it in 0..iterations {
        count = 0;
        let mut low = 2u64;
        while low <= limit {
            let high = (low + seg.len() as u64 - 1).min(limit);
            seg.iter_mut().for_each(|x| *x = true);
            for &p in &base[..nbase] {
                let p = p as u64;
                let mut m = ((low + p - 1) / p * p).max(p * p);
                while m <= high {
                    seg[(m - low) as usize] = false;
                    m += p;
                }
            }
            count += seg[..(high - low + 1) as usize].iter().filter(|x| **x).count() as i64;
            low = high + 1;
        }
        report(it + 1, iterations);
    }
    count
}

fn isqrt(n: u64) -> u64 {
    let mut r = 0u64;
    while (r + 1) * (r + 1) <= n {
        r += 1;
    }
    r
}

/// n×n f64 matrix product repeated `iterations` times; checksum = bits of the trace sum.
fn matmul(n: i64, iterations: i64, seed: i64) -> i64 {
    if !(1..=MAX_N as i64).contains(&n) {
        core::arch::wasm32::unreachable()
    }
    static mut A: [f64; MAX_N * MAX_N] = [0.0; MAX_N * MAX_N];
    static mut B: [f64; MAX_N * MAX_N] = [0.0; MAX_N * MAX_N];
    static mut C: [f64; MAX_N * MAX_N] = [0.0; MAX_N * MAX_N];
    let (a, b, c) = unsafe {
        (&mut *core::ptr::addr_of_mut!(A), &mut *core::ptr::addr_of_mut!(B), &mut *core::ptr::addr_of_mut!(C))
    };
    let n = n as usize;
    let mut x = (seed as u64) | 1;
    let mut rnd = || {
        // xorshift64*
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    };
    for i in 0..n * n {
        a[i] = rnd();
        b[i] = rnd();
    }
    let mut acc = 0.0f64;
    for it in 0..iterations {
        for i in 0..n {
            for j in 0..n {
                let mut s = 0.0;
                for k in 0..n {
                    s += a[i * n + k] * b[k * n + j];
                }
                c[i * n + j] = s;
            }
        }
        for i in 0..n {
            acc += c[i * n + i];
        }
        report(it + 1, iterations);
    }
    acc.to_bits() as i64
}
