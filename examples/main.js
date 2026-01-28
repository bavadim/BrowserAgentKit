import OpenAI from "openai";
import { createAgent, jsInterpreterTool, localStoreTool } from "browseragentkit";

const logEl = document.getElementById("log");
const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const canvas = document.getElementById("canvas");
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const promptInput = document.getElementById("prompt");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");

const params = new URLSearchParams(window.location.search);
if (baseUrlInput && params.has("baseUrl")) {
	baseUrlInput.value = params.get("baseUrl") ?? "";
}
if (apiKeyInput && params.has("apiKey")) {
	apiKeyInput.value = params.get("apiKey") ?? "";
}
if (promptInput && params.has("message")) {
	promptInput.value = params.get("message") ?? "";
}

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

let activeAssistantBubble = null;
let activeAssistantText = "";

function ensureAssistantBubble() {
	if (!chatLog) {
		return null;
	}
	if (!activeAssistantBubble) {
		const wrapper = document.createElement("div");
		wrapper.className = "message assistant";
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		wrapper.appendChild(bubble);
		chatLog.appendChild(wrapper);
		activeAssistantBubble = bubble;
		activeAssistantText = "";
		chatLog.scrollTop = chatLog.scrollHeight;
	}
	return activeAssistantBubble;
}

function appendAssistantDelta(delta) {
	const bubble = ensureAssistantBubble();
	if (!bubble) {
		return;
	}
	activeAssistantText += delta;
	bubble.textContent = activeAssistantText;
}

function finalizeAssistantMessage(text) {
	if (text) {
		const bubble = ensureAssistantBubble();
		if (bubble) {
			bubble.textContent = text;
		}
	}
	activeAssistantBubble = null;
	activeAssistantText = "";
}

function formatStatus(status) {
	switch (status.kind) {
		case "thinking":
			return "Думаю...";
		case "calling_tool":
			return status.toolName ? `Вызываю ${status.toolName}...` : "Вызываю инструмент...";
		case "tool_result":
			return status.toolName ? `Получен ответ от ${status.toolName}.` : "Получен ответ от инструмента.";
		case "error":
			return "Ошибка.";
		case "done":
		default:
			return "";
	}
}

function setStatus(status) {
	if (!statusEl || !statusTextEl) {
		return;
	}
	const label = formatStatus(status);
	if (!label) {
		statusEl.classList.add("hidden");
		statusTextEl.textContent = "";
		return;
	}
	statusTextEl.textContent = label;
	statusEl.classList.remove("hidden");
}

const skills = [
	{
		name: "canvas.render",
		description: "Renders HTML into the right-side canvas using the JS interpreter helpers.",
		promptMd: `
# Goal
Create or update HTML inside the canvas.

# Steps
1) Use the JS interpreter. It provides \`x()\`, \`replaceSubtree()\`, \`diffSubtree()\`, and \`viewRoot\`.
2) Build HTML as a string and call \`replaceSubtree(x("/")[0], html)\` to replace the canvas content.
3) Keep the response short and confirm what changed.

# Notes
- The agent can only see the canvas subtree.
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

	const baseUrl = baseUrlInput.value.trim();
	const apiKey = apiKeyInput.value.trim();
	const prompt = promptInput.value.trim();

	if (!prompt) {
		return;
	}

	addMessage("user", prompt);
	runBtn.disabled = true;
	activeAssistantBubble = null;
	activeAssistantText = "";
	if (statusEl) {
		statusEl.classList.add("hidden");
	}

	const client = new OpenAI({
		baseURL: baseUrl,
		apiKey: apiKey || undefined,
		dangerouslyAllowBrowser: true,
	});

	const agent = createAgent({
		generate: ({ messages, tools, signal }) =>
			client.responses.create(
				{
					model: "gpt-4.1-mini",
					input: messages,
					tools,
					tool_choice: tools?.length ? "auto" : undefined,
					stream: true,
				},
				signal ? { signal } : undefined
			),
		viewRoot: canvas,
		skills,
		tools: [jsInterpreterTool(), localStoreTool({ namespace: "bak" })],
		policies: { maxSteps: 25 },
	});

	try {
		for await (const ev of agent.run(prompt)) {
			log(JSON.stringify(ev, null, 2));
			if (ev.type === "message.delta") {
				appendAssistantDelta(ev.delta);
			}
			if (ev.type === "message") {
				finalizeAssistantMessage(ev.content);
				addMessage("assistant", ev.content);
			}
			if (ev.type === "status") {
				setStatus(ev.status);
			}
			if (ev.type === "error") {
				if (ev.error instanceof Error) {
					console.error(ev.error);
				} else {
					console.error(new Error(String(ev.error)));
				}
				if (ev.error && typeof ev.error === "object" && "stack" in ev.error && ev.error.stack) {
					console.error(ev.error.stack);
				}
				addMessage("assistant", `Error: ${String(ev.error)}`);
			}
		}
	} catch (error) {
		if (error instanceof Error) {
			console.error(error);
		} else {
			console.error(new Error(String(error)));
		}
		addMessage("assistant", `Error: ${String(error)}`);
	} finally {
		runBtn.disabled = false;
	}
});
