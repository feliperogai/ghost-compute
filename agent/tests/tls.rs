//! Real TLS handshakes: CA pinning accepts our CA and rejects everything else.

use std::sync::Arc;

use ghost_agent::configuration::ServerConfig;
use ghost_agent::networking::{ApiClient, ApiError};
use ghost_agent::security::{Credentials, SecretString};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::rustls::{self, pki_types::PrivateKeyDer};
use uuid::Uuid;

struct Pki {
    ca_pem: String,
    server: rustls::ServerConfig,
}

fn pki() -> Pki {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca_cert = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);

    let leaf_key = KeyPair::generate().unwrap();
    let leaf = CertificateParams::new(vec!["localhost".to_string()]).unwrap().signed_by(&leaf_key, &issuer).unwrap();

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone(), ca_cert.der().clone()],
            PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap(),
        )
        .unwrap();
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    Pki { ca_pem: ca_cert.pem(), server }
}

/// Minimal HTTPS server answering every request with a heartbeat-like JSON body.
async fn serve(cfg: rustls::ServerConfig) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { return };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                let mut buf = vec![0u8; 8192];
                let _ = tls.read(&mut buf).await;
                let body = r#"{"accessToken":"v1.t","expiresIn":900}"#;
                let res = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(res.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    port
}

fn client(port: u16, ca: Option<std::path::PathBuf>) -> ApiClient {
    let url = format!("https://localhost:{port}");
    let cfg = ServerConfig { url: url.clone(), ca_cert: ca, allow_insecure_localhost: false, request_timeout_secs: 5 };
    let creds = Credentials { server_url: url, worker_id: Uuid::new_v4(), worker_secret: SecretString::new("ghw_x") };
    ApiClient::new(&cfg, Some(creds)).unwrap()
}

fn write_pem(dir: &tempfile::TempDir, name: &str, pem: &str) -> std::path::PathBuf {
    let p = dir.path().join(name);
    std::fs::write(&p, pem).unwrap();
    p
}

#[tokio::test]
async fn pinned_ca_is_trusted() {
    let pki = pki();
    let port = serve(pki.server).await;
    let dir = tempfile::tempdir().unwrap();
    let c = client(port, Some(write_pem(&dir, "ca.pem", &pki.ca_pem)));
    // `me` authenticates first; our server answers every path with 200 JSON.
    c.me().await.expect("TLS handshake with pinned CA should succeed");
}

#[tokio::test]
async fn other_ca_is_rejected() {
    let pki_a = pki();
    let pki_b = pki();
    let port = serve(pki_a.server).await;
    let dir = tempfile::tempdir().unwrap();
    let c = client(port, Some(write_pem(&dir, "other.pem", &pki_b.ca_pem)));
    assert!(matches!(c.me().await, Err(ApiError::Network(_))));
}

#[tokio::test]
async fn private_ca_is_not_trusted_by_default() {
    let pki = pki();
    let port = serve(pki.server).await;
    assert!(matches!(client(port, None).me().await, Err(ApiError::Network(_))));
}
