// Evidence判定 — single source of truth (P1-1).
//
// Before this module the harness had TWO evidence judges with divergent pattern
// sets: hasStrongEvidence() (gate main verdict on response_text) and
// evidenceIsStrong() (per-item evidence_outputs[]). They drifted, which caused
// the 2026-06-26 F1 incident (inline `pytest … 29 passed` accepted by one, hard-
// blocked by the other) and the 2026-07-12 P0-2 false positive. Keeping every
// evidence predicate and its backing patterns in one file makes that drift a
// compile-time concern instead of a latent asymmetry.
//
// This is a leaf module: it depends on nothing else in the harness, so importing
// it from guardrail.ts cannot create a cycle.

export type CompletionRiskTier =
  | "auto"
  | "external_write"
  | "destructive_local"
  | "local_code"
  | "docs"
  | "commit";

export const COMPLETION_RISK_TIERS = [
  "auto",
  "external_write",
  "destructive_local",
  "local_code",
  "docs",
  "commit",
] as const;

export function normalizeCompletionRiskTier(value: unknown): CompletionRiskTier {
  return (COMPLETION_RISK_TIERS as readonly string[]).includes(String(value))
    ? (String(value) as CompletionRiskTier)
    : "auto";
}

export function isLocalCompletionTier(tier: CompletionRiskTier): boolean {
  return tier === "local_code" || tier === "docs" || tier === "commit";
}

