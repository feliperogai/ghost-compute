//! Control-plane communication: HTTPS client, authentication, heartbeat loop.

pub mod api;
pub mod backoff;
pub mod client;
pub mod heartbeat;

pub use client::{ApiClient, ApiError};
