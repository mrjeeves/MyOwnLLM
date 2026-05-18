//! Backend for the agent loop's general-purpose tools: shell execution,
//! file read, file write. These power the `shell`, `read_file`, and
//! `write_file` tools the model can call from chat.
//!
//! Safety stance for this revision: we run as the installed user (root
//! on the headless setups we're targeting today) and don't add a
//! per-command allowlist or path sandbox. The chat is in front of a
//! human who's explicitly typing the request; tool calls render as
//! pills in the transcript so destructive actions are visible. A
//! follow-up will add sandboxing / sudo elevation as needed.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Hard cap on captured output bytes per stream. A model that calls
/// `cat /dev/urandom` shouldn't be able to OOM the WebView; we truncate
/// past this and annotate the result so the model knows the output was
/// trimmed.
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// Default per-command timeout when the caller doesn't pass one. Long
/// enough for an `apt-get install` over a slow link, short enough that
/// a hung command doesn't park the chat forever.
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Hard ceiling on per-call timeout. Stops a confused model from
/// asking for a 24-hour timeout and parking the loop.
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// Default cap on bytes returned by `agent_read_file`. Tunable per-call
/// via `max_bytes` but capped at `MAX_READ_BYTES` regardless.
const DEFAULT_READ_BYTES: u64 = 1024 * 1024;
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

/// Outcome of one shell invocation. Mirrored to TS via serde so the
/// agent's tool result is shaped sensibly for the model.
#[derive(Debug, Serialize)]
pub struct ShellOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    /// True when stdout was truncated at `MAX_OUTPUT_BYTES`.
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    /// True when the wall-clock budget tripped and we killed the
    /// child. `exit_code` will be `None` in that case (we didn't get
    /// a clean exit) and any captured-so-far output is still returned.
    pub timed_out: bool,
}

/// Run `command` through the platform's shell (`sh -c` on Unix,
/// `cmd /C` on Windows) and return captured stdout / stderr / exit.
/// Going through a shell lets the model write natural one-liners
/// (pipes, redirects, `&&`) without us having to parse argv ourselves.
#[tauri::command]
pub async fn agent_shell(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ShellOutcome, String> {
    run_shell_inner(command, cwd, timeout_ms)
        .await
        .map_err(|e| e.to_string())
}

async fn run_shell_inner(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<ShellOutcome> {
    if command.trim().is_empty() {
        return Err(anyhow!("command must be non-empty"));
    }
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    );

    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    if let Some(dir) = cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().context("spawn shell")?;
    let mut stdout_h = child.stdout.take().context("take stdout")?;
    let mut stderr_h = child.stderr.take().context("take stderr")?;

    // Drain in parallel so a child that pipes a lot of stderr while
    // we're only reading stdout (or vice versa) doesn't deadlock on
    // the kernel pipe buffer.
    let stdout_task = tokio::spawn(async move { read_capped(&mut stdout_h).await });
    let stderr_task = tokio::spawn(async move { read_capped(&mut stderr_h).await });

    let status_fut = child.wait();
    let timed_out;
    let status_opt;
    match tokio::time::timeout(timeout, status_fut).await {
        Ok(Ok(status)) => {
            timed_out = false;
            status_opt = Some(status);
        }
        Ok(Err(e)) => return Err(anyhow!("wait child: {e}")),
        Err(_) => {
            timed_out = true;
            // Don't unwrap — child is `mut`-borrowed above; instead
            // signal via `start_kill` and `wait` for the reaper.
            let _ = child.start_kill();
            let _ = child.wait().await;
            status_opt = None;
        }
    }

    let (stdout, stdout_truncated) = stdout_task
        .await
        .map_err(|e| anyhow!("stdout join: {e}"))??;
    let (stderr, stderr_truncated) = stderr_task
        .await
        .map_err(|e| anyhow!("stderr join: {e}"))??;

    Ok(ShellOutcome {
        stdout,
        stderr,
        exit_code: status_opt.and_then(|s| s.code()),
        stdout_truncated,
        stderr_truncated,
        timed_out,
    })
}

/// Read up to `MAX_OUTPUT_BYTES` from a piped child stream, signalling
/// truncation when the limit is hit. Bytes past the limit are dropped
/// rather than buffered — keeps memory bounded even when a child
/// floods the pipe.
async fn read_capped<R>(reader: &mut R) -> Result<(String, bool)>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut tmp = [0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut tmp).await.context("read stream")?;
        if n == 0 {
            break;
        }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(buf.len());
        if remaining == 0 {
            truncated = true;
            // Keep draining so the writer doesn't block on a full pipe.
            continue;
        }
        let take = n.min(remaining);
        buf.extend_from_slice(&tmp[..take]);
        if take < n {
            truncated = true;
        }
    }
    // Lossy decode so binary output doesn't kill the whole call — the
    // model gets readable approximations, the exit code, and the
    // `*_truncated` flag for context.
    Ok((String::from_utf8_lossy(&buf).into_owned(), truncated))
}

