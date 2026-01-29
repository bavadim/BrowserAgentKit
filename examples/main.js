import OpenAI from "openai";
import * as E from "fp-ts/lib/Either.js";
import {
	createOpenAIResponsesAdapter,
	createAgentMessages,
	runAgent,
	jsInterpreterTool,
	localStoreTool,
} from "browseragentkit";

const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const canvas = document.getElementById("canvas");
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const promptInput = document.getElementById("prompt");

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
let activeAssistantIsStatus = false;
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
	if (activeAssistantIsStatus) {
		bubble.classList.remove("status");
		activeAssistantIsStatus = false;
		activeAssistantText = "";
	}
	activeAssistantText += delta;
	bubble.textContent = activeAssistantText;
}

function finalizeAssistantMessage(text) {
	const bubble = ensureAssistantBubble();
	if (bubble) {
		bubble.classList.remove("status");
		bubble.textContent = text ?? "";
	}
	activeAssistantBubble = null;
	activeAssistantText = "";
	activeAssistantIsStatus = false;
}

function statusLabel(status) {
	if (status.label) {
		return status.label;
	}
	switch (status.kind) {
		case "thinking":
			return thinkingSummary ? `Thinking: ${thinkingSummary}` : "Thinking...";
		case "calling_tool":
			return status.toolName ? `Вызываю ${status.toolName}...` : "Вызываю инструмент...";
		case "tool_result":
			return status.toolName ? `Получен ответ от ${status.toolName}.` : "Получен ответ от инструмента.";
		default:
			return "";
	}
}

function showAssistantStatus(status) {
	if (!status || status.kind === "done") {
		if (activeAssistantIsStatus) {
			finalizeAssistantMessage("");
		}
		return;
	}
	const label = statusLabel(status);
	if (!label) {
		return;
	}
	const bubble = ensureAssistantBubble();
	if (!bubble) {
		return;
	}
	bubble.classList.add("status");
	bubble.textContent = label;
	activeAssistantText = "";
	activeAssistantIsStatus = true;
}

function setStatus(status) {
	if (status.kind !== "thinking") {
		thinkingSummary = "";
	}
	showAssistantStatus(status);
}

function setThinkingSummary(summary) {
	thinkingSummary = summary;
	showAssistantStatus({ kind: "thinking" });
}

function appendThinkingDelta(delta) {
	setThinkingSummary(thinkingSummary + delta);
}

const skills = [
	{
		name: "canvas.render",
		description: "Renders HTML into the right-side canvas using the JS interpreter helpers.",
		promptSelector: "//script[@id='skill-canvas-render']",
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

const generate = createOpenAIResponsesAdapter({
	getClient,
	model: "gpt-5",
});

const agentMessages = createAgentMessages();
const tools = [jsInterpreterTool(), localStoreTool({ namespace: "bak" })];
const agentContext = { viewRoot: canvas };

runBtn.addEventListener("click", async () => {
	if (!canvas) {
		addMessage("assistant", "Canvas element not found.");
		return;
	}
	const prompt = promptInput.value.trim();

	if (!prompt) {
		return;
	}

	addMessage("user", prompt);
	runBtn.disabled = true;
	activeAssistantBubble = null;
	activeAssistantText = "";
	thinkingSummary = "";

	try {
		for await (const ev of runAgent(
			agentMessages,
			generate,
			prompt,
			tools,
			skills,
			25,
			agentContext
		)) {
			if (E.isLeft(ev)) {
				const error = ev.left;
				if (error instanceof Error) {
					console.error(error);
				} else {
					console.error(new Error(String(error)));
				}
				addMessage("assistant", `${String(error)}`);
				break;
			}
			const event = ev.right;
			if (event.type === "message.delta") {
				appendAssistantDelta(event.delta);
			}
			if (event.type === "message") {
				finalizeAssistantMessage(event.content);
			}
			if (event.type === "status") {
				setStatus(event.status);
			}
			if (event.type === "thinking.delta") {
				appendThinkingDelta(event.delta);
			}
			if (event.type === "thinking") {
				setThinkingSummary(event.summary);
			}
		}
	} catch (error) {
		if (error instanceof Error) {
			console.error(error);
		} else {
			console.error(new Error(String(error)));
		}
		addMessage("assistant", `${String(error)}`);
	} finally {
		runBtn.disabled = false;
	}
});
