import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Message, Skill, SkillCallArgs, Tool, ToolContext, ToolDefinition } from "./types";

export function formatSkills(title: string, skills: Skill[]): string {
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

export const parseSkillCallArgs = (args: unknown): E.Either<Error, SkillCallArgs> =>
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

export function buildSkillPrompt(prompt: string, childSkills: Skill[]): E.Either<Error, string> {
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

export function resolveSkillPrompt(skill: Skill, ctx: ToolContext): string {
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
	const resolvedPrompt = (node.textContent ?? "").trim();
	if (!resolvedPrompt) {
		throw new Error(`Skill prompt is empty for selector: ${selector}`);
	}
	return resolvedPrompt;
}

export function buildSkillMessages(
	basePrompt: string,
	prompt: string,
	input: SkillCallArgs,
	history: Message[] = []
): Message[] {
	return [
		{ role: "system", content: basePrompt },
		{ role: "system", content: prompt },
		...history,
		{ role: "user", content: input.task },
	];
}

export function withSystemAfter(messages: Message[], skillMessage: Message | null): Message[] {
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
}

export function toOpenAITools(tools: Tool[], skills: Skill[]): ToolDefinition[] | undefined {
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
