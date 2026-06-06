//! Daemon lifecycle + control protocol client.
//!
//! The LLM Tauri backend works against a running `myownmesh serve`
//! daemon (the binary built from the MyOwnMesh workspace). On first
//! boot we probe two candidate sockets and pick the first responsive
//! one — the "detect-and-share" mode the user opted into when the
//! migration was scoped:
//!
//! 1. **Shared daemon**: `~/.myownmesh/daemon.sock`. If MyOwnMesh GUI
//!    is running, its daemon already binds this socket. Connecting
//!    here shares identity, roster, and networks across both apps.
//! 2. **LLM-owned daemon**: `~/.myownllm/.myownmesh/daemon.sock`.
//!    We spawn `myownmesh serve` with
//!    `MYOWNMESH_HOME=~/.myownllm/.myownmesh/` so the daemon's
//!    `config.json` + `updates/` stay isolated from the LLM's
//!    `~/.myownllm/config.json` + `~/.myownllm/updates/`. Identity,
//!    rosters, and signed governance states get pre-migrated into
//!    the subdir by `mesh::migration::migrate_daemon_state_into_subdir`
//!    so existing users keep their pubkey + peer approvals.
//!
//! The choice is sticky for the app lifetime — we don't dynamically
//! switch sockets if the GUI starts mid-session. A future "merge
//! identities" flow can handle that explicitly.
//!
//! Wire shape mirrors `myownmesh::control::Request` / `Response` —
//! kept in sync by hand here. Schema drift surfaces as
//! `Response::err("parse: …")` on either side, which the Tauri layer
//! propagates to the frontend as a toast.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use interprocess::local_socket::tokio::prelude::*;
#[cfg(unix)]
use interprocess::local_socket::GenericFilePath;
#[cfg(not(unix))]
use interprocess::local_socket::GenericNamespaced;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// The target triple this build was compiled for. `build.rs`
/// surfaces it via `cargo:rustc-env=DAEMON_SIDECAR_TRIPLE=...` so
/// `daemon_binary_candidates` knows the exact name Tauri uses
/// when staging the sidecar in dev mode
/// (`myownmesh-<triple>{.exe}`, unchanged) vs. production
/// (`myownmesh{.exe}`, suffix stripped).
const DAEMON_SIDECAR_TRIPLE: &str = env!("DAEMON_SIDECAR_TRIPLE");

// ---- wire protocol ----------------------------------------------------

