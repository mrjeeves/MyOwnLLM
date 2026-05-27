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
//! 2. **LLM-owned daemon**: `~/.myownllm/daemon.sock`. We spawn
//!    `myownmesh serve` with `MYOWNMESH_HOME=~/.myownllm` so the
//!    daemon reads/writes the LLM's existing on-disk layout
//!    (`identity.json`, `mesh/rosters/...`) instead of the
//!    MyOwnMesh default. This keeps existing users on their current
//!    pubkey when no GUI is present.
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
use std::path::PathBuf;
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
    /// `MYOWNMESH_HOME=~/.myownllm`. We own the child process.
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
fn socket_for_mode(mode: DaemonMode) -> Result<SocketAddr> {
    #[cfg(unix)]
    {
        let home = dirs::home_dir().context("no home dir")?;
        let dir = match mode {
            DaemonMode::Shared => home.join(".myownmesh"),
            DaemonMode::OwnLlm => home.join(".myownllm"),
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

// ---- daemon child lifecycle ------------------------------------------

/// Owned wrapper around a spawned `myownmesh serve` child. Dropping
/// it kills the daemon (best-effort SIGKILL / TerminateProcess).
pub struct DaemonChild {
    child: Option<Child>,
}

impl Drop for DaemonChild {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            eprintln!("daemon: child terminated");
        }
    }
}

/// Resolve the `myownmesh` binary in this priority order:
///   1. **Sidecar next to the running LLM executable** — the
///      production-bundle path. `build.rs` builds (or copies) the
///      daemon binary into `src-tauri/binaries/myownmesh-<triple>`
///      and `tauri.conf.json::bundle::externalBin` declares it as
///      a sidecar. Tauri's bundler places it next to the main
///      `MyOwnLLM` executable in the `.app` / `.deb` / `.msi`. End
///      users never need to install MyOwnMesh separately.
///   2. `MYOWNLLM_MESH_BIN` env var (LLM-specific override).
///   3. `MYOWNMESH_BIN` env var (shared with MyOwnMesh GUI's convention).
///   4. `myownmesh` (or `myownmesh.exe`) on `$PATH`.
///   5. Workspace dev artefacts (sibling MyOwnMesh checkout's
///      `target/{debug,release}/`) — only relevant in dev when the
///      sidecar wasn't bundled (e.g. `MYOWNLLM_SKIP_SIDECAR=1`).
pub fn find_daemon_binary() -> Result<PathBuf> {
    let exe = if cfg!(windows) {
        "myownmesh.exe"
    } else {
        "myownmesh"
    };

    // 1. Bundled sidecar. Tauri 2 places sidecar binaries next to
    //    the main executable, renamed to drop the `-<triple>`
    //    suffix (Tauri's `externalBin` convention). So
    //    `<exe_dir>/myownmesh{.exe}` is the post-bundle location
    //    on every supported platform. macOS `.app` bundles, Linux
    //    `.deb`, and Windows `.msi` all land it in the same dir
    //    as the main exe — one join covers all three.
    //
    //    Zero-byte placeholders (written by `build.rs` when the
    //    daemon fetch was skipped) are treated as "not bundled"
    //    and we fall through to the next path so dev iteration
    //    still finds a working binary via PATH / workspace.
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidate = exe_dir.join(exe);
            if candidate.exists() {
                let usable = std::fs::metadata(&candidate)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false);
                if usable {
                    return Ok(candidate);
                }
            }
        }
    }

    // 2 + 3. Explicit env-var overrides.
    for var in ["MYOWNLLM_MESH_BIN", "MYOWNMESH_BIN"] {
        if let Ok(p) = std::env::var(var) {
            let p = PathBuf::from(p);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    // 4. PATH lookup.
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // 5. Dev fallback — sibling MyOwnMesh checkout's `target/`.
    //    Only relevant when the sidecar wasn't bundled (e.g.
    //    `MYOWNLLM_SKIP_SIDECAR=1` for offline iteration).
    let mut candidates: Vec<PathBuf> = Vec::new();
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for profile in ["debug", "release"] {
        candidates.push(manifest.join("target").join(profile).join(exe));
        if let Some(parent) = manifest.parent() {
            candidates.push(parent.join("target").join(profile).join(exe));
            if let Some(grandparent) = parent.parent() {
                candidates.push(
                    grandparent
                        .join("MyOwnMesh")
                        .join("target")
                        .join(profile)
                        .join(exe),
                );
            }
        }
    }
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }
    Err(anyhow!(
        "couldn't find `{exe}` — the daemon sidecar wasn't bundled and no fallback \
         binary is on PATH. Re-run the LLM build with network access so `build.rs` \
         can fetch myownmesh, or set MYOWNLLM_MESH_BIN to a pre-built binary."
    ))
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
    // 2. Own-LLM mode: existing daemon at ~/.myownllm/daemon.sock?
    if let Some(client) = probe(DaemonMode::OwnLlm).await {
        eprintln!(
            "daemon: attached to existing own-LLM daemon at {}",
            client.socket_display()
        );
        return Ok((client, None));
    }
    // 3. No daemon up — spawn our own with MYOWNMESH_HOME=~/.myownllm
    //    so it reads/writes the LLM's existing on-disk layout.
    let bin = find_daemon_binary().context("locate myownmesh binary")?;
    let home = dirs::home_dir().context("no home dir")?.join(".myownllm");
    eprintln!(
        "daemon: spawning own-LLM daemon: bin={} home={}",
        bin.display(),
        home.display()
    );

    let child = Command::new(&bin)
        .arg("serve")
        .env("MYOWNMESH_HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("spawn {}", bin.display()))?;
    let handle = DaemonChild { child: Some(child) };

    // Wait for the control socket. Up to 8s is plenty even on a
    // cold-cache debug build.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(client) = probe(DaemonMode::OwnLlm).await {
            eprintln!("daemon: own-LLM daemon up");
            return Ok((client, Some(handle)));
        }
    }
    // Daemon may still be coming up — return the child handle so the
    // app retry loop can wait it out.
    eprintln!(
        "daemon: own-LLM daemon did not respond within 8s; leaving child running and continuing"
    );
    Ok((ControlClient::for_mode(DaemonMode::OwnLlm)?, Some(handle)))
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
