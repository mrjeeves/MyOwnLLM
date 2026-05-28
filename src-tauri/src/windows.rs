// Windows-only Win32 helpers.
//
// Two things this module exists to fix:
//
// 1. The release binary uses `windows_subsystem = "windows"` (GUI subsystem)
//    so a console window doesn't flash when the GUI launches from Explorer.
//    The cost is that cmd.exe / PowerShell don't get any stdio handles when
//    they invoke `myownllm.exe` for a CLI command — every println!/eprintln!
//    silently goes to the bit bucket. AttachConsole(ATTACH_PARENT_PROCESS) +
//    SetStdHandle re-points stdio at the parent shell, which has to happen
//    BEFORE the std streams are first touched (Rust caches the OS handle on
//    first access).
//
// 2. `wmic` is deprecated and not present by default on modern Windows 10/11,
//    so the previous wmic-based RAM and disk detection fell through to the
//    placeholder values (8 GB / 50 GB). GlobalMemoryStatusEx and
//    GetDiskFreeSpaceExA have been in the Win32 API since Win2000 and need
//    no extra dependencies.

use std::ffi::c_void;

type Dword = u32;
type Bool = i32;
type Handle = *mut c_void;

const ATTACH_PARENT_PROCESS: Dword = 0xFFFF_FFFF;
const STD_INPUT_HANDLE: Dword = 0xFFFF_FFF6; // (DWORD)-10
const STD_OUTPUT_HANDLE: Dword = 0xFFFF_FFF5; // (DWORD)-11
const STD_ERROR_HANDLE: Dword = 0xFFFF_FFF4; // (DWORD)-12
const GENERIC_READ: Dword = 0x8000_0000;
const GENERIC_WRITE: Dword = 0x4000_0000;
const FILE_SHARE_READ: Dword = 0x0000_0001;
const FILE_SHARE_WRITE: Dword = 0x0000_0002;
const OPEN_EXISTING: Dword = 3;
const INVALID_HANDLE_VALUE: Handle = !0usize as Handle;

#[repr(C)]
struct MemoryStatusEx {
    dw_length: Dword,
    dw_memory_load: Dword,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

extern "system" {
    fn AttachConsole(dw_process_id: Dword) -> Bool;
    fn SetStdHandle(n_std_handle: Dword, h_handle: Handle) -> Bool;
    fn CreateFileA(
        lp_file_name: *const u8,
        dw_desired_access: Dword,
        dw_share_mode: Dword,
        lp_security_attributes: *mut c_void,
        dw_creation_disposition: Dword,
        dw_flags_and_attributes: Dword,
        h_template_file: Handle,
    ) -> Handle;
    fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> Bool;
    fn GetDiskFreeSpaceExA(
        lp_directory_name: *const u8,
        lp_free_bytes_available_to_caller: *mut u64,
        lp_total_number_of_bytes: *mut u64,
        lp_total_number_of_free_bytes: *mut u64,
    ) -> Bool;
}

/// Attach to the parent console (cmd.exe, PowerShell, Windows Terminal) and
/// rewire stdio so subsequent println!/eprintln!/stdin reach the launching
/// shell. Safe to call unconditionally — when there is no parent console
/// (e.g. launched from Explorer) AttachConsole returns 0 and stdio is left
/// alone.
///
/// Must be called BEFORE any code reads or writes stdout/stdin/stderr.
pub fn attach_parent_console() {
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        let conout = open_console(b"CONOUT$\0");
        if !conout.is_null() && conout != INVALID_HANDLE_VALUE {
            SetStdHandle(STD_OUTPUT_HANDLE, conout);
            SetStdHandle(STD_ERROR_HANDLE, conout);
        }
        let conin = open_console(b"CONIN$\0");
        if !conin.is_null() && conin != INVALID_HANDLE_VALUE {
            SetStdHandle(STD_INPUT_HANDLE, conin);
        }
    }
}

