import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
	Callable,
	Message,
	RunAgentOptions,
	SkillCallArgs,
	ToolCall,
	ToolContext,
	ToolEnd,
	ToolStart,
} from "./types";
import type { Skill } from "./skill";
import type { Tool } from "./tool";

export type CallTarget =
	| { kind: "tool"; tool: Tool }
	| { kind: "skill"; skill: Skill; input: SkillCallArgs; depth: number };

export type StreamOutcome = "continue" | "stop" | "error";

export type LoopState = {
	toolCalls: ToolCall[];
	textBuffer: string;
	finalText: string | null;
	reasoningSummaryBuffer: string;
	finalReasoningSummary: string | null;
	sawMessage: boolean;
	sawThinking: boolean;
};

export type StepOutcome = "continue" | "stop";

export type RunAgent = (
	messages: Message[],
	generate: AgentGenerate,
	input: string,
	callables?: Callable[],
	maxSteps?: number,
	context?: Partial<ToolContext>,
	signal?: AbortSignal,
	options?: RunAgentOptions
) => AsyncIterable<AgentStreamEvent>;

const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));

const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

export const initLoopState = (): LoopState => ({
	toolCalls: [],
	textBuffer: "",
	finalText: null,
	reasoningSummaryBuffer: "",
	finalReasoningSummary: null,
	sawMessage: false,
	sawThinking: false,
});

export const applyStreamEvent = (
	state: LoopState,
	event: AgentEvent
): { outcome: StepOutcome; outputs: AgentEvent[] } => {
	switch (event.type) {
		case "message.delta":
			state.textBuffer += event.delta;
			return { outcome: "continue", outputs: [event] };
		case "message":
			state.finalText = event.content;
			state.sawMessage = true;
			return { outcome: "continue", outputs: [event] };
		case "thinking.delta":
			state.reasoningSummaryBuffer += event.delta;
			return { outcome: "continue", outputs: [event] };
		case "thinking":
			state.finalReasoningSummary = event.summary;
			state.sawThinking = true;
			return { outcome: "continue", outputs: [event] };
		case "tool.start":
			state.toolCalls.push({ id: event.callId, name: event.name, args: event.args });
			return { outcome: "continue", outputs: [] };
		case "tool.end":
		case "artifact":
			return { outcome: "continue", outputs: [event] };
		case "done":
			return { outcome: "stop", outputs: [] };
		default:
			return { outcome: "continue", outputs: [] };
	}
};

export const flushThinking = (state: LoopState): AgentEvent | null => {
	if (state.sawThinking) {
		return null;
	}
	const summaryText = state.finalReasoningSummary ?? state.reasoningSummaryBuffer;
	return summaryText ? { type: "thinking", summary: summaryText } : null;
};

export const finalContent = (state: LoopState): string => state.finalText ?? state.textBuffer;

export function addToolOutput(messages: Message[], callId: string, output: unknown): void {
	const serialized = typeof output === "string" ? output : JSON.stringify(output ?? null);
	messages.push({
		type: "function_call_output",
		call_id: callId,
		output: serialized,
	});
}

export function addToolCall(messages: Message[], call: ToolCall): void {
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

type SkillRunResult = { output: string; events: AgentEvent[] };

export async function runSkill(
	target: Extract<CallTarget, { kind: "skill" }>,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	maxSteps: number,
	generate: AgentGenerate,
	runAgent: RunAgent,
	basePrompt: string
): Promise<E.Either<Error, SkillRunResult>> {
	const childCallables = target.skill.callables ?? [];
	const skillPromptResult = target.skill.buildPrompt(childCallables);

	return pipe(
		skillPromptResult,
		E.matchW(async (error) => E.left(error), async (skillPrompt) => {
			const nestedMessages: Message[] = [
				{ role: "system", content: basePrompt },
				{ role: "system", content: skillPrompt },
				...(target.input.history ?? []),
			];
			const skillEvents: AgentEvent[] = [];
			let skillText = "";
			for await (const ev of runAgent(
				nestedMessages,
				generate,
				target.input.task,
				childCallables,
				maxSteps,
				ctx,
				signal,
				{
					skillDepth: target.depth,
					callableListMessage: null,
					skipActiveRuns: true,
				}
			)) {
				if (E.isLeft(ev)) {
					return E.left(ev.left);
				}
				const event = ev.right;
				if (event.type === "message") {
					skillText = event.content;
					continue;
				}
				if (
					(event.type === "tool.start" || event.type === "tool.end") &&
					"isSkill" in event &&
					event.isSkill
				) {
					skillEvents.push(event);
				}
			}
			return E.right({ output: skillText, events: skillEvents });
		})
	);
}

export async function* runToolCall(
	call: ToolCall,
	args: unknown,
	target: CallTarget,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	maxSteps: number,
	generate: AgentGenerate,
	runAgent: RunAgent,
	basePrompt: string,
	loopMessages: Message[]
): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
	yield right(toolStartEvent(call, args, target));
	if (target.kind === "skill") {
		const result = await runSkill(target, ctx, signal, maxSteps, generate, runAgent, basePrompt);
		if (E.isLeft(result)) {
			yield left(result.left);
			return "error";
		}
		for (const event of result.right.events) {
			yield right(event);
		}
		yield right(toolEndEvent(call, result.right.output, target));
		addToolOutput(loopMessages, call.id ?? "tool-call", result.right.output ?? null);
		return "continue";
	}
	const result = await Promise.resolve()
		.then(() => target.tool.run(args, ctx))
		.then(E.right)
		.catch((error) => E.left(toError(error)));
	if (E.isLeft(result)) {
		yield left(result.left);
		return "error";
	}
	yield right(toolEndEvent(call, result.right, target));
	addToolOutput(loopMessages, call.id ?? "tool-call", result.right ?? null);
	return "continue";
}
