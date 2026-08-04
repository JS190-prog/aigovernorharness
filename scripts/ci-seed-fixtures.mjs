// Seed a deterministic skills-fixture directory + a skill-routes config so the
// regression suite's skill-first (INVARIANT#25) and skill-install cases pass on
// a clean CI runner that has none of the author's real skills installed.
//
// The harness reads HARNESS_SKILL_ROOTS (skill directories) and
// HARNESS_SKILL_ROUTES_CONFIG (the generated-routes JSON) — this script writes
// both under a caller-provided output dir and prints the two paths as
// `KEY=VALUE` lines so a CI step can export them.
//
// Usage: node scripts/ci-seed-fixtures.mjs <out_dir>
import * as fs from "node:fs";
import * as path from "node:path";

const outDir = path.resolve(process.argv[2] ?? "ci-fixtures");

// Skills the regression suite treats as "really installed" (must have SKILL.md):
//   codex-natural, crab                       → 11a/11f corroboration
//   hermes-audio-transcriber                  → 13a/13b/13d/13d2 skill-first
//   hermes-mcp-orchestrator, hermes-cad-expert → 13b4/13b5 route disambiguation
//   hermes-naver-publish, hermes-blog-verify,
//   hermes-illustration-expert                → supplement-route triggers (17x)
const SKILLS = [
  "codex-natural",
  "crab",
  "hermes-audio-transcriber",
  "hermes-mcp-orchestrator",
  "hermes-cad-expert",
  "hermes-naver-publish",
  "hermes-blog-verify",
  "hermes-illustration-expert",
];

// Routes the in-repo supplement does NOT provide (normally supplied by the
// generated-routes.json the sync watcher writes on the author's machine).
const ROUTES = [
  {
    keywords: ["전사", "녹음 전사", "회의 녹음", "회의 녹음 전사"],
    skills: ["hermes-audio-transcriber"],
  },
  {
    keywords: ["cad", "캐드", "도면 분석", "dwg", "dxf", "오토캐드", "건축 도면"],
    skills: ["hermes-mcp-orchestrator", "hermes-cad-expert"],
  },
];

const skillRoot = path.join(outDir, "skills");
for (const s of SKILLS) {
  const dir = path.join(skillRoot, s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${s}\ndescription: CI fixture skill.\n---\n\nCI fixture.\n`,
    "utf-8",
  );
}

const routesPath = path.join(outDir, "generated-routes.json");
fs.writeFileSync(routesPath, JSON.stringify(ROUTES, null, 2), "utf-8");

// Emit machine-readable exports. The runtime-created skill root used by test
// 11c (<cwd>/.agents/skills) is appended so its half-created fixture is still
// discovered when HARNESS_SKILL_ROOTS overrides the defaults.
// Emit forward-slash paths (Node accepts them on Windows) so the KEY=VALUE lines
// survive both `>> $GITHUB_ENV` and a plain shell read-loop without backslash
// escaping. The platform delimiter (';' on Windows, ':' on POSIX) still joins.
const fwd = (p) => p.replace(/\\/g, "/");
const skillRootsValue = [
  skillRoot,
  path.join(process.cwd(), ".agents", "skills"),
  path.join(process.cwd(), ".claude", "skills"),
]
  .map(fwd)
  .join(path.delimiter);

process.stdout.write(`HARNESS_SKILL_ROOTS=${skillRootsValue}\n`);
process.stdout.write(`HARNESS_SKILL_ROUTES_CONFIG=${fwd(routesPath)}\n`);
