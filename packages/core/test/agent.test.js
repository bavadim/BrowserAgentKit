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
