# BrowserAgentKit

BrowserAgentKit is a TypeScript library for running a **code agent in the browser**.

Implemented:
- agent loop (observe → plan → act)
- **skills** (prompt-based, Markdown text)
- tools:
  - JS interpreter
  - LocalStore (persistent KV)
  - DOM helpers inside the interpreter (XPath + subtree helpers)

The agent API is an **async generator**: you send a text request and consume streamed events.

## Install

```bash
npm i browseragentkit
```

## Quick start

```ts
import OpenAI from "openai";
import { createAgent, jsInterpreterTool, localStoreTool } from "browseragentkit";

const client = new OpenAI({
  baseURL: "/api/llm", // your backend proxy
  apiKey: "sk-...", // DANGEROUS! DO NOT PASS YOUR OWN KEY
  dangerouslyAllowBrowser: true,
});

const skills = [
  {
    name: "canvas.render",
    description: "Renders HTML inside the canvas using the JS interpreter helpers.",
    promptMd: `
# Goal
Create or update HTML inside the canvas.

# Steps
1) Use the JS interpreter helpers: \`x()\`, \`replaceSubtree()\`, and \`viewRoot\`.
2) Build HTML as a string and call \`replaceSubtree(x("/")[0], html)\`.
3) Return a short confirmation message.

# Notes
- Keep it deterministic and short.
`,
  },
];

const agent = createAgent({
  generate: async function* (messages, tools, signal) {
    const stream = await client.responses.create(
      {
        model: "gpt-4.1-mini",
        input: messages,
        tools,
        tool_choice: tools?.length ? "auto" : undefined,
        stream: true,
      },
      signal ? { signal } : undefined
    );
    const toolArgBuffers = new Map();
    for await (const event of stream) {
      switch (event.type) {
        case "response.output_text.delta":
          yield { type: "message.delta", delta: event.delta };
          break;
        case "response.output_text.done":
          yield { type: "message", content: event.text };
          break;
        case "response.reasoning_summary_text.delta":
          yield { type: "thinking.delta", delta: event.delta };
          break;
        case "response.reasoning_summary_text.done":
          yield { type: "thinking", summary: event.text };
          break;
        case "response.function_call_arguments.delta": {
          const existing = toolArgBuffers.get(event.item_id) ?? "";
          toolArgBuffers.set(event.item_id, existing + event.delta);
          break;
        }
        case "response.function_call_arguments.done": {
          const args = event.arguments ?? toolArgBuffers.get(event.item_id) ?? "";
          if (event.name) {
            yield { type: "tool.start", name: event.name, args, callId: event.item_id };
          }
          break;
        }
        case "response.failed":
        case "error":
          yield { type: "error", error: event.error ?? new Error("Response failed") };
          break;
      }
    }
  },
  viewRoot: document.getElementById("canvas"),
  skills,
  tools: [
    jsInterpreterTool(),
    localStoreTool({ namespace: "bak" }),
  ],
  policies: { maxSteps: 25 },
});

for await (const ev of agent.run("Create a hero section on the canvas")) {
  // handle events in your UI / logs
  console.log(ev);
}
```

`generate(messages, tools, signal)` must return (or resolve to) an `AsyncIterable` of `AgentEvent` objects. When using the OpenAI Responses stream, map its events into AgentEvents inside `generate` (see above or `examples/main.js`).
The agent preserves conversation history across runs; call `agent.reset()` to clear it (system prompt is kept).
If `run()` is called while a run is already active, the call is ignored.

## Skills

A skill is a **Markdown prompt** registered in the agent constructor:

```ts
const skills = [
  {
    name: "example.skill",
    description: "One-line description (optional but recommended).",
    promptMd: `
# Goal
...

# Steps
1) ...
2) ...

# Output
- What the agent should return.
`,
  },
];
```

The agent selects and executes skills inside the agent loop.

## Tools

A tool is a JavaScript function plus a **separate Markdown description** that is sent to the model.
Keep the description near the tool definition (in `src/tools.ts`).

You don’t call tools directly: you **pass tools into the agent**, and the agent calls them when needed.

## Demo

```bash
npm install
npm run build
python3 -m http.server 5173
```

Then open http://localhost:5173/examples/ in your browser.

### Dev (hot reload)

```bash
npm install
npm run dev
```

Vite will open the demo and refresh on source changes.

### URL presets

You can prefill demo fields via query params:

```
?baseUrl=https://...&apiKey=sk-...&message=Hello
```

## Agent API (async generator)

`agent.run(input: string)` returns an async generator of events.

Typical event kinds:

* `message` (agent text)
* `thinking.delta` / `thinking` (reasoning summary text, when available)
* `tool.start` / `tool.end`
* `artifact`
* `error`
* `done`

Consume it with:

```ts
for await (const ev of agent.run("...")) {
  // update UI / state
}
```
