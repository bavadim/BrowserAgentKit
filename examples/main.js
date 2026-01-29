import OpenAI from "openai";
import { createAgent, jsInterpreterTool, localStoreTool } from "browseragentkit";

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
		case "error":
			return "Ошибка.";
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

const agent = createAgent({
	generate: async function* (messages, tools, signal) {
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
		const toolArgBuffers = new Map();
		const functionCalls = new Map();
		const pendingCalls = new Map();
		const emittedToolCalls = new Set();
		const contentParts = new Map();
		const summaryParts = new Map();
		let textBuffer = "";
		let summaryBuffer = "";

		const outputItemText = (item) => {
			if (!item?.content || !Array.isArray(item.content)) {
				return "";
			}
			return item.content
				.map((part) => {
					if (part.type === "output_text") {
						return part.text ?? "";
					}
					if (part.type === "refusal") {
						return part.refusal ?? "";
					}
					return "";
				})
				.join("");
		};
		const summaryFromItem = (item) => {
			if (!item?.summary || !Array.isArray(item.summary)) {
				return "";
			}
			return item.summary
				.map((part) => (part.type === "summary_text" ? part.text ?? "" : ""))
				.join("");
		};
		const updatePartBuffer = (buffer, itemId, index, text) => {
			let parts = buffer.get(itemId);
			if (!parts) {
				parts = new Map();
				buffer.set(itemId, parts);
			}
			parts.set(index, text ?? "");
			return [...parts.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, value]) => value)
				.join("");
		};
		const nextTextDelta = (nextText) => {
			if (!nextText) {
				return "";
			}
			let delta = "";
			if (nextText.startsWith(textBuffer)) {
				delta = nextText.slice(textBuffer.length);
			} else {
				delta = nextText;
			}
			textBuffer = nextText;
			return delta;
		};
		const nextSummaryDelta = (nextText) => {
			if (!nextText) {
				return "";
			}
			let delta = "";
			if (nextText.startsWith(summaryBuffer)) {
				delta = nextText.slice(summaryBuffer.length);
			} else {
				delta = nextText;
			}
			summaryBuffer = nextText;
			return delta;
		};
		const getToolStart = (callId, name, args) => {
			if (!callId || emittedToolCalls.has(callId)) {
				return null;
			}
			emittedToolCalls.add(callId);
			return { type: "tool.start", name, args, callId };
		};
		for await (const event of stream) {
			switch (event.type) {
				case "response.queued":
				case "response.created":
				case "response.in_progress":
					yield { type: "status", status: { kind: "thinking" } };
					break;
				case "response.output_text.delta":
					textBuffer += event.delta ?? "";
					if (event.delta) {
						yield { type: "message.delta", delta: event.delta };
					}
					break;
				case "response.output_text.done": {
					const delta = nextTextDelta(event.text ?? "");
					if (delta) {
						yield { type: "message.delta", delta };
					}
					break;
				}
				case "response.reasoning_summary_text.delta":
					summaryBuffer += event.delta ?? "";
					if (event.delta) {
						yield { type: "thinking.delta", delta: event.delta };
					}
					break;
				case "response.reasoning_summary_text.done": {
					const delta = nextSummaryDelta(event.text ?? "");
					if (delta) {
						yield { type: "thinking.delta", delta };
					}
					break;
				}
				case "response.reasoning_text.delta":
				case "response.reasoning_text.done":
					break;
				case "response.reasoning_summary_part.added":
				case "response.reasoning_summary_part.done": {
					const combined = updatePartBuffer(
						summaryParts,
						event.item_id,
						event.summary_index,
						event.part?.text ?? ""
					);
					const delta = nextSummaryDelta(combined);
					if (delta) {
						yield { type: "thinking.delta", delta };
					}
					break;
				}
				case "response.content_part.added":
				case "response.content_part.done": {
					if (event.part?.type === "output_text") {
						const combined = updatePartBuffer(
							contentParts,
							event.item_id,
							event.content_index,
							event.part.text ?? ""
						);
						const delta = nextTextDelta(combined);
						if (delta) {
							yield { type: "message.delta", delta };
						}
					}
					if (event.part?.type === "refusal") {
						const combined = updatePartBuffer(
							contentParts,
							event.item_id,
							event.content_index,
							event.part.refusal ?? ""
						);
						const delta = nextTextDelta(combined);
						if (delta) {
							yield { type: "message.delta", delta };
						}
					}
					break;
				}
				case "response.refusal.delta":
					textBuffer += event.delta ?? "";
					if (event.delta) {
						yield { type: "message.delta", delta: event.delta };
					}
					break;
				case "response.refusal.done": {
					const delta = nextTextDelta(event.refusal ?? "");
					if (delta) {
						yield { type: "message.delta", delta };
					}
					break;
				}
				case "response.function_call_arguments.delta": {
					const existing = toolArgBuffers.get(event.item_id) ?? "";
					toolArgBuffers.set(event.item_id, existing + event.delta);
					break;
				}
				case "response.function_call_arguments.done": {
					const args = event.arguments ?? toolArgBuffers.get(event.item_id) ?? "";
					const stored = functionCalls.get(event.item_id);
					if (stored?.callId && stored?.name) {
						const toolStart = getToolStart(stored.callId, stored.name, args);
						if (toolStart) {
							yield toolStart;
						}
					} else if (event.name) {
						pendingCalls.set(event.item_id, { name: event.name, args });
					}
					break;
				}
				case "response.failed":
					yield { type: "error", error: event.error ?? new Error("Response failed") };
					break;
				case "error":
					yield { type: "error", error: event.error };
					break;
				case "response.audio.delta":
				case "response.audio.done":
				case "response.completed":
					break;
				case "response.output_item.added":
				case "response.output_item.done": {
					if (event.item?.type === "message") {
						const delta = nextTextDelta(outputItemText(event.item));
						if (delta) {
							yield { type: "message.delta", delta };
						}
					}
					if (event.item?.type === "reasoning") {
						const delta = nextSummaryDelta(summaryFromItem(event.item));
						if (delta) {
							yield { type: "thinking.delta", delta };
						}
					}
					if (event.item?.type === "function_call") {
						const itemId = event.item.id ?? event.item.call_id;
						if (itemId) {
							const callId = event.item.call_id ?? itemId;
							functionCalls.set(itemId, {
								callId,
								name: event.item.name,
								args: event.item.arguments ?? "",
							});
							const pending = pendingCalls.get(itemId);
							const args = pending?.args ?? event.item.arguments ?? "";
							const name = pending?.name ?? event.item.name;
							if (pending) {
								pendingCalls.delete(itemId);
							}
							if (event.type === "response.output_item.done") {
								const toolStart = getToolStart(callId, name, args);
								if (toolStart) {
									yield toolStart;
								}
							}
						}
					}
					break;
				}
				default:
					console.error("unrecognized event", event);
					break;
			}
		}
	},
	viewRoot: canvas,
	skills,
	tools: [jsInterpreterTool(), localStoreTool({ namespace: "bak" })],
	policies: { maxSteps: 25 },
});

runBtn.addEventListener("click", async () => {
	if (!canvas) {
		addMessage("assistant", "Canvas element not found.");
		return;
	}
	if (!agent) {
		addMessage("assistant", "Agent is not ready.");
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
		for await (const ev of agent.run(prompt)) {
			if (ev.type === "message.delta") {
				appendAssistantDelta(ev.delta);
			}
			if (ev.type === "message") {
				finalizeAssistantMessage(ev.content);
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
				addMessage("assistant", `${String(ev.error)}`);
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