const PASS_EVIDENCE_PATTERNS = [
  /```[\s\S]*?\bexit\s*(code)?\s*[:=]?\s*0\b[\s\S]*?```/i,
  /```[\s\S]*?\btests?\b.{0,40}\b(pass|passed|ok|success)\b[\s\S]*?```/i,
  /```[\s\S]*?\bbuild\b.{0,40}\b(pass|passed|ok|success|compiled)\b[\s\S]*?```/i,
  // [diff_block_start] ... [diff_block_end] — real diff output from replace_file_content / multi_replace_file_content.
  // Added 2026-07-05 (session e44520ce): diff evidence was consistently rejected despite being
  // valid stdout from replace_file_content, causing INVARIANT#12 false positives on every
  // file-edit completion claim in this session.
  /\[diff_block_start\][\s\S]*?@@\s*-?\d+,\d+[\s\S]*?\[diff_block_end\]/i,
  // Fence-independent test/build evidence. The 2026-06-26 Codex incident
  // (trace 1c126e97db60) hard-blocked a *legitimate* report: the model ran the
  // suite and quoted the pass counts, but in a markdown bullet list with inline
  // backticks ("`pytest tests/x.py` → 29 passed") rather than a ``` fence, so
  // the fenced patterns above missed it, strongEvidence stayed false, and
  // INVARIANT#15_PHANTOM_SCRIPT fired CRITICAL — pushing the model to *weaken*
  // its evidence to pass the gate. evidenceIsStrong() (used for evidence_outputs[])
  // already accepted this exact form, so hasStrongEvidence() was asymmetric.
  // These patterns close that gap. They REQUIRE a concrete numeric result
  // (N passed / exit 0 next to a runner token), so phantom "ran the script"
  // claims without counts stay blocked by INVARIANT#15.
  /\b\d+\s*(?:tests?\s+)?(?:passed|passing)\b/i,
  /\b\d+\s*개?\s*통과\b/,
  /\b(?:pytest|jest|vitest|mocha|go\s+test|cargo\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|py_compile|tsc|gradle|mvn)\b[\s\S]{0,200}?\b(?:\d+\s*passed|exit\s*(?:code)?\s*[:=]?\s*0|compiled|build\s+(?:succeeded|success))\b/i,
  /\bverified\b.{0,80}\b(stdout|log|json|status|diff|file|endpoint|response)\b/i,
  /\btask_ledger\.py\s+guard\b[\s\S]{0,300}\b(ok|all_done|exit\s*(code)?\s*[:=]?\s*0)\b/i,
  /\bExit\s+code\s*:\s*0\b[\s\S]{0,120}\bOutput\s*:\b[\s\S]{0,300}\bPASS[_A-Z0-9-]*\b/i,
  /\bexit[_\s-]*code\s*[:=]\s*0\b[\s\S]{0,300}\bPASS[_A-Z0-9-]*\b/i,
  // Compact raw-evidence excerpts used by external-write closeouts. The
  // per-item evidence_outputs[] binding still verifies every claimed item;
  // this pattern only lets the response quote those already-bound results in
  // a concise, machine-readable form such as
  // `CLOUD_PASS status=completed ingest_complete=true`.
  /\b[A-Z][A-Z0-9_]*_PASS\b[\s\S]{0,240}?\b(?:status|result_status|operation_ready|completion_claim_allowed|ingest_complete|registry_found)\s*=\s*(?:operation_ready|completed|success|pass|true)\b/i,
  /```[\s\S]*?\bHTTP\s*(200|204)\b[\s\S]*?```/i,
  /\bALL_VERIFIED\b/,
  /\bguard_decision\b.{0,80}\bPASS\b/i,
  /\boverall_verdict\b.{0,80}\bALL_VERIFIED\b/i,
  /\bSHA-?256\b\s*[:=]\s*[a-f0-9]{32,64}\b/i,
  // view_file / Read tool style outputs (Korean + English).
  // Examples that incorrectly BLOCKed in the 2026-05-10 session:
  //   "console 출력은 깨져 보이지만 파일 자체는 UTF-8 정상입니다 (`bytes=10043, lines=213` 확인)"
  //   "정확히 작성됐습니다 (214줄, 10043 바이트)."
  //   "정상적으로 저장됐습니다. (총 151줄, 8935 바이트)"
  /\bbytes\s*[:=]\s*\d{2,}\b[\s\S]{0,40}\blines?\s*[:=]\s*\d{1,}/i,
  /\b\d{2,}\s*(?:bytes|byte|바이트)\b[\s\S]{0,40}\b\d{1,}\s*(?:lines?|줄|라인|행)\b/i,
  /\b\d{1,}\s*(?:lines?|줄|라인|행)\b[\s\S]{0,40}\b\d{2,}\s*(?:bytes|byte|바이트)\b/i,
  /\(\s*총\s*\d{1,}\s*줄[\s\S]{0,30}\d{2,}\s*바이트\s*\)/,
  /\b(?:라인\s*수|줄\s*수|line\s*count)\s*[:=]?\s*\d{1,}\b/i,
  // view_file / Read standard tool output (Antigravity IDE + Claude harness).
  // The label-before-number, lines-before-bytes form ("Total Lines: 96, Total
  // Bytes: 3583") was NOT covered by the patterns above (those assume number-
  // first or bytes-first), so genuine view_file evidence was hard-blocked as
  // INVARIANT#12 in the 2026-05-28 08:04:56 Antigravity session. Accept both
  // the explicit "Total Lines/Total Bytes" pair and the "Showing lines N to M"
  // range marker, which only appear in real file-read tool output.
  /\b(?:total\s+)?lines?\s*[:=]\s*\d+\b[\s\S]{0,60}\b(?:total\s+)?bytes?\s*[:=]\s*\d+/i,
  /\b(?:total\s+)?bytes?\s*[:=]\s*\d+\b[\s\S]{0,60}\b(?:total\s+)?lines?\s*[:=]\s*\d+/i,
  /\bShowing\s+lines?\s+\d+\s+to\s+\d+\b/i,
  // Local image generation/normalization checks often emit concrete PNG names,
  // dimensions, byte sizes, and an aggregate png_count rather than line counts.
  /\bPASS\s+[\w.-]+\.png\s+\d{2,5}x\d{2,5}\s+bytes\s*=\s*\d{3,}\b/i,
  /\bPASS\s+png_count\s*=\s*\d+\b/i,
  // spec_pack_audit evidence (INVARIANT#23). Both forms accepted: the raw
  // completion_token from pack_audit.py and the surrounding verdict line.
  /\bcompletion_token["']?\s*[:=]\s*["']?[a-f0-9]{16,32}\b/i,
  /\bspec_pack_audit\b[\s\S]{0,120}\bverdict["']?\s*[:=]\s*["']?PASS\b/i,
  /\bspec_pack_audit\b[\s\S]{0,40}\bPASS\b[\s\S]{0,80}\bcompletion_token\b/i,
];

const LOCAL_ENGINEERING_EVIDENCE_PATTERNS = [
  /\bpython\s+-m\s+unittest\b[\s\S]{0,500}\bRan\s+\d+\s+tests?\b[\s\S]{0,120}\bOK\b/i,
  /\b(?:pytest|python\s+-m\s+pytest|pnpm\s+(?:run\s+)?test|npm\s+(?:run\s+)?test)\b[\s\S]{0,500}\b(?:\d+\s+passed|passed|OK|exit\s*(?:code)?\s*[:=]?\s*0)\b/i,
  /\bgit\s+diff\s+--(?:cached\s+)?check\b[\s\S]{0,200}\b(?:exit\s*(?:code)?\s*[:=]?\s*0|no\s+output|OK)\b/i,
  /\bgit\s+status\s+--short\s+--branch\b[\s\S]{0,120}\n##\s+[^\r\n]+\s*$/i,
  /\bgit\s+log\s+--oneline\s+-1\b[\s\S]{0,120}\b[a-f0-9]{7,40}\s+(?:fix|feat|docs|test|chore|refactor|perf|style)(?:\([^)]+\))?:/i,
  /\b(?:Read excerpt|Get-Content|rg\s+-n|Select-String)\b[\s\S]{0,500}\b(def|function|class|const|interface|assert|self\.assert|expect\()\b/i,
  /\b(?:Created|Modified|Updated|Added)\s+(?:file\s+)?[A-Za-z]:[\\/][^\r\n]+/i,
];

const WEAK_EVIDENCE_ONLY = /^(ok|true|success|done|pass|passed|complete|completed|fixed|verified|완료|성공|통과|확인|정상|문제없음)$/i;

function parseJsonEvidenceCandidate(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectJsonEvidenceValues(text: string): unknown[] {
  const values: unknown[] = [];
  const trimmed = text.trim();
  if (!trimmed) return values;

  const whole = parseJsonEvidenceCandidate(trimmed);
  if (whole !== null) values.push(whole);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const parsed = parseJsonEvidenceCandidate(match[1].trim());
    if (parsed !== null) values.push(parsed);
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const parsed = parseJsonEvidenceCandidate(line.trim());
    if (parsed !== null) values.push(parsed);
  }

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    const parsed = parseJsonEvidenceCandidate(trimmed.slice(firstObject, lastObject + 1));
    if (parsed !== null) values.push(parsed);
  }

  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) {
    const parsed = parseJsonEvidenceCandidate(trimmed.slice(firstArray, lastArray + 1));
    if (parsed !== null) values.push(parsed);
  }

  return values;
}

