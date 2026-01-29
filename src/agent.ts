import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { AgentStatusKind } from "./types";
import type {
	AgentEvent,
	AgentOptions,
	Message,
	SkillCallArgs,
	Skill,
	Tool,
	ToolCall,
	ToolContext,
	ToolDefinition,
} from "./types";

const BASE_SYSTEM_PROMPT = "You are a browser-based code agent. Use tools when helpful and respond succinctly.";

function formatSkills(title: string, skills: Skill[]): string {
	if (skills.length === 0) {
		return "";
	}
	const skillsBlock = skills
		.map((skill) => {
			const desc = skill.description ? `\nDescription: ${skill.description}` : "";
			return `## Skill: ${skill.name}${desc}`;
		})
		.join("\n\n");
	return `\n# ${title}\n${skillsBlock}`;
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

const parseSkillCallArgs = (args: unknown): E.Either<Error, SkillCallArgs> =>
	pipe(
		E.fromPredicate(
			(value): value is { task?: unknown; history?: unknown } =>
				!!value && typeof value === "object" && !Array.isArray(value),
			() => new Error("Skill call arguments must be an object.")
		)(args),
		E.chain((candidate) => {
			const task = candidate.task;
			if (typeof task !== "string" || task.trim().length === 0) {
				return E.left(new Error("Skill call must include a non-empty task string."));
			}
			if (candidate.history === undefined) {
				return E.right({ task });
			}
			if (!Array.isArray(candidate.history)) {
				return E.left(new Error("Skill call history must be an array of messages."));
			}
			return E.right({ task, history: candidate.history as SkillCallArgs["history"] });
		})
	);

const activeRuns = new WeakMap<Message[], AbortController>();

function toOpenAITools(tools: Tool[], skills: Skill[]): ToolDefinition[] | undefined {
	if (tools.length === 0 && skills.length === 0) {
		return undefined;
	}
	const toolDefs: ToolDefinition[] = tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? { type: "object" },
		strict: true,
	}));
	const skillDefs: ToolDefinition[] = skills.map((skill) => ({
		type: "function",
		name: skill.name,
		description: skill.description,
		parameters: {
			type: "object",
			properties: {
				task: {
					type: "string",
					description: "Task for the skill to perform.",
				},
				history: {
					type: "array",
					description: "Optional chat history for the skill.",
					items: {
						type: "object",
						properties: {
							role: { type: "string" },
							content: { type: "string" },
						},
						required: ["role", "content"],
						additionalProperties: true,
					},
				},
			},
			required: ["task"],
			additionalProperties: false,
		},
		strict: true,
	}));
	return [...toolDefs, ...skillDefs];
}

function addToolOutput(messages: Message[], callId: string, output: unknown): void {
	const serialized = typeof output === "string" ? output : JSON.stringify(output ?? null);
	messages.push({
		type: "function_call_output",
		call_id: callId,
		output: serialized,
	});
}

function resolveSkillPrompt(skill: Skill, ctx: ToolContext): string {
	const selector = skill.promptSelector?.trim();
	if (!selector) {
		throw new Error(`Skill prompt selector is required for ${skill.name}.`);
	}
	const doc =
		ctx.document ?? ctx.viewRoot?.ownerDocument ?? (typeof document !== "undefined" ? document : undefined);
	if (!doc) {
		throw new Error("No document available to resolve skill prompt.");
	}
	const XPathResultRef = doc.defaultView?.XPathResult;
	if (!XPathResultRef) {
		throw new Error("XPathResult is not available in this environment.");
	}
	const result = doc.evaluate(selector, doc, null, XPathResultRef.FIRST_ORDERED_NODE_TYPE, null);
	const node = result.singleNodeValue;
	if (!node || node.nodeType !== 1) {
		throw new Error(`Skill prompt not found for selector: ${selector}`);
	}
	const prompt = (node.textContent ?? "").trim();
	if (!prompt) {
		throw new Error(`Skill prompt is empty for selector: ${selector}`);
	}
	return prompt;
}

export function createAgentMessages(): Message[] {
	return [{ role: "system", content: BASE_SYSTEM_PROMPT }];
}

