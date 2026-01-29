import type {
	EasyInputMessage,
	ResponseInputItem,
	Tool as ResponseTool,
} from "openai/resources/responses/responses";
import type { Either } from "fp-ts/lib/Either.js";

export type JsonSchema = {
	type: string;
	description?: string;
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
	items?: JsonSchema;
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
	promptSelector: string;
	allowedSkills?: Skill[];
	tools?: Tool[];
};

export type ToolCall = {
	id?: string;
	name: string;
	args: unknown;
};

export type Message = EasyInputMessage | ResponseInputItem;
export type ToolDefinition = ResponseTool;

export type SkillCallArgs = {
	task: string;
	history?: EasyInputMessage[];
};

export enum AgentStatusKind {
	Thinking = "thinking",
	CallingTool = "calling_tool",
	ToolResult = "tool_result",
	Done = "done",
}

export type AgentStatus = {
	kind: AgentStatusKind;
	label?: string;
	toolName?: string;
};

export type ToolStartBase = {
	type: "tool.start";
	name: string;
	args: unknown;
	callId?: string;
};

export type SkillToolStart = ToolStartBase & {
	isSkill: true;
	depth: number;
	input: SkillCallArgs;
};

export type ToolStart = ToolStartBase | (ToolStartBase & { isSkill?: false }) | SkillToolStart;

export type ToolEndBase = {
	type: "tool.end";
	name: string;
	result: unknown;
};

export type SkillToolEnd = ToolEndBase & {
	isSkill: true;
	depth: number;
};

export type ToolEnd = ToolEndBase | (ToolEndBase & { isSkill?: false }) | SkillToolEnd;

export type AgentEvent =
	| { type: "message"; content: string }
	| { type: "message.delta"; delta: string }
	| { type: "thinking"; summary: string }
	| { type: "thinking.delta"; delta: string }
	| { type: "status"; status: AgentStatus }
	| ToolStart
	| ToolEnd
	| { type: "artifact"; name: string; data: unknown }
	| { type: "done" };

export type AgentStreamEvent = Either<Error, AgentEvent>;

export type AgentGenerate = (
	messages: Message[],
	tools?: ToolDefinition[],
	signal?: AbortSignal
) => AsyncIterable<AgentStreamEvent>;
