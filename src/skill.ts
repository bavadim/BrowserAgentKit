import { pipe } from "fp-ts/lib/function.js";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import type { Callable, SkillCallArgs, ToolDefinition } from "./types";

type SkillFrontmatter = {
	name?: string;
	description?: string;
};

type SkillMarkdown = {
	frontmatter: SkillFrontmatter;
	body: string;
};

const CALLABLE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function normalizeCallableName(name: string, fallback: string): string {
	const trimmed = name.trim();
	if (CALLABLE_NAME_PATTERN.test(trimmed)) {
		return trimmed;
	}
	const sanitized = trimmed
		.replace(/[^a-zA-Z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (sanitized && CALLABLE_NAME_PATTERN.test(sanitized)) {
		return sanitized;
	}
	return fallback;
}

export class Skill {
	public readonly kind = "skill" as const;
	public readonly name: string;
	public readonly callName: string;
	public readonly description?: string;
	public readonly prompt: string;
	public readonly callables: Callable[];

	public constructor(
		name: string,
		description: string | undefined,
		prompt: string,
		callables: Callable[] = []
	) {
		this.name = name;
		this.callName = normalizeCallableName(name, "skill");
		this.description = description;
		this.prompt = prompt;
		this.callables = callables;
	}

	public withCallables(callables: Callable[]): Skill {
		return new Skill(this.name, this.description, this.prompt, callables);
	}

	public formatForList(): string {
		const callName = this.callName !== this.name ? `\nCall name: ${this.callName}` : "";
		const desc = this.description ? `\nDescription: ${this.description}` : "";
		return `## Skill: ${this.name}${callName}${desc}`;
	}

	public buildPrompt(childCallables: Callable[]): E.Either<Error, string> {
		const childSkills = childCallables.filter(Skill.isSkill);
		return pipe(
			Skill.sanitizePrompt(this.prompt),
			O.fromPredicate((text) => text.length > 0),
			O.map((sanitized) => {
				const subskillsBlock = Skill.formatList("Subskills", childSkills);
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

	public toToolDefinition(): ToolDefinition {
		return {
			type: "function",
			name: this.callName,
			description: this.description,
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
							additionalProperties: false,
						},
					},
				},
				required: ["task", "history"],
				additionalProperties: false,
			},
			strict: true,
		};
	}

	public static formatList(title: string, skills: Skill[]): string {
		if (skills.length === 0) {
			return "";
		}
		const skillsBlock = skills.map((skill) => skill.formatForList()).join("\n\n");
		return `\n# ${title}\n${skillsBlock}`;
	}

	public static parseCallArgs(args: unknown): E.Either<Error, SkillCallArgs> {
		return pipe(
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
	}

	public static fromDomSelector(selector: string, doc: Document): Skill {
		const trimmedSelector = selector.trim();
		if (!trimmedSelector) {
			throw new Error("Skill selector must be a non-empty XPath string.");
		}
		const XPathResultRef = doc.defaultView?.XPathResult;
		if (!XPathResultRef) {
			throw new Error("XPathResult is not available in this environment.");
		}
		const result = doc.evaluate(trimmedSelector, doc, null, XPathResultRef.FIRST_ORDERED_NODE_TYPE, null);
		const node = result.singleNodeValue;
		if (!node || node.nodeType !== 1) {
			throw new Error(`Skill markdown not found for selector: ${trimmedSelector}`);
		}
		const rawMarkdown = (node.textContent ?? "").trim();
		if (!rawMarkdown) {
			throw new Error(`Skill markdown is empty for selector: ${trimmedSelector}`);
		}
		const parsed = Skill.parseMarkdown(rawMarkdown);
		const name = parsed.frontmatter.name?.trim();
		if (!name) {
			throw new Error(`Skill frontmatter must include a non-empty name for selector: ${trimmedSelector}`);
		}
		const description = parsed.frontmatter.description?.trim();
		return new Skill(name, description, parsed.body);
	}

	private static sanitizePrompt(prompt: string): string {
		return prompt
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<\/?[^>]+>/g, "")
			.trim();
	}

	private static parseMarkdown(markdown: string): SkillMarkdown {
		const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
		if (!match) {
			throw new Error("Skill markdown must start with YAML frontmatter.");
		}
		const frontmatterText = match[1] ?? "";
		const body = markdown.slice(match[0].length).trim();
		return {
			frontmatter: Skill.parseFrontmatter(frontmatterText),
			body,
		};
	}

	private static parseFrontmatter(frontmatterText: string): SkillFrontmatter {
		const frontmatter: SkillFrontmatter = {};
		for (const line of frontmatterText.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}
			const separatorIndex = trimmed.indexOf(":");
			if (separatorIndex === -1) {
				throw new Error(`Invalid frontmatter line: ${line}`);
			}
			const key = trimmed.slice(0, separatorIndex).trim();
			const value = trimmed.slice(separatorIndex + 1).trim();
			if (!key) {
				throw new Error(`Invalid frontmatter line: ${line}`);
			}
			if (key === "name" || key === "description") {
				frontmatter[key] = Skill.stripQuotes(value);
			}
		}
		return frontmatter;
	}

	private static stripQuotes(value: string): string {
		if (
			(value.startsWith("\"") && value.endsWith("\"")) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			return value.slice(1, -1);
		}
		return value;
	}

	private static isSkill(callable: Callable): callable is Skill {
		return callable.kind === "skill";
	}
}
