import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { AgentStatusKind } from "./types";
import type { AgentEvent, AgentStreamEvent, Message, ToolDefinition } from "./types";

const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));
const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

export type OpenAIResponsesClient = {
	responses: {
		create: (
			params: Record<string, unknown>,
			requestOptions?: { signal?: AbortSignal }
		) => Promise<AsyncIterable<OpenAIResponsesStreamEvent>>;
	};
};

export type OpenAIResponsesAdapterOptions = {
	client?: OpenAIResponsesClient;
	getClient?: () => OpenAIResponsesClient;
	model: string;
	toolChoice?: "auto" | "none" | "required";
	responseOptions?: Record<string, unknown>;
};

export type OpenAIResponsesStreamEvent = {
	type: string;
	delta?: string;
	text?: string;
	name?: string;
	arguments?: string;
	item_id?: string;
	call_id?: string;
	error?: unknown;
	refusal?: string;
	content_index?: number;
	summary_index?: number;
	part?: {
		type?: string;
		text?: string;
		refusal?: string;
	};
	item?: {
		type?: string;
		content?: Array<{ type?: string; text?: string; refusal?: string }>;
		summary?: Array<{ type?: string; text?: string }>;
		id?: string;
		call_id?: string;
		name?: string;
		arguments?: string;
	};
};

type FunctionCallEntry = {
	callId: string;
	name?: string;
	args?: string;
};

type PendingCallEntry = {
	name?: string;
	args?: string;
};

function outputItemText(item: OpenAIResponsesStreamEvent["item"]): string {
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
}

function summaryFromItem(item: OpenAIResponsesStreamEvent["item"]): string {
	if (!item?.summary || !Array.isArray(item.summary)) {
		return "";
	}
	return item.summary
		.map((part) => (part.type === "summary_text" ? part.text ?? "" : ""))
		.join("");
}

function updatePartBuffer(
	buffer: Map<string, Map<number, string>>,
	itemId: string | undefined,
	index: number | undefined,
	text: string | undefined
): string {
	if (!itemId || index === undefined) {
		return "";
	}
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
}

function nextDelta(nextText: string, bufferRef: { value: string }): string {
	if (!nextText) {
		return "";
	}
	let delta = "";
	if (nextText.startsWith(bufferRef.value)) {
		delta = nextText.slice(bufferRef.value.length);
	} else {
		delta = nextText;
	}
	bufferRef.value = nextText;
	return delta;
}

export function createOpenAIResponsesAdapter(
	options: OpenAIResponsesAdapterOptions
): (
	messages: Message[],
	tools?: ToolDefinition[],
	signal?: AbortSignal
) => AsyncIterable<AgentStreamEvent> {
	const toolChoice = options.toolChoice;
	return async function* generate(messages: Message[], tools?: ToolDefinition[], signal?: AbortSignal) {
		const client = options.getClient ? options.getClient() : options.client;
		if (!client) {
			throw new Error("OpenAI client is required for the responses adapter.");
		}
		const stream = await client.responses.create(
			{
				model: options.model,
				input: messages,
				tools,
				tool_choice: toolChoice ?? (tools?.length ? "auto" : undefined),
				stream: true,
				...(options.responseOptions ?? {}),
			},
			signal ? { signal } : undefined
		);

		const toolArgBuffers = new Map<string, string>();
		const functionCalls = new Map<string, FunctionCallEntry>();
		const pendingCalls = new Map<string, PendingCallEntry>();
		const emittedToolCalls = new Set<string>();
		const contentParts = new Map<string, Map<number, string>>();
		const summaryParts = new Map<string, Map<number, string>>();
		const textBufferRef = { value: "" };
		const summaryBufferRef = { value: "" };

		const getToolStart = (callId: string | undefined, name: string | undefined, args: string) => {
			return pipe(
				O.fromNullable(callId),
				O.filter((id) => !emittedToolCalls.has(id)),
				O.filter(() => !!name),
				O.map((id) => {
					emittedToolCalls.add(id);
					return { type: "tool.start", name: name as string, args, callId: id } as const;
				}),
				O.toNullable
			);
		};

		for await (const event of stream) {
			switch (event.type) {
				case "response.queued":
				case "response.created":
				case "response.in_progress":
					yield right({ type: "status", status: { kind: AgentStatusKind.Thinking } });
					break;
				case "response.output_text.delta": {
					const delta = event.delta ?? "";
					textBufferRef.value += delta;
					if (delta) {
						yield right({ type: "message.delta", delta });
					}
					break;
				}
				case "response.output_text.done": {
					const delta = nextDelta(event.text ?? "", textBufferRef);
					if (delta) {
						yield right({ type: "message.delta", delta });
					}
					break;
				}
				case "response.reasoning_summary_text.delta": {
					const delta = event.delta ?? "";
					summaryBufferRef.value += delta;
					if (delta) {
						yield right({ type: "thinking.delta", delta });
					}
					break;
				}
				case "response.reasoning_summary_text.done": {
					const delta = nextDelta(event.text ?? "", summaryBufferRef);
					if (delta) {
						yield right({ type: "thinking.delta", delta });
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
						event.part?.text
					);
					const delta = nextDelta(combined, summaryBufferRef);
					if (delta) {
						yield right({ type: "thinking.delta", delta });
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
							event.part.text
						);
						const delta = nextDelta(combined, textBufferRef);
						if (delta) {
							yield right({ type: "message.delta", delta });
						}
					}
					if (event.part?.type === "refusal") {
						const combined = updatePartBuffer(
							contentParts,
							event.item_id,
							event.content_index,
							event.part.refusal
						);
						const delta = nextDelta(combined, textBufferRef);
						if (delta) {
							yield right({ type: "message.delta", delta });
						}
					}
					break;
				}
				case "response.refusal.delta": {
					const delta = event.delta ?? "";
					textBufferRef.value += delta;
					if (delta) {
						yield right({ type: "message.delta", delta });
					}
					break;
				}
				case "response.refusal.done": {
					const delta = nextDelta(event.refusal ?? "", textBufferRef);
					if (delta) {
						yield right({ type: "message.delta", delta });
					}
					break;
				}
				case "response.function_call_arguments.delta": {
					const existing = toolArgBuffers.get(event.item_id ?? "") ?? "";
					toolArgBuffers.set(event.item_id ?? "", existing + (event.delta ?? ""));
					break;
				}
				case "response.function_call_arguments.done": {
					const args = event.arguments ?? toolArgBuffers.get(event.item_id ?? "") ?? "";
					const stored = functionCalls.get(event.item_id ?? "");
					if (stored?.callId && stored?.name) {
						const toolStart = getToolStart(stored.callId, stored.name, args);
						if (toolStart) {
							yield right(toolStart);
						}
					} else if (event.name) {
						pendingCalls.set(event.item_id ?? "", { name: event.name, args });
					}
					break;
				}
				case "response.failed":
					yield left(toError(event.error ?? new Error("Response failed")));
					return;
				case "error":
					yield left(toError(event.error));
					return;
				case "response.audio.delta":
				case "response.audio.done":
				case "response.completed":
					break;
				case "response.output_item.added":
				case "response.output_item.done": {
					if (event.item?.type === "message") {
						const delta = nextDelta(outputItemText(event.item), textBufferRef);
						if (delta) {
							yield right({ type: "message.delta", delta });
						}
					}
					if (event.item?.type === "reasoning") {
						const delta = nextDelta(summaryFromItem(event.item), summaryBufferRef);
						if (delta) {
							yield right({ type: "thinking.delta", delta });
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
									yield right(toolStart);
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
	};
}
