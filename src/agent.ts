import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import { AgentStatusKind } from "./types";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
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
import {
	buildSkillMessages,
	buildSkillPrompt,
	formatSkills,
	parseSkillCallArgs,
	resolveSkillPrompt,
	toOpenAITools,
	withSystemAfter,
} from "./skill";

type Outcome =
	| { kind: "error"; error: Error }
	| { kind: "event"; event: AgentEvent };

const BASE_SYSTEM_PROMPT = "You are a browser-based code agent. Use tools when helpful and respond succinctly.";
const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));
const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

function normalizeToolArgs(args: unknown): unknown {
	if (typeof args !== "string") {
		return args;
	}
	const trimmed = args.trim();
	if (!trimmed) {
		return {};
	}
	return pipe(
		E.tryCatch(() => JSON.parse(trimmed) as unknown, toError),
		E.getOrElseW(() => args)
	);
}

const activeRuns = new WeakMap<Message[], AbortController>();

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

const singleLeftStream = (error: Error): AsyncIterable<AgentStreamEvent> =>
	(async function* () {
		yield left(error);
	})();

const ignoreEvent = function* (_event: AgentEvent): Generator<AgentStreamEvent, void, void> {};
const emitLeft = function* (error: Error): Generator<AgentStreamEvent, void, void> {
	yield left(error);
};

const safeGenerate = (
	generate: AgentGenerate,
	messages: Message[],
	tools: ToolDefinition[] | undefined,
	signal?: AbortSignal
): Promise<AsyncIterable<AgentStreamEvent>> =>
	Promise.resolve(generate(messages, tools, signal)).catch((error) =>
		singleLeftStream(toError(error))
	);

