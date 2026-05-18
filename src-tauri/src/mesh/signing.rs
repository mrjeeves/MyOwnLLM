//! ed25519 signing and verification for the Cloud Mesh.
//!
//! Used by the auth handshake: when a new peer connects, both ends
//! sign a challenge with their private key, and the receiving side
//! verifies the signature against the claimed Device ID. This proves
//! the peer actually owns the keypair that produces their advertised
//! pubkey, not just that they know it.
//!
//! Signing operations live in Rust so the private key never leaves
//! the anchor file — the frontend sends a message to sign and gets
//! back a signature, never the key itself.

use anyhow::{Context, Result};
use data_encoding::BASE32_NOPAD;
use ed25519_dalek::{
    Signature, Signer, SigningKey, Verifier, VerifyingKey, PUBLIC_KEY_LENGTH, SIGNATURE_LENGTH,
};

use super::identity;

/// Sign an arbitrary message with this device's private key. Returns
/// the 64-byte signature, base32-lowercase encoded. The caller is
/// responsible for whatever protocol-level framing wraps the message
/// — auth handshakes typically prefix a domain-separation tag so a
/// signature from one context can't be replayed in another.
pub fn sign(message: &[u8]) -> Result<String> {
    let identity = identity::load_or_create()?;
    Ok(sign_with(identity.signing_key(), message))
}

fn sign_with(key: &SigningKey, message: &[u8]) -> String {
    let sig: Signature = key.sign(message);
    BASE32_NOPAD.encode(&sig.to_bytes()).to_lowercase()
}

/// Verify a signature against a claimed Device ID. Accepts the same
/// base32-lowercase encoding the rest of the mesh uses. Returns `true`
/// if and only if the signature is valid for `message` under the
/// pubkey portion of `device_id`. Suffix on the Device ID (the
/// `-XXXXX` display tag) is stripped before parsing — peers exchange
/// raw pubkeys on the wire, but the UI surfaces the display form, so
/// either is accepted here.
pub fn verify(device_id: &str, message: &[u8], signature_b32: &str) -> Result<bool> {
    let pubkey_part_str = pubkey_part(device_id);
    let pubkey_bytes = BASE32_NOPAD
        .decode(pubkey_part_str.to_uppercase().as_bytes())
        .context("device_id is not valid base32")?;
    if pubkey_bytes.len() != PUBLIC_KEY_LENGTH {
        anyhow::bail!(
            "device_id decodes to {} bytes; expected {}",
            pubkey_bytes.len(),
            PUBLIC_KEY_LENGTH
        );
    }
    let mut pubkey_arr = [0u8; PUBLIC_KEY_LENGTH];
    pubkey_arr.copy_from_slice(&pubkey_bytes);
    let pubkey = VerifyingKey::from_bytes(&pubkey_arr)
        .context("device_id is not a valid ed25519 public key")?;

    let sig_bytes = BASE32_NOPAD
        .decode(signature_b32.to_uppercase().as_bytes())
        .context("signature is not valid base32")?;
    if sig_bytes.len() != SIGNATURE_LENGTH {
        anyhow::bail!(
            "signature decodes to {} bytes; expected {}",
            sig_bytes.len(),
            SIGNATURE_LENGTH
        );
    }
    let mut sig_arr = [0u8; SIGNATURE_LENGTH];
    sig_arr.copy_from_slice(&sig_bytes);
    let sig = Signature::from_bytes(&sig_arr);

    Ok(pubkey.verify(message, &sig).is_ok())
}

/// Strip the display suffix from a Device ID, returning just the
/// pubkey portion in canonical base32-lowercase form. Used by the
/// roster (which keys on pubkey, not display) and by anywhere that
/// needs to compare two IDs that may differ only by suffix.
///
/// Real pubkeys are pure base32 (no dashes), so we strip a single
/// trailing `-XXXXX` tail where XXXXX is exactly 5 alphanumerics.
/// Inputs that don't match the display-form pattern are returned
/// unchanged.
pub fn pubkey_part(device_id: &str) -> &str {
    if let Some((body, suffix)) = device_id.rsplit_once('-') {
        if suffix.len() == 5 && suffix.chars().all(|c| c.is_ascii_alphanumeric()) {
            return body;
        }
    }
    device_id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_key() -> (SigningKey, String) {
        // Deterministic seed for reproducible test signatures.
        let seed = [7u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let pubkey_b32 = BASE32_NOPAD
            .encode(sk.verifying_key().as_bytes())
            .to_lowercase();
        (sk, pubkey_b32)
    }

    #[test]
    fn sign_verify_round_trip() {
        let (sk, pubkey) = fixture_key();
        let msg = b"hello mesh";
        let sig = sign_with(&sk, msg);
        assert!(verify(&pubkey, msg, &sig).unwrap());
    }

    #[test]
    fn verify_rejects_wrong_message() {
        let (sk, pubkey) = fixture_key();
        let sig = sign_with(&sk, b"original");
        assert!(!verify(&pubkey, b"tampered", &sig).unwrap());
    }

    #[test]
    fn verify_rejects_wrong_pubkey() {
        let (sk, _) = fixture_key();
        let other_pubkey = BASE32_NOPAD
            .encode(
                SigningKey::from_bytes(&[8u8; 32])
                    .verifying_key()
                    .as_bytes(),
            )
            .to_lowercase();
        let sig = sign_with(&sk, b"hello");
        assert!(!verify(&other_pubkey, b"hello", &sig).unwrap());
    }

    #[test]
    fn verify_accepts_display_form_device_id() {
        let (sk, pubkey) = fixture_key();
        let msg = b"hello mesh";
        let sig = sign_with(&sk, msg);
        // Display form includes the -XXXXX suffix; verify() strips it.
        let display = format!("{pubkey}-abc12");
        assert!(verify(&display, msg, &sig).unwrap());
    }

    #[test]
    fn pubkey_part_strips_suffix() {
        assert_eq!(pubkey_part("abcdefghij-xyz12"), "abcdefghij");
        assert_eq!(pubkey_part("abcdefghij"), "abcdefghij");
        // Non-5-char tails are not display suffixes — leave alone.
        assert_eq!(pubkey_part("abc-defghij"), "abc-defghij");
        // 5-char tail with non-alphanumerics — leave alone.
        assert_eq!(pubkey_part("abc-xy!12"), "abc-xy!12");
    }
}