/// Mirror of `myownmesh::control::Request`. Kept in sync by hand;
/// adding a variant here without the daemon side (or vice versa)
/// surfaces as a JSON parse error.
#[derive(Debug, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    // ---- control plane ---------------------------------------------
    Status,
    NetworksList,
    PeersList {
        network: String,
    },
    RosterList {
        network: String,
    },
    RosterApprove {
        network: String,
        device_id: String,
        label: Option<String>,
    },
    RosterRemove {
        network: String,
        device_id: String,
    },
    TopologySet {
        network: String,
        topology: String,
        hub: Option<String>,
    },
    IdentityShow,
    IdentitySetLabel {
        label: String,
    },
    NetworkIdGenerate,
    NetworkIdNormalize {
        input: String,
    },
    ConfigShow,
    NetworkAdd {
        config: serde_json::Value,
    },
    NetworkRemove {
        network: String,
    },
    /// Update an already-joined network's config in place. The daemon
    /// hot-applies topology/label/auto_approve changes and rebuilds the
    /// network for transport changes (signaling / STUN / TURN). This is
    /// how a STUN/TURN edit reaches a network the daemon joined on a
    /// previous launch — `NetworkAdd` no-ops on an existing network.
    NetworkUpdate {
        config: serde_json::Value,
    },
    EventsSubscribe,

    // ---- governance ------------------------------------------------
    GovernanceState {
        network: String,
    },
    GovernanceProposeKindChange {
        network: String,
        /// `"open"` or `"closed"`.
        to: String,
    },
    GovernanceProposeRoleGrant {
        network: String,
        target: String,
        role: String,
    },
    GovernanceProposeRoleRevoke {
        network: String,
        target: String,
    },
    GovernanceSign {
        network: String,
        proposal_id: String,
    },
    GovernanceDeny {
        network: String,
        proposal_id: String,
    },
    GovernanceWithdraw {
        network: String,
        proposal_id: String,
    },
    GovernanceSpawnSplit {
        network: String,
        proposal_id: String,
    },

    // ---- RPC + typed channels + capabilities (new in PR #16) -------
    RpcRegister {
        client_id: String,
        network: String,
        method: String,
        streaming: bool,
    },
    RpcUnregister {
        client_id: String,
        network: String,
        method: String,
    },
    RpcRespond {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        ok: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    RpcStreamChunk {
        request_id: String,
        payload: serde_json::Value,
    },
    RpcStreamEnd {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    RpcCall {
        network: String,
        peer: String,
        method: String,
        payload: serde_json::Value,
    },
    RpcCallStream {
        client_id: String,
        network: String,
        peer: String,
        method: String,
        payload: serde_json::Value,
    },
    ChannelSubscribe {
        client_id: String,
        network: String,
        channel: String,
    },
    ChannelUnsubscribe {
        client_id: String,
        network: String,
        channel: String,
    },
    ChannelSendTo {
        network: String,
        channel: String,
        peer: String,
        payload: serde_json::Value,
    },
    ChannelSendAll {
        network: String,
        channel: String,
        payload: serde_json::Value,
    },
    CapabilitiesSet {
        network: String,
        capabilities: serde_json::Value,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Response {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

// ---- socket addressing ------------------------------------------------

/// Two candidate daemon sockets in detect-and-share priority order.
/// `Shared` is the MyOwnMesh-GUI-managed socket; `OwnLlm` is our own
/// daemon's socket when we spawned it ourselves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonMode {
    /// Connected to a daemon that was already running (MyOwnMesh GUI
    /// or a manually-started `myownmesh serve`). We don't own its
    /// lifetime.
    Shared,
    /// We spawned the daemon ourselves with
    /// `MYOWNMESH_HOME=~/.myownllm/.myownmesh/`. We own the child
    /// process.
    OwnLlm,
}

#[derive(Debug, Clone)]
enum SocketAddr {
    #[cfg_attr(not(unix), allow(dead_code))]
    Path(PathBuf),
    #[cfg_attr(unix, allow(dead_code))]
    Name(String),
}

impl fmt::Display for SocketAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SocketAddr::Path(p) => write!(f, "{}", p.display()),
            SocketAddr::Name(n) => write!(f, "named pipe {n}"),
        }
    }
}

/// Compute the candidate socket addresses for the two daemon modes.
/// On Windows the namespaced pipe segment is shared between modes —
/// we still spawn our own daemon if probing the existing one fails,
/// but the wire name is the same.
///
/// Per-mode Unix paths mirror the daemon's
/// `MYOWNMESH_HOME/daemon.sock` layout:
/// - `Shared`: `~/.myownmesh/daemon.sock` — the MyOwnMesh GUI's
///   default location.
/// - `OwnLlm`: `~/.myownllm/.myownmesh/daemon.sock` — the LLM
///   spawns its own daemon with `MYOWNMESH_HOME=~/.myownllm/.myownmesh/`
///   so the daemon's `config.json` + `updates/` don't collide with
///   the LLM's. See `mesh/migration.rs` for the why.
fn socket_for_mode(mode: DaemonMode) -> Result<SocketAddr> {
    #[cfg(unix)]
    {
        let home = dirs::home_dir().context("no home dir")?;
        let dir = match mode {
            DaemonMode::Shared => home.join(".myownmesh"),
            DaemonMode::OwnLlm => home.join(".myownllm").join(".myownmesh"),
        };
        Ok(SocketAddr::Path(dir.join("daemon.sock")))
    }
    #[cfg(not(unix))]
    {
        // Windows uses a single namespaced pipe name. Pre-existing
        // daemons (including MyOwnMesh GUI's) bind the same name; if
        // we can't connect, we own-spawn our own which will bind it
        // once the existing one (if any) has gone.
        let _ = mode;
        Ok(SocketAddr::Name("myownmesh.sock".to_string()))
    }
}

// ---- ControlClient ----------------------------------------------------

#[derive(Clone)]
pub struct ControlClient {
    addr: SocketAddr,
    pub mode: DaemonMode,
}

impl ControlClient {
    pub fn for_mode(mode: DaemonMode) -> Result<Self> {
        Ok(Self {
            addr: socket_for_mode(mode.clone())?,
            mode,
        })
    }

    pub fn socket_display(&self) -> String {
        self.addr.to_string()
    }

