# PRD: Static skill loader for Codex markdown files

## 1) Background
Today we support skills loaded from DOM via `Skill.fromDomSelector(...)`. Many apps keep Codex skills as `.md` files in the repo and want to bundle them at build time. We need a static loader path that is idiomatic for modern build tools and keeps runtime headless.

## 2) Goals
- Load Codex skill markdown from local `.md` files at build time.
- Provide a simple runtime API for turning markdown strings into `Skill` objects.
- Offer a build-time integration ("loader") that is easy to configure.
- Keep runtime bundle browser-safe (no `fs`, no Node APIs).
- Preserve the existing DOM loader and API.

## 3) Non-goals
- Remote fetching of skills at runtime.
- A full skill registry or auto-reload server.
- Multi-theme or markdown rendering for the UI.

## 4) Target users
- Apps that store Codex skills as markdown files in their repo.
- Developers who want to ship skills in a browser bundle.

## 5) Success criteria
- A developer can import a folder of skills and get a `Skill[]` with one call.
- Works with Vite out of the box; other bundlers have a documented path.
- Skill parsing and validation errors are surfaced with file context.

## 6) Proposed API surface (draft)
Single package with optional build subpath. No extra npm packages.

### Runtime exports (core)
- `Skill.fromMarkdown(markdown: string, sourceName?: string): Skill`
- `loadSkillsFromModules(modules: Record<string, string>): Skill[]`

### Build-time exports (dev only)
- `browseragentkit/skills/vite` → `codexSkillPlugin()`
- (optional later) `browseragentkit/skills/rollup`
- (optional later) `browseragentkit/skills/webpack`

## 7) Recommended flow (idiomatic)
### Vite (preferred)
```ts
// vite.config.ts
import { defineConfig } from "vite";
import { codexSkillPlugin } from "browseragentkit/skills/vite";

export default defineConfig({
	plugins: [codexSkillPlugin()],
});
```

```ts
// app code
import { loadSkillsFromModules } from "browseragentkit";

const modules = import.meta.glob("./skills/**/*.skill.md", {
	as: "raw",
	eager: true,
});

const skills = loadSkillsFromModules(modules);
```

### Bundler-agnostic fallback
```ts
import { Skill, loadSkillsFromModules } from "browseragentkit";

const markdowns: Record<string, string> = {
	"./skills/foo.skill.md": "---\nname: foo\n---\n# Goal\n...",
};

const skills = loadSkillsFromModules(markdowns);
// or Skill.fromMarkdown(markdown, "./skills/foo.skill.md")
```

## 8) Loader behavior (draft)
- Accept only files with `.skill.md` suffix (avoid collisions with docs).
- The plugin does not parse YAML; it only ensures raw content is importable.
- Parsing/validation happens in runtime `Skill.fromMarkdown` with better errors.
- Errors include `sourceName` when available.

## 9) DOM-backed resources (minimal change path)
To keep browser-only runtime and minimize changes:
- Use `script[type=\"text/plain\"]` for skill resources (prompt + references + scripts).
- Reuse existing `Skill.fromDomSelector(...)` by pointing it at injected DOM nodes.
- No new tools required: `domSubtreeHtmlTool` can read nodes by selector if needed.

### DOM mapping (decisions)
The Vite plugin can inject a hidden container:
```
<div id="bak-skills-root" hidden>
  <script type="text/plain" data-skill="canvas.render" data-kind="prompt" data-path="SKILL.md">
    ...SKILL.md contents...
  </script>
  <script type="text/plain" data-skill="canvas.render" data-kind="reference" data-path="references/guide.md">
    ...reference markdown...
  </script>
  <script type="text/plain" data-skill="canvas.render" data-kind="script" data-path="scripts/foo.js">
    ...js code as text...
  </script>
</div>
```

Decisions:
- Container id: `bak-skills-root`.
- `data-skill`: value from frontmatter `name`.
- `data-kind`: `prompt | reference | script`.
- `data-path`: relative to the skill folder (e.g. `SKILL.md`, `references/x.md`).
- Use `script[type="text/plain"]` only (no `<template>`).

### Runtime usage (draft)
- Load skill prompt via `Skill.fromDomSelector(...)`.
- If the agent needs extra text, it can read the node’s text via existing DOM tools.
- Script execution remains explicit via `jsInterpreterTool` / `jsRunTool` using the extracted text.

### Plugin API (decisions)
`codexSkillPlugin(options?)`
- `root`: string (default `"./skills"`)
- `mode`: `"dom" | "raw"` (default `"dom"`)
- `include`: `{ references?: boolean; scripts?: boolean }` (default `{ references: true, scripts: true }`)
- `extensions`: `{ skillFile?: string }` (default `"SKILL.md"`)

Behavior:
- Scans `root/**/SKILL.md`.
- In `dom` mode, injects the container into `index.html` (append before `</body>`).
- In `raw` mode, exposes a virtual module `browseragentkit/skills` that exports a map of `{ [path]: string }`.

## 10) Error handling
- Empty file → error with file path.
- Missing `name` in frontmatter → error with file path.
- Invalid frontmatter line → error with file path.
- Sanitized prompt empty → existing error path preserved.

## 11) Implementation plan
### Phase 0 — API
- Add `Skill.fromMarkdown(markdown, sourceName?)` using existing parser.
- Add `loadSkillsFromModules(modules)` helper (order deterministic by path).

### Phase 1 — build integration (Vite)
- Add `skills/vite` subpath that exports a Vite plugin.
- Plugin supports two modes:
	- `raw` mode: user imports via `import.meta.glob(..., { as: "raw" })`
	- `dom` mode: plugin injects `script[type=\"text/plain\"]` nodes into HTML
- Document both modes; recommend `dom` for full Codex skill folder support.

### Phase 2 — docs and demo
- Add README section: “Static skills from files.”
- Add small example in `examples/` or docs (no runtime change required).

## 12) Open questions
- Should `loadSkillsFromModules` accept async module maps?
- Do we want to export `loadSkillsFromGlob` helper for Vite only?
- Do we add Rollup/Webpack plugins now or later?

## 13) Out of scope for v1
- Hot reload of skills in production builds.
- JSON/YAML skill formats.
- Nested skill folder conventions or registry manifests.
