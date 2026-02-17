import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { AgentManager } from "./claude/AgentManager";
import type { SDKMessage, PermissionResult, ContentBlock, SlashCommand, Message, SessionMeta } from "./claude/types";
import type ClawbarPlugin from "./main";
import { BUILTIN_COMMANDS } from "./constants";
import { UsageModal } from "./UsageModal";
import { McpSettingsModal } from "./McpSettingsModal";
import { InputArea } from "./InputArea";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

export class ChatView extends ItemView {
	private messages: Message[] = [];
	private messagesContainer: HTMLElement;
	private thinkingEl: HTMLElement | null = null;
	private promptsContainer: HTMLElement;
	private permissionQueue: Promise<void> = Promise.resolve();
	private agent: AgentManager;
	private activeFile: TFile | null = null;
	private currentSessionId: string | null = null;
	private sessionBarEl: HTMLElement;
	private inputComponent: InputArea;
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

		// Session selector bar
		this.sessionBarEl = container.createDiv({ cls: "clawbar-session-bar" });
		this.renderSessionBar();

		// Messages container
		this.messagesContainer = container.createDiv({ cls: "clawbar-messages" });

		// Prompts container (permission/question prompts — never cleared by renderMessages)
		this.promptsContainer = container.createDiv({ cls: "clawbar-prompts" });

		// Input area component
		this.inputComponent = new InputArea(container, this.app, {
			onSubmit: (text) => this.handleSubmit(text),
			onStop: () => this.handleStop(),
			onSettings: () => this.openSettingsModal(),
		});

