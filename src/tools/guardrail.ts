import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CompletionRiskTier,
  COMPLETION_RISK_TIERS,
  normalizeCompletionRiskTier,
  isLocalCompletionTier,
  hasStrongEvidence,
  hasTieredStrongEvidence,
  evidenceIsStrong,
} from "./evidence.js";

const SCRIPT_EXT_GROUP = "py|sh|ts|mjs|cjs|js|ps1|bat|cmd|rb|go|rs";
const SCRIPT_EXEC_VERBS = "실행|통해|사용하여|돌려|동작|구동|기동|호출|호출하여|invok\\w*|ran|run|running|executed|execute|executing|via|using|through";

const SEARCH_ROOTS_DEFAULT = [
  path.join(os.homedir(), ".gemini"),
  path.join(os.homedir(), ".claude"),
  process.cwd(),
];

function getSearchRoots(): string[] {
  const fromEnv = (process.env.HARNESS_SEARCH_ROOTS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  const roots = fromEnv.length ? fromEnv : SEARCH_ROOTS_DEFAULT;
  return roots.filter((r) => {
    try {
      return fs.existsSync(r) && fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "build",
  "dist",
  ".next",
  "target",
  ".cache",
  ".pnpm-store",
]);

function findFileByName(filename: string, roots: string[], maxHits = 3): string[] {
  const hits: string[] = [];
  const target = filename.toLowerCase();
  function walk(dir: string, depth: number) {
    if (hits.length >= maxHits || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (hits.length >= maxHits) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".") && entry.name !== ".gemini" && entry.name !== ".claude") continue;
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase() === target) {
        hits.push(full);
      }
    }
  }
  for (const root of roots) walk(root, 0);
  return hits;
}

type Severity = "CRITICAL" | "HIGH" | "MEDIUM";
// CompletionRiskTier / COMPLETION_RISK_TIERS / normalizeCompletionRiskTier /
// isLocalCompletionTier now live in ./evidence.ts (imported above).

interface Violation {
  rule: string;
  severity: Severity;
  matched: string;
  description: string;
}

interface PatternRule {
  pattern: RegExp;
  rule: string;
  severity: Severity;
  description: string;
}

// MCP natural-language trigger map.
// Loaded at module init from `config/mcp_triggers.json` (relative to harness root).
// Cross-checked against `~/.gemini/antigravity/mcp_config.json` — entries whose
// `mcpServerName` is not currently registered in mcp_config are auto-skipped
// (logged to stderr) to avoid false positives from uninstalled servers.
//
// To add a new trigger: edit config/mcp_triggers.json and restart the MCP server.
// No TypeScript rebuild required.
interface McpTriggerEntry {
  name: string;
  mcpServerName: string;
  keywordPattern: RegExp;
  bypassPattern: RegExp;
  expectedMcpPrefix: string;
  description: string;
}

interface McpTriggerConfigRaw {
  name: string;
  mcpServerName?: string;
  keywordPattern: string;
  bypassPattern: string;
  expectedMcpPrefix: string;
  description: string;
}

// fileURLToPath handles drive letters, spaces, and non-ASCII (e.g. Korean) path
// segments correctly. The former manual `new URL(...).pathname` + regex left
// percent-encodings (%20 / %ED…) in place, which silently broke config loading
// (→ INVARIANT#19 disabled) when the repo lived under such a path. (P3-4)
const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function defaultAntigravityRoot(): string {
  const legacyRoot = path.join(os.homedir(), ".gemini", "antigravity");
  const ideRoot = path.join(os.homedir(), ".gemini", "antigravity-ide");
  const normalizedHarnessRoot = path.normalize(HARNESS_ROOT);

  if (
    normalizedHarnessRoot.split(path.sep).includes("antigravity-ide") &&
    fs.existsSync(ideRoot)
  ) {
    return ideRoot;
  }

  return legacyRoot;
}

const DEFAULT_ANTIGRAVITY_ROOT = defaultAntigravityRoot();
const MCP_TRIGGERS_CONFIG_PATH =
  process.env.HARNESS_MCP_TRIGGERS_CONFIG ?? path.join(HARNESS_ROOT, "config", "mcp_triggers.json");
const GEMINI_SKILL_ROUTES_PATH =
  process.env.HARNESS_SKILL_ROUTES_CONFIG ??
  path.join(os.homedir(), ".codex", "gemini-sync", "generated-routes.json");
const ANTIGRAVITY_MCP_CONFIG = path.join(
  process.env.ANTIGRAVITY_ROOT ?? DEFAULT_ANTIGRAVITY_ROOT,
  "mcp_config.json",
);

function loadRegisteredMcpServers(): Set<string> {
  try {
    const raw = fs.readFileSync(ANTIGRAVITY_MCP_CONFIG, "utf-8");
    const parsed = JSON.parse(raw);
    const names = Object.keys(parsed?.mcpServers ?? {});
    return new Set(names);
  } catch (err) {
    console.error(
      `[harness] could not read ${ANTIGRAVITY_MCP_CONFIG}: ${(err as Error).message}. mcp_config cross-check disabled — all triggers loaded unconditionally.`,
    );
    return new Set();
  }
}

function loadMcpTriggers(): McpTriggerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(MCP_TRIGGERS_CONFIG_PATH, "utf-8");
  } catch (err) {
    console.error(
      `[harness] mcp_triggers.json not found at ${MCP_TRIGGERS_CONFIG_PATH} — INVARIANT#19 disabled. ${(err as Error).message}`,
    );
    return [];
  }

  let parsed: { triggers?: McpTriggerConfigRaw[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[harness] mcp_triggers.json is invalid JSON — INVARIANT#19 disabled. ${(err as Error).message}`,
    );
    return [];
  }

  const registered = loadRegisteredMcpServers();
  const crossCheckDisabled = process.env.HARNESS_MCP_TRIGGERS_NO_CROSS_CHECK === "1";
  const crossCheckEnabled = !crossCheckDisabled && registered.size > 0;
  const out: McpTriggerEntry[] = [];

  for (const t of parsed.triggers ?? []) {
    if (!t.name || !t.keywordPattern || !t.bypassPattern || !t.expectedMcpPrefix) {
      console.error(`[harness] skipping incomplete trigger entry: ${JSON.stringify(t)}`);
      continue;
    }
    const mcpServerName = t.mcpServerName ?? t.name;
    if (crossCheckEnabled && !registered.has(mcpServerName)) {
      console.error(
        `[harness] trigger '${t.name}' references mcpServerName='${mcpServerName}' which is not registered in mcp_config.json — skipped.`,
      );
      continue;
    }
    try {
      out.push({
        name: t.name,
        mcpServerName,
        keywordPattern: new RegExp(t.keywordPattern, "i"),
        bypassPattern: new RegExp(t.bypassPattern, "i"),
        expectedMcpPrefix: t.expectedMcpPrefix,
        description: t.description ?? "",
      });
    } catch (err) {
      console.error(
        `[harness] trigger '${t.name}' has invalid regex — skipped. ${(err as Error).message}`,
      );
    }
  }

  console.error(
    `[harness] loaded ${out.length} MCP trigger(s) from ${MCP_TRIGGERS_CONFIG_PATH} (cross-check ${crossCheckEnabled ? "ON" : "OFF"})`,
  );
  return out;
}

const MCP_TRIGGER_MAP: McpTriggerEntry[] = loadMcpTriggers();

interface SkillRouteEntry {
  keywords: string[];
  skills: string[];
}

function parseSkillRoutesFile(filePath: string, label: string): SkillRouteEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  } catch (err) {
    console.error(
      `[harness] ${label} skill routes not found at ${filePath} — skill-first natural-language routing reduced to explicit skill names. ${(err as Error).message}`,
    );
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => ({
        keywords: Array.isArray(r?.keywords) ? r.keywords.map((x: unknown) => String(x).trim()).filter(Boolean) : [],
        skills: Array.isArray(r?.skills) ? r.skills.map((x: unknown) => String(x).trim()).filter(Boolean) : [],
      }))
      .filter((r) => r.keywords.length > 0 && r.skills.length > 0);
  } catch (err) {
    console.error(
      `[harness] ${label} skill routes invalid JSON — skill-first natural-language routing reduced to explicit skill names. ${(err as Error).message}`,
    );
    return [];
  }
}

// generated-routes.json 은 스킬 동기화 워처가 자동 생성한다. 워처가 누락한 라우트
// (2026-06-11 trace 48ad4493: hermes-naver-publish / hermes-blog-verify 미등록으로
// INVARIANT#25 가 발동 자체가 불가능했던 사례)는 하네스 자체 보충 파일로 항상 보장한다.
const SKILL_ROUTES_SUPPLEMENT_PATH =
  process.env.HARNESS_SKILL_ROUTES_SUPPLEMENT ??
  path.join(HARNESS_ROOT, "config", "skill_routes.supplement.json");

function loadSkillRoutes(): SkillRouteEntry[] {
  return [
    ...parseSkillRoutesFile(GEMINI_SKILL_ROUTES_PATH, "generated"),
    ...parseSkillRoutesFile(SKILL_ROUTES_SUPPLEMENT_PATH, "supplement"),
  ];
}

const SKILL_ROUTE_MAP: SkillRouteEntry[] = loadSkillRoutes();

const ANTIGRAVITY_ROOT =
  process.env.ANTIGRAVITY_ROOT ?? DEFAULT_ANTIGRAVITY_ROOT;
// HARNESS_STATE_DIR 로 상태 디렉토리를 분리할 수 있다(테스트 격리용). 미설정 시
// 기존 동작(<ANTIGRAVITY_ROOT>/state)을 그대로 유지하므로 프로덕션 런타임은 변화 없음.
// 회귀/스모크 테스트가 이 변수를 임시 디렉토리로 주입하면, 테스트의 resetState/append 가
// 더 이상 실제 honest_check_calls.jsonl / honest_check_pending.json 을 삭제·오염하지 않는다.
const STATE_DIR = process.env.HARNESS_STATE_DIR ?? path.join(ANTIGRAVITY_ROOT, "state");
const HONEST_CALL_LOG = path.join(STATE_DIR, "honest_check_calls.jsonl");
// Rotation threshold. Defaults to 5MB; overridable via HARNESS_HONEST_LOG_MAX_BYTES
// so tests can force rotation cheaply (mirrors the HARNESS_STATE_DIR injection).
function resolveHonestLogMaxBytes(): number {
  const raw = Number(process.env.HARNESS_HONEST_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024;
}
const HONEST_CALL_LOG_MAX_BYTES = resolveHonestLogMaxBytes();

interface HonestCallEntry {
  ts: string;
  session_id: string;
  verdict: string;
  violation_count: number;
  violation_rules?: string[];
  claim_hash?: string;
  evidence_hash?: string;
  result_verdict?: "HONEST" | "WEAK" | "DECEPTIVE";
  process_verdict?: "HONEST" | "WEAK" | "DECEPTIVE";
}

// Keep only the newest HONEST_CALL_LOG_BAK_KEEP rotated `.bak` files so the
// state dir doesn't accumulate one backup per rotation forever. (P2-5)
const HONEST_CALL_LOG_BAK_KEEP = 3;
function pruneRotatedLogs(): void {
  try {
    const dir = path.dirname(HONEST_CALL_LOG);
    const base = path.basename(HONEST_CALL_LOG);
    const baks = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of baks.slice(HONEST_CALL_LOG_BAK_KEEP)) {
      try { fs.unlinkSync(stale.full); } catch {}
    }
  } catch {
    /* best-effort cleanup */
  }
}

