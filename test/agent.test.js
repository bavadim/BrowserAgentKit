import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createAgentMessages, runAgent } from "../dist/index.js";

async function collectEvents(generator) {
	const events = [];
	for await (const ev of generator) {
		events.push(ev);
	}
	return events;
}

function runAgentEvents(messages, options, input) {
	return collectEvents(runAgent(messages, options, input));
}

function streamFrom(events) {
	return (async function* () {
		for (const event of events) {
			yield event;
		}
	})();
}

test("streams text and thinking summary", async () => {
	const generate = () =>
		streamFrom([
			{ type: "thinking.delta", delta: "short " },
			{ type: "thinking", summary: "short summary" },
			{ type: "message.delta", delta: "hello" },
			{ type: "message", content: "hello" },
		]);

	const messages = createAgentMessages();
	const options = { generate };
	const events = await runAgentEvents(messages, options, "hi");

	const deltaEvent = events.find((ev) => ev.type === "message.delta");
	const messageEvent = events.find((ev) => ev.type === "message");
	const thinkingEvent = events.find((ev) => ev.type === "thinking");
	assert.ok(deltaEvent);
	assert.ok(messageEvent);
	assert.ok(thinkingEvent);
	assert.equal(messageEvent.content, "hello");
	assert.equal(thinkingEvent.summary, "short summary");
});

test("accepts async generate that resolves to a stream", async () => {
	const generate = async () => {
		await Promise.resolve();
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	const messages = createAgentMessages();
	const options = { generate };
	const events = await runAgentEvents(messages, options, "hi");

	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "ok"));
});

test("runs tools when requested", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [tool] };
	const events = await runAgentEvents(messages, options, "test");

	assert.ok(events.some((ev) => ev.type === "tool.start" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "tool.end" && ev.name === "echo"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("emits error for unknown tool", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [] };
	const events = await runAgentEvents(messages, options, "test");

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("emits error when tool throws", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [tool] };
	const events = await runAgentEvents(messages, options, "test");

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "done"));
});

test("stops after maxSteps", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [tool], maxSteps: 2 };
	const events = await runAgentEvents(messages, options, "test");

	assert.equal(calls, 2);
	assert.ok(events.some((ev) => ev.type === "done"));
	assert.ok(!events.some((ev) => ev.type === "message"));
});

test("parses JSON tool args", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [tool] };
	const events = await runAgentEvents(messages, options, "test");

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.deepEqual(startEvent?.args, { value: "ok" });
});

test("preserves non-JSON tool args", async () => {
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

	const messages = createAgentMessages();
	const options = { generate, tools: [tool] };
	const events = await runAgentEvents(messages, options, "test");

	const startEvent = events.find((ev) => ev.type === "tool.start");
	assert.equal(startEvent?.args, "not json");
});

test("reports model errors", async () => {
	const generate = async function* () {
		throw new Error("model down");
	};

	const messages = createAgentMessages();
	const options = { generate };
	const events = await runAgentEvents(messages, options, "test");

	assert.ok(events.some((ev) => ev.type === "error"));
	assert.ok(events.some((ev) => ev.type === "done"));
});

test("reset clears history between runs", async () => {
	const lengths = [];
	const generate = (messages) => {
		lengths.push(messages.length);
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	let messages = createAgentMessages();
	const options = { generate };
	await runAgentEvents(messages, options, "one");
	messages = createAgentMessages();
	await runAgentEvents(messages, options, "two");

	assert.equal(lengths[0], 2);
	assert.equal(lengths[1], 2);
});

test("new run aborts previous run", async () => {
	let callCount = 0;
	let firstSignal = null;
	const generate = async function* (_messages, _tools, signal) {
		callCount += 1;
		if (callCount === 1) {
			firstSignal = signal;
			if (!signal?.aborted) {
				await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
			}
			return;
		}
		yield { type: "message", content: "ok" };
	};

	const messages = createAgentMessages();
	const options = { generate };
	const firstRun = collectEvents(runAgent(messages, options, "one"));
	const secondRun = collectEvents(runAgent(messages, options, "two"));
	const [firstEvents, secondEvents] = await Promise.all([firstRun, secondRun]);

	assert.ok(firstSignal?.aborted);
	assert.ok(firstEvents.some((ev) => ev.type === "done"));
	assert.ok(secondEvents.some((ev) => ev.type === "message" && ev.content === "ok"));
});

test("root cycle inserts skill list message", async () => {
	let seenMessages = null;
	const generate = (messages) => {
		seenMessages = messages;
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "demo.skill",
				description: "Demo skill.",
				promptSelector: "//script[@id='skill']",
			},
		],
	};

	await runAgentEvents(messages, options, "hi");

	assert.ok(seenMessages);
	assert.equal(seenMessages[0].role, "system");
	assert.equal(seenMessages[1].role, "system");
	assert.equal(seenMessages[2].role, "user");
	assert.ok(seenMessages[0].content.includes("browser-based code agent"));
	assert.ok(seenMessages[1].content.includes("demo.skill"));
	assert.ok(seenMessages[1].content.includes("$"));
	assert.ok(!seenMessages[0].content.includes("Skills"));
});

