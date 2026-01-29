import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as E from "fp-ts/lib/Either.js";
import { createAgentMessages, runAgent } from "../dist/index.js";

async function collectEvents(generator) {
	const events = [];
	for await (const ev of generator) {
		events.push(ev);
	}
	return events;
}

function rightEvents(events) {
	return events.filter(E.isRight).map((event) => event.right);
}

function leftErrors(events) {
	return events.filter(E.isLeft).map((event) => event.left);
}

function runAgentEvents(messages, generate, input, tools, skills, maxSteps, context, signal) {
	return collectEvents(runAgent(messages, generate, input, tools, skills, maxSteps, context, signal));
}

function streamFrom(events) {
	return (async function* () {
		for (const event of events) {
			yield E.right(event);
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
	const events = await runAgentEvents(messages, generate, "hi");
	const rights = rightEvents(events);

	const deltaEvent = rights.find((ev) => ev.type === "message.delta");
	const messageEvent = rights.find((ev) => ev.type === "message");
	const thinkingEvent = rights.find((ev) => ev.type === "thinking");
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
	const events = await runAgentEvents(messages, generate, "hi");
	const rights = rightEvents(events);

	assert.ok(rights.some((ev) => ev.type === "message" && ev.content === "ok"));
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
	const events = await runAgentEvents(messages, generate, "test", [tool]);
	const rights = rightEvents(events);

	assert.ok(rights.some((ev) => ev.type === "tool.start" && ev.name === "echo"));
	assert.ok(rights.some((ev) => ev.type === "tool.end" && ev.name === "echo"));
	assert.ok(rights.some((ev) => ev.type === "message" && ev.content === "done"));
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
	const events = await runAgentEvents(messages, generate, "test", []);
	const errors = leftErrors(events);

	assert.ok(errors.length > 0);
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
	const events = await runAgentEvents(messages, generate, "test", [tool]);
	const errors = leftErrors(events);

	assert.ok(errors.length > 0);
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
	const events = await runAgentEvents(messages, generate, "test", [tool], [], 2);
	const rights = rightEvents(events);

	assert.equal(calls, 2);
	assert.ok(rights.some((ev) => ev.type === "done"));
	assert.ok(!rights.some((ev) => ev.type === "message"));
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
	const events = await runAgentEvents(messages, generate, "test", [tool]);
	const rights = rightEvents(events);

	const startEvent = rights.find((ev) => ev.type === "tool.start");
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
	const events = await runAgentEvents(messages, generate, "test", [tool]);
	const rights = rightEvents(events);

	const startEvent = rights.find((ev) => ev.type === "tool.start");
	assert.equal(startEvent?.args, "not json");
});

test("reports model errors", async () => {
	const generate = async function* () {
		throw new Error("model down");
	};

	const messages = createAgentMessages();
	const events = await runAgentEvents(messages, generate, "test");
	const errors = leftErrors(events);

	assert.ok(errors.length > 0);
});

test("reset clears history between runs", async () => {
	const lengths = [];
	const generate = (messages) => {
		lengths.push(messages.length);
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	let messages = createAgentMessages();
	await runAgentEvents(messages, generate, "one");
	messages = createAgentMessages();
	await runAgentEvents(messages, generate, "two");

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
		yield E.right({ type: "message", content: "ok" });
	};

	const messages = createAgentMessages();
	const firstRun = collectEvents(runAgent(messages, generate, "one"));
	const secondRun = collectEvents(runAgent(messages, generate, "two"));
	const [firstEvents, secondEvents] = await Promise.all([firstRun, secondRun]);
	const secondRights = rightEvents(secondEvents);

	assert.ok(firstSignal?.aborted);
	assert.ok(rightEvents(firstEvents).some((ev) => ev.type === "done"));
	assert.ok(secondRights.some((ev) => ev.type === "message" && ev.content === "ok"));
});

test("root cycle inserts skill list message", async () => {
	let seenMessages = null;
	const generate = (messages) => {
		seenMessages = messages;
		return streamFrom([{ type: "message", content: "ok" }]);
	};

	const messages = createAgentMessages();
	const skills = [
		{
			name: "demo.skill",
			description: "Demo skill.",
			promptSelector: "//script[@id='skill']",
		},
	];

	await runAgentEvents(messages, generate, "hi", [], skills);

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
	const skills = [
		{
			name: "demo.skill",
			description: "Demo skill.",
			promptSelector: "//script[@id='skill']",
		},
	];

	const events = await runAgentEvents(
		messages,
		generate,
		"Please do $demo.skill if needed",
		[],
		skills
	);
	const rights = rightEvents(events);
	assert.ok(!rights.some((ev) => ev.type === "tool.start"));
	assert.ok(rights.some((ev) => ev.type === "message" && ev.content === "ok"));
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
	const skills = [
		{
			name: "dom.skill",
			description: "Reads prompt from DOM.",
			promptSelector: "//script[@id='skill']",
		},
	];
	const context = { document: dom.window.document, window: dom.window };

	await runAgentEvents(messages, generate, "hi", [], skills, undefined, context);

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
	const skills = [
		{
			name: "dom.skill",
			description: "Reads prompt from DOM.",
			promptSelector: "//script[@id='skill']",
		},
	];
	const context = { document: dom.window.document, window: dom.window };

	await runAgentEvents(messages, generate, "hi", [], skills, undefined, context);

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
	const skills = [
		{
			name: "dom.skill",
			description: "Reads prompt from DOM.",
			promptSelector: "//script[@id='skill']",
		},
	];
	const context = { document: dom.window.document, window: dom.window };

	const events = await runAgentEvents(messages, generate, "hi", [], skills, undefined, context);
	const errors = leftErrors(events);

	assert.equal(callCount, 1);
	assert.ok(errors.length > 0);
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
	const skills = [
		{
			name: "bad.skill",
			description: "Needs task.",
			promptSelector: "//script[@id='skill']",
		},
	];

	const events = await runAgentEvents(messages, generate, "hi", [], skills);
	const errors = leftErrors(events);

	assert.equal(callCount, 1);
	assert.ok(errors.length > 0);
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
	const skills = [
		{
			name: "parent.skill",
			description: "Parent skill.",
			promptSelector: "//script[@id='parent']",
			allowedSkills: [childSkill],
			tools: [childTool],
		},
		otherSkill,
	];
	const context = { document: dom.window.document, window: dom.window };

	await runAgentEvents(messages, generate, "hi", [rootTool], skills, undefined, context);

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
	const skills = [
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
	];
	const context = { document: dom.window.document, window: dom.window };

	const events = await runAgentEvents(messages, generate, "hi", [], skills, undefined, context);
	const rights = rightEvents(events);

	const skillStarts = rights.filter((ev) => ev.type === "tool.start" && ev.isSkill);
	const skillEnds = rights.filter((ev) => ev.type === "tool.end" && ev.isSkill);

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

	const echoTool = {
		name: "echo",
		description: "Echoes.",
		parameters: { type: "object", additionalProperties: false },
		run() {
			return { ok: true };
		},
	};

	const messages = createAgentMessages();
	const events = await runAgentEvents(messages, generate, "hi", [echoTool]);
	const rights = rightEvents(events);

	const statusKinds = new Set(rights.filter((ev) => ev.type === "status").map((ev) => ev.status.kind));
	assert.ok(statusKinds.has("thinking"));
	assert.ok(statusKinds.has("calling_tool"));
	assert.ok(statusKinds.has("tool_result"));
	assert.ok(statusKinds.has("done"));
});
