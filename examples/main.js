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
import { createChatUi } from "browseragentkit/ui";

const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const skillList = document.getElementById("skillList");
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

const chatUi = chatLog ? createChatUi({ container: chatLog }) : null;

function addUserMessage(text) {
	chatUi?.addUserMessage(text);
}

function addAssistantMessage(text) {
	chatUi?.finalizeAssistantMessage(text);
}

const skills = [Skill.fromDomSelector("//script[@id='skill-canvas-render']", document)];
const enabledSkills = new Set(skills.map((skill) => skill.name));

function renderSkillList() {
	if (!skillList) {
		return;
	}
	skillList.innerHTML = "";
	if (skills.length === 0) {
		const empty = document.createElement("div");
		empty.className = "skill-list-item";
		empty.textContent = "No skills available.";
		skillList.appendChild(empty);
		return;
	}
	for (const skill of skills) {
		const row = document.createElement("label");
		row.className = "skill-list-item";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = enabledSkills.has(skill.name);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) {
				enabledSkills.add(skill.name);
			} else {
				enabledSkills.delete(skill.name);
			}
		});

		const text = document.createElement("span");
		text.textContent = skill.name;

		row.appendChild(checkbox);
		row.appendChild(text);
		skillList.appendChild(row);
	}
}

renderSkillList();

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
function getEnabledSkills() {
	return skills.filter((skill) => enabledSkills.has(skill.name));
}
const agentContext = { viewRoot: canvas };

runBtn.addEventListener("click", async () => {
	if (!canvas) {
		addAssistantMessage("Canvas element not found.");
		return;
	}
	const prompt = promptInput.value.trim();

	if (!prompt) {
		return;
	}

	let thinkingSummary = "";

	addUserMessage(prompt);
	runBtn.disabled = true;
	chatUi?.setStatus({ kind: "thinking", label: "Working..." });

	try {
		const adapter = getAdapter();
		for await (const ev of withStatus(runAgent(
			agentMessages,
			adapter.generate,
			prompt,
			[...tools, ...getEnabledSkills()],
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
				addAssistantMessage(`${String(error)}`);
				break;
			}
			const event = ev.right;
			if (event.type === "message.delta") {
				chatUi?.appendAssistantDelta(event.delta);
			}
			if (event.type === "message") {
				chatUi?.finalizeAssistantMessage(event.content);
			}
			if (event.type === "status") {
				if (event.status.kind !== "thinking") {
					thinkingSummary = "";
				}
				chatUi?.setStatus(event.status);
			}
			if (event.type === "thinking.delta") {
				thinkingSummary += event.delta;
				chatUi?.setThinkingSummary(thinkingSummary);
			}
			if (event.type === "thinking") {
				thinkingSummary = event.summary;
				chatUi?.setThinkingSummary(event.summary);
			}
		}
	} catch (error) {
		if (error instanceof Error) {
			console.error(error);
		} else {
			console.error(new Error(String(error)));
		}
		addAssistantMessage(`${String(error)}`);
	} finally {
		runBtn.disabled = false;
		if (promptInput) {
			promptInput.value = "";
			promptInput.focus();
		}
	}
});
