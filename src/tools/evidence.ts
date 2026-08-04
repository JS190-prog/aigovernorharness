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
  // Deployment scripts emit these machine completion markers on separate
  // lines. Require the full deploy + public verification + health trio so a
  // narrative mention of "deployed" cannot satisfy the external-write gate.
  /\bDEPLOYED_AND_PUBLICLY_VERIFIED\b[\s\S]{0,300}\bDEPLOY_COMPLETE\b[\s\S]{0,300}\bHEALTH_READY\b/i,
  // Nginx-only policy publishes skip the static-file deploy markers when the
  // public static matrix is already current. Require both the remote nginx
  // completion and the coordinator's public cache/header verification.
  /\bNGINX_DEPLOY_COMPLETE\b[\s\S]{0,300}\bWEB_CACHE_POLICY_DEPLOY_COMPLETE\b/i,
  // Git publish verification emitted by the release workflow. The marker is
  // only strong when the local and remote object ids are identical; a bare
  // zero-exit marker must not prove that the intended revision was published.
  /\bGIT_REMOTE_EXIT_0\b[^\r\n]*\bhead=([a-f0-9]{7,40})\b[^\r\n]*\bremote=\1\b/i,
  // Canonical local verification summaries put PASS first and the process
  // result last (for example: "PASS installed_agent exit 0 version=...").
  // Require both tokens on one physical line so narrative PASS prose or an
  // unrelated exit code cannot accidentally satisfy the evidence gate.
  /(?:^|\r?\n)\s*PASS\s+[A-Za-z0-9_.:-]+[^\r\n]{0,240}\bexit(?:\s+code)?\s*[:=]?\s*0\b/im,
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

  const strongStatus = /^(operation_ready|pass|passed|ok|complete|completed|completed_pass|success|registered|ready|resolved|closed|all_verified|fully_verified|public_readback_ok|deployed_and_publicly_verified|honest)$/i;
  const weakOrBadStatus = /(fail|failed|error|blocked|deceptive|not_ready|missing|rejected)/i;
  const emptyArrayKeys = new Set([
    "warnings",
    "blocking_failures",
    "required_next_actions",
    "errors",
    "blockers",
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
    "failed_shards",
    "failedshards",
    "unresolved_count",
    "unresolvedcount",
    "unresolved_groups",
    "unresolvedgroups",
    "unresolved_occurrences",
    "unresolvedoccurrences",
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
    "passed_shards",
    "passedshards",
    "syntax_passed",
    "syntaxpassed",
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

      const isStatusKey =
        key === "status" ||
        key.endsWith("_status") ||
        key === "workflowstate" ||
        key === "lifecyclestate" ||
        key === "verdict";

      if (typeof rawValue === "string") {
        if (isStatusKey && weakOrBadStatus.test(rawValue)) {
          negative = true;
        }
        if (isStatusKey && strongStatus.test(rawValue)) {
          score += rawValue.toLowerCase() === "operation_ready" ? 3 : 1;
        }
      } else if (typeof rawValue === "boolean") {
        if ((key === "operation_ready" || key === "completion_claim_allowed") && rawValue) score += 3;
        else if (key === "ingest_complete" && rawValue) score += 2;
        else if (key === "ok" && rawValue) score += 1;
        else if ((key === "can_finalize" || key === "canfinalize") && rawValue) score += 3;
        else if ((key === "registry_found" || key === "source_documents_found" || key === "connected") && rawValue) score += 1;
        else if ((key === "operation_ready" || key === "completion_claim_allowed" || key === "ingest_complete" || key === "ok") && !rawValue) {
          negative = true;
        }
      } else if (typeof rawValue === "number") {
        if (zeroKeys.has(key) && rawValue === 0) score += 1;
        if ((key === "evidence_pass_rate" || key === "native_vector_pass_rate") && rawValue >= 1) score += 1;
        if (positiveCountKeys.has(key) && rawValue > 0) score += 1;
        if ((key === "httpstatus" || key === "http_status" || key.endsWith("http") || key.endsWith("httpstatus")) && rawValue >= 200 && rawValue < 300) score += 1;
        if ((key === "resolvedat" || key === "resolved_at") && rawValue > 0) score += 1;
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
  // Read-only verification commands often emit a named machine result before
  // the wrapper's exit code (for example API_READBACK=PASS ... EXIT_CODE=0).
  // Keep this order-independent and require an uppercase key plus the already
  // checked zero exit code so free-form narrative "pass" text stays weak.
  if (/\b[A-Z][A-Z0-9_]*(?:READBACK|CHECK|VERIFY|VERIFIED|RESULT)\s*[:=]\s*PASS\b/.test(text)) {
    score += 3;
  }
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

export function isExplicitNegativeClaim(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  // Zero-remaining closeout claims are positive completion claims. Without
  // this guard, "no unresolved reports remain" was classified as a negative
  // claim merely because it contains both "unresolved" and "remain". That
  // inverted the evidence contract: a clean canFinalize=true result failed,
  // while an unresolved/canFinalize=false result could satisfy the claim.
  if (
    /\b(?:no|zero)\s+unresolved\b/i.test(normalized) ||
    /\bunresolved(?:[_\s-]+(?:report|item|group|occurrence|inventory|count)s?){0,2}\s*(?:is|are|=|:)\s*(?:zero|0)\b/i.test(normalized) ||
    /\bno\s+[^.\r\n]{0,80}\bremain(?:s|ing)?\b/i.test(normalized) ||
    /\bnone\s+(?:remain|remaining)\b/i.test(normalized) ||
    /(?:미해결|남은)\s*(?:항목|보고서|건)?\s*(?:이|가)?\s*(?:0|없(?:다|음|습니다))/.test(normalized) ||
    /남아\s*있지\s*않/.test(normalized)
  ) {
    return false;
  }

  // Claims should be atomic, but guard the common resolved/unblocked phrasing
  // so a historical mention of a block cannot turn failure evidence into proof
  // of a positive completion claim.
  if (
    /(?:차단|블록)(?:을|이)?\s*해제|차단\s*해소|(?:문제|오류)(?:가|를)?\s*해결/i.test(normalized) ||
    /\b(?:unblocked|no longer blocked|resolved|remediated)\b/i.test(normalized)
  ) {
    return false;
  }

  return (
    /(?:미완료|미실행|미검증|실패|차단|보류|완료되지|해결되지|남아\s*(?:있|있음)|남음)/i.test(normalized) ||
    /\b(?:failed|blocked|unresolved|incomplete|unverified|not\s+(?:run|completed|ready)|remaining)\b/i.test(normalized) ||
    /\bcan[_\s-]*finalize\b\s*(?:is|=|:)\s*false\b/i.test(normalized)
  );
}

export function evidenceIsStrongForClaim(
  evidence: string,
  claimText: string,
  riskTier: CompletionRiskTier = "auto",
): boolean {
  if (!isExplicitNegativeClaim(claimText)) return evidenceIsStrong(evidence, riskTier);

  const trimmed = evidence.trim();
  if (trimmed.length < 20) return false;
  if (WEAK_EVIDENCE_ONLY.test(trimmed)) return false;
  if (/undefined|no output|not run|미실행|출력 없음/i.test(trimmed)) return false;
  if (/^[A-Za-z]:\\[^\r\n]+$/.test(trimmed)) return false;

  // A narrative such as "it failed" is not enough. Negative claims require a
  // machine-readable failure state, count, false readiness flag, HTTP failure,
  // or a non-zero process result paired with such a signal.
  const hasMachineEnvelope =
    collectJsonEvidenceValues(trimmed).length > 0 ||
    /\bexit[_\s-]*(?:code)?\s*[:=]?\s*[1-9]\d*\b/i.test(trimmed) ||
    /\bhttp[_\s-]*status\s*[:=]\s*[45]\d\d\b/i.test(trimmed);
  return hasMachineEnvelope && hasStructuredFailureSignals(trimmed);
}

export const STRUCTURED_EVIDENCE_SOURCE_TYPES = [
  "process_stdout",
  "api_json",
  "tool_json",
  "playwright_dom",
  "screenshot_ocr",
  "human_summary",
] as const;

export type StructuredEvidenceSourceType =
  (typeof STRUCTURED_EVIDENCE_SOURCE_TYPES)[number];

export interface StructuredClaim {
  claim_id: string;
  text: string;
}

export interface StructuredEvidenceItem {
  evidence_id?: string;
  claim_id: string;
  source_type: StructuredEvidenceSourceType;
  producer: string;
  operation_id?: string;
  target_id?: string;
  exit_code?: number;
  raw_output: string;
}

export interface EvidenceCorrelationClaimResult {
  claim_id: string;
  verified: boolean;
  corroborated: boolean;
  primary_sources: StructuredEvidenceSourceType[];
  corroborating_sources: StructuredEvidenceSourceType[];
  operation_id: string | null;
  target_id: string | null;
  facts: Record<string, string | number | boolean>;
  errors: string[];
}

export interface EvidenceCorrelationResult {
  enabled: boolean;
  all_verified: boolean;
  claims: EvidenceCorrelationClaimResult[];
  errors: string[];
}

const CORRELATED_FACT_ALIASES: Record<string, string> = {
  status: "status",
  result_status: "status",
  operation_status: "status",
  readiness_status: "status",
  deploy_status: "status",
  deploystatus: "status",
  verdict: "status",
  workflow_state: "workflow_state",
  workflowstate: "workflow_state",
  workflowstates: "workflow_state",
  occurrence_count: "recurrence_count",
  occurrencecount: "recurrence_count",
  recurrence_count: "recurrence_count",
  recurrencecount: "recurrence_count",
  root_cause_investigation_required: "root_cause_investigation_required",
  rootcauseinvestigationrequired: "root_cause_investigation_required",
  lifecycle_state: "lifecycle_state",
  lifecyclestate: "lifecycle_state",
  lifecyclestates: "lifecycle_state",
  statuses: "status",
  ok: "ok",
  http_status: "http_status",
  httpstatus: "http_status",
  manifesthttp: "http_status",
  scripthttp: "http_status",
  publichealthstatuscode: "http_status",
  resolved_at: "resolved_at",
  resolvedat: "resolved_at",
  report_id: "report_id",
  reportid: "report_id",
  saved_to_disk: "saved_to_disk",
  operation_ready: "operation_ready",
  completion_claim_allowed: "completion_claim_allowed",
  ingest_complete: "ingest_complete",
  livehealthok: "operation_ready",
  adminjshashmatches: "admin_js_hash_matches",
  styleshashmatches: "styles_hash_matches",
  files: "files",
  pages: "pages",
  page_count: "pages",
  tables: "tables",
  table_count: "tables",
  characters: "characters",
  characters_with_spaces: "characters",
  chars: "characters",
  lines: "lines",
  document_count: "document_count",
  stop_button_count: "stop_button_count",
  safe_session_active: "safe_session_active",
  exit_code: "exit_code",
  exitcode: "exit_code",
};

const SUCCESS_STATUS = /^(operation_ready|pass|passed|ok|complete|completed|completed_pass|success|registered|ready|resolved|closed|all_verified|fully_verified|public_readback_ok|deployed_and_publicly_verified|honest)$/i;
const FAILURE_STATUS = /^(fail|failed|error|blocked|deceptive|not_ready|missing|rejected)$/i;

function normalizeCorrelatedFact(key: string, value: unknown): string | number | boolean | null {
  if (Array.isArray(value) && value.length === 1) {
    return normalizeCorrelatedFact(key, value[0]);
  }
  if (["status", "workflow_state", "lifecycle_state"].includes(key) && typeof value === "string") {
    if (SUCCESS_STATUS.test(value)) return "success";
    if (FAILURE_STATUS.test(value)) return "failure";
    return value.trim().toLowerCase();
  }
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function extractTextFacts(text: string, facts: Map<string, string | number | boolean>): void {
  const aliases = Object.keys(CORRELATED_FACT_ALIASES).sort((a, b) => b.length - a.length);
  const machineRe = new RegExp(
    `\\b(${aliases.join("|")})\\b\\s*[:=]\\s*["']?([A-Za-z_]+|-?\\d+(?:\\.\\d+)?)`,
    "gi",
  );
  for (const match of text.matchAll(machineRe)) {
    const canonical = CORRELATED_FACT_ALIASES[match[1].toLowerCase()];
    const normalized = normalizeCorrelatedFact(canonical, match[2]);
    if (normalized !== null) facts.set(canonical, normalized);
  }

  const koreanPatterns: Array<[string, RegExp]> = [
    ["pages", /페이지\s*수\s*[:=]?\s*(\d+)\s*쪽/i],
    ["tables", /표\s*(?:개수|수)\s*[:=]?\s*(\d+)\s*개/i],
    ["characters", /전체\s*글자\s*수(?:\([^)]*\))?\s*[:=]?\s*(\d+)\s*자/i],
    ["lines", /문단\s*수\s*[:=]?\s*(\d+)\s*개/i],
  ];
  for (const [key, pattern] of koreanPatterns) {
    const match = text.match(pattern);
    if (match) facts.set(key, Number(match[1]));
  }
}

function extractCorrelatedFacts(raw: string): Map<string, string | number | boolean> {
  const facts = new Map<string, string | number | boolean>();

  function inspect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string") extractTextFacts(value, facts);
      return;
    }
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const canonical = CORRELATED_FACT_ALIASES[rawKey.toLowerCase()];
      if (canonical) {
        const normalized = normalizeCorrelatedFact(canonical, rawValue);
        if (normalized !== null) facts.set(canonical, normalized);
      }
      inspect(rawValue);
    }
  }

  for (const value of collectJsonEvidenceValues(raw)) inspect(value);
  extractTextFacts(raw, facts);
  return facts;
}

