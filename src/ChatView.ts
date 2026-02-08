import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import { ClaudeProcess } from "./claude/ProcessManager";
import { StreamMessage, ContentBlock } from "./claude/types";
import type ClawbarPlugin from "./main";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

interface Message {
	role: "user" | "assistant";
	content: string;
}

export class ChatView extends ItemView {
	private messages: Message[] = [];
	private messagesContainer: HTMLElement;
	private inputArea: HTMLTextAreaElement;
	private claudeProcess: ClaudeProcess;
	plugin: ClawbarPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ClawbarPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.claudeProcess = new ClaudeProcess();
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

		// Messages container
		this.messagesContainer = container.createDiv({ cls: "clawbar-messages" });

		// Input area
		const inputWrapper = container.createDiv({ cls: "clawbar-input-area" });

		this.inputArea = inputWrapper.createEl("textarea", {
			cls: "clawbar-input",
			attr: { placeholder: "Message Claude..." },
		});

		const submitButton = inputWrapper.createEl("button", {
			cls: "clawbar-submit",
			text: "Send",
		});

		// Event handlers
		this.inputArea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.handleSubmit();
			}
		});

		submitButton.addEventListener("click", () => {
			this.handleSubmit();
		});

		// Auto-resize textarea
		this.inputArea.addEventListener("input", () => {
			this.inputArea.style.height = "auto";
			this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 150) + "px";
		});

		// Start Claude process
		this.startClaudeProcess();
	}

	private startClaudeProcess() {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			console.error("[ChatView] Could not get vault base path");
			new Notice("Could not get vault base path");
			return;
		}

		const claudePath = this.plugin.settings.claudePath;
		if (!claudePath) {
			new Notice("Claude path not configured. Please set it in plugin settings.");
			return;
		}

		this.claudeProcess.onMessage((msg: StreamMessage) => {
			this.handleStreamMessage(msg);
		});

		this.claudeProcess.onError((error: string) => {
			console.error("[ChatView] Claude error:", error);
			new Notice(`Claude error: ${error}`);
		});

		this.claudeProcess.start(claudePath, vaultPath);
	}

	private handleStreamMessage(msg: StreamMessage) {
		if (msg.type === "assistant") {
			const content = this.extractTextContent(msg.message.content);
			if (content) {
				this.addMessage("assistant", content);
			}
		} else if (msg.type === "system") {
			console.log("[ChatView] System message:", msg.message);
		} else if (msg.type === "result") {
			console.log("[ChatView] Result:", msg.result, "Cost:", msg.cost_usd);
		}
	}

	private extractTextContent(blocks: ContentBlock[]): string {
		return blocks
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text)
			.join("\n");
	}

	async onClose() {
		this.claudeProcess.stop();
	}

	private handleSubmit() {
		const text = this.inputArea.value.trim();
		if (!text) return;

		this.addMessage("user", text);
		this.inputArea.value = "";
		this.inputArea.style.height = "auto";

		this.claudeProcess.sendMessage(text);
	}

	addMessage(role: "user" | "assistant", content: string) {
		this.messages.push({ role, content });
		this.renderMessages();
	}

	private async renderMessages() {
		this.messagesContainer.empty();

		for (const msg of this.messages) {
			const msgEl = this.messagesContainer.createDiv({
				cls: `clawbar-message clawbar-message-${msg.role}`,
			});

			const roleLabel = msgEl.createDiv({ cls: "clawbar-message-role" });
			roleLabel.setText(msg.role === "user" ? "You" : "Claude");

			const contentEl = msgEl.createDiv({ cls: "clawbar-message-content" });
			await MarkdownRenderer.render(this.app, msg.content, contentEl, "", this);
		}

		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}
}
