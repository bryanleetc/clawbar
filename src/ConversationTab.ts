import { App, Component, Notice } from "obsidian";
import { homedir } from "os";
import { AgentManager } from "./claude/AgentManager";
import {
	assistantBlocks,
	isReplay,
	toolResultBlocks,
	toolResultText,
} from "./claude/types";
import type {
	SDKMessage,
	ContentBlock,
	Message,
	ModelInfo,
	SlashCommand,
} from "./claude/types";
import type ClawbarPlugin from "./main";
import { MessageRenderer } from "./MessageRenderer";
import { PromptManager } from "./PromptManager";

// Delay before re-applying persisted disabled MCPs, to let the agent initialize
const MCP_REAPPLY_DELAY_MS = 2000;

/** What a tab reports back to the ChatView that hosts it. */
export interface TabHost {
	/** Tab state visible in the tab strip changed (title, thinking, unseen). */
	onTabStateChanged(tab: ConversationTab): void;
	/** The tab captured its session id for the first time. */
	onSessionId(tab: ConversationTab): void;
	/** The tab's agent reported its model list (shown when the tab is active). */
	onModels(tab: ConversationTab): void;
	onSkills(skills: SlashCommand[]): void;
}

/**
 * One open conversation: its messages, its own agent (which keeps running
 * while the tab is in the background), and its own message/prompt DOM,
 * shown or hidden as tabs switch.
 */
export class ConversationTab {
	messages: Message[] = [];
	sessionId: string | null = null;
	/** Model list reported by this tab's agent, re-applied on activation. */
	models: ModelInfo[] = [];
	currentModel: string | null = null;

	private agent: AgentManager | null = null;
	private renderer: MessageRenderer;
	private prompts: PromptManager;
	private messagesEl: HTMLElement;
	private promptsEl: HTMLElement;
	private thinkingEl: HTMLElement | null = null;
	private thinking = false;
	private unseen = false;
	private active = false;

	constructor(
		private app: App,
		private plugin: ClawbarPlugin,
		messagesRegion: HTMLElement,
		promptsRegion: HTMLElement,
		owner: Component,
		private host: TabHost,
	) {
		this.messagesEl = messagesRegion.createDiv({ cls: "clawbar-messages" });
		this.promptsEl = promptsRegion.createDiv({ cls: "clawbar-prompts" });
		this.renderer = new MessageRenderer(app, this.messagesEl, owner);
		this.prompts = new PromptManager(this.promptsEl);
		this.hide();
	}

	isThinking(): boolean { return this.thinking; }
	hasUnseen(): boolean { return this.unseen; }
	isActive(): boolean { return this.active; }

	// --- Visibility ---

	show() {
		this.active = true;
		this.unseen = false;
		this.messagesEl.style.display = "";
		this.promptsEl.style.display = "";
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	hide() {
		this.active = false;
		this.messagesEl.style.display = "none";
		this.promptsEl.style.display = "none";
	}

	// --- Lifecycle ---

	/** Load saved messages (before startAgent) when reopening a session. */
	loadMessages(sessionId: string, messages: Message[]) {
		this.sessionId = sessionId;
		this.messages = messages;
		this.renderMessages();
	}

	startAgent(resumeSessionId?: string) {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			new Notice("Could not get vault base path");
			return;
		}

		this.agent = new AgentManager({
			onMessage: (msg) => this.handleSDKMessage(msg),
			onError: (err) => this.handleAgentError(err, resumeSessionId),
			onPermission: (toolName, toolInput) => this.prompts.request(toolName, toolInput),
			onSkills: (skills) => this.host.onSkills(skills),
			onSessionId: (id) => {
				this.sessionId = id;
				this.host.onSessionId(this);
			},
			onModels: (models, currentModel) => {
				this.models = models;
				this.currentModel = currentModel;
				this.host.onModels(this);
			},
		});

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

	/** Save, stop the agent, and remove this tab's DOM. */
	async dispose() {
		await this.save();
		this.prompts.reset();
		this.agent?.detach();
		this.agent?.stop();
		this.agent = null;
		this.messagesEl.remove();
		this.promptsEl.remove();
	}

	async save() {
		if (!this.sessionId || this.messages.length === 0) return;
		if (!this.plugin.conversationStore) return;
		await this.plugin.conversationStore.saveSession(this.sessionId, this.messages);
		// The saved title (derived from the first message) feeds the tab label
		this.host.onTabStateChanged(this);
	}

	// --- Input / agent actions ---

	/** Add the user's message to the view and send the full outgoing text to the agent. */
	sendUserMessage(displayText: string, outgoingText: string) {
		this.addMessage("user", [{ type: "text", text: displayText }]);
		this.showThinking();
		this.agent?.sendMessage(outgoingText);
	}

	requestUsage(callback: (markdown: string) => void) {
		this.agent?.requestUsage(callback);
	}

	async setModel(model: string): Promise<void> {
		await this.agent?.setModel(model);
	}

	stop() {
		this.agent?.stop();
		this.hideThinking();
	}

	getAgent(): AgentManager | null {
		return this.agent;
	}

	// --- SDK message handling ---

	private handleSDKMessage(msg: SDKMessage) {
		// Resume replays are skipped — the UI already has these messages loaded
		if (isReplay(msg)) return;

		switch (msg.type) {
			case "result":
				this.hideThinking();
				this.save();
				if (!this.active) {
					this.unseen = true;
					this.host.onTabStateChanged(this);
				}
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
		this.thinkingEl = this.messagesEl.createDiv({ cls: "clawbar-thinking" });
		this.thinkingEl.createSpan({ text: "Thinking", cls: "clawbar-thinking-text" });
		this.thinkingEl.createSpan({ cls: "clawbar-thinking-dots" });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

		this.thinking = true;
		this.host.onTabStateChanged(this);
	}

	private hideThinking() {
		if (this.thinkingEl) {
			this.thinkingEl.remove();
			this.thinkingEl = null;
		}
		if (this.thinking) {
			this.thinking = false;
			this.host.onTabStateChanged(this);
		}
	}
}
