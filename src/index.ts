import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { jsInterpreterDescription } from "./descriptions";

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
  viewRoot?: Element;
  context?: Partial<ToolContext>;
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

export function createAgent(options: AgentOptions) {
  const skills = options.skills ?? [];
  const tools = options.tools ?? [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const maxSteps = options.policies?.maxSteps ?? 25;

  async function* run(input: string, runOptions: RunOptions = {}): AsyncGenerator<AgentEvent> {
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
            const result = await tool.run(args, baseContext);
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

type RuntimeEnv = {
  document?: Document;
  localStorage?: Storage;
  window?: Window;
  viewRoot?: Element;
};

function ensureDocument(runtime?: RuntimeEnv): Document {
  const doc =
    runtime?.document ??
    runtime?.viewRoot?.ownerDocument ??
    (typeof document !== "undefined" ? document : undefined);
  if (!doc) {
    throw new Error("No document available in this environment.");
  }
  return doc;
}

function getStorage(runtime?: RuntimeEnv): Storage {
  if (runtime?.localStorage) {
    return runtime.localStorage;
  }
  if (typeof localStorage === "undefined") {
    throw new Error("No localStorage available in this environment.");
  }
  return localStorage;
}

function getViewRoot(doc: Document, runtime?: RuntimeEnv): Node {
  return runtime?.viewRoot ?? doc;
}

function scopeXpath(xpath: string, root: Node): string {
  const trimmed = xpath.trim();
  if (root.nodeType === Node.DOCUMENT_NODE) {
    return trimmed;
  }
  if (trimmed === "/") {
    return ".";
  }
  if (trimmed.startsWith("//") || trimmed.startsWith("/")) {
    return `.${trimmed}`;
  }
  return trimmed;
}

function resolveNode(target: unknown, helpers: { x: (xpath: string, root?: Node) => Node[] }): Node | null {
  if (!target) {
    return null;
  }
  if (target instanceof Node) {
    return target;
  }
  if (Array.isArray(target)) {
    const first = target.find((item) => item instanceof Node) as Node | undefined;
    return first ?? null;
  }
  if (typeof target === "string") {
    return helpers.x(target)[0] ?? null;
  }
  return null;
}

function nodeToString(node: Node | null): string {
  if (!node) {
    return "";
  }
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return Array.from(node.childNodes)
      .map((child) => nodeToString(child))
      .join("");
  }
  if (node.nodeType === Node.DOCUMENT_NODE) {
    const doc = node as Document;
    return doc.documentElement?.outerHTML ?? "";
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).outerHTML;
  }
  return node.textContent ?? "";
}

function createInterpreterHelpers(runtime?: RuntimeEnv) {
  const doc = ensureDocument(runtime);
  const root = getViewRoot(doc, runtime);
  const win = runtime?.window ?? (typeof window !== "undefined" ? window : undefined);
  const winAny = win as (Window & { $?: unknown; jQuery?: unknown }) | undefined;
  const jq = winAny?.$ ?? winAny?.jQuery;

  function x(xpath: string, rootOverride?: unknown): Node[] {
    let baseRoot = root;
    if (rootOverride) {
      if (rootOverride instanceof Node) {
        baseRoot = rootOverride;
      } else if (Array.isArray(rootOverride)) {
        const first = rootOverride.find((item) => item instanceof Node) as Node | undefined;
        if (first) {
          baseRoot = first;
        }
      } else if (typeof rootOverride === "string") {
        const resolved = resolveNode(rootOverride, { x });
        if (resolved) {
          baseRoot = resolved;
        }
      }
    }
    const scoped = scopeXpath(xpath, baseRoot);
    const result = doc.evaluate(scoped, baseRoot, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const nodes: Node[] = [];
    for (let i = 0; i < result.snapshotLength; i += 1) {
      const node = result.snapshotItem(i);
      if (node) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  function replaceSubtree(target: unknown, next: unknown): Node | DocumentFragment | null {
    const resolvedTarget = resolveNode(target, { x });
    if (!resolvedTarget) {
      throw new Error("replaceSubtree: target not found.");
    }

    let replacement: Node | DocumentFragment;
    if (next instanceof Node) {
      replacement = next;
    } else if (typeof next === "string") {
      const template = doc.createElement("template");
      template.innerHTML = next;
      replacement = template.content;
    } else {
      replacement = doc.createTextNode(String(next ?? ""));
    }

    (resolvedTarget as ChildNode).replaceWith(replacement);
    return replacement;
  }

  function diffSubtree(a: unknown, b: unknown) {
    const nodeA = resolveNode(a, { x });
    const nodeB = resolveNode(b, { x });
    const equal = nodeA && nodeB ? nodeA.isEqualNode(nodeB) : nodeA === nodeB;
    return {
      equal,
      before: nodeToString(nodeA),
      after: nodeToString(nodeB),
    };
  }

  return {
    x,
    replaceSubtree,
    diffSubtree,
    viewRoot: root,
    document: doc,
    window: win,
    $: jq,
  };
}

export function jsInterpreterTool(): Tool {
  return {
    name: "jsInterpreter",
    description: jsInterpreterDescription,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source to evaluate." },
        async: { type: "boolean", description: "Whether to run as async." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const { code, async } = args as { code: string; async?: boolean };
      const helpers = createInterpreterHelpers(ctx as RuntimeEnv | undefined);
      if (async) {
        const fn = new Function(
          "helpers",
          `const { x, replaceSubtree, diffSubtree, viewRoot, document, window, $ } = helpers;` +
            `return (async () => { ${code} })()`
        );
        return await fn(helpers);
      }
      const fn = new Function(
        "helpers",
        `const { x, replaceSubtree, diffSubtree, viewRoot, document, window, $ } = helpers;` +
          `return (function () { ${code} })()`
      );
      return fn(helpers);
    },
  };
}

export function localStoreTool(options: { namespace?: string } = {}): Tool {
  const prefix = options.namespace ? `${options.namespace}:` : "";
  return {
    name: "localStore",
    description: "Read and write small values in browser localStorage.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", description: "Operation: get, set, remove, keys." },
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { op, key, value } = args as { op: string; key?: string; value?: string };
      const storage = getStorage(ctx as RuntimeEnv | undefined);

      switch (op) {
        case "get": {
          if (!key) {
            throw new Error("localStore.get requires key");
          }
          return storage.getItem(`${prefix}${key}`);
        }
        case "set": {
          if (!key) {
            throw new Error("localStore.set requires key");
          }
          storage.setItem(`${prefix}${key}`, value ?? "");
          return { ok: true };
        }
        case "remove": {
          if (!key) {
            throw new Error("localStore.remove requires key");
          }
          storage.removeItem(`${prefix}${key}`);
          return { ok: true };
        }
        case "keys": {
          const keys: string[] = [];
          for (let i = 0; i < storage.length; i += 1) {
            const storedKey = storage.key(i);
            if (!storedKey) {
              continue;
            }
            if (storedKey.startsWith(prefix)) {
              keys.push(storedKey.slice(prefix.length));
            }
          }
          return keys;
        }
        default:
          throw new Error(`Unknown localStore op: ${op}`);
      }
    },
  };
}
