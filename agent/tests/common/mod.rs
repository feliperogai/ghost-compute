#![allow(dead_code)]

use ghost_agent::configuration::ServerConfig;
use ghost_agent::security::{Credentials, SecretString};
use uuid::Uuid;

pub fn server_cfg(url: &str) -> ServerConfig {
    ServerConfig { url: url.into(), ca_cert: None, allow_insecure_localhost: true, request_timeout_secs: 5 }
}

pub fn creds(url: &str) -> Credentials {
    Credentials { server_url: url.into(), worker_id: Uuid::new_v4(), worker_secret: SecretString::new("ghw_secret") }
}
