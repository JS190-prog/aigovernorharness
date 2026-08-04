import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-lifecycle-"));
const lifecycleLog = path.join(stateDir, "harness_lifecycle.jsonl");
const expectedDefaultLog = path.join(process.cwd(), "runtime", "state", "harness_lifecycle.jsonl");

function run(args, sessionId) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf-8",
    input: "",
    timeout: 10_000,
    env: {
      ...process.env,
      HARNESS_SESSION_ID: sessionId,
      HARNESS_STATE_DIR: stateDir,
    },
  });
}

function entries() {
  return fs
    .readFileSync(lifecycleLog, "utf-8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const defaultPathProbe = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", "import { getLifecycleLogPath } from './build/lifecycle.js'; console.log(getLifecycleLogPath());"],
  {
    cwd: process.cwd(),
    encoding: "utf-8",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !["HARNESS_STATE_DIR", "HARNESS_LIFECYCLE_LOG"].includes(key)),
    ),
  },
);
assert.equal(defaultPathProbe.status, 0, defaultPathProbe.stderr);
assert.equal(path.normalize(defaultPathProbe.stdout.trim()), path.normalize(expectedDefaultLog));

const first = run(["build/index.js"], "lifecycle-normal-1");
assert.equal(first.status, 0, first.stderr);
let observed = entries();
assert.ok(observed.some((entry) => entry.event === "startup"));
assert.ok(observed.some((entry) => entry.event === "stdio_connected"));
assert.ok(observed.some((entry) => entry.event === "stdin_end" || entry.event === "stdin_close"));
assert.ok(observed.some((entry) => entry.event === "process_exit" && entry.details?.code === 0));

const second = run(["build/index.js"], "lifecycle-normal-2");
assert.equal(second.status, 0, second.stderr);
observed = entries();
assert.ok(observed.some((entry) => entry.event === "restart_detected" && entry.details?.previous_clean_exit === true));

const uncaught = run(["scripts/lifecycle-crash-fixture.mjs", "uncaught"], "lifecycle-uncaught");
assert.notEqual(uncaught.status, 0, "uncaught exception fixture must fail");
observed = entries();
assert.ok(observed.some((entry) => entry.event === "uncaught_exception"));

const rejection = run(["scripts/lifecycle-crash-fixture.mjs", "rejection"], "lifecycle-rejection");
assert.notEqual(rejection.status, 0, "unhandled rejection fixture must fail");
observed = entries();
assert.ok(observed.some((entry) => entry.event === "unhandled_rejection"));

console.log(JSON.stringify({
  ok: true,
  state_dir: stateDir,
  default_log: expectedDefaultLog,
  events: [...new Set(observed.map((entry) => entry.event))].sort(),
}, null, 2));
