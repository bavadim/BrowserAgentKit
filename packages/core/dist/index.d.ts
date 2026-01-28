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
    runtime?: unknown;
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
export type ModelMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    toolCallId?: string;
};
export type ToolCall = {
    id?: string;
    name: string;
    args: unknown;
};
export type ModelRequest = {
    messages: ModelMessage[];
    tools?: ToolSchema[];
    signal?: AbortSignal;
};
export type ModelResponse = {
    message?: string;
    toolCalls?: ToolCall[];
    raw?: unknown;
};
export type Model = {
    generate: (req: ModelRequest) => Promise<ModelResponse>;
};
export type AgentPolicies = {
    maxSteps?: number;
};
export type AgentEvent = {
    type: "message";
    content: string;
} | {
    type: "tool.start";
    name: string;
    args: unknown;
} | {
    type: "tool.end";
    name: string;
    result: unknown;
} | {
    type: "artifact";
    name: string;
    data: unknown;
} | {
    type: "error";
    error: unknown;
} | {
    type: "done";
};
export type AgentOptions = {
    model: Model;
    runtime?: unknown;
    skills?: Skill[];
    tools?: Tool[];
    policies?: AgentPolicies;
};
export type RunOptions = {
    signal?: AbortSignal;
};
export declare function createAgent(options: AgentOptions): {
    run: (input: string, runOptions?: RunOptions) => AsyncGenerator<AgentEvent>;
};
//# sourceMappingURL=index.d.ts.map