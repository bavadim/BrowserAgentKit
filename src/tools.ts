import type { ToolContext } from "./types";
import { Tool } from "./tool";

const jsInterpreterDescription = `# JavaScript Interpreter

Run a JavaScript snippet inside the browser and return its result. The code runs with DOM helpers preloaded.
Use jQuery (\`$\`) for DOM and event work.

## Helpers

- \`x(xpath, root?)\`: returns an array of nodes that match the XPath. \`root\` can be a Node, XPath string, or an array from \`x(...)\`. The search is scoped to the agent view root by default. Use \`x("/")[0]\` to access the root container.
- \`replaceSubtree(target, next)\`: replaces a node with another node or HTML string. \`target\` can be a Node, an XPath string, or the array returned by \`x(...)\`.
- \`diffSubtree(a, b)\`: returns \`{ equal, before, after }\` using \`Node.isEqualNode()\` for equality and serialized HTML/text for the diff.
- \`viewRoot\`, \`document\`, \`window\`: convenience references to the scoped root and browser globals.
- \`$\`: jQuery alias (loaded automatically when missing).

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

const jqueryCache = new WeakMap<Window, Promise<unknown | undefined>>();

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

function getViewRoot(doc: Document, runtime?: RuntimeEnv): Node {
	return runtime?.viewRoot ?? doc;
}

function getXPathResult(doc: Document): typeof XPathResult {
	const XPathResultRef =
		doc.defaultView?.XPathResult ?? (typeof XPathResult !== "undefined" ? XPathResult : undefined);
	if (!XPathResultRef) {
		throw new Error("XPathResult is not available in this environment.");
	}
	return XPathResultRef;
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

function findNodesByXPath(xpath: string, runtime?: RuntimeEnv): { doc: Document; root: Node; nodes: Node[] } {
	if (!xpath || !xpath.trim()) {
		throw new Error("XPath selector must be a non-empty string.");
	}
	const doc = ensureDocument(runtime);
	const root = getViewRoot(doc, runtime);
	const scoped = scopeXpath(xpath, root);
	const XPathResultRef = getXPathResult(doc);
	const result = doc.evaluate(scoped, root, null, XPathResultRef.ORDERED_NODE_SNAPSHOT_TYPE, null);
	const nodes: Node[] = [];
	for (let i = 0; i < result.snapshotLength; i += 1) {
		const node = result.snapshotItem(i);
		if (node) {
			nodes.push(node);
		}
	}
	return { doc, root, nodes };
}

function resolveNodeByXPath(xpath: string, runtime?: RuntimeEnv): { doc: Document; root: Node; node: Node } {
	const { doc, root, nodes } = findNodesByXPath(xpath, runtime);
	const node = nodes[0];
	if (!node) {
		throw new Error(`XPath selector returned no nodes: ${xpath}`);
	}
	return { doc, root, node };
}

async function ensureJQuery(runtime?: RuntimeEnv): Promise<unknown | undefined> {
	const win = runtime?.window ?? (typeof window !== "undefined" ? window : undefined);
	if (!win) {
		return undefined;
	}
	const winAny = win as (Window & { $?: unknown; jQuery?: unknown }) | undefined;
	const existing = winAny?.$ ?? winAny?.jQuery;
	if (existing) {
		return existing;
	}
	const cached = jqueryCache.get(win);
	if (cached) {
		return cached;
	}
	const loader = import("jquery")
		.then((mod) => {
			const factory = (mod as { default?: unknown }).default ?? mod;
			let jq: unknown;
			if (typeof factory === "function") {
				const maybeJQuery = factory as { fn?: unknown };
				if (maybeJQuery.fn) {
					jq = factory;
				} else {
					const maybeFactory = factory as (win: Window) => unknown;
					try {
						jq = maybeFactory(win);
					} catch {
						jq = factory;
					}
				}
			} else {
				jq = factory;
			}
			if (winAny && jq) {
				winAny.$ = jq;
				winAny.jQuery = jq;
			}
			return jq;
		})
		.catch(() => undefined);
	jqueryCache.set(win, loader);
	return loader;
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

function nodeToXPath(node: Node, root: Node): string {
	if (node === root) {
		return "/";
	}
	const segments: string[] = [];
	let current: Node | null = node;
	while (current && current !== root) {
		if (current.nodeType !== Node.ELEMENT_NODE) {
			current = current.parentNode;
			continue;
		}
		const element = current as Element;
		const tag = element.tagName.toLowerCase();
		let index = 1;
		let sibling = element.previousElementSibling;
		while (sibling) {
			if (sibling.tagName.toLowerCase() === tag) {
				index += 1;
			}
			sibling = sibling.previousElementSibling;
		}
		segments.push(`${tag}[${index}]`);
		current = element.parentNode;
	}
	if (current !== root) {
		return "/";
	}
	return `/${segments.reverse().join("/")}`;
}

function formatNodeLabel(node: Element): string {
	const tag = node.tagName.toLowerCase();
	const id = node.id ? `#${node.id}` : "";
	const classes = node.classList?.length ? `.${Array.from(node.classList).join(".")}` : "";
	return `${tag}${id}${classes}`;
}

