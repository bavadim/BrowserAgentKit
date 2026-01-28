function toOpenAIMessages(messages) {
    return messages.map((msg) => {
        const base = {
            role: msg.role,
            content: msg.content,
        };
        if (msg.name) {
            base.name = msg.name;
        }
        if (msg.toolCallId) {
            base.tool_call_id = msg.toolCallId;
        }
        return base;
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
        this.baseUrl = options.baseUrl;
        this.key = options.key;
        this.model = options.model;
        this.headers = options.headers;
    }
    async generate(req) {
        const body = {
            model: this.model,
            messages: toOpenAIMessages(req.messages),
            tools: toOpenAITools(req.tools),
            tool_choice: "auto",
        };
        const headers = {
            "Content-Type": "application/json",
            ...this.headers,
        };
        if (this.key) {
            headers.Authorization = `Bearer ${this.key}`;
        }
        const response = await fetch(this.baseUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: req.signal,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`OpenAI request failed: ${response.status} ${response.statusText} ${text}`);
        }
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        if (!message) {
            return { raw: data };
        }
        const toolCalls = fromOpenAIToolCalls(message.tool_calls);
        return {
            message: message.content ?? undefined,
            toolCalls,
            raw: data,
        };
    }
}
//# sourceMappingURL=index.js.map