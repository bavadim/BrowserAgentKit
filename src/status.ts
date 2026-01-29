import * as E from "fp-ts/lib/Either.js";
import {
	AgentStatusKind,
} from "./types";
import type {
	AgentEvent,
	AgentStatus,
	AgentStatusEvent,
	AgentStatusStreamEvent,
	AgentStreamEvent,
} from "./types";

const statusKey = (status: AgentStatus) => `${status.kind}:${status.toolName ?? ""}`;

const statusForEvent = (event: AgentEvent): AgentStatus | null => {
	switch (event.type) {
		case "message.delta":
		case "message":
		case "thinking.delta":
		case "thinking":
			return { kind: AgentStatusKind.Thinking };
		case "tool.start":
			return { kind: AgentStatusKind.CallingTool, toolName: event.name };
		case "tool.end":
			return { kind: AgentStatusKind.ToolResult, toolName: event.name };
		case "done":
			return { kind: AgentStatusKind.Done };
		default:
			return null;
	}
};

export async function* withStatus(
	stream: AsyncIterable<AgentStreamEvent>
): AsyncGenerator<AgentStatusStreamEvent, void, void> {
	let lastKey: string | null = null;
	for await (const ev of stream) {
		if (E.isLeft(ev)) {
			yield ev;
			return;
		}
		const event = ev.right;
		const status = statusForEvent(event);
		if (status) {
			const key = statusKey(status);
			if (key !== lastKey) {
				lastKey = key;
				yield E.right({ type: "status", status } satisfies AgentStatusEvent);
			}
		}
		yield E.right(event);
	}
}