test("model can ignore $skill hints", async () => {
	const generate = () => streamFrom([{ type: "message", content: "ok" }]);
	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "demo.skill",
				description: "Demo skill.",
				promptSelector: "//script[@id='skill']",
			},
		],
	};

	const events = await runAgentEvents(messages, options, "Please do $demo.skill if needed");
	assert.ok(!events.some((ev) => ev.type === "tool.start"));
	assert.ok(events.some((ev) => ev.type === "message" && ev.content === "ok"));
});

test("skill call builds child history and isolates parent", async () => {
	const dom = new JSDOM(
		"<script type=\"text/markdown\" id=\"skill\"># Skill Prompt\nFollow it.</script>"
	);
	const snapshots = [];
	let callCount = 0;

	const generate = (messages) => {
		callCount += 1;
		snapshots.push(messages);
		if (callCount === 1) {
			return streamFrom([
				{
					type: "tool.start",
					name: "dom.skill",
					args: JSON.stringify({
						task: "child task",
						history: [{ role: "user", content: "prior" }],
					}),
					callId: "call-1",
				},
			]);
		}
		if (callCount === 2) {
			return streamFrom([{ type: "message", content: "child output" }]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "dom.skill",
				description: "Reads prompt from DOM.",
				promptSelector: "//script[@id='skill']",
			},
		],
		context: { document: dom.window.document, window: dom.window },
	};

	await runAgentEvents(messages, options, "hi");

	const childMessages = snapshots[1];
	assert.equal(childMessages[0].role, "system");
	assert.equal(childMessages[1].role, "system");
	assert.equal(childMessages[2].role, "user");
	assert.equal(childMessages[2].content, "prior");
	assert.equal(childMessages[3].role, "user");
	assert.equal(childMessages[3].content, "child task");
	assert.ok(childMessages[1].content.includes("Skill Prompt"));

	const rootAfterMessages = snapshots[2];
	assert.ok(rootAfterMessages.some((msg) => msg.type === "function_call"));
	assert.ok(rootAfterMessages.some((msg) => msg.type === "function_call_output"));
	assert.ok(!rootAfterMessages.some((msg) => msg.role === "user" && msg.content === "child task"));
	assert.ok(!rootAfterMessages.some((msg) => msg.role === "system" && msg.content.includes("Skill Prompt")));
});

test("skill prompt sanitizes HTML to markdown", async () => {
	const dom = new JSDOM(
		"<script type=\"text/markdown\" id=\"skill\"><div>**Hello**</div><script>alert(1)</script></script>"
	);
	let callCount = 0;
	let childMessages = null;

	const generate = (messages) => {
		callCount += 1;
		if (callCount === 1) {
			return streamFrom([
				{
					type: "tool.start",
					name: "dom.skill",
					args: JSON.stringify({ task: "do" }),
					callId: "call-1",
				},
			]);
		}
		if (callCount === 2) {
			childMessages = messages;
			return streamFrom([{ type: "message", content: "ok" }]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "dom.skill",
				description: "Reads prompt from DOM.",
				promptSelector: "//script[@id='skill']",
			},
		],
		context: { document: dom.window.document, window: dom.window },
	};

	await runAgentEvents(messages, options, "hi");

	const systemMessages = childMessages.filter((message) => message.role === "system");
	assert.equal(systemMessages.length, 2);
	const skillSystem = systemMessages[1].content;
	assert.ok(skillSystem.includes("**Hello**"));
	assert.ok(!skillSystem.includes("<div>"));
	assert.ok(!skillSystem.includes("<script>"));
});

