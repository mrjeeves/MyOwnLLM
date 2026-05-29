//! ed25519 signing / verification — delegated to `myownmesh_core::signing`.
//!
//! Previously this file held the local `sign`/`verify`/`pubkey_part`
//! triad. The same functions now come from `myownmesh-core` so peers
//! talking myownmesh-protocol exchange byte-for-byte identical
//! signatures across the family of apps. The identity that backs
//! `sign()` is loaded via `myownmesh_core::identity::load_or_create`,
//! which reads `MYOWNMESH_HOME` — set to `~/.myownllm` in `main.rs`
//! — so the local Device ID is unchanged.

pub use myownmesh_core::signing::{sign, verify};
