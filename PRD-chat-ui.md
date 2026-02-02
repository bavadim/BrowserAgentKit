# PRD: Chat UI package extraction

## 1) Background
The demo in `examples/` embeds a chat panel (left) tightly coupled to the demo page and agent loop. The goal is to keep the repo simple and still publish a reusable GUI component to npm as a small, focused “feature package.”

## 2) Goals
- Keep a single npm package for core + UI with an optional UI subpath.
- Preserve the current demo UX with minimal behavioral changes.
- Make the chat UI usable by other apps without pulling the full demo code.

## 3) Non-Goals
- Rewriting the agent loop or model adapter API.
- Introducing a large framework or full design system.
- Building a multi-theme or highly customizable UI system.
- Creating a new runtime for tools or skills.

## 4) Target users
- Developers using BrowserAgentKit who want a ready-made chat panel.
- Demo builders who need a simple, branded chat area without heavy dependencies.

## 5) Success criteria
- The demo app uses the new package with no visible UX regressions.
- The chat UI package can be installed independently from npm and used in a separate project.
- Clear, minimal API: set of functions or a single class to render and drive the chat.
- Documentation added to `README.md` and a dedicated package README.

## 6) Functional requirements
- Render a chat log with user and assistant bubbles.
- Support streaming assistant deltas and finalize assistant messages.
- Support status messages (thinking, calling tool, tool result) with a “status” style.
- Auto-scroll to bottom on updates.
- Provide functions for:
	- append user message
	- append assistant delta
	- finalize assistant message
	- set status
	- set thinking summary
	- clear input (optional, caller-driven)
- Allow attaching to an existing DOM container (no Shadow DOM).
- Avoid dependencies on framework (React/Vue/etc.).

## 7) Non-functional requirements
- Small footprint and tree-shakeable where possible.
- No runtime dependency on the core agent loop.
- TypeScript types exported.
- Compatible with modern browsers (same baseline as demo).

## 8) Proposed API surface (draft)
Package name: `browseragentkit` (single package), UI exposed via subpath export.

### Exports
- `browseragentkit` (core, headless)
- `browseragentkit/ui` (UI-only)
- `createChatUi(options): ChatUiController` (from `browseragentkit/ui`)

### Types (draft)
- `ChatUiOptions`
	- `container: HTMLElement`
	- `initialMessages?: Array<{ role: "user" | "assistant"; text: string }>`
	- `statusLabels?: Partial<{ thinking: string; callingTool: string; toolResult: string }>`
- `ChatUiController`
	- `addUserMessage(text: string): void`
	- `appendAssistantDelta(delta: string): void`
	- `finalizeAssistantMessage(text?: string): void`
	- `setStatus(status: ChatStatus | null): void`
	- `setThinkingSummary(summary: string): void`

### Status model (draft)
- `ChatStatus`
	- `{ kind: "thinking"; label?: string }`
	- `{ kind: "calling_tool"; toolName?: string; label?: string }`
	- `{ kind: "tool_result"; toolName?: string; label?: string }`
	- `{ kind: "done" }`

## 9) Packaging & repo structure
Single package with optional UI subpath. No monorepo tooling required.

### Exports layout (draft)
```
browseragentkit           -> dist/index.js (core)
browseragentkit/ui        -> dist/ui/index.js (chat UI)
```

### Build layout (draft)
- `src/` (core)
- `src/ui/` (chat UI only, no core imports)
- `dist/` mirrors structure for `exports`

### `package.json` exports (draft)
```
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./ui": { "types": "./dist/ui/index.d.ts", "default": "./dist/ui/index.js" }
}
```

## 10) Migration plan (demo)
### Phase 0 — prep
- Add `src/ui/` and `src/ui/index.ts`.
- Define types in `src/types.ts` for UI options/status/controller.
- Add `exports` subpath in `package.json` for `./ui`.

### Phase 1 — extract UI
- Move chat DOM logic from `examples/main.js` into `src/ui/chat-ui.ts` (or similar).
- Ensure UI code is DOM-only (no core imports, no agent dependencies).
- Export `createChatUi` from `src/ui/index.ts`.

### Phase 2 — update demo
- Replace inline chat DOM logic in `examples/main.js` with `createChatUi(...)`.
- Keep input handling (Enter+Shift), errors, and agent loop wiring in demo.
- Wire existing status/thinking events to the UI controller methods.

### Phase 3 — build & verify
- Run `npm run build` and ensure both `dist/index.*` and `dist/ui/index.*` are produced.
- Run `npm test` (agent + UI should not change test behavior).
- Run `npm run dev` to visually verify no UX regressions.

### Phase 4 — docs
- Update root `README.md` with `browseragentkit/ui` usage snippet.
- Document CSS expectations and minimal HTML structure in UI README.

## 11) Documentation changes
- Update root `README.md` with:
	- Install/use snippet for `@browseragentkit/chat-ui`.
	- Mention that the demo uses the chat-ui package.
- Add `packages/chat-ui/README.md`:
	- minimal usage, API, and CSS expectations.

## 12) Risks & open questions
- Styling ownership: should UI ship default CSS or expect consumer to import?
- Backward compatibility: ensure demo build still works with current `vite` setup.

## 13) Out of scope for v1
- Themes, message markdown rendering, rich media, attachments.
- Persisting chat history or state sync.
- Multi-tab or multi-session support.
