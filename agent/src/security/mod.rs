//! Security primitives: TLS policy, secrets, device identity and credential storage.

pub mod confine;
pub mod credentials;
#[cfg(windows)]
mod dpapi;
pub mod identity;
pub mod secret;
pub mod tls;

pub use credentials::{CredentialStore, Credentials};
pub use identity::DeviceIdentity;
pub use secret::SecretString;
