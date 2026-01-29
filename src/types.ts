import type {
	EasyInputMessage,
	ResponseInputItem,
	Tool as ResponseTool,
} from "openai/resources/responses/responses";

export type JsonSchema = {
	type: string;
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
};

export type ToolContext = {
	viewRoot?: Element;
	document?: Document;
	window?: Window;
	localStorage?: Storage;
	signal?: AbortSignal;
};

export type Tool = {
	name: string;
	description?: string;
	parameters?: JsonSchema;
	run: (args: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
};

export type Skill = {
	name: string;
	description?: string;
	promptMd: string;
};

export type ToolCall = {
	id?: string;
	name: string;
	args: unknown;
};

export type Message = EasyInputMessage | ResponseInputItem;
export type ToolDefinition = ResponseTool;

export type Generate = (
	messages: Message[],
	tools?: ToolDefinition[],
	signal?: AbortSignal
) => AsyncIterable<AgentEvent> | Promise<AsyncIterable<AgentEvent>>;

export type AgentPolicies = {
	maxSteps?: number;
};

export enum AgentStatusKind {
	Thinking = "thinking",
	CallingTool = "calling_tool",
	ToolResult = "tool_result",
	Done = "done",
	Error = "error",
}

export type AgentStatus = {
	kind: AgentStatusKind;
	label?: string;
	toolName?: string;
};

export type AgentEvent =
	| { type: "message"; content: string }
	| { type: "message.delta"; delta: string }
	| { type: "thinking"; summary: string }
	| { type: "thinking.delta"; delta: string }
	| { type: "status"; status: AgentStatus }
	| { type: "tool.start"; name: string; args: unknown; callId?: string }
	| { type: "tool.end"; name: string; result: unknown }
	| { type: "artifact"; name: string; data: unknown }
	| { type: "error"; error: unknown }
	| { type: "done" };

export type AgentOptions = {
	generate: Generate;
	viewRoot?: Element;
	context?: Partial<ToolContext>;
	skills?: Skill[];
	tools?: Tool[];
	policies?: AgentPolicies;
};

export type RunOptions = {
	signal?: AbortSignal;
};

export type AgentRunner = {
	run: (input: string, runOptions?: RunOptions) => AsyncGenerator<AgentEvent, void, void>;
	reset: () => void;
};
