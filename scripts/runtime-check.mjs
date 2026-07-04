import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "harness-runtime-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env: { ...process.env, HARNESS_STATE_DIR: TEST_STATE_DIR },
});

const client = new Client({ name: "ai-governor-harness-runtime-check", version: "1.0.0" });

function parseToolJson(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool returned no text content");
  return JSON.parse(text);
}

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("honest_check"), `honest_check not registered; tools=${toolNames.join(",")}`);

  const result = parseToolJson(
    await client.callTool({
      name: "honest_check",
      arguments: {
        response_text:
          "STATUS: EVIDENCE_READY\n" +
          "Runtime guard check fixture.\n" +
          "exit code: 0\n" +
          "stdout: smoke ok\n" +
          "lines=4 bytes=72",
        claimed_items: ["runtime guard check"],
        evidence_outputs: ["exit code: 0\nstdout: smoke ok\nlines=4 bytes=72"],
        tool_call_log: "runtime-check fixture: exit code 0, stdout smoke ok, lines=4 bytes=72",
        session_id: "runtime-check",
      },
    }),
  );

  assert.equal(result.verdict, "HONEST", `expected HONEST, got ${result.verdict}: ${result.reason}`);
  console.log(JSON.stringify({ ok: true, verdict: result.verdict, tools: toolNames.sort() }, null, 2));
} finally {
  await client.close();
  try {
    fs.rmSync(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {}
}
