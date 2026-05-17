//! Long-lived device identity for the Cloud Mesh.
//!
//! On first use, an ed25519 keypair is generated and persisted to
//! `~/.myownllm/.secrets/identity.json`. The directory is created with
//! 0700 and the file with 0600 on Unix so the secret key isn't
//! world-readable. Subsequent launches reload the same identity — this
//! pubkey is the device's permanent identifier across mesh joins,
//! restarts, and network ID changes.
//!
//! Encoding: pubkey and Network ID are surfaced as RFC-4648 base32
//! lowercase, no padding. A 32-byte ed25519 pubkey is 52 chars, which
//! is short enough to read aloud and case-insensitive on copy-paste.

use std::path::PathBuf;

use anyhow::{Context, Result};
use data_encoding::BASE32_NOPAD;
use ed25519_dalek::{SigningKey, VerifyingKey, SECRET_KEY_LENGTH};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

const ANCHOR_VERSION: u32 = 1;

/// On-disk anchor file format. We keep the secret key inline for v1 —
/// it never leaves the local disk and the file is mode 0600. A future
/// migration can swap to an OS keychain without changing the public
/// API of this module.
#[derive(Debug, Serialize, Deserialize)]
struct Anchor {
    version: u32,
    created_at: String,
    /// 32-byte ed25519 secret seed, base32-lowercase, no padding.
    secret_key: String,
    /// 32-byte ed25519 public key, base32-lowercase, no padding.
    /// Redundant (derivable from `secret_key`) but stored so a
    /// reader can show the Device ID without touching the secret.
    public_key: String,
    /// Optional human-readable label. Free-form; the user can edit
    /// it from the Cloud Mesh settings tab. Empty by default — the
    /// UI falls back to a truncated Device ID when this is empty.
    label: String,
}

/// In-memory view of the device's identity. Holds the secret key for
/// signing operations and a precomputed encoded public key for cheap
/// display.
pub struct Identity {
    signing_key: SigningKey,
    public_id: String,
    label: String,
}

impl Identity {
    /// Base32-lowercase encoding of the public key. This is the
    /// cryptographic identifier used on the wire — peers compare
    /// pubkeys by this value. Stable across launches.
    pub fn public_id(&self) -> &str {
        &self.public_id
    }

    /// Display form of the Device ID surfaced in the UI: the
    /// public-key body, a dash, and a deterministic 5-char
    /// alphanumeric tag. The tag (sha256 of the pubkey, first 5
    /// bytes mapped into `[a-z0-9]`) makes instances easier to pick
    /// out at a glance in a peers list — the same device always
    /// shows the same tail. Display-only; the protocol still talks
    /// `public_id()`.
    pub fn display_id(&self) -> String {
        let suffix = display_suffix(self.signing_key.verifying_key().as_bytes());
        format!("{}-{}", self.public_id(), suffix)
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    #[allow(dead_code)]
    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_key.verifying_key()
    }

    #[allow(dead_code)]
    pub fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }
}

