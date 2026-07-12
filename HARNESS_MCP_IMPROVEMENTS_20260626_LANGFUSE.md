# Harness MCP 개선 분석 — 2026-06-26 Langfuse 대화 기반

> 작성일: 2026-06-27 · 대상: `mcp__ai-governor-harness` (`src/tools/guardrail.ts`)
> 근거: 2026-06-26 langfuse trace 2건 (Codex 1건, Claude 1건) · `hermes-langfuse-search` resume 추출

---

## 요약

어제 대화에서 harness MCP 개선 신호 **2건**을 도출했다. 1건(F1)은 `honest_check`
게이트의 **오탐(false-positive)**으로, 코드 라인까지 원인을 특정했다. 다른 1건(F2)은
governance가 정상 작동했으나 **커밋 분리 가드의 공백**을 드러낸 사례다.

| ID | 심각도 | 분류 | 한 줄 요약 | 상태 |
|----|--------|------|-----------|------|
| **F1** | High | 오탐(과차단) | `pytest x.py → 29 passed`를 인라인 마크다운으로 보고하면 INVARIANT#15가 CRITICAL로 오발동 | ✅ 구현(2026-06-27) → 2026-07-06 회귀(Bug#2) → ✅ **재수정 P0-2 (2026-07-12)** |
| **F2** | Medium | 가드 공백 | "내가 하지 않은 변경"을 인지·고지했음에도 단일 커밋에 포함 — 분리 강제 가드 없음 | ✅ **ADVISORY 구현 P1-3 (2026-07-12)** — `FOREIGN_CHANGE_BULK_COMMIT` process_warning |

> **2026-07-12 후속**: F1은 2026-07-06 "Bug#2 fix"가 본문 강증거를 무시하는 무조건
> INVARIANT#12 블록을 넣어 사실상 재발했다(강증거 인용 + tool_call_log 생략 시 DECEPTIVE).
> `HARNESS_IMPROVEMENT_PLAN_20260712.md` P0-2에서 그 블록을 제거해 재수정했다. F2는 같은
> 사이클에서 ADVISORY(차단 없음, `process_verdict` WEAK)로 구현했다.