const safeStream = async function* (
	stream: AsyncIterable<AgentStreamEvent>
): AsyncGenerator<AgentStreamEvent, void, void> {
	const iterator = stream[Symbol.asyncIterator]();
	while (true) {
		const result = await iterator.next().catch((error) => ({
			done: true,
			value: left(toError(error)),
		}));
		if (result.done) {
			if (result.value) {
				yield* pipe(result.value, E.match(emitLeft, ignoreEvent));
			}
			break;
		}
		yield result.value;
	}
};

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
	generate: AgentGenerate
): AsyncGenerator<AgentStreamEvent, void, void> {
	type CallTarget =
		| { kind: "tool"; tool: Tool }
		| { kind: "skill"; skill: Skill; input: SkillCallArgs; depth: number };
	type StreamOutcome = "continue" | "stop" | "error";
	const stopWithError = async function* (
		error: Error
	): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
		yield left(error);
		return "error";
	};
	const foldStreamEvent = <T>(
		event: E.Either<Error, T>,
		onRight: (value: T) => AsyncGenerator<AgentStreamEvent, StreamOutcome, void>
	): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> =>
			pipe(event, E.match(stopWithError, onRight));

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

	const failSkill = async function* (
		error: Error
	): AsyncGenerator<AgentStreamEvent, E.Either<Error, string>, void> {
		return E.left(error);
	};

	const runSkill = async function* (
		target: Extract<CallTarget, { kind: "skill" }>
	): AsyncGenerator<AgentStreamEvent, E.Either<Error, string>, void> {
		const childSkills = target.skill.allowedSkills ?? [];
		const childTools = target.skill.tools ?? [];
		const skillPromptResult = pipe(
			E.tryCatch(() => resolveSkillPrompt(target.skill, ctx), toError),
			E.chain((prompt) => buildSkillPrompt(prompt, childSkills))
		);

		return yield* pipe(
			skillPromptResult,
			E.matchW(
				failSkill,
				async function* (skillPrompt) {
					const nestedMessages = buildSkillMessages(
						BASE_SYSTEM_PROMPT,
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
						const outcome = pipe(
							ev,
							E.match<Error, AgentEvent, Outcome>(
								(error) => ({ kind: "error", error }),
								(event) => ({ kind: "event", event })
							)
						);
						if (outcome.kind === "error") {
							return E.left(outcome.error);
						}
						const event = outcome.event;
						if (event.type === "message") {
							skillText = event.content;
							continue;
						}
						if (
							(event.type === "tool.start" || event.type === "tool.end") &&
							"isSkill" in event &&
							event.isSkill
						) {
							yield right(event);
						}
					}
					return E.right(skillText);
				}
			)
		);
	};

	const finishToolCall = async function* (
		call: ToolCall,
		output: unknown,
		target: CallTarget
	): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
		yield right(toolEndEvent(call, output, target));
		addToolOutput(loopMessages, call.id ?? "tool-call", output ?? null);
		yield* emitStatusEvent(AgentStatusKind.ToolResult, call.name);
		return "continue";
	};

	const runToolCall = async function* (
		call: ToolCall,
		args: unknown,
		target: CallTarget
	): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
		yield right(toolStartEvent(call, args, target));
		const result = target.kind === "skill"
			? yield* runSkill(target)
			: await Promise.resolve()
				.then(() => target.tool.run(args, ctx))
				.then(E.right)
				.catch((error) => E.left(toError(error)));
		return yield* pipe(result, E.match(stopWithError, (output) => finishToolCall(call, output, target)));
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
	): Generator<AgentStreamEvent, void, void> {
		const status = emitStatus(kind, toolName, label);
		if (O.isSome(status)) {
			yield right(status.value);
		}
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

		const emitThinkingEvent = function* (
			event: AgentEvent
		): Generator<AgentStreamEvent, void, void> {
			yield* emitStatusEvent(AgentStatusKind.Thinking);
			yield right(event);
		};

		type StreamHandlers = {
			[K in AgentEvent["type"]]: (
				event: Extract<AgentEvent, { type: K }>
			) => Generator<AgentStreamEvent, StreamOutcome, void>;
		};

		const streamHandlers: StreamHandlers = {
			status: function* (event) {
				yield* emitStatusEvent(event.status.kind, event.status.toolName, event.status.label);
				return "continue";
			},
			"message.delta": function* (event) {
				textBuffer += event.delta;
				yield* emitThinkingEvent(event);
				return "continue";
			},
			message: function* (event) {
				finalText = event.content;
				sawMessage = true;
				yield* emitThinkingEvent(event);
				return "continue";
			},
			"thinking.delta": function* (event) {
				reasoningSummaryBuffer += event.delta;
				yield* emitThinkingEvent(event);
				return "continue";
			},
			thinking: function* (event) {
				finalReasoningSummary = event.summary;
				sawThinking = true;
				yield* emitThinkingEvent(event);
				return "continue";
			},
			"tool.start": function* (event) {
				toolCalls.push({ id: event.callId, name: event.name, args: event.args });
				yield* emitStatusEvent(AgentStatusKind.CallingTool, event.name);
				return "continue";
			},
			"tool.end": function* (event) {
				yield right(event);
				return "continue";
			},
			artifact: function* (event) {
				yield right(event);
				return "continue";
			},
			done: function* () {
				return "stop";
			},
		};

		const handleStreamEvent = async function* (
			event: AgentEvent
		): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
			const handler = streamHandlers[event.type] as (
				evt: AgentEvent
			) => Generator<AgentStreamEvent, StreamOutcome, void>;
			return yield* handler(event);
		};

		const promptMessages = withSystemAfter(loopMessages, skillListMessage);
		const stream = await safeGenerate(generate, promptMessages, toolDefs, signal);
		for await (const event of safeStream(stream)) {
			const outcome = yield* foldStreamEvent(event, handleStreamEvent);
			if (outcome === "error") {
				return;
			}
			if (outcome === "stop") {
				break;
			}
		}

		const thinkingEvent = flushThinking(
			sawThinking,
			finalReasoningSummary,
			reasoningSummaryBuffer
		);
		if (thinkingEvent) {
			yield right(thinkingEvent);
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
				const outcome = yield* foldStreamEvent(resolved, (target) => runToolCall(call, args, target));
				if (outcome === "error") {
					return;
				}
				if (outcome === "stop") {
					return;
				}
			}
			continue;
		}

		const finalContent = finalText ?? textBuffer;
		if (finalContent) {
			loopMessages.push({ role: "assistant", content: finalContent });
			if (!sawMessage) {
				yield right({ type: "message", content: finalContent });
			}
			yield* emitStatusEvent(AgentStatusKind.Done);
			break;
		}

		break;
	}
}

export async function* runAgent(
	messages: Message[],
	generate: AgentGenerate,
	input: string,
	tools: Tool[] = [],
	skills: Skill[] = [],
	maxSteps: number = 25,
	context?: Partial<ToolContext>,
	signal?: AbortSignal
): AsyncGenerator<AgentStreamEvent, void, void> {
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
	const viewRoot = context?.viewRoot;
	const docFromRoot = viewRoot?.ownerDocument;
	const baseContext: ToolContext = {
		viewRoot,
		document: context?.document ?? docFromRoot ?? (hasWindow ? document : undefined),
		window: context?.window ?? (hasWindow ? window : undefined),
		localStorage:
			context?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined),
		signal: controller.signal,
	};
	messages.push({ role: "user", content: input });
	let sawError = false;

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
			generate
		)) {
			yield event;
			pipe(
				event,
				E.match(
					() => {
						sawError = true;
					},
					() => undefined
				)
			);
		}
	} finally {
		if (activeRuns.get(messages) === controller) {
			activeRuns.delete(messages);
		}
	}
	if (!sawError) {
		yield right({ type: "done" });
	}
}
