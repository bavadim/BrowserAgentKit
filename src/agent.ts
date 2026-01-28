import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type {
	AgentOptions,
	AgentRunner,
	AgentEvent,
	ModelMessage,
	ModelResponse,
	RunOptions,
	Skill,
	Tool,
	ToolContext,
	ToolSchema,
} from "./types";

function buildSystemPrompt(skills: Skill[]): string {
	if (skills.length === 0) {
		return "You are a browser-based code agent. Use tools when helpful and respond succinctly.";
	}

	const skillsBlock = skills
		.map((skill) => {
			const desc = skill.description ? `\nDescription: ${skill.description}` : "";
			return `## Skill: ${skill.name}${desc}\n\n${skill.promptMd.trim()}`;
		})
		.join("\n\n");

	return [
		"You are a browser-based code agent.",
		"Select and follow a relevant skill when it matches the request.",
		"Use available tools to complete the steps and return a short result.",
		"\n# Skills",
		skillsBlock,
	].join("\n");
}

function normalizeToolArgs(args: unknown): unknown {
	if (typeof args !== "string") {
		return args;
	}
	const trimmed = args.trim();
	if (!trimmed) {
		return {};
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return args;
	}
}

function resolveBrowserContext(options: AgentOptions, runOptions: RunOptions): ToolContext {
	const hasWindow = typeof window !== "undefined";
	const viewRoot = options.viewRoot ?? options.context?.viewRoot;
	const docFromRoot = viewRoot?.ownerDocument;

	return {
		viewRoot,
		document: options.context?.document ?? docFromRoot ?? (hasWindow ? document : undefined),
		window: options.context?.window ?? (hasWindow ? window : undefined),
		localStorage:
			options.context?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined),
		signal: runOptions.signal,
	};
}

function toOpenAITools(tools: ToolSchema[]): ChatCompletionTool[] | undefined {
	if (tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters ?? { type: "object" },
		},
	}));
}

export function createAgent(options: AgentOptions): AgentRunner {
	const skills = options.skills ?? [];
	const tools = options.tools ?? [];
	const toolMap = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]));
	const maxSteps = options.policies?.maxSteps ?? 25;

	async function* run(input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent, void, void> {
		const baseContext = resolveBrowserContext(options, runOptions);
		const messages: ModelMessage[] = [];
		const systemPrompt = buildSystemPrompt(skills);
		if (systemPrompt) {
			messages.push({ role: "system", content: systemPrompt });
		}
		messages.push({ role: "user", content: input });

		const toolSchemas: ToolSchema[] = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}));

		let step = 0;
		while (step < maxSteps) {
			step += 1;
			let response: ModelResponse;
			try {
				response = await options.generate({
					messages,
					tools: toOpenAITools(toolSchemas),
					signal: runOptions.signal,
				});
			} catch (error) {
				yield { type: "error", error };
				break;
			}

			const toolCalls = response.toolCalls ?? [];
			if (toolCalls.length > 0) {
				for (const call of toolCalls) {
					const tool = toolMap.get(call.name);
					if (!tool) {
						const error = new Error(`Unknown tool: ${call.name}`);
						yield { type: "error", error };
						messages.push({
							role: "tool",
							content: JSON.stringify({ error: error.message }),
							tool_call_id: call.id ?? "tool-call",
						});
						continue;
					}

					const args = normalizeToolArgs(call.args);
					yield { type: "tool.start", name: call.name, args };
					try {
						const result = await tool.run(args, baseContext);
						yield { type: "tool.end", name: call.name, result };
						messages.push({
							role: "tool",
							content: JSON.stringify(result ?? null),
							tool_call_id: call.id ?? "tool-call",
						});
					} catch (error) {
						yield { type: "error", error };
						messages.push({
							role: "tool",
							content: JSON.stringify({ error: String(error) }),
							tool_call_id: call.id ?? "tool-call",
						});
					}
				}
				continue;
			}

			if (response.message) {
				messages.push({ role: "assistant", content: response.message });
				yield { type: "message", content: response.message };
				break;
			}

			break;
		}

		yield { type: "done" };
	}

	return { run };
}
