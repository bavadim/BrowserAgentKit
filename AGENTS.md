# Repository Guidelines

## Project Structure & Module Organization
This repo is a single package with a browser demo:
- `src/`: agent loop, model adapter, and browser tools.
- `test/`: Node test suites.
- `examples/`: demo UI (left chat, right canvas).
- `README.md`: public API and usage examples.

## Build, Test, and Development Commands
- `npm install`: installs dependencies.
- `npm run build`: builds the library to `dist/`.
- `npm test`: builds and runs tests. The `--experimental-loader` warning during tests is expected and can be ignored.
- `npm run lint`: runs ESLint.

## Coding Style & Naming Conventions
ESLint is configured; use **tabs** for indentation. Match existing examples in `README.md` and use clear, descriptive names (`createAgent`, `OpenAIModel`). Tool descriptions live near the tool definition in `src/tools.ts`.
Use explicit types on function signatures (args and return types). Helper functions should remain private inside their modules; do not create separate helper files.

## Testing Guidelines
Tests live in `test/` and use Node’s built‑in test runner (`node --test`). If you add tests, keep them focused on public API behavior.

## Commit & Pull Request Guidelines
Git history is minimal (e.g., “Initial commit” and a short “ic”), so there is no established convention. Use concise, imperative commit messages (e.g., “Add JS interpreter helpers”).

Pull requests should include:
- A short description of the change and its motivation.
- Links to related issues (if any).
- README updates for API or workflow changes.

## Security & Configuration Tips
Do not commit real API keys. The README example explicitly warns against passing personal keys; prefer a backend proxy or environment-based configuration.

## ExecPlans
When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation.

## Codding guidance

- run tests after feature has completed
- run the linter before committing changes
- update README.md whenever API, usage, or workflow changes
- commit changes in the case tests have passed