#[derive(Debug, Serialize)]
pub struct ReadFileOutcome {
    pub content: String,
    pub bytes_returned: u64,
    /// True when the file was longer than `max_bytes` and we only
    /// returned the leading slice.
    pub truncated: bool,
    /// Total on-disk file size when we can stat it. None for files we
    /// can't stat (named pipes, devices, etc.).
    pub total_bytes: Option<u64>,
}

/// Read a text file and return its contents (UTF-8 lossy). Caps at
/// `max_bytes` to keep huge logs from blowing the chat context.
#[tauri::command]
pub async fn agent_read_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<ReadFileOutcome, String> {
    read_file_inner(path, max_bytes)
        .await
        .map_err(|e| e.to_string())
}

async fn read_file_inner(path: String, max_bytes: Option<u64>) -> Result<ReadFileOutcome> {
    let cap = max_bytes.unwrap_or(DEFAULT_READ_BYTES).min(MAX_READ_BYTES);
    if cap == 0 {
        return Err(anyhow!("max_bytes must be > 0"));
    }
    let path_buf = PathBuf::from(&path);
    let metadata = tokio::fs::metadata(&path_buf).await.ok();
    let total_bytes = metadata.as_ref().map(|m| m.len());
    let bytes = tokio::fs::read(&path_buf)
        .await
        .with_context(|| format!("read {path}"))?;
    let cap_usize: usize = cap.try_into().unwrap_or(usize::MAX);
    let (slice, truncated) = if bytes.len() > cap_usize {
        (&bytes[..cap_usize], true)
    } else {
        (&bytes[..], false)
    };
    Ok(ReadFileOutcome {
        content: String::from_utf8_lossy(slice).into_owned(),
        bytes_returned: slice.len() as u64,
        truncated,
        total_bytes,
    })
}

#[derive(Debug, Serialize)]
pub struct WriteFileOutcome {
    pub path: String,
    pub bytes_written: u64,
    pub created_dirs: bool,
}

/// Write `content` to `path`. Creates parent directories by default
/// — the model usually wants "make this file at this location" without
/// having to chain a separate mkdir call.
#[tauri::command]
pub async fn agent_write_file(
    path: String,
    content: String,
    create_dirs: Option<bool>,
    append: Option<bool>,
) -> Result<WriteFileOutcome, String> {
    write_file_inner(
        path,
        content,
        create_dirs.unwrap_or(true),
        append.unwrap_or(false),
    )
    .await
    .map_err(|e| e.to_string())
}

