import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Model, ModelMessage, ModelRequest, ModelResponse, ToolCall, ToolSchema } from "./agent";

export type OpenAIModelOptions = {
	apiKey?: string;
	baseURL?: string;
	model: string;
	dangerouslyAllowBrowser?: boolean;
	client?: OpenAI;
};

function toOpenAIMessages(messages: ModelMessage[]): ChatCompletionMessageParam[] {
	return messages.map((msg) => {
		if (msg.role === "tool") {
			return {
				role: "tool",
				content: msg.content,
				tool_call_id: msg.toolCallId ?? "tool-call",
			};
		}
		if (msg.role === "assistant") {
			return {
				role: "assistant",
				content: msg.content,
				name: msg.name,
			};
		}
		if (msg.role === "system") {
			return {
				role: "system",
				content: msg.content,
				name: msg.name,
			};
		}
		return {
			role: "user",
			content: msg.content,
			name: msg.name,
		};
	});
}

function toOpenAITools(tools: ToolSchema[] | undefined): ChatCompletionTool[] | undefined {
	if (!tools || tools.length === 0) {
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

function fromOpenAIToolCalls(raw: unknown): ToolCall[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((call) => {
			if (!call || typeof call !== "object") {
				return null;
			}
			const callObj = call as {
				id?: string;
				function?: { name?: string; arguments?: string };
			};
			const name = callObj.function?.name;
			if (!name) {
				return null;
			}
			return {
				id: callObj.id,
				name,
				args: callObj.function?.arguments ?? "{}",
			} as ToolCall;
		})
		.filter((call): call is ToolCall => call !== null);
}

export class OpenAIModel implements Model {
	private client: OpenAI;
	private model: string;

	constructor(options: OpenAIModelOptions) {
		this.client =
			options.client ??
			new OpenAI({
				apiKey: options.apiKey,
				baseURL: options.baseURL,
				dangerouslyAllowBrowser: options.dangerouslyAllowBrowser ?? true,
			});
		this.model = options.model;
	}

	async generate(req: ModelRequest): Promise<ModelResponse> {
		const response = await this.client.chat.completions.create(
			{
				model: this.model,
				messages: toOpenAIMessages(req.messages),
				tools: toOpenAITools(req.tools),
				tool_choice: req.tools?.length ? "auto" : undefined,
			},
			req.signal ? { signal: req.signal } : undefined
		);

		const message = response.choices?.[0]?.message;
		if (!message) {
			return { raw: response };
		}

		const toolCalls = fromOpenAIToolCalls(message.tool_calls);
		return {
			message: message.content ?? undefined,
			toolCalls,
			raw: response,
		};
	}
}