function hasNegativeStructuredFacts(facts: Map<string, string | number | boolean>): boolean {
  if (["status", "workflow_state", "lifecycle_state"].some((key) => facts.get(key) === "failure")) return true;
  if (facts.get("ok") === false) return true;
  const httpStatus = facts.get("http_status");
  if (typeof httpStatus === "number" && httpStatus >= 400) return true;
  const exitCode = facts.get("exit_code");
  if (typeof exitCode === "number" && exitCode !== 0) return true;
  for (const key of ["saved_to_disk", "operation_ready", "completion_claim_allowed", "ingest_complete"]) {
    if (facts.get(key) === false) return true;
  }
  return false;
}

function hasStructuredProcessSuccess(
  raw: string,
  facts: Map<string, string | number | boolean>,
  itemExitCode?: number,
): boolean {
  const effectiveExitCode = facts.get("exit_code") ?? itemExitCode;
  const machineJsonSuccess =
    collectJsonEvidenceValues(raw).length > 0 &&
    facts.get("status") === "success" &&
    effectiveExitCode === 0 &&
    facts.size >= 2;
  const deploymentMarkerSuccess =
    /\bDEPLOYED_AND_PUBLICLY_VERIFIED\b/i.test(raw) &&
    /\bDEPLOY_COMPLETE\b/i.test(raw) &&
    /\bHEALTH_READY\b/i.test(raw);
  const nginxPolicyMarkerSuccess =
    /\bNGINX_DEPLOY_COMPLETE\b/i.test(raw) &&
    /\bWEB_CACHE_POLICY_DEPLOY_COMPLETE\b/i.test(raw);
  return machineJsonSuccess || deploymentMarkerSuccess || nginxPolicyMarkerSuccess;
}

