//! Windows DPAPI wrappers (machine scope).

use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

const ENTROPY: &[u8] = b"ghost-agent/credentials/v1";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
}

unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as _)));
    }
    v
}

pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = blob(data);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            None,
            Some(&entropy),
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| e.to_string())?;
        Ok(take(out))
    }
}

pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = blob(data);
    let entropy = blob(ENTROPY);
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| e.to_string())?;
        Ok(take(out))
    }
}
