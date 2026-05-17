//! Cloud Mesh — peer-to-peer substrate for MyOwnLLM instances.
//!
//! Each running instance is a node in a user-scoped mesh. Nodes share
//! the same Network ID (a 256-bit rendezvous handle) and exchange
//! signed messages to form a self-organising graph for routing,
//! gossip, and direct data transfer over WebRTC.
//!
//! This module is the entry point. Today it owns:
//!   - `identity`: the long-lived ed25519 keypair persisted under
//!     `~/.myownllm/.secrets/identity.json` (anchor file). Reused
//!     across launches as the device's permanent identifier.
//!   - `commands`: Tauri commands exposed to the Svelte UI for the
//!     Cloud Mesh settings tab (identity readout, Network ID
//!     generation).
//!
//! Future submodules — signaling, peers, roster CRDT, catalog
//! gossip, Move RPC — slot in beside these without touching the
//! existing surface.

pub mod commands;
pub mod identity;
