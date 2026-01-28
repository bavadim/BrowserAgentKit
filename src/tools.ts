import type { Tool, ToolContext } from "./agent";

const jsInterpreterDescription = `# JavaScript Interpreter

Run a JavaScript snippet inside the browser and return its result. The code runs with DOM helpers preloaded.

## Helpers

- \`x(xpath, root?)\`: returns an array of nodes that match the XPath. \`root\` can be a Node, XPath string, or an array from \`x(...)\`. The search is scoped to the agent view root by default. Use \`x("/")[0]\` to access the root container.
- \`replaceSubtree(target, next)\`: replaces a node with another node or HTML string. \`target\` can be a Node, an XPath string, or the array returned by \`x(...)\`.
- \`diffSubtree(a, b)\`: returns \`{ equal, before, after }\` using \`Node.isEqualNode()\` for equality and serialized HTML/text for the diff.
- \`viewRoot\`, \`document\`, \`window\`: convenience references to the scoped root and browser globals.
- \`$\`: jQuery alias when available (falls back to \`undefined\` if jQuery is not loaded).

## Examples

\`\`\`js
// Replace the entire canvas
replaceSubtree(x("/")[0], "\n  <div class=\"card\">\n    <h2>New Title</h2>\n    <p>Updated by the agent.</p>\n  </div>\n");

// Find and update an element
const title = x("//h2")[0];
if (title) title.textContent = "Updated";

// Compare two subtrees
const diff = diffSubtree(x("//section")[0], x("//section")[1]);
\`\`\``;

type RuntimeEnv = {
	document?: Document;
	localStorage?: Storage;
	window?: Window;
	viewRoot?: Element;
};

type InterpreterHelpers = {
	x: (xpath: string, rootOverride?: unknown) => Node[];
	replaceSubtree: (target: unknown, next: unknown) => Node | DocumentFragment | null;
	diffSubtree: (a: unknown, b: unknown) => { equal: boolean; before: string; after: string };
	viewRoot: Node;
	document: Document;
	window: Window | undefined;
	$: unknown;
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

function createInterpreterHelpers(runtime?: RuntimeEnv): InterpreterHelpers {
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

	function diffSubtree(a: unknown, b: unknown): { equal: boolean; before: string; after: string } {
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
		async run(args: unknown, ctx: ToolContext): Promise<unknown> {
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
		run(args: unknown, ctx: ToolContext): unknown {
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