function hasStructuredStrongEvidence(text: string): boolean {
  const values = collectJsonEvidenceValues(text);
  if (values.length === 0) return false;

  const strongStatus = /^(operation_ready|pass|passed|ok|complete|completed|completed_pass|success|registered|ready|all_verified|honest)$/i;
  const weakOrBadStatus = /(fail|failed|error|blocked|deceptive|not_ready|missing|rejected)/i;
  const emptyArrayKeys = new Set([
    "warnings",
    "blocking_failures",
    "required_next_actions",
    "errors",
    "skipped_edges",
    "failed_queries",
  ]);
  const zeroKeys = new Set([
    "fail_count",
    "failure_count",
    "warning_count",
    "remaining_payloads",
    "generic_nodes",
    "generic_node_ratio",
    "orphan_nodes",
    "orphan_node_ratio",
    "skipped_edges",
  ]);
  const positiveCountKeys = new Set([
    "documents",
    "nodes",
    "edges",
    "payload_count",
    "completed_payloads",
    "source_document_count",
    "nodes_imported",
    "edges_imported",
    "total_queries",
  ]);

  function inspect(value: unknown): { score: number; negative: boolean } {
    if (Array.isArray(value)) {
      return value.reduce(
        (acc, item) => {
          const child = inspect(item);
          return { score: acc.score + child.score, negative: acc.negative || child.negative };
        },
        { score: 0, negative: false },
      );
    }
    if (!value || typeof value !== "object") return { score: 0, negative: false };

    let score = 0;
    let negative = false;
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();

      if (typeof rawValue === "string") {
        if ((key === "status" || key.endsWith("_status") || key === "verdict") && weakOrBadStatus.test(rawValue)) {
          negative = true;
        }
        if ((key === "status" || key.endsWith("_status") || key === "verdict") && strongStatus.test(rawValue)) {
          score += rawValue.toLowerCase() === "operation_ready" ? 3 : 1;
        }
      } else if (typeof rawValue === "boolean") {
        if ((key === "operation_ready" || key === "completion_claim_allowed") && rawValue) score += 3;
        else if (key === "ingest_complete" && rawValue) score += 2;
        else if ((key === "registry_found" || key === "source_documents_found" || key === "connected") && rawValue) score += 1;
        else if ((key === "operation_ready" || key === "completion_claim_allowed" || key === "ingest_complete") && !rawValue) {
          negative = true;
        }
      } else if (typeof rawValue === "number") {
        if (zeroKeys.has(key) && rawValue === 0) score += 1;
        if ((key === "evidence_pass_rate" || key === "native_vector_pass_rate") && rawValue >= 1) score += 1;
        if (positiveCountKeys.has(key) && rawValue > 0) score += 1;
      } else if (Array.isArray(rawValue)) {
        if (emptyArrayKeys.has(key)) {
          if (rawValue.length === 0) score += 1;
          else negative = true;
        }
      }

      const child = inspect(rawValue);
      score += child.score;
      negative = negative || child.negative;
    }

    return { score, negative };
  }

  return values.some((value) => {
    const result = inspect(value);
    return !result.negative && result.score >= 3;
  });
}

