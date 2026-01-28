# Repository Guidelines

## Project Structure & Module Organization
This is a small monorepo with two MVP packages and a browser demo:
- `packages/core/`: agent loop, types, and OpenAI model adapter.
- `packages/tools-web/`: browser tools (JS interpreter, LocalStore).
- `examples/basic/`: demo UI (left chat, right canvas).
- `README.md`: public API and usage examples.

## Build, Test, and Development Commands
- `npm install`: installs workspace dependencies.
- `npm run build`: builds all packages; `tools-web` also regenerates tool descriptions.
- `npm test`: builds and runs tests (currently only `packages/core`).

## Coding Style & Naming Conventions
No linter or formatter is configured. Match existing examples in `README.md` (TypeScript, 2‑space indentation). Use clear, descriptive names (`createAgent`, `OpenAIModel`). Tool descriptions live in Markdown files under `packages/tools-web/descriptions/`.

## Testing Guidelines
Core tests live in `packages/core/test/` and use Node’s built‑in test runner (`node --test`). If you add tests, keep them focused on public API behavior.

## Commit & Pull Request Guidelines
Git history is minimal (e.g., “Initial commit” and a short “ic”), so there is no established convention. Use concise, imperative commit messages (e.g., “Add JS interpreter helpers”).

Pull requests should include:
- A short description of the change and its motivation.
- Links to related issues (if any).
- README updates for API or workflow changes.

## Security & Configuration Tips
Do not commit real API keys. The README example explicitly warns against passing personal keys; prefer a backend proxy or environment-based configuration.
