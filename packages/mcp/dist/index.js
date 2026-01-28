export function mcpTool(options) {
    return {
        name: "mcp",
        description: "Call a remote MCP endpoint with a JSON-RPC style payload.",
        parameters: {
            type: "object",
            properties: {
                method: { type: "string" },
                params: { type: "object" },
            },
            required: ["method"],
            additionalProperties: false,
        },
        async run(args) {
            const { method, params } = args;
            const payload = {
                jsonrpc: "2.0",
                id: Date.now(),
                method,
                params: params ?? {},
            };
            const response = await fetch(options.endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
            }
            return response.json();
        },
    };
}
//# sourceMappingURL=index.js.map