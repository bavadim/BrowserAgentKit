import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
	Message,
	Skill,
	Tool,
	ToolCall,
	ToolContext,
} from "./types";
import { formatSkills, parseSkillCallArgs, toOpenAITools, withSystemAfter } from "./skill";
import { addToolCall, applyStreamEvent, finalContent, flushThinking, initLoopState } from "./loop";
import type { CallTarget, StreamOutcome } from "./execute";
import { runToolCall } from "./execute";

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

export function createAgentMessages(): Message[] {
	return [{ role: "system", content: BASE_SYSTEM_PROMPT }];
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
	const skillsBlock = formatSkills("Skills", skills);
	const rootSkillListMessage = skillsBlock
		? {
			role: "system" as const,
			content: [
				"Call a skill tool when it matches the request.",
				"If the user mentions a skill as `$name`, treat it as a suggestion (not a requirement).",
				skillsBlock,
			].join("\n"),
		}
		: null;
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
		const runSubAgent = async function* (
			loopMessages: Message[],
			signal: AbortSignal | undefined,
			ctx: ToolContext,
			loopTools: Tool[],
			loopSkills: Skill[],
			skillDepth: number,
			skillListMessage: Message | null,
			steps: number,
			loopGenerate: AgentGenerate
		): AsyncGenerator<AgentStreamEvent, void, void> {
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

			const toolMap = new Map<string, Tool>(loopTools.map((tool) => [tool.name, tool]));
			const skillMap = new Map<string, Skill>(loopSkills.map((skill) => [skill.name, skill]));
			const toolDefs = toOpenAITools(loopTools, loopSkills);
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

			let step = 0;
			while (step < steps) {
				if (signal?.aborted) {
					break;
				}
				step += 1;
				const stepState = initLoopState();
				const handleStreamEvent = async function* (
					event: AgentEvent
				): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
					const { outcome, outputs } = applyStreamEvent(stepState, event);
					for (const output of outputs) {
						yield right(output);
					}
					return outcome;
				};

				const promptMessages = withSystemAfter(loopMessages, skillListMessage);
				const stream = await loopGenerate(promptMessages, toolDefs, signal);
				for await (const event of stream) {
					const outcome = yield* foldStreamEvent(event, handleStreamEvent);
					if (outcome === "error") {
						return;
					}
					if (outcome === "stop") {
						break;
					}
				}

				const thinkingEvent = flushThinking(stepState);
				if (thinkingEvent) {
					yield right(thinkingEvent);
				}

				if (stepState.toolCalls.length > 0) {
					for (const call of stepState.toolCalls) {
						if (signal?.aborted) {
							break;
						}

						const args = normalizeToolArgs(call.args);
						addToolCall(loopMessages, call);

						const resolved = resolveTarget(call, args);
						const outcome = yield* foldStreamEvent(resolved, (target) =>
							runToolCall(
								call,
								args,
								target,
								ctx,
								signal,
								steps,
								loopGenerate,
								runSubAgent,
								BASE_SYSTEM_PROMPT,
								loopMessages
							)
						);
						if (outcome === "error") {
							return;
						}
						if (outcome === "stop") {
							return;
						}
					}
					continue;
				}

				const content = finalContent(stepState);
				if (content) {
					loopMessages.push({ role: "assistant", content });
					if (!stepState.sawMessage) {
						yield right({ type: "message", content });
					}
					break;
				}

				break;
			}
		};

		for await (const event of runSubAgent(
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
