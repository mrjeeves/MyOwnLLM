//! Long-lived device identity — delegated to `myownmesh_core::identity`.
//!
//! Previously this file held a standalone copy of the identity logic
//! (anchor file at `~/.myownllm/.secrets/identity.json`, base32 device
//! IDs, network-id helpers). The same code now lives in
//! `myownmesh-core` so other apps in the family can share the
//! substrate. `MYOWNMESH_HOME` is set to `~/.myownllm` in `main.rs`
//! before any mesh call, so the on-disk paths the substrate reads and
//! writes are identical to what MyOwnLLM has shipped for the past
//! several releases — no data migration, no orphaned identities.
//!
//! Surface kept compatible with the previous local module so
//! `mesh/commands.rs` doesn't change shape: `load_or_create`,
//! `generate_network_id`, `normalize_network_id`, `set_label` are
//! re-exported as-is; the `Identity` struct is re-exported too. Tests
//! for these symbols live with the upstream implementation in
//! `myownmesh-core` and aren't duplicated here.

pub use myownmesh_core::identity::{
    generate_network_id, load_or_create, normalize_network_id, set_label,
};
