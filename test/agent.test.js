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

function streamFrom(events) {
	return (async function* () {
		for (const event of events) {
			yield event;
		}
	})();
}

test("agent returns a message", async () => {
	const generate = () =>
		streamFrom([
			{ type: "thinking.delta", delta: "short " },
			{ type: "thinking", summary: "short summary" },
			{ type: "message.delta", delta: "hello" },
			{ type: "message", content: "hello" },
		]);

	const agent = createAgent({ generate });
	const events = await collectEvents(agent.run("hi"));

	const deltaEvent = events.find((ev) => ev.type === "message.delta");
	const messageEvent = events.find((ev) => ev.type === "message");
	const thinkingEvent = events.find((ev) => ev.type === "thinking");
	assert.ok(deltaEvent);
	assert.ok(messageEvent);
	assert.ok(thinkingEvent);
	assert.equal(messageEvent.content, "hello");
	assert.equal(thinkingEvent.summary, "short summary");
});

test("agent accepts generate that resolves to a stream", async () => {
	const generate = async () => {
		await Promise.resolve();
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	const agent = createAgent({ generate });
	const events = await collectEvents(agent.run("hi"));

	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "ok"));
});

test("agent executes tools when requested", async () => {
	let calls = 0;
	const generate = () => {
		if (calls === 0) {
			calls += 1;
			return streamFrom([
				{
					type: "tool.start",
					name: "echo",
					args: "{\"value\":\"ok\"}",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
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

	const agent = createAgent({ generate, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "tool.start" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "tool.end" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent emits error on unknown tool", async () => {
	let calls = 0;
	const generate = () => {
		if (calls === 0) {
			calls += 1;
			return streamFrom([
				{
					type: "tool.start",
					name: "missing",
					args: "{}",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const agent = createAgent({ generate, tools: [] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent emits error when tool throws", async () => {
	let calls = 0;
	const generate = () => {
		if (calls === 0) {
			calls += 1;
			return streamFrom([
				{
					type: "tool.start",
					name: "explode",
					args: "{}",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const tool = {
		name: "explode",
		description: "Throws.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			throw new Error("boom");
		},
	};

	const agent = createAgent({ generate, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("agent stops after maxSteps", async () => {
	let calls = 0;
	const generate = () => {
		calls += 1;
		return streamFrom([
			{
				type: "tool.start",
				name: "noop",
				args: "{}",
				callId: `call-${calls}`,
			},
		]);
	};

	const tool = {
		name: "noop",
		description: "No-op.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return { ok: true };
		},
	};

	const agent = createAgent({ generate, tools: [tool], policies: { maxSteps: 2 } });
	const events = await collectEvents(agent.run("test"));

	assert.equal(calls, 2);
	assert.ok(events.some((ev) => ev.type === "done"));
	assert.ok(!events.some((ev) => ev.type === "message"));
});

test("agent parses JSON tool args", async () => {
	let calls = 0;
	const generate = () => {
		if (calls === 0) {
			calls += 1;
			return streamFrom([
				{
					type: "tool.start",
					name: "echo",
					args: "{\"value\":\"ok\"}",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const tool = {
		name: "echo",
		description: "Echoes args.",
		parameters: { type: "object", additionalProperties: true },
		run(args) {
			return args;
		},
	};

	const agent = createAgent({ generate, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.deepEqual(startEvent?.args, { value: "ok" });
});

test("agent preserves non-JSON tool args", async () => {
	let calls = 0;
	const generate = () => {
		if (calls === 0) {
			calls += 1;
			return streamFrom([
				{
					type: "tool.start",
					name: "echo",
					args: "not json",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const tool = {
		name: "echo",
		description: "Echoes args.",
		parameters: { type: "object", additionalProperties: true },
		run(args) {
			return args;
		},
	};

	const agent = createAgent({ generate, tools: [tool] });
	const events = await collectEvents(agent.run("test"));

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.equal(startEvent?.args, "not json");
});

test("agent reports model errors", async () => {
	const generate = async function* () {
		throw new Error("model down");
	};

	const agent = createAgent({ generate });
	const events = await collectEvents(agent.run("test"));

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "done"));
});

test("agent reset clears history", async () => {
	const lengths = [];
	const generate = (messages) => {
		lengths.push(messages.length);
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	const agent = createAgent({ generate });
	await collectEvents(agent.run("one"));
	agent.reset();
	await collectEvents(agent.run("two"));

	assert.equal(lengths[0], 2);
	assert.equal(lengths[1], 2);
});