/// Derive a 5-char human-recognizable tag from a public key. Maps
/// 5 bytes of the pubkey's sha256 into `[a-z0-9]` — 36^5 = 60M
/// distinct tags is plenty for eyeball-disambiguation in a peers
/// list. Modulo-bias is irrelevant here (this is a display tag, not
/// a security primitive).
fn display_suffix(pubkey_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut hasher = Sha256::new();
    hasher.update(pubkey_bytes);
    let digest = hasher.finalize();
    digest
        .iter()
        .take(5)
        .map(|&b| ALPHABET[(b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Path of the anchor file. The directory `~/.myownllm/.secrets/` is
/// created on demand.
fn anchor_path() -> Result<PathBuf> {
    Ok(crate::myownllm_dir()?
        .join(".secrets")
        .join("identity.json"))
}

/// Load the identity from disk, generating it on first call. Idempotent
/// — repeated calls return the same identity. Errors propagate as-is so
/// the UI can surface a clear failure instead of silently regenerating
/// a fresh key (which would orphan any peer relationships the user had
/// already established under the old key).
pub fn load_or_create() -> Result<Identity> {
    let path = anchor_path()?;
    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("read identity anchor at {}", path.display()))?;
        let anchor: Anchor = serde_json::from_str(&raw)
            .with_context(|| format!("parse identity anchor at {}", path.display()))?;
        return decode_anchor(anchor);
    }
    create_new(&path)
}

fn create_new(path: &PathBuf) -> Result<Identity> {
    // Ensure parent directory exists with restrictive perms.
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("identity anchor path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("create .secrets dir at {}", parent.display()))?;
    restrict_dir_permissions(parent)?;

    // Generate a fresh ed25519 keypair from OS randomness.
    let mut seed = [0u8; SECRET_KEY_LENGTH];
    OsRng.fill_bytes(&mut seed);
    let signing_key = SigningKey::from_bytes(&seed);
    let verifying = signing_key.verifying_key();

    let anchor = Anchor {
        version: ANCHOR_VERSION,
        created_at: chrono_now_iso(),
        secret_key: BASE32_NOPAD.encode(&seed).to_lowercase(),
        public_key: BASE32_NOPAD.encode(verifying.as_bytes()).to_lowercase(),
        label: String::new(),
    };

    let serialized = serde_json::to_string_pretty(&anchor)?;
    std::fs::write(path, serialized)
        .with_context(|| format!("write identity anchor to {}", path.display()))?;
    restrict_file_permissions(path)?;

    Ok(Identity {
        signing_key,
        public_id: anchor.public_key,
        label: anchor.label,
    })
}

fn decode_anchor(anchor: Anchor) -> Result<Identity> {
    if anchor.version != ANCHOR_VERSION {
        anyhow::bail!(
            "identity anchor version {} unsupported (this build expects v{})",
            anchor.version,
            ANCHOR_VERSION
        );
    }
    let seed_bytes = BASE32_NOPAD
        .decode(anchor.secret_key.to_uppercase().as_bytes())
        .context("decode identity secret_key (expected base32-lowercase nopad)")?;
    if seed_bytes.len() != SECRET_KEY_LENGTH {
        anyhow::bail!(
            "identity secret_key length is {} bytes, expected {}",
            seed_bytes.len(),
            SECRET_KEY_LENGTH
        );
    }
    let mut seed = [0u8; SECRET_KEY_LENGTH];
    seed.copy_from_slice(&seed_bytes);
    let signing_key = SigningKey::from_bytes(&seed);
    Ok(Identity {
        signing_key,
        public_id: anchor.public_key,
        label: anchor.label,
    })
}

/// Generate a fresh memorable Network ID. Eight random chars from
/// `[a-z0-9]` — short enough to read over the phone, long enough
/// (36^8 ≈ 2.8 trillion) that accidental collisions don't happen.
/// The Network ID itself doesn't gate access — the per-peer auth
/// handshake does — so it doesn't need to be cryptographically
/// strong. The frontend hashes whatever the user picks to derive
/// the broker-side discovery handle.
pub fn generate_network_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|&b| ALPHABET[(b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Normalize a user-typed Network ID. Trims whitespace, lowercases,
/// and validates that every character is alphanumeric, `-`, or `_`.
/// Length is enforced to 3–64 chars — long enough to be unambiguous,
/// short enough to share verbally. Returned string is the canonical
/// form we persist and compare against; the broker discovery handle
/// is derived on the frontend by hashing this value.
pub fn normalize_network_id(input: &str) -> Result<String> {
    let trimmed = input.trim().to_lowercase();
    if trimmed.is_empty() {
        anyhow::bail!("network id is empty");
    }
    if trimmed.len() < 3 {
        anyhow::bail!("network id must be at least 3 characters");
    }
    if trimmed.len() > 64 {
        anyhow::bail!("network id must be 64 characters or fewer");
    }
    for c in trimmed.chars() {
        if !(c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            anyhow::bail!(
                "network id contains '{c}'; only letters, digits, '-', and '_' are allowed"
            );
        }
    }
    Ok(trimmed)
}

/// Update the stored label on the anchor file. Re-reads the anchor to
/// avoid clobbering fields a future migration may have added.
pub fn set_label(label: &str) -> Result<()> {
    let path = anchor_path()?;
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("read identity anchor at {}", path.display()))?;
    let mut anchor: Anchor = serde_json::from_str(&raw)?;
    anchor.label = label.to_string();
    let serialized = serde_json::to_string_pretty(&anchor)?;
    std::fs::write(&path, serialized)?;
    restrict_file_permissions(&path)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_dir_permissions(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(unix)]
fn restrict_file_permissions(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_dir_permissions(_path: &std::path::Path) -> Result<()> {
    // Windows: rely on the default ACL of the user profile, which
    // restricts access to the user. A future hardening pass can apply
    // a SetSecurityInfo call to remove inherited entries.
    Ok(())
}

#[cfg(not(unix))]
fn restrict_file_permissions(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

/// Minimal RFC 3339 timestamp formatter so we don't take a `chrono`
/// dependency just for the anchor's `created_at` field. The value is
/// informational only; nothing reads or compares it.
fn chrono_now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Format as seconds-since-epoch tagged with @ so it's unambiguous
    // and parseable by humans. We avoid pulling in a date crate just
    // to format this single field; if we ever need real ISO 8601 here,
    // swap in `time` or `chrono` at that point.
    format!("@{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_round_trips_simple_input() {
        let normed = normalize_network_id("office-mesh").unwrap();
        assert_eq!(normed, "office-mesh");
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(
            normalize_network_id("  Office-Mesh  ").unwrap(),
            "office-mesh"
        );
    }

    #[test]
    fn normalize_accepts_letters_digits_dash_underscore() {
        assert_eq!(normalize_network_id("my_net_1").unwrap(), "my_net_1");
        assert_eq!(normalize_network_id("ab12").unwrap(), "ab12");
    }

    #[test]
    fn normalize_rejects_garbage() {
        assert!(normalize_network_id("").is_err());
        // Too short
        assert!(normalize_network_id("ab").is_err());
        // Too long (65 chars)
        assert!(normalize_network_id(&"a".repeat(65)).is_err());
        // Disallowed character
        assert!(normalize_network_id("not space!").is_err());
        assert!(normalize_network_id("hello world").is_err());
    }

    #[test]
    fn generate_produces_valid_id() {
        for _ in 0..50 {
            let id = generate_network_id();
            assert_eq!(id.len(), 8);
            // Round-trip: anything generate() emits must pass normalize().
            assert_eq!(normalize_network_id(&id).unwrap(), id);
        }
    }

    #[test]
    fn display_suffix_is_5_alphanumeric() {
        let bytes = [42u8; 32];
        let suffix = display_suffix(&bytes);
        assert_eq!(suffix.len(), 5);
        assert!(suffix
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }

    #[test]
    fn display_suffix_is_deterministic() {
        let bytes = [7u8; 32];
        assert_eq!(display_suffix(&bytes), display_suffix(&bytes));
    }

    #[test]
    fn display_suffix_differs_across_pubkeys() {
        // Astronomically unlikely to collide on 5 chars of sha256
        // output, but assert so a future refactor that breaks the
        // determinism (or accidentally returns a constant) fails loud.
        let a = display_suffix(&[1u8; 32]);
        let b = display_suffix(&[2u8; 32]);
        assert_ne!(a, b);
    }
}
