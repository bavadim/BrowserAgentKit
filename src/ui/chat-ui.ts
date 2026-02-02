import type {
	ChatMessage,
	ChatStatus,
	ChatUiController,
	ChatUiOptions,
	ChatUiStatusLabels,
} from "../types";

type ChatUiState = {
	activeAssistantBubble: HTMLDivElement | null;
	activeAssistantText: string;
	activeAssistantIsStatus: boolean;
	thinkingSummary: string;
};

const defaultStatusLabels: ChatUiStatusLabels = {
	thinking: "Thinking...",
	callingTool: "Calling a tool...",
	toolResult: "Received tool result.",
};

function scrollChatToBottom(container: HTMLElement): void {
	container.scrollTop = container.scrollHeight;
}

function createMessage(container: HTMLElement, role: ChatMessage["role"], text: string): void {
	const wrapper = document.createElement("div");
	wrapper.className = `message ${role}`;

	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = text;

	wrapper.appendChild(bubble);
	container.appendChild(wrapper);
	scrollChatToBottom(container);
}

function ensureAssistantBubble(container: HTMLElement, state: ChatUiState): HTMLDivElement {
	if (!state.activeAssistantBubble) {
		const wrapper = document.createElement("div");
		wrapper.className = "message assistant";
		const bubble = document.createElement("div");
		bubble.className = "bubble";
		wrapper.appendChild(bubble);
		container.appendChild(wrapper);
		state.activeAssistantBubble = bubble;
		state.activeAssistantText = "";
		scrollChatToBottom(container);
	}
	return state.activeAssistantBubble;
}

function statusLabel(
	status: ChatStatus,
	labels: ChatUiStatusLabels,
	thinkingSummary: string
): string {
	if (status.kind === "done") {
		return "";
	}
	if (status.label) {
		return status.label;
	}
	switch (status.kind) {
		case "thinking":
			return thinkingSummary ? `Thinking: ${thinkingSummary}` : labels.thinking;
		case "calling_tool":
			return status.toolName ? `Calling ${status.toolName}...` : labels.callingTool;
		case "tool_result":
			return status.toolName
				? `Received result from ${status.toolName}.`
				: labels.toolResult;
		default:
			return "";
	}
}

function showAssistantStatus(
	container: HTMLElement,
	state: ChatUiState,
	labels: ChatUiStatusLabels,
	status: ChatStatus | null
): void {
	if (!status || status.kind === "done") {
		if (state.activeAssistantIsStatus) {
			const bubble = ensureAssistantBubble(container, state);
			bubble.classList.remove("status");
			bubble.textContent = "";
			state.activeAssistantBubble = null;
			state.activeAssistantText = "";
			state.activeAssistantIsStatus = false;
			scrollChatToBottom(container);
		}
		return;
	}

	const label = statusLabel(status, labels, state.thinkingSummary);
	if (!label) {
		return;
	}
	const bubble = ensureAssistantBubble(container, state);
	bubble.classList.add("status");
	bubble.textContent = label;
	state.activeAssistantText = "";
	state.activeAssistantIsStatus = true;
	scrollChatToBottom(container);
}

export function createChatUi(options: ChatUiOptions): ChatUiController {
	const labels = { ...defaultStatusLabels, ...options.statusLabels };
	const state: ChatUiState = {
		activeAssistantBubble: null,
		activeAssistantText: "",
		activeAssistantIsStatus: false,
		thinkingSummary: "",
	};

	if (options.initialMessages) {
		for (const message of options.initialMessages) {
			createMessage(options.container, message.role, message.text);
		}
	}

	return {
		addUserMessage: (text: string): void => {
			createMessage(options.container, "user", text);
		},
		appendAssistantDelta: (delta: string): void => {
			const bubble = ensureAssistantBubble(options.container, state);
			if (state.activeAssistantIsStatus) {
				bubble.classList.remove("status");
				state.activeAssistantIsStatus = false;
				state.activeAssistantText = "";
			}
			state.activeAssistantText += delta;
			bubble.textContent = state.activeAssistantText;
			scrollChatToBottom(options.container);
		},
		finalizeAssistantMessage: (text?: string): void => {
			const bubble = ensureAssistantBubble(options.container, state);
			bubble.classList.remove("status");
			bubble.textContent = text ?? "";
			state.activeAssistantBubble = null;
			state.activeAssistantText = "";
			state.activeAssistantIsStatus = false;
			scrollChatToBottom(options.container);
		},
		setStatus: (status: ChatStatus | null): void => {
			if (status && status.kind !== "thinking") {
				state.thinkingSummary = "";
			}
			showAssistantStatus(options.container, state, labels, status);
		},
		setThinkingSummary: (summary: string): void => {
			state.thinkingSummary = summary;
			showAssistantStatus(options.container, state, labels, { kind: "thinking" });
		},
	};
}
