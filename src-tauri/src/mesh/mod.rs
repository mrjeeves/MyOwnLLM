//! Cloud Mesh — peer-to-peer substrate for MyOwnLLM instances.
//!
//! Each running instance is a node in a user-scoped mesh. Nodes share
//! the same Network ID (a 256-bit rendezvous handle) and exchange
//! signed messages to form a self-organising graph for routing,
//! gossip, and direct data transfer over WebRTC.
//!
//! Identity, signing, and roster — historically owned by this
//! directory — now delegate to the
//! [`myownmesh-core`](https://github.com/mrjeeves/MyOwnMesh) crate.
//! The submodules below are thin re-exports of the substrate's API so
//! `commands.rs` and the Tauri handler list don't churn. The
//! substrate reads/writes `~/.myownllm/` via the `MYOWNMESH_HOME`
//! override set in `main.rs`, so existing user data
//! (`identity.json`, `mesh/rosters/*.json`) survives the migration
//! untouched.
//!
//! Submodule layout:
//!   - `identity`: re-exports of `myownmesh_core::identity` —
//!     `Identity`, `load_or_create`, `generate_network_id`,
//!     `normalize_network_id`, `set_label`.
//!   - `signing`: re-exports of `myownmesh_core::signing` —
//!     `sign`, `verify`, `pubkey_part`.
//!   - `roster`: re-exports of `myownmesh_core::roster` plus the
//!     local one-shot `migrate_legacy_if_present` that runs at
//!     startup to move pre-multi-network roster files into their
//!     per-network homes.
//!   - `commands`: Tauri commands exposed to the Svelte UI.

pub mod commands;
pub mod governance;
pub mod identity;
pub mod roster;
pub mod signing;
