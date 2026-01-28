# Browser Demo

This example runs the README agent loop in a browser using local workspace builds.

## Run

```bash
npm install
npm run build
python3 -m http.server 5173
```

Then open http://localhost:5173/examples/basic/ in your browser.

## Notes
- The demo expects an LLM proxy at `/api/llm` (or replace the URL in the form).
- Avoid pasting personal API keys into the browser; prefer a backend proxy.
- The agent tools are scoped to the right-hand canvas via `viewRoot`, so DOM tools can see only that container.
