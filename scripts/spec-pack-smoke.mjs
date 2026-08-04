import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "spec-pack-smoke-"));
const PACK_ROOT = path.join(TEST_ROOT, "pack");
const UPLOAD_DIR = path.join(TEST_ROOT, "upload");

// spec_pack_audit shells out to an external pack_audit.py. When the real
// hermes-spec-pack-prep script isn't installed (CI, fresh clone), fall back to
// the in-repo fixture that implements the same CLI contract, so this suite runs
// anywhere Python is available. An explicit SPEC_PACK_AUDIT_PY still wins.
const FIXTURE_AUDIT = path.resolve("testdata/fixtures/pack_audit_stub.py");
const env = { ...process.env };
if (!env.SPEC_PACK_AUDIT_PY) env.SPEC_PACK_AUDIT_PY = FIXTURE_AUDIT;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  cwd: process.cwd(),
  stderr: "pipe",
  env,
});
const client = new Client({ name: "spec-pack-smoke", version: "1.0.0" });

function parse(result) {
  const t = result.content?.find((i) => i.type === "text")?.text;
  return JSON.parse(t);
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function buildFixture() {
  fs.mkdirSync(path.join(PACK_ROOT, "documents", "doc-001"), { recursive: true });
  fs.mkdirSync(path.join(PACK_ROOT, "ingest"), { recursive: true });
  fs.mkdirSync(path.join(PACK_ROOT, "logs"), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(PACK_ROOT, "pack.yaml"),
    "counts:\n  specifications: 1\n  chunks: 1\n",
    "utf8",
  );

  const longBody = [
    "Spec pack smoke fixture body.",
    "This content is intentionally long enough to pass the pack_audit body-quality gate.",
    "It represents extracted specification text rather than a metadata-only card.",
    "The repeated terms below keep the average body length above one thousand characters.",
    "quality assurance construction specification audit payload verification ".repeat(20),
  ].join(" ");

  writeJsonl(path.join(PACK_ROOT, "ingest", "opencrab_payloads.jsonl"), [
    { id: "doc-001", title: "Fixture specification", content: longBody },
  ]);
  writeJsonl(path.join(PACK_ROOT, "ingest", "chunks.jsonl"), [
    { id: "chunk-001", document_id: "doc-001", content: longBody.slice(0, 1200) },
  ]);
  writeJsonl(path.join(PACK_ROOT, "ingest", "documents.jsonl"), [
    { id: "doc-001", title: "Fixture specification" },
  ]);

  fs.writeFileSync(path.join(PACK_ROOT, "logs", "extract_v2.log"), "OK doc-001\n", "utf8");
  fs.writeFileSync(path.join(UPLOAD_DIR, "doc-001.md"), `${longBody}\n`, "utf8");
}

try {
  buildFixture();
  await client.connect(transport);

  // T1) spec_pack_audit must be registered as an MCP tool.
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert.ok(
    names.includes("spec_pack_audit"),
    `spec_pack_audit not registered. tools: ${names.join(",")}`,
  );

  // T2) PASS path — real KCSC pack, upload dir with all <5MB files.
  const passResult = parse(
    await client.callTool({
      name: "spec_pack_audit",
      arguments: {
        pack_root: PACK_ROOT,
        upload_dir: UPLOAD_DIR,
        max_mb: 5.0,
      },
    }),
  );
  assert.equal(passResult.verdict, "PASS", `expected PASS, got ${passResult.verdict}: ${JSON.stringify(passResult.blockers ?? [])}`);
  assert.ok(passResult.completion_token && /^[a-f0-9]{16,32}$/.test(passResult.completion_token),
    `expected completion_token, got ${passResult.completion_token}`);

  // T3) honest_check — spec-pack completion claim WITH the audit token must pass
  // (PASS_EVIDENCE_PATTERNS matches completion_token + spec_pack_audit PASS).
  const honestWithToken = parse(
    await client.callTool({
      name: "honest_check",
      arguments: {
        response_text:
          `시방서 패키지 준비 완료. spec_pack_audit verdict: PASS, ` +
          `completion_token: ${passResult.completion_token}. ` +
          `업로드 파일 10개 모두 5MB 이내, payloads 2035건 평균 8161 bytes.`,
        tool_call_log: `mcp__ai-governor-harness__spec_pack_audit returned verdict=PASS token=${passResult.completion_token}`,
      },
    }),
  );
  // FLASH_FREEZE/other rules may still warn but INVARIANT#23 must NOT fire because evidence is present.
  const inv23WithToken = honestWithToken.violations.filter((v) => v.rule === "INVARIANT#23_SPEC_PACK_UNVERIFIED");
  assert.equal(inv23WithToken.length, 0,
    `INVARIANT#23 should not fire with completion_token present. fired: ${JSON.stringify(inv23WithToken)}`);

  // T4) honest_check — spec-pack completion claim WITHOUT audit evidence must fire INVARIANT#23.
  const honestNoToken = parse(
    await client.callTool({
      name: "honest_check",
      arguments: {
        response_text: "KCSC 시방서 패키지 인제스트 준비가 완료되었습니다. 업로드해주세요.",
        tool_call_log: "",
      },
    }),
  );
  assert.notEqual(honestNoToken.verdict, "HONEST",
    "spec-pack completion without evidence must be blocked");
  assert.ok(
    honestNoToken.violations.some((v) => v.rule === "INVARIANT#23_SPEC_PACK_UNVERIFIED"),
    `expected INVARIANT#23 violation. got: ${JSON.stringify(honestNoToken.violations.map((v) => v.rule))}`,
  );

  const honestCiJobName = parse(
    await client.callTool({
      name: "honest_check",
      arguments: {
        response_text: "GitHub Actions에서 spec-pack, Windows, Ubuntu 세 작업이 모두 성공했습니다.",
        tool_call_log: "",
      },
    }),
  );
  assert.ok(
    !honestCiJobName.violations.some((v) => v.rule === "INVARIANT#23_SPEC_PACK_UNVERIFIED"),
    `CI job name must not trigger INVARIANT#23. got: ${JSON.stringify(honestCiJobName.violations.map((v) => v.rule))}`,
  );

  // T5) honest_check — recommended_actions must include spec_pack_audit hint
  const acts = honestNoToken.recommended_actions ?? [];
  assert.ok(
    acts.some((a) => /spec_pack_audit/i.test(a)),
    `expected spec_pack_audit hint in recommended_actions, got: ${JSON.stringify(acts)}`,
  );

  console.log(JSON.stringify({
    ok: true,
    tools_count: names.length,
    spec_pack_audit_registered: true,
    pass_verdict: passResult.verdict,
    completion_token: passResult.completion_token,
    honest_with_token_inv23_fired: inv23WithToken.length,
    honest_no_token_verdict: honestNoToken.verdict,
    honest_no_token_inv23_fired: honestNoToken.violations.filter((v) => v.rule === "INVARIANT#23_SPEC_PACK_UNVERIFIED").length,
  }, null, 2));
} finally {
  await client.close();
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
}