    /// Short string id for the daemon mode, surfaced to the frontend
    /// via `mesh_daemon_status` so the UI can show whether we're on
    /// a shared MyOwnMesh GUI daemon or our own LLM-spawned one.
    pub fn mode_str(&self) -> &'static str {
        match self.mode {
            DaemonMode::Shared => "shared",
            DaemonMode::OwnLlm => "own_llm",
        }
    }

    /// One-shot request → response on a fresh socket.
    pub async fn request(&self, req: &Request) -> Result<Response> {
        let stream = self.connect().await?;
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);

        let line = serde_json::to_string(req)? + "\n";
        writer
            .write_all(line.as_bytes())
            .await
            .context("write request")?;
        writer.flush().await.context("flush request")?;

        let mut buf = String::new();
        let n = tokio::time::timeout(Duration::from_secs(30), reader.read_line(&mut buf))
            .await
            .context("daemon response timed out")??;
        if n == 0 {
            bail!("daemon closed connection without a response");
        }
        let resp: Response =
            serde_json::from_str(buf.trim()).with_context(|| format!("parse response: {buf}"))?;
        Ok(resp)
    }

    /// Convenience: request + unwrap. `data` is required on `ok`; an
    /// error response surfaces as an `Err`.
    pub async fn request_ok(&self, req: &Request) -> Result<serde_json::Value> {
        let resp = self.request(req).await?;
        if !resp.ok {
            bail!(resp.error.unwrap_or_else(|| "(no error)".into()));
        }
        Ok(resp.data.unwrap_or(serde_json::Value::Null))
    }

    /// Subscribe to the daemon's event stream. Forwards each incoming
    /// line to `tx` until the daemon disconnects. Returns after the
    /// initial ack — the caller plumbs `rx` into a Tauri emitter.
    pub async fn subscribe_events(&self, tx: mpsc::Sender<serde_json::Value>) -> Result<String> {
        let stream = self.connect().await?;
        let (reader, mut writer) = stream.split();
        let mut reader = BufReader::new(reader);

        let line = serde_json::to_string(&Request::EventsSubscribe)? + "\n";
        writer
            .write_all(line.as_bytes())
            .await
            .context("write subscribe")?;
        writer.flush().await.context("flush subscribe")?;

        let mut ack = String::new();
        let n = reader.read_line(&mut ack).await.context("read ack")?;
        if n == 0 {
            bail!("daemon closed connection before sending subscribe ack");
        }
        let parsed: Response =
            serde_json::from_str(ack.trim()).with_context(|| format!("parse ack: {ack}"))?;
        if !parsed.ok {
            return Err(anyhow!(
                "subscribe rejected: {}",
                parsed.error.unwrap_or_else(|| "(no error)".into())
            ));
        }
        let client_id = parsed
            .data
            .as_ref()
            .and_then(|d| d.get("client_id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("subscribe ack missing client_id"))?
            .to_string();

        tokio::spawn(async move {
            let _writer_keepalive = writer;
            let mut buf = String::new();
            loop {
                buf.clear();
                match reader.read_line(&mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("daemon: event stream read failed: {e}");
                        break;
                    }
                }
                let value: serde_json::Value = match serde_json::from_str(buf.trim()) {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("daemon: malformed event line: {e} — {buf}");
                        continue;
                    }
                };
                if tx.send(value).await.is_err() {
                    break;
                }
            }
        });

        Ok(client_id)
    }

    async fn connect(&self) -> Result<LocalSocketStream> {
        let name = match &self.addr {
            SocketAddr::Path(p) => {
                #[cfg(unix)]
                {
                    p.as_path()
                        .to_fs_name::<GenericFilePath>()
                        .context("socket path → fs_name")?
                }
                #[cfg(not(unix))]
                {
                    let _ = p;
                    unreachable!("SocketAddr::Path on non-Unix")
                }
            }
            SocketAddr::Name(n) => {
                #[cfg(not(unix))]
                {
                    n.as_str()
                        .to_ns_name::<GenericNamespaced>()
                        .context("socket name → ns_name")?
                }
                #[cfg(unix)]
                {
                    let _ = n;
                    unreachable!("SocketAddr::Name on Unix")
                }
            }
        };
        LocalSocketStream::connect(name).await.context(format!(
            "connect daemon socket at {} — is `myownmesh serve` running?",
            self.addr
        ))
    }
}

// ---- daemon version gate ---------------------------------------------

/// The MyOwnMesh release this build was pinned to (`.myownmesh-rev`,
/// surfaced by `build.rs`). `None` for dev builds with no pin. May be a
/// `vMAJOR.MINOR.PATCH` tag or a raw SHA; comparisons go through
/// [`version_meets`], which ignores anything not parseable as semver.
pub fn pinned_mesh_version() -> Option<&'static str> {
    option_env!("MYOWNMESH_PIN")
}