unsafe fn open_console(name: &[u8]) -> Handle {
    CreateFileA(
        name.as_ptr(),
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        std::ptr::null_mut(),
        OPEN_EXISTING,
        0,
        std::ptr::null_mut(),
    )
}

pub fn total_physical_memory_bytes() -> Option<u64> {
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as Dword,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    Some(status.ull_total_phys)
}

pub fn disk_free_bytes(path: &str) -> Option<u64> {
    let mut buf = Vec::with_capacity(path.len() + 1);
    buf.extend_from_slice(path.as_bytes());
    buf.push(0);
    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut total_free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExA(
            buf.as_ptr(),
            &mut free_to_caller,
            &mut total,
            &mut total_free,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(free_to_caller)
    }
}

// ---------------------------------------------------------------------------
// Job Object — used to guarantee the daemon child dies with the LLM.
//
// On Windows, killing a parent process via Ctrl-C / taskkill / window-close
// doesn't propagate to spawned children. Standard `Drop::kill()` on the
// `Child` handle only fires for graceful exits. The right primitive is a
// Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: when the parent
// process dies (any way), the OS reclaims its handles, the Job closes,
// and every member is terminated.
//
// The job handle MUST stay alive for the lifetime of the LLM process. We
// leak it intentionally — when the process exits, Windows GCs it.
// ---------------------------------------------------------------------------

const PROCESS_TERMINATE: Dword = 0x0001;
const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
const STILL_ACTIVE: Dword = 259;
const TH32CS_SNAPPROCESS: Dword = 0x0000_0002;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;

#[repr(C)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: Dword,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: Dword,
    affinity: usize,
    priority_class: Dword,
    scheduling_class: Dword,
}

#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic_limit_information: JobObjectBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[repr(C)]
struct ProcessEntry32W {
    dw_size: Dword,
    cnt_usage: Dword,
    th32_process_id: Dword,
    th32_default_heap_id: usize,
    th32_module_id: Dword,
    cnt_threads: Dword,
    th32_parent_process_id: Dword,
    pc_pri_class_base: i32,
    dw_flags: Dword,
    sz_exe_file: [u16; 260],
}

extern "system" {
    fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> Handle;
    fn SetInformationJobObject(
        h_job: Handle,
        job_object_information_class: i32,
        lp_job_object_information: *mut c_void,
        cb_job_object_information_length: Dword,
    ) -> Bool;
    fn AssignProcessToJobObject(h_job: Handle, h_process: Handle) -> Bool;
    fn OpenProcess(
        dw_desired_access: Dword,
        b_inherit_handle: Bool,
        dw_process_id: Dword,
    ) -> Handle;
    fn GetExitCodeProcess(h_process: Handle, lp_exit_code: *mut Dword) -> Bool;
    fn CloseHandle(h_object: Handle) -> Bool;
    fn GetCurrentProcessId() -> Dword;
    fn CreateToolhelp32Snapshot(dw_flags: Dword, th32_process_id: Dword) -> Handle;
    fn Process32FirstW(h_snapshot: Handle, lppe: *mut ProcessEntry32W) -> Bool;
    fn Process32NextW(h_snapshot: Handle, lppe: *mut ProcessEntry32W) -> Bool;
}

/// Build a Job Object with `KILL_ON_JOB_CLOSE` set and assign the
/// given child process handle to it. The returned handle is the job
/// — keep it alive for the lifetime of the LLM. Dropping it would
/// kill the job (and its members) immediately; leaking it is the
/// right move so cleanup is tied to process exit, not Drop order.
///
/// Returns `None` if any Win32 call fails (job assignment is
/// best-effort — if it falls through, Drop-based cleanup is the
/// fallback).
pub fn assign_to_kill_on_close_job(child_process_handle: *mut c_void) -> Option<*mut c_void> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JobObjectExtendedLimitInformation = std::mem::zeroed();
        info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JobObjectExtendedLimitInformation>() as Dword,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, child_process_handle) == 0 {
            CloseHandle(job);
            return None;
        }
        Some(job)
    }
}

