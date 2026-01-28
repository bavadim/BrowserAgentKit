import { jsInterpreterDescription } from "./descriptions";
function ensureDocument(runtime) {
    const doc = runtime?.document ??
        runtime?.viewRoot?.ownerDocument ??
        (typeof document !== "undefined" ? document : undefined);
    if (!doc) {
        throw new Error("No document available in this environment.");
    }
    return doc;
}
function getStorage(runtime) {
    if (runtime?.localStorage) {
        return runtime.localStorage;
    }
    if (typeof localStorage === "undefined") {
        throw new Error("No localStorage available in this environment.");
    }
    return localStorage;
}
function getViewRoot(doc, runtime) {
    return runtime?.viewRoot ?? doc;
}
function scopeXpath(xpath, root) {
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
function resolveNode(target, helpers) {
    if (!target) {
        return null;
    }
    if (target instanceof Node) {
        return target;
    }
    if (Array.isArray(target)) {
        const first = target.find((item) => item instanceof Node);
        return first ?? null;
    }
    if (typeof target === "string") {
        return helpers.x(target)[0] ?? null;
    }
    return null;
}
function nodeToString(node) {
    if (!node) {
        return "";
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return Array.from(node.childNodes)
            .map((child) => nodeToString(child))
            .join("");
    }
    if (node.nodeType === Node.DOCUMENT_NODE) {
        const doc = node;
        return doc.documentElement?.outerHTML ?? "";
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
        return node.outerHTML;
    }
    return node.textContent ?? "";
}
function createInterpreterHelpers(runtime) {
    const doc = ensureDocument(runtime);
    const root = getViewRoot(doc, runtime);
    const win = runtime?.window ?? (typeof window !== "undefined" ? window : undefined);
    const winAny = win;
    const jq = winAny?.$ ?? winAny?.jQuery;
    function x(xpath, rootOverride) {
        let baseRoot = root;
        if (rootOverride) {
            if (rootOverride instanceof Node) {
                baseRoot = rootOverride;
            }
            else if (Array.isArray(rootOverride)) {
                const first = rootOverride.find((item) => item instanceof Node);
                if (first) {
                    baseRoot = first;
                }
            }
            else if (typeof rootOverride === "string") {
                const resolved = resolveNode(rootOverride, { x });
                if (resolved) {
                    baseRoot = resolved;
                }
            }
        }
        const scoped = scopeXpath(xpath, baseRoot);
        const result = doc.evaluate(scoped, baseRoot, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const nodes = [];
        for (let i = 0; i < result.snapshotLength; i += 1) {
            const node = result.snapshotItem(i);
            if (node) {
                nodes.push(node);
            }
        }
        return nodes;
    }
    function replaceSubtree(target, next) {
        const resolvedTarget = resolveNode(target, { x });
        if (!resolvedTarget) {
            throw new Error("replaceSubtree: target not found.");
        }
        let replacement;
        if (next instanceof Node) {
            replacement = next;
        }
        else if (typeof next === "string") {
            const template = doc.createElement("template");
            template.innerHTML = next;
            replacement = template.content;
        }
        else {
            replacement = doc.createTextNode(String(next ?? ""));
        }
        resolvedTarget.replaceWith(replacement);
        return replacement;
    }
    function diffSubtree(a, b) {
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
export function jsInterpreterTool() {
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
            const { code, async } = args;
            const helpers = createInterpreterHelpers(ctx);
            if (async) {
                const fn = new Function("helpers", `const { x, replaceSubtree, diffSubtree, viewRoot, document, window, $ } = helpers;` +
                    `return (async () => { ${code} })()`);
                return await fn(helpers);
            }
            const fn = new Function("helpers", `const { x, replaceSubtree, diffSubtree, viewRoot, document, window, $ } = helpers;` +
                `return (function () { ${code} })()`);
            return fn(helpers);
        },
    };
}
export function localStoreTool(options = {}) {
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
            const { op, key, value } = args;
            const storage = getStorage(ctx);
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
                    const keys = [];
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
//# sourceMappingURL=index.js.map