test("skill prompt empty after sanitization emits error", async () => {
	const dom = new JSDOM(
		"<script type=\"text/markdown\" id=\"skill\"><div></div></script>"
	);
	let callCount = 0;
	const generate = () => {
		callCount += 1;
		if (callCount === 1) {
			return streamFrom([
				{
					type: "tool.start",
					name: "dom.skill",
					args: JSON.stringify({ task: "do" }),
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "dom.skill",
				description: "Reads prompt from DOM.",
				promptSelector: "//script[@id='skill']",
			},
		],
		context: { document: dom.window.document, window: dom.window },
	};

	const events = await runAgentEvents(messages, options, "hi");

	assert.equal(callCount, 2);
	assert.ok(events.some((ev) => ev.type === "error"));
});

test("skill call args are validated", async () => {
	let callCount = 0;
	const generate = () => {
		callCount += 1;
		if (callCount === 1) {
			return streamFrom([
				{
					type: "tool.start",
					name: "bad.skill",
					args: "{}",
					callId: "call-1",
				},
			]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "bad.skill",
				description: "Needs task.",
				promptSelector: "//script[@id='skill']",
			},
		],
	};

	const events = await runAgentEvents(messages, options, "hi");

	assert.equal(callCount, 2);
	assert.ok(events.some((ev) => ev.type === "error"));
});

test("child scope limits tools and skills", async () => {
	const dom = new JSDOM(
		"<script type=\"text/markdown\" id=\"parent\"># Parent</script>\n<script type=\"text/markdown\" id=\"child\"># Child</script>"
	);
	let callCount = 0;
	let childTools = null;

	const generate = (messages, tools) => {
		callCount += 1;
		if (callCount === 1) {
			return streamFrom([
				{
					type: "tool.start",
					name: "parent.skill",
					args: JSON.stringify({ task: "do" }),
					callId: "call-1",
				},
			]);
		}
		if (callCount === 2) {
			childTools = tools ?? [];
			return streamFrom([{ type: "message", content: "child" }]);
		}
		return streamFrom([{ type: "message", content: "done" }]);
	};

	const childTool = {
		name: "child.tool",
		description: "Child tool.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return "ok";
		},
	};
	const rootTool = {
		name: "root.tool",
		description: "Root tool.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return "ok";
		},
	};

	const childSkill = {
		name: "child.skill",
		description: "Child skill.",
		promptSelector: "//script[@id='child']",
	};
	const otherSkill = {
		name: "other.skill",
		description: "Other skill.",
		promptSelector: "//script[@id='child']",
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		tools: [rootTool],
		skills: [
			{
				name: "parent.skill",
				description: "Parent skill.",
				promptSelector: "//script[@id='parent']",
				allowedSkills: [childSkill],
				tools: [childTool],
			},
			otherSkill,
		],
		context: { document: dom.window.document, window: dom.window },
	};

	await runAgentEvents(messages, options, "hi");

	const childToolNames = childTools.map((tool) => tool.name).sort();
	assert.deepEqual(childToolNames, ["child.skill", "child.tool"]);
});

test("skill events include depth and input for nested calls", async () => {
	const dom = new JSDOM(
		"<script type=\"text/markdown\" id=\"parent\"># Parent</script>\n<script type=\"text/markdown\" id=\"child\"># Child</script>"
	);
	let callCount = 0;
	const generate = () => {
		callCount += 1;
		switch (callCount) {
			case 1:
				return streamFrom([
					{
						type: "tool.start",
						name: "parent.skill",
						args: JSON.stringify({ task: "parent task" }),
						callId: "call-1",
					},
				]);
			case 2:
				return streamFrom([
					{
						type: "tool.start",
						name: "child.skill",
						args: JSON.stringify({ task: "child task" }),
						callId: "call-2",
					},
				]);
			case 3:
				return streamFrom([{ type: "message", content: "child output" }]);
			case 4:
				return streamFrom([{ type: "message", content: "parent output" }]);
			default:
				return streamFrom([{ type: "message", content: "done" }]);
		}
	};

	const messages = createAgentMessages();
	const options = {
		generate,
		skills: [
			{
				name: "parent.skill",
				description: "Parent skill.",
				promptSelector: "//script[@id='parent']",
				allowedSkills: [
					{
						name: "child.skill",
						description: "Child skill.",
						promptSelector: "//script[@id='child']",
					},
				],
			},
		],
		context: { document: dom.window.document, window: dom.window },
	};

	const events = await runAgentEvents(messages, options, "hi");

	const skillStarts = events.filter((ev) => ev.type === "tool.start" && ev.isSkill);
	const skillEnds = events.filter((ev) => ev.type === "tool.end" && ev.isSkill);

	assert.equal(skillStarts.length, 2);
	assert.equal(skillEnds.length, 2);
	assert.deepEqual(skillStarts[0].input, { task: "parent task" });
	assert.deepEqual(skillStarts[1].input, { task: "child task" });
	assert.equal(skillStarts[0].depth, 1);
	assert.equal(skillStarts[1].depth, 2);
	assert.equal(skillEnds[0].depth, 2);
	assert.equal(skillEnds[1].depth, 1);
});

test("status events cover main states", async () => {
	let callCount = 0;
	const generate = () => {
		callCount += 1;
		switch (callCount) {
			case 1:
				return streamFrom([
					{
						type: "tool.start",
						name: "explode",
						args: "{}",
						callId: "call-1",
					},
				]);
			case 2:
				return streamFrom([
					{
						type: "tool.start",
						name: "echo",
						args: "{}",
						callId: "call-2",
					},
				]);
			default:
				return streamFrom([
					{ type: "message.delta", delta: "ok" },
					{ type: "message", content: "ok" },
				]);
		}
	};

	const explodeTool = {
		name: "explode",
		description: "Throws.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			throw new Error("boom");
		},
	};
	const echoTool = {
		name: "echo",
		description: "Echoes.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return { ok: true };
		},
	};

	const messages = createAgentMessages();
	const options = { generate, tools: [explodeTool, echoTool] };
	const events = await runAgentEvents(messages, options, "hi");

	const statusKinds = new Set(events.filter((ev) => ev.type === "status").map((ev) => ev.status.kind));
	assert.ok(statusKinds.has("thinking"));
	assert.ok(statusKinds.has("calling_tool"));
	assert.ok(statusKinds.has("tool_result"));
	assert.ok(statusKinds.has("done"));
	assert.ok(statusKinds.has("error"));
});