		// Register active file listener
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.activeFile = this.app.workspace.getActiveFile();
				this.inputComponent.updateContextBar(this.activeFile);
			})
		);

		// Initialize active file
		this.activeFile = this.app.workspace.getActiveFile();
		this.inputComponent.updateContextBar(this.activeFile);

		// Auto-resume last session or start fresh
		const lastSessionId = this.plugin.settings.currentSessionId;
		if (lastSessionId && this.plugin.conversationStore) {
			const messages = this.plugin.conversationStore.loadSession(lastSessionId);
			if (messages && messages.length > 0) {
				this.messages = messages;
				this.currentSessionId = lastSessionId;
				this.renderMessages();
				this.renderSessionBar();
				this.startAgent(lastSessionId);
				return;
			}
		}
		this.startAgent();
	}

	private loadSkills(skills: SlashCommand[]) {
		const sdkSkills = skills.map(skill => ({
			name: skill.name,
			description: skill.description,
			argumentHint: skill.argumentHint,
		}));

		this.inputComponent.setCommands([...BUILTIN_COMMANDS, ...sdkSkills]);
	}

	private startAgent(resumeSessionId?: string) {
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (!vaultPath) {
			new Notice("Could not get vault base path");
			return;
		}

		this.agent = new AgentManager();

		this.agent.onMessage((msg: SDKMessage) => this.handleSDKMessage(msg));
		this.agent.onError((err: string) => { this.hideThinking(); new Notice(`Claude error: ${err}`); console.log(`Claude error: ${err}`); });
		this.agent.onPermission((toolName: string, toolInput: unknown) => this.showPermissionPrompt(toolName, toolInput));
		this.agent.onSkills((skills: SlashCommand[]) => this.loadSkills(skills));
		this.agent.onSessionId((id: string) => {
			this.currentSessionId = id;
			this.renderSessionBar();
		});

		// Ensure buttons are in initial state
		this.hideThinking();

		// Re-apply persisted disabled MCPs after a short delay to let the agent initialize
		const disabledMcps = this.plugin.settings.disabledMcpServers;
		if (disabledMcps.length > 0) {
			setTimeout(async () => {
				for (const name of disabledMcps) {
					try {
						await this.agent.toggleMcpServer(name, false);
						console.log(`[Clawbar] MCP server disabled: ${name}`);
					} catch (err) {
						console.error(`[Clawbar] Failed to disable MCP server "${name}":`, err);
					}
				}
			}, 2000);
		}

		this.agent.start(vaultPath, this.plugin.settings.claudePath, resumeSessionId);
	}

	private handleSDKMessage(msg: SDKMessage) {
		// Skip replayed messages during session resume — we already have UI messages loaded
		if ('isReplay' in msg && (msg as any).isReplay === true) return;

		if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
			return;
		}

		if (msg.type === "result") {
			this.hideThinking();
			this.saveCurrentConversation();
			return;
		}

		if (msg.type === "assistant" && "message" in msg) {
			const assistantMsg = msg as { message: { content: ContentBlock[] } };
			const blocks = assistantMsg.message.content;
			if (blocks.length > 0) {
				// Separate text blocks from tool_use blocks
				// Skip AskUserQuestion — handled interactively by showQuestionPrompt
				const textBlocks = blocks.filter((b: ContentBlock) => b.type === "text");
				const toolUseBlocks = blocks.filter(
					(b: ContentBlock) => b.type === "tool_use" && b.name !== "AskUserQuestion"
				);

				if (textBlocks.length > 0) {
					// Text alongside tool_use = intermediate narration (thinking)
					const isThinking = toolUseBlocks.length > 0;
					this.addMessage("assistant", textBlocks, isThinking);
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
		await this.saveCurrentConversation();
		this.agent.stop();
		this.inputComponent.destroy();
	}

	private async clearConversation() {
		await this.saveCurrentConversation();
		this.messages = [];
		this.currentSessionId = null;
		this.permissionQueue = Promise.resolve();
		this.promptsContainer.empty();
		this.renderMessages();
		this.agent.detach();
		this.agent.stop();
		this.startAgent();
		this.renderSessionBar();
	}

	// --- Session Management ---

	private renderSessionBar() {
		this.sessionBarEl.empty();

		const store = this.plugin.conversationStore;
		if (!store) return;

		const sessions = store.getIndex();

		const newBtn = this.sessionBarEl.createEl("button", {
			cls: "clawbar-session-new",
			text: "+ New",
		});
		newBtn.addEventListener("click", () => this.startNewConversation());

		if (sessions.length > 0) {
			const select = this.sessionBarEl.createEl("select", {
				cls: "clawbar-session-select",
			});

			// Current conversation option
			select.createEl("option", {
				text: this.currentSessionId
					? this.getSessionTitle(this.currentSessionId, sessions)
					: "Current conversation",
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
					this.loadConversation(value);
				}
			});
		}
	}

	private getSessionTitle(sessionId: string, sessions: SessionMeta[]): string {
		const meta = sessions.find(s => s.sessionId === sessionId);
		return meta?.title ?? "Current conversation";
	}

	private async saveCurrentConversation() {
		if (!this.currentSessionId || this.messages.length === 0) return;
		if (!this.plugin.conversationStore) return;

		await this.plugin.conversationStore.saveSession(
			this.currentSessionId,
			this.messages,
		);
		this.plugin.settings.currentSessionId = this.currentSessionId;
		await this.plugin.saveSettings();
	}

	private async startNewConversation() {
		await this.saveCurrentConversation();

		this.messages = [];
		this.currentSessionId = null;
		this.permissionQueue = Promise.resolve();
		this.promptsContainer.empty();
		this.renderMessages();

		this.agent.detach();
		this.agent.stop();
		this.startAgent();

		this.renderSessionBar();
	}

	private async loadConversation(sessionId: string) {
		await this.saveCurrentConversation();

		const store = this.plugin.conversationStore;
		if (!store) return;

		const messages = store.loadSession(sessionId);

		this.agent.detach();
		this.agent.stop();

		this.permissionQueue = Promise.resolve();
		this.promptsContainer.empty();

		if (messages) {
			this.messages = messages;
			this.currentSessionId = sessionId;
		} else {
			new Notice("Could not load conversation. Starting fresh.");
			this.messages = [];
			this.currentSessionId = null;
		}

		this.renderMessages();
		this.renderSessionBar();
		this.startAgent(sessionId);
	}

	private async handleSubmit(text: string) {
		// Intercept /clear to reset conversation UI and agent context
		if (text === "/clear") {
			this.inputComponent.clear();
			this.clearConversation();
			return;
		}

		// Intercept /usage to show native modal with live data from CLI
		if (text === "/usage") {
			this.inputComponent.clear();
			const modal = new UsageModal(this.app);
			modal.open();
			this.agent.requestUsage((markdown) => {
				if (markdown.trim()) {
					modal.showContent(markdown);
				} else {
					modal.showError("No usage data returned.");
				}
			});
			return;
		}

		this.addMessage("user", [{ type: "text", text }]);
		this.inputComponent.clear();

		// Resolve @file references
		const { context: fileRefContext, cleanedText } = await this.inputComponent.resolveFileReferences(text);

		// Build message with active file context
		// Skip file context for skill commands (starting with /)
		let messageToSend = cleanedText;
		if (this.activeFile && !cleanedText.startsWith('/')) {
			const fileContent = await this.app.vault.read(this.activeFile);
			messageToSend = `[Active file: ${this.activeFile.path}]\n\n${cleanedText}`;

			// Include file content if it's not too large (< 10KB)
			if (fileContent.length < 10000) {
				messageToSend = `[Active file: ${this.activeFile.path}]\n\`\`\`\n${fileContent}\n\`\`\`\n\n${cleanedText}`;
			}
		}

		// Prepend referenced file contents
		if (fileRefContext) {
			messageToSend = fileRefContext + messageToSend;
		}

		this.showThinking();
		this.agent.sendMessage(messageToSend);
	}

	private handleStop() {
		this.agent.stop();
		this.hideThinking();
		new Notice("Request cancelled");
	}

	private openSettingsModal() {
		new McpSettingsModal(this.app, this.agent, this.plugin).open();
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

	addMessage(role: "user" | "assistant", blocks: ContentBlock[], isThinking = false) {
		this.messages.push({ role, blocks, isThinking });
		this.renderMessages();
	}

	private async renderMessages() {
		this.messagesContainer.empty();

		for (const msg of this.messages) {
			if (msg.role === "tool") {
				this.renderToolMessage(msg);
			} else if (msg.isThinking) {
				await this.renderNarrativeMessage(msg);
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

		if (this.thinkingEl) {
			this.messagesContainer.appendChild(this.thinkingEl);
		}
	}

	// --- Tool Permission Prompts ---

	private showPermissionPrompt(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		const result: Promise<PermissionResult> = this.permissionQueue.then(() =>
			this.doShowPermissionPrompt(toolName, toolInput)
		);
		// Advance the queue tail; ignore errors so the chain never breaks
		this.permissionQueue = result.then(() => {}, () => {});
		return result;
	}

	private doShowPermissionPrompt(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		if (toolName === "AskUserQuestion") {
			return this.showQuestionPrompt(toolInput as Record<string, unknown>);
		}

		return new Promise((resolve) => {
			const promptEl = this.promptsContainer.createDiv({ cls: "clawbar-permission-prompt" });

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

			const promptEl = this.promptsContainer.createDiv({ cls: "clawbar-question-prompt" });

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

	private async renderNarrativeMessage(msg: Message) {
		const el = this.messagesContainer.createDiv({ cls: "clawbar-narrative" });

		const header = el.createDiv({ cls: "clawbar-narrative-header" });
		const toggle = header.createSpan({ cls: "clawbar-narrative-toggle", text: "▶" });
		header.createSpan({ cls: "clawbar-narrative-label", text: "Thinking" });

		const content = el.createDiv({ cls: "clawbar-narrative-content clawbar-collapsed" });

		for (const block of msg.blocks) {
			if (block.type === "text" && block.text) {
				const textEl = content.createDiv({ cls: "clawbar-text-block" });
				await MarkdownRenderer.render(this.app, block.text, textEl, "", this);
			}
		}

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