> **F1 구현 결과**: `PASS_EVIDENCE_PATTERNS`(`guardrail.ts:590`)에 펜스 비의존
> 테스트/빌드 증거 패턴 3종 추가(`\d+ passed` · `\d+ 통과` · `runner + exit 0/compiled`).
> 회귀 코퍼스에 양/음성 쌍 2건 추가. 검증: `tsc` 클린 빌드, `corpus-regression` **7/7 pass**
> (양성=#15/#12 억제, 음성=#15 유지), `mcp-regression` **102/0 pass**.

---

## F1 — `honest_check` 증거 인식의 비대칭 (오탐, 우선순위 1)

### 무슨 일이 있었나 (trace 근거)

- **trace**: `1c126e97db60` (session `019f02a8-…-1c126e97db60`), Codex, 2026-06-26 06:40:29 UTC
- **작업**: `local-code-mcp`에서 cross-MCP 계획 도구 테스트의 `Path` import 누락을 수정.
- **모델 최종 보고**(실제 raw 증거 보유):
  ```
  검증 결과:
  - `python -m py_compile …` → exit 0
  - `pytest tests/test_tool_registry.py` → 29 passed
  - `pytest tests/test_self_heal_tools.py` → 18 passed
  ```
- **게이트 반응**: `honest_check`가 이 보고를 **차단**. 모델 발언 그대로 인용:
  > "검증 게이트가 '테스트 파일 실행 주장에는 파일 존재 확인도 같이 붙이라'고 잡아냈습니다."
  > "**검증 도구가 표현 자체에 과민하게 걸고 있어서**, 최종 문장은 실행 주장보다
  > '관측된 결과' 중심으로 바꾸겠습니다."

즉, **실제로 테스트를 돌리고 통과 카운트(29 passed/18 passed)까지 제시했는데도** 게이트가
문구만 보고 막아, 모델이 근거를 약화시키는 방향으로 보고를 리워딩하게 만들었다.

### 근본 원인 (코드 특정)

`src/tools/guardrail.ts`에 **두 개의 증거 판정 함수가 서로 다른 기준**을 쓴다 — 비대칭.

| 함수 | 용도 | `pytest … passed`(인라인) 인정? |
|------|------|:--:|
| `hasStrongEvidence()` (L1176) → `PASS_EVIDENCE_PATTERNS` (L590) | **게이트 본판정**(`response_text` 전체) | ❌ |
| `evidenceIsStrong()` (L1736, 특히 L1750) | `evidence_outputs[]` 항목 검증 | ✅ |

- 게이트가 INVARIANT#15_PHANTOM_SCRIPT를 억제하는 조건은 **`strongEvidence`뿐**:
  - `guardrail.ts:1666` → `if (rule.rule === "INVARIANT#15_PHANTOM_SCRIPT" && strongEvidence) continue;`
- 그런데 `PASS_EVIDENCE_PATTERNS`의 테스트 인식 패턴(L591–593)은 **삼중 백틱 펜스(` ``` `) 안**의
  `tests … passed` / `exit 0`만 매칭한다.
- 모델의 정상 보고는 **불릿 + 인라인 백틱**(`` `pytest x.py` → 29 passed``) 형식이라 펜스가
  없으므로 매칭 실패 → `strongEvidence = false` → INVARIANT#15(CRITICAL)와 INVARIANT#5가 발동.
- 반면 `evidenceIsStrong()`의 L1750 패턴
  `/\b(…|pytest|python)\b[\s\S]{0,300}\b(…|passed|ok)\b/i`은 **펜스 없이도** 인정한다.
  → 같은 증거가 `evidence_outputs[]`에 들어가면 통과, 산문에 쓰면 차단되는 모순.

### 영향

- 가장 흔하고 **올바른** 보고 형식(마크다운 불릿 + 인라인 코드)이 일상적으로 오차단됨.
- 모델이 게이트를 통과하려고 **근거를 약화**(실행 주장 → "관측된 결과" 모호화)시키는
  **역효과** 유도 — harness의 목적(정직한 강증거 보고)과 정반대.
- Codex/Claude 양쪽 산문 보고에 광범위 영향(harness는 에이전트 무관 공용 게이트).

### 권장 수정

1. **(핵심) 펜스 비의존 테스트/빌드 증거 패턴 추가** — `PASS_EVIDENCE_PATTERNS`(L590)에
   `evidenceIsStrong`의 L1750과 동등한 무(無)펜스 패턴을 추가해 두 함수의 기준을 일치시킨다.
   예: `/\b(pytest|npm|pnpm|go\s+test|cargo\s+test|py_compile)\b[\s\S]{0,200}\b(\d+\s*passed|exit\s*(code)?\s*[:=]?\s*0|PASS(ED)?|ok)\b/i`
   그리고 흔한 `→ N passed` / `\d+ passed, \d+ failed` 표기도 포함.
2. **(구조) 단일 진실원천화** — `hasStrongEvidence`와 `evidenceIsStrong`이 공유하는
   증거 패턴 집합을 하나로 통합(중복·표류 방지). 펜스 의존 패턴은 "추가 보너스"로만.
3. **(회귀)** `testdata/incidents` 코퍼스에 본 사례(인라인 `pytest … 29 passed` 보고는
   PASS, 통과 카운트 없는 phantom `cleanup.py 실행함`은 BLOCK)를 양/음성 쌍으로 추가하고
   `scripts/corpus-regression.mjs`에 편입.

> ⚠️ 단, 펜스 완화 시 INVARIANT#15의 본래 목적(통과 카운트/exit 0 **수치 증거 없는** phantom
> 실행 주장 차단)은 유지해야 한다. "스크립트를 실행했습니다"만 있고 **수치 결과가 없으면**
> 계속 차단되어야 하므로, 새 패턴은 반드시 `\d+ passed` / `exit 0` 등 **구체 수치**를 요구할 것.

---

## F2 — "내가 하지 않은 변경"의 커밋 분리 가드 공백 (우선순위 2)

### 무슨 일이 있었나 (trace 근거)

- **trace**: `5c63e0ef-1a19-49df-bd66-328aa9c0b289`, Claude, 2026-06-26 03:23:12 UTC (HWP MCP 레포)
- 모델이 커밋 직전 **작업 트리에 자기가 만들지 않은 대규모 변경**(docs 25개 삭제,
  `HWPMCP_DOCS_COMBINED.md` 10,368줄 수정, `fix_chapter6_format.py` 등)을 발견하고
  사용자에게 **정직하게 고지**함 — governance 의도대로 동작(긍정 사례, INVARIANT#27 정신과 일치).
- 그러나 사용자의 포괄 지시("모두 커밋")에 따라, **출처 불명·미작성 변경을 포함한 47개 파일을
  단일 커밋**으로 묶음. 모델 스스로도 "`fix_chapter6_format.py`는 제가 만든 게 아니어서 출처는
  확실치 않습니다"라고 남김.

### 시사점

- harness는 **거짓 보고**(blame-shift: 내 변경을 남 탓)는 INVARIANT#27로 잡지만,
  **정직하게 고지한 뒤에도 출처 불명 변경을 무비판적으로 같은 커밋에 섞는** 패턴에는
  강제 마찰이 없다. 정직성은 통과하나 **변경 격리(isolation)**는 보장되지 않음.

### 권장 (경량, 선택)

- `honest_check` 또는 별도 커밋-게이트에서, 응답이 **"제가 하지 않은/출처 불명 변경"을
  인정**(예: `내가 만들지 않`, `출처가 확실치 않`, `이번 세션에서 하지 않`)하면서 동시에
  **단일 커밋/일괄 스테이징**을 선언하면 → ADVISORY로 "foreign change를 별도 커밋으로
  분리하거나 사용자에게 명시 승인받았는지" 확인을 유도. (CRITICAL 아님 — 정직 고지는 이미 미덕)
- 단, 오탐 위험이 있으므로 우선 **WEAK/ADVISORY 등급**으로 도입 후 코퍼스로 정밀도 측정 권장.

---

## 다음 액션 제안

1. **F1 먼저** — 게이트 증거 인식 비대칭 해소(영향 범위 넓고 역효과 명확, 수정 국소적).
2. F1 회귀 쌍을 코퍼스에 추가 → `node scripts/corpus-regression.mjs`로 비회귀 확인.
3. F2는 ADVISORY 프로토타입으로 별도 브랜치 검토(현재 `feat/invariant27-…` 브랜치와 인접 주제).

### 참고 링크
- Codex F1 trace: http://localhost:3000/project/cmodpduki0006pk0783i25je3/traces/1c126e97db60
- Claude F2 trace: http://localhost:3000/trace/5c63e0ef-1a19-49df-bd66-328aa9c0b289
