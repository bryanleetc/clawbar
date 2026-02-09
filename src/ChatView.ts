import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { AgentManager } from "./claude/AgentManager";
import type { SDKMessage, PermissionResult, ContentBlock } from "./claude/types";
import type ClawbarPlugin from "./main";
import { SLASH_COMMANDS } from "./constants";

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
	private submitButton: HTMLButtonElement;
	private stopButton: HTMLButtonElement;
	private thinkingEl: HTMLElement | null = null;
	private agent: AgentManager;
	private activeFile: TFile | null = null;
	private contextBar: HTMLElement;
	private autocompleteEl: HTMLElement | null = null;
	private selectedCommandIndex = -1;
	private isRequestActive = false;
	plugin: ClawbarPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ClawbarPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.agent = new AgentManager();
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

		this.submitButton = inputWrapper.createEl("button", {
			cls: "clawbar-submit",
			text: "Send",
		});

		this.stopButton = inputWrapper.createEl("button", {
			cls: "clawbar-stop",
			text: "Stop",
		});
		this.stopButton.style.display = "none";

		// Autocomplete dropdown (initially hidden)
		this.autocompleteEl = inputWrapper.createDiv({ cls: "clawbar-autocomplete" });
		this.autocompleteEl.style.display = "none";

		// Context bar showing active file (below input)
		this.contextBar = container.createDiv({ cls: "clawbar-context-bar" });
		this.updateContextBar();

		// Event handlers
		this.inputArea.addEventListener("keydown", (e) => {
			// Handle autocomplete navigation
			if (this.autocompleteEl && this.autocompleteEl.style.display !== "none") {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					this.navigateAutocomplete(1);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					this.navigateAutocomplete(-1);
					return;
				}
				if (e.key === "Tab") {
					e.preventDefault();
					this.selectCommand();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					this.hideAutocomplete();
					return;
				}
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				// If autocomplete is open, select the highlighted command
				if (this.autocompleteEl && this.autocompleteEl.style.display !== "none") {
					this.selectCommand();
				} else {
					this.handleSubmit();
				}
			}
		});

		this.submitButton.addEventListener("click", () => {
			this.handleSubmit();
		});

		this.stopButton.addEventListener("click", () => {
			this.handleStop();
		});

		// Auto-resize textarea and handle autocomplete
		this.inputArea.addEventListener("input", () => {
			this.inputArea.style.height = "auto";
			this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 150) + "px";
			this.handleAutocomplete();
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

		// Start agent
		this.startAgent();
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

	private startAgent() {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			new Notice("Could not get vault base path");
			return;
		}

		this.agent = new AgentManager();

		this.agent.onMessage((msg: SDKMessage) => this.handleSDKMessage(msg));
		this.agent.onError((err: string) => { this.hideThinking(); new Notice(`Claude error: ${err}`); console.log(`Claude error: ${err}`); });
		this.agent.onPermission((toolName: string, toolInput: unknown) => this.showPermissionPrompt(toolName, toolInput));

		const resumeId = this.plugin.settings.resumeLastConversation
			? this.plugin.settings.lastSessionId ?? undefined
			: undefined;

		// Ensure buttons are in initial state
		this.hideThinking();

		this.agent.start(vaultPath, this.plugin.settings.claudePath);
	}

	private handleSDKMessage(msg: SDKMessage) {
		if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
			if ("session_id" in msg) {
				this.plugin.settings.lastSessionId = msg.session_id as string;
				this.plugin.saveSettings();
			}
			return;
		}

		if (msg.type === "result") {
			this.hideThinking();
			if ("session_id" in msg) {
				this.plugin.settings.lastSessionId = msg.session_id as string;
				this.plugin.saveSettings();
			}
			return;
		}

		if (msg.type === "assistant" && "message" in msg) {
			const assistantMsg = msg as { message: { content: ContentBlock[] } };
			const blocks = assistantMsg.message.content;
			if (blocks.length > 0) {
				this.hideThinking();

				// Separate text blocks from tool_use blocks
				// Skip AskUserQuestion — handled interactively by showQuestionPrompt
				const textBlocks = blocks.filter((b: ContentBlock) => b.type === "text");
				const toolUseBlocks = blocks.filter(
					(b: ContentBlock) => b.type === "tool_use" && b.name !== "AskUserQuestion"
				);

				if (textBlocks.length > 0) {
					this.addMessage("assistant", textBlocks);
				}

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
		}

		if (msg.type === "user" && "message" in msg) {
			const userMsg = msg as { message: { content: any[] } };
			const toolResults = userMsg.message.content.filter(
				(b: any) => b.type === "tool_result"
			);
			for (const result of toolResults) {
				const toolMsg = this.messages.find(
					(m: Message) => m.role === "tool" && m.toolId === result.tool_use_id
				);
				if (toolMsg) {
					// Handle both string content and array of content blocks
					if (typeof result.content === "string") {
						toolMsg.toolResult = result.content;
					} else if (Array.isArray(result.content)) {
						// Extract text from content blocks array
						toolMsg.toolResult = result.content
							.filter((block: any) => block.type === "text")
							.map((block: any) => block.text)
							.join("\n");
					} else {
						toolMsg.toolResult = JSON.stringify(result.content);
					}
				}
			}
			if (toolResults.length > 0) {
				this.renderMessages();
			}
		}
	}

	async onClose() {
		this.agent.stop();
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
		this.agent.sendMessage(messageToSend);
	}

	private handleStop() {
		this.agent.stop();
		this.hideThinking();
		new Notice("Request cancelled");
	}

	private showThinking() {
		this.hideThinking();
		this.thinkingEl = this.messagesContainer.createDiv({ cls: "clawbar-thinking" });
		this.thinkingEl.createSpan({ text: "Thinking", cls: "clawbar-thinking-text" });
		this.thinkingEl.createSpan({ cls: "clawbar-thinking-dots" });
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		// Toggle buttons
		this.isRequestActive = true;
		this.submitButton.style.display = "none";
		this.stopButton.style.display = "block";
	}

	private hideThinking() {
		if (this.thinkingEl) {
			this.thinkingEl.remove();
			this.thinkingEl = null;
		}

		// Toggle buttons
		this.isRequestActive = false;
		this.submitButton.style.display = "block";
		this.stopButton.style.display = "none";
	}

	addMessage(role: "user" | "assistant", blocks: ContentBlock[]) {
		this.messages.push({ role, blocks });
		this.renderMessages();
	}

	private async renderMessages() {
		this.messagesContainer.empty();

		for (const msg of this.messages) {
			if (msg.role === "tool") {
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

	// --- Tool Permission Prompts (Phase 3) ---

	private showPermissionPrompt(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		if (toolName === "AskUserQuestion") {
			return this.showQuestionPrompt(toolInput as Record<string, unknown>);
		}

		return new Promise((resolve) => {
			const promptEl = this.messagesContainer.createDiv({ cls: "clawbar-permission-prompt" });

			const header = promptEl.createDiv({ cls: "clawbar-permission-header" });
			header.createSpan({ text: `Claude wants to use: ${toolName}` });

			const details = promptEl.createDiv({ cls: "clawbar-permission-details" });
			const inputPre = details.createEl("pre", { cls: "clawbar-tool-code" });
			inputPre.createEl("code", { text: JSON.stringify(toolInput, null, 2) });

			const actions = promptEl.createDiv({ cls: "clawbar-permission-actions" });

			const allowBtn = actions.createEl("button", {
				cls: "clawbar-permission-allow",
				text: "Allow",
			});

			const denyBtn = actions.createEl("button", {
				cls: "clawbar-permission-deny",
				text: "Deny",
			});

			allowBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({ behavior: "allow", updatedInput: toolInput as Record<string, unknown> });
			});

			denyBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({ behavior: "deny", message: "User denied tool use" });
			});

			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		});
	}

	private showQuestionPrompt(input: Record<string, unknown>): Promise<PermissionResult> {
		return new Promise((resolve) => {
			const questions = (input.questions as Array<{
				question: string;
				header: string;
				options: Array<{ label: string; description: string }>;
				multiSelect: boolean;
			}>) || [];
			const answers: Record<string, string> = {};

			const promptEl = this.messagesContainer.createDiv({ cls: "clawbar-question-prompt" });

			for (const q of questions) {
				const questionEl = promptEl.createDiv({ cls: "clawbar-question" });
				questionEl.createDiv({ cls: "clawbar-question-text", text: q.question });

				const optionsEl = questionEl.createDiv({ cls: "clawbar-question-options" });
				const selected = new Set<string>();

				for (const opt of q.options) {
					const optBtn = optionsEl.createEl("button", {
						cls: "clawbar-question-option",
					});
					optBtn.createSpan({ cls: "clawbar-question-option-label", text: opt.label });
					if (opt.description) {
						optBtn.createSpan({ cls: "clawbar-question-option-desc", text: opt.description });
					}

					optBtn.addEventListener("click", () => {
						// Clear "Other" input when selecting a preset option
						const otherInput = questionEl.querySelector(".clawbar-question-other-input") as HTMLInputElement | null;
						if (otherInput) otherInput.value = "";

						if (q.multiSelect) {
							if (selected.has(opt.label)) {
								selected.delete(opt.label);
								optBtn.removeClass("clawbar-question-option-selected");
							} else {
								selected.add(opt.label);
								optBtn.addClass("clawbar-question-option-selected");
							}
							answers[q.question] = Array.from(selected).join(", ");
						} else {
							selected.clear();
							optionsEl.querySelectorAll(".clawbar-question-option").forEach(
								(b) => (b as HTMLElement).removeClass("clawbar-question-option-selected")
							);
							selected.add(opt.label);
							optBtn.addClass("clawbar-question-option-selected");
							answers[q.question] = opt.label;
						}
					});
				}

				// "Other" free-text option
				const otherEl = questionEl.createDiv({ cls: "clawbar-question-other" });
				const otherInput = otherEl.createEl("input", {
					cls: "clawbar-question-other-input",
					attr: { placeholder: "Other...", type: "text" },
				});
				otherInput.addEventListener("input", () => {
					if (otherInput.value.trim()) {
						selected.clear();
						optionsEl.querySelectorAll(".clawbar-question-option").forEach(
							(b) => (b as HTMLElement).removeClass("clawbar-question-option-selected")
						);
						answers[q.question] = otherInput.value.trim();
					}
				});
			}

			const submitBtn = promptEl.createEl("button", {
				cls: "clawbar-question-submit",
				text: "Submit",
			});

			submitBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({
					behavior: "allow",
					updatedInput: { ...input, answers },
				});
			});

			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		});
	}

	// --- Tool Message Rendering ---

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

	// --- Slash Command Autocomplete ---

	private handleAutocomplete() {
		const text = this.inputArea.value;
		const cursorPos = this.inputArea.selectionStart;

		// Find the last '/' before cursor
		const textBeforeCursor = text.substring(0, cursorPos);
		const lastSlashIndex = textBeforeCursor.lastIndexOf('/');

		// Check if we're at the start or after whitespace (valid slash command position)
		if (lastSlashIndex === -1) {
			this.hideAutocomplete();
			return;
		}

		const beforeSlash = textBeforeCursor.substring(0, lastSlashIndex);
		if (beforeSlash.trim() !== '' && !beforeSlash.endsWith('\n')) {
			this.hideAutocomplete();
			return;
		}

		// Get the partial command after the slash
		const partialCommand = textBeforeCursor.substring(lastSlashIndex + 1);

		// Filter commands based on partial input
		const filteredCommands = SLASH_COMMANDS.filter(cmd =>
			cmd.name.startsWith(partialCommand.toLowerCase())
		);

		if (filteredCommands.length === 0) {
			this.hideAutocomplete();
			return;
		}

		this.showAutocomplete(filteredCommands);
	}

	private showAutocomplete(commands: typeof SLASH_COMMANDS) {
		if (!this.autocompleteEl) return;

		this.autocompleteEl.empty();
		this.selectedCommandIndex = 0;

		commands.forEach((cmd, index) => {
			const item = this.autocompleteEl!.createDiv({
				cls: index === 0 ? "clawbar-autocomplete-item clawbar-autocomplete-selected" : "clawbar-autocomplete-item"
			});

			item.createDiv({ cls: "clawbar-autocomplete-name", text: `/${cmd.name}` });
			item.createDiv({ cls: "clawbar-autocomplete-desc", text: cmd.description });

			item.addEventListener("click", () => {
				this.selectedCommandIndex = index;
				this.selectCommand();
			});
		});

		this.autocompleteEl.style.display = "block";
	}

	private hideAutocomplete() {
		if (this.autocompleteEl) {
			this.autocompleteEl.style.display = "none";
			this.selectedCommandIndex = -1;
		}
	}

	private navigateAutocomplete(direction: number) {
		if (!this.autocompleteEl) return;

		const items = this.autocompleteEl.querySelectorAll(".clawbar-autocomplete-item");
		if (items.length === 0) return;

		// Remove current selection
		items[this.selectedCommandIndex]?.removeClass("clawbar-autocomplete-selected");

		// Update index with wrapping
		this.selectedCommandIndex = (this.selectedCommandIndex + direction + items.length) % items.length;

		// Add new selection
		items[this.selectedCommandIndex]?.addClass("clawbar-autocomplete-selected");

		// Scroll into view
		items[this.selectedCommandIndex]?.scrollIntoView({ block: "nearest" });
	}

	private selectCommand() {
		if (!this.autocompleteEl || this.selectedCommandIndex === -1) return;

		const items = this.autocompleteEl.querySelectorAll(".clawbar-autocomplete-item");
		const selectedItem = items[this.selectedCommandIndex];
		if (!selectedItem) return;

		const commandName = selectedItem.querySelector(".clawbar-autocomplete-name")?.textContent;
		if (!commandName) return;

		// Replace the partial command with the selected one
		const text = this.inputArea.value;
		const cursorPos = this.inputArea.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPos);
		const lastSlashIndex = textBeforeCursor.lastIndexOf('/');

		const newText = text.substring(0, lastSlashIndex) + commandName + " " + text.substring(cursorPos);
		this.inputArea.value = newText;

		// Set cursor position after the command and space
		const newCursorPos = lastSlashIndex + commandName.length + 1;
		this.inputArea.setSelectionRange(newCursorPos, newCursorPos);

		this.hideAutocomplete();
		this.inputArea.focus();
	}
}
