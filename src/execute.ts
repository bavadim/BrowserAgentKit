import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import type {
	AgentEvent,
	AgentGenerate,
	AgentStreamEvent,
	Message,
	Skill,
	SkillCallArgs,
	Tool,
	ToolCall,
	ToolContext,
	ToolEnd,
	ToolStart,
} from "./types";
import { buildSkillMessages, buildSkillPrompt, resolveSkillPrompt } from "./skill";
import { addToolOutput } from "./loop";

export type CallTarget =
	| { kind: "tool"; tool: Tool }
	| { kind: "skill"; skill: Skill; input: SkillCallArgs; depth: number };

export type StreamOutcome = "continue" | "stop" | "error";

export type RunLoop = (
	messages: Message[],
	signal: AbortSignal | undefined,
	ctx: ToolContext,
	tools: Tool[],
	skills: Skill[],
	skillDepth: number,
	skillListMessage: Message | null,
	maxSteps: number,
	generate: AgentGenerate
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

const failSkill = async function* (
	error: Error
): AsyncGenerator<AgentStreamEvent, E.Either<Error, string>, void> {
	return E.left(error);
};

export const runSkill = async function* (
	target: Extract<CallTarget, { kind: "skill" }>,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	maxSteps: number,
	generate: AgentGenerate,
	runLoop: RunLoop,
	basePrompt: string
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
					basePrompt,
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
						E.match<Error, AgentEvent, { kind: "error"; error: Error } | { kind: "event"; event: AgentEvent }>(
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

export async function* runToolCall(
	call: ToolCall,
	args: unknown,
	target: CallTarget,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	maxSteps: number,
	generate: AgentGenerate,
	runLoop: RunLoop,
	basePrompt: string,
	loopMessages: Message[]
): AsyncGenerator<AgentStreamEvent, StreamOutcome, void> {
	yield right(toolStartEvent(call, args, target));
	const result = target.kind === "skill"
		? yield* runSkill(target, ctx, signal, maxSteps, generate, runLoop, basePrompt)
		: await Promise.resolve()
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
