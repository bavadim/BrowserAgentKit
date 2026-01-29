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
	ToolEnd,
	ToolStart,
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

function addToolCall(messages: Message[], call: ToolCall): void {
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

const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));

const withSystemAfter = (messages: Message[], skillMessage: Message | null): Message[] => {
	if (!skillMessage) {
		return messages;
	}
	const systemIndex = messages.findIndex((item) => "role" in item && item.role === "system");
	if (systemIndex === -1) {
		return [skillMessage, ...messages];
	}
	return [
		...messages.slice(0, systemIndex + 1),
		skillMessage,
		...messages.slice(systemIndex + 1),
	];
};

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

function buildSkillPrompt(prompt: string, childSkills: Skill[]): E.Either<Error, string> {
	return pipe(
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
		E.fromOption(() => new Error("Skill prompt is empty after sanitization."))
	);
}

const flushThinking = (
	sawThinking: boolean,
	finalReasoningSummary: string | null,
	reasoningSummaryBuffer: string
): AgentEvent | null => {
	if (sawThinking) {
		return null;
	}
	const summaryText = finalReasoningSummary ?? reasoningSummaryBuffer;
	return summaryText ? { type: "thinking", summary: summaryText } : null;
};

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
	type CallTarget =
		| { kind: "tool"; tool: Tool }
		| { kind: "skill"; skill: Skill; input: SkillCallArgs; depth: number };

	const toolStartEvent = (call: ToolCall, args: unknown, target: CallTarget): ToolStart =>
		target.kind === "skill"
			? {
					type: "tool.start",
					name: call.name,
					args,
					callId: call.id,
					isSkill: true,
					depth: target.depth,
					input: target.input,
			  }
			: { type: "tool.start", name: call.name, args, callId: call.id };

	const toolEndEvent = (call: ToolCall, result: unknown, target: CallTarget): ToolEnd =>
		target.kind === "skill"
			? { type: "tool.end", name: call.name, result, isSkill: true, depth: target.depth }
			: { type: "tool.end", name: call.name, result };

	const resolveTarget = (call: ToolCall, args: unknown): E.Either<Error, CallTarget> => {
		const skill = skillMap.get(call.name);
		if (skill) {
			return pipe(
				parseSkillCallArgs(args),
				E.map(
					(input): CallTarget => ({
						kind: "skill",
						skill,
						input,
						depth: skillDepth + 1,
					})
				)
			);
		}
		const tool = toolMap.get(call.name);
		if (tool) {
			return E.right({ kind: "tool", tool });
		}
		return E.left(new Error(`Unknown tool: ${call.name}`));
	};

	const buildSkillMessages = (
		prompt: string,
		input: SkillCallArgs,
		history: Message[] = []
	): Message[] => [
		{ role: "system", content: BASE_SYSTEM_PROMPT },
		{ role: "system", content: prompt },
		...history,
		{ role: "user", content: input.task },
	];

	const runSkill = async function* (target: Extract<CallTarget, { kind: "skill" }>): AsyncGenerator<
		AgentEvent,
		string,
		void
	> {
		const prompt = resolveSkillPrompt(target.skill, ctx);
		const childSkills = target.skill.allowedSkills ?? [];
		const childTools = target.skill.tools ?? [];
		const skillPrompt = pipe(
			buildSkillPrompt(prompt, childSkills),
			E.getOrElseW((error) => {
				throw error;
			})
		);
		const nestedMessages = buildSkillMessages(
			skillPrompt,
			target.input,
			target.input.history ?? []
		);
		let skillText = "";
		for await (const ev of runLoop(
			nestedMessages,
			signal,
			ctx,
			childTools,
			childSkills,
			target.depth,
			null,
			maxSteps,
			generate
		)) {
			if (ev.type === "message") {
				skillText = ev.content;
				continue;
			}
			if ((ev.type === "tool.start" || ev.type === "tool.end") && "isSkill" in ev && ev.isSkill) {
				yield ev;
				continue;
			}
			if (ev.type === "error") {
				yield ev;
			}
		}
		return skillText;
	};

	const runToolCall = async function* (
		call: ToolCall,
		args: unknown,
		target: CallTarget
	): AsyncGenerator<AgentEvent, void, void> {
		yield toolStartEvent(call, args, target);
		let result: unknown = null;
		if (target.kind === "skill") {
			result = yield* runSkill(target);
		} else {
			result = await target.tool.run(args, ctx);
		}
		yield toolEndEvent(call, result, target);
		addToolOutput(loopMessages, call.id ?? "tool-call", result ?? null);
		yield* emitStatusEvent(AgentStatusKind.ToolResult, call.name);
	};

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
	const emitStatusEvent = function* (
		kind: AgentStatusKind,
		toolName?: string,
		label?: string
	): Generator<AgentEvent, void, void> {
		const status = emitStatus(kind, toolName, label);
		if (O.isSome(status)) {
			yield status.value;
		}
	};

	const emitErrorAndOutput = function* (
		call: ToolCall,
		error: Error,
		statusName?: string
	): Generator<AgentEvent, void, void> {
		yield { type: "error", error };
		addToolOutput(loopMessages, call.id ?? "tool-call", { error: String(error) });
		yield* emitStatusEvent(AgentStatusKind.Error, statusName ?? call.name);
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
		let streamError: Error | null = null;
		let errorEmitted = false;

		const emitThinkingEvent = function* (event: AgentEvent): Generator<AgentEvent, void, void> {
			yield* emitStatusEvent(AgentStatusKind.Thinking);
			yield event;
		};

		type StreamHandlers = {
			[K in AgentEvent["type"]]: (
				event: Extract<AgentEvent, { type: K }>
			) => Generator<AgentEvent, boolean, void>;
		};

		const streamHandlers: StreamHandlers = {
			status: function* (event) {
				yield* emitStatusEvent(event.status.kind, event.status.toolName, event.status.label);
				return false;
			},
			"message.delta": function* (event) {
				textBuffer += event.delta;
				yield* emitThinkingEvent(event);
				return false;
			},
			message: function* (event) {
				finalText = event.content;
				sawMessage = true;
				yield* emitThinkingEvent(event);
				return false;
			},
			"thinking.delta": function* (event) {
				reasoningSummaryBuffer += event.delta;
				yield* emitThinkingEvent(event);
				return false;
			},
			thinking: function* (event) {
				finalReasoningSummary = event.summary;
				sawThinking = true;
				yield* emitThinkingEvent(event);
				return false;
			},
			"tool.start": function* (event) {
				toolCalls.push({ id: event.callId, name: event.name, args: event.args });
				yield* emitStatusEvent(AgentStatusKind.CallingTool, event.name);
				return false;
			},
			"tool.end": function* (event) {
				yield event;
				return false;
			},
			artifact: function* (event) {
				yield event;
				return false;
			},
			error: function* (event) {
				streamError = toError(event.error);
				errorEmitted = true;
				yield event;
				yield* emitStatusEvent(AgentStatusKind.Error);
				return true;
			},
			done: function* () {
				return false;
			},
		};

		const handleStreamEvent = function* (event: AgentEvent): Generator<AgentEvent, boolean, void> {
			const handler = streamHandlers[event.type] as (
				evt: AgentEvent
			) => Generator<AgentEvent, boolean, void>;
			return yield* handler(event);
		};

		try {
			const promptMessages = withSystemAfter(loopMessages, skillListMessage);
			const stream = await generate(promptMessages, toolDefs, signal);
			streamLoop: for await (const event of stream) {
				const shouldStop = yield* handleStreamEvent(event);
				if (shouldStop) {
					break streamLoop;
				}
			}
		} catch (error) {
			streamError = toError(error);
		}

		if (streamError) {
			if (!errorEmitted) {
				yield { type: "error", error: streamError };
				yield* emitStatusEvent(AgentStatusKind.Error);
			}
			break;
		}

		const thinkingEvent = flushThinking(
			sawThinking,
			finalReasoningSummary,
			reasoningSummaryBuffer
		);
		if (thinkingEvent) {
			yield thinkingEvent;
		}

		if (toolCalls.length > 0) {
			for (const call of toolCalls) {
				if (signal?.aborted) {
					break;
				}

				const args = normalizeToolArgs(call.args);
				yield* emitStatusEvent(AgentStatusKind.CallingTool, call.name);
				addToolCall(loopMessages, call);

				const resolved = resolveTarget(call, args);

				if (E.isLeft(resolved)) {
					yield* emitErrorAndOutput(call, resolved.left);
					continue;
				}

				const target = resolved.right;

				try {
					yield* runToolCall(call, args, target);
				} catch (error) {
					yield* emitErrorAndOutput(call, toError(error));
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
			yield* emitStatusEvent(AgentStatusKind.Done);
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
