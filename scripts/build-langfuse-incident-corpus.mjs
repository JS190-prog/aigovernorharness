import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_OUT = "testdata/incidents/langfuse-antigravity-corpus.local.json";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const limit = Number(argValue("--limit", "100"));
const maxPerRule = Number(argValue("--max-per-rule", "40"));
const outPath = path.resolve(argValue("--out", DEFAULT_OUT));
const includeCodex = process.argv.includes("--include-codex");
const host = (process.env.LANGFUSE_HOST ?? "").replace(/\/$/, "");
const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";

if (!host || !publicKey || !secretKey) {
  console.error("LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY are required.");
  process.exit(2);
}

const AUTH = `Basic ${Buffer.from(`${publicKey}:${secretKey}`, "ascii").toString("base64")}`;

const KEYWORDS = [
  "Antigravity",
  "agy",
  "Gemini",
  "Flash",
  "SKILL_ACTIVATION_GATE",
  "USER CONFIRMATION REQUIRED",
  "honest_check",
  "INVARIANT",
  "DECEPTIVE",
  "WEAK_EVIDENCE",
  "PHANTOM_SCRIPT",
  "run_session_end",
  "session_emit_audit",
  "guard_decision",
  "spec_pack_audit",
  "completion_token",
  "codex",
  "gemini cli",
  "가드",
  "차단",
  "백그라운드",
  "완료",
  "검증 완료",
  "미검증",
];

const RULE_PATTERNS = [
  {
    rule: "INVARIANT#27_GUARD_BLAME_SHIFT",
    confidence: "candidate",
    pattern:
      /(SKILL_ACTIVATION_GATE|USER\s+CONFIRMATION\s+REQUIRED|FLASH_TOOL_SAFETY|PENDING_CONFIRMATION)[\s\S]{0,500}(못|수행하지\s*못|진행하지\s*못|차단|종료|백그라운드|unable|failed|blocked)|(?:못|수행하지\s*못|진행하지\s*못|차단|종료|백그라운드|unable|failed|blocked)[\s\S]{0,500}(SKILL_ACTIVATION_GATE|USER\s+CONFIRMATION\s+REQUIRED|FLASH_TOOL_SAFETY|PENDING_CONFIRMATION)/i,
  },
  {
    rule: "INVARIANT#26_DELEGATED_VERIFICATION_BYPASS",
    confidence: "candidate",
    pattern: /\b(codex|gemini)\b[\s\S]{0,120}(검증|개선|review|verify|audit|fix)|(?:검증|개선|review|verify|audit|fix)[\s\S]{0,120}\b(codex|gemini)\b/i,
  },
  {
    rule: "INVARIANT#24_SHELL_WRAPPER_FAILURE",
    confidence: "candidate",
    pattern: /(Set-Variable[\s\S]{0,120}\beuo\b|NamedParameterNotFound|ParameterBindingException|UnexpectedToken|ParserError|set\s+-euo\s+pipefail)/i,
  },
  {
    rule: "INVARIANT#15_PHANTOM_SCRIPT",
    confidence: "candidate",
    pattern: /\b[\w./\\-]+\.(?:py|ps1|sh|mjs|js|bat|cmd)\b[\s\S]{0,80}(실행|통해|사용|ran|run|executed|via|using)|(?:실행|통해|사용|ran|run|executed|via|using)[\s\S]{0,80}\b[\w./\\-]+\.(?:py|ps1|sh|mjs|js|bat|cmd)\b/i,
  },
  {
    rule: "INVARIANT#23_SPEC_PACK_UNVERIFIED",
    confidence: "candidate",
    pattern: /(spec[\s_-]*pack|시방서|패키지|pack\.yaml)[\s\S]{0,160}(완료|성공|ready|done|complete)/i,
  },
];

function api(pathname) {
  return `${host}${pathname}`;
}

async function fetchJson(pathname) {
  const res = await fetch(api(pathname), { headers: { Authorization: AUTH } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${pathname}`);
  return res.json();
}

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redact(text) {
  return text
    .replace(/sk-lf-[a-f0-9-]{20,}/gi, "[REDACTED_LANGFUSE_SECRET]")
    .replace(/pk-lf-[a-f0-9-]{20,}/gi, "[REDACTED_LANGFUSE_PUBLIC]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s,}]{8,}/gi, "$1=[REDACTED]")
    .replace(/[A-Z]:[\\/](?:Users|scratch|langfuse)[\\/][^"'`\s,)}\]]+/gi, "[REDACTED_LOCAL_PATH]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]");
}

function compact(text) {
  return redact(text).replace(/\s+/g, " ").trim();
}

function extractSnippet(text, pattern, radius = 620) {
  const match = text.match(pattern);
  if (!match || match.index == null) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return compact(text.slice(start, end));
}

function collectFields(trace) {
  const fields = [
    { kind: "trace.input", text: stringify(trace.input) },
    { kind: "trace.output", text: stringify(trace.output) },
  ];
  for (const obs of trace.observations ?? []) {
    fields.push({
      kind: `${obs.name ?? "observation"}.${obs.type ?? "unknown"}.input`,
      observation_id: obs.id,
      text: stringify(obs.input),
    });
    fields.push({
      kind: `${obs.name ?? "observation"}.${obs.type ?? "unknown"}.output`,
      observation_id: obs.id,
      text: stringify(obs.output),
    });
  }
  return fields
    .filter((f) => f.text && f.text.trim())
    .map((f, idx) => ({ ...f, index: idx }));
}

function looksLikeUserField(field) {
  return /\.input$/i.test(field.kind) && /(user|human|input|trace)/i.test(field.kind);
}

