# BrowserAgentKit

BrowserAgentKit is a TypeScript library for running a **code agent in the browser**.

Implemented:
- agent loop (observe → plan → act)
- **skills** (prompt-based tools, Codex skill markdown in the DOM)
- tools:
  - JS interpreter
  - DOM helpers inside the interpreter (XPath + subtree helpers)

The agent API is an **async generator**: you send a text request and consume streamed events.

## Install

```bash
npm i browseragentkit
```

## Quick start

```ts
import OpenAI from "openai";
import * as E from "fp-ts/lib/Either.js";
import {
  createAgentMessages,
  createOpenAIResponsesAdapter,
  jsInterpreterTool,
  runAgent,
  Skill,
} from "browseragentkit";

const client = new OpenAI({
  baseURL: "/api/llm", // your backend proxy
  apiKey: "sk-...", // DANGEROUS! DO NOT PASS YOUR OWN KEY
  dangerouslyAllowBrowser: true,
});

// Somewhere in your HTML:
// <script type="text/markdown" id="skill-canvas-render">
// ---
// name: canvas.render
// description: Renders HTML inside the canvas using the JS interpreter helpers.
// ---
// # Goal
// Create or update HTML inside the canvas.
//
// # Steps
// 1) Use the JS interpreter helpers: `x()`, `replaceSubtree()`, and `viewRoot`.
// 2) Build HTML as a string and call `replaceSubtree(x("/")[0], html)`.
// 3) Return a short confirmation message.
//
// # Notes
// - Keep it deterministic and short.
// </script>

const skills = [Skill.fromDomSelector("//script[@id='skill-canvas-render']", document)];

const generate = createOpenAIResponsesAdapter({
  client,
  model: "gpt-4.1-mini",
});

const agentMessages = createAgentMessages();
const tools = [
  jsInterpreterTool(),
];
const callables = [...tools, ...skills];
const agentContext = { viewRoot: document.getElementById("canvas") };

for await (const ev of runAgent(
  agentMessages,
  generate,
  "Create a hero section on the canvas",
  callables,
  25,
  agentContext
)) {
  if (E.isLeft(ev)) {
    console.error(ev.left);
    continue;
  }
  // handle events in your UI / logs
  console.log(ev.right);
}
```

`generate(messages, tools, signal)` must return (or resolve to) an `AsyncIterable` of `Either<Error, AgentEvent>` objects. When using the OpenAI Responses stream, you can reuse `createOpenAIResponsesAdapter` from the library (see above or `examples/main.js`).
The agent preserves conversation history across runs; create a fresh `createAgentMessages()` array to clear it (system prompt is kept).
If `runAgent()` is called again with the same messages array, the previous run is aborted.

## Skills

A skill is a **tool** that runs the LLM with a Markdown prompt stored in the DOM.
Store prompts in a script tag (or any DOM element) as **Codex skill markdown** (YAML frontmatter + body)
and pass an XPath selector:

```html
<script type="text/markdown" id="skill-example">
---
name: example.skill
description: One-line description (optional but recommended).
---
# Goal
...

# Steps
1) ...
2) ...

# Output
- What the agent should return.
</script>

<script type="text/markdown" id="skill-subskill">
---
name: example.subskill
description: Nested skill (only available inside this skill).
---
# Goal
...
</script>
```

```ts
const skills = [
  Skill.fromDomSelector("//script[@id='skill-example']", document)
    // Optional: scope what the skill can call.
    .withCallables([
      jsInterpreterTool(),
      Skill.fromDomSelector("//script[@id='skill-subskill']", document),
    ]),
];
```

The agent exposes each skill as a function-calling tool. When a skill runs, the agent:
- Builds a child cycle from scratch (base system prompt → skill prompt → optional history → task).
- Sanitizes the skill prompt to Markdown-only.
- Makes only the skill's `callables` available to the child cycle.
The skill tool arguments are `{ task: string; history?: EasyInputMessage[] }`.
At the start of each root cycle, the agent injects a system message listing available tools and skills. If the user mentions `$name`, it is treated as a suggestion.

## Tools

A tool is an instance of the `Tool` class: name, description, action, and **input/output schemas**.
Keep the description near the tool definition (in `src/tools.ts`).

```ts
import { Tool } from "browseragentkit";

const echoTool = new Tool(
  "echo",
  "Echo the input.",
  (args) => args,
  {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  { type: "object", description: "Echoed args." }
);
```

Built-in tools:
- `jsInterpreterTool` (runs JS with DOM helpers + jQuery)
- `jsRunTool` (same as above, with explicit jQuery guidance)
- `domSummaryTool`
- `domSubtreeHtmlTool`
- `domAppendHtmlTool`
- `domRemoveTool`
- `domBindEventTool`

If you load the demo via plain `importmap`, add jQuery:

```html
<script type="importmap">
{
  "imports": {
    "browseragentkit": "../dist/index.js",
    "openai": "../node_modules/openai/index.mjs",
    "jquery": "../node_modules/jquery/dist/jquery.min.js"
  }
}
</script>
```

You don’t call tools directly: you **pass tools and skills into the agent as one callables list**, and the agent calls them when needed.

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

`runAgent(messages, generate, input, callables?, maxSteps?, context?, signal?)` returns an async generator of `Either<Error, AgentEvent>`.

Typical event kinds:

* `message` (agent text)
* `thinking.delta` / `thinking` (reasoning summary text, when available)
* `tool.start` / `tool.end`
* `artifact`
* `done`

Consume it with:

```ts
const agentMessages = createAgentMessages();

for await (const ev of runAgent(agentMessages, generate, "...")) {
  if (E.isLeft(ev)) {
    console.error(ev.left);
    break;
  }
  // update UI / state
}

If you want status events, wrap the stream:

```ts
import { withStatus } from "browseragentkit";

for await (const ev of withStatus(runAgent(agentMessages, generate, "..."))) {
  if (E.isLeft(ev)) {
    console.error(ev.left);
    break;
  }
  if (ev.right.type === "status") {
    console.log(ev.right.status);
  }
}
```
```
