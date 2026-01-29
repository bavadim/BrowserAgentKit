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

const BASE_SYSTEM_PROMPT = "You are a browser-based code agent. Use tools when helpful and respond succinctly.";
const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));
const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

const DEFAULT_CONTEXT_WINDOW_TOKENS = 96_000;
const DEFAULT_COMPACT_THRESHOLD = 0.75;

function getMessageRole(message: Message): string | undefined {
	if ("role" in message && typeof message.role === "string") {
		return message.role;
	}
	const messageType = (message as { type?: unknown }).type;
	if (messageType === "message") {
		const role = (message as { role?: unknown }).role;
		return typeof role === "string" ? role : undefined;
	}
	return undefined;
}

function compactHistory(messages: Message[]): Message[] {
	const firstUserIndex = messages.findIndex((message) => getMessageRole(message) === "user");
	if (firstUserIndex === -1) {
		return messages;
	}
	const head = messages.slice(0, firstUserIndex);
	const segments: Message[][] = [];
	let current: Message[] | null = null;
	for (let i = firstUserIndex; i < messages.length; i += 1) {
		const message = messages[i];
		const role = getMessageRole(message);
		if (role === "user") {
			if (current && current.length > 0) {
				segments.push(current);
			}
			current = [message];
			continue;
		}
		if (current) {
			current.push(message);
		}
	}
	if (current && current.length > 0) {
		segments.push(current);
	}
	if (segments.length <= 3) {
		return messages;
	}
	const tailSegments = segments.slice(-3).flat();
	return [...head, ...tailSegments];
}

function pruneDanglingToolCalls(messages: Message[]): void {
	const callIds = new Set<string>();
	const outputIds = new Set<string>();
	for (const message of messages) {
		if ("type" in message) {
			if (message.type === "function_call" && message.call_id) {
				callIds.add(message.call_id);
			}
			if (message.type === "function_call_output" && message.call_id) {
				outputIds.add(message.call_id);
			}
		}
	}
	const validIds = new Set<string>();
	for (const callId of callIds) {
		if (outputIds.has(callId)) {
			validIds.add(callId);
		}
	}
	if (validIds.size === callIds.size && validIds.size === outputIds.size) {
		return;
	}
	const filtered = messages.filter((message) => {
		if (!("type" in message)) {
			return true;
		}
		if (message.type === "function_call" || message.type === "function_call_output") {
			return !!message.call_id && validIds.has(message.call_id);
		}
		return true;
	});
	messages.splice(0, messages.length, ...filtered);
}

function formatArgsFromSchema(schema: { type?: unknown; properties?: Record<string, unknown>; required?: string[] }): string {
	if (!schema || schema.type !== "object" || !schema.properties) {
		return "(none)";
	}
	const required = new Set(schema.required ?? []);
	const entries = Object.entries(schema.properties)
		.map(([key, value]) => {
			const prop = value as { type?: string | string[] };
			const rawType = prop?.type;
			const type = Array.isArray(rawType) ? rawType.join("|") : rawType ?? "any";
			const reqLabel = required.has(key) ? ", required" : "";
			return `${key} (${type}${reqLabel})`;
		})
		.filter(Boolean);
	return entries.length ? entries.join("; ") : "(none)";
}

function escapeTableCell(value: string): string {
	return value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
}

function renderTable(headers: string[], rows: string[][]): string {
	if (rows.length === 0) {
		return "";
	}
	const head = `| ${headers.join(" | ")} |`;
	const sep = `| ${headers.map(() => "---").join(" | ")} |`;
	const body = rows
		.map((row) => `| ${row.map((cell) => escapeTableCell(cell)).join(" | ")} |`)
		.join("\n");
	return [head, sep, body].join("\n");
}

function formatCallables(title: string, callables: Callable[]): string {
	if (callables.length === 0) {
		return "";
	}
	const toolRows = callables
		.filter(isToolCallable)
		.map((tool) => [
			tool.callName === tool.name ? tool.name : `${tool.name} (call: ${tool.callName})`,
			tool.description ?? "",
			formatArgsFromSchema(tool.inputSchema),
		]);
	const skillRows = callables
		.filter(isSkillCallable)
		.map((skill) => [
			skill.callName === skill.name ? skill.name : `${skill.name} (call: ${skill.callName})`,
			skill.description ?? "",
			"task (string, required); history (array, required)",
		]);
	const blocks: string[] = [];
	const toolTable = renderTable(["Name", "Description", "Args"], toolRows);
	if (toolTable) {
		blocks.push(`# Tools\n${toolTable}`);
	}
	const skillTable = renderTable(["Name", "Description", "Args"], skillRows);
	if (skillTable) {
		blocks.push(`# Skills\n${skillTable}`);
	}
	return `\n# ${title}\n${blocks.join("\n\n")}`;
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
					"Use the tools described below to make changes in the browser.",
					"Call a tool or skill when it matches the request.",
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
	pruneDanglingToolCalls(messages);
	if ((options?.skillDepth ?? 0) === 0) {
		const tokenCounter = options?.tokenCounter;
		if (tokenCounter) {
			const projectedMessages: Message[] = [...messages, { role: "user", content: input }];
			const contextWindow = options?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
			const threshold = options?.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
			const tokenCount = await Promise.resolve(tokenCounter(projectedMessages, options?.model));
			if (tokenCount >= contextWindow * threshold) {
				const compacted = compactHistory(messages);
				if (compacted !== messages) {
					messages.splice(0, messages.length, ...compacted);
				}
			}
		}
	}
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
