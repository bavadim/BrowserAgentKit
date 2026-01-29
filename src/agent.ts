import { AgentStatusKind } from "./types";
import type {
	AgentEvent,
	AgentOptions,
	AgentRunner,
	AgentStatus,
	Message,
	RunOptions,
	Skill,
	Tool,
	ToolCall,
	ToolContext,
	ToolDefinition,
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

function toOpenAITools(tools: Tool[]): ToolDefinition[] | undefined {
	if (tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? { type: "object" },
		strict: true,
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

function addToolOutput(messages: Message[], callId: string, output: unknown): void {
	const serialized = typeof output === "string" ? output : JSON.stringify(output ?? null);
	messages.push({
		type: "function_call_output",
		call_id: callId,
		output: serialized,
	});
}

export function createAgent(options: AgentOptions): AgentRunner {
	const skills = options.skills ?? [];
	const tools = options.tools ?? [];
	const toolMap = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
	const maxSteps = options.policies?.maxSteps ?? 25;
	const systemPrompt = buildSystemPrompt(skills);
	const systemMessage: Message | null = systemPrompt
		? { role: "system", content: systemPrompt }
		: null;
	const messages: Message[] = [];
	let isRunning = false;

	if (systemMessage) {
		messages.push(systemMessage);
	}

	const reset = () => {
		messages.length = 0;
		if (systemMessage) {
			messages.push(systemMessage);
		}
	};

	async function* run(input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent, void, void> {
		if (isRunning) {
			return;
		}
		isRunning = true;
		const baseContext = resolveBrowserContext(options, runOptions);
		const userMessage: Message = { role: "user", content: input };
		messages.push(userMessage);

		try {
			let step = 0;
			let lastStatusKey: string | null = null;

			while (step < maxSteps) {
				step += 1;
				const toolCalls: ToolCall[] = [];
				let textBuffer = "";
				let finalText: string | null = null;
				let reasoningSummaryBuffer = "";
				let finalReasoningSummary: string | null = null;
				let sawMessage = false;
				let sawThinking = false;

				const emitStatus = (status: AgentStatus) => {
					const key = statusKey(status);
					if (key !== lastStatusKey) {
						lastStatusKey = key;
						return { type: "status", status } as const;
					}
					return null;
				};

				let streamError: unknown = null;
				let errorEmitted = false;
				try {
					const stream = await options.generate(messages, toOpenAITools(tools), runOptions.signal);
					streamLoop: for await (const event of stream) {
						switch (event.type) {
							case "status": {
								const status = emitStatus(event.status);
								if (status) {
									yield status;
								}
								break;
							}
							case "message.delta": {
								const status = emitStatus(buildStatus(AgentStatusKind.Thinking));
								if (status) {
									yield status;
								}
								textBuffer += event.delta;
								yield event;
								break;
							}
							case "message": {
								const status = emitStatus(buildStatus(AgentStatusKind.Thinking));
								if (status) {
									yield status;
								}
								finalText = event.content;
								sawMessage = true;
								yield event;
								break;
							}
							case "thinking.delta": {
								const status = emitStatus(buildStatus(AgentStatusKind.Thinking));
								if (status) {
									yield status;
								}
								reasoningSummaryBuffer += event.delta;
								yield event;
								break;
							}
							case "thinking": {
								const status = emitStatus(buildStatus(AgentStatusKind.Thinking));
								if (status) {
									yield status;
								}
								finalReasoningSummary = event.summary;
								sawThinking = true;
								yield event;
								break;
							}
							case "tool.start": {
								toolCalls.push({ id: event.callId, name: event.name, args: event.args });
								const status = emitStatus(buildStatus(AgentStatusKind.CallingTool, event.name));
								if (status) {
									yield status;
								}
								break;
							}
							case "tool.end":
							case "artifact": {
								yield event;
								break;
							}
							case "error": {
								streamError = event.error;
								errorEmitted = true;
								yield event;
								const status = emitStatus(buildStatus(AgentStatusKind.Error));
								if (status) {
									yield status;
								}
								break streamLoop;
							}
							case "done":
								break;
							default:
								console.error("unrecognized event", event);
								break;
						}
					}
				} catch (error) {
					streamError = error;
				}

				if (streamError) {
					if (!errorEmitted) {
						yield { type: "error", error: streamError };
						const status = emitStatus(buildStatus(AgentStatusKind.Error));
						if (status) {
							yield status;
						}
					}
					break;
				}

				if (!sawThinking) {
					const summaryText = finalReasoningSummary ?? reasoningSummaryBuffer;
					if (summaryText) {
						yield { type: "thinking", summary: summaryText };
					}
				}

				if (toolCalls.length > 0) {
					for (const call of toolCalls) {
						const tool = toolMap.get(call.name);
						if (!tool) {
							const error = new Error(`Unknown tool: ${call.name}`);
							yield { type: "error", error };
							addToolOutput(messages, call.id ?? "tool-call", { error: error.message });
							continue;
						}

						const args = normalizeToolArgs(call.args);
						const status = emitStatus(buildStatus(AgentStatusKind.CallingTool, call.name));
						if (status) {
							yield status;
						}
						if (call.id) {
							messages.push({
								type: "function_call",
								call_id: call.id,
								name: call.name,
								arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
							});
						}
						yield { type: "tool.start", name: call.name, args, callId: call.id };
						try {
							const result = await tool.run(args, baseContext);
							yield { type: "tool.end", name: call.name, result };
							addToolOutput(messages, call.id ?? "tool-call", result ?? null);
							const toolResultStatus = emitStatus(buildStatus(AgentStatusKind.ToolResult, call.name));
							if (toolResultStatus) {
								yield toolResultStatus;
							}
						} catch (error) {
							yield { type: "error", error };
							addToolOutput(messages, call.id ?? "tool-call", { error: String(error) });
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
					if (!sawMessage) {
						yield { type: "message", content: finalContent };
					}
					const doneStatus = emitStatus(buildStatus(AgentStatusKind.Done));
					if (doneStatus) {
						yield doneStatus;
					}
					break;
				}

				break;
			}

			yield { type: "done" };
		} finally {
			isRunning = false;
		}
	}

	return { run, reset };
}