function hasStructuredFailureSignals(
  raw: string,
  allowedStatuses: ReadonlySet<string> = new Set(),
): boolean {
  const failureArrayKeys = new Set(["warnings", "errors", "blockers", "blocking_failures", "failed_queries"]);
  const failureCountKeys = new Set([
    "fail_count",
    "failure_count",
    "warning_count",
    "error_count",
    "failed_shards",
    "failedshards",
    "unresolvedgroups",
    "unresolved_groups",
    "unresolvedoccurrences",
    "unresolved_occurrences",
    "remaining",
    "remaining_groups",
    "remaining_payloads",
  ]);
  const criticalBooleanKeys = new Set([
    "saved_to_disk",
    "operation_ready",
    "completion_claim_allowed",
    "ingest_complete",
    "document_created",
    "canfinalize",
    "can_finalize",
    "ok",
  ]);
  const statusKeys = new Set([
    "status",
    "result_status",
    "operation_status",
    "readiness_status",
    "workflow_state",
    "workflowstate",
    "lifecycle_state",
    "lifecyclestate",
    "verdict",
  ]);
  const badStatus = /^(?:fail|failed|error|blocked|rejected|deceptive|not_ready|missing|incomplete|unresolved|pending)$/i;

  function inspect(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(inspect);
    if (!value || typeof value !== "object") return false;

    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (failureArrayKeys.has(key) && Array.isArray(rawValue) && rawValue.length > 0) return true;
      if (failureCountKeys.has(key) && typeof rawValue === "number" && rawValue > 0) return true;
      if (
        rawValue === false &&
        (criticalBooleanKeys.has(key) || key.endsWith("hashmatches") || key.endsWith("hash_matches") || key.endsWith("healthok") || key.endsWith("health_ok"))
      ) return true;
      if (
        statusKeys.has(key) &&
        typeof rawValue === "string" &&
        badStatus.test(rawValue.trim()) &&
        !allowedStatuses.has(rawValue.trim().toLowerCase())
      ) return true;
      if (
        (key === "http_status" || key === "httpstatus" || key.endsWith("http") || key.endsWith("httpstatus") || key.endsWith("httpstatuscode") || key === "publichealthstatuscode") &&
        typeof rawValue === "number" &&
        rawValue >= 400
      ) return true;
      if (inspect(rawValue)) return true;
    }
    return false;
  }

  if (collectJsonEvidenceValues(raw).some(inspect)) return true;

  const textStatusFailure = [...raw.matchAll(
    /\b(?:status|result_status|operation_status|readiness_status|verdict)\b\s*[:=]\s*["']?(fail|failed|error|blocked|rejected|deceptive|not_ready|missing|incomplete|unresolved|pending)\b/gi,
  )].some((match) => !allowedStatuses.has(match[1].toLowerCase()));

  return (
    textStatusFailure ||
    /\b(?:saved_to_disk|operation_ready|completion_claim_allowed|ingest_complete|document_created|can_?finalize)\b\s*[:=]\s*["']?false\b/i.test(raw) ||
    /\b(?:warnings|errors|blocking_failures|failed_queries)\b\s*[:=]\s*\[\s*(?!\])[^\]]+\]/i.test(raw) ||
    /\b(?:unresolved_groups?|unresolved_occurrences?|remaining(?:_groups|_payloads)?)\b\s*[:=]\s*[1-9]\d*\b/i.test(raw)
  );
}

