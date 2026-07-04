import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// Path to the Python audit CLI shipped with hermes-spec-pack-prep skill.
// Shared through ~/.gemini/antigravity-ide and ~/.gemini/config/skills, so the same script serves both
// Claude and Antigravity environments.
const PACK_AUDIT_PY =
  process.env.SPEC_PACK_AUDIT_PY ??
  path.join(
    os.homedir(),
    ".claude",
    "skills",
    "hermes-spec-pack-prep",
    "scripts",
    "pack_audit.py",
  );

interface PackAuditResult {
  verdict: "PASS" | "FAIL" | "ERROR";
  blockers?: string[];
  audits?: unknown[];
  declared?: Record<string, unknown>;
  actual?: Record<string, unknown>;
  payload_stats?: Record<string, unknown>;
  upload_files?: { name: string; mb: number }[];
  completion_token?: string | null;
  raw_stdout?: string;
  stderr?: string;
}

export function registerSpecPackTools(server: McpServer) {
  server.tool(
    "spec_pack_audit",
    {
      pack_root: z
        .string()
        .describe(
          "Absolute path to the spec-pack root (must contain documents/, ingest/, logs/, pack.yaml). " +
            "Example: C:\\scratch\\시방서\\kcsc_latest_spec_pack",
        ),
      upload_dir: z
        .string()
        .optional()
        .describe(
          "Directory containing the final per-prefix .md files (e.g. kcsc_split/). " +
            "When omitted, the upload-size guard is skipped — only pack.yaml↔actual count consistency and body quality are audited.",
        ),
      max_mb: z
        .number()
        .optional()
        .describe(
          "Per-file size limit. Default 5.0 = opencrab.sh single-file upload hard limit (verified 2026-05).",
        ),
    },
    async ({ pack_root, upload_dir, max_mb }) => {
      if (!fs.existsSync(PACK_AUDIT_PY)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  verdict: "ERROR",
                  reason: `pack_audit.py not found at ${PACK_AUDIT_PY}. Install hermes-spec-pack-prep skill or set SPEC_PACK_AUDIT_PY.`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const args: string[] = [PACK_AUDIT_PY, "--pack-root", pack_root];
      if (upload_dir) args.push("--upload-dir", upload_dir);
      if (typeof max_mb === "number") args.push("--max-mb", String(max_mb));

      let stdout = "";
      let stderr = "";
      let exit = 0;
      try {
        stdout = execFileSync("python", args, {
          encoding: "utf-8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        exit = typeof err.status === "number" ? err.status : 1;
        stdout = String(err.stdout ?? "");
        stderr = String(err.stderr ?? err.message ?? "");
      }

      let parsed: PackAuditResult;
      try {
        parsed = JSON.parse(stdout) as PackAuditResult;
      } catch {
        parsed = {
          verdict: "ERROR",
          raw_stdout: stdout.slice(0, 4000),
          stderr: stderr.slice(0, 2000),
        };
      }

      // Surface concise, action-oriented instructions back to the model so
      // the call site behaves consistently regardless of which agent is calling.
      let instructions: string;
      if (parsed.verdict === "PASS") {
        instructions =
          "PASS. Include the completion_token verbatim in your final user-facing report. " +
          "honest_check will treat the token + 'spec_pack_audit: PASS' as strong evidence " +
          "for spec-pack completion claims (INVARIANT#23).";
      } else if (parsed.verdict === "FAIL") {
        instructions =
          "FAIL. Do NOT claim the pack is ingest-ready. Address each blocker, re-run the " +
          "extraction/build_payloads/split pipeline, then call spec_pack_audit again. " +
          "If you cannot resolve a blocker, emit STATUS: PARTIAL_STATUS instead of declaring completion.";
      } else {
        instructions =
          "ERROR running the audit. Verify pack_root path exists, pack_audit.py is installed, " +
          "and python is on PATH. Do not claim completion until the audit can run cleanly.";
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ...parsed,
                exit_code: exit,
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