// ---------------------------------------------------------------------------
// Parent-PID watchdog — used to make `tauri dev` / `cargo run` Ctrl-C
// actually kill the LLM.
//
// Tauri windowed apps detach from the terminal's console, so a Ctrl-C in
// the shell that started `cargo run` reaches cargo but NOT the LLM. The
// LLM keeps running after the terminal closes. This is what was leaving
// orphaned `myownllm.exe` processes around between `just dev` runs.
//
// The fix: at startup, find our parent PID (cargo). Spawn a thread that
// polls every second; if the parent process no longer exists, exit. Drop
// + RunEvent::Exit then fire normally, the daemon child dies via the Job
// Object above, every file handle is released, and the next `just dev`
// has a clean slate.
// ---------------------------------------------------------------------------

/// Walk the process snapshot to find our parent PID. Returns None
/// if the snapshot fails or we can't find ourselves (shouldn't
/// happen on a live process).
fn parent_pid() -> Option<Dword> {
    unsafe {
        let our_pid = GetCurrentProcessId();
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as Dword;
        let mut found: Option<Dword> = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32_process_id == our_pid {
                    found = Some(entry.th32_parent_process_id);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

/// Open a process handle for liveness polling.
fn open_parent(pid: Dword) -> Option<Handle> {
    unsafe {
        let h = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            pid,
        );
        if h.is_null() {
            None
        } else {
            Some(h)
        }
    }
}

fn process_is_alive(handle: Handle) -> bool {
    unsafe {
        let mut code: Dword = 0;
        if GetExitCodeProcess(handle, &mut code) == 0 {
            return false;
        }
        code == STILL_ACTIVE
    }
}

/// Install the parent-PID watchdog. Spawns a daemon thread that
/// polls the parent (cargo / tauri-dev / etc.) every second and
/// calls `std::process::exit(0)` when it sees the parent gone.
///
/// Idempotent: safe to call once at startup. The thread is
/// detached and runs for the lifetime of the LLM process.
///
/// Skips installation when:
/// - We can't find our parent (e.g. parent is `services.exe` for
///   a Windows service install — in that case there's nothing
///   useful to watch).
/// - The parent's image name is `explorer.exe` (interactive
///   launch from File Explorer; we never want to die just
///   because Explorer hiccuped).
pub fn install_parent_watchdog() {
    let Some(ppid) = parent_pid() else {
        return;
    };
    // Walk the snapshot again to read the parent's image name so
    // we can skip the watchdog for Explorer-launched runs.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if !snapshot.is_null() && snapshot != INVALID_HANDLE_VALUE {
            let mut entry: ProcessEntry32W = std::mem::zeroed();
            entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as Dword;
            let mut skip = false;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32_process_id == ppid {
                        // Read the NUL-terminated UTF-16 image name.
                        let name = String::from_utf16_lossy(
                            &entry.sz_exe_file
                                [..entry.sz_exe_file.iter().position(|&c| c == 0).unwrap_or(0)],
                        )
                        .to_ascii_lowercase();
                        if name == "explorer.exe" || name == "services.exe" {
                            skip = true;
                        }
                        break;
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snapshot);
            if skip {
                return;
            }
        }
    }

    let Some(handle) = open_parent(ppid) else {
        return;
    };
    let handle_addr = handle as usize;
    std::thread::Builder::new()
        .name("parent-watchdog".into())
        .spawn(move || {
            let handle = handle_addr as Handle;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                if !process_is_alive(handle) {
                    eprintln!("[watchdog] parent pid {ppid} exited — shutting LLM down");
                    // Use exit(0) so Drop + RunEvent::Exit run.
                    // That tears down the daemon child + ollama,
                    // releasing every file handle before the
                    // process actually ends.
                    std::process::exit(0);
                }
            }
        })
        .ok();
}