/// True when daemon version `have` satisfies requirement `want`
/// (`have >= want`). Both accept an optional leading `v` and ignore any
/// `-pre` / `+build` suffix. Returns `true` ("don't nag") when either
/// side isn't a parseable `MAJOR.MINOR.PATCH` — e.g. a SHA pin in dev —
/// since no meaningful claim can be made then.
pub fn version_meets(have: &str, want: &str) -> bool {
    fn parse(s: &str) -> Option<(u64, u64, u64)> {
        let s = s.trim();
        let s = s.strip_prefix('v').unwrap_or(s);
        let core = s.split(|c| c == '-' || c == '+').next().unwrap_or(s);
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        Some((major, minor, patch))
    }
    match (parse(have), parse(want)) {
        (Some(h), Some(w)) => h >= w,
        _ => true,
    }
}

/// Best-effort: nudge the live `myownmesh` daemon toward (at least) the
/// pinned version. Advisory only — mismatched revs still peer, since the
/// wire protocol negotiates features per-peer — so this never blocks.
///
/// `own` = MyOwnLLM spawned this daemon, so it runs against our isolated
/// `MYOWNMESH_HOME` and it's safe to `apply` the staged binary (which
/// takes effect on the daemon's next start). For a shared daemon we only
/// `enable` + `check` (stage); its own process applies on its restart —
/// we never swap another app's binary out from under it.
///
/// Returns a small JSON summary. Every step is fail-soft, so a missing
/// binary, a read-only install, or an offline box degrades quietly
/// rather than surfacing an error to the user.
pub fn drive_daemon_update(own: bool) -> serde_json::Value {
    let Some(bin) = daemon_binary_candidates().into_iter().find(|p| p.is_file()) else {
        return serde_json::json!({ "ok": false, "error": "no myownmesh binary found" });
    };
    // Own-LLM daemon lives under our isolated home; a shared daemon uses
    // its own default `MYOWNMESH_HOME` (don't override it).
    let home = if own {
        dirs::home_dir().map(|h| h.join(".myownllm").join(".myownmesh"))
    } else {
        None
    };
    let run = |args: &[&str]| -> Result<String, String> {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(args);
        if let Some(h) = &home {
            cmd.env("MYOWNMESH_HOME", h);
        }
        match cmd.output() {
            Ok(o) if o.status.success() => {
                Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
            }
            Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
            Err(e) => Err(e.to_string()),
        }
    };
    // 1. Make sure the daemon's own background updater is on ("let it").
    let _ = run(&["update", "enable"]);
    // 2. Force a check now so we don't wait out the 6h interval; stages
    //    the latest release when the daemon's apply policy allows.
    let check = run(&["update", "check", "--json"]);
    // 3. For a daemon we own, apply the staged binary (effective on its
    //    next start). Leave a shared daemon's binary alone.
    let apply = if own {
        Some(run(&["update", "apply"]))
    } else {
        None
    };
    serde_json::json!({
        "ok": true,
        "own": own,
        "binary": bin.display().to_string(),
        "check": check.as_ref().ok(),
        "check_error": check.as_ref().err(),
        "applied": apply.as_ref().map(|r| r.is_ok()),
        "apply": apply.as_ref().and_then(|r| r.as_ref().ok().cloned()),
        "apply_error": apply.as_ref().and_then(|r| r.as_ref().err().cloned()),
    })
}

// ---- daemon child lifecycle ------------------------------------------

/// Owned wrapper around a spawned `myownmesh serve` child.
/// Dropping it kills the daemon (best-effort SIGKILL /
/// TerminateProcess). On Windows we also attach the child to a
/// Job Object with `KILL_ON_JOB_CLOSE`: if the LLM is killed
/// abruptly (Ctrl-C / taskkill / crash) and Drop never runs, the
/// OS still terminates the daemon when our process exits. That
/// covers the orphan case the simple Drop path misses.
pub struct DaemonChild {
    child: Option<Child>,
    /// Windows Job Object the child is assigned to. Leaked
    /// intentionally — the handle stays alive for the lifetime
    /// of the LLM process so Windows reclaims it on exit (any
    /// exit) and triggers KILL_ON_JOB_CLOSE.
    #[cfg(windows)]
    #[allow(dead_code)]
    job: Option<*mut std::ffi::c_void>,
}