// Codex/PowerShell process wrappers commonly emit key/value summaries rather
// than JSON or synthetic `*_PASS` tokens. Keep this parser contradiction-aware:
// a zero process exit code is necessary, but failure statuses, false readiness
// flags, or non-empty warning/error arrays always reject the block.
function hasKeyValueStrongEvidence(text: string): boolean {
  const exitOk =
    /\b(?:process[_\s-]*)?exit[_\s-]*code\s*[:=]\s*0\b/i.test(text) ||
    /\bexit\s+(?:code\s*)?[:=]\s*0\b/i.test(text);
  if (!exitOk) return false;

  const key = (name: string) => `["']?${name}["']?`;
  const assignment = "\\s*[:=]\\s*";
  const quoted = (value: string) => `["']?${value}["']?`;
  const negativeStatus = new RegExp(
    `\\b${key("(?:status|result_status|operation_status|readiness_status)")}${assignment}${quoted("(?:fail|failed|error|blocked|rejected|deceptive|not_ready)")}\\b`,
    "i",
  );
  const falseCriticalFlag = new RegExp(
    `\\b${key("(?:operation_ready|completion_claim_allowed|ingest_complete)")}${assignment}${quoted("false")}\\b`,
    "i",
  );
  const nonEmptyFailureArray = new RegExp(
    `\\b${key("(?:warnings|blocking_failures|errors|failed_queries)")}${assignment}\\[\\s*(?!\\])[^\\]]+\\]`,
    "i",
  );
  if (negativeStatus.test(text) || falseCriticalFlag.test(text) || nonEmptyFailureArray.test(text)) {
    return false;
  }

  let score = 0;
  const positiveStatus = new RegExp(
    `\\b${key("(?:status|result_status|operation_status|readiness_status)")}${assignment}${quoted("(?:operation_ready|pass|passed|ok|complete|completed|success|registered|ready)")}\\b`,
    "i",
  );
  if (positiveStatus.test(text)) score += 2;
  if (new RegExp(`\\b${key("operation_ready")}${assignment}${quoted("true")}\\b`, "i").test(text)) score += 3;
  if (new RegExp(`\\b${key("completion_claim_allowed")}${assignment}${quoted("true")}\\b`, "i").test(text)) score += 2;
  if (new RegExp(`\\b${key("ingest_complete")}${assignment}${quoted("true")}\\b`, "i").test(text)) score += 2;
  if (new RegExp(`\\b${key("(?:registry_found|source_documents_found)")}${assignment}${quoted("true")}\\b`, "i").test(text)) score += 1;
  if (
    new RegExp(
      `\\b${key("(?:warnings|blocking_failures|errors|failed_queries)")}${assignment}\\[\\s*\\]`,
      "i",
    ).test(text)
  ) {
    score += 1;
  }
  return score >= 3;
}

