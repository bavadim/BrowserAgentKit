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
import { createAgent, OpenAIModel, jsInterpreterTool, localStoreTool } from "browseragentkit";

const model = new OpenAIModel({
  baseURL: "/api/llm", // your backend proxy
  apiKey: "sk-...", // DANGEROUS! DO NOT PASS YOUR OWN KEY
  model: "gpt-4.1-mini",
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
  model,
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
Keep the description near the tool definition (in `src/index.ts`).

You don’t call tools directly: you **pass tools into the agent**, and the agent calls them when needed.

## Agent API (async generator)

`agent.run(input: string)` returns an async generator of events.

Typical event kinds:

* `message` (agent text)
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
