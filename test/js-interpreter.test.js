import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { jsInterpreterTool } from "../dist/index.js";

function withDom(html, fn) {
	const dom = new JSDOM(html, { url: "https://example.com" });
	const prev = {
		window: globalThis.window,
		document: globalThis.document,
		Node: globalThis.Node,
		XPathResult: globalThis.XPathResult,
	};

	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	globalThis.Node = dom.window.Node;
	globalThis.XPathResult = dom.window.XPathResult;

	const restore = () => {
		if (prev.window === undefined) {
			delete globalThis.window;
		} else {
			globalThis.window = prev.window;
		}
		if (prev.document === undefined) {
			delete globalThis.document;
		} else {
			globalThis.document = prev.document;
		}
		if (prev.Node === undefined) {
			delete globalThis.Node;
		} else {
			globalThis.Node = prev.Node;
		}
		if (prev.XPathResult === undefined) {
			delete globalThis.XPathResult;
		} else {
			globalThis.XPathResult = prev.XPathResult;
		}
	};

	return Promise.resolve(fn(dom)).finally(restore);
}

test("jsInterpreter scopes XPath to viewRoot", async () => {
	await withDom(
		"<div id=\"root\"><p class=\"in\">Hi</p></div><p class=\"out\">No</p>",
		async (dom) => {
			const tool = jsInterpreterTool();
			const root = dom.window.document.querySelector("#root");
			const result = await tool.run(
				{ code: "return x(\"//p\").length;" },
				{ viewRoot: root, document: dom.window.document, window: dom.window }
			);
			assert.equal(result, 1);
		}
	);
});

test("jsInterpreter replaces subtree from HTML", async () => {
	await withDom("<div id=\"root\"><p>Old</p></div>", async (dom) => {
		const tool = jsInterpreterTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{
				code:
          "replaceSubtree(x(\"//p\")[0], \"<span id='new'>New</span>\");" +
          "return x(\"//span[@id='new']\").length;",
			},
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result, 1);
	});
});

test("jsInterpreter replaces subtree from Node", async () => {
	await withDom("<div id=\"root\"><p>Old</p></div>", async (dom) => {
		const tool = jsInterpreterTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{
				code:
          "const el = document.createElement('em');" +
          "el.textContent = 'Em';" +
          "replaceSubtree(x(\"//p\")[0], el);" +
          "return x(\"//em\")[0].textContent;",
			},
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result, "Em");
	});
});

test("jsInterpreter diffSubtree returns diff payload", async () => {
	await withDom("<div id=\"root\"><p>One</p><p>Two</p></div>", async (dom) => {
		const tool = jsInterpreterTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{
				code:
          "const diff = diffSubtree(x(\"//p\")[0], x(\"//p\")[1]);" +
          "return diff;",
			},
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result.equal, false);
		assert.ok(result.before.includes("One"));
		assert.ok(result.after.includes("Two"));
	});
});

test("jsInterpreter supports async execution", async () => {
	await withDom("<div id=\"root\"></div>", async (dom) => {
		const tool = jsInterpreterTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{ code: "await Promise.resolve(7); return 7;", async: true },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result, 7);
	});
});

test("jsInterpreter exposes jQuery alias when present", async () => {
	await withDom("<div id=\"root\"></div>", async (dom) => {
		dom.window.$ = () => "jq";
		const tool = jsInterpreterTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{ code: "return typeof $ === 'function' ? $() : 'none';" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result, "jq");
	});
});

test("jsInterpreter throws when no document is available", async () => {
	const tool = jsInterpreterTool();
	const prevDoc = globalThis.document;
	try {
		delete globalThis.document;
		await assert.rejects(() => tool.run({ code: "return 1;" }, {}), /No document/);
	} finally {
		if (prevDoc === undefined) {
			delete globalThis.document;
		} else {
			globalThis.document = prevDoc;
		}
	}
});