// SAFETY: the Job Object handle is opaque + never dereferenced
// directly; it's held purely so its lifetime extends across the
// daemon child's lifetime. Sending the wrapper between threads
// is safe.
#[cfg(windows)]
unsafe impl Send for DaemonChild {}
#[cfg(windows)]
unsafe impl Sync for DaemonChild {}

impl Drop for DaemonChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            eprintln!("daemon: child terminated");
        }
        // The Job Object handle is leaked deliberately — see the
        // struct doc above. Windows GCs it when the LLM process
        // exits, which is the point.
    }
}

/// Collect every viable `myownmesh` binary location on this
/// machine, in priority order. `ensure_daemon_running` iterates
/// through them and tries to spawn each — picking the first
/// that actually works rather than the first that merely exists.
/// That distinction matters in dev setups where a stale, broken,
/// or zero-byte file at one location would otherwise block the
/// app from using a working binary at the next.
///
/// Priority order:
///   1. **Sidecar next to the running LLM executable** — the
///      production-bundle path. `build.rs` builds (or copies)
///      the daemon binary into `src-tauri/binaries/myownmesh-
///      <triple>` and `tauri.conf.json::bundle::externalBin`
///      declares it as a sidecar. Tauri's bundler places it next
///      to the main `MyOwnLLM` executable in the `.app` / `.deb`
///      / `.msi`. End users never need to install MyOwnMesh
///      separately. Zero-byte placeholders (written by build.rs
///      when the daemon fetch was skipped) are filtered out so we
///      fall through.
///   2. `MYOWNLLM_MESH_BIN` env var (LLM-specific override).
///   3. `MYOWNMESH_BIN` env var (shared with MyOwnMesh GUI's
///      convention).
///   4. `myownmesh` (or `myownmesh.exe`) on `$PATH`.
///   5. Workspace dev artefacts (sibling MyOwnMesh checkout's
///      `target/{debug,release}/`) — only relevant in dev when
///      the sidecar wasn't bundled (offline iteration,
///      `MYOWNLLM_SKIP_SIDECAR=1`).
/// Verify a candidate path is a real, usable daemon binary
/// before we try to spawn it. Matches the build-time
/// validator in `build.rs::validate_executable_magic`:
///
/// - File size ≥ 1 MiB (filters truncated downloads / stubs).
/// - PE / ELF / Mach-O magic at offset 0.
/// - On Windows (`.exe`): walk the DOS header's `e_lfanew` and
///   verify the PE signature is `PE\0\0`. A 4 MB truncated PE
///   that still starts with `MZ` would pass a magic-only check
///   but spawn would reject it with the cryptic "not a valid
///   Win32 application" error — this catches it.
///
/// Files at paths we own (the source `binaries/<triple>` slot,
/// Tauri's dev-mode `target/<profile>/` staging) that fail the
/// check get unlinked here as a self-heal so the next build /
/// dev cycle rewrites with fresh content instead of perpetually
/// staging corrupt bits. Files at paths we DON'T own (PATH
/// lookup, env-var override) just get skipped without deletion.
/// Validate a candidate daemon binary. `Ok(())` when usable, else
/// `Err(reason)` describing why it was rejected. Performs the self-heal
/// removal of a stale *owned* slot, but does NOT log — callers collect
/// the reasons and surface them only when the whole search fails, so a
/// successful daemon launch stays quiet (see `ensure_daemon_running`).
fn check_executable(path: &Path) -> Result<(), String> {
    match validate_path_is_executable(path) {
        Ok(()) => Ok(()),
        Err(reason) => {
            // Self-heal: if this is a known-owned slot and the content is
            // invalid, delete it. Tauri's externalBin staging regenerates
            // it from the source on the next build; the source's own
            // validator catches problems before propagating them.
            if is_owned_slot(path) {
                let _ = std::fs::remove_file(path);
                Err(format!(
                    "{} failed executable check ({reason}); removed stale file",
                    path.display()
                ))
            } else {
                Err(format!("skipping {} ({reason})", path.display()))
            }
        }
    }
}

