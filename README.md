# AI Governor Harness

[English](README.en.md) | 한국어

AI Governor Harness는 AI 에이전트가 "작업을 끝냈다"고 보고하기 전에 실제 증거를 확인하고, 위험한 작업 의도를 감지하며, 여러 단계로 이어지는 작업 흐름을 안전하게 유지하도록 돕는 Model Context Protocol(MCP) 서버입니다.

이 서버는 TypeScript로 작성되어 stdio transport로 실행됩니다. Codex, Claude Desktop, Antigravity 등 MCP를 지원하는 클라이언트에서 도구 서버로 연결해 사용할 수 있습니다.

## 주요 기능

- `honest_check`: 응답 초안, 도구 호출 로그, 원시 실행 증거를 비교해 근거 없는 완료 주장과 파일 경로 환각을 잡습니다.
- `chain_progress_check`: 여러 단계 작업 중 불필요하게 멈춰 사용자에게 재확인을 요구하는 패턴을 감지합니다.
- `turn_intent_check`: 민감 작업, 파괴적 작업, 위임 검증, 스킬 우선 라우팅이 필요한 요청을 실행 전에 분류합니다.
- `session_emit_audit`: 최종 응답 직전에 최근 검증 호출이 누락되지 않았는지 확인합니다.
- `spec_pack_audit`: 외부 pack audit 스크립트를 호출해 spec pack 또는 ontology pack의 업로드 준비 상태를 검증합니다.

## 저장소 구조

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

## 요구 사항

- Node.js 20 이상
- pnpm 10.x
- MCP를 지원하는 클라이언트
- `spec_pack_audit`를 사용하려면 Python과 외부 `pack_audit.py` 경로가 필요합니다.

## 설치

```bash
git clone https://github.com/JS190-prog/aigovernorharness.git
cd aigovernorharness
pnpm install
pnpm build
```

npm으로도 빌드할 수 있습니다.

```bash
npm install
npm run build
```

## 실행

```bash
pnpm start
```

같은 명령을 직접 실행하면 다음과 같습니다.

```bash
node build/index.js
```

서버가 시작되면 stderr에 다음과 비슷한 상태 메시지가 출력됩니다.

```text
AI-Governor-Harness MCP server v2.5.0 running on stdio (session_id=...)
```

## MCP 클라이언트 설정 예시

빌드 후 MCP 클라이언트 설정에 stdio 서버로 등록합니다.

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

여러 IDE 창이나 여러 에이전트가 동시에 같은 서버를 사용할 때는 서로 다른 `HARNESS_SESSION_ID`를 설정하거나, 각 도구 호출에 명시적인 `session_id`를 전달하는 것이 안전합니다.

## 테스트

기본 테스트를 실행합니다.

```bash
pnpm test
```

이 명령은 다음 작업을 순서대로 수행합니다.

```bash
pnpm build
node scripts/mcp-smoke.mjs
node scripts/mcp-regression.mjs
```

공개용 synthetic corpus 회귀 테스트는 별도로 실행할 수 있습니다.

```bash
pnpm corpus:test
```

로컬 Langfuse 데이터에서 corpus를 생성하려면 다음 명령을 사용합니다.

```bash
pnpm corpus:build
```

`pnpm corpus:build`는 `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`가 필요합니다. 생성된 corpus에는 로컬 trace 문맥이 들어갈 수 있으므로 공개 전에 반드시 검토해야 합니다. 저장소에 포함된 corpus는 공개용 synthetic fixture입니다.

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `HARNESS_SESSION_ID` | 기본 세션 ID입니다. 없거나 `default`이면 서버가 자동 ID를 생성합니다. |
| `HARNESS_STATE_DIR` | pending state와 호출 로그를 저장하는 디렉터리입니다. 테스트에서는 임시 디렉터리를 주입합니다. |
| `HARNESS_SEARCH_ROOTS` | 파일명 검색 루트 목록입니다. OS별 path delimiter로 구분합니다. |
| `HARNESS_MCP_TRIGGERS_CONFIG` | `mcp_triggers.json` 대체 경로입니다. |
| `HARNESS_SKILL_ROUTES_CONFIG` | skill routing JSON 대체 경로입니다. |
| `HARNESS_MCP_TRIGGERS_NO_CROSS_CHECK` | `1`로 설정하면 MCP 설정 cross-check를 비활성화합니다. |
| `ANTIGRAVITY_ROOT` | Antigravity 설정과 상태 파일의 기준 루트입니다. |
| `SPEC_PACK_AUDIT_PY` | `spec_pack_audit`가 사용할 Python 감사 스크립트 경로입니다. |

## 공개 전 주의 사항

공개 저장소에 올리기 전에는 생성 파일, 로컬 로그, private corpus 데이터가 staged 상태인지 확인하세요.

```bash
git status --short
```

다음 항목은 커밋하지 않는 것이 좋습니다.

- `node_modules/`
- `build/`
- `*.log`
- 로컬 MCP 상태 파일
- credential 또는 API key가 들어 있는 설정 파일
- 실제 trace에서 뽑은 raw incident corpus

## 라이선스

ISC
