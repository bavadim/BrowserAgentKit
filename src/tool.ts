import type { JsonSchema, ToolAction, ToolContext, ToolDefinition } from "./types";

export class Tool {
	public readonly kind = "tool" as const;
	public readonly name: string;
	public readonly description?: string;
	public readonly inputSchema: JsonSchema;
	public readonly outputSchema: JsonSchema;
	private readonly action: ToolAction;

	public constructor(
		name: string,
		description: string | undefined,
		action: ToolAction,
		inputSchema: JsonSchema,
		outputSchema: JsonSchema
	) {
		this.name = name;
		this.description = description;
		this.action = action;
		this.inputSchema = inputSchema;
		this.outputSchema = outputSchema;
	}

	public run(args: unknown, ctx: ToolContext): Promise<unknown> | unknown {
		return this.action(args, ctx);
	}

	public toToolDefinition(): ToolDefinition {
		return {
			type: "function",
			name: this.name,
			description: this.description,
			parameters: this.inputSchema,
			strict: true,
		};
	}

	public formatForList(): string {
		const desc = this.description ? `\nDescription: ${this.description}` : "";
		return `## Tool: ${this.name}${desc}`;
	}
}
