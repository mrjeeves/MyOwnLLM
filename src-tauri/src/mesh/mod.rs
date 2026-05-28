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
//! substrate reads/writes `~/.myownllm/.myownmesh/` via the
//! `MYOWNMESH_HOME` override set in `main.rs`. Existing user data
//! (`identity.json`, `mesh/rosters/*.json`) lived at the LLM-parent
//! path (`~/.myownllm/.secrets/`, `~/.myownllm/mesh/rosters/`) up
//! through PR #205; the `migration` submodule's one-shot move
//! relocates them into the subdir on first launch after this PR so
//! existing users keep their pubkey + peer approvals.
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
//!   - `migration`: one-shot move of daemon-owned state into a
//!     dedicated subdir (`~/.myownllm/.myownmesh/`) so the
//!     daemon's `config.json` doesn't collide with the LLM's. Runs
//!     on the first launch after this isolation landed; idempotent
//!     thereafter.
//!   - `commands`: Tauri commands exposed to the Svelte UI.

pub mod commands;
pub mod daemon;
pub mod daemon_commands;
pub mod governance;
pub mod identity;
pub mod migration;
pub mod roster;
pub mod signing;
