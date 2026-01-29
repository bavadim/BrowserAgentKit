import type { AgentEvent, Message, ToolCall } from "./types";

export type LoopState = {
	toolCalls: ToolCall[];
	textBuffer: string;
	finalText: string | null;
	reasoningSummaryBuffer: string;
	finalReasoningSummary: string | null;
	sawMessage: boolean;
	sawThinking: boolean;
};

export type StepOutcome = "continue" | "stop";

export const initLoopState = (): LoopState => ({
	toolCalls: [],
	textBuffer: "",
	finalText: null,
	reasoningSummaryBuffer: "",
	finalReasoningSummary: null,
	sawMessage: false,
	sawThinking: false,
});

export const applyStreamEvent = (
	state: LoopState,
	event: AgentEvent
): { outcome: StepOutcome; outputs: AgentEvent[] } => {
	switch (event.type) {
		case "message.delta":
			state.textBuffer += event.delta;
			return { outcome: "continue", outputs: [event] };
		case "message":
			state.finalText = event.content;
			state.sawMessage = true;
			return { outcome: "continue", outputs: [event] };
		case "thinking.delta":
			state.reasoningSummaryBuffer += event.delta;
			return { outcome: "continue", outputs: [event] };
		case "thinking":
			state.finalReasoningSummary = event.summary;
			state.sawThinking = true;
			return { outcome: "continue", outputs: [event] };
		case "tool.start":
			state.toolCalls.push({ id: event.callId, name: event.name, args: event.args });
			return { outcome: "continue", outputs: [] };
		case "tool.end":
		case "artifact":
			return { outcome: "continue", outputs: [event] };
		case "done":
			return { outcome: "stop", outputs: [] };
		default:
			return { outcome: "continue", outputs: [] };
	}
};

export const flushThinking = (state: LoopState): AgentEvent | null => {
	if (state.sawThinking) {
		return null;
	}
	const summaryText = state.finalReasoningSummary ?? state.reasoningSummaryBuffer;
	return summaryText ? { type: "thinking", summary: summaryText } : null;
};

export const finalContent = (state: LoopState): string => state.finalText ?? state.textBuffer;

export function addToolOutput(messages: Message[], callId: string, output: unknown): void {
	const serialized = typeof output === "string" ? output : JSON.stringify(output ?? null);
	messages.push({
		type: "function_call_output",
		call_id: callId,
		output: serialized,
	});
}

export function addToolCall(messages: Message[], call: ToolCall): void {
	if (!call.id) {
		return;
	}
	const args =
		typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {});
	messages.push({
		type: "function_call",
		call_id: call.id,
		name: call.name,
		arguments: args,
	});
}
