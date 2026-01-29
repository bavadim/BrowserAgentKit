# Agent Loop Plan (Skills + Child Cycles)

## Goals
- Add skill-aware child cycles with clean message construction and scoped skills/tools.
- Enforce minimal, explicit runtime validation for skill prompts and skill call args.
- Extend AgentEvent tool events for skills without introducing new event types.
- Keep the API surface minimal and rely on TypeScript where possible.

## Non-Goals (for this phase)
- No maxSteps/timeout changes.
- No compacting/memory budget enforcement (only TODO in Optional Extensions).
- No new event types; only extend existing tool events.

## Current State (types.ts summary)
- `Skill` only includes `name`, `description`, `promptSelector`.
- `AgentEvent` tool events have no skill metadata.
- No `SkillCallArgs` type or runtime validation.

---

## Proposed Type Shapes (concrete)

### SkillCallArgs
```ts
export type SkillCallArgs = {
	task: string;
	history?: EasyInputMessage[];
};
```

### Skill
```ts
export type Skill = {
	name: string;
	description?: string;
	promptSelector: string;
	allowedSkills?: Skill[];
	tools?: Tool[];
};
```

### AgentEvent (tool.start / tool.end)
Keep the same event types, extend tool events with a discriminated union on `isSkill`:

```ts
type ToolStartBase = {
	type: "tool.start";
	name: string;
	args: unknown;
	callId?: string;
};

type SkillToolStart = ToolStartBase & {
	isSkill: true;
	depth: number;
	input: SkillCallArgs;
};

type ToolStart = ToolStartBase | (ToolStartBase & { isSkill?: false }) | SkillToolStart;

// For end events, include isSkill/depth if start was a skill
// (result remains unknown; input not required on end)

type ToolEndBase = {
	type: "tool.end";
	name: string;
	result: unknown;
};

type SkillToolEnd = ToolEndBase & {
	isSkill: true;
	depth: number;
};

type ToolEnd = ToolEndBase | (ToolEndBase & { isSkill?: false }) | SkillToolEnd;
```

Then update `AgentEvent` to use `ToolStart` and `ToolEnd` in its union.

---

## Module Changes (What to Do, Where)

### 1) `src/types.ts`
- Add `SkillCallArgs` and (optionally) `SkillHistoryMessage` alias to `EasyInputMessage`.
- Extend `Skill` with `allowedSkills?: Skill[]` and `tools?: Tool[]`.
- Extend `AgentEvent` union for `tool.start` and `tool.end` to support `isSkill`, `depth`, and `input`.

### 2) `src/agent.ts`
#### Skill list system message (root cycles)
- Build a **root skill list system message** from skill `name + description` only.
- Insert it as the **second system message** on `runLoop` entry (after base agent prompt).
- Do **not** include skill prompt text in root list.
- If no skills exist, do not insert it.

#### Child cycle message construction
On skill call:
1. Resolve skill prompt from DOM.
2. Sanitize to markdown-only (strip HTML/script).
3. If sanitized prompt is empty → throw error (see below for timing).
4. Parse and validate skill call args → `SkillCallArgs`.
5. Build child history **from scratch**, ignoring parent history:
	- `system`: base agent prompt.
	- `system`: skill prompt + allowed subskills list (name + description).
	- optional `history` messages from args.
	- `user`: `task` from args.
6. Call `runLoop` with child history and tool list restricted to `skill.tools`.

#### Skill prompt sanitization
- Add a small sanitizer in `agent.ts`:
	- Strip HTML/script tags; preserve markdown text.
	- If sanitized prompt is empty → error.
- Throw error at **skill invocation time** (constructor-only error is not feasible without DOM).

#### Skill call args validation
- Add runtime validation: `task` must be a string; `history` must be an array of `EasyInputMessage` if present.
- If invalid, emit `error` and do not enter child cycle.

#### Skill event metadata
- For skill tool calls, set:
	- `isSkill: true`
	- `depth: 1` at root skill call, increment by 1 for nested skill calls.
	- `input: SkillCallArgs` on `tool.start` only.

### 3) `test/agent.test.js`
Add tests from the updated plan (see “Tests” section below), in particular:
- Skill prompt sanitization and empty prompt error.
- Skill call args validation and history splitting.
- Root/child message ordering.
- Skill/tool scoping.
- Event metadata (`isSkill`, `depth`, `input`).

---

## Tests (Updated Set)
(Keep existing tests; add the following)

### Message Ordering & Child History
- Root order: system(agent) → system(skills list) → user.
- Root list excludes skill prompts.
- Child order: system(agent) → system(skill prompt + subskills) → [history?] → user(task).
- Child excludes parent conversation and parent `function_call`.

### Skill Args
- Invalid args → error, no child cycle.
- `history` + `task` split into child history correctly.

### Prompt Sanitizing
- HTML/script stripped; markdown preserved.
- Empty after sanitize → error (on skill call).

