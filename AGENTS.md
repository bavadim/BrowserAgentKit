# Repository Guidelines

## Project Structure & Module Organization
This repository currently contains documentation and package metadata only:
- `README.md` documents the BrowserAgentKit API and usage examples.
- `package.json` defines the npm package and scripts.
- `LICENSE` contains licensing terms.

There is no `src/` or `test/` directory yet. If you add code, keep it organized under `src/` (library entry points) and `test/` (unit/integration tests), and update the README accordingly.

## Build, Test, and Development Commands
- `npm install`: installs package dependencies.
- `npm test`: currently exits with an error because tests are not configured (see `package.json`).

If you introduce build or dev commands (for example `npm run build` or `npm run lint`), add them to `package.json` and document them here with a one‑line explanation.

## Coding Style & Naming Conventions
No linter or formatter is configured. Match existing examples in `README.md` (TypeScript, 2‑space indentation). Use clear, descriptive names (`createAgent`, `BrowserRuntime`) and keep API docs in JSDoc style, as shown in the README tool example.

## Testing Guidelines
Testing is not set up yet. If you add tests, document the framework, add a working `npm test`, and place files under `test/` (for example `test/agent.test.ts`). Keep tests focused on public API behavior.

## Commit & Pull Request Guidelines
Git history is minimal (e.g., “Initial commit” and a short “ic”), so there is no established convention. Use concise, imperative commit messages (e.g., “Add browser runtime adapter”).

Pull requests should include:
- A short description of the change and its motivation.
- Links to related issues (if any).
- README updates for API or workflow changes.

## Security & Configuration Tips
Do not commit real API keys. The README example explicitly warns against passing personal keys; prefer a backend proxy or environment-based configuration.

# ExecPlans
When writing complex features or significant refactors, use an ExecPlan (as described in .agent/PLANS.md) from design to implementation.
