import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_CHAT = "clawbar-chat-view";

export class ChatView extends ItemView {
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
		const container = this.containerEl.children[1];
		container.empty();
		container.createEl("div", {
			cls: "clawbar-container",
			text: "Claude Code chat will appear here.",
		});
	}

	async onClose() {
		// Cleanup when view is closed
	}
}
