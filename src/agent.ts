import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import { AgentStatusKind } from "./types";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStatus,
	AgentStatusEvent,
	AgentStatusStreamEvent,
	AgentStreamEvent,
	Callable,
	Message,
	RunAgentOptions,
	ToolCall,
	ToolContext,
	ToolDefinition,
} from "./types";
import { Skill } from "./skill";
import { Tool } from "./tools";
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

const BASE_SYSTEM_PROMPT =
	"You are a browser-based code agent. Use tools to take actions. " +
	"If the task involves DOM changes or JavaScript execution, you MUST call a tool or skill " +
	"and never output raw code as the final response. Respond succinctly.";
const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));
const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

function formatCallables(title: string, callables: Callable[]): string {
	if (callables.length === 0) {
		return "";
	}
	const block = callables.map((callable) => callable.formatForList()).join("\n\n");
	return `\n# ${title}\n${block}`;
}

function withSystemAfter(messages: Message[], systemMessage: Message | null): Message[] {
	if (!systemMessage) {
		return messages;
	}
	const systemIndex = messages.findIndex((item) => "role" in item && item.role === "system");
	if (systemIndex === -1) {
		return [systemMessage, ...messages];
	}
	return [
		...messages.slice(0, systemIndex + 1),
		systemMessage,
		...messages.slice(systemIndex + 1),
	];
}

function toOpenAITools(callables: Callable[]): ToolDefinition[] | undefined {
	if (callables.length === 0) {
		return undefined;
	}
	return callables.map((callable) => callable.toToolDefinition());
}

const isSkillCallable = (callable: Callable): callable is Skill => callable.kind === "skill";
const isToolCallable = (callable: Callable): callable is Tool => callable.kind === "tool";

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
	callables: Callable[] = [],
	maxSteps: number = 25,
	context?: Partial<ToolContext>,
	signal?: AbortSignal,
	options?: RunAgentOptions
): AsyncGenerator<AgentStreamEvent, void, void> {
	const skipActiveRuns = options?.skipActiveRuns ?? false;
	const skillDepth = options?.skillDepth ?? 0;
	const hasCallableListOverride = options?.callableListMessage !== undefined;
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
	const callablesBlock = formatCallables("Callables", callables);
	const rootCallableListMessage = hasCallableListOverride
		? options?.callableListMessage ?? null
		: callablesBlock
			? {
				role: "system" as const,
				content: [
					"Call a tool or skill when it matches the request.",
					"Never output raw code; use tools or skills to apply changes.",
					"If the user mentions a callable as `$name`, treat it as a suggestion (not a requirement).",
					callablesBlock,
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
		signal: runSignal,
	};
	messages.push({ role: "user", content: input });
	let sawError = false;
	const callableMap = new Map<string, Callable>();
	for (const callable of callables) {
		callableMap.set(callable.callName, callable);
		if (callable.name !== callable.callName) {
			callableMap.set(callable.name, callable);
		}
	}
	const toolDefs = toOpenAITools(callables);
	const resolveTarget = (call: ToolCall, args: unknown): E.Either<Error, CallTarget> => {
		const callable = callableMap.get(call.name);
		if (!callable) {
			return E.left(new Error(`Unknown callable: ${call.name}`));
		}
		if (isSkillCallable(callable)) {
			return pipe(
				Skill.parseCallArgs(args),
				E.map(
					(input): CallTarget => ({
						kind: "skill",
						skill: callable,
						input,
						depth: skillDepth + 1,
					})
				)
			);
		}
		if (isToolCallable(callable)) {
			return E.right({ kind: "tool", tool: callable });
		}
		return E.left(new Error(`Unknown callable kind: ${call.name}`));
	};

	try {
		let step = 0;
		while (step < maxSteps) {
			if (runSignal?.aborted) {
				break;
			}
			step += 1;
			const stepState = initLoopState();
			const promptMessages = withSystemAfter(messages, rootCallableListMessage);
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
