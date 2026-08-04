import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { installLifecycleDiagnostics, markStdioConnected } from "./lifecycle.js";

// Single source of truth for the version: read it from package.json at runtime
// (build/index.js → ../package.json = repo root) instead of hardcoding it in
// three places (was index.ts ×2 + README). (P3-2)
const require = createRequire(import.meta.url);
const { version: HARNESS_VERSION } = require("../package.json") as { version: string };

if (!process.env.HARNESS_SESSION_ID || process.env.HARNESS_SESSION_ID === "default") {
  const auto = `auto-${process.pid}-${Date.now().toString(36)}`;
  process.env.HARNESS_SESSION_ID = auto;
  console.error(
    `[harness] HARNESS_SESSION_ID was unset/default — bootstrapped to '${auto}' for this process. ` +
      `Per-conversation isolation requires the caller to pass session_id explicitly when running concurrent MCP clients.`,
  );
}

installLifecycleDiagnostics();

const { registerGuardrailTools } = await import("./tools/guardrail.js");
const { registerSpecPackTools } = await import("./tools/spec_pack_audit.js");

const server = new McpServer({
  name: "ai-governor-harness",
  version: HARNESS_VERSION,
});

registerGuardrailTools(server);
registerSpecPackTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  markStdioConnected();
  console.error(
    `AI-Governor-Harness MCP server v${HARNESS_VERSION} running on stdio ` +
      `(session_id=${process.env.HARNESS_SESSION_ID})`,
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
