import test from "node:test";
import assert from "node:assert/strict";
import { OpenAIModel } from "../dist/index.js";

test("OpenAIModel maps messages and tools", async () => {
	const calls = [];
	const client = {
		chat: {
			completions: {
				async create(payload, options) {
					calls.push({ payload, options });
					return {
						choices: [
							{
								message: {
									content: "ok",
									tool_calls: [],
								},
							},
						],
					};
				},
			},
		},
	};

	const model = new OpenAIModel({ model: "gpt-test", client });
	const req = {
		messages: [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi", name: "bob" },
			{ role: "assistant", content: "reply", name: "bot" },
			{ role: "tool", content: "{}", name: "echo", toolCallId: "t1" },
		],
		tools: [
			{
				name: "echo",
				description: "Echo",
				parameters: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
		],
	};

	const response = await model.generate(req);

	assert.equal(response.message, "ok");
	assert.equal(calls.length, 1);

	const { payload, options } = calls[0];
	assert.equal(payload.model, "gpt-test");
	assert.equal(payload.tool_choice, "auto");
	assert.equal(options, undefined);

	assert.equal(payload.messages[0].role, "system");
	assert.equal(payload.messages[0].content, "sys");
	assert.equal(payload.messages[1].role, "user");
	assert.equal(payload.messages[1].name, "bob");
	assert.equal(payload.messages[2].role, "assistant");
	assert.equal(payload.messages[2].name, "bot");
	assert.equal(payload.messages[3].role, "tool");
	assert.equal(payload.messages[3].tool_call_id, "t1");
	assert.equal(payload.messages[3].content, "{}");

	assert.deepEqual(payload.tools, [
		{
			type: "function",
			function: {
				name: "echo",
				description: "Echo",
				parameters: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					additionalProperties: false,
				},
			},
		},
	]);
});

test("OpenAIModel omits tools when none provided", async () => {
	const calls = [];
	const client = {
		chat: {
			completions: {
				async create(payload) {
					calls.push(payload);
					return {
						choices: [
							{
								message: {
									content: "ok",
								},
							},
						],
					};
				},
			},
		},
	};

	const model = new OpenAIModel({ model: "gpt-test", client });
	await model.generate({ messages: [{ role: "user", content: "hi" }] });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].tool_choice, undefined);
	assert.equal(calls[0].tools, undefined);
});

test("OpenAIModel parses tool calls", async () => {
	const client = {
		chat: {
			completions: {
				async create() {
					return {
						choices: [
							{
								message: {
									content: null,
									tool_calls: [
										{
											id: "call-1",
											function: {
												name: "echo",
												arguments: "{\"value\":\"ok\"}",
											},
										},
									],
								},
							},
						],
					};
				},
			},
		},
	};

	const model = new OpenAIModel({ model: "gpt-test", client });
	const response = await model.generate({
		messages: [{ role: "user", content: "hi" }],
	});

	assert.deepEqual(response.toolCalls, [
		{
			id: "call-1",
			name: "echo",
			args: "{\"value\":\"ok\"}",
		},
	]);
});

test("OpenAIModel returns raw when message missing", async () => {
	const rawResponse = { choices: [] };
	const client = {
		chat: {
			completions: {
				async create() {
					return rawResponse;
				},
			},
		},
	};

	const model = new OpenAIModel({ model: "gpt-test", client });
	const response = await model.generate({
		messages: [{ role: "user", content: "hi" }],
	});

	assert.deepEqual(response.raw, rawResponse);
	assert.equal(response.message, undefined);
});