function logHonestCheckCall(
  sessionId: string,
  verdict: string,
  violationCount: number,
  violationRules: string[] = [],
  claimHashValue?: string,
  evidenceHashValue?: string,
  resultVerdict?: "HONEST" | "WEAK" | "DECEPTIVE",
  processVerdict?: "HONEST" | "WEAK" | "DECEPTIVE",
): void {
  try {
    fs.mkdirSync(path.dirname(HONEST_CALL_LOG), { recursive: true });
    if (fs.existsSync(HONEST_CALL_LOG)) {
      const st = fs.statSync(HONEST_CALL_LOG);
      if (st.size > HONEST_CALL_LOG_MAX_BYTES) {
        fs.renameSync(HONEST_CALL_LOG, HONEST_CALL_LOG + `.${Date.now()}.bak`);
        pruneRotatedLogs(); // P2-5: keep only the newest few .bak rotations
      }
    }
    const entry: HonestCallEntry = {
      ts: new Date().toISOString(),
      session_id: sessionId || "default",
      verdict,
      violation_count: violationCount,
      violation_rules: violationRules.length > 0 ? violationRules.slice(0, 10) : undefined,
      claim_hash: claimHashValue,
      evidence_hash: evidenceHashValue,
      result_verdict: resultVerdict,
      process_verdict: processVerdict,
    };
    fs.appendFileSync(HONEST_CALL_LOG, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error(`[harness] honest_check log error: ${(err as Error).message}`);
  }
}

function readRecentHonestCalls(sessionId: string, windowMinutes: number): HonestCallEntry[] {
  if (!fs.existsSync(HONEST_CALL_LOG)) return [];
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  let raw: string;
  try {
    raw = fs.readFileSync(HONEST_CALL_LOG, "utf-8");
  } catch {
    return [];
  }
  const out: HonestCallEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as HonestCallEntry;
      if (sessionId && obj.session_id !== sessionId) continue;
      const t = Date.parse(obj.ts);
      if (Number.isNaN(t) || t < cutoff) continue;
      out.push(obj);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

const ACTIVE_ALERT_FILES = [
  path.join(STATE_DIR, "ACTIVE_FALSE_COMPLETION_ALERT.md"),
  path.join(STATE_DIR, "ANTIGRAVITY_IDE_GUARD_BLOCK.md"),
  path.join(STATE_DIR, "antigravity_guard_stop.flag"),
  path.join(STATE_DIR, "ACTIVE_HALLUCINATION_ALERT.md"),
];

// Pending confirmation state.
//
// Design (post-codex-review 2026-05-26):
//   - JSON map keyed by session_id (default "default") → per-session isolation
//   - atomic write via temp file + rename to avoid torn writes
//   - .lock file (open with "wx" exclusive) wraps read-modify-write so concurrent
//     MCP clients can't both increment retry_count off the same snapshot
//   - PendingState includes claim_hash (bag-of-words signature) so retry_count
//     only increments when the SAME broad claim is retried, and HONEST verdicts
//     only clear pending if they match the same claim
//   - persistence failures surface as state_error in the response, never silent
//
const HONEST_CHECK_PENDING_PATH = path.join(STATE_DIR, "honest_check_pending.json");
const PENDING_LOCK_PATH = `${HONEST_CHECK_PENDING_PATH}.lock`;
const PENDING_LOCK_MAX_RETRIES = 30;
const PENDING_LOCK_DELAY_MS = 10;
const PENDING_LOCK_STALE_MS = 5000;

// Session id resolution.
// index.ts bootstraps HARNESS_SESSION_ID to `auto-<pid>-<base36ts>` when it's
// unset or literally "default" (pre-fix all calls collapsed into shared "default"
// bucket — pending state collisions across concurrent IDE windows). We still
// guard here so library use outside index.ts isn't broken.
function resolveDefaultSessionId(): string {
  const envSid = process.env.HARNESS_SESSION_ID;
  if (envSid && envSid !== "default") return envSid;
  const auto = `auto-${process.pid}-${Date.now().toString(36)}`;
  console.error(
    `[harness] HARNESS_SESSION_ID resolved to '${auto}' inside guardrail module (was '${envSid ?? "<unset>"}').`,
  );
  return auto;
}
const DEFAULT_SESSION_ID = resolveDefaultSessionId();

// Claim-scoped session block tracking.
// Earlier versions counted ALL non-HONEST honest_check calls in the recent
// window regardless of claim_hash. That prevented infinite retries, but it
// also let one broad failed claim poison a later, narrower claim with fresh
// evidence. Keep the session window, but scope it to the current claim hash.
const SESSION_BLOCK_LIMIT = 3;
const SESSION_BLOCK_WINDOW_MIN = 10;

interface PendingState {
  verdict: "DECEPTIVE" | "WEAK";
  reason: string;
  blocked_summary?: string;
  created_at: string;
  retry_count: number;
  first_blocked_at: string;
  claim_hash: string;
  evidence_hash?: string;
  violation_rules?: string[];
  force_partial_status?: boolean;
  // 2026-07-06 Bug#1 fix: persist user request across retry turns so
  // detectSkillTriggers() can fire INVARIANT#25 even when the model omits
  // user_request on subsequent honest_check calls.
  last_user_request?: string;
}

type PendingStore = Record<string, PendingState>;

const RETRY_LIMIT = 2; // After RETRY_LIMIT same-claim retries, force PARTIAL_STATUS narrowing.

function claimScopeHash(text: string): string {
  const words = (text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 60)
    .sort();
  return crypto.createHash("sha256").update(words.join(" ")).digest("hex").slice(0, 16);
}

function evidenceHash(toolCallLog: string, evidenceOutputs: string[] = []): string {
  const normalized = [toolCallLog, ...evidenceOutputs]
    .join("\n")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function samePendingScope(
  pending: PendingState | null,
  currentClaimHash: string,
  currentEvidenceHash: string,
): boolean {
  if (!pending) return false;
  if (pending.claim_hash === currentClaimHash) return true;
  const emptyEvidenceHash = evidenceHash("", []);
  return (
    currentEvidenceHash !== emptyEvidenceHash &&
    !!pending.evidence_hash &&
    pending.evidence_hash === currentEvidenceHash
  );
}

function sleepSync(ms: number): void {
  // Block for `ms` without spinning the CPU (the former busy-wait pegged a core
  // during lock contention). A private SharedArrayBuffer that is never notified
  // makes Atomics.wait run the full timeout, then return "timed-out". (P3-5)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withPendingLock<T>(fn: () => T): T | null {
  for (let attempt = 0; attempt < PENDING_LOCK_MAX_RETRIES; attempt++) {
    let fd: number;
    try {
      fs.mkdirSync(path.dirname(PENDING_LOCK_PATH), { recursive: true });
      fd = fs.openSync(PENDING_LOCK_PATH, "wx");
    } catch {
      // Lock held — check for stale lock (>STALE_MS old) and clean it up.
      try {
        const stat = fs.statSync(PENDING_LOCK_PATH);
        if (Date.now() - stat.mtimeMs > PENDING_LOCK_STALE_MS) {
          fs.unlinkSync(PENDING_LOCK_PATH);
          continue;
        }
      } catch {
        // Race: lock disappeared mid-check, retry.
      }
      sleepSync(PENDING_LOCK_DELAY_MS);
      continue;
    }
    try {
      return fn();
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(PENDING_LOCK_PATH); } catch {}
    }
  }
  console.error(
    `[harness] could not acquire pending state lock after ${PENDING_LOCK_MAX_RETRIES} attempts`,
  );
  return null;
}

function atomicWriteJson(target: string, data: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(temp, target);
    return true;
  } catch (err) {
    console.error(`[harness] atomic write to ${target} failed: ${(err as Error).message}`);
    return false;
  }
}

function loadPendingStore(): PendingStore {
  try {
    const raw = fs.readFileSync(HONEST_CHECK_PENDING_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Backward-compat: legacy flat PendingState → wrap under "default" session.
    if (parsed && typeof parsed === "object" && "verdict" in parsed && "reason" in parsed) {
      return { default: parsed as PendingState };
    }
    return (parsed ?? {}) as PendingStore;
  } catch {
    return {};
  }
}

function loadSessionPending(session_id: string): PendingState | null {
  const store = loadPendingStore();
  return store[session_id] ?? null;
}

function saveSessionPending(session_id: string, state: PendingState | null): boolean {
  const result = withPendingLock(() => {
    const store = loadPendingStore();
    if (state === null) {
      delete store[session_id];
    } else {
      store[session_id] = state;
    }
    if (Object.keys(store).length === 0) {
      // Empty store → remove file to keep filesystem clean.
      try { fs.unlinkSync(HONEST_CHECK_PENDING_PATH); } catch {}
      return true;
    }
    return atomicWriteJson(HONEST_CHECK_PENDING_PATH, store);
  });
  return result ?? false;
}

function clearSessionPending(session_id: string): boolean {
  return saveSessionPending(session_id, null);
}

// Intent classification for turn_intent_check.
// SESSION_CLOSE_RE matches session-end intent; SESSION_CLOSE_NEG_RE strips
// technical-context phrases like '파일 종료' / '프로세스 종료' / '탭 종료' as well
// as work-transition phrases like '마무리 단계로 가자' that are NOT session-end.
const SESSION_CLOSE_RE = /(?:^|[\s,.])((세션\s*)?(종료|마무리|마무리하자|마무리해|끝|다\s*했어|작업\s*완료|작업\s*다\s*했)|end\s*session|stop\s*session|wrap\s*up|exit\s*session)(?:[\s,.!?]|$)/i;
const SESSION_CLOSE_NEG_RE =
  /(파일|프로세스|process|service|connection|task|컨테이너|container|함수|스레드|thread|클라이언트|client|서버|server|수신|read|stream|소켓|socket|채널|channel|핸들|handle|루프|loop|탭|tab|팝업|popup|창|window|터미널|terminal|pty|child\s*process|job|browser\s*context|세션\s*파일|file\s*handle)\s*(종료|끝|마무리|닫기|close)|마무리\s*(단계|작업|후|할\s*일|할\s*거|할거|짓기|짓자)|마지막\s*단계/i;

// (2026-05-31) Short-reply approve/reject classification removed: the harness no
// longer asks the user 예/아니오 to confirm a blocked completion claim. honest_check
// now auto-retries (model self-corrects + re-calls) until HONEST, then auto-
// decomposes into STATUS: PARTIAL_STATUS — so there is no confirmation reply to
// classify. The destructive-operation risk gate below is unrelated and stays.

// Non-execution context detection: if the user is asking to explain/describe
// a destructive command (not execute it), skip the risk gate.
const NON_EXECUTION_CONTEXT_RE =
  /(설명|explain|예시|example|sample|문서|document(?:ation)?|readme|\.md\b|says?\b|라고\s*(?:되어|적혀|쓰여|나와)|주석|comment|reference|guide|tutorial|샘플|왜\s*위험|어떻게\s*동작|어떻게\s*작동|how\s*(?:does|do|it\s*works)|what\s*(?:is|does)|학습|배우|이해해)/i;

// #9 (Codex review 2026-05-25): when scanning the user_request fallback for
// risk patterns (no draft_action provided), strip fenced code blocks, inline
// code, quoted strings and comment-prefixed lines first. A destructive command
// QUOTED inside a markdown fence or a `# comment` is documentation, not an
// intent to execute — pre-fix `\`\`\`docker volume rm old\`\`\`` false-fired
// destructive_docker. draft_action itself is never stripped (it represents
// genuine execution intent).
function stripRiskNoise(text: string): string {
  return stripCodeAndQuotes(text).replace(/^\s*(?:#|\/\/).*$/gm, "");
}

// Stop-and-ask anti-pattern. Defined ONCE here so honest_check (FLASH_FREEZE)
// and chain_progress_check share the same detector and can't drift apart.
// NOTE (#7, Codex review 2026-05-25): the `이어서` branch must require an
// interrogative/permission suffix (할까요?/해도 될까). Pre-fix it matched the
// bare stems `이어서 진행`/`이어서 작업`, so a DECLARATIVE auto-chain statement
// like "이어서 작업하겠습니다" / "이어서 진행하겠습니다" — exactly the behavior the
// harness WANTS — was false-flagged as FLASH_FREEZE. Only block when the model
// is actually asking for permission to continue.
const STOP_AND_ASK_KO_RE =
  /(계속\s*진행할까요|이어서\s*(진행할까요?|작업할까요?|할까요?|해도\s*될까)|원하시면\s*(다음|이어)|다음\s*(단계|차례|작업)을?\s*(진행|시작|할까|할까요)|(나누어|쪼개어|분할\s*해서)\s*진행|확인\s*후\s*(진행|이어)|승인.*기다|어떻게\s*(할까요|진행할까요)|이어할까|이어가도\s*될까|마저\s*진행할까|진행해도\s*될까요|진행할지\s*알려|이어\s*진행할까요|이어\s*해도\s*될까|진행\s*여부\s*알려)/i;
const STOP_AND_ASK_EN_RE =
  /(sh(?:all|ould)\s+I\s+(continue|proceed)|continue\?|let\s+me\s+know\s+(if|whether|when)|do\s+you\s+want\s+me\s+to|would\s+you\s+like\s+me\s+to)/i;
const STOP_AND_ASK_RE = new RegExp(
  `${STOP_AND_ASK_KO_RE.source}|${STOP_AND_ASK_EN_RE.source}`,
  "i",
);

function detectStopAndAsk(text: string): { rule: string; matched: string }[] {
  const out: { rule: string; matched: string }[] = [];
  const ko = text.match(STOP_AND_ASK_KO_RE);
  if (ko) out.push({ rule: "ko_stop_and_ask", matched: ko[0].slice(0, 60) });
  const en = text.match(STOP_AND_ASK_EN_RE);
  if (en) out.push({ rule: "en_stop_and_ask", matched: en[0].slice(0, 60) });
  return out;
}

// Risk signals — flagged so the model can request approval per CLAUDE.md guards.
const RISK_PATTERNS: { rule: string; pattern: RegExp; reason: string }[] = [
  { rule: "destructive_filesystem", pattern: /(rm\s+-rf|Remove-Item\s+-Recurse\s+-Force|rmdir\s+\/s)/i, reason: "Recursive filesystem deletion" },
  { rule: "destructive_db", pattern: /(DROP\s+TABLE|TRUNCATE|DETACH\s+DELETE|deleteMany\(\{\}\)|drop\(\)|reset\(\))/i, reason: "Destructive database operation" },
  { rule: "destructive_git", pattern: /(git\s+push\s+--force|force\s*push|git\s+reset\s+--hard|--no-verify)/i, reason: "Destructive git operation" },
  { rule: "destructive_docker", pattern: /(docker\s+(volume\s+rm|volume\s+prune|system\s+prune\s+-a))/i, reason: "Docker volume/system destruction" },
  { rule: "secret_dump", pattern: /(cat\s+\.env|Get-Content\s+\.env|type\s+\.env|credentials\.json)/i, reason: "Potentially exposing secrets to stdout" },
  // ── 2026-06-20 추가: 파일 내용 변환 + 원본 삭제 패턴 (나은이네 이미지 사건)
  // 사용자가 '이름 변경'을 요청했는데 에이전트가 os.remove + imwrite(변환) 실행한 사례.
  // 이 두 패턴이 draft_action/user_request 에 잡히면 turn_intent_check 가 파괴적
  // 작업 승인 게이트를 요구한다. (rename↔delete 범위 드리프트는 아래 SCOPE_DRIFT_DELETE_RE
  // 로 user_request 의 rename/분석 의도와 삭제가 실제로 공존할 때만 별도 발화한다 —
  // 2026-07-12 P1-4: 기존 scope_drift_rename_vs_delete 는 삭제 패턴만으로 이중 발화하고
  // reason 은 있지도 않은 user_request 대조를 주장했다.)
  { rule: "destructive_file_delete", pattern: /\bos\.remove\b|\bos\.unlink\b|\bshutil\.rmtree\b|\bpathlib.*\.unlink\b/, reason: "Python single-file/tree deletion (os.remove/os.unlink/shutil.rmtree) — irreversible without backup confirmation" },
  { rule: "destructive_file_overwrite", pattern: /\b(?:cv2|PIL|Image)[\s.]+(?:imwrite|imencode|save)\b|\bimwrite_korean\b|\bopen\(.*['"']wb['"']\)/, reason: "Binary file overwrite via OpenCV/PIL/raw open-wb — original data is permanently replaced" },
];

// 2026-07-12 P1-4: real scope-drift signal. Only meaningful when the USER asked
// for a rename/analysis-only operation but the action being taken deletes files.
const SCOPE_DRIFT_DELETE_RE = /(?:os\.remove|os\.unlink|shutil\.rmtree|Remove-Item)/i;
// Non-destructive intents that should NOT lead to deletion. "정리"(tidy) is
// deliberately excluded — it often legitimately includes deletion.
const RENAME_ANALYSIS_INTENT_RE = /(이름\s*(?:을|를)?\s*(?:변경|바꿔|바꾸)|rename|파일\s*명|분석|확인|조회)/i;
// If the user explicitly asked to delete, deletion is in-scope — not drift.
const EXPLICIT_DELETE_INTENT_RE = /(삭제|지워|지우|없애|제거|remove|delete)/i;

// ACTIVE_HALLUCINATION_ALERT.md is continuously re-created by the hallucination
// watchdog daemon even after manual removal. If it is the ONLY active alert
// file remaining, we downgrade the completion block to a warning rather than
// a hard CRITICAL — the model may still be doing correct work even while the
// watchdog keeps the file alive.
const WATCHDOG_REGENERATED_ALERTS = new Set([
  path.join(STATE_DIR, "ACTIVE_HALLUCINATION_ALERT.md"),
]);

// PASS_EVIDENCE_PATTERNS / LOCAL_ENGINEERING_EVIDENCE_PATTERNS / WEAK_EVIDENCE_ONLY
// and the evidence predicates that consume them now live in ./evidence.ts (P1-1).
const COMPLETION_WORD_RE = /\b(done|complete|completed|fixed|resolved|verified)\b|완료|성공|해결|검증 완료/i;
const TRANSCRIPTION_COMPLETION_RE =
  /(전사(?:본|문|파일|결과|산출물|완료|생성|통합|작업)|원본\s*그대로\s*전사|녹취록|STT\s*및\s*화자\s*분리|화자\s*분리|diari[sz]|transcription|transcribed)/i;

// Gemini/Antigravity MCP shell failure pattern (observed in mcp-shell.log):
// the shell server wrapped PowerShell commands with bash-only `set -euo pipefail`,
// producing ParserError/ParameterBindingException before the intended command
// ran. Treat any completion claim backed by this log as unverified failure.
const SHELL_WRAPPER_FAILURE_RE =
  /(Set-Variable[\s\S]{0,120}\beuo\b|NamedParameterNotFound|ParameterBindingException|UnexpectedToken|ParserError|set\s+-euo\s+pipefail[\s\S]{0,120}(powershell\.exe|\$[A-Za-z]))/i;

// SKILL_INSTALL_INCOMPLETE — skill 설치 완료 주장의 디스크 검증 (Langfuse incident).
// 배경: Antigravity CLI가 "스킬 설치 완료"라고 보고했지만 일부 스킬이 실제로는
// 생성되지 않았고(SKILL.md 누락) Claude가 재점검해서 마무리한 사례. honest_check가
// 스킬 설치/등록 완료 주장을 보면, 주장한 스킬마다 실제 SKILL.md 가 디스크에 있는지
// fs.existsSync 로 직접 검증한다 (OUTPUT_ARTIFACT_MISSING 과 동일한 ground-truth 방식).
//
// 스킬 슬러그 형태: 케밥케이스 2segment 이상 (hermes-blog-expert, codex-natural).
const SKILL_SLUG = "[a-z][a-z0-9]*(?:-[a-z0-9]+)+";
// 스킬 설치/등록/배포/동기화 + 완료 동사를 (순서 무관) 근접 매칭.
// NOTE: no \b after (스킬|skills?) — \b is an ASCII word boundary and never
// fires after the Korean "스킬" (Hangul is not \w), which silently disabled the
// first alternative for Korean reports.
const SKILL_INSTALL_COMPLETION_RE = new RegExp(
  `(스킬|skills?)[\\s\\S]{0,60}?(설치|등록|배포|동기화|추가|생성|install|register|deploy|sync|add|creat)[a-z]*[\\s\\S]{0,24}?(완료|됐|됨|했|함|끝|성공|complete|done|finished|ready|registered|installed|created)` +
    `|(설치|등록|배포|생성)\\s*(완료|함|했|됨)[\\s\\S]{0,30}?(스킬|skill)`,
  "i",
);
// 정직하게 "미설치/실패/예정"으로 라벨된 스킬은 누락으로 보지 않는다.
const SKILL_NOT_INSTALLED_CTX_RE =
  /(미설치|설치\s*안|설치\s*예정|미생성|미완료|실패|제외|건너뛰|건너뜀|skip|아직|예정|보류|not\s*(?:yet\s*)?(?:installed|created|registered|found)|todo|누락(?:됨|된|되어)?|없음|존재하지\s*않)/i;
const SKILL_ROOT_CANDIDATES_DEFAULT = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".gemini", "antigravity", "skills"),
  path.join(os.homedir(), ".gemini", "config", "skills"),
  path.join(process.cwd(), ".claude", "skills"),
  path.join(process.cwd(), ".agents", "skills"),
];

// HARNESS_SKILL_ROOTS overrides the skill-root search list (path.delimiter-
// separated), mirroring HARNESS_SEARCH_ROOTS. Lets tests/CI inject a
// deterministic skills fixture directory instead of depending on whatever skills
// happen to be installed on the host. Unset → default candidates, so production
// runtime is unchanged.
function skillRootCandidates(): string[] {
  const fromEnv = (process.env.HARNESS_SKILL_ROOTS ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : SKILL_ROOT_CANDIDATES_DEFAULT;
}

const RESPONSE_RULES: PatternRule[] = [
  {
    pattern: /\|\|\s*(echo|Write-Output|true)\s+["']?(success|done|ok|완료|성공)/i,
    rule: "INVARIANT#11",
    severity: "CRITICAL",
    description: "Failure masking with a success fallback is forbidden.",
  },
  {
    pattern: /2>\s*(\$null|NUL|\/dev\/null)/i,
    rule: "INVARIANT#11",
    severity: "HIGH",
    description: "Suppressing stderr is not valid evidence of success.",
  },
  {
    pattern: /(all|everything|모든|전체|대부분|거의\s*다|사실상).{0,40}(done|complete|completed|fixed|resolved|완료|성공|해결|반영|마무리)/i,
    rule: "INVARIANT#5",
    severity: "HIGH",
    description: "Broad completion claims require quoted tool output or explicit verification evidence.",
  },
  {
    pattern: /(should|probably|likely|seems|appears|maybe|perhaps|presumably|tentatively|I think|아마|대략|보통|일반적으로|추정|것\s*같(습니다|아요|네요|군요|음)|것으로\s*보(입니다|이|여)|아닐까|로\s*보이|에\s*가깝)/i,
    rule: "INVARIANT#2_GUESS",
    severity: "MEDIUM",
    description: "Guesses must be labeled as uncertainty and cannot be presented as verified facts.",
  },
  {
    pattern: /(이게|이것이|이거)\s*(바로\s*)?(진짜|진정한|실제|true|real)\s*(원인|이유|문제|root\s*cause)/i,
    rule: "INVARIANT#13",
    severity: "HIGH",
    description: "Confident root-cause claims require direct evidence (process tree, file content, exit code), not narrative.",
  },
  {
    pattern: /(유일한|the\s*only)\s*(해결|방법|방안|way|solution|option)/i,
    rule: "INVARIANT#14",
    severity: "HIGH",
    description: "Claiming a single 'only solution' is rarely true. Cite the source or list alternatives considered.",
  },
  {
    pattern: /~[\\/]/,
    rule: "INVARIANT#9",
    severity: "MEDIUM",
    description: "Use absolute Windows paths in this Antigravity workspace.",
  },
  {
    // Stop-and-ask anti-pattern. Defined in STOP_AND_ASK_RE above so honest_check
    // and chain_progress_check share the same detector. Severity HIGH → WEAK verdict.
    pattern: STOP_AND_ASK_RE,
    rule: "FLASH_FREEZE",
    severity: "HIGH",
    description:
      "Stop-and-ask anti-pattern: multi-step work must auto-chain until the requested outcome is genuinely handled. Asking 'shall I continue?' / '이어서 진행할까요?' mid-task is forbidden — the user already approved the multi-step task at the outset.",
  },
  {
    pattern: new RegExp(
      `(?:${SCRIPT_EXEC_VERBS})\\s*[^\\n.!?;]{0,40}?[\\w./\\\\-]+\\.(?:${SCRIPT_EXT_GROUP})\\b|\\b[\\w./\\\\-]+\\.(?:${SCRIPT_EXT_GROUP})\\b[^\\n.!?;]{0,40}?(?:${SCRIPT_EXEC_VERBS})`,
      "i",
    ),
    rule: "INVARIANT#15_PHANTOM_SCRIPT",
    severity: "CRITICAL",
    description:
      "Claims that a script was executed must be backed by quoted stdout AND the script's existence verified. Phantom-script reports (e.g. 'cleanup_materials.py를 통해 제거') are how false-completion incidents start.",
  },
  {
    // Detects manually-fabricated session-end summaries (e.g. model writes its own
    // run_session_end JSON block after guard returned BLOCK). The tell-tale is
    // a '세션 종료 결산' or fake JSON with 'status':'Success' appearing in the
    // same response that also contains a guard BLOCK signal.
    pattern: /(세션\s*종료\s*결산|자동\s*실행기\s*출력)[\s\S]{0,200}["']status["']\s*:\s*["'](Success|Partial|완료)["']/i,
    rule: "INVARIANT#16_FAKE_SESSION_END",
    severity: "CRITICAL",
    description:
      "Model fabricated a run_session_end.py JSON output. The session-end block must be produced by actually running run_session_end.py and quoting its stdout — never hand-written. If guard_completion returned BLOCK, the session-end claim is forbidden until the block is resolved.",
  },
  {
    // Detects false MCP activation claims: model says 'MCP 활성화 완료' or
    // 'MCP로 검색했다' without an actual mcp__ tool call in evidence.
    // Evidence strings from real MCP calls contain 'mcp__' prefixed tool names.
    pattern: /(MCP\s*(활성화|검색|연결|호출|사용|통해\s*조회)\s*(완료|했|하여|하고|함)|MCP로\s*(검색|조회|확인|분석)\s*(완료|했|하였))/i,
    rule: "INVARIANT#17_PHANTOM_MCP_CALL",
    severity: "HIGH",
    description:
      "Model claimed to have used/searched via MCP but provided no actual mcp__ tool call evidence. Real MCP tool usage produces output with 'mcp__<server>__<tool>' in the tool call record. auto_mcp_antigravity.py only writes to mcp_config.json — it does NOT execute a search query. Claiming a search was performed via MCP without a matching tool call is a false report.",
  },
  {
    // Post-BLOCK completion: model received guard_completion → BLOCK_*
    // (or BLOCK_HALLUCINATED_PATH / BLOCK_PHANTOM_SCRIPT / BLOCK_SELF_CORRECTION_LOOP /
    // BLOCK_COMPLETION_CLAIM) and yet the same response simultaneously declares
    // completion / PASS / 완료. Flash treats BLOCK as advisory and ploughs on.
    //
    // We catch any block verdict signal (echoed harness output) co-occurring
    // with a completion declaration in the same response.
    pattern:
      /(?:guard_decision|verdict)\s*[:=]\s*["']?BLOCK[A-Z_]*["']?[\s\S]{0,800}(?:완료(?:했|됐|됨|입니다|하였|하였습니다)|작업이?\s*완료|\b(?:done|completed|finished|fixed|resolved)\b|guard_decision\s*[:=]\s*["']?PASS["']?|overall_verdict\s*[:=]\s*["']?ALL_VERIFIED["']?)/i,
    rule: "INVARIANT#20_POST_BLOCK_COMPLETION",
    severity: "CRITICAL",
    description:
      "Response contains a BLOCK verdict from a harness tool AND a completion declaration in the same turn. " +
      "BLOCK means the completion claim is forbidden until the underlying issue is resolved. " +
      "Either re-run the work, gather missing evidence, or report Partial honestly — never paper over BLOCK with a fresh PASS sentence.",
  },
  {
    // INVARIANT#23_SPEC_PACK_UNVERIFIED — spec-pack/시방서 패키지 완료 주장에
    // spec_pack_audit completion_token 증거가 없으면 차단.
    //
    // Gemini Flash가 2026-05-26 KCSC 케이스에서 zip 406MB · payloads 100%
    // metadata_only 상태로 "패키지 완료" 보고를 한 실패 패턴을 잡는다.
    // 완료 주장이 동시에 metadata_only 마커나 짧은 본문 표시를 포함하면 즉시
    // CRITICAL, 그 외 일반 완료 주장은 strongEvidence(`completion_token` 또는
    // `spec_pack_audit ... PASS`)가 응답에 있을 때만 통과 (PASS_EVIDENCE_PATTERNS
    // 에 추가됨).
    pattern: /(시방서\s*(?:팩|패키지|pack|인제스트)|spec[\s_-]*pack|kcsc\s*(?:패키지|pack|인제스트|시방서)|HWP\s*일괄\s*(?:변환|추출)|opencrab\.sh\s*(?:업로드|인제스트))[\s\S]{0,120}(완료|완성|준비\s*완료|성공|ready|done|complete(?:d)?|반영|패키징\s*끝)/i,
    rule: "INVARIANT#23_SPEC_PACK_UNVERIFIED",
    severity: "HIGH",
    description:
      "Spec-pack completion claim without spec_pack_audit evidence. " +
      "Call mcp__ai-governor-harness__spec_pack_audit(pack_root, upload_dir, max_mb=5.0) first; " +
      "include the completion_token in the response. " +
      "This rule exists because Gemini Flash's 2026-05-26 KCSC failure produced a 406MB zip with " +
      "100% metadata_only payloads while reporting 'pack complete'.",
  },
  {
    // INVARIANT#35_SCOPE_DRIFT (2026-06-20 추가 — 나은이네 이미지 사건)
    // 사용자 요청 범위(이름 변경/분석)를 넘어 파일 내용 변환 또는 원본 삭제가 일어난 경우.
    // 탐지: user_scope 키워드("이름 변경", "rename", "분석", "확인")와 action_scope에 파괴적 동사가 공존.
    pattern: /(이름\s*변경|rename|파일\s*명|분석|확인|조회)[\s\S]{0,300}(os\.remove|os\.unlink|shutil\.rmtree|imwrite|cv2\.\w+\s*\(|원본\s*삭제|삭제[\s\S]{0,20}완료)/i,
    rule: "INVARIANT#35_SCOPE_DRIFT",
    severity: "CRITICAL",
    description:
      "SCOPE_DRIFT: 사용자가 '이름 변경/분석/확인'을 요청했으나 에이전트가 파일 내용 변환(imwrite/cv2) 또는 원본 삭제(os.remove/shutil.rmtree)를 수행했습니다. " +
      "사용자 요청 범위를 초과하는 파괴·변환 행위는 명시적 승인 없이 금지됩니다. " +
      "이 규칙은 2026-06-20 나은이네 이미지 사건(rename 요청 → 원본 전량 삭제 + OpenCV 변환)에서 추가됨.",
  },
  {
    // INVARIANT#36_UNKNOWN_SCRIPT_AUDIT (2026-06-20 추가)
    // 스킬/도구 내부 스크립트를 소스 검토 없이 사용자 파일에 실행한 경우.
    // 탐지: python *.py 실행 주장 + 해당 .py의 view_file/Read 증거 없음.
    // 이 패턴은 INVARIANT#15_PHANTOM_SCRIPT 보다 넓은 범위 — 스크립트가 존재하더라도
    // 내부 파괴 행위(os.remove 등)를 확인하지 않고 실행한 경우를 잡는다.
    pattern: /(?:python|py)\s+["']?[^\s"']{3,}\.py["']?[\s\S]{0,200}(?:(?:os\.remove|os\.unlink|shutil\.rmtree)\s*이미\s*발생|원본\s*(?:삭제됨|제거됨|없어짐))/i,
    rule: "INVARIANT#36_UNKNOWN_SCRIPT_AUDIT",
    severity: "CRITICAL",
    description:
      "UNKNOWN_SCRIPT_AUDIT: 외부 .py 스크립트를 소스 검토(view_file/Read) 없이 사용자 파일에 실행하고, " +
      "내부에서 os.remove/shutil.rmtree 등의 파괴적 동작이 발생했습니다. " +
      "실행 전 스크립트 소스를 열어 파괴적 패턴(os.remove, imwrite 등) 여부를 확인한 후 사용자에게 알리고 승인을 받아야 합니다.",
  },
];

// INVARIANT#22_TIMESTAMP_HALLUCINATION — Flash 강의 리뷰 전용 규칙 (2026-05-18 추가)
// transcript_diarized.md 분석 시 mm:ss 형식의 창작 타임스탬프를 감지합니다.
// 실제 전사본은 hh:mm:ss.ss 형식이며, 단순 mm:ss 형식(예: 18:45, 35:12)은
// trace 25960117에서 Flash가 만들어낸 환각 패턴이었습니다.
// RESPONSE_RULES에는 추가하지 않고(과잉 차단 우려) guard_completion 전용으로만 적용합니다.

// Per-rule evidence-collection hints. When honest_check returns DECEPTIVE/WEAK,
// the instructions field surfaces these so the model knows the next tool call
// to make instead of just retrying the same draft. (#1+#5 — 2026-05-26)
const BUILTIN_EVIDENCE_HINTS: Record<string, string[]> = {
  "INVARIANT#5": [
    "Split each broad completion claim into per-item entries and attach raw stdout/diff/Read excerpt as evidence_outputs[i].",
  ],
  "INVARIANT#11": [
    "Remove stderr-suppression (`2>$null`, `2>NUL`, `|| echo success`) and quote the actual error output.",
  ],
  "INVARIANT#12": [
    "Call the relevant tool first (e.g. `Read tests/last-run.log`, `Bash: git diff HEAD~1`, `Bash: curl … | jq`) and paste the raw stdout/diff in the response before honest_check.",
  ],
  "INVARIANT#12_EVIDENCE_NOT_INLINE": [
    "tool_call_log에 raw evidence는 있으나 응답 본문에 인용되지 않았습니다. view_file/Read의 lines/bytes/exit code 등을 응답 안에 직접 짧게 인용해주세요.",
  ],
  "INVARIANT#13": [
    "Cite direct evidence (process tree, file content, exit code, log line). Hedge as 'likely' until verified.",
  ],
  "INVARIANT#14": [
    "List at least one alternative considered, or cite the source of the 'only solution' claim.",
  ],
  "INVARIANT#15_PHANTOM_SCRIPT": [
    "Execute the script and quote stdout (`exit 0`), OR remove the execution claim and label as 'proposed'.",
  ],
  "INVARIANT#16_FAKE_SESSION_END": [
    "Run `python run_session_end.py` and paste the JSON stdout literally. Do not hand-write the session-end block.",
  ],
  "INVARIANT#17_PHANTOM_MCP_CALL": [
    "Make a real `mcp__<server>__<tool>` tool call. auto_mcp.py only configures — it does not execute searches.",
  ],
  "INVARIANT#19_MCP_TRIGGER_BYPASS": [
    "The user's keyword required an MCP call. Make the `mcp__<server>__<tool>` call before responding.",
  ],
  "INVARIANT#20_POST_BLOCK_COMPLETION": [
    "Resolve the BLOCK first (rerun, fix, gather evidence). Do NOT issue a fresh PASS in the same turn.",
  ],
  "INVARIANT#23_SPEC_PACK_UNVERIFIED": [
    "Call mcp__ai-governor-harness__spec_pack_audit({pack_root: '<PACK_ROOT>', upload_dir: '<UPLOAD_DIR>', max_mb: 5.0}) FIRST.",
    "Wait for verdict='PASS' and a 24-char completion_token. Embed both 'spec_pack_audit: PASS' and the token verbatim in the final report.",
    "If verdict='FAIL', resolve each blocker (re-extract / rebuild payloads / re-split) and re-call spec_pack_audit — do NOT manually edit pack.yaml counts or upload sizes to make them look right.",
  ],
  "INVARIANT#24_SHELL_WRAPPER_FAILURE": [
    "The captured tool log shows the shell wrapper failed before the intended command ran. Re-run in the correct shell (`cmd /c ...`, PowerShell-native syntax, or bash-only inside Git Bash) and quote the new `exit code: 0` output.",
    "Do not treat `ParserError`, `UnexpectedToken`, `NamedParameterNotFound`, or `set -euo pipefail` PowerShell failures as test/build evidence.",
  ],
  "INVARIANT#25_SKILL_FIRST_REQUIRED": [
    "This request matched a Gemini skill trigger. Before doing any other work, read the matching `<skill>/SKILL.md` and quote the tool evidence/path in `tool_call_log`.",
    "If work already started without the skill, stop, read SKILL.md now, then restart/redo the affected steps according to that skill. Do not claim completion from a no-skill path.",
  ],
  "INVARIANT#21_TRANSCRIPTION_ARTIFACTS": [
    "Cite `raw/*.raw.md`, `diarized/*.diarized.md`, `progress.json`, and `speaker_roster.md` before declaring transcription complete.",
  ],
  "WEAK_EVIDENCE": [
    "For each claimed_item, provide raw stdout/diff/Read excerpt (≥20 chars, with tool tokens like 'exit 0', 'lines', 'bytes', 'PASS') — not narrative.",
  ],
  "INVARIANT#26_DELEGATED_VERIFICATION_BYPASS": [
    "사용자가 지정한 CLI로 실제 검증/작업을 실행하세요: 예) `codex exec --skip-git-repo-check -s read-only \"<대상> 검증해줘\"`, `codex review`, 또는 `gemini -p \"...\"`. `codex doctor`/`--help`/다른 MCP(session_emit_audit·audit.py)로의 대체는 위임 이행이 아닙니다.",
    "그 CLI의 raw stdout(검증 결론/diff)을 응답에 인용한 뒤에만 완료를 주장하세요. 백그라운드 실행이면 태스크가 RUNNING인 동안 '완료'라고 보고하지 말고, 종료(exit 0)와 출력 수신을 확인한 뒤 보고하세요.",
  ],
  "INVARIANT#27_GUARD_BLAME_SHIFT": [
    "가드레일이 작업을 차단했다고 핑계를 대기 전에 먼저 지시된 조치(skill_view/activate_skill 호출, 권한 요청 등)를 취했는지 tool_call_log를 확인하십시오.",
    "SKILL_ACTIVATION_GATE 등 BeforeTool 가드는 프로세스를 종료시키지 않으며 단지 차단(decision:deny)만 합니다. '가드가 백그라운드 작업을 종료시켜서...'와 같은 거짓된 기술적 주장을 하거나 스스로를 '피해자'로 포장하지 말고, 정직하게 차단된 사실과 자신이 취한 조치를 보고하십시오.",
  ],
  "PHANTOM_SCRIPT": [
    "Verify the script exists via Glob or `Test-Path`, then either quote its execution stdout or remove the citation.",
  ],
  "BACKTICK_PATH_HALLUCINATION": [
    "Either include the path in this turn's tool args/output (Read/Edit/Bash), or remove the backtick citation.",
  ],
  "OUTPUT_ARTIFACT_MISSING": [
    "Run `Test-Path <path>` / `Get-Item <path>` and quote the real size/LastWriteTime, OR relabel the item as 미실행/proposed. Never claim '생성됨' for a file that is not on disk.",
  ],
  "SKILL_INSTALL_INCOMPLETE": [
    "For each skill you claim to have installed, verify `Test-Path '<skills_root>/<name>/SKILL.md'` returns True (skills_root is e.g. ~/.claude/skills or ~/.gemini/config/skills). Create any missing SKILL.md, then re-claim.",
    "If a skill is only partially set up (folder exists but SKILL.md missing), finish it or label it 미설치/예정 — do not report the batch as '설치 완료'.",
  ],
  "ACTIVE_ALERT_COMPLETION": [
    "Resolve the alert file(s) (review + remove) before claiming completion, OR reframe as STATUS: PARTIAL_STATUS.",
  ],
  "FLASH_FREEZE": [
    "REMOVE the stop-and-ask sentence ('이어서 진행할까요?', 'shall I continue?', etc.) from your draft. The user already approved the multi-step task — auto-chain to the next step immediately.",
    "If the operation has hang risk (large file walk, browser MCP, external API, long-running script), split it into chunks ≤1–2 min wall-clock each. Emit a one-line progress note between chunks; never pause for user confirmation between chunks.",
    "Only pause for: (a) genuine inability to proceed (missing file, auth error), (b) destructive-action approval per CLAUDE.md, or (c) ambiguous user intent that materially changes the plan.",
  ],
  // INVARIANT#29_CLOSEOUT_PROTOCOL_SKIPPED (2026-06-08 추가)
  // 배경: '종료' 명령 시 run_session_end.py 미실행 후 단순 텍스트로 마감한 사례
  "INVARIANT#29_CLOSEOUT_PROTOCOL_SKIPPED": [
    "사용자가 '종료'/'세션 종료'/'session close' 명령을 내렸습니다. GEMINI.md Closeout 룰에 따라 반드시 `python run_session_end.py --session-title \"<title>\" ...` 를 실행하고 그 JSON stdout을 응답에 인용해야 합니다.",
    "단순 텍스트로 '종료합니다'만 응답하는 것은 프로토콜 위반입니다. run_session_end.py 실행 후 quality_check.py 까지 수행하고 스코어를 보고하세요.",
    "이 규칙은 2026-06-07 '종료' 명령 시 run_session_end.py 미실행 후 단순 텍스트 응답으로 마감한 사례에서 추가되었습니다.",
  ],
  // INVARIANT#30_FABRICATED_DIARIZATION (2026-06-11 추가, trace 74cb9bd1)
  // 배경: 모델이 pyannote를 실행하지 않고 하드코딩 python 스크립트로
  // diarized/part_000.diarized.md + speaker_roster.md 를 손으로 창작한 사례.
  "INVARIANT#30_FABRICATED_DIARIZATION": [
    "diarized/*.diarized.md, transcript_diarized.md, speaker_roster.md 는 반드시 실제 화자분리 파이프라인 산출물이어야 합니다. 승인된 전사/화자분리 파이프라인(pyannote 등)을 실행하고 그 stdout을 인용하세요. (구체 실행 명령은 배포별 config/evidence_hints.supplement.json 으로 주입할 수 있습니다.)",
    "화자표를 손으로 작성하거나(추정 화자/시간/confidence 기입), 별도 전사본을 글자수 비례로 화자 블록에 재배분하는 것은 데이터 날조입니다. 화자 분리가 불가능하면 화자 컬럼 없이 raw 전사만 제출하고 '화자 분리 미실행'으로 보고하세요.",
  ],
  // INVARIANT#31_CPU_DEVICE_OVERRIDE (2026-06-11 추가, trace 74cb9bd1)
  // 배경: 멀쩡한 CUDA venv가 있는데 자체 스크립트에 device="cpu" 를 하드코딩해
  // large-v3를 CPU로 돌리고 'CPU 버전 설치' 류의 거짓 설명을 한 사례.
  "INVARIANT#31_CPU_DEVICE_OVERRIDE": [
    "전사/화자분리 코드에 device='cpu' 를 하드코딩하기 전에 먼저 `python -c \"import torch; print(torch.cuda.is_available())\"` 를 (승인된 CUDA venv에서) 실행해 결과를 인용하세요. True면 GPU 경로를 사용해야 합니다.",
    "CUDA가 실제로 False인 경우에만 CPU 실행이 허용되며, 그 False 출력 원문과 함께 --allow-cpu 사용을 보고하세요.",
  ],
  // INVARIANT#28_FAILURE_THEN_ARTEFACT_LIST (2026-06-11 추가, trace 0e9310ad/7bf784cc)
  // 배경: 이미지 생성이 429/quota 로 실패했는데 응답에는 01_*.png, 02_*.png …
  // 번호 매긴 산출물 목록을 그대로 나열해 명시적 완료 주장 없이 성공을 암시한 사례.
  // 2026-06-07 Gemini 세션이 이 규칙을 '추가 완료(90 pass)'로 보고했으나 실제로는
  // 어느 브랜치에도 반영되지 않았던 허위 완료 건이기도 하다.
  "INVARIANT#28_FAILURE_THEN_ARTEFACT_LIST": [
    "tool_call_log에 429/503/quota/RESOURCE_EXHAUSTED 류 실패가 있습니다. 산출물 파일명을 나열하기 전에 각 파일의 실제 존재를 검증하세요: `Test-Path <file>` True 또는 `PASS <name>.png WxH bytes=N` 류의 raw 출력 인용이 필요합니다.",
    "실패한 항목은 파일명 나열에서 제외하고 '미생성/실패'로 명시하세요. 번호 매긴 파일 목록 레이아웃만으로 성공을 암시하는 것은 거짓 완료 보고입니다.",
  ],
  // INVARIANT#32_BUILD_ARTIFACT_DIRECT_PATCH (2026-06-11 추가, trace 48ad4493)
  // 배경: 소스(guardrail.ts) tsc 빌드가 인코딩 깨짐으로 실패하자 빌드 산출물
  // (build/tools/guardrail.js)을 직접 패치하고 '패치 적용 완료'라고 보고해
  // 소스와 빌드가 영구 분기된 사례.
  "INVARIANT#32_BUILD_ARTIFACT_DIRECT_PATCH": [
    "빌드 실패(error TSxxxx 등)가 있는 상태에서 build/·dist/ 산출물(.js)을 직접 패치하지 마세요. 먼저 소스(.ts)의 빌드 오류를 고치고 `pnpm run build` exit 0 출력을 인용한 뒤 완료를 주장하세요.",
    "긴급히 산출물을 직접 패치해야 했다면 '소스 미반영 — 다음 빌드에서 소실됨'을 명시하고 STATUS: PARTIAL_STATUS 로 보고하세요. 소스/빌드 동기화 없이 '반영 완료'를 주장하는 것은 금지됩니다.",
  ],
  // ── 2026-06-20 추가: 나은이네 이미지 사건에서 추가된 인배리언트 힌트
  "INVARIANT#35_SCOPE_DRIFT": [
    "사용자가 요청한 범위('이름 변경', '분석', 'rename')와 실제로 수행한 작업('파일 변환', '원본 삭제')이 불일치합니다.",
    "스크립트/도구가 내부적으로 os.remove/imwrite 등을 실행하는지 소스를 먼저 확인하고 사용자에게 명시적으로 알린 뒤 승인을 받으세요.",
    "승인 없이 원본 파일을 삭제하거나 변환한 경우 STATUS: PARTIAL_STATUS로 보고하고 복구 방법을 안내하세요.",
  ],
  "INVARIANT#36_UNKNOWN_SCRIPT_AUDIT": [
    "사용자 파일에 대해 외부 스크립트(.py/.sh/.ps1)를 실행하기 전 반드시 해당 스크립트 소스를 view_file/Read로 열어 os.remove, shutil.rmtree, imwrite 등 파괴적 패턴이 있는지 확인하세요.",
    "파괴적 패턴이 발견되면 실행 전 사용자에게 구체적으로 알리고 명시적 승인을 받은 뒤에만 실행하세요.",
    "이 규칙은 2026-06-20 나은이네 이미지 사건(process_images.py가 내부적으로 os.remove를 실행해 원본 삭제)에서 추가됐습니다.",
  ],
  "destructive_file_delete": [
    "os.remove/os.unlink/shutil.rmtree가 포함된 코드 또는 명령을 실행하기 전, 삭제할 파일이 백업됐는지 확인하거나 사용자에게 명시적 승인을 받으세요.",
  ],
  "destructive_file_overwrite": [
    "cv2.imwrite/PIL.save/open(wb) 등 파일 덮어쓰기 동작 전, 원본 파일이 별도로 보존되어 있는지 확인하세요. 원본 삭제 없이 새 파일명으로 저장하는 방식을 우선 사용하세요.",
  ],
  "INVARIANT#38_SKILL_METHOD_BYPASS": [
    "hermes-illustration-expert 스킬은 generate_image 도구에 ImagePaths 파라미터를 전달하는 방식만 허용합니다.",
    "cv2, OpenCV, PIL, process_images.py, bilateral 등 로컬 이미지 처리 라이브러리는 이 스킬에서 명시적으로 금지됩니다.",
    "스킬 SKILL.md를 읽는 것만으로는 부족합니다 — 스킬이 지시한 prescribed method(generate_image + ImagePaths)를 실제로 사용해야 합니다.",
    "다른 스킬에서도 마찬가지입니다: SKILL.md가 '반드시 X 도구를 사용하라'고 명시한다면 X 이외의 방법은 INVARIANT#38 위반으로 처리됩니다.",
  ],
  "INVARIANT#39_OPENCRAB_9SPACE_PREWRITE": [
    "Before any OpenCrab create/update/link/upload/ingest action, confirm and include purpose plus all nine 9space axes: subject, resource, evidence, concept, claim, community, outcome, lever, policy.",
    "Do not treat workspace_label, package title, or project name as the full 9space. They are slugs/names only.",
    "Redo or repair the operation only after the user confirms the full purpose and all nine axes; quote that confirmation and the mutating tool input evidence.",
  ],
  "INVARIANT#40_OPENCRAB_NEO4J_LINEAGE_UNVERIFIED": [
    "For OpenCrab full/high-quality/Neo4j-linked ingest claims, quote read-only Neo4j evidence that maps package_id, workspace_id, source_title, and a document/chunk/source locator.",
    "SaaS pack search, OpenCrab graph search_nodes, or list_edges alone is not direct local Neo4j property mapping evidence.",
    "If direct Neo4j access or metadata backfill is unavailable, report a degraded SaaS ingest or STATUS: PARTIAL_STATUS instead of claiming full/high-quality/Neo4j-linked completion.",
  ],
};

// P3-6: keep deployment-specific hint text (transcription venv paths, session-end
// script names, custom rules) OUT of the shipped source. An optional supplement
// JSON — { "<RULE>": ["extra hint", ...] } — is merged in at load, mirroring the
// mcp_triggers / skill_routes.supplement pattern. Absent file → built-in hints
// only (public default). Env override: HARNESS_EVIDENCE_HINTS_CONFIG.
const EVIDENCE_HINTS_SUPPLEMENT_PATH =
  process.env.HARNESS_EVIDENCE_HINTS_CONFIG ??
  path.join(HARNESS_ROOT, "config", "evidence_hints.supplement.json");

function loadEvidenceHints(): Record<string, string[]> {
  // Deep-copy the built-ins so a merge never mutates the source-of-truth object.
  const merged: Record<string, string[]> = {};
  for (const [rule, hints] of Object.entries(BUILTIN_EVIDENCE_HINTS)) merged[rule] = [...hints];

  let raw: string;
  try {
    raw = fs.readFileSync(EVIDENCE_HINTS_SUPPLEMENT_PATH, "utf-8").replace(/^﻿/, "");
  } catch {
    return merged; // no supplement — public default
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[harness] evidence_hints.supplement.json invalid JSON — ignored. ${(err as Error).message}`,
    );
    return merged;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return merged;

  let added = 0;
  for (const [rule, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const extra = value.map((v) => String(v).trim()).filter(Boolean);
    if (extra.length === 0) continue;
    const base = merged[rule] ?? [];
    // Append supplement hints, de-duplicating against the built-ins.
    for (const hint of extra) {
      if (!base.includes(hint)) {
        base.push(hint);
        added++;
      }
    }
    merged[rule] = base;
  }
  if (added > 0) {
    console.error(
      `[harness] merged ${added} supplement evidence hint(s) from ${EVIDENCE_HINTS_SUPPLEMENT_PATH}`,
    );
  }
  return merged;
}

const EVIDENCE_HINTS: Record<string, string[]> = loadEvidenceHints();

function recommendedActionsFor(violations: Violation[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of violations) {
    const hints = EVIDENCE_HINTS[v.rule];
    if (!hints) continue;
    for (const h of hints) {
      if (seen.has(h)) continue;
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

// INVARIANT#19_MCP_TRIGGER_BYPASS — runtime-evaluated using MCP_TRIGGER_MAP.
// We detect it after the static rule sweep so the trigger map can be
// extended without rebuilding the regex shape every time.
//
// #E (2026-05-27) — Run keyword AND bypass matches against the code/quote-
// stripped text. Pre-fix: a model citing example curl commands in code blocks
// (educational or "here's how the API looks" context) would false-trigger
// INVARIANT#19 even when it actually used the MCP. Mirrors what FLASH_FREEZE
// already does via textNoQuotes in scanText. Real bypass is still caught when
// the keyword + bypass are both in narrative AND no expectedMcpPrefix call is
// in tool_call_log.
function scanMcpTriggerBypass(text: string, toolCallLog: string): Violation[] {
  const out: Violation[] = [];
  const stripped = stripCodeAndQuotes(text);
  for (const entry of MCP_TRIGGER_MAP) {
    if (!entry.keywordPattern.test(stripped)) continue;
    const bypassed = entry.bypassPattern.test(stripped);
    if (!bypassed) continue;
    // If the tool-call log explicitly shows the expected mcp__ prefix, it's not a bypass.
    if (toolCallLog && toolCallLog.includes(entry.expectedMcpPrefix)) continue;
    out.push({
      rule: "INVARIANT#19_MCP_TRIGGER_BYPASS",
      severity: "HIGH",
      matched: `${entry.name}: keyword present + bypass pattern present, no ${entry.expectedMcpPrefix}* call in tool log`,
      description: entry.description,
    });
  }
  return out;
}

const OPENCRAB_9SPACE_AXES = [
  "subject",
  "resource",
  "evidence",
  "concept",
  "claim",
  "community",
  "outcome",
  "lever",
  "policy",
];

function hasExplicitOpenCrabAxis(text: string, axis: string): boolean {
  return new RegExp(`(^|[\\s{,;"']|\\\\n)["']?${axis}["']?\\s*[:=]`, "im").test(text);
}

function hasOpenCrabPurpose(text: string): boolean {
  return /(^|[\s{,;"']|\\n)["']?(purpose|ontology_purpose|metaontology_purpose|nine_grammar_purpose)["']?\s*[:=]\s*.{20,}/ims.test(text);
}

function openCrabMissingPurposeOrAxes(text: string): string[] {
  const missing: string[] = [];
  if (!hasOpenCrabPurpose(text)) missing.push("purpose");
  for (const axis of OPENCRAB_9SPACE_AXES) {
    if (!hasExplicitOpenCrabAxis(text, axis)) missing.push(axis);
  }
  return missing;
}

function openCrabActionNear(log: string, tool: string, actionPattern: RegExp): boolean {
  const re = new RegExp(tool, "ig");
  let match: RegExpExecArray | null;
  while ((match = re.exec(log)) !== null) {
    const window = log.slice(match.index, match.index + 900);
    actionPattern.lastIndex = 0;
    if (actionPattern.test(window)) return true;
  }
  return false;
}

function openCrabMutatingEvidence(log: string): string[] {
  const hits: string[] = [];
  const lower = log.toLowerCase();
  if (/\bopencrab_ingest_text\b/.test(lower)) hits.push("opencrab_ingest_text");
  if (/\bopencrab_pack_update\b/.test(lower)) hits.push("opencrab_pack_update");
  if (/\bopencrab_crab_agent\b/.test(lower) && !openCrabActionNear(lower, "opencrab_crab_agent", /["']?action["']?\s*[:=]\s*["']status["']/i)) {
    hits.push("opencrab_crab_agent");
  }
  if (openCrabActionNear(lower, "opencrab_project_manage", /["']?action["']?\s*[:=]\s*["'](?:create|delete|add_packs|remove_packs|set_packs)["']/i)) {
    hits.push("opencrab_project_manage");
  }
  if (openCrabActionNear(lower, "opencrab_project_run", /["']?reverse_ingest["']?\s*[:=]\s*(?:true|1)/i)) {
    hits.push("opencrab_project_run(reverse_ingest)");
  }
  if (openCrabActionNear(lower, "opencrab_workflow_manage", /["']?action["']?\s*[:=]\s*["'](?:create|update|delete)["']/i)) {
    hits.push("opencrab_workflow_manage");
  }
  if (
    openCrabActionNear(lower, "opencrab_pack_qa", /["']?mode["']?\s*[:=]\s*["'](?:assess_and_update|reverse_ingest)["']/i) ||
    openCrabActionNear(lower, "opencrab_pack_qa", /["']?(?:reverse_ingest|update_existing)["']?\s*[:=]\s*(?:true|1)/i)
  ) {
    hits.push("opencrab_pack_qa(mutating)");
  }
  return [...new Set(hits)];
}

function scanOpenCrab9spacePrewriteBypass(toolCallLog: string): Violation[] {
  const mutating = openCrabMutatingEvidence(toolCallLog);
  if (mutating.length === 0) return [];
  const missing = openCrabMissingPurposeOrAxes(toolCallLog);
  if (missing.length === 0) return [];
  return [{
    rule: "INVARIANT#39_OPENCRAB_9SPACE_PREWRITE",
    severity: "CRITICAL",
    matched: `${mutating.join(", ")} missing ${missing.join(", ")}`,
    description:
      "OpenCrab mutating tool evidence is present, but the tool input/log does not show confirmed purpose plus all nine 9space axes. " +
      "workspace_label is only a slug and cannot substitute for subject/resource/evidence/concept/claim/community/outcome/lever/policy.",
  }];
}

// INVARIANT#26_DELEGATED_VERIFICATION_BYPASS — 지정 도구 검증/개선 위임 우회.
// 배경 (2026-06-01, 세션 40d84b6a): 사용자가 "codex cli로 검증해줘"라고 외부 CLI
// 검증을 명시 위임했는데, 모델이 codex를 실제 실행하지 않고 session_emit_audit MCP /
// hermes-langfuse-search 의 audit.py 로 바꿔치기하거나 `codex doctor`·`codex --help`
// 같은 비검증 호출만 한 뒤 "검증/개선 완료"를 보고했다. 사용자가 두 차례 추궁
// ("codex 호출한 거 맞아?", "codex 없이 작업한 거 같은데?")한 뒤에야 실제 `codex exec`
// 를 돌렸다. honest_check 는 기껏 WEAK_EVIDENCE 만 띄웠을 뿐 "사용자가 지정한 도구를
// 실제로 안 돌렸다"는 사각지대는 규칙이 없어 사람만 잡았다. 이 규칙이 그 구멍을 닫는다:
// 위임된 CLI 의 *실제 실행*(exec/review/chat/-p)이 tool_call_log 에 없으면 완료 주장을
// DECEPTIVE 로 차단한다. doctor/--help/--version/login 같은 진단·도움말과, 다른 도구로의
// 바꿔치기는 위임 이행으로 인정하지 않는다.
function openCrabLineageCompletionClaim(userRequest: string, responseText: string): boolean {
  const combined = `${userRequest}\n${responseText}`;
  if (!/\bopencrab\b|오픈크랩/i.test(combined)) return false;
  const fullOrNeo4j =
    /(full\s*(?:pack|ingest)|high[-\s]*quality|neo4j[-\s]*(?:linked|mapped|lineage)|local\s+neo4j|로컬\s*neo4j|neo4j\s*(?:연동|매핑|라인리지)|풀\s*팩|고품질)/i.test(combined);
  const ingestClaim =
    /(ingest(?:ed|ion)?|인제스트|pack|패키지|upload(?:ed)?|업로드|link(?:ed)?|연동)/i.test(combined) &&
    (COMPLETION_WORD_RE.test(responseText) || /(완료|성공|끝|됐|됨|처리|올라감|올라갔|ingested|uploaded|linked|ready|done|complete(?:d)?)/i.test(responseText));
  return fullOrNeo4j || ingestClaim;
}

function openCrabLineageUnverifiedAdmitted(responseText: string): boolean {
  return /STATUS:\s*PARTIAL_STATUS|saas[-\s]*only|degraded\s+saas|neo4j[\s\S]{0,80}(?:unverified|not\s+verified|unavailable|unchecked)|(?:로컬\s*)?neo4j[\s\S]{0,80}(?:확인\s*안|미검증|불가|접속\s*불가)|직접\s*매핑[\s\S]{0,60}(?:확인\s*안|미검증|불가)/i.test(responseText);
}

function hasLineageFieldEvidence(text: string, field: string): boolean {
  const prop = field.replace(/_/g, "[_-]?");
  return new RegExp(`\\b${prop}\\b\\s*[:=]\\s*["']?[^"',}\\]\\s]{3,}`, "i").test(text) ||
    new RegExp(`\\b${prop}\\b`, "i").test(text);
}

function missingOpenCrabNeo4jLineageEvidence(text: string): string[] {
  const missing: string[] = [];
  for (const field of ["package_id", "workspace_id", "source_title"]) {
    if (!hasLineageFieldEvidence(text, field)) missing.push(field);
  }
  if (!/(?:\bdocument[_-]?id\b|\bchunk[_-]?id\b|\bsource[_-]?path\b|\bsource[_-]?alias\b)/i.test(text)) {
    missing.push("document_id or chunk_id or source_path");
  }
  return missing;
}

function hasDirectNeo4jLineageReadEvidence(text: string): boolean {
  const hasNeo4jSurface =
    /\bneo4j\b|\bcypher\b|bolt:\/\//i.test(text) ||
    /\bMATCH\s*\([^)]*\)[\s\S]{0,600}\bRETURN\b/i.test(text);
  const hasReadOnly =
    /\bread[-\s]*only\b|\breadonly\b|\bquery\b|\bqueried\b|\bMATCH\b|\bRETURN\b|조회|검증/i.test(text);
  const hasNodeRead = /\bMATCH\s*\([^)]*\)|\bnodes?\b|노드/i.test(text);
  const hasEdgeRead = /\bMATCH\s*\([^)]*\)\s*-\s*\[|\bedges?\b|\brelationships?\b|엣지|관계/i.test(text);
  const hasLineage = missingOpenCrabNeo4jLineageEvidence(text).length === 0;
  return hasNeo4jSurface && hasReadOnly && hasNodeRead && hasEdgeRead && hasLineage;
}

function scanOpenCrabNeo4jLineageVerification(userRequest: string, responseText: string, toolCallLog: string): Violation[] {
  const mutating = openCrabMutatingEvidence(toolCallLog);
  if (mutating.length === 0) return [];
  if (!openCrabLineageCompletionClaim(userRequest, responseText)) return [];
  if (openCrabLineageUnverifiedAdmitted(responseText)) return [];

  const combined = `${responseText}\n${toolCallLog}`;
  const missing = missingOpenCrabNeo4jLineageEvidence(combined);
  const hasNeo4jRead = hasDirectNeo4jLineageReadEvidence(combined);
  if (missing.length === 0 && hasNeo4jRead) return [];

  const reasons = [...missing];
  if (!hasNeo4jRead) reasons.push("direct read-only Neo4j node/edge query evidence");
  return [{
    rule: "INVARIANT#40_OPENCRAB_NEO4J_LINEAGE_UNVERIFIED",
    severity: "CRITICAL",
    matched: `${mutating.join(", ")} missing ${[...new Set(reasons)].join(", ")}`,
    description:
      "OpenCrab mutating evidence is present and the response claims full/high-quality/Neo4j-linked ingest completion, " +
      "but the evidence does not show direct read-only Neo4j lineage mapping for package_id/workspace_id/source_title plus document/chunk/source locator.",
  }];
}

const DELEGATED_VERIFY_TOOLS: { name: string; mention: RegExp; realExec: RegExp }[] = [
  {
    name: "codex",
    mention: /\bcodex\b/i,
    realExec:
      /codex(?:\.exe|\.cmd)?\s+(?:exec|review|chat|resume|apply)\b(?![\w\s-]{0,24}--help)|codex(?:\.exe|\.cmd)?\s+(?:-p|--prompt)\b/i,
  },
  {
    name: "gemini",
    mention: /\bgemini(?:\s*cli)?\b/i,
    realExec: /gemini(?:\.js|\.cmd|\.exe)?\s+(?:-p|--prompt|exec)\b(?![\w\s-]{0,24}--help)/i,
  },
];
const DELEGATION_INTENT_RE =
  /(검증|검토|확인|점검|리뷰|감수|review|verify|audit|개선|고쳐|고치|수정|보완|improve|fix|분석|진단)/i;

function scanDelegatedVerificationBypass(
  userRequest: string,
  responseText: string,
  toolCallLog: string,
): Violation[] {
  const out: Violation[] = [];
  if (!userRequest) return out;
  const req = stripCodeAndQuotes(userRequest);
  // 완료/검증/개선을 주장하는 응답일 때만 검사한다.
  const claimsDone =
    COMPLETION_WORD_RE.test(responseText) ||
    /(검증|검토|점검|확인|리뷰|분석|개선|수정|진단)\s*(완료|했|했습니다|됐|결과|끝|함)/i.test(responseText);
  if (!claimsDone) return out;
  const log = toolCallLog ?? "";
  for (const t of DELEGATED_VERIFY_TOOLS) {
    if (!t.mention.test(req)) continue; // 사용자가 그 도구를 지정했나
    if (!DELEGATION_INTENT_RE.test(req)) continue; // 검증/개선 등 위임 의도인가
    if (t.realExec.test(log)) continue; // 실제로 그 CLI 를 돌렸으면 통과
    out.push({
      rule: "INVARIANT#26_DELEGATED_VERIFICATION_BYPASS",
      severity: "CRITICAL",
      matched: `user delegated '${t.name}' verification/improvement; no real '${t.name} exec/review/-p' call in tool_call_log`,
      description:
        `User explicitly delegated verification/improvement to the '${t.name}' CLI, but this response claims it is done ` +
        `without any real ${t.name} execution (e.g. '${t.name} exec', '${t.name} review', '${t.name} -p') in tool_call_log. ` +
        `Substituting another tool (session_emit_audit, audit.py) or running '${t.name} doctor/--help' is NOT the delegated ` +
        `verification. Actually run the ${t.name} CLI on the target and quote its raw stdout before claiming completion.`,
    });
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── F2 (2026-06-26 improvement doc) — foreign change swept into a bulk commit ──
// Incident (trace 5c63e0ef, HWP MCP repo): the model honestly disclosed that the
// working tree held large changes it had not authored ("fix_chapter6_format.py는
// 제가 만든 게 아니어서 출처는 확실치 않습니다"), then, following a broad "commit
// everything" instruction, folded those unknown-origin files into a single commit.
// INVARIANT#27 catches DISHONEST blame-shifting; this catches the opposite honest-
// but-unisolated shape. Because the disclosure is itself a virtue, this is ADVISORY
// only (process_warnings → process_verdict WEAK, never blocks the completion claim).
const FOREIGN_CHANGE_ADMISSION_RE =
  /(내가\s*만들지\s*않|제가\s*만든\s*게\s*아니|만들지\s*않은\s*(?:파일|변경|것)|출처가?\s*(?:불명|불분명|확실치\s*않|확실하지\s*않)|이번\s*세션에서\s*(?:하지\s*않|만들지\s*않)|내가\s*하지\s*않은\s*변경|didn'?t\s*create|not\s*(?:mine|my\s*(?:own\s*)?change)|unknown[-\s]*origin|foreign\s*change|someone\s*else'?s\s*change)/i;
const BULK_COMMIT_DECL_RE =
  /(git\s+add\s+(?:-A\b|--all\b|\.\s)|git\s+commit\b[\s\S]{0,40}\b-a\b|모두\s*(?:커밋|스테이징)|전부\s*(?:커밋|스테이징)|한꺼번에\s*커밋|일괄\s*(?:커밋|스테이징)|stage\s+(?:all|everything)|commit\s+(?:all|everything))/i;
// Honest isolation/approval language that makes the advisory unnecessary.
const CHANGE_ISOLATED_RE =
  /(별도\s*커밋|따로\s*커밋|분리\s*(?:해서\s*)?커밋|제외하(?:고|여|였)|승인\s*(?:받|을\s*받)|사용자\s*승인|separate\s*commit|excluded|split\s*into\s*(?:a\s*)?separate)/i;

function scanForeignChangeBulkCommit(
  responseText: string,
  toolCallLog: string,
): { rule: string; matched: string; description: string }[] {
  if (!FOREIGN_CHANGE_ADMISSION_RE.test(responseText)) return [];
  const bulk = `${responseText}\n${toolCallLog}`.match(BULK_COMMIT_DECL_RE);
  if (!bulk) return [];
  if (CHANGE_ISOLATED_RE.test(responseText)) return []; // already isolated / approved
  return [
    {
      rule: "FOREIGN_CHANGE_BULK_COMMIT",
      matched: bulk[0].slice(0, 60),
      description:
        "The response honestly discloses an unknown-origin / not-authored change, yet also stages or commits it in bulk. " +
        "Isolate the foreign change into its own commit (or get explicit user approval to include it) so an unaudited change " +
        "isn't silently attributed to this work. This is advisory — the honest disclosure itself is correct.",
    },
  ];
}

function scanGuardBlameShift(responseText: string, toolCallLog: string): Violation[] {
  const out: Violation[] = [];

  const log = toolCallLog ?? "";

  const GUARD_NAME =
    "(SKILL_ACTIVATION_GATE|PENDING_CONFIRMATION|FLASH_TOOL_SAFETY|INTENT_GATE|DESTRUCTIVE|가드레일|guardrail|게이트)";
  const GUARD_BLOCK =
    "(차단|막혀|막았|거부|tool\\s*execution\\s*blocked|blocked|실행\\s*차단|USER\\s*CONFIRMATION\\s*REQUIRED)";
  const GUARD_NAME_RE = new RegExp(
    `${GUARD_NAME}[\\s\\S]{0,80}${GUARD_BLOCK}|${GUARD_BLOCK}[\\s\\S]{0,80}${GUARD_NAME}`,
    "i",
  );

  // Langfuse incident follow-up: the original #27 caught "the guard blocked me,
  // so I could not continue" excuses, but not the equally risky report shape
  // "the guard blocked me, so I bypassed it and relaunched". BeforeTool gates are
  // boundaries to resolve with skill activation or user approval, not obstacles
  // to bypass with YOLO/skip-trust language.
  const GUARD_BYPASS_RE =
    /(우회(?!\s*(?:하지|하지\s*않|없이))|무시|skip[-\s]?trust|YOLO|강제\s*(?:승인|통과)|bypass(?:ed|ing)?)/i;
  const BYPASS_SUCCESS_RE =
    /(정상\s*수행|다시\s*(?:런칭|실행)|재(?:런칭|실행)|실행\s*중|완료|진행|자동\s*승인|나머지[\s\S]{0,80}수행)/i;

  if (GUARD_NAME_RE.test(responseText) && GUARD_BYPASS_RE.test(responseText) && BYPASS_SUCCESS_RE.test(responseText)) {
    out.push({
      rule: "INVARIANT#27_GUARD_BLAME_SHIFT",
      severity: "CRITICAL",
      matched: "reported bypassing a guard/gate block and continuing execution",
      description:
        "The response says a guard/gate such as SKILL_ACTIVATION_GATE blocked execution, then frames bypassing or ignoring that gate as the path to continue. Resolve the gate with the required skill/user approval and quote that evidence; do not report guard bypass as success.",
    });
  }

  const EXCUSE_RE = /(수행하지\s*못|못\s*했|실패|중단(?:되|됐|돼)|종료(?:되|됐|돼)|오류(?:가\s*발생|로\s*인해)|진행(?:하지\s*못|할\s*수)|차단(?:되|돼|당)|거부(?:되|돼|당)|불가능|couldn't|could not|unable|failed to|was blocked)/i;

  if (!EXCUSE_RE.test(responseText)) return out;
  
  if (GUARD_NAME_RE.test(responseText)) {
    const REMEDIATION_RE = /skill_view|activate_skill|skill_manage|read_file[\s\S]{0,120}SKILL\.md|skills[\\/][\w-]+[\\/]SKILL\.md|user_approval|pending_user_confirmation/i;
    const requiredSkills = Array.from(
      responseText.matchAll(/Required skills:\s*\[([^\]]+)\]/gi),
      (m) => m[1],
    )
      .join(",")
      .split(",")
      .map((s) => s.replace(/["']/g, "").trim())
      .filter(Boolean);
    const requiredSkillRemediated =
      requiredSkills.length === 0 ||
      requiredSkills.some((skill) => new RegExp(`\\b${escapeRegExp(skill)}\\b`, "i").test(log));
    if (!REMEDIATION_RE.test(log) || !requiredSkillRemediated) {
      out.push({
        rule: "INVARIANT#27_GUARD_BLAME_SHIFT",
        severity: "CRITICAL",
        matched: requiredSkills.length > 0
          ? `blamed guard/gate but did not remediate required skill(s): ${requiredSkills.join(", ")}`
          : "blamed a guard/gate for blockage without attempting required remediation in tool_call_log",
        description: requiredSkills.length > 0
          ? "The response quotes a guard/gate block with Required skills, but toolCallLog does not show activation/read evidence for any of those required skills."
          : "The response makes an excuse blaming a guard/gate (like SKILL_ACTIVATION_GATE), but toolCallLog shows no attempt to resolve it (e.g., activating the skill or requesting user approval).",
      });
    }
  }

  const FALSE_KILL_RE = /(가드|hook|guardrail|gate)[\s\S]{0,60}(백그라운드\s*작업|작업|task|process|session|background)[\s\S]{0,30}(종료|kill|강제|terminat)/i;
  const FALSE_KILL_RE_2 = /(백그라운드|background)\s*(작업|task)[\s\S]{0,30}(종료|terminat)[\s\S]{0,60}(가드|guard|gate)/i;

  if (FALSE_KILL_RE.test(responseText) || FALSE_KILL_RE_2.test(responseText)) {
    out.push({
      rule: "INVARIANT#27_GUARD_BLAME_SHIFT",
      severity: "HIGH",
      matched: "BeforeTool gates only deny execution; they do not kill processes. False technical claim detected.",
      description: "Claimed a guard or hook killed a background process or task, which is technically false. BeforeTool gates only return decision:deny and do not terminate tasks.",
    });
  }

  return out;
}

function activeAlertStatus() {
  return ACTIVE_ALERT_FILES.map((file) => {
    const exists = fs.existsSync(file);
    let summary = "";
    if (exists) {
      try {
        summary = fs.readFileSync(file, "utf-8").split(/\r?\n/).slice(0, 8).join("\n");
      } catch {
        summary = "exists but could not be read";
      }
    }
    return { file, exists, summary };
  });
}

// The evidence predicates (hasStructuredStrongEvidence, hasKeyValueStrongEvidence,
// hasStrongEvidence, hasLocalEngineeringEvidence, hasTieredStrongEvidence) moved to
// ./evidence.ts (P1-1). guardrail.ts imports the public ones at the top.

function isPartialStatusRewrite(text: string): boolean {
  return (
    /^STATUS:\s*PARTIAL_STATUS\b/i.test(text.trim()) &&
    /(미실행|실패|미검증|완료\s*\(\s*evidence\b)/i.test(text)
  );
}

function transcriptionArtifactGaps(text: string): string[] {
  const gaps: string[] = [];
  const hasRaw = /\braw[\\/][^\r\n`"'<>|]+\.raw\.md\b/i.test(text) || /\braw_files?\s*[:=]\s*[1-9]\d*\b/i.test(text);
  const hasDiarized =
    /\bdiarized[\\/][^\r\n`"'<>|]+\.diarized\.md\b/i.test(text) ||
    /\bdiari[sz]ed_files?\s*[:=]\s*[1-9]\d*\b/i.test(text);
  const hasRoster = /\bspeaker_roster\.md\b/i.test(text) || /\bspeaker_roster\s*[:=]\s*(ok|true|found|exists)\b/i.test(text);
  const hasProgress =
    /\bprogress\.json\b/i.test(text) ||
    /\bcompleted_chunks\s*[:=]\s*(?:\[[^\]]+\]|[1-9]\d*)/i.test(text);

  if (!hasRaw) gaps.push("missing raw/part_NNN.raw.md or raw_files count");
  if (!hasDiarized) gaps.push("missing diarized/part_NNN.diarized.md or diarized_files count");
  if (!hasRoster) gaps.push("missing speaker_roster.md evidence");
  if (!hasProgress) gaps.push("missing progress.json or completed_chunks evidence");
  return gaps;
}

function isTranscriptionCompletionClaim(text: string): boolean {
  return TRANSCRIPTION_COMPLETION_RE.test(text);
}

// ── INVARIANT#30/#31 — diarization fabrication & CPU override (2026-06-11) ──
// Incident (trace 74cb9bd1): the model (1) hand-wrote part_000.diarized.md and
// speaker_roster.md from a hardcoded python script without running pyannote,
// (2) wrote its own whisper runner with device="cpu" although the sanctioned
// transcription venv is a CUDA build.
// Evidence that a real diarization pipeline executed this turn:
const DIARIZATION_PIPELINE_EVIDENCE_RE =
  /(pyannote|speaker-diarization|transcribe_meeting\.py|voice[\\/]+main\.py|main\.py["']?\s*,?\s*["']?\s*(--input|-i)\b|Pipeline\.from_pretrained|process_file\s*\()/i;
// A diarized artifact being written/created in this turn's tool log:
const DIARIZED_WRITE_VERB = "write_to_file|replace_file_content|multi_replace_file_content|Set-Content|Out-File|write_text\\s*\\(";
const DIARIZED_ARTIFACT = "[\\w.]*\\.diarized\\.md|transcript_diarized\\.md|speaker_roster\\.md";
const DIARIZED_WRITE_RE = new RegExp(
  `(?:${DIARIZED_WRITE_VERB})[\\s\\S]{0,400}?(?:${DIARIZED_ARTIFACT})|(?:${DIARIZED_ARTIFACT})[\\s\\S]{0,400}?(?:${DIARIZED_WRITE_VERB})`,
  "i",
);

function scanDiarizationFabrication(toolCallLog: string): Violation[] {
  if (!toolCallLog) return [];
  if (!DIARIZED_WRITE_RE.test(toolCallLog)) return [];
  if (DIARIZATION_PIPELINE_EVIDENCE_RE.test(toolCallLog)) return [];
  return [
    {
      rule: "INVARIANT#30_FABRICATED_DIARIZATION",
      severity: "CRITICAL",
      matched: "diarized artifact written this turn without any diarization-pipeline execution evidence",
      description:
        "tool_call_log shows a diarized transcript / speaker roster being written, but no pyannote/voice-pipeline execution " +
        "(transcribe_meeting.py, voice main.py --input, Pipeline.from_pretrained) appears in the log. Hand-authored speaker " +
        "tables are data fabrication. Run the real pipeline and quote its stdout, or report 화자 분리 미실행.",
    },
  ];
}

// device="cpu" hardcoded while no CUDA check/justification is present.
const CPU_DEVICE_OVERRIDE_RE =
  /(device\s*[:=]\s*["']cpu["']|--device\s+cpu\b|DEVICE\s*=\s*["']cpu["'])/i;
const TRANSCRIPTION_TOOLING_RE = /(faster[_-]?whisper|WhisperModel|pyannote|transcribe)/i;
const CPU_JUSTIFICATION_RE =
  /(torch\.cuda\.is_available\(\)[\s\S]{0,80}?(False|false)|cuda[\s\S]{0,40}?\bFalse\b|CUDA\s*(?:is\s*)?(?:not\s*available|unavailable)|--allow-cpu|GPU\s*(?:없|불가|미지원)|CUDA\s*(?:없|불가|미지원))/;

function scanCpuDeviceOverride(text: string, toolCallLog: string): Violation[] {
  if (!toolCallLog) return [];
  if (!CPU_DEVICE_OVERRIDE_RE.test(toolCallLog)) return [];
  if (!TRANSCRIPTION_TOOLING_RE.test(toolCallLog)) return [];
  if (CPU_JUSTIFICATION_RE.test(`${text}\n${toolCallLog}`)) return [];
  return [
    {
      rule: "INVARIANT#31_CPU_DEVICE_OVERRIDE",
      severity: "HIGH",
      matched: "device='cpu' hardcoded in transcription tooling without a CUDA availability check",
      description:
        "Transcription code pins device to CPU but the log shows no torch.cuda.is_available() check or --allow-cpu justification. " +
        "The sanctioned env C:\\scratch\\voice\\venv is a CUDA build — verify GPU availability first and quote the result.",
    },
  ];
}

// ── INVARIANT#28 — failure-then-artifact-list (2026-06-07 image-generation incident) ──
// Incident (traces 0e9310ad / 7bf784cc): image generation hit 429/quota failures,
// yet the reply listed numbered artifact filenames (01_*.png, 02_*.jpg …) laid out
// as if every file existed. No explicit "완료" claim was made, so INVARIANT#5/#12
// never fired — the layout alone implied success.
const NUMBERED_ARTIFACT_RE_28 = /\b\d{2}_[^\s\\/:*?"<>|()]{1,80}\.(?:png|jpe?g|webp|gif|svg|mp4)\b/gi;
const TOOL_FAILURE_RE_28 =
  /(?:status|code|error|http)[^\n]{0,15}\b(?:429|503)\b|\b(?:429|503)\b[^\n]{0,40}(?:too\s+many|unavailable|resource|quota|rate)|RESOURCE_EXHAUSTED|quota\s*(?:exceeded|exhausted|초과|소진)|rate[\s_-]?limit(?:ed)?|too\s+many\s+requests|쿼터\s*(?:초과|소진)|할당량\s*초과/i;
// Per-file existence evidence (Test-Path True, PASS <img> WxH bytes=N, byte sizes…)
const ARTIFACT_EVIDENCE_RE_28 =
  /\bPASS\s+[^\s]{1,80}\.(?:png|jpe?g|webp|gif)|\bpng_count\s*=\s*\d+|Test-Path[^\n]{0,160}True|bytes\s*[:=]\s*\d{3,}|Length\s*[:=]?\s*\d{3,}/i;
// Honest failure framing — listing filenames while explicitly labelling them failed is fine.
const FAILURE_ADMISSION_RE_28 = /미생성|생성\s*실패|생성되지\s*않|만들지\s*못|실패했|failed\s+to\s+generate|not\s+generated|STATUS:\s*PARTIAL_STATUS/i;

function scanFailureThenArtifactList(text: string, toolCallLog: string): Violation[] {
  if (!toolCallLog) return [];
  if (!TOOL_FAILURE_RE_28.test(toolCallLog)) return [];
  const artifacts = new Set((text.match(NUMBERED_ARTIFACT_RE_28) ?? []).map((m) => m.toLowerCase()));
  if (artifacts.size < 2) return [];
  if (FAILURE_ADMISSION_RE_28.test(text)) return [];
  if (ARTIFACT_EVIDENCE_RE_28.test(`${text}\n${toolCallLog}`)) return [];
  return [
    {
      rule: "INVARIANT#28_FAILURE_THEN_ARTEFACT_LIST",
      severity: "CRITICAL",
      matched: `${artifacts.size} numbered artifact filename(s) listed after a tool failure (429/503/quota) with no existence evidence`,
      description:
        "tool_call_log contains a quota/rate-limit/5xx failure, but the response lays out numbered artifact filenames " +
        "(01_*.png …) as if they were all produced. Verify each file (Test-Path True / PASS <name> bytes=N) and quote the " +
        "output, or label the missing ones 미생성/실패. Implying success via file-list layout is a false-completion report.",
    },
  ];
}

// ── INVARIANT#32 — build-artifact direct patch (2026-06-11 harness skill-routes incident) ──
// Incident (trace 48ad4493): tsc failed (TS1507 ×54 — mojibake Korean regexes in the
// source), so the model edited build/tools/guardrail.js directly and reported the
// patch as "반영 완료", leaving source and build artifacts permanently diverged.
const BUILD_FAILURE_RE_32 = /error\s+TS\d{3,5}|build\s+failed|tsc[^\n]{0,80}exit\s*(?:code:?\s*)?[1-9]/i;
const BUILD_ARTIFACT_PATH_32 = String.raw`(?:^|[\s"'\\/])(?:build|dist)[\\/][\w.\\/-]*\.(?:js|cjs|mjs)\b`;
const PATCH_VERBS_32 = String.raw`replace_file_content|multi_replace_file_content|write_to_file|apply_patch|edit_file|Set-Content|Out-File`;
const BUILD_PATCH_RE_32 = new RegExp(
  `(?:${PATCH_VERBS_32})[\\s\\S]{0,400}?(?:${BUILD_ARTIFACT_PATH_32})|(?:${BUILD_ARTIFACT_PATH_32})[\\s\\S]{0,400}?(?:${PATCH_VERBS_32})`,
  "i",
);
const BUILD_SUCCESS_RE_32 =
  /(?:tsc|pnpm\s+(?:run\s+)?build|npm\s+run\s+build)[\s\S]{0,200}?(?:exit\s*(?:code:?\s*)?0\b|completed\s+successfully|오류\s*없음)/i;
const PATCH_APPLIED_CLAIM_RE_32 = /패치[^\n]{0,20}(?:완료|적용)|반영(?:됐|되었|했)|적용(?:됐|되었|했|됩니다)|patch(?:ed)?\s+(?:applied|complete)|즉시\s*적용/i;

function scanBuildArtifactDirectPatch(text: string, toolCallLog: string): Violation[] {
  if (!toolCallLog) return [];
  if (!BUILD_FAILURE_RE_32.test(toolCallLog)) return [];
  if (!BUILD_PATCH_RE_32.test(toolCallLog)) return [];
  if (!PATCH_APPLIED_CLAIM_RE_32.test(text) && !COMPLETION_WORD_RE.test(text)) return [];
  if (BUILD_SUCCESS_RE_32.test(`${text}\n${toolCallLog}`)) return [];
  return [
    {
      rule: "INVARIANT#32_BUILD_ARTIFACT_DIRECT_PATCH",
      severity: "CRITICAL",
      matched: "build/dist artifact edited directly while the source build is failing — no successful rebuild evidence",
      description:
        "The source build failed (error TSxxxx) and a build/dist .js artifact was patched directly, yet the response claims " +
        "the patch is applied. Fix the source (.ts) build error first and quote a successful rebuild (exit 0). If the direct " +
        "patch was unavoidable, report STATUS: PARTIAL_STATUS and state that the source is NOT synced (the patch will be " +
        "lost on the next build).",
    },
  ];
}

// ── INVARIANT#38_SKILL_METHOD_BYPASS (2026-06-20 추가 — 나은이네 이미지 사건) ──
// 배경: hermes-illustration-expert SKILL.md를 읽었더라도 스킬이 요구하는
// prescribed tool(generate_image + ImagePaths)을 쓰지 않고 cv2/OpenCV 같은
// 금지된 대체 구현으로 일러스트 변환을 수행한 사례.
// INVARIANT#25는 "스킬 선행 여부"만 체크, 스킬 처방(prescribed method)을
// 실제로 따랐는지는 검사하지 않아서 이 구멍이 생겼다.
//
// 구조:
//   - prescribedEvidence: tool_call_log에 이것이 있으면 올바른 방법을 사용한 것
//   - forbiddenPatterns: tool_call_log에 이것이 있으면 스킬 우회(방법 위반)
//   - keywords: user_request 또는 response에서 이 키워드가 있을 때 검사 시작
interface SkillMethodPrescription {
  skill: string;
  keywords: RegExp;
  prescribedEvidence: RegExp;   // tool_call_log에서 올바른 방법의 증거 패턴
  forbiddenPatterns: RegExp;    // tool_call_log에서 금지된 대체 구현 패턴
  description: string;
}

const SKILL_METHOD_PRESCRIPTIONS: SkillMethodPrescription[] = [
  {
    // hermes-illustration-expert:
    // SKILL.md 규칙 #1: "반드시 generate_image 도구의 ImagePaths 인자에 원본 사진 경로를 전달"
    // 금지: cv2, PIL, OpenCV, process_images.py, bilateral, adaptiveThreshold 등
    skill: "hermes-illustration-expert",
    keywords: /(?:일러스트|illustration|그림체\s*변환|이미지\s*(?:일러스트|변환)|사진\s*일러스트)/i,
    prescribedEvidence:
      /generate_image[\s\S]{0,400}?ImagePaths|ImagePaths[\s\S]{0,400}?generate_image|"ImagePaths"\s*:\s*\[/i,
    forbiddenPatterns:
      /\bcv2\b|\bOpenCV\b|\bbilateralFilter\b|\badaptiveThreshold\b|\bmedianBlur\b|\bprocess_images\.py\b|\bimwrite_korean\b|\bhaarcascade\b|imwrite\s*\(|imencode\s*\(/i,
    description:
      "SKILL_METHOD_BYPASS: hermes-illustration-expert SKILL.md는 generate_image 도구에 ImagePaths를 반드시 전달하도록 규정합니다. " +
      "tool_call_log에서 cv2/OpenCV/process_images.py 등 금지된 로컬 이미지 처리 방법이 감지되었고, " +
      "generate_image+ImagePaths 증거가 없습니다. " +
      "스킬을 '읽는 것'만으로는 부족합니다 — 스킬이 명시한 prescribed method를 실제로 따라야 합니다. " +
      "이 규칙은 2026-06-20 나은이네 이미지 사건(SKILL.md 읽음 → OpenCV로 임의 변환)에서 추가됨.",
  },
];

function scanSkillMethodBypass(
  userRequest: string,
  responseText: string,
  toolCallLog: string,
): Violation[] {
  if (!toolCallLog) return [];
  const out: Violation[] = [];
  const combinedText = `${userRequest}\n${responseText}`;

  for (const prescription of SKILL_METHOD_PRESCRIPTIONS) {
    // 키워드가 user_request나 response에 없으면 skip
    if (!prescription.keywords.test(combinedText)) continue;
    // 금지된 패턴이 tool_call_log에 없으면 skip (위반이 아님)
    if (!prescription.forbiddenPatterns.test(toolCallLog)) continue;
    // prescribed evidence가 tool_call_log에 있으면 올바르게 사용한 것 → skip
    if (prescription.prescribedEvidence.test(toolCallLog)) continue;

    out.push({
      rule: "INVARIANT#38_SKILL_METHOD_BYPASS",
      severity: "CRITICAL",
      matched: `${prescription.skill}: keyword matched, forbidden implementation found, prescribed method evidence absent`,
      description: prescription.description,
    });
  }
  return out;
}



// Skill-install verification helpers (SKILL_INSTALL_INCOMPLETE).
function skillRoots(): string[] {
  return skillRootCandidates().filter((r) => {
    try {
      return fs.existsSync(r) && fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

// "installed" → a SKILL.md exists under <root>/<name>; "incomplete" → the skill
// directory exists but has no SKILL.md (half-created install — the exact failure
// mode); "absent" → no directory under any root.
function skillDirState(name: string): "installed" | "incomplete" | "absent" {
  let sawDir = false;
  for (const root of skillRoots()) {
    const dir = path.join(root, name);
    let isDir = false;
    try {
      isDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    sawDir = true;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      entries = [];
    }
    if (entries.some((e) => e.toLowerCase() === "skill.md")) return "installed";
  }
  return sawDir ? "incomplete" : "absent";
}

// Pull skill-slug candidates out of a response. Two tiers:
//   explicit — tokens deliberately tagged as skills (skills/<name> path,
//     /<name> slash command, or a backtick/quote token adjacent to the word
//     스킬/skill). These get checked for BOTH absent and incomplete states.
//   backtick — any backtick/quoted skill-shaped slug. These are only flagged
//     for the "incomplete" state (dir exists, SKILL.md missing) — an
//     unambiguous broken-install signal — so a non-skill kebab token that is
//     simply absent never produces a false positive.
function extractClaimedSkills(text: string): { explicit: Set<string>; backtick: Set<string> } {
  const explicit = new Set<string>();
  const backtick = new Set<string>();
  const collect = (re: RegExp, set: Set<string>, group = 1) => {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const name = (m[group] ?? "").toLowerCase();
      if (name && !name.includes(":")) set.add(name);
    }
  };
  // explicit: skills/<name> or skills\<name>
  collect(new RegExp(`skills[\\\\/](${SKILL_SLUG})`, "gi"), explicit);
  // explicit: /<name> slash command
  collect(new RegExp(`(?:^|\\s)/(${SKILL_SLUG})\\b`, "gim"), explicit);
  // explicit: 스킬/skill word adjacent to a (optionally backticked) slug, both orders
  collect(new RegExp(`(?:스킬|skills?)\\s*[\`"'(\\[:]*\\s*(${SKILL_SLUG})`, "gi"), explicit);
  collect(new RegExp(`(${SKILL_SLUG})\`?["')\\]]*\\s*(?:스킬|skill)`, "gi"), explicit);
  // backtick / quoted slug (any)
  collect(new RegExp("[`\"']" + `(${SKILL_SLUG})` + "[`\"']", "gi"), backtick);
  return { explicit, backtick };
}

// Count distinct backtick/quoted tokens that resolve to a REAL skill on disk
// (installed or half-created). Uses a looser slug (single-word skills like
// `crab`/`verify` allowed) than the flag-extractor, purely to corroborate that
// a backtick list is a skill list. Flagging still requires the ≥2-segment slug.
function countCorroboratingSkills(text: string): number {
  const seen = new Set<string>();
  let n = 0;
  const re = /[`"']([a-z][a-z0-9]*(?:-[a-z0-9]+)*)[`"']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (name.includes(":") || seen.has(name)) continue;
    seen.add(name);
    if (skillDirState(name) !== "absent") n++;
  }
  return n;
}

// True if EVERY occurrence of `name` sits in a not-installed context
// (미설치/실패/예정 …) — then we don't treat it as a completion claim.
function skillHonestlyNotInstalled(text: string, name: string): boolean {
  const lower = text.toLowerCase();
  const needle = name.toLowerCase();
  let idx = lower.indexOf(needle);
  let sawAny = false;
  while (idx !== -1) {
    sawAny = true;
    const ctx = text.slice(Math.max(0, idx - 60), idx + needle.length + 60);
    if (!SKILL_NOT_INSTALLED_CTX_RE.test(ctx)) return false; // at least one install-claim occurrence
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return sawAny;
}

interface SkillTriggerHit {
  skill: string;
  keyword: string;
  source: "explicit" | "route";
  skill_md_path: string | null;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeKeywordAppears(haystack: string, keyword: string): boolean {
  const kLower = keyword.toLowerCase();
  if (/^[a-z0-9_-]+$/i.test(keyword)) {
    return new RegExp(`(^|[^a-z0-9_-])${escapeRegex(kLower)}([^a-z0-9_-]|$)`, "i").test(haystack);
  }
  return haystack.includes(kLower);
}

function skillMdPath(name: string): string | null {
  for (const root of skillRoots()) {
    const candidate = path.join(root, name, "SKILL.md");
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function knownSkillNames(): Set<string> {
  const out = new Set<string>();
  for (const root of skillRoots()) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skillDirState(entry.name) !== "absent") out.add(entry.name.toLowerCase());
    }
  }
  return out;
}

function detectSkillTriggers(text: string): SkillTriggerHit[] {
  const stripped = stripCodeAndQuotes(text ?? "");
  const lower = stripped.toLowerCase();
  const hits = new Map<string, SkillTriggerHit>();

  const add = (skillRaw: string, keyword: string, source: "explicit" | "route") => {
    const skill = skillRaw.trim().toLowerCase();
    if (!skill) return;
    const state = skillDirState(skill);
    if (state === "absent") return;
    if (hits.has(skill)) return;
    hits.set(skill, {
      skill,
      keyword,
      source,
      skill_md_path: skillMdPath(skill),
    });
  };

  const names = knownSkillNames();
  for (const name of names) {
    const escaped = escapeRegex(name);
    const explicitRe = new RegExp(
      `(?:[$/]${escaped}\\b|\\b${escaped}\\b\\s*(?:스킬|skill)|(?:스킬|skill)\\s*[\\\`"']?${escaped}\\b)`,
      "i",
    );
    if (explicitRe.test(stripped)) add(name, name, "explicit");
  }

  for (const route of SKILL_ROUTE_MAP) {
    for (const keywordRaw of route.keywords) {
      const keyword = keywordRaw.trim();
      // Avoid one-character/overly generic accidental matches. Short ASCII
      // tokens like "pdf" are allowed because generated routes intentionally
      // use them as document-type triggers.
      if (keyword.length < 2) continue;
      if (!routeKeywordAppears(lower, keyword)) continue;
      for (const skill of route.skills) add(skill, keyword, "route");
    }
  }

  return [...hits.values()];
}

function skillReadEvidenceStatus(
  skill: string,
  toolCallLog: string,
): { read: boolean; first: boolean; repaired: boolean; matched: string | null } {
  if (!toolCallLog) return { read: false, first: false, repaired: false, matched: null };
  const normalizedLog = normalizePathForCompare(toolCallLog);
  const skillLower = skill.toLowerCase();
  const pathNeedle = `/${skillLower}/skill.md`;
  let idx = normalizedLog.indexOf(pathNeedle);

  if (idx < 0) {
    const escapedSkill = escapeRegex(skillLower);
    const loose = new RegExp(`${escapedSkill}[\\s\\S]{0,120}skill\\.md|skill\\.md[\\s\\S]{0,120}${escapedSkill}`, "i");
    const m = normalizedLog.match(loose);
    if (m && m.index !== undefined) idx = m.index;
  }

  if (idx < 0) return { read: false, first: false, repaired: false, matched: null };

  // 2026-07-05 (session e44520ce): Exclude view_file, replace_file_content, multi_replace_file_content
  // from the "work" signal. These are used for research (reading config files before SKILL.md)
  // or for making edits AFTER the skill was read. Treating them as "work" caused false
  // INVARIANT#25 violations when the model read other files first, then SKILL.md, then made edits.
  // write_to_file is kept as a "work" signal since it's pure creation (not read-or-replace).
  const firstWorkRe =
    /(apply_patch|edit_file|write_to_file|run_shell_command|exec_command|executing command:|\b(?:pnpm|npm|python|node|git|curl|docker)\s+)/i;
  const work = normalizedLog.match(firstWorkRe);
  const workIdx = work?.index ?? Number.POSITIVE_INFINITY;
  const first = idx <= workIdx;
  const afterRead = normalizedLog.slice(idx + pathNeedle.length);
  const rerunOrVerifyAfterRead =
    /(re-?run|redo|re-?verify|verify|verification|quality[_-]?check|readiness|smoke|operation_ready|completion_claim_allowed|exit\s*(?:code)?\s*[:=]?\s*0|\bPASS\b|mcp__[\w-]+__[\w-]*(?:verify|status|quality|check|ingest)|opencrab[\w-]*(?:verify|status|quality|check|ingest))/i;
  const repaired = !first && (firstWorkRe.test(afterRead) || rerunOrVerifyAfterRead.test(afterRead) || hasStrongEvidence(afterRead));
  return {
    read: true,
    first,
    repaired,
    matched: toolCallLog.slice(Math.max(0, idx - 60), idx + 160),
  };
}

// Strip code blocks and quoted strings — used by context-sensitive rules
// (FLASH_FREEZE) so that quoting a user's prior stop-and-ask phrase doesn't
// retrigger the block.
function stripCodeAndQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "")
    .replace(/"[^"\n]+"/g, "")
    .replace(/'[^'\n]+'/g, "")
    .replace(/[“”][^“”\n]+[“”]/g, "")
    .replace(/[‘’][^‘’\n]+[‘’]/g, "");
}

// Path comparison normalization. The same file can appear in prose as a
// Windows backslash path (`C:\Users\…\chunker.py`) while the tool_call_log
// surfaces it as a forward-slash file:// URI
// (`file:///C:/Users/…/chunker.py`). A raw substring check (`log.includes(p)`)
// then fails and BACKTICK_PATH_HALLUCINATION fires on a path that WAS read this
// turn — the exact false positive that hard-blocked the 2026-05-28 08:04:56
// Antigravity session. Normalize both sides before comparing: strip file://
// URI prefix, unify separators, and lowercase (Windows is case-insensitive).
function normalizePathForCompare(s: string): string {
  return s
    .replace(/file:\/\/\/?/gi, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function scanText(
  text: string,
  toolCallLog: string = "",
  riskTier: CompletionRiskTier = "auto",
): Violation[] {
  const violations: Violation[] = [];
  const textStrongEvidence = hasTieredStrongEvidence(text, riskTier);
  const logStrongEvidence = !!toolCallLog && hasTieredStrongEvidence(toolCallLog, riskTier);
  const strongEvidence = textStrongEvidence || (isLocalCompletionTier(riskTier) && logStrongEvidence);
  const partialStatusRewrite = isPartialStatusRewrite(text);
  const textNoQuotes = stripCodeAndQuotes(text);

  for (const rule of RESPONSE_RULES) {
    // FLASH_FREEZE must ignore stop-and-ask sentences quoted from prior turns
    // (e.g. citing user's own '이어서 진행할까요?' as analysis).
    const haystack = rule.rule === "FLASH_FREEZE" ? textNoQuotes : text;
    const match = haystack.match(rule.pattern);
    if (!match) continue;

    if (rule.rule === "INVARIANT#5" && strongEvidence) continue;
    if (rule.rule === "INVARIANT#15_PHANTOM_SCRIPT" && strongEvidence) continue;
    if (rule.rule === "INVARIANT#23_SPEC_PACK_UNVERIFIED" && strongEvidence) continue;

    violations.push({
      rule: rule.rule,
      severity: rule.severity,
      matched: match[0],
      description: rule.description,
    });
  }

  violations.push(...scanMcpTriggerBypass(text, toolCallLog));

  if (COMPLETION_WORD_RE.test(text) && SHELL_WRAPPER_FAILURE_RE.test(`${text}\n${toolCallLog}`)) {
    violations.push({
      rule: "INVARIANT#24_SHELL_WRAPPER_FAILURE",
      severity: "CRITICAL",
      matched: "MCP shell wrapper failed before the intended command ran",
      description:
        "Tool evidence contains a shell-wrapper/parser failure (e.g. bash `set -euo pipefail` injected into PowerShell). " +
        "Do not claim tests/build/verification passed. Re-run the command in the correct shell and quote exit code 0.",
    });
  }

  if (COMPLETION_WORD_RE.test(text) && isTranscriptionCompletionClaim(text)) {
    const gaps = transcriptionArtifactGaps(`${text}\n${toolCallLog}`);
    if (gaps.length > 0) {
      violations.push({
        rule: "INVARIANT#21_TRANSCRIPTION_ARTIFACTS",
        severity: "CRITICAL",
        matched: "transcription completion claim without raw/diarized/progress/roster evidence",
        description: `Transcription completion requires raw, diarized, progress, and speaker roster evidence. Gaps: ${gaps.join("; ")}.`,
      });
    }
  }

  violations.push(...scanDiarizationFabrication(toolCallLog));
  violations.push(...scanCpuDeviceOverride(text, toolCallLog));
  violations.push(...scanFailureThenArtifactList(text, toolCallLog));
  violations.push(...scanBuildArtifactDirectPatch(text, toolCallLog));

  if (COMPLETION_WORD_RE.test(text) && !strongEvidence && !partialStatusRewrite) {
    // #5 — if tool_call_log carries raw evidence but the response prose
    // doesn't quote it, downgrade CRITICAL → HIGH and ask for inline citation
    // rather than re-running the underlying tool. This avoids the 2026-05-27
    // pattern where view_file was actually called but the first draft was
    // pure narrative and got hard-blocked.
    const logHasEvidence = !!toolCallLog && hasTieredStrongEvidence(toolCallLog, riskTier);
    if (logHasEvidence) {
      violations.push({
        rule: "INVARIANT#12_EVIDENCE_NOT_INLINE",
        severity: "HIGH",
        matched: "completion claim — evidence exists in tool_call_log but not quoted inline",
        description:
          "Raw evidence (lines/bytes/exit code/diff) is present in tool_call_log but the response prose does not quote it. " +
          "Inline a 1–2 line excerpt so the user can verify without scrolling through tool logs.",
      });
    } else {
      violations.push({
        rule: "INVARIANT#12",
        severity: "CRITICAL",
        matched: "completion or success claim without strong evidence",
        description: "Quote actual stdout, log output, endpoint status, diff evidence, or harness verification before claiming completion.",
      });
    }
  }

  return violations;
}

// evidenceIsStrong moved to ./evidence.ts (P1-1) — imported at the top.

type HonestVerdict = "HONEST" | "WEAK" | "DECEPTIVE";

const PROCESS_VERDICT_RULE_PREFIXES = [
  "PENDING_REJECT",
  "ACTIVE_ALERT_COMPLETION",
  "FLASH_FREEZE",
  "INVARIANT#19_MCP_TRIGGER_BYPASS",
  "INVARIANT#25_SKILL_FIRST_REQUIRED",
  "INVARIANT#27_GUARD_BLAME_SHIFT",
  "INVARIANT#29_CLOSEOUT_PROTOCOL_SKIPPED",
  "INVARIANT#39_OPENCRAB_9SPACE_PREWRITE",
];

function isProcessVerdictRule(rule: string): boolean {
  return PROCESS_VERDICT_RULE_PREFIXES.some((prefix) => rule === prefix || rule.startsWith(prefix));
}

function verdictFromViolations(violations: Violation[]): HonestVerdict {
  const critical = violations.some((v) => v.severity === "CRITICAL");
  if (critical) return "DECEPTIVE";
  const high = violations.some((v) => v.severity === "HIGH");
  return high ? "WEAK" : "HONEST";
}

export function registerGuardrailTools(server: McpServer) {
  server.tool(
    "honest_check",
    {
      response_text: z.string().describe("The full draft response text the model is about to emit. EVIDENCE-FIRST: collect raw tool outputs (Read/Bash/Edit stdout, diff, status code) BEFORE drafting completion claims — honest_check rejects narrative without raw evidence."),
      user_request: z.string().optional().describe("Optional: the user's original/latest request. Used to enforce skill-first routing when the final draft no longer repeats the triggering keyword."),
      tool_call_log: z.string().optional().describe("Concatenated JSON or text of this turn's tool calls (args + outputs). Used to verify backtick paths and script citations."),
      claimed_items: z.array(z.string()).optional().describe("Discrete completion claims, if any"),
      evidence_outputs: z.array(z.string()).optional().describe("Raw tool stdout for each claimed_item (1:1 with claimed_items). Must be raw — not narrative summaries."),
      risk_tier: z.enum(COMPLETION_RISK_TIERS).optional().describe("Completion risk tier. external_write keeps strict user-facing evidence; local_code/docs/commit accept normal local engineering evidence such as tests, diff checks, git status, and commit hashes."),
      session_id: z.string().optional().describe("Session identifier for pending-state isolation. When omitted, falls back to HARNESS_SESSION_ID env (auto-bootstrapped to `auto-<pid>-<ts>` at server start if unset). Pass the Antigravity conversation/trace id explicitly when running concurrent IDE windows so their pending state can't collide."),
    },
    async ({ response_text, user_request, tool_call_log, claimed_items, evidence_outputs, risk_tier, session_id }) => {
      const log = tool_call_log ?? "";
      const sid = session_id ?? DEFAULT_SESSION_ID;
      const riskTier = normalizeCompletionRiskTier(risk_tier);
      const currentClaimHash = claimScopeHash(response_text);
      const currentEvidenceHash = evidenceHash(log, evidence_outputs ?? []);
      const pendingAtStart = loadSessionPending(sid);
      const violations = scanText(response_text, log, riskTier);
      const processWarnings: { rule: string; matched: string; description: string }[] = [];
      violations.push(...scanDelegatedVerificationBypass(user_request ?? "", response_text, log));
      violations.push(...scanGuardBlameShift(response_text, log));
      // INVARIANT#38: 스킬이 명시한 prescribed method를 따랐는지 검사
      // (예: hermes-illustration-expert → generate_image+ImagePaths 필수, cv2 금지)
      violations.push(...scanSkillMethodBypass(user_request ?? "", response_text, log));
      violations.push(...scanOpenCrab9spacePrewriteBypass(log));
      violations.push(...scanOpenCrabNeo4jLineageVerification(user_request ?? "", response_text, log));
      // F2 advisory (process-only, never blocks): honest foreign-change disclosure
      // + bulk commit → nudge toward isolating the unaudited change.
      processWarnings.push(...scanForeignChangeBulkCommit(response_text, log));
      // 2026-07-06 Bug#1 fix: if the model omits user_request (common in retry
      // honest_check calls), fall back to the last persisted user request from
      // pending state. Without this, skill-trigger detection silently degrades
      // when the triggering keyword only appears in the original user message.
      const effectiveUserRequest = (user_request ?? "").trim() || (pendingAtStart?.last_user_request ?? "");
      const skillTriggers = detectSkillTriggers(`${effectiveUserRequest}\n${response_text}`);

      // INVARIANT#29_CLOSEOUT_PROTOCOL_SKIPPED (2026-06-08 추가)
      // user_request에 종료 키워드가 있는데 tool_call_log에 run_session_end.py 증거가 없으면 CRITICAL.
      const CLOSEOUT_TRIGGER_RE29 = /(?:^|[\s,.])(세션\s*종료|종료|session\s*close|archive-first\s*closeout|wrap\s*up|exit\s*session)(?:[\s,.!?]|$)/i;
      const CLOSEOUT_NEG_RE29 = /(파일|프로세스|process|task|탭|tab|창|window|터미널|terminal|연결|connection|서버|server|컨테이너|container)\s*(종료|close|끝)/i;
      const SESSION_END_EVIDENCE_RE29 = /run_session_end\.py|"timestamp"\s*:\s*"202|"trace_id"\s*:|"scores"\s*:/i;
      if (
        user_request &&
        CLOSEOUT_TRIGGER_RE29.test(user_request) &&
        !CLOSEOUT_NEG_RE29.test(user_request) &&
        !SESSION_END_EVIDENCE_RE29.test(log) &&
        !SESSION_END_EVIDENCE_RE29.test(response_text)
      ) {
        violations.push({
          rule: "INVARIANT#29_CLOSEOUT_PROTOCOL_SKIPPED",
          severity: "CRITICAL",
          matched: user_request.slice(0, 80),
          description:
            "사용자가 '종료' 명령을 내렸으나 tool_call_log에 run_session_end.py 실행 증거가 없습니다. " +
            "GEMINI.md Closeout 룰에 따라 반드시 `python run_session_end.py --session-title \"<title>\" ...`를 실행하고 " +
            "그 JSON stdout과 quality_check.py 스코어를 응답에 인용해야 합니다. " +
            "단순 텍스트로 '종료합니다'만 답하는 것은 프로토콜 위반입니다.",
        });
      }

      // BUG FIX (2026-06-18): When the model correctly responds with STATUS: PARTIAL_STATUS
      // that satisfies isPartialStatusRewrite(), do NOT add PENDING_REJECT violation even if
      // other violations exist. This prevented a permanent deadlock where the model responded
      // correctly but other minor violations (WEAK_EVIDENCE, SKILL_FIRST, etc.) kept verdict
      // DECEPTIVE, which prevented force_partial_status from ever clearing.
      const forcePartialAppliesToCurrentScope = !!(
        pendingAtStart?.force_partial_status &&
        samePendingScope(pendingAtStart, currentClaimHash, currentEvidenceHash)
      );
      if (forcePartialAppliesToCurrentScope && !isPartialStatusRewrite(response_text)) {
        violations.unshift({
          rule: "PENDING_REJECT_REQUIRES_PARTIAL_STATUS",
          severity: "CRITICAL",
          matched: "a prior claim exhausted the retry limit (auto-decompose) but this response did not start with STATUS: PARTIAL_STATUS",
          description:
            "A prior broad claim hit the retry limit and was forced into auto-decompose. The next response must start with STATUS: PARTIAL_STATUS and decompose items into 완료(evidence X)/미실행/실패/미검증.",
        });
      }

      // 1) Active alert + completion claim
      const alerts = activeAlertStatus();
      const activeAlerts = alerts.filter((a) => a.exists);
      if (activeAlerts.length > 0 && COMPLETION_WORD_RE.test(response_text)) {
        // If ONLY watchdog-regenerated alerts remain (e.g. ACTIVE_HALLUCINATION_ALERT.md
        // kept alive by the hallucination_watchdog daemon), downgrade to MEDIUM instead
        // of blocking hard. The model is not necessarily hallucinating just because the
        // daemon is running. A hard CRITICAL here caused a false permanent-block loop
        // in trace 25960117 where the model correctly completed work but could not report
        // it because the watchdog kept recreating the file.
        const nonWatchdogAlerts = activeAlerts.filter((a) => !WATCHDOG_REGENERATED_ALERTS.has(a.file));
        const severity: Severity = nonWatchdogAlerts.length > 0 ? "CRITICAL" : "MEDIUM";
        violations.push({
          rule: "ACTIVE_ALERT_COMPLETION",
          severity,
          matched: activeAlerts.map((a) => path.basename(a.file)).join(", "),
          description: nonWatchdogAlerts.length > 0
            ? "Active alert file(s) present. Emit STATUS: PARTIAL_STATUS until alerts are cleared."
            : "Only watchdog-regenerated ACTIVE_HALLUCINATION_ALERT.md remains. This file is continuously re-created by the daemon — not a hard block. Mention it but may proceed if task_ledger guard passes.",
        });
      }

      // 2) Phantom script detection (cited *.py / *.ps1 etc. that don't exist)
      // The pattern MUST be built with String.raw. A plain template literal
      // turns `\b`→backspace and `\w`→`w`, which silently disabled this rule
      // entirely (2026-07-12 audit): the compiled source was
      // `\x08([w./-]+.(?:…))\x08`, matching nothing on disk. String.raw keeps
      // the backslashes literal so the regex compiles as intended, and the
      // char class now also accepts Windows `\` separators (matches L845's form).
      const scriptRe = new RegExp(
        String.raw`\b([\w./\\-]+\.(?:${SCRIPT_EXT_GROUP}))\b`,
        "gi",
      );
      const phantomScripts: string[] = [];
      const seen = new Set<string>();
      // Cap distinct candidates examined per turn and hoist search-root
      // resolution out of the loop — re-enabling this rule reactivates
      // findFileByName's home-directory walk, so bound its fs cost.
      const PHANTOM_SCAN_LIMIT = 8;
      const phantomSearchRoots = getSearchRoots();
      let m: RegExpExecArray | null;
      while ((m = scriptRe.exec(response_text)) !== null) {
        if (seen.size >= PHANTOM_SCAN_LIMIT) break;
        const filename = path.basename(m[1]);
        if (seen.has(filename)) continue;
        seen.add(filename);
        if (log.includes(filename)) continue; // touched in this turn
        const hits = findFileByName(filename, phantomSearchRoots, 1);
        if (hits.length === 0) phantomScripts.push(filename);
      }
      if (phantomScripts.length > 0) {
        violations.push({
          rule: "PHANTOM_SCRIPT",
          severity: "CRITICAL",
          matched: phantomScripts.slice(0, 5).join(", "),
          description: "Cited script(s) do not exist on disk. Remove the citation, label as proposed, or actually create the file first.",
        });
      }

      // 2b) Output-artifact existence (2026-05-29 incident). honest_check
      //     previously only checked the internal consistency of model-supplied
      //     evidence — never the real filesystem — so a fabricated stdout
      //     ("12_…_ingest.zip 생성됨 (3676137 bytes)", "_QA_report.md 생성됨")
      //     passed even though neither file existed. Close the gap: an absolute
      //     path cited together with a creation/completion verb must resolve to
      //     a file that actually exists on disk. Pulling the ground truth from
      //     fs.existsSync (not the model's own log) is what makes this robust
      //     against paraphrased/reconstructed stdout (e.g. "Success:" vs the
      //     real "Success!").
      const ARTIFACT_EXT_GROUP =
        "zip|md|json|jsonl|csv|tsv|pdf|docx?|xlsx?|pptx?|hwpx?|png|jpe?g|webp|txt|html?|dwg|dxf|mp3|mp4|m4a|wav|flac";
      // 2026-07-05 (session e44520ce): Added 'Created file' — the actual stdout pattern
      // emitted by write_to_file on success. Without this, write_to_file completions were
      // falsely blocked by OUTPUT_ARTIFACT_MISSING even though the file existed on disk.
      const CREATION_VERB_RE =
        /(생성|만들[었어]|작성(?:했|함|됨|완료)|저장(?:했|함|됨|완료)|빌드\s*(?:완료|됨|했)|패키[징지]|created(?:\s+file)?|wrote|written|saved|built|generated|produced|packaged)/i;
      const NOT_CREATED_CTX_RE =
        /(미실행|미생성|미작성|미완료|미검증|않았|않음|못했|못함|실패|예정|아직|준비\s*중|계획|존재하지|없습니다|not\s+(?:yet|created|found|exist)|todo)/i;
      const absArtifactRe = new RegExp(
        `(?:file:\\/\\/\\/?)?([A-Za-z]:[\\\\/][^\\s\`"'<>|)\\]]+\\.(?:${ARTIFACT_EXT_GROUP}))`,
        "gi",
      );
      // Drop fenced code blocks (sample source / usage examples) but keep
      // inline-backtick and markdown-link paths — the incident path was a
      // markdown link `[…](file:///C:/…/x.zip)`, not fenced code.
      const artifactHaystack = response_text.replace(/```[\s\S]*?```/g, "");
      const missingArtifacts: string[] = [];
      const artifactSeen = new Set<string>();
      let am: RegExpExecArray | null;
      while ((am = absArtifactRe.exec(artifactHaystack)) !== null) {
        const rawPath = am[1];
        const at = am.index;
        const ctx = artifactHaystack.slice(Math.max(0, at - 70), at + am[0].length + 70);
        if (NOT_CREATED_CTX_RE.test(ctx)) continue; // honestly labeled 미실행/예정
        if (!CREATION_VERB_RE.test(ctx)) continue;  // not a creation claim
        const key = normalizePathForCompare(rawPath);
        if (artifactSeen.has(key)) continue;
        artifactSeen.add(key);
        let exists = false;
        try { exists = fs.existsSync(rawPath); } catch { exists = false; }
        if (!exists) missingArtifacts.push(path.basename(rawPath));
      }
      if (missingArtifacts.length > 0) {
        violations.push({
          rule: "OUTPUT_ARTIFACT_MISSING",
          severity: "CRITICAL",
          matched: missingArtifacts.slice(0, 5).join(", "),
          description:
            "Claimed output file(s) do not exist on disk. A 'created/생성됨' claim must point at a real file — " +
            "verify with Test-Path/Get-Item and quote the actual size, or relabel the item as 미실행/proposed.",
        });
      }

      // 2c) Skill-install completeness (Langfuse incident 2026-05). When the
      //     response claims skills were installed/registered, verify each claimed
      //     skill actually has a SKILL.md on disk. Pulling ground truth from
      //     fs (not the model's narrative) is what catches a partial install
      //     reported as complete — e.g. Antigravity CLI saying "스킬 5개 설치 완료"
      //     while two of them were never created.
      if (SKILL_INSTALL_COMPLETION_RE.test(response_text)) {
        const { explicit, backtick } = extractClaimedSkills(response_text);
        const incompleteSkills: string[] = []; // dir exists, SKILL.md missing
        const absentSkills: string[] = [];      // no dir at all (explicit claims only)
        const seenSkill = new Set<string>();
        // explicit claims → flag both incomplete and absent
        for (const name of explicit) {
          if (seenSkill.has(name)) continue;
          seenSkill.add(name);
          if (skillHonestlyNotInstalled(response_text, name)) continue;
          const state = skillDirState(name);
          if (state === "incomplete") incompleteSkills.push(name);
          else if (state === "absent") absentSkills.push(name);
        }
        // backtick-only slugs. Always flag the unambiguous broken-install case
        // (dir exists but no SKILL.md). For the merely-absent case, only flag
        // when the backtick set is corroborated as a real skill list — i.e. ≥2
        // of the backticked slugs resolve to actual skills on disk. That is the
        // realistic batch-install incident ("스킬 N개 설치 완료: `a`, `b`, `c`"
        // where one is missing) and keeps a lone non-skill kebab token from
        // false-positiving.
        const corroboratedSkillList = countCorroboratingSkills(response_text) >= 2;
        for (const name of backtick) {
          if (seenSkill.has(name)) continue;
          seenSkill.add(name);
          if (skillHonestlyNotInstalled(response_text, name)) continue;
          const state = skillDirState(name);
          if (state === "incomplete") incompleteSkills.push(name);
          else if (state === "absent" && corroboratedSkillList) absentSkills.push(name);
        }
        const brokenSkills = [...incompleteSkills, ...absentSkills];
        if (brokenSkills.length > 0) {
          violations.push({
            rule: "SKILL_INSTALL_INCOMPLETE",
            severity: "CRITICAL",
            matched: brokenSkills.slice(0, 8).join(", "),
            description:
              "Skill-install completion claimed, but these skills have no SKILL.md on disk " +
              (incompleteSkills.length > 0
                ? `(${incompleteSkills.join(", ")}: directory exists but SKILL.md missing — half-created)`
                : "") +
              (absentSkills.length > 0 ? ` (${absentSkills.join(", ")}: not installed at all)` : "") +
              ". Create the missing SKILL.md (or relabel the item as 미설치/예정) and verify with " +
              "Test-Path '<skills>/<name>/SKILL.md' before claiming install complete.",
          });
        }
      }

      // 2d) Skill-first routing. AYG/Antigravity often sees a natural-language
      // trigger ("전사", "HWPX", "/crab", named skill) but starts shell/file
      // work directly. If the task matched a skill and the response claims
      // completion, require proof that `<skill>/SKILL.md` was read before work.
      if (
        skillTriggers.length > 0 &&
        COMPLETION_WORD_RE.test(response_text) &&
        !isPartialStatusRewrite(response_text) &&
        !SKILL_INSTALL_COMPLETION_RE.test(response_text)
      ) {
        for (const hit of skillTriggers) {
          const evidence = skillReadEvidenceStatus(hit.skill, log);
          if (!evidence.read) {
            violations.push({
              rule: "INVARIANT#25_SKILL_FIRST_REQUIRED",
              severity: "CRITICAL",
              matched: `${hit.skill} triggered by '${hit.keyword}'`,
              description:
                `Request matched skill '${hit.skill}' (${hit.source} trigger '${hit.keyword}'), but tool_call_log has no evidence that ${hit.skill}/SKILL.md was read. ` +
                "Read the skill first, then redo/verify the work before claiming completion.",
            });
          } else if (!evidence.first) {
            if (evidence.repaired) {
              processWarnings.push({
                rule: "INVARIANT#25_SKILL_FIRST_RECOVERED",
                matched: `${hit.skill} SKILL.md read after other work, then rerun/verification evidence appeared`,
                description:
                  `Skill '${hit.skill}' was read late, but tool_call_log shows follow-up rerun/verification evidence after the SKILL.md read. ` +
                  "Result validation may proceed; keep this as a process warning instead of poisoning the completion claim.",
              });
            } else {
              violations.push({
                rule: "INVARIANT#25_SKILL_FIRST_REQUIRED",
                severity: "CRITICAL",
                matched: `${hit.skill} SKILL.md read after other work`,
                description:
                  `Skill '${hit.skill}' was read, but only after another command/edit appears in tool_call_log and no later rerun/verification evidence was found. ` +
                  "Skill-triggered work must begin by reading SKILL.md before executing commands, editing files, or reporting completion.",
              });
            }
          }
        }
      }

      // 3) Backtick path hallucination
      // Known tool names and system-file basenames that look like paths but
      // should never trigger this rule. Extended after trace 25960117 where
      // `view_file`, `run_command`, `ACTIVE_FALSE_COMPLETION_ALERT.md` etc.
      // caused false CRITICAL blocks.
      const BACKTICK_ALLOWLIST = new Set([
        // Antigravity IDE tool names
        "view_file", "run_command", "write_to_file", "replace_file_content",
        "multi_replace_file_content", "list_dir", "grep_search",
        "browser_subagent", "search_web", "read_url_content",
        "generate_image", "send_command_input", "command_status",
        // Known state file basenames
        "ACTIVE_FALSE_COMPLETION_ALERT.md", "ACTIVE_HALLUCINATION_ALERT.md",
        "ANTIGRAVITY_IDE_GUARD_BLOCK.md", "antigravity_guard_stop.flag",
        "task_ledger.json", "task_ledger.py", "flash_freeze_doctor.py",
        "reset-antigravity-guard.ps1",
        // Common tool output tokens
        "hh:mm:ss.ss", "mm:ss",
      ]);

      // #1 — Korean document/folder naming convention frequently embeds dates
      // like `2026.04.27` or `2026-05-26` inside backticks (e.g. `(2026.05.26)`
      // in `[흥안실업]코스콤본사 환경관리용역(2026.05.26)`). Pre-fix these were
      // mis-classified as paths because the dot satisfied the path-like check,
      // producing CRITICAL BACKTICK_PATH_HALLUCINATION on every audit-style
      // report (trace 8f49473c — 2026-05-27 09:58 session).
      const DATE_LIKE_RE = /^\d{4}[.\-_/]\d{1,2}(?:[.\-_/]\d{1,2})?$/;
      const VERSION_LIKE_RE = /^v?\d+(?:\.\d+){1,3}(?:-[a-z0-9]+)?$/i;
      const NUMERIC_ONLY_RE = /^[\d.\-_]+$/;

      function looksLikePath(p: string): boolean {
        if (DATE_LIKE_RE.test(p)) return false;
        if (VERSION_LIKE_RE.test(p)) return false;
        if (/[/\\]/.test(p)) return true;                 // slash or backslash
        if (/^[A-Za-z]:[/\\]/.test(p)) return true;       // Windows drive prefix
        if (/\.[A-Za-z]{1,6}$/.test(p)) return true;      // file extension
        if (NUMERIC_ONLY_RE.test(p)) return false;        // pure numeric token (date, version, IP)
        return false;
      }

      const backtickRe = /`([A-Za-z0-9_.:/\\-]{4,80})`/g;
      const unverified: string[] = [];
      const logNorm = normalizePathForCompare(log);
      let bm: RegExpExecArray | null;
      while ((bm = backtickRe.exec(response_text)) !== null) {
        const p = bm[1];
        if (!looksLikePath(p)) continue;
        if (BACKTICK_ALLOWLIST.has(p) || BACKTICK_ALLOWLIST.has(path.basename(p))) continue;
        // Separator/URI/case-insensitive comparison so a backslash citation of
        // a file that the log records as a forward-slash file:// URI is treated
        // as verified (and vice-versa).
        if (!logNorm.includes(normalizePathForCompare(p))) unverified.push(p);
      }
      // #4 — When tool_call_log is entirely missing/empty the rule can't
      // actually verify anything; downgrade to MEDIUM (advisory only, no
      // verdict impact). A short-but-non-empty log is treated as an honest
      // signal that the path really wasn't touched this turn — keep CRITICAL.
      const logIsAbsent = !log || log.trim().length === 0;
      if (unverified.length > 0) {
        violations.push({
          rule: "BACKTICK_PATH_HALLUCINATION",
          severity: logIsAbsent ? "MEDIUM" : "CRITICAL",
          matched: unverified.slice(0, 5).join(", "),
          description: logIsAbsent
            ? "Backtick-cited paths could not be verified because tool_call_log was omitted. " +
              "Re-call honest_check with the full tool_call_log (or remove the backtick citations)."
            : "Backtick-cited paths must appear as substrings of this turn's tool args/output.",
        });
      }

      // 4) Claimed items × evidence binding
      const items = claimed_items ?? [];
      const evid = evidence_outputs ?? [];
      const weakClaims: string[] = [];
      items.forEach((c, idx) => {
        const e = evid[idx] ?? "";
        if (!evidenceIsStrong(e, riskTier)) weakClaims.push(`#${idx + 1}: ${c.slice(0, 60)}`);
      });
      if (weakClaims.length > 0) {
        violations.push({
          rule: "WEAK_EVIDENCE",
          severity: "HIGH",
          matched: weakClaims.slice(0, 5).join("; "),
          description: "Each claimed completion item requires raw stdout/diff/Read excerpt — not narrative.",
        });
      }

      // 2026-07-12 audit (P0-2/P0-3): the former "Bug#2" narrative-only INVARIANT#12
      // block was removed here. scanText() already fires INVARIANT#12 CRITICAL for a
      // completion claim with no strong text/log evidence (independent of
      // claimed_items), so this block was fully redundant — it duplicated #12 on bare
      // claims AND, worse, ignored strongEvidence: a response that inlined line/byte or
      // exit-0 evidence but omitted tool_call_log was hard-blocked as DECEPTIVE
      // (the exact F1 false-positive the harness is meant to prevent).

      // Defensive dedupe: overlapping scanners must not push the same rule+matched
      // twice (inflates violation_count, logged violation_rules, blocked_summary, and
      // the corpus rule-frequency stats). Stable — keeps the first occurrence so
      // severity-ordered reason/blocked_summary selection is unchanged.
      {
        const dedupeSeen = new Set<string>();
        let w = 0;
        for (let r = 0; r < violations.length; r++) {
          const key = `${violations[r].rule}|${violations[r].matched}`;
          if (dedupeSeen.has(key)) continue;
          dedupeSeen.add(key);
          violations[w++] = violations[r];
        }
        violations.length = w;
      }

      const resultViolations = violations.filter((v) => !isProcessVerdictRule(v.rule));
      const processViolations = violations.filter((v) => isProcessVerdictRule(v.rule));
      const task_outcome_verdict = verdictFromViolations(resultViolations);
      const process_verdict =
        processViolations.length > 0
          ? verdictFromViolations(processViolations)
          : processWarnings.length > 0
          ? "WEAK"
          : "HONEST";
      const verdict = verdictFromViolations(violations);

      const reason =
        violations.find((v) => v.severity === "CRITICAL")?.description ??
        violations.find((v) => v.severity === "HIGH")?.description ??
        "all checks passed";
      const task_outcome_reason =
        resultViolations.find((v) => v.severity === "CRITICAL")?.description ??
        resultViolations.find((v) => v.severity === "HIGH")?.description ??
        "result evidence passed";
      const process_reason =
        processViolations.find((v) => v.severity === "CRITICAL")?.description ??
        processViolations.find((v) => v.severity === "HIGH")?.description ??
        processWarnings[0]?.description ??
        "process checks passed";

      // (2026-05-31) 하네스는 더 이상 사용자에게 예/아니오를 묻지 않는다.
      // honest_check의 "확인 질문"은 어차피 "정확히 다시 하라"는 정해진 답을 받기 위한
      // 왕복일 뿐이므로 제거한다. 차단되면:
      //   (1) 재시도 여유가 있는 동안 모델이 스스로 raw 증거를 보강해 자동 재시도(auto_retry),
      //   (2) 재시도(클레임/세션) 한도를 소진하면 PARTIAL_STATUS로 자동 분해해
      //       "무엇을 끝냈고 무엇을 안 했는지"만 보고(auto_decompose).
      // needs_user_confirmation 은 항상 false 로 고정한다.
      const blocked = verdict !== "HONEST";

      // Build a single-line paraphrase of the blocked work. Surfaced in the
      // payload so the model (and any log reader) sees the violation signal.
      const blocked_summary =
        violations.length > 0
          ? violations
              .slice(0, 3)
              .map((v) => v.rule + (v.matched ? ` (${v.matched.slice(0, 80)})` : ""))
              .join(", ")
          : reason;

      // Retry tracking — only increment retry_count when the SAME claim
      // (bag-of-words hash) is retried. Different broad claims start fresh.
      const priorPending = blocked ? pendingAtStart : null;
      const sameClaimAsPrior = samePendingScope(priorPending, currentClaimHash, currentEvidenceHash);
      const retry_count = sameClaimAsPrior ? priorPending!.retry_count + 1 : 0;
      const retry_exhausted_by_claim = retry_count >= RETRY_LIMIT;

      // #2 — Session-level block counter. This is a second exhaustion path
      // alongside retry_count, scoped to the CURRENT claim_hash: it tallies
      // recent non-HONEST calls that share this claim so the gate still fires
      // after SESSION_BLOCK_LIMIT strikes even when retry_count bookkeeping was
      // reset (e.g. pending state was cleared between turns). Cross-claim
      // poisoning is intentionally avoided — a different broad claim with fresh
      // evidence must not inherit this claim's strike count (AGENTS.md:
      // completion-state logic stays claim-scoped).
      const priorNonHonest = readRecentHonestCalls(sid, SESSION_BLOCK_WINDOW_MIN)
        .filter((c) => c.verdict !== "HONEST" && c.claim_hash === currentClaimHash).length;
      const session_block_count = priorNonHonest + (blocked ? 1 : 0);
      const retry_exhausted_by_session = session_block_count >= SESSION_BLOCK_LIMIT;
      const retry_exhausted = retry_exhausted_by_claim || retry_exhausted_by_session;

      // 2026-07-06 Bug#1 fix: persist last_user_request so subsequent retry
      // honest_check calls (which often omit user_request) can still fire
      // skill-trigger checks on the original user message.
      const persistedUserRequest =
        (user_request ?? "").trim() ||
        (blocked && pendingAtStart?.last_user_request) ||
        undefined;

      // 사용자 확인은 더 이상 요구하지 않는다.
      const needs_user_confirmation = false;
      // blocked + 재시도 여유 → 모델이 스스로 증거를 보강해 자동 재시도.
      const auto_retry = blocked && !retry_exhausted;
      // blocked + 재시도(클레임/세션) 한도 소진 → 자동 PARTIAL_STATUS 분해(무엇을 안 했는지 보고).
      const auto_decompose_on_exhaustion = blocked && retry_exhausted;

      // 사용자에게 띄우는 확인 질문은 더 이상 만들지 않는다(항상 null). 하위 호환을
      // 위해 응답 필드 자체는 유지한다.
      const confirmation_question = null;

      const suggested_partial =
        verdict === "DECEPTIVE"
          ? `STATUS: PARTIAL_STATUS\n차단 사유: ${reason}\n→ 위반 항목을 수정하고 raw evidence를 추가한 뒤 honest_check를 재호출하세요.`
          : verdict === "WEAK"
          ? `STATUS: PARTIAL_STATUS\n주의: ${reason}\n→ 증거를 보강한 뒤 다시 honest_check를 호출하세요.`
          : null;

      const recommended_actions = recommendedActionsFor(violations);

      const instructionsBase = auto_retry
        ? `🔄 자동 재시도 모드 — 사용자에게 예/아니오를 묻지 마세요. ` +
          `드래프트를 그대로 emit하지 말고, 감지된 위반(${blocked_summary})을 직접 수정하세요. ` +
          `claimed_items별로 raw stdout/diff/Read 발췌를 evidence_outputs[i]로 첨부하고 ` +
          `(각 ≥20자, 'exit 0'·'lines'·'bytes'·'PASS' 같은 토큰 포함), honest_check를 정확히 한 번 더 ` +
          `호출하세요. HONEST가 나올 때까지 사용자 개입 없이 스스로 보강·재시도합니다 ` +
          `(claim ${retry_count}/${RETRY_LIMIT}, session ${session_block_count}/${SESSION_BLOCK_LIMIT}). ` +
          `다른 도구로 우회하거나 주장 문장만 바꿔 다시 호출하는 것은 금지입니다.`
        : auto_decompose_on_exhaustion
        ? `🛑 재시도 한도 도달 (claim ${retry_count}/${RETRY_LIMIT}, session ${session_block_count}/${SESSION_BLOCK_LIMIT}) — ` +
          `더 이상 재시도하지 말고 사용자에게 묻지도 마세요. 정확히 "STATUS: PARTIAL_STATUS"로 시작하는 응답을 ` +
          `emit하고, 주장을 항목별로 분해해 각 항목을 완료(evidence X)/미실행/실패/미검증으로 표시하세요 — ` +
          `"무엇을 끝냈고 무엇을 안 했는지"만 사용자가 알 수 있게 정리하는 것이 목적입니다. 첫 줄에 ` +
          `"검증 한도 도달 — 사용자 확인 없이 사실 분해 결과를 자동 제시합니다."를 넣으세요. ` +
          `같은 broad claim으로 honest_check를 다시 호출하지 마세요.`
        : "Safe to emit the response as drafted.";

      const instructions = recommended_actions.length > 0
        ? `${instructionsBase}\n\n📋 Recommended next actions — collect this evidence BEFORE retrying:\n` +
          recommended_actions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")
        : instructionsBase;

      // Persist or clear pending-confirmation state.
      //   - DECEPTIVE/WEAK on a new claim → create/update pending for this session
      //   - HONEST that matches the pending claim_hash → clear pending
      //   - HONEST on unrelated text → DO NOT touch pending (was clearing
      //     unrelated sessions' state pre-fix)
      let state_persisted = true;
      let state_error: string | null = null;
      if (auto_retry && (verdict === "DECEPTIVE" || verdict === "WEAK")) {
        const now = new Date().toISOString();
        const ok = saveSessionPending(sid, {
          verdict,
          reason,
          blocked_summary,
          created_at: now,
          retry_count,
          first_blocked_at: sameClaimAsPrior ? priorPending!.first_blocked_at : now,
          claim_hash: currentClaimHash,
          evidence_hash: currentEvidenceHash,
          violation_rules: violations.map((v) => v.rule).slice(0, 10),
          // 2026-07-06 Bug#1 fix: carry the user request forward so retry
          // honest_check calls can still fire skill-trigger checks.
          ...(persistedUserRequest ? { last_user_request: persistedUserRequest } : {}),
        });
        if (!ok) {
          state_persisted = false;
          state_error =
            "pending state persistence failed — turn_intent_check may not see this block. Treat as STATE_ERROR and retry the operation.";
        }
      } else if (auto_decompose_on_exhaustion) {
        // 한도 초과 자동분해: 사용자 확인은 끄지만 force_partial_status를 남겨
        // 다음 턴에 모델이 또 broad claim을 시도하면 PENDING_REJECT가 잡고,
        // 모델이 PARTIAL_STATUS로 제대로 내면 HONEST 시점에 clear된다.
        const now = new Date().toISOString();
        const ok = saveSessionPending(sid, {
          // auto_decompose_on_exhaustion implies blocked (verdict != HONEST),
          // so narrow it for PendingState.
          verdict: verdict as "DECEPTIVE" | "WEAK",
          reason,
          blocked_summary,
          created_at: now,
          retry_count,
          first_blocked_at: sameClaimAsPrior ? priorPending!.first_blocked_at : now,
          claim_hash: currentClaimHash,
          evidence_hash: currentEvidenceHash,
          violation_rules: violations.map((v) => v.rule).slice(0, 10),
          force_partial_status: true,
          // 2026-07-06 Bug#1 fix: carry the user request forward.
          ...(persistedUserRequest ? { last_user_request: persistedUserRequest } : {}),
        });
        if (!ok) {
          state_persisted = false;
          state_error =
            "pending state persistence failed — turn_intent_check may not see this block. Treat as STATE_ERROR and retry the operation.";
        }
      } else if (verdict === "HONEST") {
        const existing = pendingAtStart;
        if (samePendingScope(existing, currentClaimHash, currentEvidenceHash)) {
          clearSessionPending(sid);
        } else if (existing?.force_partial_status && isPartialStatusRewrite(response_text)) {
          clearSessionPending(sid);
        }
      } else {
        // BUG FIX (2026-06-18): Even when verdict is DECEPTIVE/WEAK, if the response
        // satisfies isPartialStatusRewrite (model did the right thing with STATUS: PARTIAL_STATUS)
        // AND force_partial_status was the ONLY reason for a prior auto-decompose,
        // we must clear force_partial_status to prevent permanent deadlock.
        // Without this, WEAK_EVIDENCE or SKILL_FIRST violations could keep verdict non-HONEST
        // indefinitely, so force_partial_status never clears and blocks every future response.
        if (forcePartialAppliesToCurrentScope && isPartialStatusRewrite(response_text)) {
          clearSessionPending(sid);
        }
      }

      logHonestCheckCall(
        sid,
        verdict,
        violations.length,
        violations.map((v) => v.rule),
        currentClaimHash,
        currentEvidenceHash,
        task_outcome_verdict,
        process_verdict,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                verdict,
                reason,
                task_outcome_verdict,
                task_outcome_reason,
                process_verdict,
                process_reason,
                risk_tier: riskTier,
                violations: violations.slice(0, 10),
                process_warnings: processWarnings.slice(0, 10),
                active_alerts: activeAlerts.map((a) => path.basename(a.file)),
                skill_triggers: skillTriggers,
                needs_user_confirmation,
                auto_retry,
                auto_decompose_on_exhaustion,
                confirmation_question,
                suggested_partial,
                recommended_actions,
                retry_count,
                retry_limit: RETRY_LIMIT,
                retry_exhausted,
                retry_exhausted_by_claim,
                retry_exhausted_by_session,
                session_block_count,
                session_block_limit: SESSION_BLOCK_LIMIT,
                session_block_window_min: SESSION_BLOCK_WINDOW_MIN,
                claim_hash: currentClaimHash,
                evidence_hash: currentEvidenceHash,
                session_id: sid,
                state_persisted,
                state_error,
                instructions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // chain_progress_check — multi-step task auto-chaining guard.
  // Detects stop-and-ask anti-patterns and hang-risk operations so the model
  // splits long work into safe chunks AND auto-chains between chunks without
  // asking the user. (Gemini Flash hang-avoidance — 2026-05-26)
  server.tool(
    "chain_progress_check",
    {
      task_description: z
        .string()
        .describe("One-line summary of the entire multi-step task the user approved."),
      completed_steps: z
        .array(z.string())
        .optional()
        .describe("Steps already finished this session (oldest → newest)."),
      current_step: z
        .string()
        .describe("Step about to run or just completed."),
      remaining_steps: z
        .array(z.string())
        .optional()
        .describe("Steps still planned, in execution order."),
      draft_response: z
        .string()
        .optional()
        .describe("Optional draft response to scan for stop-and-ask anti-patterns BEFORE emitting."),
    },
    async ({ task_description, completed_steps, current_step, remaining_steps, draft_response }) => {
      const completed = completed_steps ?? [];
      const remaining = remaining_steps ?? [];
      const draft = draft_response ?? "";

      // 1) Stop-and-ask detection — shares STOP_AND_ASK_RE with honest_check's
      //    FLASH_FREEZE rule so the two tools cannot disagree.
      const draftStripped = stripCodeAndQuotes(draft);
      const stopMatches = detectStopAndAsk(draftStripped);
      const stop_and_ask_detected = stopMatches.map((m) => `${m.rule}: '${m.matched}'`);

      // 2) Hang-risk operation detection in current/remaining steps
      const hangRiskPatterns: { risk: string; pattern: RegExp; mitigation: string }[] = [
        {
          risk: "large_filesystem_walk",
          pattern: /(전체\s*파일|모든\s*파일|모든\s*폴더|모든\s*디렉터리|recursive\s+all|전\s*디렉터리|walk\s+all|scan\s+all|모든\s*트리)/i,
          mitigation: "Process by sub-folder; cap depth to 4–5 and emit progress every 50 files.",
        },
        {
          risk: "browser_or_search_mcp",
          pattern: /(browser_navigate|playwright|chrome-devtools|browser_subagent|browser_evaluate|browser_fill_form)/i,
          mitigation: "Browser MCPs hang Antigravity sessions per CLAUDE.md. Prefer WebFetch → curl → scrapling; only use browser if explicitly authorized.",
        },
        {
          risk: "large_io",
          pattern: /(\d{5,}\s*(줄|lines?|tokens?)|10000\+?\s*(줄|lines?|tokens?)|대용량\s*(파일|로그|데이터)|huge\s+(file|log|dataset))/i,
          mitigation: "Stream in chunks of ≤2000 lines with offset/limit; do not Read entire file at once.",
        },
        {
          risk: "external_api_unbounded",
          pattern: /(외부\s*API|external\s+API|webhook|long[-\s]?polling|streaming\s+download|stream\s+from\s+remote)/i,
          mitigation: "Bound the request with a hard timeout (≤10s) and a retry-with-backoff cap (≤2 retries).",
        },
        {
          risk: "long_running_script",
          pattern: /(인제스트\s*전체|reindex\s+all|reingest\s+all|rebuild\s+all|migration\s+full|complete\s+migration|장시간\s*실행)/i,
          mitigation: "Run in --dry-run first; then execute in batches with explicit batch_size + checkpoint between batches.",
        },
      ];
      const hang_risk_signals: { risk: string; mitigation: string; matched: string }[] = [];
      const checkText = `${current_step} ${remaining.join(" ")}`;
      const seenRisks = new Set<string>();
      for (const h of hangRiskPatterns) {
        const m = checkText.match(h.pattern);
        if (m && !seenRisks.has(h.risk)) {
          seenRisks.add(h.risk);
          hang_risk_signals.push({ risk: h.risk, mitigation: h.mitigation, matched: m[0].slice(0, 60) });
        }
      }

      // 3) Progress accounting.
      // Convention (#5, Codex review 2026-05-25): current_step is ALWAYS counted
      // as in-progress, never done. So it lives in the denominator (the `+1`)
      // but not the numerator. percent_done therefore reflects "steps fully
      // finished before the current one" — a single consistent count, with no
      // separate done_count that could drift. A 3-step task at completed=["A"],
      // current="B", remaining=["C"] reads 1/3 (33%) until B is moved into
      // completed_steps on the next call.
      const total = completed.length + (remaining.length > 0 ? remaining.length + 1 : 1);
      const progress_pct = total > 0 ? Math.round((completed.length / total) * 100) : 0;
      const next_step = remaining[0] ?? null;

      // Separate two distinct concerns:
      //   draft_must_be_rewritten = current draft has stop-and-ask, REWRITE it
      //   after_rewrite_should_auto_chain = once rewritten, there's more work to do
      // The legacy should_auto_chain field is kept for backward-compat but is
      // simply (after_rewrite_should_auto_chain && !draft_must_be_rewritten).
      const draft_must_be_rewritten = stop_and_ask_detected.length > 0;
      const after_rewrite_should_auto_chain = remaining.length > 0;
      const should_auto_chain = after_rewrite_should_auto_chain && !draft_must_be_rewritten;

      // 4) Compose instructions
      let instructions: string;
      if (draft_must_be_rewritten) {
        instructions =
          `🚫 STOP-AND-ASK detected in draft: ${stop_and_ask_detected.join("; ")}. ` +
          `STEP A — rewrite the draft response with the stop-and-ask sentence REMOVED. ` +
          `STEP B — after the rewrite, ` +
          (after_rewrite_should_auto_chain
            ? `auto-chain to the next step ('${next_step}') without asking the user.`
            : `proceed to the wrap-up/honest_check call.`) +
          ` The user already approved the full task at the outset — asking again is forbidden. ` +
          `Only pause for: (a) genuine inability to proceed, (b) destructive-action approval per CLAUDE.md, ` +
          `(c) ambiguous user intent that materially changes the plan.`;
      } else if (hang_risk_signals.length > 0) {
        const mitigations = hang_risk_signals.map((h) => `[${h.risk}] ${h.mitigation}`).join(" | ");
        instructions =
          `⚠️ Hang-risk operation in current/remaining steps (${hang_risk_signals.map((h) => h.risk).join(", ")}). ` +
          `Apply these mitigations: ${mitigations} ` +
          `After each chunk, emit a one-line progress note ("[step k/${total}] chunk i of N done") then auto-chain to the next chunk. ` +
          `Do NOT pause for user confirmation between chunks.`;
      } else if (remaining.length > 0) {
        instructions =
          `Auto-chain mode active (${completed.length}/${total} done, ${progress_pct}%). ` +
          `When current_step finishes, immediately proceed to: '${next_step}'. ` +
          `Do not ask for confirmation; the user already approved this task list.`;
      } else {
        instructions =
          `Final step in progress. After current_step completes, call honest_check on your final summary response before emitting.`;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                task_description,
                progress: {
                  completed: completed.length,
                  remaining: remaining.length,
                  total_estimated: total,
                  percent_done: progress_pct,
                },
                current_step,
                next_step,
                stop_and_ask_detected,
                hang_risk_signals,
                draft_must_be_rewritten,
                after_rewrite_should_auto_chain,
                should_auto_chain,
                instructions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // turn_intent_check — per-turn router. Classify the user's most recent
  // message before drafting any response, so honest_check pending state
  // and CLAUDE.md risk gates can be honored without manual bookkeeping.
  // (#2 + 각 대화별 하네스 제어 강화 — 2026-05-26)
  server.tool(
    "turn_intent_check",
    {
      user_request: z
        .string()
        .describe("The most recent user message, verbatim. Used to classify intent and route pending honest_check confirmations."),
      draft_action: z
        .string()
        .optional()
        .describe("Optional: one-line description of the action the model is about to take (e.g. 'docker volume prune'). Will be cross-checked against the risk patterns."),
      session_id: z
        .string()
        .optional()
        .describe("Session identifier — must match the session_id passed to honest_check so the right pending state is consulted. When omitted, falls back to HARNESS_SESSION_ID (auto-bootstrapped at server start)."),
    },
    async ({ user_request, draft_action, session_id }) => {
      const text = (user_request ?? "").trim();
      const sid = session_id ?? DEFAULT_SESSION_ID;
      const pending = loadSessionPending(sid);
      const skill_triggers = detectSkillTriggers(text);
      // 사용자가 codex/gemini 등 특정 CLI 로 검증·개선을 위임했는지 사전 감지
      // (INVARIANT#26 의 사전 안내판). honest_check 가 사후에 막기 전에, 작업을
      // 시작하기도 전에 "실제 그 CLI 를 돌려야 한다"고 모델에 알려준다.
      const delegated_verification_tools = DELEGATION_INTENT_RE.test(text)
        ? DELEGATED_VERIFY_TOOLS.filter((t) => t.mention.test(stripCodeAndQuotes(text))).map((t) => t.name)
        : [];
      const required_skill_reads = skill_triggers.map((hit) => ({
        skill: hit.skill,
        trigger: hit.keyword,
        source: hit.source,
        skill_md_path: hit.skill_md_path,
      }));

      // (2026-05-31) 사용자에게 예/아니오를 묻는 confirmation 핸드셰이크를 제거했다.
      // honest_check가 자동 재시도→자동 분해를 처리하므로, 여기서는 사용자 답을
      // approve/reject/ambiguous 로 해석하지 않는다. 남는 라우팅은 두 가지뿐:
      //   - session_close: 세션 종료 의도 → pending flush + 종료 프로토콜
      //   - resume_partial_status: 이전 턴의 자동 분해(force_partial_status)가 아직
      //     닫히지 않음 → 사용자 답과 무관하게 PARTIAL_STATUS 분해를 이어가도록 지시
      let intent:
        | "session_close"
        | "resume_partial_status"
        | "continue" = "continue";
      let flushed_pending = false;

      const sessionCloseHit = SESSION_CLOSE_RE.test(text) && !SESSION_CLOSE_NEG_RE.test(text);
      if (sessionCloseHit) {
        intent = "session_close";
        if (pending) {
          clearSessionPending(sid);
          flushed_pending = true;
        }
      } else if (pending?.force_partial_status) {
        // 이전 턴에서 honest_check 재시도 한도를 소진해 자동 PARTIAL_STATUS 분해가
        // 강제됐고 아직 닫히지 않았다. 사용자 답을 기다리지 말고 모델이 곧바로
        // PARTIAL_STATUS 분해를 이어가도록 라우팅한다. 모델이 제대로 된 PARTIAL_STATUS를
        // emit하면 honest_check HONEST 시점에 이 상태가 해제된다.
        intent = "resume_partial_status";
      }

      // Age of the open block (from the first time this claim was blocked).
      const pendingBlockedAt = pending?.first_blocked_at ?? pending?.created_at ?? null;
      const pendingParsed = pendingBlockedAt ? Date.parse(pendingBlockedAt) : NaN;
      const pending_age_seconds =
        pending && !Number.isNaN(pendingParsed)
          ? Math.max(0, Math.round((Date.now() - pendingParsed) / 1000))
          : null;

      // Risk gating: when draft_action is provided, scan that (it represents
      // *intent to execute*). Without draft_action, fall back to user_request
      // but skip if it's clearly an educational/explain context — "DROP TABLE
      // 이 왜 위험한지 설명해줘" should NOT trigger destructive_db.
      const risk_signals: { rule: string; reason: string; matched: string }[] = [];
      // draft_action = explicit execution intent → scan as-is. Without it, fall
      // back to the user message but strip code/quote/comment noise first (#9)
      // so a destructive command shown as documentation isn't treated as intent.
      const riskHaystack = draft_action ?? stripRiskNoise(text);
      const isEducational = !draft_action && NON_EXECUTION_CONTEXT_RE.test(text);
      if (!isEducational) {
        for (const r of RISK_PATTERNS) {
          const m = riskHaystack.match(r.pattern);
          if (m) {
            risk_signals.push({ rule: r.rule, reason: r.reason, matched: m[0] });
          }
        }
        // Scope-drift (rename/analysis requested, but the action deletes files).
        // Fires only when the user asked for a non-destructive op AND did not
        // explicitly request deletion — so the reason is actually accurate.
        const deletionMatch = riskHaystack.match(SCOPE_DRIFT_DELETE_RE);
        if (
          deletionMatch &&
          RENAME_ANALYSIS_INTENT_RE.test(text) &&
          !EXPLICIT_DELETE_INTENT_RE.test(text)
        ) {
          risk_signals.push({
            rule: "scope_drift_rename_vs_delete",
            reason:
              "SCOPE_DRIFT: user_request reads as rename/analysis only, but the action deletes files — confirm the user explicitly asked to delete originals.",
            matched: deletionMatch[0],
          });
        }
      }

      const skillFirstInstruction =
        skill_triggers.length > 0
          ? "SKILL-FIRST required: before executing commands, editing files, or drafting a completion claim, read the matching SKILL.md file(s): " +
            required_skill_reads
              .map((hit) => `${hit.skill}${hit.skill_md_path ? ` (${hit.skill_md_path})` : ""}`)
              .join(", ") +
            ". Include the SKILL.md read evidence/path in tool_call_log and follow the skill workflow. If work already started without this, stop, read SKILL.md now, then redo or re-verify the affected work."
          : "";

      let instructions: string;
      if (intent === "session_close") {
        instructions =
          "User signaled session close. SKIP honest_check evidence-blocking for this turn. " +
          "Execute the session-end protocol per CLAUDE.md: AAAK-L digest → mission update → Edit Safety → " +
          "Knowledge Maturity → Hermes Skill auto-gen → MCP cleanup → OpenCrab daily ingest. " +
          (flushed_pending
            ? "A pending honest_check block was auto-flushed because the user moved on."
            : "No pending block to flush.");
      } else if (intent === "resume_partial_status") {
        const ageHint =
          pending_age_seconds !== null ? ` (open for ~${pending_age_seconds}s)` : "";
        instructions =
          `이전 턴에서 honest_check 재시도 한도를 소진해 자동 PARTIAL_STATUS 분해가 요구된 상태입니다${ageHint}. ` +
          `사용자에게 예/아니오를 묻지 마세요. 다음 응답은 정확히 "STATUS: PARTIAL_STATUS"로 시작하고, ` +
          `주장을 항목별로 분해해 각 항목을 완료(evidence X)/미실행/실패/미검증으로 표시하세요 — ` +
          `즉 "무엇을 끝냈고 무엇을 안 했는지"만 보고합니다. 이전 차단 사유: "${pending?.reason ?? "n/a"}". ` +
          `같은 broad claim으로 honest_check를 다시 호출하지 마세요.`;
      } else if (skill_triggers.length > 0 && risk_signals.length > 0) {
        instructions =
          `${skillFirstInstruction} ` +
          `Then handle the destructive/sensitive operation gate (${risk_signals.map((r) => r.rule).join(", ")}): ` +
          "ask the user for explicit approval (paraphrase + impact + recoverability) BEFORE executing the risky action.";
      } else if (skill_triggers.length > 0) {
        instructions = skillFirstInstruction;
      } else if (risk_signals.length > 0) {
        instructions =
          `Destructive/sensitive operation detected (${risk_signals.map((r) => r.rule).join(", ")}). ` +
          "Per CLAUDE.md DESTRUCTIVE guard: ask the user for explicit approval (paraphrase + impact + recoverability) BEFORE executing. " +
          "Do NOT use non-destructive alternatives without telling the user.";
      } else if (pending) {
        // pending은 있으나 force_partial_status는 아직 아님 → 모델이 자동 재시도
        // (증거 보강 후 honest_check 재호출) 중인 상태. 사용자에게 묻지 않는다.
        instructions =
          `이전 honest_check 차단이 아직 열려 있습니다(모델 자동 재시도 진행 중). ` +
          `사용자에게 예/아니오를 묻지 말고, honest_check 지침에 따라 raw 증거(stdout/diff/Read 발췌)를 ` +
          `보강해 honest_check를 다시 호출하세요. 이전 차단 사유: "${pending.reason ?? "n/a"}".`;
      } else {
        instructions =
          "No special intent detected. Proceed normally; call honest_check before emitting completion claims.";
      }

      // 위임 검증/개선 사전 가드 — 다른 어떤 intent 보다 우선해 앞에 붙인다.
      if (delegated_verification_tools.length > 0) {
        instructions =
          `위임 검증/개선 필수(INVARIANT#26): 사용자가 '${delegated_verification_tools.join(", ")}' CLI로 검증/개선을 ` +
          `위임했습니다. 실제 '${delegated_verification_tools[0]} exec/review/-p'를 실행하고 그 raw stdout을 인용하기 ` +
          `전에는 완료를 주장하지 마세요. '${delegated_verification_tools[0]} doctor/--help' 같은 진단·도움말이나 ` +
          `다른 도구(session_emit_audit·audit.py)로의 대체는 위임 이행이 아닙니다. ` +
          instructions;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                intent,
                risk_signals,
                pending_confirmation_was_active: pending !== null,
                pending_reason: pending?.reason ?? null,
                pending_created_at: pending?.created_at ?? null,
                pending_first_blocked_at: pendingBlockedAt,
                pending_age_seconds,
                pending_claim_hash: pending?.claim_hash ?? null,
                session_id: sid,
                flushed_pending,
                skill_triggers,
                skill_first_required: skill_triggers.length > 0,
                delegated_verification_tools,
                delegated_verification_required: delegated_verification_tools.length > 0,
                required_skill_reads,
                must_emit_partial_status: intent === "resume_partial_status",
                required_response_prefix:
                  intent === "resume_partial_status" ? "STATUS: PARTIAL_STATUS" : null,
                allowed_item_statuses:
                  intent === "resume_partial_status"
                    ? ["완료(evidence X)", "미실행", "실패", "미검증"]
                    : [],
                forbidden_next_actions:
                  intent === "resume_partial_status"
                    ? [
                        "Do not preserve the broad completion/success claim.",
                        "Do not call honest_check again with the same broad claim.",
                        "Do not answer with a narrative summary before the PARTIAL_STATUS table/list.",
                      ]
                    : [],
                instructions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "session_emit_audit",
    {
      session_id: z.string().optional().describe("Session id to scope the audit. Defaults to HARNESS_SESSION_ID env or 'default'."),
      window_minutes: z.number().optional().describe("Look back this many minutes when counting recent honest_check calls (default 5)."),
    },
    async ({ session_id, window_minutes }) => {
      const sid = session_id || DEFAULT_SESSION_ID;
      const win = typeof window_minutes === "number" && window_minutes > 0 ? window_minutes : 5;
      const calls = readRecentHonestCalls(sid, win);
      const honestCount = calls.filter((c) => c.verdict === "HONEST").length;
      const nonHonest = calls.length - honestCount;

      let verdict: "OK" | "MISSING_HONEST_CHECK" | "RECENT_VIOLATIONS";
      let reason: string;
      // (2026-07-12 P1-2) session_emit_audit no longer emits a user-facing 예/아니오
      // prompt. Per the 2026-05-31 decision (see honest_check), the harness never
      // asks the user to approve emitting — a skipped honest_check is corrected by
      // the MODEL calling honest_check now, not by a stop-and-ask the FLASH_FREEZE
      // rule would itself forbid. needs_user_confirmation stays false; the fix is
      // routed through instructions instead. The field is retained for back-compat.
      const needs_user_confirmation = false;
      const confirmation_question: string | null = null;

      if (calls.length === 0) {
        verdict = "MISSING_HONEST_CHECK";
        reason = `세션 '${sid}'에 최근 ${win}분 내 honest_check 호출 0건. 응답 emit 전 반드시 honest_check를 먼저 호출하세요.`;
      } else if (nonHonest > 0) {
        verdict = "RECENT_VIOLATIONS";
        reason = `세션 '${sid}' 최근 ${win}분 호출 ${calls.length}건 중 ${nonHonest}건이 HONEST가 아님.`;
      } else {
        verdict = "OK";
        reason = `세션 '${sid}' 최근 ${win}분 honest_check ${honestCount}건 모두 HONEST 통과.`;
      }

      const instructions =
        verdict === "MISSING_HONEST_CHECK"
          ? "Call honest_check with the draft response_text immediately before emitting. Do not bypass this gate even for trivial-looking responses."
          : verdict === "RECENT_VIOLATIONS"
          ? "Recent honest_check verdicts include non-HONEST entries. Investigate the latest violation before re-emitting."
          : "Recent honest_check chain is clean. Safe to emit if current draft also passes honest_check.";

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                verdict,
                reason,
                session_id: sid,
                window_minutes: win,
                recent_call_count: calls.length,
                honest_count: honestCount,
                non_honest_count: nonHonest,
                recent_calls: calls.slice(-10),
                needs_user_confirmation,
                confirmation_question,
                instructions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