async function* runLoop(
	loopMessages: Message[],
	signal: AbortSignal | undefined,
	ctx: ToolContext,
	loopTools: Tool[],
	loopSkills: Skill[],
	skillDepth: number,
	skillListMessage: Message | null,
	maxSteps: number,
	generate: AgentOptions["generate"]
): AsyncGenerator<AgentEvent, void, void> {
	const toolMap = new Map<string, Tool>(loopTools.map((tool) => [tool.name, tool]));
	const skillMap = new Map<string, Skill>(loopSkills.map((skill) => [skill.name, skill]));
	const toolDefs = toOpenAITools(loopTools, loopSkills);
	let step = 0;
	let lastStatusKey: string | null = null;

	const emitStatus = (kind: AgentStatusKind, toolName?: string, label?: string) => {
		const key = `${kind}:${toolName ?? ""}`;
		if (key === lastStatusKey) {
			return O.none;
		}
		lastStatusKey = key;
		return O.some({ type: "status", status: { kind, toolName, label } } as const);
	};

	while (step < maxSteps) {
		if (signal?.aborted) {
			break;
		}
		step += 1;
		const toolCalls: ToolCall[] = [];
		let textBuffer = "";
		let finalText: string | null = null;
		let reasoningSummaryBuffer = "";
		let finalReasoningSummary: string | null = null;
		let sawMessage = false;
		let sawThinking = false;
		let streamError: unknown = null;
		let errorEmitted = false;

		try {
			let promptMessages = loopMessages;
			if (skillListMessage) {
				const systemIndex = loopMessages.findIndex(
					(message) => "role" in message && message.role === "system"
				);
				if (systemIndex === -1) {
					promptMessages = [skillListMessage, ...loopMessages];
				} else {
					promptMessages = [
						...loopMessages.slice(0, systemIndex + 1),
						skillListMessage,
						...loopMessages.slice(systemIndex + 1),
					];
				}
			}
			const stream = await generate(promptMessages, toolDefs, signal);
			streamLoop: for await (const event of stream) {
				switch (event.type) {
					case "status": {
						const status = emitStatus(event.status.kind, event.status.toolName, event.status.label);
						if (O.isSome(status)) {
							yield status.value;
						}
						break;
					}
					case "message.delta": {
						const status = emitStatus(AgentStatusKind.Thinking);
						if (O.isSome(status)) {
							yield status.value;
						}
						textBuffer += event.delta;
						yield event;
						break;
					}
					case "message": {
						const status = emitStatus(AgentStatusKind.Thinking);
						if (O.isSome(status)) {
							yield status.value;
						}
						finalText = event.content;
						sawMessage = true;
						yield event;
						break;
					}
					case "thinking.delta": {
						const status = emitStatus(AgentStatusKind.Thinking);
						if (O.isSome(status)) {
							yield status.value;
						}
						reasoningSummaryBuffer += event.delta;
						yield event;
						break;
					}
					case "thinking": {
						const status = emitStatus(AgentStatusKind.Thinking);
						if (O.isSome(status)) {
							yield status.value;
						}
						finalReasoningSummary = event.summary;
						sawThinking = true;
						yield event;
						break;
					}
					case "tool.start": {
						toolCalls.push({ id: event.callId, name: event.name, args: event.args });
						const status = emitStatus(AgentStatusKind.CallingTool, event.name);
						if (O.isSome(status)) {
							yield status.value;
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
						const status = emitStatus(AgentStatusKind.Error);
						if (O.isSome(status)) {
							yield status.value;
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
				const status = emitStatus(AgentStatusKind.Error);
				if (O.isSome(status)) {
					yield status.value;
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
				if (signal?.aborted) {
					break;
				}
				const skill = skillMap.get(call.name);
				const tool = toolMap.get(call.name);
				if (!skill && !tool) {
					const error = new Error(`Unknown tool: ${call.name}`);
					yield { type: "error", error };
					addToolOutput(loopMessages, call.id ?? "tool-call", { error: error.message });
					continue;
				}

				const args = normalizeToolArgs(call.args);
				const status = emitStatus(AgentStatusKind.CallingTool, call.name);
				if (O.isSome(status)) {
					yield status.value;
				}
				if (call.id) {
					loopMessages.push({
						type: "function_call",
						call_id: call.id,
						name: call.name,
						arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {}),
					});
				}

				let skillInput: SkillCallArgs | null = null;
				let skillDepthValue: number | null = null;
				if (skill) {
					const parsed = parseSkillCallArgs(args);
					if (E.isLeft(parsed)) {
						yield { type: "error", error: parsed.left };
						addToolOutput(loopMessages, call.id ?? "tool-call", { error: String(parsed.left) });
						const errorStatus = emitStatus(AgentStatusKind.Error, call.name);
						if (O.isSome(errorStatus)) {
							yield errorStatus.value;
						}
						continue;
					}
					skillInput = parsed.right;
					skillDepthValue = skillDepth + 1;
				}

				if (skill && skillInput && skillDepthValue !== null) {
					yield {
						type: "tool.start",
						name: call.name,
						args,
						callId: call.id,
						isSkill: true,
						depth: skillDepthValue,
						input: skillInput,
					};
				} else {
					yield { type: "tool.start", name: call.name, args, callId: call.id };
				}

				try {
					let result: unknown = null;
					if (skill && skillInput && skillDepthValue !== null) {
						const prompt = resolveSkillPrompt(skill, ctx);
						const childSkills = skill.allowedSkills ?? [];
						const childTools = skill.tools ?? [];
						const skillPrompt = pipe(
							prompt
								.replace(/<script[\s\S]*?<\/script>/gi, "")
								.replace(/<style[\s\S]*?<\/style>/gi, "")
								.replace(/<\/?[^>]+>/g, "")
								.trim(),
							O.fromPredicate((text) => text.length > 0),
							O.map((sanitized) => {
								const subskillsBlock = formatSkills("Subskills", childSkills);
								if (!subskillsBlock) {
									return sanitized;
								}
								return [
									sanitized,
									"",
									"Call subskills when they help complete the task.",
									"If the user mentions a subskill as `$name`, treat it as a suggestion (not a requirement).",
									subskillsBlock,
								].join("\n");
							}),
							E.fromOption(() => new Error("Skill prompt is empty after sanitization.")),
							E.getOrElseW((error) => {
								throw error;
							})
						);
						const nestedMessages: Message[] = [
							{ role: "system", content: BASE_SYSTEM_PROMPT },
							{ role: "system", content: skillPrompt },
							...(skillInput.history ?? []),
							{ role: "user", content: skillInput.task },
						];
						let skillText = "";
						for await (const ev of runLoop(
							nestedMessages,
							signal,
							ctx,
							childTools,
							childSkills,
							skillDepthValue,
							null,
							maxSteps,
							generate
						)) {
							if (ev.type === "message") {
								skillText = ev.content;
								continue;
							}
							if (
								(ev.type === "tool.start" || ev.type === "tool.end") &&
								"isSkill" in ev &&
								ev.isSkill
							) {
								yield ev;
								continue;
							}
							if (ev.type === "error") {
								yield ev;
							}
						}
						result = skillText;
					} else if (tool) {
						result = await tool.run(args, ctx);
					}

					if (skill && skillDepthValue !== null) {
						yield { type: "tool.end", name: call.name, result, isSkill: true, depth: skillDepthValue };
					} else {
						yield { type: "tool.end", name: call.name, result };
					}
					addToolOutput(loopMessages, call.id ?? "tool-call", result ?? null);
					const toolResultStatus = emitStatus(AgentStatusKind.ToolResult, call.name);
					if (O.isSome(toolResultStatus)) {
						yield toolResultStatus.value;
					}
				} catch (error) {
					yield { type: "error", error };
					addToolOutput(loopMessages, call.id ?? "tool-call", { error: String(error) });
					const errorStatus = emitStatus(AgentStatusKind.Error, call.name);
					if (O.isSome(errorStatus)) {
						yield errorStatus.value;
					}
				}
			}
			continue;
		}

		const finalContent = finalText ?? textBuffer;
		if (finalContent) {
			loopMessages.push({ role: "assistant", content: finalContent });
			if (!sawMessage) {
				yield { type: "message", content: finalContent };
			}
			const doneStatus = emitStatus(AgentStatusKind.Done);
			if (O.isSome(doneStatus)) {
				yield doneStatus.value;
			}
			break;
		}

		break;
	}
}

export async function* runAgent(
	messages: Message[],
	options: AgentOptions,
	input: string,
	signal?: AbortSignal
): AsyncGenerator<AgentEvent, void, void> {
	const previous = activeRuns.get(messages);
	if (previous) {
		previous.abort(new Error("Superseded by a new request."));
	}
	const controller = new AbortController();
	activeRuns.set(messages, controller);
	if (signal) {
		if (signal.aborted) {
			controller.abort(signal.reason);
		} else {
			signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
		}
	}
	const skills = options.skills ?? [];
	const tools = options.tools ?? [];
	const maxSteps = options.maxSteps ?? 25;
	const rootSkillListMessage = pipe(
		formatSkills("Skills", skills),
		O.fromPredicate((block) => block.length > 0),
		O.map((block) => ({
			role: "system" as const,
			content: [
				"Call a skill tool when it matches the request.",
				"If the user mentions a skill as `$name`, treat it as a suggestion (not a requirement).",
				block,
			].join("\n"),
		})),
		O.toNullable
	);
	const hasWindow = typeof window !== "undefined";
	const viewRoot = options.viewRoot ?? options.context?.viewRoot;
	const docFromRoot = viewRoot?.ownerDocument;
	const baseContext: ToolContext = {
		viewRoot,
		document: options.context?.document ?? docFromRoot ?? (hasWindow ? document : undefined),
		window: options.context?.window ?? (hasWindow ? window : undefined),
		localStorage:
			options.context?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined),
		signal: controller.signal,
	};
	messages.push({ role: "user", content: input });

	try {
		for await (const event of runLoop(
			messages,
			controller.signal,
			baseContext,
			tools,
			skills,
			0,
			rootSkillListMessage,
			maxSteps,
			options.generate
		)) {
			yield event;
		}
	} finally {
		if (activeRuns.get(messages) === controller) {
			activeRuns.delete(messages);
		}
	}
	yield { type: "done" };
}
