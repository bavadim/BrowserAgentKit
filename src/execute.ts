import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
	Message,
	RunAgentOptions,
	Skill,
	SkillCallArgs,
	Tool,
	ToolCall,
	ToolContext,
	ToolEnd,
	ToolStart,
} from "./types";
import { buildSkillPrompt, resolveSkillPrompt } from "./skill";
import { addToolOutput } from "./loop";

export type CallTarget =
	| { kind: "tool"; tool: Tool }
	| { kind: "skill"; skill: Skill; input: SkillCallArgs; depth: number };

export type StreamOutcome = "continue" | "stop" | "error";

export type RunAgent = (
	messages: Message[],
	generate: AgentGenerate,
	input: string,
	tools?: Tool[],
	skills?: Skill[],
	maxSteps?: number,
	context?: Partial<ToolContext>,
	signal?: AbortSignal,
	options?: RunAgentOptions
) => AsyncIterable<AgentStreamEvent>;

const toError = (error: unknown): Error =>
	error instanceof Error ? error : new Error(String(error));

const right = (event: AgentEvent): AgentStreamEvent => E.right(event);
const left = (error: Error): AgentStreamEvent => E.left(error);

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
	const childSkills = target.skill.allowedSkills ?? [];
	const childTools = target.skill.tools ?? [];
	const skillPromptResult = pipe(
		E.tryCatch(() => resolveSkillPrompt(target.skill, ctx), toError),
		E.chain((prompt) => buildSkillPrompt(prompt, childSkills))
	);

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
				childTools,
				childSkills,
				maxSteps,
				ctx,
				signal,
				{
					skillDepth: target.depth,
					skillListMessage: null,
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
