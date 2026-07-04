import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

if (!process.env.HARNESS_SESSION_ID || process.env.HARNESS_SESSION_ID === "default") {
  const auto = `auto-${process.pid}-${Date.now().toString(36)}`;
  process.env.HARNESS_SESSION_ID = auto;
  console.error(
    `[harness] HARNESS_SESSION_ID was unset/default — bootstrapped to '${auto}' for this process. ` +
      `Per-conversation isolation requires the caller to pass session_id explicitly when running concurrent MCP clients.`,
  );
}

const { registerGuardrailTools } = await import("./tools/guardrail.js");
const { registerSpecPackTools } = await import("./tools/spec_pack_audit.js");

const server = new McpServer({
  name: "ai-governor-harness",
  version: "2.5.0",
});

registerGuardrailTools(server);
registerSpecPackTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `AI-Governor-Harness MCP server v2.5.0 running on stdio ` +
      `(session_id=${process.env.HARNESS_SESSION_ID})`,
  );
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