function isExpectedAdminCodeFixedEvidence(
  claimText: string,
  facts: Map<string, string | number | boolean>,
): boolean {
  if (!/(?:\bcode[_\s-]*fixed\b|코드\s*수정완료)/i.test(claimText)) return false;
  if (facts.get("workflow_state") !== "code_fixed") return false;

  const lifecycle = facts.get("lifecycle_state");
  const status = facts.get("status");
  if (lifecycle !== undefined && lifecycle !== "temporary_fix") return false;
  if (status !== undefined && status !== "unresolved") return false;

  const httpStatus = facts.get("http_status");
  return facts.get("ok") === true ||
    (typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 300);
}

function structuredPrimaryIsStrong(
  item: StructuredEvidenceItem,
  facts: Map<string, string | number | boolean>,
  riskTier: CompletionRiskTier,
  claimText: string,
): boolean {
  if (isExplicitNegativeClaim(claimText)) {
    if (!["process_stdout", "api_json", "tool_json"].includes(item.source_type)) return false;
    if (!hasStructuredFailureSignals(item.raw_output) && !hasNegativeStructuredFacts(facts)) return false;
    if (item.source_type === "process_stdout") {
      return (
        item.exit_code !== undefined &&
        (item.exit_code !== 0 || collectJsonEvidenceValues(item.raw_output).length > 0)
      );
    }
    return collectJsonEvidenceValues(item.raw_output).length > 0;
  }

  if (item.exit_code !== undefined && item.exit_code !== 0) return false;
  const expectedAdminCodeFixed = isExpectedAdminCodeFixedEvidence(claimText, facts);
  if (
    hasNegativeStructuredFacts(facts) ||
    hasStructuredFailureSignals(
      item.raw_output,
      expectedAdminCodeFixed ? new Set(["unresolved"]) : undefined,
    )
  ) return false;
  if (item.source_type === "process_stdout") {
    return (
      item.exit_code === 0 &&
      (hasTieredStrongEvidence(item.raw_output, riskTier) ||
        hasStructuredProcessSuccess(item.raw_output, facts, item.exit_code))
    );
  }
  if (item.source_type !== "api_json" && item.source_type !== "tool_json") return false;
  if (collectJsonEvidenceValues(item.raw_output).length === 0) return false;
  if (expectedAdminCodeFixed) return true;
  if (hasTieredStrongEvidence(item.raw_output, riskTier)) return true;
  return facts.get("status") === "success" && facts.size >= 2;
}

