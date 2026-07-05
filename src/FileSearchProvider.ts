import { App, TFile } from "obsidian";
import { AutocompleteDropdown } from "./AutocompleteDropdown";
import { MAX_FILE_SUGGESTIONS, MAX_INLINE_FILE_CHARS } from "./constants";

/** @file autocomplete and @file reference resolution for the input textarea. */
export class FileSearchProvider {
	private dropdown: AutocompleteDropdown<TFile>;

	constructor(
		private app: App,
		containerEl: HTMLElement,
		private inputArea: HTMLTextAreaElement,
	) {
		this.dropdown = new AutocompleteDropdown<TFile>(
			containerEl,
			{
				renderItem: (file, el) => {
					el.createSpan({ cls: "clawbar-autocomplete-name clawbar-file-name", text: file.name });
					const dir = file.parent?.path || "";
					if (dir && dir !== "/") {
						el.createSpan({ cls: "clawbar-autocomplete-desc clawbar-file-path", text: dir });
					}
				},
				onSelect: (file) => this.insertReference(file),
			},
			"clawbar-file-autocomplete",
		);
	}

	/** Returns true if the file autocomplete is active (consumed the input). */
	handleInput(): boolean {
		const query = this.currentQuery();
		if (query === null) {
			this.dropdown.hide();
			return false;
		}

		const files = this.searchFiles(query);
		if (files.length === 0) {
			this.dropdown.hide();
			return false;
		}

		this.dropdown.show([{ label: "Files", items: files }]);
		return true;
	}

	/** Returns true if it consumed the key event. */
	handleKeydown(e: KeyboardEvent): boolean {
		return this.dropdown.handleKeydown(e);
	}

	/**
	 * Reads the contents of @file references in `text` and returns a context
	 * string to prepend to the outgoing message ("" if there are none).
	 */
	async resolveReferences(text: string): Promise<string> {
		const refs = Array.from(text.matchAll(/@(\S+)/g), (m) => m[1]);
		const contextParts: string[] = [];

		for (const ref of refs) {
			const file = this.app.vault.getAbstractFileByPath(ref);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.app.vault.read(file);
				contextParts.push(
					content.length < MAX_INLINE_FILE_CHARS
						? `[Referenced file: ${file.path}]\n\`\`\`\n${content}\n\`\`\``
						: `[Referenced file: ${file.path} (file too large to include, >10KB)]`
				);
			} catch {
				// File couldn't be read, skip silently
			}
		}

		return contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";
	}

	destroy() {
		this.dropdown.destroy();
	}

	// --- Private ---

	/** The partial filename being typed after '@' at the cursor, or null if not in an @ context. */
	private currentQuery(): string | null {
		const cursorPos = this.inputArea.selectionStart;
		const textBeforeCursor = this.inputArea.value.substring(0, cursorPos);

		const lastAtIndex = textBeforeCursor.lastIndexOf("@");
		if (lastAtIndex === -1) return null;

		// Whitespace after '@' means the token is complete — not in autocomplete mode
		const query = textBeforeCursor.substring(lastAtIndex + 1);
		if (query.includes(" ") || query.includes("\n")) return null;

		return query.toLowerCase();
	}

	private searchFiles(query: string): TFile[] {
		const allFiles = this.app.vault.getFiles();

		// Show recent/all files when just '@' is typed
		if (query === "") return allFiles.slice(0, MAX_FILE_SUGGESTIONS);

		// Name-start matches score highest, then name matches, then path matches
		const scored: { file: TFile; score: number }[] = [];
		for (const file of allFiles) {
			const nameLower = file.name.toLowerCase();
			if (nameLower.includes(query)) {
				scored.push({ file, score: nameLower.startsWith(query) ? 2 : 1 });
			} else if (file.path.toLowerCase().includes(query)) {
				scored.push({ file, score: 0 });
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, MAX_FILE_SUGGESTIONS).map((s) => s.file);
	}

	private insertReference(file: TFile) {
		const text = this.inputArea.value;
		const cursorPos = this.inputArea.selectionStart;
		const lastAtIndex = text.substring(0, cursorPos).lastIndexOf("@");
		if (lastAtIndex === -1) return;

		// Replace @partial with @full/path
		const inserted = `@${file.path} `;
		this.inputArea.value = text.substring(0, lastAtIndex) + inserted + text.substring(cursorPos);

		const newCursorPos = lastAtIndex + inserted.length;
		this.inputArea.setSelectionRange(newCursorPos, newCursorPos);
		this.inputArea.focus();
	}
}
