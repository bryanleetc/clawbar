import { describe, it, expect, beforeEach, vi } from "vitest";
import { patchObsidianDom } from "./__mocks__/obsidian-dom";

// Mock modules that ChatView imports (besides obsidian, which is aliased in vitest.config)
vi.mock("./claude/AgentManager", () => ({
	AgentManager: class {
		constructor(_events: unknown) {}
		start() {}
		stop() {}
		detach() {}
		sendMessage() {}
	},
}));

vi.mock("./UsageModal", () => ({
	UsageModal: class {
		constructor() {}
		open() {}
	},
}));

vi.mock("./FileSearchProvider", () => ({
	FileSearchProvider: class {
		constructor() {}
		handleInput() { return false; }
		handleKeydown() { return false; }
	},
}));

// Patch DOM before importing ChatView (which extends ItemView)
patchObsidianDom();

import { ChatView } from "./ChatView";
import { MessageRenderer } from "./MessageRenderer";
import { PromptManager } from "./PromptManager";
import { WorkspaceLeaf } from "obsidian";

function createChatView(): ChatView {
	const leaf = new WorkspaceLeaf();
	const plugin = { settings: { claudePath: "claude" }, loadData: async () => ({}) } as any;
	return new ChatView(leaf as any, plugin);
}

function setupDom(view: ChatView): { messagesContainer: HTMLElement; promptsContainer: HTMLElement } {
	const messagesContainer = document.createElement("div");
	const promptsContainer = document.createElement("div");
	(view as any).messagesContainer = messagesContainer;
	(view as any).renderer = new MessageRenderer((view as any).app, messagesContainer, view as any);
	(view as any).prompts = new PromptManager(promptsContainer);
	(view as any).messages = [];
	(view as any).thinkingEl = null;
	(view as any).inputComponent = {
		_thinking: false,
		setThinking(val: boolean) { this._thinking = val; },
		clear() {},
		destroy() {},
	};
	return { messagesContainer, promptsContainer };
}

describe("ChatView thinking indicator", () => {
	let view: ChatView;

	beforeEach(() => {
		view = createChatView();
		setupDom(view);
	});

	it("showThinking creates thinking element in messagesContainer", () => {
		(view as any).showThinking();

		const container = (view as any).messagesContainer as HTMLElement;
		const thinkingEl = container.querySelector(".clawbar-thinking");
		expect(thinkingEl).not.toBeNull();
		expect((view as any).thinkingEl).toBe(thinkingEl);
		expect((view as any).inputComponent._thinking).toBe(true);
	});

	it("hideThinking removes thinking element and resets buttons", () => {
		(view as any).showThinking();
		(view as any).hideThinking();

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.querySelector(".clawbar-thinking")).toBeNull();
		expect((view as any).thinkingEl).toBeNull();
		expect((view as any).inputComponent._thinking).toBe(false);
	});

	it("hideThinking is idempotent when no thinking element exists", () => {
		expect(() => (view as any).hideThinking()).not.toThrow();
		expect((view as any).inputComponent._thinking).toBe(false);
	});

	it("renderMessages preserves thinking element after re-render", async () => {
		(view as any).showThinking();
		const thinkingRef = (view as any).thinkingEl;

		(view as any).messages.push({
			role: "user",
			blocks: [{ type: "text", text: "hello" }],
		});
		await (view as any).renderMessages();

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.contains(thinkingRef)).toBe(true);
		expect(container.lastElementChild).toBe(thinkingRef);
		expect((view as any).thinkingEl).toBe(thinkingRef);
	});

	it("renderMessages does not append thinking when thinkingEl is null", async () => {
		(view as any).messages.push({
			role: "user",
			blocks: [{ type: "text", text: "hello" }],
		});
		await (view as any).renderMessages();

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.querySelector(".clawbar-thinking")).toBeNull();
	});

	it("addMessage triggers renderMessages and preserves thinking", async () => {
		(view as any).showThinking();
		view.addMessage("user", [{ type: "text", text: "test" }]);

		// renderMessages is async, wait a tick
		await new Promise((r) => setTimeout(r, 0));

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.querySelector(".clawbar-thinking")).not.toBeNull();
		expect(container.lastElementChild).toBe((view as any).thinkingEl);
		// 1 message div + 1 thinking div
		expect(container.children.length).toBe(2);
	});

	it("thinking element survives multiple consecutive renderMessages calls", async () => {
		(view as any).showThinking();
		const thinkingRef = (view as any).thinkingEl;

		await (view as any).renderMessages();
		await (view as any).renderMessages();
		await (view as any).renderMessages();

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.contains(thinkingRef)).toBe(true);
		expect(container.lastElementChild).toBe(thinkingRef);
		expect(container.querySelectorAll(".clawbar-thinking").length).toBe(1);
	});

	it("showThinking called twice does not duplicate thinking element", () => {
		(view as any).showThinking();
		(view as any).showThinking();

		const container = (view as any).messagesContainer as HTMLElement;
		expect(container.querySelectorAll(".clawbar-thinking").length).toBe(1);
	});
});

describe("ChatView prompt/message container separation", () => {
	it("prompts render into their own container and survive message re-renders", async () => {
		const view = createChatView();
		const { messagesContainer, promptsContainer } = setupDom(view);

		(view as any).prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		expect(promptsContainer.querySelector(".clawbar-permission-prompt")).not.toBeNull();
		expect(messagesContainer.querySelector(".clawbar-permission-prompt")).toBeNull();

		(view as any).messages.push({ role: "user", blocks: [{ type: "text", text: "hi" }] });
		await (view as any).renderMessages();
		await (view as any).renderMessages();

		expect(promptsContainer.querySelector(".clawbar-permission-prompt")).not.toBeNull();
	});
});
