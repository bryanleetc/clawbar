import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import type { Message } from "./claude/types";
import { hasDiffView, renderDiffView } from "./DiffView";

const TOOL_SUMMARY_MAX_CHARS = 80;
const TOOL_OUTPUT_MAX_CHARS = 2000;

/** Renders the chat message list into its container. Owns no state beyond the container. */
export class MessageRenderer {
	constructor(
		private app: App,
		private container: HTMLElement,
		private owner: Component,
	) {}

	/** Re-render the full message list. */
	async render(messages: Message[]): Promise<void> {
		this.container.empty();

		if (messages.length === 0) {
			this.renderEmptyState();
			return;
		}

		for (const msg of messages) {
			if (msg.role === "tool") {
				this.renderToolMessage(msg);
			} else if (msg.isThinking) {
				await this.renderNarrativeMessage(msg);
			} else {
				await this.renderChatMessage(msg);
			}
		}

		this.container.scrollTop = this.container.scrollHeight;
	}

	private renderEmptyState() {
		const emptyEl = this.container.createDiv({ cls: "clawbar-empty-state" });
		emptyEl.createDiv({ cls: "clawbar-empty-icon", text: "✳" });
		emptyEl.createDiv({ cls: "clawbar-empty-title", text: "Claude Code" });
		emptyEl.createDiv({
			cls: "clawbar-empty-hint",
			text: "Ask anything about your vault. Use / for commands, @ to reference files.",
		});
	}

	private async renderChatMessage(msg: Message) {
		const msgEl = this.container.createDiv({
			cls: `clawbar-message clawbar-message-${msg.role}`,
		});
		const contentEl = msgEl.createDiv({ cls: "clawbar-message-content" });
		for (const block of msg.blocks) {
			if (block.type === "text" && block.text) {
				await this.renderMarkdown(block.text, contentEl);
			}
		}
	}

	// Intermediate narration alongside tool calls, shown as a collapsed "Thinking" section
	private async renderNarrativeMessage(msg: Message) {
		const el = this.container.createDiv({ cls: "clawbar-narrative" });

		const header = el.createDiv({ cls: "clawbar-narrative-header" });
		const toggle = header.createSpan({ cls: "clawbar-narrative-toggle" });
		setIcon(toggle, "chevron-right");
		header.createSpan({ cls: "clawbar-narrative-label", text: "Thinking" });

		const content = el.createDiv({ cls: "clawbar-narrative-content clawbar-collapsed" });
		for (const block of msg.blocks) {
			if (block.type === "text" && block.text) {
				await this.renderMarkdown(block.text, content);
			}
		}

		this.wireCollapse(header, toggle, content);
	}

	private renderToolMessage(msg: Message) {
		const toolEl = this.container.createDiv({ cls: "clawbar-message clawbar-message-tool" });

		const header = toolEl.createDiv({ cls: "clawbar-tool-header" });
		const toggle = header.createSpan({ cls: "clawbar-tool-toggle" });
		setIcon(toggle, "chevron-right");
		header.createSpan({ cls: "clawbar-tool-name", text: msg.toolName || "Tool" });

		const summary = this.getToolSummary(msg.toolName, msg.blocks[0]?.input);
		if (summary) {
			header.createSpan({
				cls: "clawbar-tool-summary",
				text: summary.length > TOOL_SUMMARY_MAX_CHARS
					? summary.slice(0, TOOL_SUMMARY_MAX_CHARS) + "…"
					: summary,
			});
		}

		const isComplete = msg.toolResult !== undefined;
		const status = header.createSpan({
			cls: `clawbar-tool-status ${isComplete ? "clawbar-tool-complete" : "clawbar-tool-pending"}`,
		});
		if (isComplete) {
			setIcon(status, "check");
		} else {
			status.createSpan({ cls: "clawbar-spinner" });
		}

		const content = toolEl.createDiv({ cls: "clawbar-tool-content clawbar-collapsed" });

		const toolBlock = msg.blocks[0];
		if (toolBlock?.input) {
			if (hasDiffView(msg.toolName, toolBlock.input)) {
				content.createDiv({
					cls: "clawbar-tool-section-label",
					text: msg.toolName === "Write" ? "New content" : "Changes",
				});
				renderDiffView(content, msg.toolName, toolBlock.input);
			} else {
				content.createDiv({ cls: "clawbar-tool-section-label", text: "Input" });
				this.renderCodeBlock(content, JSON.stringify(toolBlock.input, null, 2));
			}
		}

		if (msg.toolResult !== undefined) {
			content.createDiv({ cls: "clawbar-tool-section-label", text: "Output" });
			this.renderCodeBlock(
				content,
				msg.toolResult.length > TOOL_OUTPUT_MAX_CHARS
					? msg.toolResult.slice(0, TOOL_OUTPUT_MAX_CHARS) + "\n... (truncated)"
					: msg.toolResult,
			);
		}

		this.wireCollapse(header, toggle, content);
	}

	// One-line human-readable summary of a tool call for the collapsed header
	private getToolSummary(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
		if (!input) return "";
		const str = (key: string): string => typeof input[key] === "string" ? (input[key] as string) : "";
		switch (toolName) {
			case "Read":
			case "Write":
			case "Edit":
			case "NotebookEdit":
				return str("file_path") || str("notebook_path");
			case "Bash":
				return str("description") || str("command");
			case "Grep":
			case "Glob":
				return str("pattern");
			case "WebFetch":
			case "WebSearch":
				return str("url") || str("query");
			case "Task":
				return str("description");
			case "TodoWrite":
				return "Update task list";
			default: {
				// Fall back to the first string value in the input
				const first = Object.values(input).find((v) => typeof v === "string");
				return typeof first === "string" ? first : "";
			}
		}
	}

	private async renderMarkdown(text: string, container: HTMLElement) {
		const textEl = container.createDiv({ cls: "clawbar-text-block" });
		await MarkdownRenderer.render(this.app, text, textEl, "", this.owner);
	}

	private renderCodeBlock(container: HTMLElement, text: string) {
		container.createEl("pre", { cls: "clawbar-tool-code" }).createEl("code", { text });
	}

	private wireCollapse(header: HTMLElement, toggle: HTMLElement, content: HTMLElement) {
		header.addEventListener("click", () => {
			const wasCollapsed = content.hasClass("clawbar-collapsed");
			if (wasCollapsed) {
				content.removeClass("clawbar-collapsed");
				toggle.addClass("clawbar-expanded");
			} else {
				content.addClass("clawbar-collapsed");
				toggle.removeClass("clawbar-expanded");
			}
		});
	}
}
