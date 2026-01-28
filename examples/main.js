import OpenAI from "openai";
import { createAgent, jsInterpreterTool, localStoreTool } from "browseragentkit";

const logEl = document.getElementById("log");
const runBtn = document.getElementById("runBtn");
const chatLog = document.getElementById("chatLog");
const canvas = document.getElementById("canvas");
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const promptInput = document.getElementById("prompt");

const params = new URLSearchParams(window.location.search);
if (baseUrlInput && params.has("baseUrl")) {
	baseUrlInput.value = params.get("baseUrl") ?? "";
}
if (apiKeyInput && params.has("apiKey")) {
	apiKeyInput.value = params.get("apiKey") ?? "";
}
if (promptInput && params.has("message")) {
	promptInput.value = params.get("message") ?? "";
}

function addMessage(role, text) {
	if (!chatLog) {
		return;
	}
	const wrapper = document.createElement("div");
	wrapper.className = `message ${role}`;

	const bubble = document.createElement("div");
	bubble.className = "bubble";
	bubble.textContent = text;

	wrapper.appendChild(bubble);
	chatLog.appendChild(wrapper);
	chatLog.scrollTop = chatLog.scrollHeight;
}

const skills = [
	{
		name: "canvas.render",
		description: "Renders HTML into the right-side canvas using the JS interpreter helpers.",
		promptMd: `
# Goal
Create or update HTML inside the canvas.

# Steps
1) Use the JS interpreter. It provides \`x()\`, \`replaceSubtree()\`, \`diffSubtree()\`, and \`viewRoot\`.
2) Build HTML as a string and call \`replaceSubtree(x("/")[0], html)\` to replace the canvas content.
3) Keep the response short and confirm what changed.

# Notes
- The agent can only see the canvas subtree.
`,
	},
];

runBtn.addEventListener("click", async () => {
	if (!canvas) {
		addMessage("assistant", "Canvas element not found.");
		return;
	}
	if (logEl) {
		logEl.textContent = "";
	}

	const baseUrl = baseUrlInput.value.trim();
	const apiKey = apiKeyInput.value.trim();
	const prompt = promptInput.value.trim();

	if (!prompt) {
		return;
	}

	addMessage("user", prompt);
	runBtn.disabled = true;

	const client = new OpenAI({
		baseURL: baseUrl,
		apiKey: apiKey || undefined,
		dangerouslyAllowBrowser: true,
	});

	const agent = createAgent({
		generate: async ({ messages, tools, signal }) => {
			const response = await client.chat.completions.create(
				{
					model: "gpt-4.1-mini",
					messages,
					tools,
					tool_choice: tools?.length ? "auto" : undefined,
				},
				signal ? { signal } : undefined
			);
			const message = response.choices?.[0]?.message;
			const toolCalls = Array.isArray(message?.tool_calls)
				? message.tool_calls
					.map((call) =>
						call?.function?.name
							? { id: call.id, name: call.function.name, args: call.function.arguments ?? "{}" }
							: null
					)
					.filter((call) => call !== null)
				: [];
			return { message: message?.content ?? undefined, toolCalls, raw: response };
		},
		viewRoot: canvas,
		skills,
		tools: [
			jsInterpreterTool(),
			localStoreTool({ namespace: "bak" }),
		],
		policies: { maxSteps: 25 },
	});

	try {
		for await (const ev of agent.run(prompt)) {
			if (ev.type === "message") {
				addMessage("assistant", ev.content);
			}
			if (ev.type === "error") {
				console.error(JSON.stringify(ev.error));
				addMessage("assistant", `${String(ev.error)}`);
			}
		}
	} catch (error) {
		addMessage("assistant", `${String(error)}`);
		console.error(error);
	} finally {
		runBtn.disabled = false;
	}
});
