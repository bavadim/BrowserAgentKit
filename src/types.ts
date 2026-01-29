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

export type ToolSchema = {
	name: string;
	description?: string;
	parameters?: JsonSchema;
};

export type ToolContext = {
	viewRoot?: Element;
	document?: Document;
	window?: Window;
	localStorage?: Storage;
	signal?: AbortSignal;
};

export type Tool = ToolSchema & {
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

export type GenerateRequest = {
	messages: Message[];
	tools?: ToolDefinition[];
	signal?: AbortSignal;
};

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

export type ResponseQueuedEvent = { type: StreamingEventType.ResponseQueued };
export type ResponseCreatedEvent = { type: StreamingEventType.ResponseCreated };
export type ResponseInProgressEvent = { type: StreamingEventType.ResponseInProgress };

export type ResponseOutputTextDeltaEvent = {
	type: StreamingEventType.ResponseOutputTextDelta;
	item_id?: string;
	delta: string;
};

export type ResponseOutputTextDoneEvent = {
	type: StreamingEventType.ResponseOutputTextDone;
	item_id?: string;
	text: string;
};

export type ResponseReasoningSummaryTextDeltaEvent = {
	type: StreamingEventType.ResponseReasoningSummaryTextDelta;
	item_id?: string;
	delta: string;
};

export type ResponseReasoningSummaryTextDoneEvent = {
	type: StreamingEventType.ResponseReasoningSummaryTextDone;
	item_id?: string;
	text: string;
};

export type ResponseFunctionCallArgumentsDeltaEvent = {
	type: StreamingEventType.ResponseFunctionCallArgumentsDelta;
	item_id: string;
	delta: string;
};

export type ResponseFunctionCallArgumentsDoneEvent = {
	type: StreamingEventType.ResponseFunctionCallArgumentsDone;
	item_id: string;
	name?: string;
	arguments?: string;
};

export type ResponseCompletedEvent = { type: StreamingEventType.ResponseCompleted };
export type ResponseFailedEvent = { type: StreamingEventType.ResponseFailed; error?: unknown };
export type ResponseErrorEvent = { type: StreamingEventType.Error; error: unknown };

export type StreamingEvent =
	| ResponseQueuedEvent
	| ResponseCreatedEvent
	| ResponseInProgressEvent
	| ResponseOutputTextDeltaEvent
	| ResponseOutputTextDoneEvent
	| ResponseReasoningSummaryTextDeltaEvent
	| ResponseReasoningSummaryTextDoneEvent
	| ResponseFunctionCallArgumentsDeltaEvent
	| ResponseFunctionCallArgumentsDoneEvent
	| ResponseCompletedEvent
	| ResponseFailedEvent
	| ResponseErrorEvent;

export type Generate = (
	req: GenerateRequest
) => AsyncIterable<StreamingEvent> | Promise<AsyncIterable<StreamingEvent>>;

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
