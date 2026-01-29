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
) => AsyncIterable<StreamingEvent> | Promise<AsyncIterable<StreamingEvent>>;

export enum StreamingEventType {
	ResponseQueued = "response.queued",
	ResponseCreated = "response.created",
	ResponseInProgress = "response.in_progress",
	ResponseOutputTextDelta = "response.output_text.delta",
	ResponseOutputTextDone = "response.output_text.done",
	ResponseReasoningSummaryTextDelta = "response.reasoning_summary_text.delta",
	ResponseReasoningSummaryTextDone = "response.reasoning_summary_text.done",
	ResponseFunctionCallArgumentsDelta = "response.function_call_arguments.delta",
	ResponseFunctionCallArgumentsDone = "response.function_call_arguments.done",
	ResponseCompleted = "response.completed",
	ResponseFailed = "response.failed",
	Error = "error",
}

export type StreamingEvent =
	| { type: StreamingEventType.ResponseQueued }
	| { type: StreamingEventType.ResponseCreated }
	| { type: StreamingEventType.ResponseInProgress }
	| { type: StreamingEventType.ResponseOutputTextDelta; item_id?: string; delta: string }
	| { type: StreamingEventType.ResponseOutputTextDone; item_id?: string; text: string }
	| { type: StreamingEventType.ResponseReasoningSummaryTextDelta; item_id?: string; delta: string }
	| { type: StreamingEventType.ResponseReasoningSummaryTextDone; item_id?: string; text: string }
	| { type: StreamingEventType.ResponseFunctionCallArgumentsDelta; item_id: string; delta: string }
	| { type: StreamingEventType.ResponseFunctionCallArgumentsDone; item_id: string; name?: string; arguments?: string }
	| { type: StreamingEventType.ResponseCompleted }
	| { type: StreamingEventType.ResponseFailed; error?: unknown }
	| { type: StreamingEventType.Error; error: unknown };

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
	| { type: "tool.start"; name: string; args: unknown }
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
