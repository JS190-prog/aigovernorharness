import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const corpusPath = path.resolve(process.argv[2] ?? "testdata/incidents/langfuse-antigravity-corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf-8"));
const enforceable = (corpus.entries ?? []).filter(
  (entry) =>
    Array.isArray(entry.expected_rules_present) &&
    Array.isArray(entry.expected_rules_absent) &&
    (entry.expected_rules_present.length > 0 || entry.expected_rules_absent.length > 0),
);

if (enforceable.length === 0) {
  console.error(
    JSON.stringify(
      {
        corpus: corpusPath,
        generated_at: corpus.generated_at ?? null,
        total_entries: (corpus.entries ?? []).length,
        enforceable_entries: 0,
        error:
          "No enforceable corpus entries. Review Langfuse candidates and fill expected_rules_present/expected_rules_absent before trusting corpus:test.",
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

const TEST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "harness-corpus-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: { ...process.env, HARNESS_STATE_DIR: TEST_STATE_DIR },
});
const client = new Client({ name: "ai-governor-harness-corpus", version: "1.0.0" });

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool returned no text content");
  return JSON.parse(text);
}

let pass = 0;
let fail = 0;
const failures = [];

try {
  await client.connect(transport);
  for (const entry of enforceable) {
    try {
      const result = parse(
        await client.callTool({
          name: "honest_check",
          arguments: {
            response_text: entry.response_text,
            user_request: entry.user_request ?? "",
            tool_call_log: entry.tool_call_log ?? "",
            session_id: `corpus-${entry.id}`,
          },
        }),
      );
      const rules = new Set((result.violations ?? []).map((v) => v.rule));
      for (const rule of entry.expected_rules_present ?? []) {
        assert.ok(rules.has(rule), `${entry.id}: expected ${rule}, got ${[...rules].join(", ")}`);
      }
      for (const rule of entry.expected_rules_absent ?? []) {
        assert.ok(!rules.has(rule), `${entry.id}: unexpected ${rule}, got ${[...rules].join(", ")}`);
      }
      pass++;
    } catch (err) {
      fail++;
      failures.push(String(err?.message ?? err));
    }
  }
} finally {
  await client.close();
  try { fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true }); } catch {}
}

console.log(JSON.stringify({
  corpus: corpusPath,
  generated_at: corpus.generated_at ?? null,
  total_entries: (corpus.entries ?? []).length,
  enforceable_entries: enforceable.length,
  pass,
  fail,
  failures: failures.slice(0, 20),
}, null, 2));

if (fail > 0) process.exit(1);
