import OpenAI from "openai";
function buildSystemPrompt(skills) {
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
function normalizeToolArgs(args) {
    if (typeof args !== "string") {
        return args;
    }
    const trimmed = args.trim();
    if (!trimmed) {
        return {};
    }
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return args;
    }
}
function resolveBrowserContext(options, runOptions) {
    const hasWindow = typeof window !== "undefined";
    const viewRoot = options.viewRoot ?? options.context?.viewRoot;
    const docFromRoot = viewRoot?.ownerDocument;
    return {
        viewRoot,
        document: options.context?.document ?? docFromRoot ?? (hasWindow ? document : undefined),
        window: options.context?.window ?? (hasWindow ? window : undefined),
        localStorage: options.context?.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : undefined),
        signal: runOptions.signal,
    };
}
export function createAgent(options) {
    const skills = options.skills ?? [];
    const tools = options.tools ?? [];
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const maxSteps = options.policies?.maxSteps ?? 25;
    async function* run(input, runOptions = {}) {
        const baseContext = resolveBrowserContext(options, runOptions);
        const messages = [];
        const systemPrompt = buildSystemPrompt(skills);
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: input });
        const toolSchemas = tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        }));
        let step = 0;
        while (step < maxSteps) {
            step += 1;
            let response;
            try {
                response = await options.model.generate({
                    messages,
                    tools: toolSchemas,
                    signal: runOptions.signal,
                });
            }
            catch (error) {
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
                    }
                    catch (error) {
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
function toOpenAIMessages(messages) {
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
function toOpenAITools(tools) {
    if (!tools || tools.length === 0) {
        return undefined;
    }
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? { type: "object" },
        },
    }));
}
function fromOpenAIToolCalls(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .map((call) => {
        if (!call || typeof call !== "object") {
            return null;
        }
        const callObj = call;
        const name = callObj.function?.name;
        if (!name) {
            return null;
        }
        return {
            id: callObj.id,
            name,
            args: callObj.function?.arguments ?? "{}",
        };
    })
        .filter((call) => call !== null);
}
export class OpenAIModel {
    constructor(options) {
        this.client =
            options.client ??
                new OpenAI({
                    apiKey: options.apiKey,
                    baseURL: options.baseURL,
                    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser ?? true,
                });
        this.model = options.model;
    }
    async generate(req) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: toOpenAIMessages(req.messages),
            tools: toOpenAITools(req.tools),
            tool_choice: req.tools?.length ? "auto" : undefined,
        }, req.signal ? { signal: req.signal } : undefined);
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
//# sourceMappingURL=index.js.map