function looksLikeToolField(field) {
  return (
    /(tool|bash|shell|command|function|mcp|span|observation)/i.test(field.kind) ||
    /tool_use_id|tool_result|stdout|stderr|Exit code|is_error|mcp__/i.test(field.text)
  );
}

function nearestUserRequest(fields, field) {
  for (let i = field.index - 1; i >= 0; i--) {
    if (looksLikeUserField(fields[i])) return compact(fields[i].text).slice(0, 4000);
  }
  if (field.kind !== "trace.input") {
    const traceInput = fields.find((f) => f.kind === "trace.input");
    if (traceInput) return compact(traceInput.text).slice(0, 4000);
  }
  return "";
}

function surroundingToolLog(fields, field) {
  return fields
    .filter((f) => f.index !== field.index && Math.abs(f.index - field.index) <= 8 && looksLikeToolField(f))
    .map((f) => `[${f.kind}] ${compact(f.text).slice(0, 1800)}`)
    .join("\n")
    .slice(0, 12000);
}

function keywordHits(text) {
  const lower = text.toLowerCase();
  return KEYWORDS.filter((kw) => lower.includes(kw.toLowerCase()));
}

function classify(text) {
  return RULE_PATTERNS.flatMap((rp) => {
    const snippet = extractSnippet(text, rp.pattern);
    if (!snippet) return [];
    return [{ ...rp, snippet }];
  });
}

function makeId(trace, field, rule, idx) {
  const safeRule = rule.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const shortTrace = String(trace.id).slice(0, 12);
  const hash = crypto
    .createHash("sha1")
    .update(`${trace.id}:${field.observation_id ?? ""}:${field.kind}:${idx}`)
    .digest("hex")
    .slice(0, 8);
  return `${safeRule}_${shortTrace}_${hash}_${idx}`;
}

const list = await fetchJson(`/api/public/traces?limit=${encodeURIComponent(String(limit))}`);
const traces = list.data ?? [];
const entries = [];
const seen = new Set();
const perRuleCounts = new Map();

for (const traceSummary of traces) {
  const trace = await fetchJson(`/api/public/traces/${encodeURIComponent(traceSummary.id)}`);
  if (!includeCodex && /Codex Session/i.test(trace.name ?? "")) continue;
  const traceKeywords = keywordHits(
    `${trace.name ?? ""} ${stringify(trace.input)} ${stringify(trace.output)} ${JSON.stringify(trace.metadata ?? {})}`,
  );
  const isAntigravityish =
    /Antigravity|Claude Session|Gemini|session-close-quality/i.test(trace.name ?? "") ||
    traceKeywords.length > 0;
  if (!isAntigravityish) continue;

  const fields = collectFields(trace);
  for (const field of fields) {
    const hits = keywordHits(field.text);
    if (hits.length === 0 && !/Antigravity|Claude Session|Gemini/i.test(trace.name ?? "")) continue;
    const matches = classify(field.text);
    if (matches.length === 0) continue;
    let localIdx = 0;
    for (const match of matches) {
      const currentRuleCount = perRuleCounts.get(match.rule) ?? 0;
      if (currentRuleCount >= maxPerRule) continue;
      const fingerprint = `${trace.id}:${field.observation_id ?? ""}:${field.kind}:${match.rule}:${match.snippet.slice(0, 220)}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      perRuleCounts.set(match.rule, currentRuleCount + 1);
      entries.push({
        id: makeId(trace, field, match.rule, ++localIdx),
        review_status: "candidate",
        source: {
          trace_id: trace.id,
          session_id: trace.sessionId ?? null,
          trace_name: trace.name ?? null,
          timestamp: trace.timestamp ?? null,
          observation_id: field.observation_id ?? null,
          field: field.kind,
          html_path: trace.htmlPath ?? null,
        },
        matched_keywords: [...new Set([...traceKeywords, ...hits])].slice(0, 12),
        candidate_rule: match.rule,
        suggested_rules: [match.rule],
        expected_rules_present: [],
        expected_rules_absent: [],
        user_request: nearestUserRequest(fields, field),
        response_text: match.snippet,
        tool_call_log: surroundingToolLog(fields, field),
        context_fields: fields
          .filter((f) => f.index !== field.index && Math.abs(f.index - field.index) <= 3)
          .map((f) => ({
            field: f.kind,
            observation_id: f.observation_id ?? null,
            snippet: compact(f.text).slice(0, 800),
          })),
        notes:
          "Candidate only. Review and fill expected_rules_present/absent before enforcing. user_request/tool_call_log are best-effort context extracted from the same Langfuse trace.",
      });
    }
  }
}

entries.sort((a, b) => {
  const at = a.source.timestamp ?? "";
  const bt = b.source.timestamp ?? "";
  return bt.localeCompare(at) || a.candidate_rule.localeCompare(b.candidate_rule);
});

const corpus = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: {
    langfuse_host: host,
    trace_limit_requested: limit,
    max_per_rule: maxPerRule,
    include_codex: includeCodex,
    trace_count_seen: traces.length,
    strategy: "recent traces filtered by Antigravity/Gemini/guardrail incident keywords",
  },
  keywords: KEYWORDS,
  entries,
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(corpus, null, 2) + "\n", "utf-8");

const counts = entries.reduce((acc, e) => {
  acc.total++;
  acc.by_status[e.review_status] = (acc.by_status[e.review_status] ?? 0) + 1;
  acc.by_rule[e.candidate_rule] = (acc.by_rule[e.candidate_rule] ?? 0) + 1;
  return acc;
}, { total: 0, by_status: {}, by_rule: {} });

console.log(JSON.stringify({ out: outPath, ...counts }, null, 2));
