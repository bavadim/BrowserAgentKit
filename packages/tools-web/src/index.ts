import type { Tool } from "@browser-agent-kit/core";

type RuntimeEnv = {
  document?: Document;
  localStorage?: Storage;
  window?: Window;
  viewRoot?: Element;
};

function getDocument(runtime?: RuntimeEnv): Document {
  return runtime?.document ?? runtime?.viewRoot?.ownerDocument ?? document;
}

function getStorage(runtime?: RuntimeEnv): Storage {
  if (runtime?.localStorage) {
    return runtime.localStorage;
  }
  return localStorage;
}

function getViewRoot(runtime?: RuntimeEnv): { root: Node; doc: Document } {
  if (runtime?.viewRoot) {
    return { root: runtime.viewRoot, doc: runtime.viewRoot.ownerDocument ?? document };
  }
  const doc = getDocument(runtime);
  return { root: doc, doc };
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

function xpathForNode(node: Node, root?: Node): string {
  if (root && node === root) {
    return "/";
  }
  if (node.nodeType === Node.DOCUMENT_NODE) {
    return "/";
  }
  if (!node.parentNode || node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const parent = node.parentNode as ParentNode;
  const siblings = Array.from(parent.children).filter(
    (sibling) => sibling.tagName === element.tagName
  );
  const index = siblings.indexOf(element) + 1;
  const parentPath = xpathForNode(parent, root);
  const tag = element.tagName.toLowerCase();
  const segment = siblings.length > 1 ? `${tag}[${index}]` : tag;

  if (!parentPath || parentPath === "/") {
    return `/${segment}`;
  }
  return `${parentPath}/${segment}`;
}

export function jsInterpreterTool(): Tool {
  return {
    name: "jsInterpreter",
    description: "Run a JavaScript snippet and return its result.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "JavaScript source to evaluate." },
        async: { type: "boolean", description: "Whether to run as async." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async run(args) {
      const { code, async } = args as { code: string; async?: boolean };
      if (async) {
        const fn = new Function(`return (async () => { ${code} })()`);
        return await fn();
      }
      const fn = new Function(`return (function () { ${code} })()`);
      return fn();
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
      const storage = getStorage(ctx.runtime as RuntimeEnv | undefined);

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

export function domXpathTool(): Tool {
  return {
    name: "domXpath",
    description: "Search DOM nodes using an XPath expression (scoped to viewRoot when provided).",
    parameters: {
      type: "object",
      properties: {
        xpath: { type: "string", description: "XPath expression (e.g. //h1)." },
        limit: { type: "number", description: "Max number of nodes to return." },
      },
      required: ["xpath"],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { xpath, limit } = args as { xpath: string; limit?: number };
      const { root, doc } = getViewRoot(ctx.runtime as RuntimeEnv | undefined);
      const scoped = scopeXpath(xpath, root);
      const result = doc.evaluate(scoped, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes: Array<{ xpath: string; text?: string; attrs?: Record<string, string> }> = [];
      const max = limit ?? result.snapshotLength;
      for (let i = 0; i < result.snapshotLength && nodes.length < max; i += 1) {
        const node = result.snapshotItem(i);
        if (!node) {
          continue;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const element = node as Element;
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(element.attributes)) {
            attrs[attr.name] = attr.value;
          }
          nodes.push({
            xpath: xpathForNode(element, root),
            text: element.textContent ?? undefined,
            attrs,
          });
        } else {
          nodes.push({ xpath: xpathForNode(node, root), text: node.textContent ?? undefined });
        }
      }
      return nodes;
    },
  };
}

export function domPatchTool(): Tool {
  return {
    name: "domPatch",
    description: "Apply a simple patch to a DOM node located by XPath (scoped to viewRoot when provided).",
    parameters: {
      type: "object",
      properties: {
        xpath: { type: "string" },
        action: { type: "string", description: "setText | setHtml | setAttr | remove | appendHtml" },
        text: { type: "string" },
        html: { type: "string" },
        attrName: { type: "string" },
        attrValue: { type: "string" },
      },
      required: ["xpath", "action"],
      additionalProperties: false,
    },
    run(args, ctx) {
      const { xpath, action, text, html, attrName, attrValue } = args as {
        xpath: string;
        action: string;
        text?: string;
        html?: string;
        attrName?: string;
        attrValue?: string;
      };
      const { root, doc } = getViewRoot(ctx.runtime as RuntimeEnv | undefined);
      const scoped = scopeXpath(xpath, root);
      const result = doc.evaluate(scoped, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      const node = result.singleNodeValue;
      if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        throw new Error(`No element found for xpath: ${xpath}`);
      }
      const element = node as Element;
      switch (action) {
        case "setText":
          element.textContent = text ?? "";
          break;
        case "setHtml":
          element.innerHTML = html ?? "";
          break;
        case "appendHtml":
          element.insertAdjacentHTML("beforeend", html ?? "");
          break;
        case "setAttr":
          if (!attrName) {
            throw new Error("domPatch.setAttr requires attrName");
          }
          element.setAttribute(attrName, attrValue ?? "");
          break;
        case "remove":
          element.remove();
          break;
        default:
          throw new Error(`Unknown domPatch action: ${action}`);
      }
      return { ok: true };
    },
  };
}
