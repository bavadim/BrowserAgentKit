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

export type AgentEvent =
  | { type: "message"; content: string }
  | { type: "tool.start"; name: string; args: unknown }
  | { type: "tool.end"; name: string; result: unknown }
  | { type: "artifact"; name: string; data: unknown }
  | { type: "error"; error: unknown }
  | { type: "done" };

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
    return JSON.parse(trimmed);
  } catch {
    return args;
  }
}

export function createAgent(options: AgentOptions) {
  const skills = options.skills ?? [];
  const tools = options.tools ?? [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const maxSteps = options.policies?.maxSteps ?? 25;

  async function* run(input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent> {
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
        response = await options.model.generate({
          messages,
          tools: toolSchemas,
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
              name: call.name,
              content: JSON.stringify({ error: error.message }),
              toolCallId: call.id,
            });
            continue;
          }

          const args = normalizeToolArgs(call.args);
          yield { type: "tool.start", name: call.name, args };
          try {
            const result = await tool.run(args, { runtime: options.runtime, signal: runOptions.signal });
            yield { type: "tool.end", name: call.name, result };
            messages.push({
              role: "tool",
              name: call.name,
              content: JSON.stringify(result ?? null),
              toolCallId: call.id,
            });
          } catch (error) {
            yield { type: "error", error };
            messages.push({
              role: "tool",
              name: call.name,
              content: JSON.stringify({ error: String(error) }),
              toolCallId: call.id,
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
