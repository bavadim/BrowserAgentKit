import test from "node:test";
import assert from "node:assert/strict";
import { createAgent } from "../dist/index.js";

async function collectEvents(generator) {
	const events = [];
	for await (const ev of generator) {
		events.push(ev);
	}
	return events;
}

test("agent returns a message", async () => {
	const model = {
		async generate() {
			return { message: "hello" };
		},
	};

	const agent = createAgent({ model });
	const events = await collectEvents(agent.run("hi"));

	const messageEvent = events.find((ev) => ev.type === "message");
	assert.ok(messageEvent);
	assert.equal(messageEvent.content, "hello");
});

test("agent executes tools when requested", async () => {
	let calls = 0;
	const model = {
		async generate() {
			if (calls === 0) {
				calls += 1;
				return {
					toolCalls: [
						{
							id: "call-1",
							name: "echo",
							args: { value: "ok" },
						},
					],
				};
			}
			return { message: "done" };
		},
	};

	const tool = {
		name: "echo",
		description: "Echoes args.",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		},
		run(args) {
			return args;
		},
	};

	const agent = createAgent({ model, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "tool.start" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "tool.end" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent emits error on unknown tool", async () => {
	let calls = 0;
	const model = {
		async generate() {
			if (calls === 0) {
				calls += 1;
				return {
					toolCalls: [
						{
							id: "call-1",
							name: "missing",
							args: {},
						},
					],
				};
			}
			return { message: "done" };
		},
	};

	const agent = createAgent({ model, tools: [] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent emits error when tool throws", async () => {
	let calls = 0;
	const model = {
		async generate() {
			if (calls === 0) {
				calls += 1;
				return {
					toolCalls: [
						{
							id: "call-1",
							name: "explode",
							args: {},
						},
					],
				};
			}
			return { message: "done" };
		},
	};

	const tool = {
		name: "explode",
		description: "Throws.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			throw new Error("boom");
		},
	};

	const agent = createAgent({ model, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent stops after maxSteps", async () => {
	let calls = 0;
	const model = {
		async generate() {
			calls += 1;
			return {
				toolCalls: [
					{
						id: `call-${calls}`,
						name: "noop",
						args: {},
					},
				],
			};
		},
	};

	const tool = {
		name: "noop",
		description: "No-op.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return { ok: true };
		},
	};

	const agent = createAgent({ model, tools: [tool], policies: { maxSteps: 2 } });
	const events = await collectEvents(agent.run("test"));

	assert.equal(calls, 2);
	assert.ok(events.some((ev) => ev.type === "done"));
	assert.ok(!events.some((ev) => ev.type === "message"));
});

test("agent parses JSON tool args", async () => {
	let calls = 0;
	const model = {
		async generate() {
			if (calls === 0) {
				calls += 1;
				return {
					toolCalls: [
						{
							id: "call-1",
							name: "echo",
							args: JSON.stringify({ value: "ok" }),
						},
					],
				};
			}
			return { message: "done" };
		},
	};

	const tool = {
		name: "echo",
		description: "Echoes args.",
		parameters: { type: "object", additionalProperties: true },
		run(args) {
			return args;
		},
	};

	const agent = createAgent({ model, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.deepEqual(startEvent?.args, { value: "ok" });
});

test("agent preserves non-JSON tool args", async () => {
	let calls = 0;
	const model = {
		async generate() {
			if (calls === 0) {
				calls += 1;
				return {
					toolCalls: [
						{
							id: "call-1",
							name: "echo",
							args: "not json",
						},
					],
				};
			}
			return { message: "done" };
		},
	};

	const tool = {
		name: "echo",
		description: "Echoes args.",
		parameters: { type: "object", additionalProperties: true },
		run(args) {
			return args;
		},
	};

	const agent = createAgent({ model, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.equal(startEvent?.args, "not json");
});

test("agent reports model errors", async () => {
	const model = {
		async generate() {
			throw new Error("model down");
		},
	};

	const agent = createAgent({ model });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "done"));
});