async fn write_file_inner(
    path: String,
    content: String,
    create_dirs: bool,
    append: bool,
) -> Result<WriteFileOutcome> {
    let path_buf = PathBuf::from(&path);
    let mut created_dirs = false;
    if create_dirs {
        if let Some(parent) = path_buf.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .with_context(|| format!("mkdir {}", parent.display()))?;
                created_dirs = true;
            }
        }
    }
    let bytes = content.as_bytes();
    if append {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path_buf)
            .await
            .with_context(|| format!("open {path} for append"))?;
        f.write_all(bytes)
            .await
            .with_context(|| format!("append to {path}"))?;
        f.flush().await.ok();
    } else {
        tokio::fs::write(&path_buf, bytes)
            .await
            .with_context(|| format!("write {path}"))?;
    }
    Ok(WriteFileOutcome {
        path,
        bytes_written: bytes.len() as u64,
        created_dirs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Per-test temp dir under `/tmp`. Mirrors the helper in
    /// `self_update.rs` so we don't pull in `tempfile` just for two
    /// roundtrip tests.
    fn tempdir(label: &str) -> PathBuf {
        let unix_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{label}-{}-{unix_secs}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn shell_captures_stdout_and_exit() {
        let out = run_shell_inner("echo hello".to_string(), None, Some(5_000))
            .await
            .unwrap();
        assert!(out.stdout.contains("hello"));
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
    }

    // The stderr-split and timeout tests use shell idioms that differ
    // between POSIX sh and Windows cmd. Rather than write two parallel
    // tests, gate the Unix-idiomatic ones to Unix CI — the shell capture
    // pipeline is platform-independent (the cfg!(windows) branch in
    // run_shell_inner just picks the launcher), so the
    // `shell_captures_stdout_and_exit` test above still exercises the
    // Windows path end-to-end.
    #[cfg(unix)]
    #[tokio::test]
    async fn shell_separates_stderr() {
        let out = run_shell_inner(
            "echo out; echo err 1>&2; exit 3".to_string(),
            None,
            Some(5_000),
        )
        .await
        .unwrap();
        assert!(out.stdout.contains("out"));
        assert!(out.stderr.contains("err"));
        assert_eq!(out.exit_code, Some(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn shell_times_out() {
        let out = run_shell_inner("sleep 5".to_string(), None, Some(200))
            .await
            .unwrap();
        assert!(out.timed_out);
        assert!(out.exit_code.is_none());
    }

    // Windows-only variants of the two tests above so the timeout +
    // stderr paths still get coverage on the Windows CI runner.
    //
    // Choices that landed after a CI failure round-trip:
    //
    //   - Use plain `exit 3`, not `exit /b 3`. `/b` is documented to
    //     "exit batch", and from a `cmd /C` invocation it doesn't
    //     always set the parent cmd's exit code the way you'd hope —
    //     the value can come back as 1 instead of 3. Plain `exit N`
    //     is unambiguous.
    //   - Use `ping 127.0.0.1 -n 6 > NUL` as the sleep, not
    //     `timeout /t 5 /nobreak`. `timeout.exe` refuses to run when
    //     stdin is redirected (we wire `Stdio::null()`), printing
    //     "ERROR: Input redirection is not supported, exiting the
    //     process immediately." and exiting in <1ms — which makes
    //     the surrounding `tokio::time::timeout` wrapper see a fast
    //     exit rather than a timeout. `ping` doesn't care about
    //     stdin and runs ~1 s per echo, so 6 echoes ≈ 5 s of
    //     wall-clock — well past the 200 ms test budget below.
    #[cfg(windows)]
    #[tokio::test]
    async fn shell_separates_stderr_windows() {
        let out = run_shell_inner(
            "echo out & echo err 1>&2 & exit 3".to_string(),
            None,
            Some(5_000),
        )
        .await
        .unwrap();
        assert!(out.stdout.contains("out"));
        assert!(out.stderr.contains("err"));
        assert_eq!(out.exit_code, Some(3));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn shell_times_out_windows() {
        let out = run_shell_inner("ping 127.0.0.1 -n 6 > NUL".to_string(), None, Some(200))
            .await
            .unwrap();
        assert!(out.timed_out);
        assert!(out.exit_code.is_none());
    }

    #[tokio::test]
    async fn shell_rejects_empty_command() {
        assert!(run_shell_inner("   ".to_string(), None, Some(1_000))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn read_write_roundtrip() {
        let dir = tempdir("agent-io-rw");
        let path = dir.join("sub").join("file.txt");
        let path_s = path.to_string_lossy().into_owned();
        let w = write_file_inner(path_s.clone(), "hello\nworld".into(), true, false)
            .await
            .unwrap();
        assert_eq!(w.bytes_written, 11);
        assert!(w.created_dirs);
        let r = read_file_inner(path_s.clone(), None).await.unwrap();
        assert_eq!(r.content, "hello\nworld");
        assert!(!r.truncated);
        assert_eq!(r.bytes_returned, 11);
        // Append path
        write_file_inner(path_s.clone(), "!".into(), false, true)
            .await
            .unwrap();
        let r2 = read_file_inner(path_s.clone(), None).await.unwrap();
        assert_eq!(r2.content, "hello\nworld!");
    }

    #[tokio::test]
    async fn read_truncates_at_max_bytes() {
        let dir = tempdir("agent-io-trunc");
        let path = dir.join("big.txt");
        let path_s = path.to_string_lossy().into_owned();
        let payload = "x".repeat(100);
        write_file_inner(path_s.clone(), payload, true, false)
            .await
            .unwrap();
        let r = read_file_inner(path_s, Some(20)).await.unwrap();
        assert!(r.truncated);
        assert_eq!(r.bytes_returned, 20);
    }
}
