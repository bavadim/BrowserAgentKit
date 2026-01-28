import { AgentStatusKind, StreamingEventType } from "./types";
import type {
	AgentEvent,
	AgentOptions,
	AgentRunner,
	AgentStatus,
	GenerateRequest,
	Message,
	RunOptions,
	Skill,
	StreamingEvent,
	Tool,
	ToolCall,
	ToolContext,
	ToolDefinition,
	ToolSchema,
} from "./types";

function buildSystemPrompt(skills: Skill[]): string {
	if (skills.length === 0) {
		return "You are a browser-based code agent. Use tools when helpful and respond succinctly.";
	}

	const skillsBlock = skills
		.map((skill) => {
			const desc = skill.description ? `\nDescription: ${skill.description}` : "";
			return `## Skill: ${skill.name}${desc}\n\n${skill.promptMd.trim()}`;
		})
		.join("\n\n");

	return [
		"You are a browser-based code agent.",
		"Select and follow a relevant skill when it matches the request.",
		"Use available tools to complete the steps and return a short result.",
		"\n# Skills",
		skillsBlock,
	].join("\n");
}

function normalizeToolArgs(args: unknown): unknown {
	if (typeof args !== "string") {
		return args;
	}
	const trimmed = args.trim();
	if (!trimmed) {
		return {};
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return args;
	}
}

function serializeToolArgs(args: unknown): string {
	if (typeof args === "string") {
		return args;
	}
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return "{}";
	}
}

function resolveBrowserContext(options: AgentOptions, runOptions: RunOptions): ToolContext {
	const hasWindow = typeof window !== "undefined";
	const viewRoot = options.viewRoot ?? options.context?.viewRoot;
	const docFromRoot = viewRoot?.ownerDocument;

	return {
		viewRoot,
		document: options.context?.document ?? docFromRoot ?? (hasWindow ? document : undefined),
		window: options.context?.window ?? (hasWindow ? window : undefined),
		localStorage:
			options.context?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined),
		signal: runOptions.signal,
	};
}

function toOpenAITools(tools: ToolSchema[]): ToolDefinition[] | undefined {
	if (tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters ?? { type: "object" },
		},
	}));
}

function buildStatus(kind: AgentStatusKind, toolName?: string): AgentStatus {
	let label: string | undefined;
	if (kind === AgentStatusKind.Thinking) {
		label = "Thinking...";
	} else if (kind === AgentStatusKind.CallingTool) {
		label = toolName ? `Calling ${toolName}...` : "Calling tool...";
	} else if (kind === AgentStatusKind.ToolResult) {
		label = toolName ? `Received ${toolName} result.` : "Received tool result.";
	} else if (kind === AgentStatusKind.Done) {
		label = "Done.";
	} else if (kind === AgentStatusKind.Error) {
		label = "Error.";
	}
	return { kind, label, toolName };
}

function statusKey(status: AgentStatus): string {
	return `${status.kind}:${status.toolName ?? ""}`;
}

function appendToolCallsMessage(messages: Message[], toolCalls: ToolCall[]): void {
	const toolCallsPayload = toolCalls.map((call, index) => ({
		id: call.id ?? `tool-call-${index + 1}`,
		type: "function" as const,
		function: {
			name: call.name,
			arguments: serializeToolArgs(call.args),
		},
	}));

	messages.push({
		role: "assistant",
		content: null,
		tool_calls: toolCallsPayload,
	});
}

