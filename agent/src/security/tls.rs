//! TLS policy: rustls (no OpenSSL), TLS 1.2+ only, optional CA pinning.

use std::{io::BufReader, path::Path, sync::Arc};

use rustls::{ClientConfig, RootCertStore};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("cannot read CA file {0}: {1}")]
    Read(String, std::io::Error),
    #[error("CA file {0} contains no certificates")]
    Empty(String),
    #[error("invalid CA certificate: {0}")]
    Invalid(#[from] rustls::Error),
}

/// Builds the client TLS config.
/// - `pinned_ca = Some(path)`: trust ONLY the CAs in that PEM file.
/// - `None`: trust the Mozilla root set bundled in the binary (not the OS store).
pub fn client_config(pinned_ca: Option<&Path>) -> Result<ClientConfig, TlsError> {
    let mut roots = RootCertStore::empty();
    match pinned_ca {
        Some(path) => {
            let shown = path.display().to_string();
            let file = std::fs::File::open(path).map_err(|e| TlsError::Read(shown.clone(), e))?;
            let certs = rustls_pemfile::certs(&mut BufReader::new(file))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| TlsError::Read(shown.clone(), e))?;
            if certs.is_empty() {
                return Err(TlsError::Empty(shown));
            }
            for c in certs {
                roots.add(c)?;
            }
        }
        None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])?
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(cfg)
}

pub fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_detection() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        assert!(is_loopback(&u("http://localhost:8080")));
        assert!(is_loopback(&u("http://127.0.0.1")));
        assert!(is_loopback(&u("http://[::1]:1")));
        assert!(!is_loopback(&u("http://10.0.0.1")));
        assert!(!is_loopback(&u("http://localhost.evil.com")));
    }

    #[test]
    fn default_config_uses_public_roots() {
        let cfg = client_config(None).unwrap();
        assert_eq!(cfg.alpn_protocols.len(), 2);
    }

    #[test]
    fn rejects_empty_or_missing_ca() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("ca.pem");
        std::fs::write(&empty, "").unwrap();
        assert!(matches!(client_config(Some(&empty)), Err(TlsError::Empty(_))));
        assert!(matches!(client_config(Some(&dir.path().join("nope.pem"))), Err(TlsError::Read(..))));
    }
}