export function hasStrongEvidence(text: string): boolean {
  return (
    hasStructuredStrongEvidence(text) ||
    hasKeyValueStrongEvidence(text) ||
    PASS_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))
  );
}

function hasLocalEngineeringEvidence(text: string): boolean {
  return LOCAL_ENGINEERING_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasTieredStrongEvidence(text: string, tier: CompletionRiskTier): boolean {
  return hasStrongEvidence(text) || (isLocalCompletionTier(tier) && hasLocalEngineeringEvidence(text));
}

export function evidenceIsStrong(
  evidence: string,
  riskTier: CompletionRiskTier = "auto",
): boolean {
  const trimmed = evidence.trim();
  if (trimmed.length < 20) return false;
  if (WEAK_EVIDENCE_ONLY.test(trimmed)) return false;
  if (/undefined|no output|not run|미실행|출력 없음/i.test(trimmed)) return false;
  if (/^[A-Za-z]:\\[^\r\n]+$/.test(trimmed)) return false;
  return (
    hasTieredStrongEvidence(trimmed, riskTier) ||
    /\b(stdout|stderr|output|json|verdict|status|sha256|lastwritetime|length|line|lines|endpoint|response)\b/i.test(trimmed) ||
    // Bare narrative "diff에서 확인" is NOT evidence (2026-06-11 incident: the
    // model cited "multi_replace_file_content diff에서 함수 추가 확인" for an
    // edit that never landed on disk). Require actual diff/patch syntax.
    (/\bdiff\b/i.test(trimmed) &&
      /(^|\n)\s*(@@\s*-?\d|\+\+\+\s|---\s|[+-]\s{0,2}[\w<{("'`])|ReplacementChunks|TargetContent|ReplacementContent/m.test(trimmed)) ||
    /\b(Test-Path|Get-Item|Get-Content|Select-String|rg|pnpm|npm|pytest|python)\b[\s\S]{0,300}\b(True|exit[_\s-]*(code)?\s*[:=]?\s*0|PASS|passed|ok)\b/i.test(trimmed) ||
    /\bExit\s+code\s*:\s*0\b[\s\S]{0,120}\bOutput\s*:\b[\s\S]{0,300}\bPASS[_A-Z0-9-]*\b/i.test(trimmed) ||
    /\bexit[_\s-]*code\s*[:=]\s*0\b[\s\S]{0,300}\bPASS[_A-Z0-9-]*\b/i.test(trimmed) ||
    // Accept Korean view_file / write-back signatures (line/byte counts).
    /\b\d{2,}\s*(?:bytes|byte|바이트)\b/i.test(trimmed) && /\b\d{1,}\s*(?:lines?|줄|라인|행)\b/i.test(trimmed) ||
    /\(\s*총\s*\d{1,}\s*줄[\s\S]{0,30}\d{2,}\s*바이트\s*\)/.test(trimmed) ||
    /\b(?:라인\s*수|줄\s*수|line\s*count)\s*[:=]?\s*\d{1,}\b/i.test(trimmed)
  );
}