function truncateLine(line: string, maxLength: number): string {
	if (line.length <= maxLength) {
		return line;
	}
	const sliceLength = Math.max(0, maxLength - 3);
	return `${line.slice(0, sliceLength)}...`;
}

async function createInterpreterHelpers(
	runtime?: RuntimeEnv,
	options: { requireJQuery?: boolean } = {}
): Promise<InterpreterHelpers> {
	const doc = ensureDocument(runtime);
	const root = getViewRoot(doc, runtime);
	const win = runtime?.window ?? (typeof window !== "undefined" ? window : undefined);
	const jq = await ensureJQuery(runtime);
	if (options.requireJQuery && !jq) {
		throw new Error("jQuery is required but could not be loaded.");
	}
	const XPathResultRef = getXPathResult(doc);

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
		const result = doc.evaluate(
			scoped,
			baseRoot,
			null,
			XPathResultRef.ORDERED_NODE_SNAPSHOT_TYPE,
			null
		);
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
	const inputSchema = {
		type: "object",
		properties: {
			code: { type: "string", description: "JavaScript source to evaluate." },
			async: { type: "boolean", description: "Whether to run as async." },
		},
		required: ["code"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: ["string", "number", "boolean", "object", "array", "null"],
		description: "JSON-serializable result from the JavaScript snippet.",
	};
	return new Tool(
		"jsInterpreter",
		jsInterpreterDescription,
		async (args: unknown, ctx: ToolContext): Promise<unknown> => {
			const { code, async } = args as { code: string; async?: boolean | null };
			const isAsync = async ?? false;
			const helpers = await createInterpreterHelpers(ctx as RuntimeEnv | undefined);
			if (isAsync) {
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
		inputSchema,
		outputSchema
	);
}

const domSummaryDescription = `# DOM Summary

Return a Markdown tree that summarizes the DOM structure (scoped to the view root when provided).
Each line includes a tag label and its XPath. Lines longer than 2048 characters are truncated.

Inputs:
- \`maxDepth\`: Maximum depth to traverse (default: 6).
- \`maxChildren\`: Maximum number of children per node (default: 50).
- \`maxNodes\`: Maximum number of nodes to include (default: 300).`;

const domSubtreeHtmlDescription = `# DOM Subtree (HTML)

Return the full \`outerHTML\` of the first node matching the XPath selector.`;

const domAppendHtmlDescription = `# DOM Append HTML

Append an HTML string as children of the node matching the XPath selector.`;

const domRemoveDescription = `# DOM Remove

Remove all nodes matching the XPath selector.`;

const domBindEventDescription = `# DOM Bind Event

Attach a JavaScript event handler to all nodes matching the XPath selector.
The handler receives \`event\`, \`element\`, \`document\`, \`window\`, and \`$\` (jQuery).`;

const jsRunDescription = `# JavaScript Runner

Run a JavaScript snippet inside the browser and return its result.
Use jQuery (\`$\`) for DOM and event work.`;

export function domSummaryTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			maxDepth: { type: "number", description: "Maximum depth to traverse." },
			maxChildren: { type: "number", description: "Maximum number of children per node." },
			maxNodes: { type: "number", description: "Maximum number of nodes to include." },
		},
		required: [],
		additionalProperties: false,
	};
	const outputSchema = {
		type: "string",
		description: "Markdown tree of DOM selectors.",
	};
	return new Tool(
		"domSummary",
		domSummaryDescription,
		(args: unknown, ctx: ToolContext): string => {
			const { maxDepth, maxChildren, maxNodes } = args as {
				maxDepth?: number;
				maxChildren?: number;
				maxNodes?: number;
			};
			const depthLimit = Number.isFinite(maxDepth) ? Math.max(0, maxDepth as number) : 6;
			const childLimit = Number.isFinite(maxChildren) ? Math.max(0, maxChildren as number) : 50;
			const nodeLimit = Number.isFinite(maxNodes) ? Math.max(0, maxNodes as number) : 300;
			const doc = ensureDocument(ctx as RuntimeEnv | undefined);
			const rootNode = getViewRoot(doc, ctx as RuntimeEnv | undefined);
			const rootElement =
				rootNode.nodeType === Node.DOCUMENT_NODE
					? (rootNode as Document).documentElement
					: (rootNode as Element);
			if (!rootElement) {
				throw new Error("DOM summary root element not found.");
			}
			const lines: string[] = [];
			let visited = 0;

			const walk = (node: Element, depth: number): void => {
				if (visited >= nodeLimit) {
					return;
				}
				const indent = "  ".repeat(depth);
				const label = formatNodeLabel(node);
				const path = nodeToXPath(node, rootElement);
				const line = truncateLine(`${indent}- ${label} (xpath: ${path})`, 2048);
				lines.push(line);
				visited += 1;
				if (depth >= depthLimit) {
					return;
				}
				const children = Array.from(node.children);
				const limit = Math.min(children.length, childLimit);
				for (let i = 0; i < limit; i += 1) {
					walk(children[i], depth + 1);
					if (visited >= nodeLimit) {
						return;
					}
				}
				if (children.length > limit && visited < nodeLimit) {
					const remaining = children.length - limit;
					const overflowLine = truncateLine(`${indent}  - ... (${remaining} more)`, 2048);
					lines.push(overflowLine);
					visited += 1;
				}
			};

			walk(rootElement, 0);
			return lines.join("\n");
		},
		inputSchema,
		outputSchema
	);
}

