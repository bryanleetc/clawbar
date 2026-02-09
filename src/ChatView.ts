import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { ClaudeProcess } from "./claude/ProcessManager";
import { StreamMessage, ContentBlock } from "./claude/types";
import type ClawbarPlugin from "./main";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

interface Message {
	role: "user" | "assistant" | "tool";
	blocks: ContentBlock[];
	toolName?: string;
	toolId?: string;
	toolResult?: string;
}

export class ChatView extends ItemView {
	private messages: Message[] = [];
	private messagesContainer: HTMLElement;
	private inputArea: HTMLTextAreaElement;
	private thinkingEl: HTMLElement | null = null;
	private claudeProcess: ClaudeProcess;
	private activeFile: TFile | null = null;
	private contextBar: HTMLElement;
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

		// Context bar showing active file (below input)
		this.contextBar = container.createDiv({ cls: "clawbar-context-bar" });
		this.updateContextBar();

		// Event handlers
		this.inputArea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
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

		// Register active file listener
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.activeFile = this.app.workspace.getActiveFile();
				this.updateContextBar();
			})
		);

		// Initialize active file
		this.activeFile = this.app.workspace.getActiveFile();
		this.updateContextBar();

		// Start Claude process
		this.startClaudeProcess();
	}

	private updateContextBar() {
		this.contextBar.empty();

		if (this.activeFile) {
			this.contextBar.createSpan({
				cls: "clawbar-context-file",
				text: this.activeFile.name
			});
		}
	}

	private startClaudeProcess() {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
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
			this.hideThinking();
			new Notice(`Claude error: ${error}`);
		});

		this.claudeProcess.start(claudePath, vaultPath);
	}

	private handleStreamMessage(msg: StreamMessage) {
		if (msg.type === "assistant") {
			const blocks = msg.message.content;
			if (blocks.length > 0) {
				this.hideThinking();

				// Separate text blocks from tool_use blocks
				const textBlocks = blocks.filter(b => b.type === "text");
				const toolUseBlocks = blocks.filter(b => b.type === "tool_use");

				// Add text content as assistant message
				if (textBlocks.length > 0) {
					this.addMessage("assistant", textBlocks);
				}

				// Add each tool_use as its own "tool" message
				for (const toolBlock of toolUseBlocks) {
					this.messages.push({
						role: "tool",
						blocks: [toolBlock],
						toolName: toolBlock.name,
						toolId: toolBlock.id,
					});
				}

				if (toolUseBlocks.length > 0) {
					this.renderMessages();
				}
			}
		} else if (msg.type === "user") {
			// Match tool results to their tool_use messages
			const toolResults = msg.message.content.filter(b => b.type === "tool_result");
			for (const result of toolResults) {
				// Find the matching tool message by ID
				const toolMsg = this.messages.find(
					m => m.role === "tool" && m.toolId === result.tool_use_id
				);
				if (toolMsg) {
					toolMsg.toolResult = result.content;
				}
			}
			if (toolResults.length > 0) {
				this.renderMessages();
			}
		} else if (msg.type === "result") {
			this.hideThinking();
		}
	}

	async onClose() {
		this.claudeProcess.stop();
	}

	private async handleSubmit() {
		const text = this.inputArea.value.trim();
		if (!text) return;

		this.addMessage("user", [{ type: "text", text }]);
		this.inputArea.value = "";
		this.inputArea.style.height = "auto";

		// Build message with active file context
		let messageToSend = text;
		if (this.activeFile) {
			const fileContent = await this.app.vault.read(this.activeFile);
			messageToSend = `[Active file: ${this.activeFile.path}]\n\n${text}`;

			// Include file content if it's not too large (< 10KB)
			if (fileContent.length < 10000) {
				messageToSend = `[Active file: ${this.activeFile.path}]\n\`\`\`\n${fileContent}\n\`\`\`\n\n${text}`;
			}
		}

		this.showThinking();
		this.claudeProcess.sendMessage(messageToSend);
	}

	private showThinking() {
		this.hideThinking();
		this.thinkingEl = this.messagesContainer.createDiv({ cls: "clawbar-thinking" });
		this.thinkingEl.createSpan({ text: "Thinking", cls: "clawbar-thinking-text" });
		this.thinkingEl.createSpan({ cls: "clawbar-thinking-dots" });
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private hideThinking() {
		if (this.thinkingEl) {
			this.thinkingEl.remove();
			this.thinkingEl = null;
		}
	}

	addMessage(role: "user" | "assistant", blocks: ContentBlock[]) {
		this.messages.push({ role, blocks });
		this.renderMessages();
	}

	private async renderMessages() {
		this.messagesContainer.empty();

		for (const msg of this.messages) {
			if (msg.role === "tool") {
				// Render tool messages with their own style
				this.renderToolMessage(msg);
			} else {
				const msgEl = this.messagesContainer.createDiv({
					cls: `clawbar-message clawbar-message-${msg.role}`,
				});

				const roleLabel = msgEl.createDiv({ cls: "clawbar-message-role" });
				roleLabel.setText(msg.role === "user" ? "You" : "Claude");

				const contentEl = msgEl.createDiv({ cls: "clawbar-message-content" });

				for (const block of msg.blocks) {
					await this.renderContentBlock(block, contentEl);
				}
			}
		}

		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private renderToolMessage(msg: Message) {
		const toolEl = this.messagesContainer.createDiv({ cls: "clawbar-message clawbar-message-tool" });

		const header = toolEl.createDiv({ cls: "clawbar-tool-header" });
		const toggle = header.createSpan({ cls: "clawbar-tool-toggle", text: "▶" });
		header.createSpan({ cls: "clawbar-tool-name", text: msg.toolName || "Tool" });

		// Show status indicator
		if (msg.toolResult !== undefined) {
			header.createSpan({ cls: "clawbar-tool-status clawbar-tool-complete", text: "✓" });
		} else {
			header.createSpan({ cls: "clawbar-tool-status clawbar-tool-pending", text: "⋯" });
		}

		const content = toolEl.createDiv({ cls: "clawbar-tool-content clawbar-collapsed" });

		// Render tool input
		const toolBlock = msg.blocks[0];
		if (toolBlock?.input) {
			content.createDiv({ cls: "clawbar-tool-section-label", text: "Input" });
			const inputCode = content.createEl("pre", { cls: "clawbar-tool-code" });
			inputCode.createEl("code", {
				text: JSON.stringify(toolBlock.input, null, 2)
			});
		}

		// Render tool result if available
		if (msg.toolResult !== undefined) {
			content.createDiv({ cls: "clawbar-tool-section-label", text: "Output" });
			const resultCode = content.createEl("pre", { cls: "clawbar-tool-code" });
			const displayContent = msg.toolResult.length > 2000
				? msg.toolResult.slice(0, 2000) + "\n... (truncated)"
				: msg.toolResult;
			resultCode.createEl("code", { text: displayContent });
		}

		// Toggle collapse/expand
		header.addEventListener("click", () => {
			const isCollapsed = content.hasClass("clawbar-collapsed");
			if (isCollapsed) {
				content.removeClass("clawbar-collapsed");
				toggle.setText("▼");
			} else {
				content.addClass("clawbar-collapsed");
				toggle.setText("▶");
			}
		});
	}

	private async renderContentBlock(block: ContentBlock, container: HTMLElement) {
		if (block.type === "text" && block.text) {
			const textEl = container.createDiv({ cls: "clawbar-text-block" });
			await MarkdownRenderer.render(this.app, block.text, textEl, "", this);
		}
		// tool_use and tool_result are handled by renderToolMessage
	}
}
