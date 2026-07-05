import { ItemView, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { homedir } from "os";
import { AgentManager } from "./claude/AgentManager";
import {
	assistantBlocks,
	isReplay,
	toolResultBlocks,
	toolResultText,
} from "./claude/types";
import type { SDKMessage, ContentBlock, Message, SessionMeta } from "./claude/types";
import type ClawbarPlugin from "./main";
import { BUILTIN_COMMANDS, MAX_INLINE_FILE_CHARS } from "./constants";
import { UsageModal } from "./UsageModal";
import { McpSettingsModal } from "./McpSettingsModal";
import { InputArea } from "./InputArea";
import { MessageRenderer } from "./MessageRenderer";
import { PromptManager } from "./PromptManager";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

// Delay before re-applying persisted disabled MCPs, to let the agent initialize
const MCP_REAPPLY_DELAY_MS = 2000;

export class ChatView extends ItemView {
	private messages: Message[] = [];
	private messagesContainer: HTMLElement;
	private thinkingEl: HTMLElement | null = null;
	private renderer: MessageRenderer;
	private prompts: PromptManager;
	private agent: AgentManager | null = null;
	private activeFile: TFile | null = null;
	private currentSessionId: string | null = null;
	private sessionBarEl: HTMLElement;
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

		this.sessionBarEl = container.createDiv({ cls: "clawbar-session-bar" });
		this.messagesContainer = container.createDiv({ cls: "clawbar-messages" });
		this.renderer = new MessageRenderer(this.app, this.messagesContainer, this);
		this.prompts = new PromptManager(container.createDiv({ cls: "clawbar-prompts" }));

		this.inputComponent = new InputArea(container, this.app, {
			onSubmit: (text) => this.handleSubmit(text),
			onStop: () => this.handleStop(),
			onSettings: () => {
				if (this.agent) new McpSettingsModal(this.app, this.agent, this.plugin).open();
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

		// Auto-resume the last session if it has saved messages
		const lastSessionId = this.plugin.settings.currentSessionId;
		const saved = lastSessionId
			? this.plugin.conversationStore?.loadSession(lastSessionId)
			: null;
		if (lastSessionId && saved && saved.length > 0) {
			this.messages = saved;
			this.currentSessionId = lastSessionId;
		}

		this.renderMessages();
		this.renderSessionBar();
		this.startAgent(this.currentSessionId ?? undefined);
	}

	async onClose() {
		await this.saveCurrentConversation();
		this.agent?.stop();
		this.inputComponent.destroy();
	}

	async restartForAccountChange() {
		await this.switchToSession(null);
	}

	// --- Agent lifecycle ---

	private startAgent(resumeSessionId?: string) {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			new Notice("Could not get vault base path");
			return;
		}

		this.agent = new AgentManager({
			onMessage: (msg) => this.handleSDKMessage(msg),
			onError: (err) => this.handleAgentError(err, resumeSessionId),
			onPermission: (toolName, toolInput) => this.prompts.request(toolName, toolInput),
			onSkills: (skills) =>
				this.inputComponent.setCommands([
					...BUILTIN_COMMANDS,
					...skills.map((s) => ({
						name: s.name,
						description: s.description,
						argumentHint: s.argumentHint,
					})),
				]),
			onSessionId: (id) => {
				this.currentSessionId = id;
				this.renderSessionBar();
			},
			onModels: (models, currentModel) => this.inputComponent.setModels(models, currentModel),
		});

		// Ensure buttons are in initial state
		this.hideThinking();
		this.reapplyDisabledMcps();

		const activeAccount = this.plugin.settings.accounts?.find(
			(a) => a.id === this.plugin.settings.activeAccountId
		);
		this.agent.start(
			vaultPath,
			this.plugin.settings.claudePath,
			resumeSessionId,
			activeAccount?.configDir?.replace(/^~/, homedir()),
			this.plugin.settings.selectedModel ?? undefined,
		);
	}

	private handleAgentError(err: string, resumeSessionId?: string) {
		this.hideThinking();
		if (resumeSessionId) {
			// Session resume failed (e.g. stale session after vault reopen) — retry fresh
			console.log(`[Clawbar] Session resume failed, starting fresh. Error: ${err}`);
			this.startAgent();
		} else {
			new Notice(`Claude error: ${err}`);
			console.log(`Claude error: ${err}`);
		}
	}

	private reapplyDisabledMcps() {
		const disabled = this.plugin.settings.disabledMcpServers;
		if (disabled.length === 0) return;
		setTimeout(async () => {
			for (const name of disabled) {
				try {
					await this.agent?.toggleMcpServer(name, false);
					console.log(`[Clawbar] MCP server disabled: ${name}`);
				} catch (err) {
					console.error(`[Clawbar] Failed to disable MCP server "${name}":`, err);
				}
			}
		}, MCP_REAPPLY_DELAY_MS);
	}

	private async handleModelChange(model: string) {
		try {
			await this.agent?.setModel(model);
			this.plugin.settings.selectedModel = model;
			await this.plugin.saveSettings();
			new Notice(`Model switched to ${model}`);
		} catch (err) {
			new Notice(`Could not switch model: ${err instanceof Error ? err.message : err}`);
		}
	}

	// --- SDK message handling ---

	private handleSDKMessage(msg: SDKMessage) {
		// Resume replays are skipped — the UI already has these messages loaded
		if (isReplay(msg)) return;

		switch (msg.type) {
			case "result":
				this.hideThinking();
				this.saveCurrentConversation();
				return;
			case "assistant":
				this.handleAssistantMessage(assistantBlocks(msg) ?? []);
				return;
			case "user":
				this.applyToolResults(toolResultBlocks(msg));
				return;
		}
	}

	private handleAssistantMessage(blocks: ContentBlock[]) {
		// AskUserQuestion is excluded — it's handled interactively via the permission prompt
		const textBlocks = blocks.filter((b) => b.type === "text");
		const toolBlocks = blocks.filter(
			(b) => b.type === "tool_use" && b.name !== "AskUserQuestion"
		);
		if (textBlocks.length === 0 && toolBlocks.length === 0) return;

		if (textBlocks.length > 0) {
			// Text alongside tool calls is intermediate narration ("Thinking")
			this.messages.push({
				role: "assistant",
				blocks: textBlocks,
				isThinking: toolBlocks.length > 0,
			});
		}
		for (const block of toolBlocks) {
			this.messages.push({
				role: "tool",
				blocks: [block],
				toolName: block.name,
				toolId: block.id,
			});
		}
		this.renderMessages();
	}

	private applyToolResults(results: ContentBlock[]) {
		if (results.length === 0) return;
		for (const result of results) {
			const toolMsg = this.messages.find(
				(m) => m.role === "tool" && m.toolId === result.tool_use_id
			);
			if (toolMsg) {
				toolMsg.toolResult = toolResultText(result.content);
			}
		}
		this.renderMessages();
	}

	// --- Session management ---

	/** Save the current conversation, then reset UI + agent onto `sessionId` (null = fresh). */
	private async switchToSession(sessionId: string | null) {
		await this.saveCurrentConversation();

		let messages: Message[] | null = null;
		if (sessionId) {
			messages = this.plugin.conversationStore?.loadSession(sessionId) ?? null;
			if (!messages) {
				new Notice("Could not load conversation. Starting fresh.");
				sessionId = null;
			}
		}

		this.messages = messages ?? [];
		this.currentSessionId = sessionId;
		this.prompts.reset();
		this.agent?.detach();
		this.agent?.stop();
		this.renderMessages();
		this.renderSessionBar();
		this.startAgent(sessionId ?? undefined);
	}

	private async saveCurrentConversation() {
		if (!this.currentSessionId || this.messages.length === 0) return;
		if (!this.plugin.conversationStore) return;

		await this.plugin.conversationStore.saveSession(this.currentSessionId, this.messages);
		this.plugin.settings.currentSessionId = this.currentSessionId;
		await this.plugin.saveSettings();
	}

	private renderSessionBar() {
		this.sessionBarEl.empty();

		const store = this.plugin.conversationStore;
		if (!store) return;

		const sessions = store.getIndex();

		const newBtn = this.sessionBarEl.createEl("button", {
			cls: "clawbar-session-new",
			text: "+ New",
		});
		newBtn.addEventListener("click", () => this.switchToSession(null));

		if (sessions.length === 0) return;

		const select = this.sessionBarEl.createEl("select", { cls: "clawbar-session-select" });

		select.createEl("option", {
			text: this.getSessionTitle(this.currentSessionId, sessions),
			attr: { value: this.currentSessionId ?? "__current__" },
		});
		for (const session of sessions) {
			if (session.sessionId === this.currentSessionId) continue;
			const date = new Date(session.updatedAt).toLocaleDateString();
			select.createEl("option", {
				text: `${session.title} — ${date}`,
				attr: { value: session.sessionId },
			});
		}

		select.addEventListener("change", (e) => {
			const value = (e.target as HTMLSelectElement).value;
			if (value && value !== "__current__" && value !== this.currentSessionId) {
				this.switchToSession(value);
			}
		});
	}

	private getSessionTitle(sessionId: string | null, sessions: SessionMeta[]): string {
		const meta = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined;
		return meta?.title ?? "Current conversation";
	}

	// --- Input handling ---

	private async handleSubmit(text: string) {
		if (text === "/clear") {
			this.inputComponent.clear();
			this.switchToSession(null);
			return;
		}
		if (text === "/usage") {
			this.inputComponent.clear();
			this.showUsageModal();
			return;
		}

		this.addMessage("user", [{ type: "text", text }]);
		this.inputComponent.clear();
		this.showThinking();
		this.agent?.sendMessage(await this.buildOutgoingMessage(text));
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
		this.agent?.requestUsage((markdown) => {
			if (markdown.trim()) {
				modal.showContent(markdown);
			} else {
				modal.showError("No usage data returned.");
			}
		});
	}

	private handleStop() {
		this.agent?.stop();
		this.hideThinking();
		new Notice("Request cancelled");
	}

	// --- Rendering ---

	addMessage(role: "user" | "assistant", blocks: ContentBlock[], isThinking = false) {
		this.messages.push({ role, blocks, isThinking });
		this.renderMessages();
	}

	private renderMessages(): Promise<void> {
		return this.renderer.render(this.messages, this.thinkingEl);
	}

	private showThinking() {
		this.hideThinking();
		this.thinkingEl = this.messagesContainer.createDiv({ cls: "clawbar-thinking" });
		this.thinkingEl.createSpan({ text: "Thinking", cls: "clawbar-thinking-text" });
		this.thinkingEl.createSpan({ cls: "clawbar-thinking-dots" });
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		this.inputComponent.setThinking(true);
	}

	private hideThinking() {
		if (this.thinkingEl) {
			this.thinkingEl.remove();
			this.thinkingEl = null;
		}
		this.inputComponent?.setThinking(false);
	}
}