function structuredDomIsCorroborating(
  item: StructuredEvidenceItem,
  facts: Map<string, string | number | boolean>,
): boolean {
  // P2-5 (2026-07-17 plan): DOM 스냅샷에는 exit code 개념이 없다 — undefined 를
  // 허용하지 않으면 클라이언트가 0을 지어내야만 corroborate 가 됐다. 명시된
  // 0 이외의 값은 여전히 거부한다.
  return (
    item.source_type === "playwright_dom" &&
    (item.exit_code === undefined || item.exit_code === 0) &&
    !!item.operation_id?.trim() &&
    /playwright|node[_-]?repl|browser/i.test(item.producer) &&
    item.raw_output.trim().length >= 20 &&
    facts.size > 0 &&
    !hasNegativeStructuredFacts(facts) &&
    !hasStructuredFailureSignals(item.raw_output)
  );
}

function addFactConflicts(
  perItemFacts: Array<{ item: StructuredEvidenceItem; facts: Map<string, string | number | boolean> }>,
  errors: string[],
): Record<string, string | number | boolean> {
  const merged: Record<string, string | number | boolean> = {};
  const observed = new Map<string, { value: string | number | boolean; evidence: string }>();
  for (const { item, facts } of perItemFacts) {
    for (const [key, value] of facts) {
      const prior = observed.get(key);
      if (prior && prior.value !== value) {
        errors.push(
          `fact_mismatch:${key}:${prior.evidence}=${String(prior.value)}:${item.evidence_id ?? item.source_type}=${String(value)}`,
        );
      } else if (!prior) {
        observed.set(key, { value, evidence: item.evidence_id ?? item.source_type });
        merged[key] = value;
      }
    }
  }
  return merged;
}

