import {
	createOpenAIResponsesAdapter,
	createAgentMessages,
	isAgentError,
	runAgent,
	domAppendHtmlTool,
	domBindEventTool,
	domRemoveTool,
	domSubtreeHtmlTool,
	domSummaryTool,
	jsInterpreterTool,
	jsRunTool,
	Skill,
	withStatus,
} from "browseragentkit";

const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const canvas = document.getElementById("canvas");
const baseUrlInput = document.getElementById("baseUrl");
const modelSelect = document.getElementById("modelSelect");
const apiKeyInput = document.getElementById("apiKey");
const promptInput = document.getElementById("prompt");

const params = new URLSearchParams(window.location.search);
if (baseUrlInput && params.has("baseUrl")) {
	baseUrlInput.value = params.get("baseUrl") ?? "";
}
if (modelSelect && params.has("model")) {
	modelSelect.value = params.get("model") ?? "";
}
if (apiKeyInput && params.has("apiKey")) {
	apiKeyInput.value = params.get("apiKey") ?? "";
}
if (promptInput && params.has("message")) {
	promptInput.value = params.get("message") ?? "";
}

if (promptInput) {
	promptInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && event.shiftKey) {
			event.preventDefault();
			runBtn?.click();
		}
	});
}

function scrollChatToBottom() {
	if (!chatLog) {
		return;
	}
	chatLog.scrollTop = chatLog.scrollHeight;
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
	scrollChatToBottom();
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
	scrollChatToBottom();
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
	scrollChatToBottom();
}

function statusLabel(status) {
	if (status.label) {
		return status.label;
	}
	switch (status.kind) {
		case "thinking":
			return thinkingSummary ? `Thinking: ${thinkingSummary}` : "Thinking...";
		case "calling_tool":
			return status.toolName ? `Calling ${status.toolName}...` : "Calling a tool...";
		case "tool_result":
			return status.toolName ? `Received result from ${status.toolName}.` : "Received tool result.";
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
	scrollChatToBottom();
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

const skills = [Skill.fromDomSelector("//script[@id='skill-canvas-render']", document)];

let lastAdapter = { key: "", adapter: null };

function getSelectedModel() {
	const value = modelSelect?.value?.trim();
	return value || "gpt-5.1-codex-mini";
}

function getAdapter() {
	const model = getSelectedModel();
	const baseURL = baseUrlInput?.value.trim() ?? "";
	const apiKey = apiKeyInput?.value.trim() ?? "";
	const key = `${model}|${baseURL}|${apiKey}`;
	if (!lastAdapter.adapter || lastAdapter.key !== key) {
		lastAdapter = {
			key,
			adapter: createOpenAIResponsesAdapter({
				model,
				baseURL,
				apiKey: apiKey || undefined,
				dangerouslyAllowBrowser: true,
			}),
		};
	}
	return lastAdapter.adapter;
}

const agentMessages = createAgentMessages();
const tools = [
	jsInterpreterTool(),
	jsRunTool(),
	domSummaryTool(),
	domSubtreeHtmlTool(),
	domAppendHtmlTool(),
	domRemoveTool(),
	domBindEventTool(),
];
const callables = [...tools, ...skills];
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
	showAssistantStatus({ kind: "thinking", label: "Working..." });

	try {
		const adapter = getAdapter();
		for await (const ev of withStatus(runAgent(
			agentMessages,
			adapter.generate,
			prompt,
			callables,
			25,
			agentContext,
			undefined,
			{
				tokenCounter: adapter.countTokens,
				contextWindowTokens: adapter.contextWindowTokens,
				model: adapter.model,
			}
		))) {
			if (isAgentError(ev)) {
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
		if (promptInput) {
			promptInput.value = "";
			promptInput.focus();
		}
	}
});
