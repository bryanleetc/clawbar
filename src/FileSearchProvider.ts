import { App, TFile } from "obsidian";

export class FileSearchProvider {
	private app: App;
	private inputArea: HTMLTextAreaElement;
	private dropdownEl: HTMLElement;
	private selectedIndex = -1;
	private filteredFiles: TFile[] = [];

	constructor(app: App, containerEl: HTMLElement, inputArea: HTMLTextAreaElement) {
		this.app = app;
		this.inputArea = inputArea;

		this.dropdownEl = containerEl.createDiv({ cls: "clawbar-autocomplete clawbar-file-autocomplete" });
		this.dropdownEl.style.display = "none";
	}

	/**
	 * Called from ChatView's input handler.
	 * Returns true if the file autocomplete is active (consumed the event).
	 */
	handleInput(): boolean {
		const text = this.inputArea.value;
		const cursorPos = this.inputArea.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPos);

		// Find the last '@' before cursor
		const lastAtIndex = textBeforeCursor.lastIndexOf("@");
		if (lastAtIndex === -1) {
			this.hide();
			return false;
		}

		// Extract the query after '@' (up to cursor)
		const query = textBeforeCursor.substring(lastAtIndex + 1);

		// If there's a space after the query started, the token is complete — not in autocomplete mode
		if (query.includes(" ") || query.includes("\n")) {
			this.hide();
			return false;
		}

		// Filter vault files
		const allFiles = this.app.vault.getFiles();
		const lowerQuery = query.toLowerCase();

		if (lowerQuery === "") {
			// Show recent/all files when just '@' is typed
			this.filteredFiles = allFiles.slice(0, 15);
		} else {
			// Score and filter files
			const scored: { file: TFile; score: number }[] = [];
			for (const file of allFiles) {
				const nameLower = file.name.toLowerCase();
				const pathLower = file.path.toLowerCase();

				if (nameLower.includes(lowerQuery)) {
					// Exact name start match scores highest
					const score = nameLower.startsWith(lowerQuery) ? 2 : 1;
					scored.push({ file, score });
				} else if (pathLower.includes(lowerQuery)) {
					scored.push({ file, score: 0 });
				}
			}

			scored.sort((a, b) => b.score - a.score);
			this.filteredFiles = scored.slice(0, 15).map((s) => s.file);
		}

		if (this.filteredFiles.length === 0) {
			this.hide();
			return false;
		}

		this.render();
		return true;
	}

	/**
	 * Called from ChatView's keydown handler.
	 * Returns true if it consumed the event.
	 */
	handleKeydown(e: KeyboardEvent): boolean {
		if (this.dropdownEl.style.display === "none") return false;

		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.navigate(1);
			return true;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			this.navigate(-1);
			return true;
		}
		if (e.key === "Tab" || e.key === "Enter") {
			e.preventDefault();
			this.select();
			return true;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			this.hide();
			return true;
		}

		return false;
	}

	/**
	 * Extracts @file references from the message text, reads their contents,
	 * and returns a context string to prepend + the original text.
	 */
	async resolveReferences(text: string): Promise<{ context: string; cleanedText: string }> {
		const regex = /@(\S+)/g;
		let match;
		const refs: string[] = [];

		while ((match = regex.exec(text)) !== null) {
			refs.push(match[1]);
		}

		if (refs.length === 0) {
			return { context: "", cleanedText: text };
		}

		const contextParts: string[] = [];

		for (const ref of refs) {
			const file = this.app.vault.getAbstractFileByPath(ref);
			if (!(file instanceof TFile)) continue;

			try {
				const content = await this.app.vault.read(file);
				if (content.length < 10000) {
					contextParts.push(`[Referenced file: ${file.path}]\n\`\`\`\n${content}\n\`\`\``);
				} else {
					contextParts.push(`[Referenced file: ${file.path} (file too large to include, >10KB)]`);
				}
			} catch {
				// File couldn't be read, skip silently
			}
		}

		const context = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";
		return { context, cleanedText: text };
	}

	destroy() {
		this.dropdownEl.remove();
	}

	// --- Private methods ---

	private render() {
		this.dropdownEl.empty();
		this.selectedIndex = 0;

		this.dropdownEl.createDiv({
			cls: "clawbar-autocomplete-section",
			text: "Files",
		});

		this.filteredFiles.forEach((file, index) => {
			const item = this.dropdownEl.createDiv({
				cls: index === 0
					? "clawbar-autocomplete-item clawbar-autocomplete-selected"
					: "clawbar-autocomplete-item",
			});

			item.createSpan({ cls: "clawbar-autocomplete-name clawbar-file-name", text: file.name });

			const dir = file.parent?.path || "";
			if (dir && dir !== "/") {
				item.createSpan({ cls: "clawbar-autocomplete-desc clawbar-file-path", text: dir });
			}

			item.addEventListener("click", () => {
				this.selectedIndex = index;
				this.select();
			});
		});

		this.dropdownEl.style.display = "block";
	}

	private hide() {
		this.dropdownEl.style.display = "none";
		this.selectedIndex = -1;
		this.filteredFiles = [];
	}

	private navigate(direction: number) {
		const items = this.dropdownEl.querySelectorAll(".clawbar-autocomplete-item");
		if (items.length === 0) return;

		items[this.selectedIndex]?.removeClass("clawbar-autocomplete-selected");
		this.selectedIndex = (this.selectedIndex + direction + items.length) % items.length;
		items[this.selectedIndex]?.addClass("clawbar-autocomplete-selected");
		items[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
	}

	private select() {
		if (this.selectedIndex === -1 || this.selectedIndex >= this.filteredFiles.length) return;

		const file = this.filteredFiles[this.selectedIndex];
		const text = this.inputArea.value;
		const cursorPos = this.inputArea.selectionStart;
		const textBeforeCursor = text.substring(0, cursorPos);
		const lastAtIndex = textBeforeCursor.lastIndexOf("@");

		if (lastAtIndex === -1) return;

		// Replace @partial with @full/path
		const newText = text.substring(0, lastAtIndex) + "@" + file.path + " " + text.substring(cursorPos);
		this.inputArea.value = newText;

		const newCursorPos = lastAtIndex + 1 + file.path.length + 1;
		this.inputArea.setSelectionRange(newCursorPos, newCursorPos);

		this.hide();
		this.inputArea.focus();
	}
}
