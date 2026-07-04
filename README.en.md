# AI Governor Harness

English | [한국어](README.md)

AI Governor Harness is a Model Context Protocol (MCP) server that helps AI
agents verify evidence before reporting completion, detect risky action intent,
and keep multi-step work moving safely.

The server is written in TypeScript and runs over stdio. It can be connected to
MCP-capable clients such as Codex, Claude Desktop, Antigravity, and other agent
environments.

## Features

- `honest_check` verifies completion claims against raw evidence, tool-call logs,
  and draft user-facing responses.
- `chain_progress_check` catches unnecessary stop-and-ask behavior during
  multi-step work.
- `turn_intent_check` classifies sensitive, destructive, delegated, or
  skill-routed requests before action.
- `session_emit_audit` checks that recent final-response verification was not
  skipped.
- `spec_pack_audit` calls an external pack-audit script to validate upload-ready
  spec or ontology packs.

## Repository Layout

```text
.
|-- config/
|   |-- mcp_triggers.json
|   `-- skill_routes.supplement.json
|-- scripts/
|   |-- mcp-smoke.mjs
|   |-- mcp-regression.mjs
|   |-- corpus-regression.mjs
|   `-- build-langfuse-incident-corpus.mjs
|-- src/
|   |-- index.ts
|   `-- tools/
|       |-- guardrail.ts
|       `-- spec_pack_audit.ts
|-- testdata/
|   `-- incidents/
|       `-- langfuse-antigravity-corpus.json
|-- package.json
`-- tsconfig.json
```

## Requirements

- Node.js 20 or newer
- pnpm 10.x
- An MCP-capable client
- Python plus an external `pack_audit.py` path if you want to use
  `spec_pack_audit`

## Install

```bash
git clone https://github.com/JS190-prog/aigovernorharness.git
cd aigovernorharness
pnpm install
pnpm build
```

You can also build with npm:

```bash
npm install
npm run build
```

## Run

```bash
pnpm start
```

Equivalent command:

```bash
node build/index.js
```

When the server starts, it writes a status line like this to stderr:

```text
AI-Governor-Harness MCP server v2.5.0 running on stdio (session_id=...)
```

## MCP Client Example

Register the server as a stdio transport after building the repository:

```json
{
  "mcpServers": {
    "ai-governor-harness": {
      "command": "node",
      "args": ["/absolute/path/to/aigovernorharness/build/index.js"],
      "env": {
        "HARNESS_SESSION_ID": "my-session-id"
      }
    }
  }
}
```

Use distinct `HARNESS_SESSION_ID` values, or pass explicit `session_id` values
in tool calls, when multiple agents or IDE windows are connected at the same
time.

## Tests

Run the main suite:

```bash
pnpm test
```

This runs:

```bash
pnpm build
node scripts/mcp-smoke.mjs
node scripts/mcp-regression.mjs
```

Run the public synthetic corpus regression suite:

```bash
pnpm corpus:test
```

Build a local Langfuse-derived corpus:

```bash
pnpm corpus:build
```

`pnpm corpus:build` requires `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, and
`LANGFUSE_SECRET_KEY`. Review generated entries before publishing them; the
checked-in corpus is synthetic and intentionally contains no private traces.

## Environment Variables

| Variable | Description |
| --- | --- |
| `HARNESS_SESSION_ID` | Default session ID. If missing or set to `default`, an automatic ID is generated. |
| `HARNESS_STATE_DIR` | Directory for pending state and call logs. Tests inject a temporary directory. |
| `HARNESS_SEARCH_ROOTS` | File-name search roots, separated by the OS-specific path delimiter. |
| `HARNESS_MCP_TRIGGERS_CONFIG` | Alternate path for `mcp_triggers.json`. |
| `HARNESS_SKILL_ROUTES_CONFIG` | Alternate path for skill-routing JSON. |
| `HARNESS_MCP_TRIGGERS_NO_CROSS_CHECK` | Set to `1` to disable MCP config cross-checking. |
| `ANTIGRAVITY_ROOT` | Base root for Antigravity config and state files. |
| `SPEC_PACK_AUDIT_PY` | Path to the Python audit script used by `spec_pack_audit`. |

## Publishing Notes

Before publishing changes publicly, check that generated files, local logs, and
private corpus data are not staged:

```bash
git status --short
```

Do not commit `node_modules/`, `build/`, `*.log`, local MCP state, credentials,
or raw exported incident corpora.

## License

MIT
