import { App, TFile, setIcon } from "obsidian";
import { BUILTIN_COMMANDS, type SlashCommandDef } from "./constants";
import { FileSearchProvider } from "./FileSearchProvider";

export interface InputAreaCallbacks {
	onSubmit: (text: string) => void;
	onStop: () => void;
	onSettings?: () => void;
}

export class InputArea {
	private inputEl: HTMLTextAreaElement;
	private submitButton: HTMLButtonElement;
	private stopButton: HTMLButtonElement;
	private autocompleteEl: HTMLElement;
	private contextBarEl: HTMLElement;
	private selectedCommandIndex = -1;
	private allCommands: SlashCommandDef[] = [];
	private fileSearch: FileSearchProvider;
	private callbacks: InputAreaCallbacks;

	constructor(container: HTMLElement, app: App, callbacks: InputAreaCallbacks) {
		this.callbacks = callbacks;

		const inputWrapper = container.createDiv({ cls: "clawbar-input-area" });

		this.inputEl = inputWrapper.createEl("textarea", {
			cls: "clawbar-input",
			attr: { placeholder: "Message Claude..." },
		});

		const buttonsRow = inputWrapper.createDiv({ cls: "clawbar-input-buttons" });

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

		this.autocompleteEl = inputWrapper.createDiv({ cls: "clawbar-autocomplete" });
		this.autocompleteEl.style.display = "none";

		this.fileSearch = new FileSearchProvider(app, inputWrapper, this.inputEl);

		this.contextBarEl = container.createDiv({ cls: "clawbar-context-bar" });

		// Event handlers
		this.inputEl.addEventListener("keydown", (e) => this.handleKeydown(e));
		this.submitButton.addEventListener("click", () => {
			const text = this.getValue();
			if (text) this.callbacks.onSubmit(text);
		});
		this.stopButton.addEventListener("click", () => this.callbacks.onStop());
		this.inputEl.addEventListener("input", () => this.handleInput());
	}

	// --- Public API ---

	getValue(): string {
		return this.inputEl.value.trim();
	}

	clear() {
		this.inputEl.value = "";
		this.inputEl.style.height = "auto";
	}

	setCommands(commands: SlashCommandDef[]) {
		this.allCommands = commands;
	}

	setThinking(thinking: boolean) {
		if (thinking) {
			this.submitButton.style.display = "none";
			this.stopButton.style.display = "block";
		} else {
			this.submitButton.style.display = "block";
			this.stopButton.style.display = "none";
		}
	}

	updateContextBar(file: TFile | null) {
		this.contextBarEl.empty();
		if (file) {
			this.contextBarEl.createSpan({
				cls: "clawbar-context-file",
				text: file.name,
			});
		}
	}

	async resolveFileReferences(text: string) {
		return this.fileSearch.resolveReferences(text);
	}

	destroy() {
		this.fileSearch.destroy();
	}

	// --- Private: Event Handlers ---

	private handleKeydown(e: KeyboardEvent) {
		if (this.fileSearch.handleKeydown(e)) return;

		if (this.autocompleteEl.style.display !== "none") {
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
			if (this.autocompleteEl.style.display !== "none") {
				this.selectCommand();
			} else {
				const text = this.getValue();
				if (text) this.callbacks.onSubmit(text);
			}
		}
	}

	private handleInput() {
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";

		if (!this.fileSearch.handleInput()) {
			this.handleAutocomplete();
		}
	}

	// --- Private: Slash Command Autocomplete ---

	private handleAutocomplete() {
		const text = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPos);
		const lastSlashIndex = textBeforeCursor.lastIndexOf('/');

		if (lastSlashIndex === -1) {
			this.hideAutocomplete();
			return;
		}

		const beforeSlash = textBeforeCursor.substring(0, lastSlashIndex);
		if (beforeSlash.trim() !== '' && !beforeSlash.endsWith('\n')) {
			this.hideAutocomplete();
			return;
		}

		const partialCommand = textBeforeCursor.substring(lastSlashIndex + 1);

