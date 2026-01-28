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
export function createAgent(options) {
    const skills = options.skills ?? [];
    const tools = options.tools ?? [];
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    const maxSteps = options.policies?.maxSteps ?? 25;
    async function* run(input, runOptions = {}) {
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
                        const result = await tool.run(args, { runtime: options.runtime, signal: runOptions.signal });
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
//# sourceMappingURL=index.js.map