import { createAgent } from "@browser-agent-kit/core";
import { BrowserRuntime } from "@browser-agent-kit/runtime-browser";
import {
  localStoreTool,
  domXpathTool,
  domPatchTool,
} from "@browser-agent-kit/tools-web";
import { mcpTool } from "@browser-agent-kit/mcp";
import { OpenAIModel } from "@browser-agent-kit/model-bridge";

const logEl = document.getElementById("log");
const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const canvas = document.getElementById("canvas");

function log(line) {
  if (!logEl) {
    return;
  }
  logEl.textContent += `${line}\n`;
}

function addMessage(role, text) {
  if (!chatLog) {
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  chatLog.appendChild(wrapper);
  chatLog.scrollTop = chatLog.scrollHeight;
}

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

runBtn.addEventListener("click", async () => {
  if (!canvas) {
    addMessage("assistant", "Canvas element not found.");
    return;
  }
  if (logEl) {
    logEl.textContent = "";
  }

  const baseUrl = document.getElementById("baseUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  const prompt = document.getElementById("prompt").value.trim();

  if (!prompt) {
    return;
  }

  addMessage("user", prompt);
  runBtn.disabled = true;

  const model = new OpenAIModel({
    baseUrl,
    key: apiKey || undefined,
    model: "gpt-4.1-mini",
  });

  const runtime = new BrowserRuntime({ viewRoot: canvas });

  const agent = createAgent({
    model,
    runtime,
    skills,
    tools: [
      localStoreTool({ namespace: "bak" }),
      domXpathTool(),
      domPatchTool(),
      mcpTool({ endpoint: "/mcp" }),
    ],
    policies: { maxSteps: 25 },
  });

  try {
    for await (const ev of agent.run(prompt)) {
      log(JSON.stringify(ev, null, 2));
      if (ev.type === "message") {
        addMessage("assistant", ev.content);
      }
      if (ev.type === "error") {
        addMessage("assistant", `Error: ${String(ev.error)}`);
      }
    }
  } catch (error) {
    addMessage("assistant", `Error: ${String(error)}`);
  } finally {
    runBtn.disabled = false;
  }
});
