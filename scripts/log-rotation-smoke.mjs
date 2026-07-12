// Regression for pruneRotatedLogs(): once the honest_check call log crosses the
// rotation threshold, each further call renames the log to a timestamped `.bak`
// and prune keeps only the newest HONEST_CALL_LOG_BAK_KEEP (3) backups. Without
// pruning the state dir would accumulate one `.bak` per rotation forever.
//
// We force cheap rotations with HARNESS_HONEST_LOG_MAX_BYTES (tiny) + an isolated
// HARNESS_STATE_DIR, drive many honest_check calls, then assert the `.bak` count
// is capped at 3 and the live log still exists.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BAK_KEEP = 3; // mirrors HONEST_CALL_LOG_BAK_KEEP in guardrail.ts
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotation-smoke-"));
const LOG = path.join(STATE_DIR, "honest_check_calls.jsonl");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: {
    ...process.env,
    HARNESS_MCP_TRIGGERS_NO_CROSS_CHECK: "1",
    HARNESS_STATE_DIR: STATE_DIR,
    HARNESS_HONEST_LOG_MAX_BYTES: "200", // tiny → every call after the first rotates
  },
});
const client = new Client({ name: "log-rotation-smoke", version: "1.0.0" });

function bakFiles() {
  return fs
    .readdirSync(STATE_DIR)
    .filter((n) => n.startsWith("honest_check_calls.jsonl.") && n.endsWith(".bak"));
}

try {
  await client.connect(transport);

  // 12 calls: without pruning that would leave ~11 .bak files. Space them out a
  // few ms so the Date.now()-based .bak names stay distinct.
  for (let i = 0; i < 12; i++) {
    await client.callTool({
      name: "honest_check",
      arguments: {
        response_text: `rotation probe ${i} — exit code: 0, 12 lines, 340 bytes 확인.`,
        session_id: `rot-${i}`,
      },
    });
    await new Promise((r) => setTimeout(r, 5));
  }

  const baks = bakFiles();
  assert.ok(
    baks.length > 0,
    "expected at least one rotated .bak file after crossing the threshold",
  );
  assert.ok(
    baks.length <= BAK_KEEP,
    `rotated .bak files must be capped at ${BAK_KEEP}, found ${baks.length}: ${baks.join(", ")}`,
  );
  assert.ok(fs.existsSync(LOG), "the live honest_check_calls.jsonl must still exist after rotation");

  console.log(
    JSON.stringify(
      { ok: true, bak_count: baks.length, bak_keep: BAK_KEEP, live_log_present: true },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  try {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
  } catch {}
}
