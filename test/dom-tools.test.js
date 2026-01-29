import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
	domAppendHtmlTool,
	domBindEventTool,
	domRemoveTool,
	domSubtreeHtmlTool,
	domSummaryTool,
	jsRunTool,
} from "../dist/index.js";

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

test("domSummaryTool returns markdown tree with XPath and truncates lines", async () => {
	await withDom("<div id=\"root\"><section class=\"hero\"><h1>Hi</h1></section></div>", (dom) => {
		const tool = domSummaryTool();
		const root = dom.window.document.querySelector("#root");
		root.className = `hero-${"x".repeat(3000)}`;
		const output = tool.run(
			{},
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.ok(output.includes("div#root"));
		assert.ok(output.includes("section.hero"));
		assert.ok(output.includes("xpath: /section[1]"));
		for (const line of output.split("\n")) {
			assert.ok(line.length <= 2048);
		}
	});
});

test("domSubtreeHtmlTool returns outerHTML", async () => {
	await withDom("<div id=\"root\"><section class=\"hero\" data-x=\"1\"></section></div>", (dom) => {
		const tool = domSubtreeHtmlTool();
		const root = dom.window.document.querySelector("#root");
		const output = tool.run(
			{ xpath: "//section" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.ok(output.startsWith("<section"));
		assert.ok(output.includes("class=\"hero\""));
		assert.ok(output.includes("data-x=\"1\""));
	});
});

test("domAppendHtmlTool appends HTML to the target node", async () => {
	await withDom("<div id=\"root\"></div>", (dom) => {
		const tool = domAppendHtmlTool();
		const root = dom.window.document.querySelector("#root");
		const result = tool.run(
			{ xpath: "/", html: "<span data-x=\"1\">Hi</span>" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result.ok, true);
		assert.equal(result.appended, 1);
		assert.ok(root.innerHTML.includes("span"));
	});
});

test("domRemoveTool removes all matching nodes", async () => {
	await withDom("<div id=\"root\"><p>One</p><p>Two</p></div>", (dom) => {
		const tool = domRemoveTool();
		const root = dom.window.document.querySelector("#root");
		const result = tool.run(
			{ xpath: "//p" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result.ok, true);
		assert.equal(result.removed, 2);
		assert.equal(root.querySelectorAll("p").length, 0);
	});
});

test("domBindEventTool attaches handlers to all matches", async () => {
	await withDom("<div id=\"root\"><button id=\"btn\"></button></div>", async (dom) => {
		const tool = domBindEventTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{ xpath: "//button", event: "click", code: "element.dataset.hit = 'yes';" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result.ok, true);
		assert.equal(result.attached, 1);
		const btn = dom.window.document.querySelector("#btn");
		btn.dispatchEvent(new dom.window.Event("click"));
		assert.equal(btn.dataset.hit, "yes");
	});
});

test("jsRunTool loads jQuery and executes code", async () => {
	await withDom("<div id=\"root\"></div>", async (dom) => {
		const tool = jsRunTool();
		const root = dom.window.document.querySelector("#root");
		const result = await tool.run(
			{ code: "return typeof $ === 'function';" },
			{ viewRoot: root, document: dom.window.document, window: dom.window }
		);
		assert.equal(result, true);
	});
});