export function domSubtreeHtmlTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			xpath: { type: "string", description: "XPath selector for the target node." },
		},
		required: ["xpath"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: "string",
		description: "Outer HTML for the matched node.",
	};
	return new Tool(
		"domSubtreeHtml",
		domSubtreeHtmlDescription,
		(args: unknown, ctx: ToolContext): string => {
			const { xpath } = args as { xpath: string };
			const { node } = resolveNodeByXPath(xpath, ctx as RuntimeEnv | undefined);
			return nodeToString(node);
		},
		inputSchema,
		outputSchema
	);
}

export function domAppendHtmlTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			xpath: { type: "string", description: "XPath selector for the target node." },
			html: { type: "string", description: "HTML string to append." },
		},
		required: ["xpath", "html"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			appended: { type: "number" },
		},
		required: ["ok", "appended"],
		additionalProperties: false,
	};
	return new Tool(
		"domAppendHtml",
		domAppendHtmlDescription,
		(args: unknown, ctx: ToolContext): { ok: boolean; appended: number } => {
			const { xpath, html } = args as { xpath: string; html: string };
			const { doc, node } = resolveNodeByXPath(xpath, ctx as RuntimeEnv | undefined);
			if (node.nodeType !== Node.ELEMENT_NODE) {
				throw new Error("Target node is not an element.");
			}
			const template = doc.createElement("template");
			template.innerHTML = html;
			const fragment = template.content;
			const appended = fragment.childNodes.length;
			(node as Element).appendChild(fragment);
			return { ok: true, appended };
		},
		inputSchema,
		outputSchema
	);
}

export function domRemoveTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			xpath: { type: "string", description: "XPath selector for the nodes to remove." },
		},
		required: ["xpath"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			removed: { type: "number" },
		},
		required: ["ok", "removed"],
		additionalProperties: false,
	};
	return new Tool(
		"domRemove",
		domRemoveDescription,
		(args: unknown, ctx: ToolContext): { ok: boolean; removed: number } => {
			const { xpath } = args as { xpath: string };
			const { nodes } = findNodesByXPath(xpath, ctx as RuntimeEnv | undefined);
			let removed = 0;
			for (const node of nodes) {
				if (node.parentNode) {
					node.parentNode.removeChild(node);
					removed += 1;
				}
			}
			return { ok: true, removed };
		},
		inputSchema,
		outputSchema
	);
}

export function domBindEventTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			xpath: { type: "string", description: "XPath selector for the target nodes." },
			event: { type: "string", description: "Event name (e.g. click, submit)." },
			code: { type: "string", description: "Handler code to execute." },
		},
		required: ["xpath", "event", "code"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: "object",
		properties: {
			ok: { type: "boolean" },
			attached: { type: "number" },
		},
		required: ["ok", "attached"],
		additionalProperties: false,
	};
	return new Tool(
		"domBindEvent",
		domBindEventDescription,
		async (args: unknown, ctx: ToolContext): Promise<{ ok: boolean; attached: number }> => {
			const { xpath, event, code } = args as { xpath: string; event: string; code: string };
			const { doc, nodes } = findNodesByXPath(xpath, ctx as RuntimeEnv | undefined);
			const win = ctx.window ?? doc.defaultView ?? (typeof window !== "undefined" ? window : undefined);
			const jq = await ensureJQuery(ctx as RuntimeEnv | undefined);
			const handler = new Function(
				"event",
				"element",
				"document",
				"window",
				"$",
				code
			) as (event: Event, element: Element, document: Document, window?: Window, $?: unknown) => void;
			let attached = 0;
			for (const node of nodes) {
				if (node.nodeType !== Node.ELEMENT_NODE) {
					continue;
				}
				const element = node as Element;
				element.addEventListener(event, (ev) => handler(ev, element, doc, win ?? undefined, jq));
				attached += 1;
			}
			return { ok: true, attached };
		},
		inputSchema,
		outputSchema
	);
}

export function jsRunTool(): Tool {
	const inputSchema = {
		type: "object",
		properties: {
			code: { type: "string", description: "JavaScript source to evaluate." },
			async: { type: "boolean", description: "Whether to run as async." },
		},
		required: ["code"],
		additionalProperties: false,
	};
	const outputSchema = {
		type: ["string", "number", "boolean", "object", "array", "null"],
		description: "JSON-serializable result from the JavaScript snippet.",
	};
	return new Tool(
		"jsRun",
		jsRunDescription,
		async (args: unknown, ctx: ToolContext): Promise<unknown> => {
			const { code, async } = args as { code: string; async?: boolean | null };
			const isAsync = async ?? false;
			const helpers = await createInterpreterHelpers(ctx as RuntimeEnv | undefined, {
				requireJQuery: true,
			});
			if (isAsync) {
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
		inputSchema,
		outputSchema
	);
}
