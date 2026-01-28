# BrowserAgentKit

BrowserAgentKit is a TypeScript library for running a **code agent in the browser**.

Implemented:
- agent loop (observe → plan → act)
- **skills** (prompt-based, Markdown text)
- tools:
  - JS interpreter
  - LocalStore (persistent KV)
  - DOM XPath search + DOM patching
  - MCP tool calling

The agent API is an **async generator**: you send a text request and consume streamed events.

## Install

```bash
npm i @browser-agent-kit/core @browser-agent-kit/runtime-browser @browser-agent-kit/tools-web @browser-agent-kit/mcp
# + your model adapter package (or your own)
````

## Quick start

```ts
import { createAgent } from "@browser-agent-kit/core";
import { BrowserRuntime } from "@browser-agent-kit/runtime-browser";
import {
  jsInterpreterTool,
  localStoreTool,
  domXpathTool,
  domPatchTool,
} from "@browser-agent-kit/tools-web";
import { mcpTool } from "@browser-agent-kit/mcp";
import { OpenAIModel } from "@browser-agent-kit/model-bridge";

const model = new OpenAIModel({
  baseUrl: "/api/llm", // your backend proxy
  key: "sk-...", # DANGERUS! DO NOT PASS YOUR OWN KEY
  model: "gpt-4.1-mini",
});

const skills = [
  {
    name: "scrape.storeTitle",
    description: "Finds page title and stores it in LocalStore.",
    promptMd: `
# Goal
Read the page title and store it to LocalStore.

# Steps
1) Use DOM XPath tool to find the title (prefer //h1, fallback to <title>).
2) Store result to LocalStore under key \`page:title\`.
3) Return a short confirmation message.

# Notes
- Keep it deterministic and short.
`,
  },
];

const agent = createAgent({
  model,
  runtime: new BrowserRuntime(),
  skills,
  tools: [
    jsInterpreterTool(),
    localStoreTool({ namespace: "bak" }),
    domXpathTool(),
    domPatchTool(),
    mcpTool({ endpoint: "/mcp" }),
  ],
  policies: { maxSteps: 25 },
});

for await (const ev of agent.run("Store the current page title in LocalStore")) {
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

A tool is a JavaScript function plus **JSDoc** documentation (the most common JS/TS documentation style).
BrowserAgentKit uses the JSDoc text (and the TS types) to build tool documentation for the agent.

Example shape:

```ts
/**
 * Search DOM nodes using an XPath expression.
 *
 * @param args.xpath XPath expression (e.g. "//h1")
 * @param args.limit Max number of nodes to return.
 * @returns Matched nodes with minimal metadata (text, attributes, xpath).
 */
export async function domXpath(args: {
  xpath: string;
  limit?: number;
}): Promise<Array<{ xpath: string; text?: string; attrs?: Record<string, string> }>> {
  // implementation...
  return [];
}
```

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

