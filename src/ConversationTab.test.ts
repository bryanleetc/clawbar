import { describe, it, expect, beforeEach, vi } from "vitest";
import { patchObsidianDom } from "./__mocks__/obsidian-dom";

// Mock modules that ConversationTab imports (besides obsidian, aliased in vitest.config)
vi.mock("./claude/AgentManager", () => ({
	AgentManager: class {
		constructor(_events: unknown) {}
		start() {}
		stop() {}
		detach() {}
		sendMessage() {}
	},
}));

// Patch DOM before importing ConversationTab (its containers use Obsidian DOM helpers)
patchObsidianDom();

import { ConversationTab, type TabHost } from "./ConversationTab";

function createHost(): TabHost {
	return {
		onTabStateChanged: vi.fn(),
		onSessionId: vi.fn(),
		onModels: vi.fn(),
		onSkills: vi.fn(),
	};
}

function createTab(host: TabHost = createHost()): {
	tab: ConversationTab;
	messagesRegion: HTMLElement;
	promptsRegion: HTMLElement;
} {
	const messagesRegion = document.createElement("div");
	const promptsRegion = document.createElement("div");
	const plugin = {
		settings: {
			claudePath: "claude",
			disabledMcpServers: [],
			accounts: [],
			activeAccountId: null,
			selectedModel: null,
		},
	} as any;
	const tab = new ConversationTab(
		{} as any,
		plugin,
		messagesRegion,
		promptsRegion,
		{} as any,
		host,
	);
	return { tab, messagesRegion, promptsRegion };
}

function messagesEl(tab: ConversationTab): HTMLElement {
	return (tab as any).messagesEl;
}

describe("ConversationTab thinking indicator", () => {
	let tab: ConversationTab;

	beforeEach(() => {
		({ tab } = createTab());
	});

	it("showThinking creates thinking element in the tab's messages container", () => {
		(tab as any).showThinking();

		const thinkingEl = messagesEl(tab).querySelector(".clawbar-thinking");
		expect(thinkingEl).not.toBeNull();
		expect((tab as any).thinkingEl).toBe(thinkingEl);
		expect(tab.isThinking()).toBe(true);
	});

	it("hideThinking removes thinking element and resets state", () => {
		(tab as any).showThinking();
		(tab as any).hideThinking();

		expect(messagesEl(tab).querySelector(".clawbar-thinking")).toBeNull();
		expect((tab as any).thinkingEl).toBeNull();
		expect(tab.isThinking()).toBe(false);
	});

	it("hideThinking is idempotent when no thinking element exists", () => {
		expect(() => (tab as any).hideThinking()).not.toThrow();
		expect(tab.isThinking()).toBe(false);
	});

	it("renderMessages preserves thinking element after re-render", async () => {
		(tab as any).showThinking();
		const thinkingRef = (tab as any).thinkingEl;

		tab.messages.push({
			role: "user",
			blocks: [{ type: "text", text: "hello" }],
		});
		await (tab as any).renderMessages();

		const container = messagesEl(tab);
		expect(container.contains(thinkingRef)).toBe(true);
		expect(container.lastElementChild).toBe(thinkingRef);
		expect((tab as any).thinkingEl).toBe(thinkingRef);
	});

	it("renderMessages does not append thinking when thinkingEl is null", async () => {
		tab.messages.push({
			role: "user",
			blocks: [{ type: "text", text: "hello" }],
		});
		await (tab as any).renderMessages();

		expect(messagesEl(tab).querySelector(".clawbar-thinking")).toBeNull();
	});

	it("addMessage triggers renderMessages and preserves thinking", async () => {
		(tab as any).showThinking();
		tab.addMessage("user", [{ type: "text", text: "test" }]);

		// renderMessages is async, wait a tick
		await new Promise((r) => setTimeout(r, 0));

		const container = messagesEl(tab);
		expect(container.querySelector(".clawbar-thinking")).not.toBeNull();
		expect(container.lastElementChild).toBe((tab as any).thinkingEl);
		// 1 message div + 1 thinking div
		expect(container.children.length).toBe(2);
	});

	it("thinking element survives multiple consecutive renderMessages calls", async () => {
		(tab as any).showThinking();
		const thinkingRef = (tab as any).thinkingEl;

		await (tab as any).renderMessages();
		await (tab as any).renderMessages();
		await (tab as any).renderMessages();

		const container = messagesEl(tab);
		expect(container.contains(thinkingRef)).toBe(true);
		expect(container.lastElementChild).toBe(thinkingRef);
		expect(container.querySelectorAll(".clawbar-thinking").length).toBe(1);
	});

	it("showThinking called twice does not duplicate thinking element", () => {
		(tab as any).showThinking();
		(tab as any).showThinking();

		expect(messagesEl(tab).querySelectorAll(".clawbar-thinking").length).toBe(1);
	});

	it("thinking state changes notify the host", () => {
		const host = createHost();
		const { tab } = createTab(host);

		(tab as any).showThinking();
		expect(host.onTabStateChanged).toHaveBeenCalledWith(tab);

		(host.onTabStateChanged as ReturnType<typeof vi.fn>).mockClear();
		(tab as any).hideThinking();
		expect(host.onTabStateChanged).toHaveBeenCalledWith(tab);
	});
});

describe("ConversationTab prompt/message container separation", () => {
	it("prompts render into their own container and survive message re-renders", async () => {
		const { tab } = createTab();
		const promptsEl = (tab as any).promptsEl as HTMLElement;
		const container = messagesEl(tab);

		(tab as any).prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		expect(promptsEl.querySelector(".clawbar-permission-prompt")).not.toBeNull();
		expect(container.querySelector(".clawbar-permission-prompt")).toBeNull();

		tab.messages.push({ role: "user", blocks: [{ type: "text", text: "hi" }] });
		await (tab as any).renderMessages();
		await (tab as any).renderMessages();

		expect(promptsEl.querySelector(".clawbar-permission-prompt")).not.toBeNull();
	});
});

describe("ConversationTab visibility and activity", () => {
	it("starts hidden; show/hide toggle the tab's containers", () => {
		const { tab } = createTab();
		const container = messagesEl(tab);
		const promptsEl = (tab as any).promptsEl as HTMLElement;

		expect(container.style.display).toBe("none");
		expect(tab.isActive()).toBe(false);

		tab.show();
		expect(container.style.display).toBe("");
		expect(promptsEl.style.display).toBe("");
		expect(tab.isActive()).toBe(true);

		tab.hide();
		expect(container.style.display).toBe("none");
		expect(promptsEl.style.display).toBe("none");
		expect(tab.isActive()).toBe(false);
	});

	it("a result while hidden marks the tab unseen; show clears it", () => {
		const host = createHost();
		const { tab } = createTab(host);
		tab.hide();

		(tab as any).handleSDKMessage({ type: "result", is_error: false });

		expect(tab.hasUnseen()).toBe(true);
		expect(host.onTabStateChanged).toHaveBeenCalledWith(tab);

		tab.show();
		expect(tab.hasUnseen()).toBe(false);
	});

	it("a result while visible does not mark the tab unseen", () => {
		const { tab } = createTab();
		tab.show();

		(tab as any).handleSDKMessage({ type: "result", is_error: false });

		expect(tab.hasUnseen()).toBe(false);
	});

	it("dispose removes the tab's containers from the regions", async () => {
		const { tab, messagesRegion, promptsRegion } = createTab();

		await tab.dispose();

		expect(messagesRegion.children.length).toBe(0);
		expect(promptsRegion.children.length).toBe(0);
	});
});
