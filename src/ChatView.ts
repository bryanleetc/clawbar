import { ItemView, Notice, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import { ConversationTab, type TabHost } from "./ConversationTab";
import type { SessionMeta, SlashCommand } from "./claude/types";
import type ClawbarPlugin from "./main";
import { BUILTIN_COMMANDS, MAX_INLINE_FILE_CHARS } from "./constants";
import { UsageModal } from "./UsageModal";
import { McpSettingsModal } from "./McpSettingsModal";
import { InputArea } from "./InputArea";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

const TAB_TITLE_MAX_CHARS = 24;

export class ChatView extends ItemView implements TabHost {
	private tabs: ConversationTab[] = [];
	private activeTab: ConversationTab | null = null;
	private tabStripEl: HTMLElement;
	private messagesRegion: HTMLElement;
	private promptsRegion: HTMLElement;
	private activeFile: TFile | null = null;
	private inputComponent: InputArea;
	plugin: ClawbarPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ClawbarPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return "Claude Code";
	}

	getIcon(): string {
		return "message-square";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("clawbar-container");

		this.tabStripEl = container.createDiv({ cls: "clawbar-tab-strip" });
		this.messagesRegion = container.createDiv({ cls: "clawbar-messages-region" });
		this.promptsRegion = container.createDiv({ cls: "clawbar-prompts-region" });

		this.inputComponent = new InputArea(container, this.app, {
			onSubmit: (text) => this.handleSubmit(text),
			onStop: () => this.handleStop(),
			onSettings: () => {
				const agent = this.activeTab?.getAgent();
				if (agent) new McpSettingsModal(this.app, agent, this.plugin).open();
			},
			onModelChange: (model) => this.handleModelChange(model),
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.activeFile = this.app.workspace.getActiveFile();
				this.inputComponent.updateContextBar(this.activeFile);
			})
		);
		this.activeFile = this.app.workspace.getActiveFile();
		this.inputComponent.updateContextBar(this.activeFile);

		this.restoreTabs();
	}

	async onClose() {
		await this.persistOpenTabs();
		for (const tab of this.tabs) {
			await tab.dispose();
		}
		this.tabs = [];
		this.activeTab = null;
		this.inputComponent.destroy();
	}

	async restartForAccountChange() {
		for (const tab of this.tabs) {
			await tab.dispose();
		}
		this.tabs = [];
		this.activeTab = null;
		this.newTab();
	}

	// --- TabHost ---

	onTabStateChanged(tab: ConversationTab) {
		this.renderTabStrip();
		if (tab === this.activeTab) {
			this.inputComponent.setThinking(tab.isThinking());
		}
	}

	onSessionId(tab: ConversationTab) {
		this.persistOpenTabs();
		this.renderTabStrip();
	}

	onModels(tab: ConversationTab) {
		if (tab === this.activeTab) {
			this.inputComponent.setModels(tab.models, tab.currentModel);
		}
	}

	onSkills(skills: SlashCommand[]) {
		this.inputComponent.setCommands([
			...BUILTIN_COMMANDS,
			...skills.map((s) => ({
				name: s.name,
				description: s.description,
				argumentHint: s.argumentHint,
			})),
		]);
	}

	// --- Tab management ---

	/** Recreate tabs persisted from the last session; falls back to one fresh tab. */
	private restoreTabs() {
		const store = this.plugin.conversationStore;
		const sessionIds = this.plugin.settings.openSessionIds.length > 0
			? this.plugin.settings.openSessionIds
			// Migration from the pre-tabs single-session layout
			: this.plugin.settings.currentSessionId
				? [this.plugin.settings.currentSessionId]
				: [];

		for (const sessionId of sessionIds) {
			const messages = store?.loadSession(sessionId);
			if (!messages || messages.length === 0) continue;
			const tab = this.createTab();
			tab.loadMessages(sessionId, messages);
			tab.startAgent(sessionId);
			this.tabs.push(tab);
		}

		if (this.tabs.length === 0) {
			this.newTab();
			return;
		}

		const current = this.tabs.find(
			(t) => t.sessionId === this.plugin.settings.currentSessionId
		);
		this.activateTab(current ?? this.tabs[0]);
	}

	private createTab(): ConversationTab {
		return new ConversationTab(
			this.app,
			this.plugin,
			this.messagesRegion,
			this.promptsRegion,
			this,
			this,
		);
	}

	private newTab(): ConversationTab {
		const tab = this.createTab();
		tab.startAgent();
		this.tabs.push(tab);
		this.activateTab(tab);
		return tab;
	}

	/** Open a saved session as a tab, or focus it if it's already open. */
	private openSession(sessionId: string) {
		const existing = this.tabs.find((t) => t.sessionId === sessionId);
		if (existing) {
			this.activateTab(existing);
			return;
		}

		const messages = this.plugin.conversationStore?.loadSession(sessionId);
		if (!messages) {
			new Notice("Could not load conversation.");
			return;
		}

		const tab = this.createTab();
		tab.loadMessages(sessionId, messages);
		tab.startAgent(sessionId);
		this.tabs.push(tab);
		this.activateTab(tab);
	}

	private activateTab(tab: ConversationTab) {
		for (const t of this.tabs) {
			if (t === tab) t.show();
			else t.hide();
		}
		this.activeTab = tab;
		this.inputComponent.setThinking(tab.isThinking());
		this.inputComponent.setModels(tab.models, tab.currentModel);
		this.persistOpenTabs();
		this.renderTabStrip();
	}

	private async closeTab(tab: ConversationTab) {
		const index = this.tabs.indexOf(tab);
		if (index === -1) return;

		this.tabs.splice(index, 1);
		await tab.dispose();

		if (this.tabs.length === 0) {
			this.newTab();
		} else if (tab === this.activeTab) {
			this.activateTab(this.tabs[Math.min(index, this.tabs.length - 1)]);
		} else {
			this.persistOpenTabs();
			this.renderTabStrip();
		}
	}

	/** Replace the active tab with a fresh conversation (used by /clear). */
	private async resetActiveTab() {
		const old = this.activeTab;
		const index = old ? this.tabs.indexOf(old) : -1;

		const tab = this.createTab();
		tab.startAgent();
		if (index >= 0) {
			this.tabs[index] = tab;
		} else {
			this.tabs.push(tab);
		}
		this.activateTab(tab);
		await old?.dispose();
	}

	private async persistOpenTabs() {
		this.plugin.settings.openSessionIds = this.tabs
			.map((t) => t.sessionId)
			.filter((id): id is string => id !== null);
		this.plugin.settings.currentSessionId = this.activeTab?.sessionId ?? null;
		await this.plugin.saveSettings();
	}

	// --- Tab strip rendering ---

	private renderTabStrip() {
		this.tabStripEl.empty();

		const sessions = this.plugin.conversationStore?.getIndex() ?? [];

		for (const tab of this.tabs) {
			const tabEl = this.tabStripEl.createDiv({
				cls: `clawbar-tab${tab === this.activeTab ? " clawbar-tab-active" : ""}`,
			});

			if (tab.isThinking()) {
				tabEl.createSpan({ cls: "clawbar-tab-thinking" });
			} else if (tab.hasUnseen()) {
				tabEl.createSpan({ cls: "clawbar-tab-unseen" });
			}

			const title = this.getTabTitle(tab, sessions);
			tabEl.createSpan({ cls: "clawbar-tab-title", text: title });
			tabEl.setAttribute("title", title);

			const closeBtn = tabEl.createSpan({ cls: "clawbar-tab-close", text: "×" });
			closeBtn.setAttribute("aria-label", "Close tab");
			closeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.closeTab(tab);
			});

			tabEl.addEventListener("click", () => {
				if (tab !== this.activeTab) this.activateTab(tab);
			});
			tabEl.addEventListener("auxclick", (e) => {
				if (e.button === 1) this.closeTab(tab);
			});
		}

		const newBtn = this.tabStripEl.createEl("button", {
			cls: "clawbar-tab-new",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => this.newTab());

		this.renderHistorySelect(sessions);
	}

	/** Dropdown of saved sessions not currently open; picking one opens it as a tab. */
	private renderHistorySelect(sessions: SessionMeta[]) {
		const openIds = new Set(this.tabs.map((t) => t.sessionId));
		const closed = sessions.filter((s) => !openIds.has(s.sessionId));
		if (closed.length === 0) return;

		const select = this.tabStripEl.createEl("select", { cls: "clawbar-tab-history" });
		select.createEl("option", {
			text: "History…",
			attr: { value: "", selected: "selected", disabled: "disabled" },
		});
		for (const session of closed) {
			const date = new Date(session.updatedAt).toLocaleDateString();
			select.createEl("option", {
				text: `${session.title} — ${date}`,
				attr: { value: session.sessionId },
			});
		}
		select.addEventListener("change", (e) => {
			const value = (e.target as HTMLSelectElement).value;
			if (value) this.openSession(value);
		});
	}

	private getTabTitle(tab: ConversationTab, sessions: SessionMeta[]): string {
		const meta = tab.sessionId
			? sessions.find((s) => s.sessionId === tab.sessionId)
			: undefined;
		let title = meta?.title;

		if (!title) {
			// Not saved yet — derive from the first user message, if any
			const firstUser = tab.messages.find((m) => m.role === "user");
			const text = firstUser?.blocks.find((b) => b.type === "text")?.text?.trim();
			title = text || "New chat";
		}

		return title.length > TAB_TITLE_MAX_CHARS
			? title.substring(0, TAB_TITLE_MAX_CHARS - 1) + "…"
			: title;
	}

	// --- Input handling ---

	private async handleSubmit(text: string) {
		if (text === "/clear") {
			this.inputComponent.clear();
			this.resetActiveTab();
			return;
		}
		if (text === "/usage") {
			this.inputComponent.clear();
			this.showUsageModal();
			return;
		}
		if (!this.activeTab) return;

		const tab = this.activeTab;
		this.inputComponent.clear();
		tab.sendUserMessage(text, await this.buildOutgoingMessage(text));
	}

	/** Prepend @file references and active-file context to the outgoing message. */
	private async buildOutgoingMessage(text: string): Promise<string> {
		const fileRefContext = await this.inputComponent.resolveFileReferences(text);

		let message = text;
		// Skill commands (/foo) skip the active-file context
		if (this.activeFile && !text.startsWith("/")) {
			const content = await this.app.vault.read(this.activeFile);
			const inline = content.length < MAX_INLINE_FILE_CHARS
				? `\n\`\`\`\n${content}\n\`\`\``
				: "";
			message = `[Active file: ${this.activeFile.path}]${inline}\n\n${text}`;
		}
		return fileRefContext + message;
	}

	private showUsageModal() {
		const modal = new UsageModal(this.app);
		modal.open();
		this.activeTab?.requestUsage((markdown) => {
			if (markdown.trim()) {
				modal.showContent(markdown);
			} else {
				modal.showError("No usage data returned.");
			}
		});
	}

	private async handleModelChange(model: string) {
		try {
			await this.activeTab?.setModel(model);
			this.plugin.settings.selectedModel = model;
			await this.plugin.saveSettings();
			new Notice(`Model switched to ${model}`);
		} catch (err) {
			new Notice(`Could not switch model: ${err instanceof Error ? err.message : err}`);
		}
	}

	private handleStop() {
		this.activeTab?.stop();
		new Notice("Request cancelled");
	}
}