fn validate_path_is_executable(path: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    let size = meta.len();
    if size < 1_048_576 {
        return Err(format!("{size} bytes < 1 MiB minimum"));
    }
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mut head = [0u8; 4];
    f.read_exact(&mut head)
        .map_err(|e| format!("read magic: {e}"))?;
    let pe = head[0..2] == *b"MZ";
    let elf = head == [0x7f, b'E', b'L', b'F'];
    let macho = matches!(
        u32::from_le_bytes(head),
        0xFEED_FACE | 0xFEED_FACF | 0xCAFE_BABE | 0xBEBA_FECA
    ) || matches!(
        u32::from_be_bytes(head),
        0xFEED_FACE | 0xFEED_FACF | 0xCAFE_BABE | 0xBEBA_FECA
    );
    if !(pe || elf || macho) {
        return Err(format!("bad magic {head:02x?}"));
    }
    if pe {
        f.seek(SeekFrom::Start(0x3C))
            .map_err(|e| format!("seek 0x3C: {e}"))?;
        let mut e_lfanew_bytes = [0u8; 4];
        f.read_exact(&mut e_lfanew_bytes)
            .map_err(|e| format!("read e_lfanew: {e}"))?;
        let e_lfanew = u32::from_le_bytes(e_lfanew_bytes) as u64;
        if e_lfanew < 0x40 || e_lfanew >= size {
            return Err(format!("nonsense e_lfanew=0x{e_lfanew:x}"));
        }
        f.seek(SeekFrom::Start(e_lfanew))
            .map_err(|e| format!("seek to PE sig: {e}"))?;
        let mut pe_sig = [0u8; 4];
        f.read_exact(&mut pe_sig)
            .map_err(|e| format!("read PE sig: {e}"))?;
        if pe_sig != [b'P', b'E', 0, 0] {
            return Err(format!("no PE sig at 0x{e_lfanew:x}"));
        }
    }
    Ok(())
}

/// Identify paths where the LLM owns the file and a stale /
/// corrupt blob can be safely removed: the source `binaries/`
/// sidecar slot, and the Tauri dev-staging `target/<profile>/`
/// directories. Everything else (env-var overrides, PATH hits,
/// sibling MyOwnMesh checkout) we leave alone.
fn is_owned_slot(path: &Path) -> bool {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let owned_dirs = [
        manifest.join("binaries"),
        manifest.join("target").join("debug"),
        manifest.join("target").join("release"),
    ];
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    for dir in &owned_dirs {
        let canonical_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.clone());
        if canonical_path.starts_with(&canonical_dir) {
            return true;
        }
    }
    false
}

pub fn daemon_binary_candidates() -> Vec<PathBuf> {
    daemon_binary_candidates_diag().0
}

/// Like [`daemon_binary_candidates`] but also returns the human-readable
/// reason each rejected path was skipped. `ensure_daemon_running` holds
/// these and only prints them if the whole search fails, so a successful
/// launch doesn't spam the log with every probed-and-skipped location.
fn daemon_binary_candidates_diag() -> (Vec<PathBuf>, Vec<String>) {
    let exe = if cfg!(windows) {
        "myownmesh.exe"
    } else {
        "myownmesh"
    };
    // Build-time-captured target triple — surfaced by `build.rs`.
    // `tauri dev` keeps the `-<triple>` suffix when staging
    // sidecars next to the dev exe; `tauri build` strips it.
    // Checking both covers dev + production from one runtime path.
    let exe_with_triple = if cfg!(windows) {
        format!("myownmesh-{DAEMON_SIDECAR_TRIPLE}.exe")
    } else {
        format!("myownmesh-{DAEMON_SIDECAR_TRIPLE}")
    };
    let mut out: Vec<PathBuf> = Vec::new();
    let mut diags: Vec<String> = Vec::new();

    // Helper: push a candidate iff it exists AND looks like a
    // real executable (filters out the zero-byte stub
    // `build.rs` writes when the daemon fetch was skipped, AND
    // filters out corrupt / truncated downloads that would
    // otherwise produce a confusing "%1 is not a valid Win32
    // application" error when we try to spawn them). Rejection
    // reasons are collected into `diags` rather than logged here.
    fn push_if_usable(out: &mut Vec<PathBuf>, diags: &mut Vec<String>, p: PathBuf) {
        match check_executable(&p) {
            Ok(()) => out.push(p),
            Err(reason) => diags.push(reason),
        }
    }

    // 1. Bundled sidecar next to the running LLM executable —
    //    the production-bundle convention. Tauri's build step
    //    strips the `-<triple>` suffix; the dev-mode `tauri dev`
    //    leaves it on. Check both names so prod + dev resolve
    //    via the same code path.
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            push_if_usable(&mut out, &mut diags, exe_dir.join(exe));
            push_if_usable(&mut out, &mut diags, exe_dir.join(&exe_with_triple));
        }
    }

    // 1b. Source `binaries/<triple>` directory — where `build.rs`
    //     writes the bundled daemon before Tauri copies it
    //     elsewhere. In `cargo run` (no Tauri staging) this is
    //     the *only* place the binary lives. Relative to the
    //     crate, so it works from any working directory.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_if_usable(
        &mut out,
        &mut diags,
        manifest.join("binaries").join(&exe_with_triple),
    );

    // 2 + 3. Explicit env-var overrides.
    for var in ["MYOWNLLM_MESH_BIN", "MYOWNMESH_BIN"] {
        if let Ok(p) = std::env::var(var) {
            let p = PathBuf::from(p);
            if p.exists() {
                out.push(p);
            }
        }
    }

    // 4. PATH lookup.
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.exists() {
                out.push(candidate);
            }
        }
    }

    // 5. Dev fallback — sibling MyOwnMesh checkout's `target/`.
    //    `manifest` already declared above for the `binaries/`
    //    lookup; reuse it here.
    for profile in ["debug", "release"] {
        push_if_usable(
            &mut out,
            &mut diags,
            manifest.join("target").join(profile).join(exe),
        );
        if let Some(parent) = manifest.parent() {
            push_if_usable(
                &mut out,
                &mut diags,
                parent.join("target").join(profile).join(exe),
            );
            if let Some(grandparent) = parent.parent() {
                push_if_usable(
                    &mut out,
                    &mut diags,
                    grandparent
                        .join("MyOwnMesh")
                        .join("target")
                        .join(profile)
                        .join(exe),
                );
            }
        }
    }

    // De-dupe while preserving order (sidecar and workspace paths
    // can resolve to the same file under symlinked dev setups).
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| {
        let canonical = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        seen.insert(canonical)
    });
    (out, diags)
}

