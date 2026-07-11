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

	it("showThinking sets thinking state without touching the messages container", () => {
		(tab as any).showThinking();

		expect(tab.isThinking()).toBe(true);
		expect(messagesEl(tab).children.length).toBe(0);
	});

	it("hideThinking resets state", () => {
		(tab as any).showThinking();
		(tab as any).hideThinking();

		expect(tab.isThinking()).toBe(false);
	});

	it("hideThinking is idempotent when not thinking", () => {
		expect(() => (tab as any).hideThinking()).not.toThrow();
		expect(tab.isThinking()).toBe(false);
	});

	it("hideThinking does not notify the host when already idle", () => {
		const host = createHost();
		const { tab } = createTab(host);

		(tab as any).hideThinking();
		expect(host.onTabStateChanged).not.toHaveBeenCalled();
	});

	it("thinking state survives message re-renders", async () => {
		(tab as any).showThinking();

		tab.messages.push({
			role: "user",
			blocks: [{ type: "text", text: "hello" }],
		});
		await (tab as any).renderMessages();

		expect(tab.isThinking()).toBe(true);
		// only the message itself is rendered
		expect(messagesEl(tab).children.length).toBe(1);
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
