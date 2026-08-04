import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type LifecycleEvent =
  | "restart_detected"
  | "startup"
  | "stdio_connected"
  | "stdin_end"
  | "stdin_close"
  | "uncaught_exception"
  | "unhandled_rejection"
  | "process_exit";

interface LifecycleEntry {
  ts: string;
  event: LifecycleEvent;
  pid: number;
  ppid: number;
  session_id: string;
  details?: Record<string, unknown>;
}

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STATE_DIR = path.join(HARNESS_ROOT, "runtime", "state");
const STATE_DIR = process.env.HARNESS_STATE_DIR ?? DEFAULT_STATE_DIR;
const LIFECYCLE_LOG = process.env.HARNESS_LIFECYCLE_LOG ?? path.join(STATE_DIR, "harness_lifecycle.jsonl");
const MAX_BYTES = (() => {
  const configured = Number(process.env.HARNESS_LIFECYCLE_LOG_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 1024 * 1024;
})();
const BACKUP_KEEP = 3;

let installed = false;

export function getLifecycleLogPath(): string {
  return LIFECYCLE_LOG;
}

function sanitizeDiagnostic(value: unknown, maxLength: number): string {
  const text = value instanceof Error ? value.message : String(value ?? "unknown error");
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:mwa|sk|api)[_-][A-Za-z0-9._~-]{12,}\b/gi, "[redacted]")
    .slice(0, maxLength);
}

function pruneBackups(): void {
  try {
    const directory = path.dirname(LIFECYCLE_LOG);
    const base = path.basename(LIFECYCLE_LOG);
    const backups = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak"))
      .map((name) => {
        const fullPath = path.join(directory, name);
        return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const stale of backups.slice(BACKUP_KEEP)) {
      fs.unlinkSync(stale.fullPath);
    }
  } catch {
    // Diagnostics must never bring down the MCP server.
  }
}

function rotateIfNeeded(): void {
  if (!fs.existsSync(LIFECYCLE_LOG) || fs.statSync(LIFECYCLE_LOG).size <= MAX_BYTES) return;
  fs.renameSync(LIFECYCLE_LOG, `${LIFECYCLE_LOG}.${Date.now()}.bak`);
  pruneBackups();
}

function appendLifecycle(event: LifecycleEvent, details?: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(LIFECYCLE_LOG), { recursive: true });
    rotateIfNeeded();
    const entry: LifecycleEntry = {
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      ppid: process.ppid,
      session_id: process.env.HARNESS_SESSION_ID ?? "unknown",
      ...(details ? { details } : {}),
    };
    fs.appendFileSync(LIFECYCLE_LOG, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    console.error(`[harness] lifecycle log error: ${sanitizeDiagnostic(error, 500)}`);
  }
}

function readPreviousEntry(): LifecycleEntry | null {
  try {
    if (!fs.existsSync(LIFECYCLE_LOG)) return null;
    const lines = fs.readFileSync(LIFECYCLE_LOG, "utf-8").trim().split(/\r?\n/);
    if (!lines.length || !lines[lines.length - 1]) return null;
    return JSON.parse(lines[lines.length - 1]) as LifecycleEntry;
  } catch {
    return null;
  }
}

export function installLifecycleDiagnostics(): void {
  if (installed) return;
  installed = true;

  const previous = readPreviousEntry();
  if (previous && previous.pid !== process.pid) {
    appendLifecycle("restart_detected", {
      previous_pid: previous.pid,
      previous_event: previous.event,
      previous_ts: previous.ts,
      previous_clean_exit: previous.event === "process_exit",
    });
  }
  appendLifecycle("startup", { node: process.version, platform: process.platform });

  process.stdin.once("end", () => appendLifecycle("stdin_end"));
  process.stdin.once("close", () => appendLifecycle("stdin_close"));
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    appendLifecycle(origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception", {
      origin,
      name: error.name,
      message: sanitizeDiagnostic(error, 2000),
      stack: sanitizeDiagnostic(error.stack ?? error, 8000),
    });
  });
  process.once("exit", (code) => appendLifecycle("process_exit", { code }));
}

export function markStdioConnected(): void {
  appendLifecycle("stdio_connected");
}