/// Legacy single-binary lookup. Returns the highest-priority
/// candidate, or an error message listing what was tried.
/// `ensure_daemon_running` now prefers
/// [`daemon_binary_candidates`] so it can iterate, but this is
/// still useful for the CLI's `myownllm mesh` diag.
#[allow(dead_code)]
pub fn find_daemon_binary() -> Result<PathBuf> {
    let candidates = daemon_binary_candidates();
    candidates.into_iter().next().ok_or_else(|| {
        anyhow!(
            "couldn't find `myownmesh` — the daemon sidecar wasn't bundled and no fallback \
             binary is on PATH. Re-run the LLM build with network access so `build.rs` \
             can fetch myownmesh, point MYOWNLLM_MESH_BIN at a pre-built binary, or \
             clone MyOwnMesh alongside this repo and run `cargo build -p myownmesh`."
        )
    })
}

/// Probe a candidate socket. Returns `true` when something is
/// listening and answers a `Status` request.
async fn probe(mode: DaemonMode) -> Option<ControlClient> {
    let client = ControlClient::for_mode(mode).ok()?;
    if tokio::time::timeout(Duration::from_millis(800), client.request(&Request::Status))
        .await
        .ok()
        .and_then(|r| r.ok())
        .map(|r| r.ok)
        .unwrap_or(false)
    {
        Some(client)
    } else {
        None
    }
}

