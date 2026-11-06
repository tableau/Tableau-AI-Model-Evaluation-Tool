/**
 * Platform sleep inhibitor: keeps the host awake during active evaluations.
 *
 * A paused laptop is fine — the run auto-pauses and resumes — but an
 * *unintentional* idle-sleep mid-suite wastes hours, so runs hold a sleep
 * inhibitor: `caffeinate` on macOS, `systemd-inhibit` on Linux. All
 * best-effort: on any failure the run proceeds without the inhibitor.
 *
 * Windows:
 * Bind `SetThreadExecutionState` in `kernel32.dll` via `bun:ffi`: acquire sets
 * `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` and `release()` restores `ES_CONTINUOUS`
 * alone. If FFI is unavailable for any reason the
 * inhibitor degrades to a no-op so the run still proceeds without the wake lock.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** A held sleep inhibitor. `release()` is idempotent and never throws. */
export interface SleepInhibitor {
  release(): void;
}

const NOOP_INHIBITOR: SleepInhibitor = { release() {} };

// Win32 SetThreadExecutionState flags (see winbase.h). EXECUTION_STATE is a
// DWORD (u32). JS bitwise OR is signed 32-bit, so `0x80000000 | 0x1` yields a
// negative number; `>>> 0` reinterprets it as the intended unsigned value.
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_HOLD = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0;
const ES_RELEASE = ES_CONTINUOUS >>> 0;

/**
 * Windows inhibitor via `bun:ffi` -> `kernel32!SetThreadExecutionState`. Sets
 * `ES_CONTINUOUS | ES_SYSTEM_REQUIRED` to hold the wake lock; `release()`
 * restores `ES_CONTINUOUS` alone and closes the library. Returns a no-op handle
 * if FFI/`dlopen` is unavailable. Never throws.
 */
function inhibitSleepWindows(): SleepInhibitor {
  try {
    // Lazy require so non-Windows platforms never touch bun:ffi.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("kernel32.dll", {
      SetThreadExecutionState: {
        args: [FFIType.u32],
        returns: FFIType.u32,
      },
    });
    const setState = lib.symbols.SetThreadExecutionState;
    // A zero return means the call failed; treat as unavailable.
    if (setState(ES_HOLD) === 0) {
      try {
        lib.close();
      } catch {
        /* best-effort */
      }
      return NOOP_INHIBITOR;
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          setState(ES_RELEASE);
        } catch {
          /* best-effort */
        }
        try {
          lib.close();
        } catch {
          /* best-effort */
        }
      },
    };
  } catch {
    return NOOP_INHIBITOR;
  }
}

/**
 * Unix inhibitor: spawn a long-lived helper process (`caffeinate` /
 * `systemd-inhibit`) that holds the wake lock until `release()` kills it.
 * Returns a no-op handle if the spawn throws synchronously. Never throws.
 */
function inhibitSleepUnix(cmd: string, args: string[]): SleepInhibitor {
  let proc: ChildProcess;
  try {
    proc = spawn(cmd, args, { stdio: "ignore", detached: false });
  } catch {
    return NOOP_INHIBITOR;
  }
  // If the binary is missing, spawn emits 'error' asynchronously; swallow it
  // so an unavailable inhibitor never crashes the run.
  proc.on("error", () => {
    /* best-effort: inhibitor unavailable, continue without it */
  });

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Acquire a best-effort sleep inhibitor for the platform. Returns a handle
 * whose `release()` tears it down. Never throws — any failure yields a no-op
 * handle so the run proceeds without the inhibitor.
 */
export function inhibitSleep(): SleepInhibitor {
  switch (process.platform) {
    case "win32":
      return inhibitSleepWindows();
    case "darwin":
      return inhibitSleepUnix("caffeinate", ["-i"]);
    case "linux":
      return inhibitSleepUnix("systemd-inhibit", [
        "--what=idle:sleep",
        "--why=Tableau AI Model Evaluation Tool run",
        "sleep",
        "infinity",
      ]);
    default:
      // Unknown platform: no known inhibitor mechanism, proceed without one.
      return NOOP_INHIBITOR;
  }
}
