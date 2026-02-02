import { Tool } from "./tools";
import type { McpClient, McpHttpClientOptions, McpTool, McpToolResult } from "./types";

const DEFAULT_HEADERS: Record<string, string> = {
	"Content-Type": "application/json",
};

type McpToolsListResponse = {
	tools?: McpTool[];
	error?: { message?: string };
};

type McpToolsCallResponse = {
	content?: unknown;
	metadata?: unknown;
	error?: { message?: string };
};

function joinUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`MCP request failed (${response.status}): ${url}`);
	}
	return (await response.json()) as T;
}

function parseError(error: { message?: string } | undefined, fallback: string): Error {
	const message = error?.message?.trim();
	if (message) {
		return new Error(message);
	}
	return new Error(fallback);
}

export function createMcpHttpClient(options: McpHttpClientOptions): McpClient {
	const headers = { ...DEFAULT_HEADERS };
	if (options.bearerToken) {
		headers.Authorization = `Bearer ${options.bearerToken}`;
	}
	const baseUrl = options.baseUrl;

	return {
		async listTools(): Promise<McpTool[]> {
			const url = joinUrl(baseUrl, "tools/list");
			const result = await postJson<McpToolsListResponse>(url, {}, headers);
			if (result.error) {
				throw parseError(result.error, `MCP tools/list failed: ${url}`);
			}
			return result.tools ?? [];
		},
		async callTool(name: string, args: unknown): Promise<McpToolResult> {
			const url = joinUrl(baseUrl, "tools/call");
			const result = await postJson<McpToolsCallResponse>(url, { name, arguments: args }, headers);
			if (result.error) {
				throw parseError(result.error, `MCP tools/call failed: ${url}`);
			}
			return { content: result.content, metadata: result.metadata };
		},
	};
}

export function mcpTools(client: McpClient): Tool[] {
	let cachedTools: Promise<McpTool[]> | null = null;

	async function getTools(): Promise<McpTool[]> {
		if (!cachedTools) {
			cachedTools = client.listTools();
		}
		return cachedTools;
	}

	const listTool = new Tool(
		"mcp.list",
		"List tools available from the MCP server.",
		async () => getTools(),
		{
			type: "object",
			properties: {},
			required: [],
			additionalProperties: false,
		},
		{ type: "array", description: "MCP tool list." }
	);

	const callTool = new Tool(
		"mcp.call",
		"Call a tool on the MCP server.",
		async (args) => {
			if (!args || typeof args !== "object" || Array.isArray(args)) {
				throw new Error("MCP call expects an object with name and arguments.");
			}
			const name = (args as { name?: unknown }).name;
			if (typeof name !== "string" || !name.trim()) {
				throw new Error("MCP call expects a non-empty tool name.");
			}
			const toolArgs = (args as { arguments?: unknown }).arguments ?? {};
			const result = await client.callTool(name, toolArgs);
			return result.content;
		},
		{
			type: "object",
			properties: {
				name: { type: "string" },
				arguments: { type: "object" },
			},
			required: ["name"],
			additionalProperties: true,
		},
		{ type: "object", description: "MCP tool result content." }
	);

	return [listTool, callTool];
}