/// Detect-and-share daemon resolution. Returns the live
/// `ControlClient` plus an `Option<DaemonChild>` — the child is
/// `Some` only when we spawned the daemon ourselves.
pub async fn ensure_daemon_running() -> Result<(ControlClient, Option<DaemonChild>)> {
    // 1. Shared mode: existing daemon at ~/.myownmesh/daemon.sock?
    if let Some(client) = probe(DaemonMode::Shared).await {
        eprintln!(
            "daemon: attached to existing shared daemon at {}",
            client.socket_display()
        );
        return Ok((client, None));
    }
    // 2. Own-LLM mode: existing daemon at
    //    ~/.myownllm/.myownmesh/daemon.sock?
    if let Some(client) = probe(DaemonMode::OwnLlm).await {
        eprintln!(
            "daemon: attached to existing own-LLM daemon at {}",
            client.socket_display()
        );
        return Ok((client, None));
    }
    // 3. No daemon up — spawn our own with
    //    MYOWNMESH_HOME=~/.myownllm/.myownmesh/ so the daemon's
    //    config.json + updates/ stay isolated from the LLM's. We
    //    iterate every viable binary location (`daemon_binary_
    //    candidates`); a stale or broken file at one location is
    //    skipped in favour of a working binary at the next. The
    //    diag log surfaces each attempt so a user with multiple
    //    stale candidates can see which one we picked.
    // `skip_diags` records every probed-but-rejected location. We stay
    // quiet about them on the happy path and only surface them if the
    // search ultimately fails, so a normal launch doesn't log a wall of
    // "skipping ..." lines for paths that simply don't apply here.
    let (candidates, skip_diags) = daemon_binary_candidates_diag();
    if candidates.is_empty() {
        for d in &skip_diags {
            eprintln!("daemon: {d}");
        }
        return Err(anyhow!(
            "couldn't find a `myownmesh` binary. Re-run the LLM build with network \
             access so `build.rs` can fetch the daemon, set MYOWNLLM_MESH_BIN to a \
             pre-built daemon, or clone MyOwnMesh alongside this repo and run \
             `cargo build -p myownmesh`."
        ));
    }
    // Daemon's MYOWNMESH_HOME — isolated under `~/.myownllm/.myownmesh/`
    // so the daemon's `config.json` + `updates/` don't collide with
    // the LLM's. The substrate reads/writes everything (identity,
    // rosters, states, config, updates) under this dir; identity +
    // rosters + states get pre-migrated into here by
    // `mesh::migration::migrate_daemon_state_into_subdir` so existing
    // users keep their pubkey + peer approvals.
    let home = dirs::home_dir()
        .context("no home dir")?
        .join(".myownllm")
        .join(".myownmesh");

    let mut last_err: Option<String> = None;
    for bin in &candidates {
        eprintln!(
            "daemon: spawning own-LLM daemon: bin={} home={}",
            bin.display(),
            home.display()
        );
        let spawn_res = Command::new(bin)
            .arg("serve")
            .env("MYOWNMESH_HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn();
        let child = match spawn_res {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("spawn {}: {e}", bin.display());
                eprintln!("daemon: {msg} — trying next candidate");
                last_err = Some(msg);
                continue;
            }
        };
        // On Windows: assign the child to a KILL_ON_JOB_CLOSE
        // Job Object so even an abrupt LLM exit (Ctrl-C in the
        // parent terminal, taskkill, crash) terminates the
        // daemon. This is what handles the orphan case the
        // simple Drop fallback misses.
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            crate::windows::assign_to_kill_on_close_job(child.as_raw_handle())
        };
        let handle = DaemonChild {
            child: Some(child),
            #[cfg(windows)]
            job,
        };

        // Wait for the control socket. Up to 8s is plenty even on
        // a cold-cache debug build.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Some(client) = probe(DaemonMode::OwnLlm).await {
                eprintln!("daemon: own-LLM daemon up (from {})", bin.display());
                return Ok((client, Some(handle)));
            }
        }
        // Didn't bind within the window. The child may still be
        // coming up slowly — but rather than gamble, drop the
        // child (its `Drop` kills it) and try the next candidate.
        eprintln!(
            "daemon: {} did not bind the control socket within 8s — trying next candidate",
            bin.display()
        );
        last_err = Some(format!(
            "{} spawned but the control socket never opened",
            bin.display()
        ));
        drop(handle);
    }

    // Every candidate failed. Now that the search has definitively
    // failed, surface the locations we skipped during enumeration too —
    // they're part of the picture the user needs to debug it.
    for d in &skip_diags {
        eprintln!("daemon: {d}");
    }
    // Surface a diag listing everything tried so the user can see what
    // got attempted — beats a bare "couldn't find".
    let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
    Err(anyhow!(
        "no working `myownmesh` binary on this machine. Tried:\n  {}\nLast error: {}",
        tried.join("\n  "),
        last_err.unwrap_or_else(|| "(none)".into()),
    ))
}

// ---- Tauri state ----------------------------------------------------

/// State managed by Tauri for the duration of the app. The
/// `child` slot keeps the spawned daemon alive (or `None` if we
/// attached to one we didn't spawn); the `client` is what every
/// Tauri command uses; the `client_id` is what RPC/channel ops
/// pass back to the daemon so it routes inbound events to our
/// event socket.
pub struct MeshDaemon {
    pub client: ControlClient,
    pub client_id: String,
    /// Held purely for lifetime — drop kills the daemon child.
    /// `Mutex<Option<_>>` so we can take ownership at app exit
    /// to wait the child cleanly rather than racing the OS to
    /// reclaim it.
    pub child: parking_lot::Mutex<Option<DaemonChild>>,
}

impl MeshDaemon {
    pub fn new(client: ControlClient, client_id: String, child: Option<DaemonChild>) -> Self {
        Self {
            client,
            client_id,
            child: parking_lot::Mutex::new(child),
        }
    }
}