const REPEATED_ROOT_CAUSE_CLAIM_RE =
  /(?:root[-_\s]?cause|근본\s*원인|원인\s*조사|code[_\s-]*fixed|수정\s*(?:완료|했다|됨)|해결\s*(?:완료|했다|됨)|resolved?)/i;

export function correlateStructuredEvidence(
  claims: StructuredClaim[],
  evidenceItems: StructuredEvidenceItem[],
  riskTier: CompletionRiskTier,
): EvidenceCorrelationResult {
  if (claims.length === 0 && evidenceItems.length === 0) {
    return { enabled: false, all_verified: false, claims: [], errors: [] };
  }

  const errors: string[] = [];
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (claimIds.has(claim.claim_id)) errors.push(`duplicate_claim_id:${claim.claim_id}`);
    claimIds.add(claim.claim_id);
  }
  for (const item of evidenceItems) {
    if (!claimIds.has(item.claim_id)) errors.push(`unknown_claim_id:${item.claim_id}`);
  }

  const results = claims.map((claim): EvidenceCorrelationClaimResult => {
    const items = evidenceItems.filter((item) => item.claim_id === claim.claim_id);
    const claimErrors: string[] = [];
    const perItemFacts = items.map((item) => ({ item, facts: extractCorrelatedFacts(item.raw_output) }));
    const operationIds = new Set(items.map((item) => item.operation_id?.trim()).filter(Boolean) as string[]);
    const targetIds = new Set(items.map((item) => item.target_id?.trim()).filter(Boolean) as string[]);
    const hasDom = items.some((item) => item.source_type === "playwright_dom");
    if (operationIds.size > 1) claimErrors.push(`operation_id_mismatch:${[...operationIds].join(",")}`);
    if (targetIds.size > 1) claimErrors.push(`target_id_mismatch:${[...targetIds].join(",")}`);
    if (hasDom && items.some((item) => !item.operation_id?.trim())) {
      claimErrors.push("operation_id_required_for_correlated_dom");
    }

    const primary = perItemFacts.filter(({ item, facts }) =>
      structuredPrimaryIsStrong(item, facts, riskTier, claim.text),
    );
    const corroborating = perItemFacts.filter(({ item, facts }) =>
      structuredDomIsCorroborating(item, facts),
    );
    if (primary.length === 0) claimErrors.push("strong_primary_evidence_required");
    if (hasDom && corroborating.length === 0) claimErrors.push("playwright_dom_not_raw_or_uncorrelated");

    const facts = addFactConflicts(perItemFacts, claimErrors);
    const recurrenceCount = facts.recurrence_count;
    const repeatedRootCauseClaim =
      typeof recurrenceCount === "number" &&
      recurrenceCount >= 3 &&
      REPEATED_ROOT_CAUSE_CLAIM_RE.test(claim.text);
    if (repeatedRootCauseClaim) {
      if (facts.root_cause_investigation_required !== false) {
        claimErrors.push("root_cause_investigation_not_cleared");
      }
      const producers = new Set(primary.map(({ item }) => item.producer.trim().toLowerCase()));
      const sourceTypes = new Set(primary.map(({ item }) => item.source_type));
      if (producers.size < 2 || sourceTypes.size < 2) {
        claimErrors.push("independent_primary_evidence_required_for_recurrence");
      }
    }
    return {
      claim_id: claim.claim_id,
      verified: primary.length > 0 && claimErrors.length === 0,
      corroborated: primary.length > 0 && corroborating.length > 0 && claimErrors.length === 0,
      primary_sources: primary.map(({ item }) => item.source_type),
      corroborating_sources: corroborating.map(({ item }) => item.source_type),
      operation_id: operationIds.size === 1 ? [...operationIds][0] : null,
      target_id: targetIds.size === 1 ? [...targetIds][0] : null,
      facts,
      errors: claimErrors,
    };
  });

  return {
    enabled: true,
    all_verified: errors.length === 0 && results.length > 0 && results.every((result) => result.verified),
    claims: results,
    errors,
  };
}
