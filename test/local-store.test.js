import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { localStoreTool } from "../dist/index.js";

function withDom(html, fn) {
	const dom = new JSDOM(html, { url: "https://example.com" });
	const prev = {
		window: globalThis.window,
		document: globalThis.document,
		Node: globalThis.Node,
		XPathResult: globalThis.XPathResult,
		localStorage: globalThis.localStorage,
	};

	globalThis.window = dom.window;
	globalThis.document = dom.window.document;
	globalThis.Node = dom.window.Node;
	globalThis.XPathResult = dom.window.XPathResult;
	globalThis.localStorage = dom.window.localStorage;

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
		if (prev.localStorage === undefined) {
			delete globalThis.localStorage;
		} else {
			globalThis.localStorage = prev.localStorage;
		}
	};

	return Promise.resolve(fn(dom)).finally(restore);
}

test("localStore set/get/remove", async () => {
	await withDom("<div></div>", async (dom) => {
		const tool = localStoreTool({ namespace: "ns" });
		const ctx = { localStorage: dom.window.localStorage };

		tool.run({ op: "set", key: "a", value: "1" }, ctx);
		const value = tool.run({ op: "get", key: "a" }, ctx);
		assert.equal(value, "1");

		tool.run({ op: "remove", key: "a" }, ctx);
		assert.equal(tool.run({ op: "get", key: "a" }, ctx), null);
	});
});

test("localStore keys respects namespace", async () => {
	await withDom("<div></div>", async (dom) => {
		const tool = localStoreTool({ namespace: "ns" });
		const ctx = { localStorage: dom.window.localStorage };

		tool.run({ op: "set", key: "a", value: "1" }, ctx);
		tool.run({ op: "set", key: "b", value: "2" }, ctx);
		dom.window.localStorage.setItem("other", "3");

		const keys = tool.run({ op: "keys" }, ctx).sort();
		assert.deepEqual(keys, ["a", "b"]);
	});
});

test("localStore validates required keys", async () => {
	await withDom("<div></div>", async (dom) => {
		const tool = localStoreTool();
		const ctx = { localStorage: dom.window.localStorage };

		assert.throws(() => tool.run({ op: "get" }, ctx), /requires key/);
		assert.throws(() => tool.run({ op: "set" }, ctx), /requires key/);
		assert.throws(() => tool.run({ op: "remove" }, ctx), /requires key/);
	});
});

test("localStore rejects unknown op", async () => {
	await withDom("<div></div>", async (dom) => {
		const tool = localStoreTool();
		const ctx = { localStorage: dom.window.localStorage };

		assert.throws(() => tool.run({ op: "nope" }, ctx), /Unknown localStore op/);
	});
});

test("localStore throws when localStorage is missing", async () => {
	const tool = localStoreTool();
	const prevStorage = globalThis.localStorage;
	try {
		delete globalThis.localStorage;
		assert.throws(() => tool.run({ op: "keys" }, {}), /No localStorage available/);
	} finally {
		if (prevStorage === undefined) {
			delete globalThis.localStorage;
		} else {
			globalThis.localStorage = prevStorage;
		}
	}
});
