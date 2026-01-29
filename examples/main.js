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
let currentStatus = null;
let thinkingSummary = "";

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
			return thinkingSummary ? `Thinking: ${thinkingSummary}` : "Thinking...";
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

function renderStatus() {
	if (!statusEl || !statusTextEl) {
		return;
	}
	if (!currentStatus) {
		statusEl.classList.add("hidden");
		statusTextEl.textContent = "";
		return;
	}
	const label = formatStatus(currentStatus);
	if (!label) {
		statusEl.classList.add("hidden");
		statusTextEl.textContent = "";
		return;
	}
	statusTextEl.textContent = label;
	statusEl.classList.remove("hidden");
}

function setStatus(status) {
	currentStatus = status;
	if (status.kind !== "thinking") {
		thinkingSummary = "";
	}
	renderStatus();
}

function setThinkingSummary(summary) {
	thinkingSummary = summary;
	if (!currentStatus || currentStatus.kind !== "thinking") {
		currentStatus = { kind: "thinking" };
	}
	renderStatus();
}

function appendThinkingDelta(delta) {
	setThinkingSummary(thinkingSummary + delta);
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

let lastClientConfig = { baseUrl: "", apiKey: "" };
let client = null;

function getClient() {
	const baseUrl = baseUrlInput?.value.trim() ?? "";
	const apiKey = apiKeyInput?.value.trim() ?? "";
	if (!client || baseUrl !== lastClientConfig.baseUrl || apiKey !== lastClientConfig.apiKey) {
		client = new OpenAI({
			baseURL: baseUrl,
			apiKey: apiKey || undefined,
			dangerouslyAllowBrowser: true,
		});
		lastClientConfig = { baseUrl, apiKey };
	}
	return client;
}

const agent = canvas
	? createAgent({
			generate: async function* ({ messages, tools, signal }) {
				const activeClient = getClient();
				const stream = await activeClient.responses.create(
					{
						model: "gpt-5",
						input: messages,
						tools,
						tool_choice: tools?.length ? "auto" : undefined,
						stream: true,
					},
					signal ? { signal } : undefined
				);
				for await (const event of stream) {
					yield event;
				}
			},
			viewRoot: canvas,
			skills,
			tools: [jsInterpreterTool(), localStoreTool({ namespace: "bak" })],
			policies: { maxSteps: 25 },
		})
	: null;

runBtn.addEventListener("click", async () => {
	if (!canvas) {
		addMessage("assistant", "Canvas element not found.");
		return;
	}
	if (!agent) {
		addMessage("assistant", "Agent is not ready.");
		return;
	}
	if (logEl) {
		logEl.textContent = "";
	}

	const prompt = promptInput.value.trim();

	if (!prompt) {
		return;
	}

	addMessage("user", prompt);
	runBtn.disabled = true;
	activeAssistantBubble = null;
	activeAssistantText = "";
	currentStatus = null;
	thinkingSummary = "";
	renderStatus();

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
			if (ev.type === "thinking.delta") {
				appendThinkingDelta(ev.delta);
			}
			if (ev.type === "thinking") {
				setThinkingSummary(ev.summary);
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