		const filteredBuiltins = BUILTIN_COMMANDS.filter(cmd =>
			cmd.name.startsWith(partialCommand.toLowerCase())
		);

		const sdkSkills = this.allCommands.filter(cmd =>
			!BUILTIN_COMMANDS.some(builtin => builtin.name === cmd.name)
		);
		const filteredSkills = sdkSkills.filter(cmd =>
			cmd.name.startsWith(partialCommand.toLowerCase())
		);

		if (filteredBuiltins.length === 0 && filteredSkills.length === 0) {
			this.hideAutocomplete();
			return;
		}

		this.showAutocomplete(filteredBuiltins, filteredSkills);
	}

	private showAutocomplete(builtinCommands: SlashCommandDef[], skills: SlashCommandDef[]) {
		this.autocompleteEl.empty();
		this.selectedCommandIndex = 0;

		let itemIndex = 0;

		if (builtinCommands.length > 0) {
			this.autocompleteEl.createDiv({
				cls: "clawbar-autocomplete-section",
				text: "Commands"
			});

			builtinCommands.forEach((cmd) => {
				this.renderAutocompleteItem(cmd, itemIndex === 0);
				itemIndex++;
			});
		}

		if (skills.length > 0) {
			this.autocompleteEl.createDiv({
				cls: "clawbar-autocomplete-section",
				text: "Skills"
			});

			skills.forEach((cmd) => {
				this.renderAutocompleteItem(cmd, itemIndex === 0 && builtinCommands.length === 0);
				itemIndex++;
			});
		}

		this.autocompleteEl.style.display = "block";
	}

	private renderAutocompleteItem(cmd: SlashCommandDef, isSelected: boolean) {
		const itemIndex = this.autocompleteEl.querySelectorAll(".clawbar-autocomplete-item").length;

		const item = this.autocompleteEl.createDiv({
			cls: isSelected ? "clawbar-autocomplete-item clawbar-autocomplete-selected" : "clawbar-autocomplete-item"
		});

		item.setAttribute("title", cmd.description);

		const nameText = cmd.argumentHint
			? `/${cmd.name} ${cmd.argumentHint}`
			: `/${cmd.name}`;

		item.createSpan({ cls: "clawbar-autocomplete-name", text: nameText });
		item.createSpan({ cls: "clawbar-autocomplete-desc", text: cmd.description });

		item.addEventListener("click", () => {
			this.selectedCommandIndex = itemIndex;
			this.selectCommand();
		});
	}

	private hideAutocomplete() {
		this.autocompleteEl.style.display = "none";
		this.selectedCommandIndex = -1;
	}

	private navigateAutocomplete(direction: number) {
		const items = this.autocompleteEl.querySelectorAll(".clawbar-autocomplete-item");
		if (items.length === 0) return;

		items[this.selectedCommandIndex]?.removeClass("clawbar-autocomplete-selected");
		this.selectedCommandIndex = (this.selectedCommandIndex + direction + items.length) % items.length;
		items[this.selectedCommandIndex]?.addClass("clawbar-autocomplete-selected");
		items[this.selectedCommandIndex]?.scrollIntoView({ block: "nearest" });
	}

	private selectCommand() {
		if (this.selectedCommandIndex === -1) return;

		const items = this.autocompleteEl.querySelectorAll(".clawbar-autocomplete-item");
		const selectedItem = items[this.selectedCommandIndex];
		if (!selectedItem) return;

		const commandName = selectedItem.querySelector(".clawbar-autocomplete-name")?.textContent;
		if (!commandName) return;

		const text = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPos);
		const lastSlashIndex = textBeforeCursor.lastIndexOf('/');

		const newText = text.substring(0, lastSlashIndex) + commandName + " " + text.substring(cursorPos);
		this.inputEl.value = newText;

		const newCursorPos = lastSlashIndex + commandName.length + 1;
		this.inputEl.setSelectionRange(newCursorPos, newCursorPos);

		this.hideAutocomplete();
		this.inputEl.focus();
	}
}