export function createAgent(options: AgentOptions): AgentRunner {
	const skills = options.skills ?? [];
	const tools = options.tools ?? [];
	const toolMap = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
	const maxSteps = options.policies?.maxSteps ?? 25;

	async function* run(input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent, void, void> {
		const baseContext = resolveBrowserContext(options, runOptions);
		const messages: Message[] = [];
		const systemPrompt = buildSystemPrompt(skills);
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}
		messages.push({ role: "user", content: input });

		const toolSchemas: ToolSchema[] = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));

		let step = 0;
		let lastStatusKey: string | null = null;

		while (step < maxSteps) {
			step += 1;
			const toolCalls: ToolCall[] = [];
			const toolArgBuffers = new Map<string, string>();
			let textBuffer = "";
			let finalText: string | null = null;

			const request: GenerateRequest = {
				messages,
				tools: toOpenAITools(toolSchemas),
				signal: runOptions.signal,
			};

			const emitStatus = (status: AgentStatus) => {
				const key = statusKey(status);
				if (key !== lastStatusKey) {
					lastStatusKey = key;
					return { type: "status", status } as const;
				}
				return null;
			};

			let streamError: unknown = null;
			try {
				for await (const event of options.generate(request)) {
					switch (event.type) {
						case StreamingEventType.ResponseQueued:
						case StreamingEventType.ResponseCreated:
						case StreamingEventType.ResponseInProgress: {
							const status = emitStatus(buildStatus(AgentStatusKind.Thinking));
							if (status) {
								yield status;
							}
							break;
						}
						case StreamingEventType.ResponseOutputTextDelta: {
							textBuffer += event.delta;
							yield { type: "message.delta", delta: event.delta };
							break;
						}
						case StreamingEventType.ResponseOutputTextDone: {
							finalText = event.text;
							break;
						}
						case StreamingEventType.ResponseFunctionCallArgumentsDelta: {
							const existing = toolArgBuffers.get(event.item_id) ?? "";
							toolArgBuffers.set(event.item_id, existing + event.delta);
							break;
						}
						case StreamingEventType.ResponseFunctionCallArgumentsDone: {
							const args = event.arguments ?? toolArgBuffers.get(event.item_id) ?? "";
							if (event.name) {
								toolCalls.push({ id: event.item_id, name: event.name, args });
								const status = emitStatus(buildStatus(AgentStatusKind.CallingTool, event.name));
								if (status) {
									yield status;
								}
							}
							break;
						}
						case StreamingEventType.ResponseFailed: {
							streamError = event.error ?? new Error("Response failed");
							break;
						}
						case StreamingEventType.Error: {
							streamError = event.error;
							break;
						}
						case StreamingEventType.ResponseCompleted:
						default:
							break;
					}
				}
			} catch (error) {
				streamError = error;
			}

			if (streamError) {
				yield { type: "error", error: streamError };
				const status = emitStatus(buildStatus(AgentStatusKind.Error));
				if (status) {
					yield status;
				}
				break;
			}

			if (toolCalls.length > 0) {
				appendToolCallsMessage(messages, toolCalls);
				for (const call of toolCalls) {
					const tool = toolMap.get(call.name);
					if (!tool) {
						const error = new Error(`Unknown tool: ${call.name}`);
						yield { type: "error", error };
						messages.push({
							role: "tool",
							content: JSON.stringify({ error: error.message }),
							tool_call_id: call.id ?? "tool-call",
						});
						continue;
					}

					const args = normalizeToolArgs(call.args);
					const status = emitStatus(buildStatus(AgentStatusKind.CallingTool, call.name));
					if (status) {
						yield status;
					}
					yield { type: "tool.start", name: call.name, args };
					try {
						const result = await tool.run(args, baseContext);
						yield { type: "tool.end", name: call.name, result };
						messages.push({
							role: "tool",
							content: JSON.stringify(result ?? null),
							tool_call_id: call.id ?? "tool-call",
						});
						const toolResultStatus = emitStatus(buildStatus(AgentStatusKind.ToolResult, call.name));
						if (toolResultStatus) {
							yield toolResultStatus;
						}
					} catch (error) {
						yield { type: "error", error };
						messages.push({
							role: "tool",
							content: JSON.stringify({ error: String(error) }),
							tool_call_id: call.id ?? "tool-call",
						});
						const errorStatus = emitStatus(buildStatus(AgentStatusKind.Error, call.name));
						if (errorStatus) {
							yield errorStatus;
						}
					}
				}
				continue;
			}

			const finalContent = finalText ?? textBuffer;
			if (finalContent) {
				messages.push({ role: "assistant", content: finalContent });
				yield { type: "message", content: finalContent };
				const doneStatus = emitStatus(buildStatus(AgentStatusKind.Done));
				if (doneStatus) {
					yield doneStatus;
				}
				break;
			}

			break;
		}

		yield { type: "done" };
	}

	return { run };
}
