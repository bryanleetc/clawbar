import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

interface Message {
	role: "user" | "assistant";
	content: string;
}

export class ChatView extends ItemView {
	private messages: Message[] = [];
	private messagesContainer: HTMLElement;
	private inputArea: HTMLTextAreaElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
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
	}

	async onClose() {
		// Cleanup when view is closed
	}

	private handleSubmit() {
		const text = this.inputArea.value.trim();
		if (!text) return;

		this.addMessage("user", text);
		this.inputArea.value = "";
		this.inputArea.style.height = "auto";

		// TODO: Phase 1.3 will send to Claude process
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
