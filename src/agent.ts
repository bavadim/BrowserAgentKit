import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
	Message,
	RunAgentOptions,
	Skill,
	Tool,
	ToolCall,
	ToolContext,
} from "./types";
import { formatSkills, parseSkillCallArgs, toOpenAITools, withSystemAfter } from "./skill";
import {
	addToolCall,
	applyStreamEvent,
	finalContent,
	flushThinking,
	initLoopState,
	runToolCall,
	type CallTarget,
	type StreamOutcome,
} from "./execute";

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
	signal?: AbortSignal,
	options?: RunAgentOptions
): AsyncGenerator<AgentStreamEvent, void, void> {
	const skipActiveRuns = options?.skipActiveRuns ?? false;
	const skillDepth = options?.skillDepth ?? 0;
	const hasSkillListOverride = options?.skillListMessage !== undefined;
	const controller = skipActiveRuns ? null : new AbortController();
	const runSignal = controller?.signal ?? signal;
	if (!skipActiveRuns) {
		const previous = activeRuns.get(messages);
		if (previous) {
			previous.abort(new Error("Superseded by a new request."));
		}
		activeRuns.set(messages, controller as AbortController);
		if (signal) {
			if (signal.aborted) {
				controller?.abort(signal.reason);
			} else {
				signal.addEventListener("abort", () => controller?.abort(signal.reason), { once: true });
			}
		}
	}
	const skillsBlock = formatSkills("Skills", skills);
	const rootSkillListMessage = hasSkillListOverride
		? options?.skillListMessage ?? null
		: skillsBlock
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
		signal: runSignal,
	};
	messages.push({ role: "user", content: input });
	let sawError = false;
	const toolMap = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
	const skillMap = new Map<string, Skill>(skills.map((skill) => [skill.name, skill]));
	const toolDefs = toOpenAITools(tools, skills);
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

	try {
		let step = 0;
		while (step < maxSteps) {
			if (runSignal?.aborted) {
				break;
			}
			step += 1;
			const stepState = initLoopState();
			const promptMessages = withSystemAfter(messages, rootSkillListMessage);
			const stream = await generate(promptMessages, toolDefs, runSignal);
			let stop = false;

			for await (const event of stream) {
				if (E.isLeft(event)) {
					sawError = true;
					yield event;
					return;
				}
				const { outcome, outputs } = applyStreamEvent(stepState, event.right);
				for (const output of outputs) {
					yield right(output);
				}
				if (outcome === "stop") {
					stop = true;
					break;
				}
			}

			const thinkingEvent = flushThinking(stepState);
			if (thinkingEvent) {
				yield right(thinkingEvent);
			}

			if (stop) {
				break;
			}

			if (stepState.toolCalls.length > 0) {
				for (const call of stepState.toolCalls) {
					if (runSignal?.aborted) {
						break;
					}

					const args = normalizeToolArgs(call.args);
					addToolCall(messages, call);

					const resolved = resolveTarget(call, args);
					if (E.isLeft(resolved)) {
						sawError = true;
						yield left(resolved.left);
						return;
					}

					const toolStream = runToolCall(
						call,
						args,
						resolved.right,
						baseContext,
						runSignal,
						maxSteps,
						generate,
						runAgent,
						BASE_SYSTEM_PROMPT,
						messages
					);
					let outcome: StreamOutcome = "continue";
					while (true) {
						const { value, done } = await toolStream.next();
						if (done) {
							outcome = value;
							break;
						}
						if (E.isLeft(value)) {
							sawError = true;
							yield value;
							return;
						}
						yield value;
					}
					if (outcome === "error") {
						sawError = true;
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
				messages.push({ role: "assistant", content });
				if (!stepState.sawMessage) {
					yield right({ type: "message", content });
				}
				break;
			}

			break;
		}
	} finally {
		if (!skipActiveRuns && controller && activeRuns.get(messages) === controller) {
			activeRuns.delete(messages);
		}
	}
	if (!sawError) {
		yield right({ type: "done" });
	}
}
