import type { PermissionResult } from "./claude/types";
import { hasDiffView, renderDiffView } from "./DiffView";

interface Question {
	question: string;
	header: string;
	options: Array<{ label: string; description: string }>;
	multiSelect: boolean;
}

/**
 * Interactive permission and AskUserQuestion prompts, queued so only one
 * is visible at a time. Owns its container; it is never cleared by message
 * re-renders.
 */
export class PromptManager {
	private queue: Promise<void> = Promise.resolve();

	constructor(private container: HTMLElement) {}

	/** Queue a tool permission request; resolves when the user answers. */
	request(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		const result = this.queue.then(() => this.show(toolName, toolInput));
		// Advance the queue tail; ignore errors so the chain never breaks
		this.queue = result.then(() => {}, () => {});
		return result;
	}

	/** Drop pending prompts (e.g. when switching conversations). */
	reset() {
		this.queue = Promise.resolve();
		this.container.empty();
	}

	private show(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		if (toolName === "AskUserQuestion") {
			return this.showQuestionPrompt(toolInput as Record<string, unknown>);
		}
		return this.showPermissionPrompt(toolName, toolInput);
	}

	private showPermissionPrompt(toolName: string, toolInput: unknown): Promise<PermissionResult> {
		return new Promise((resolve) => {
			const promptEl = this.container.createDiv({ cls: "clawbar-permission-prompt" });

			const header = promptEl.createDiv({ cls: "clawbar-permission-header" });
			header.createSpan({ text: `Claude wants to use: ${toolName}` });

			const details = promptEl.createDiv({ cls: "clawbar-permission-details" });
			const input = toolInput as Record<string, unknown>;
			if (hasDiffView(toolName, input)) {
				if (typeof input.file_path === "string") {
					details.createDiv({ cls: "clawbar-diff-file", text: input.file_path });
				}
				renderDiffView(details, toolName, input);
			} else {
				const inputPre = details.createEl("pre", { cls: "clawbar-tool-code" });
				inputPre.createEl("code", { text: JSON.stringify(toolInput, null, 2) });
			}

			const actions = promptEl.createDiv({ cls: "clawbar-permission-actions" });

			const allowBtn = actions.createEl("button", {
				cls: "clawbar-permission-allow",
				text: "Allow",
			});
			allowBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({ behavior: "allow", updatedInput: input });
			});

			const denyBtn = actions.createEl("button", {
				cls: "clawbar-permission-deny",
				text: "Deny",
			});
			denyBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({ behavior: "deny", message: "User denied tool use" });
			});
		});
	}

	private showQuestionPrompt(input: Record<string, unknown>): Promise<PermissionResult> {
		return new Promise((resolve) => {
			const questions = (input.questions as Question[]) || [];
			const answers: Record<string, string> = {};

			const promptEl = this.container.createDiv({ cls: "clawbar-question-prompt" });

			for (const q of questions) {
				this.renderQuestion(promptEl, q, answers);
			}

			const submitBtn = promptEl.createEl("button", {
				cls: "clawbar-question-submit",
				text: "Submit",
			});
			submitBtn.addEventListener("click", () => {
				promptEl.remove();
				resolve({ behavior: "allow", updatedInput: { ...input, answers } });
			});
		});
	}

	private renderQuestion(promptEl: HTMLElement, q: Question, answers: Record<string, string>) {
		const questionEl = promptEl.createDiv({ cls: "clawbar-question" });
		questionEl.createDiv({ cls: "clawbar-question-text", text: q.question });

		const optionsEl = questionEl.createDiv({ cls: "clawbar-question-options" });
		const selected = new Set<string>();

		const clearSelection = () => {
			selected.clear();
			optionsEl.querySelectorAll(".clawbar-question-option").forEach(
				(b) => (b as HTMLElement).removeClass("clawbar-question-option-selected")
			);
		};

		for (const opt of q.options) {
			const optBtn = optionsEl.createEl("button", { cls: "clawbar-question-option" });
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
					clearSelection();
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
				clearSelection();
				answers[q.question] = otherInput.value.trim();
			}
		});
	}
}
