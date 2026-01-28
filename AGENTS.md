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
- `npm test`: builds and runs tests.

## Coding Style & Naming Conventions
No linter or formatter is configured. Match existing examples in `README.md` (TypeScript, 2‑space indentation). Use clear, descriptive names (`createAgent`, `OpenAIModel`). Tool descriptions live in `src/descriptions.ts`.

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
- commit changes in the case tests have passed