### Scoping
- Child tools restricted to `skill.tools`.
- Child skills restricted to `skill.allowedSkills`.

### Events & Status
- Skill tool events include `isSkill`, `depth`, `input`.
- Status events still emit (no extra fields required).

### TODO
- Compact/memory fraction test (deferred).

---

## Type System Coverage vs Tests
- **TypeScript covers**: `SkillCallArgs` shape; `Skill` fields; event payload shape for skill tool events.
- **Runtime tests cover**: prompt sanitization and empty-prompt errors; invalid LLM args; message ordering; child scoping; event metadata and status emissions.

---

## Definition of Done (DoD)
- `src/types.ts` updated with new types and event unions.
- `src/agent.ts`:
	- root skill list system message inserted correctly;
	- child history built from scratch with skill prompt + subskills + task;
	- prompt sanitization and args validation implemented;
	- skill tool events include `isSkill`, `depth`, `input`.
- Tests added/updated; `npm test` passes.
- No new event types introduced.
- No changes to maxSteps/timeout.

---

## Optional Extensions
- TODO (compact): dialogue length must not exceed a configured fraction of available memory.

---

# Refactor Ideas (Agent Simplification)

## Scope (include)
1. **Make runLoop a pure “machine”**
	- Move side-effect helpers (tool call tracking, prompt insertion, tool output) into a separate module (e.g. `loop.ts`).
	- Shape: `step(state, input) -> { state, outputs }` and `drive(generate, state) -> Stream`.

2. **Remove AgentStatus from core**
	- Keep core agent streaming only `message/tool/artifact`.
	- Move status emission to a wrapper/middleware around `runAgent`.

3. **Extract tool/skill execution**
	- Move `runToolCall` + `runSkill` into `tool.ts` / `skill.ts`.
	- `runLoop` becomes: resolve target → execute → append outputs.

4. **Unify Either stream handling**
	- Introduce a single combinator like `liftEitherStream` to short-circuit on `Left`.
	- Replace all per-loop `foldStreamEvent/stopWithError` patterns with one helper.

6. **Contract: generate never throws**
	- Make `AgentGenerate` return only `Either` (no exceptions).
	- Remove `safeGenerate`/`safeStream` entirely.

## Out of Scope (explicitly excluded)
5. Simplify message types / create a new `AgentMessage` type.
7. Merge `runLoop` + `runAgent` into one generator.

---

# Plan: Merge `runLoop` + `runAgent`

## Goals
- Collapse the two generators into a single `runAgent` stream that owns both root-loop lifecycle and step iteration.
- Keep arguments flat and preserve current behavior: abort on superseded runs, tool/skill execution, skill-list system insertion, and end-of-run `done`.
- Preserve current event stream contract (`Either<Error, AgentEvent>`); no new event types.

## Design Notes
- `runAgent` becomes the only exported generator; internal helpers remain in `loop.ts` and `execute.ts`.
- `runAgent` holds the loop `while (step < maxSteps)` and per-step `LoopState`.
- The previous `runLoop` responsibilities split as:
	- **Message construction + root context** stays at top of `runAgent`.
	- **Per-step stream handling** uses `applyStreamEvent`/`flushThinking`/`finalContent`.
	- **Tool/skill execution** via `runToolCall` from `execute.ts`.
- Child cycle: replace recursive `runLoop` calls with a recursive call to `runAgentInternal` (a non-exported function) or a local `runSubAgent` inner generator to avoid re-doing root wiring (signals, activeRuns). Use flat args.

## Steps (Concrete)
1. **Introduce internal generator** in `src/agent.ts`:
	- `async function* runAgentInternal(messages, signal, ctx, tools, skills, skillDepth, skillListMessage, maxSteps, generate)`
	- This is the merged loop body (what `runLoop` did), but owned by `runAgent`.
2. **Update `runAgent`**:
	- Builds root `messages`, `rootSkillListMessage`, context, abort logic, then `yield* runAgentInternal(...)`.
	- After the internal stream ends, emit `done` if no error was seen.
3. **Update `runToolCall`** in `src/execute.ts`:
	- Accept a function parameter `runAgentInternal` (or `runSubAgent`) to call for skills instead of `runLoop`.
	- Rename parameter to reflect new shape and keep flat args.
4. **Remove `runLoop`**:
	- Delete exported/local `runLoop` function and related types (`RunLoop` in `execute.ts`), replacing with `RunAgentInternal` type.
5. **Tests**:
	- Ensure existing tests pass (no new behavior).
	- Add one regression test: runAgent uses one generator path for both root + child (e.g., assert `runAgentInternal` is used by checking child calls still work and no duplicate root setup).

## DoD
- Only one exported generator (`runAgent`) in `src/agent.ts`.
- `execute.ts` no longer references `runLoop`; uses `runAgentInternal` (or similar) for skills.
- All tests and lint pass.
