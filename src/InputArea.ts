import { App, TFile, setIcon } from "obsidian";
import { BUILTIN_COMMANDS, type SlashCommandDef } from "./constants";
import { AutocompleteDropdown } from "./AutocompleteDropdown";
import { FileSearchProvider } from "./FileSearchProvider";
import type { ModelInfo } from "./claude/types";

export interface InputAreaCallbacks {
	onSubmit: (text: string) => void;
	onStop: () => void;
	onSettings?: () => void;
	onModelChange?: (model: string) => void;
}

export class InputArea {
	private inputEl: HTMLTextAreaElement;
	private submitButton: HTMLButtonElement;
	private stopButton: HTMLButtonElement;
	private contextBarEl: HTMLElement;
	private modelSelectEl: HTMLSelectElement;
	private commandDropdown: AutocompleteDropdown<SlashCommandDef>;
	private allCommands: SlashCommandDef[] = [];
	private fileSearch: FileSearchProvider;
	private callbacks: InputAreaCallbacks;

	/** Submitted messages, oldest first. */
	private history: string[] = [];
	/** Cursor into history; equals history.length when composing a fresh message. */
	private historyIndex = 0;
	/** In-progress text stashed when navigating away into history. */
	private draft = "";

	constructor(container: HTMLElement, app: App, callbacks: InputAreaCallbacks) {
		this.callbacks = callbacks;

		const inputWrapper = container.createDiv({ cls: "clawbar-input-area" });

		this.inputEl = inputWrapper.createEl("textarea", {
			cls: "clawbar-input",
			attr: { placeholder: "Message Claude..." },
		});

		const buttonsRow = inputWrapper.createDiv({ cls: "clawbar-input-buttons" });

		this.modelSelectEl = buttonsRow.createEl("select", {
			cls: "clawbar-model-select",
			attr: { "aria-label": "Model" },
		});
		this.modelSelectEl.style.display = "none";
		this.modelSelectEl.addEventListener("change", () => {
			const value = this.modelSelectEl.value;
			if (value) this.callbacks.onModelChange?.(value);
		});

		const settingsButton = buttonsRow.createEl("button", {
			cls: "clawbar-settings-btn",
			attr: { "aria-label": "MCP Settings" },
		});
		setIcon(settingsButton, "settings");
		settingsButton.addEventListener("click", () => this.callbacks.onSettings?.());

		this.stopButton = buttonsRow.createEl("button", {
			cls: "clawbar-stop",
			text: "Stop",
		});
		this.stopButton.style.display = "none";

		this.submitButton = buttonsRow.createEl("button", {
			cls: "clawbar-submit",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.submitButton, "arrow-up");

		this.commandDropdown = new AutocompleteDropdown<SlashCommandDef>(inputWrapper, {
			renderItem: (cmd, el) => {
				el.setAttribute("title", cmd.description);
				const nameText = cmd.argumentHint ? `/${cmd.name} ${cmd.argumentHint}` : `/${cmd.name}`;
				el.createSpan({ cls: "clawbar-autocomplete-name", text: nameText });
				el.createSpan({ cls: "clawbar-autocomplete-desc", text: cmd.description });
			},
			onSelect: (cmd) => this.insertCommand(cmd),
		});

		this.fileSearch = new FileSearchProvider(app, inputWrapper, this.inputEl);

		this.contextBarEl = container.createDiv({ cls: "clawbar-context-bar" });

		this.inputEl.addEventListener("keydown", (e) => this.handleKeydown(e));
		this.inputEl.addEventListener("input", () => this.handleInput());
		this.submitButton.addEventListener("click", () => this.submit());
		this.stopButton.addEventListener("click", () => this.callbacks.onStop());
	}

	// --- Public API ---

	getValue(): string {
		return this.inputEl.value.trim();
	}

	clear() {
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";
		this.historyIndex = this.history.length;
		this.draft = "";
	}

	setCommands(commands: SlashCommandDef[]) {
		this.allCommands = commands;
	}

	setModels(models: ModelInfo[], currentModel: string | null) {
		this.modelSelectEl.empty();

		if (models.length === 0) {
			this.modelSelectEl.style.display = "none";
			return;
		}

		let matched = false;
		for (const model of models) {
			const option = this.modelSelectEl.createEl("option", {
				text: model.displayName,
				attr: { value: model.value, title: model.description },
			});
			if (currentModel && (model.value === currentModel || currentModel.includes(model.value))) {
				option.selected = true;
				matched = true;
			}
		}

		// Current model not in the list (e.g. full model ID from init) — show it as-is
		if (currentModel && !matched) {
			const option = this.modelSelectEl.createEl("option", {
				text: currentModel,
				attr: { value: currentModel },
			});
			option.selected = true;
		}

		this.modelSelectEl.style.display = "block";
	}

	setThinking(thinking: boolean) {
		this.submitButton.style.display = thinking ? "none" : "block";
		this.stopButton.style.display = thinking ? "block" : "none";
	}

	updateContextBar(file: TFile | null) {
		this.contextBarEl.empty();
		if (file) {
			this.contextBarEl.createSpan({ cls: "clawbar-context-file", text: file.name });
		}
	}

	resolveFileReferences(text: string): Promise<string> {
		return this.fileSearch.resolveReferences(text);
	}

	destroy() {
		this.fileSearch.destroy();
		this.commandDropdown.destroy();
	}

	// --- Private ---

	private submit() {
		const text = this.getValue();
		if (text) {
			this.recordHistory(text);
			this.callbacks.onSubmit(text);
		}
	}

	private recordHistory(text: string) {
		// Skip consecutive duplicates so repeated sends don't clutter history.
		if (this.history[this.history.length - 1] !== text) {
			this.history.push(text);
		}
		this.historyIndex = this.history.length;
		this.draft = "";
	}

	private handleKeydown(e: KeyboardEvent) {
		if (this.fileSearch.handleKeydown(e)) return;
		if (this.commandDropdown.handleKeydown(e)) return;

		if (e.key === "ArrowUp" && this.navigateHistory(-1)) {
			e.preventDefault();
			return;
		}
		if (e.key === "ArrowDown" && this.navigateHistory(1)) {
			e.preventDefault();
			return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.submit();
		}
	}

	/**
	 * Steps through submitted-message history when the caret is on the edge line
	 * (top line for Up, bottom line for Down), so multi-line editing still works.
	 * Returns true when it consumed the key.
	 */
	private navigateHistory(direction: -1 | 1): boolean {
		if (this.history.length === 0) return false;

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart;
		if (direction === -1) {
			// Up: only when nothing precedes the caret line.
			if (value.substring(0, cursorPos).includes("\n")) return false;
		} else {
			// Down: only when nothing follows the caret line.
			if (value.substring(cursorPos).includes("\n")) return false;
			// Already composing a fresh message — let the caret move normally.
			if (this.historyIndex >= this.history.length) return false;
		}

		if (direction === -1 && this.historyIndex === this.history.length) {
			this.draft = value;
		}

		const nextIndex = this.historyIndex + direction;
		if (nextIndex < 0 || nextIndex > this.history.length) return false;

		this.historyIndex = nextIndex;
		const nextValue = nextIndex === this.history.length ? this.draft : this.history[nextIndex];
		this.setValue(nextValue);
		return true;
	}

	private setValue(text: string) {
		this.inputEl.value = text;
		this.inputEl.setSelectionRange(text.length, text.length);
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
	}

	private handleInput() {
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";

		// Editing detaches from history; next Up starts from the newest entry.
		this.historyIndex = this.history.length;

		if (!this.fileSearch.handleInput()) {
			this.updateCommandAutocomplete();
		}
	}

	private updateCommandAutocomplete() {
		const prefix = this.currentSlashQuery();
		if (prefix === null) {
			this.commandDropdown.hide();
			return;
		}

		const matches = (cmds: SlashCommandDef[]) => cmds.filter((c) => c.name.startsWith(prefix));
		const skills = this.allCommands.filter(
			(c) => !BUILTIN_COMMANDS.some((builtin) => builtin.name === c.name)
		);

		this.commandDropdown.show([
			{ label: "Commands", items: matches(BUILTIN_COMMANDS) },
			{ label: "Skills", items: matches(skills) },
		]);
	}

	/** The partial command being typed after '/' at the cursor, or null if not in a slash context. */
	private currentSlashQuery(): string | null {
		const cursorPos = this.inputEl.selectionStart;
		const textBeforeCursor = this.inputEl.value.substring(0, cursorPos);

		const lastSlashIndex = textBeforeCursor.lastIndexOf("/");
		if (lastSlashIndex === -1) return null;

		// Only complete when the slash starts a line
		const beforeSlash = textBeforeCursor.substring(0, lastSlashIndex);
		if (beforeSlash.trim() !== "" && !beforeSlash.endsWith("\n")) return null;

		return textBeforeCursor.substring(lastSlashIndex + 1).toLowerCase();
	}

	private insertCommand(cmd: SlashCommandDef) {
		const text = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart;
		const lastSlashIndex = text.substring(0, cursorPos).lastIndexOf("/");
		if (lastSlashIndex === -1) return;

		const inserted = `/${cmd.name} `;
		this.inputEl.value = text.substring(0, lastSlashIndex) + inserted + text.substring(cursorPos);

		const newCursorPos = lastSlashIndex + inserted.length;
		this.inputEl.setSelectionRange(newCursorPos, newCursorPos);
		this.inputEl.focus();
	}
}
