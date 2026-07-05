export interface AutocompleteSection<T> {
	label: string;
	items: T[];
}

/**
 * Generic autocomplete dropdown with keyboard navigation, shared by the
 * slash-command and @file autocompletes. Items are kept in memory; the DOM
 * is only ever a projection of them.
 */
export class AutocompleteDropdown<T> {
	private el: HTMLElement;
	private items: T[] = [];
	private itemEls: HTMLElement[] = [];
	private selectedIndex = -1;

	constructor(
		container: HTMLElement,
		private callbacks: {
			renderItem: (item: T, el: HTMLElement) => void;
			onSelect: (item: T) => void;
		},
		extraCls = "",
	) {
		this.el = container.createDiv({ cls: `clawbar-autocomplete ${extraCls}`.trim() });
		this.el.style.display = "none";
	}

	get isOpen(): boolean {
		return this.el.style.display !== "none";
	}

	show(sections: AutocompleteSection<T>[]) {
		this.el.empty();
		this.items = [];
		this.itemEls = [];
		this.selectedIndex = -1;

		for (const section of sections) {
			if (section.items.length === 0) continue;
			this.el.createDiv({ cls: "clawbar-autocomplete-section", text: section.label });
			for (const item of section.items) {
				const index = this.items.length;
				const itemEl = this.el.createDiv({ cls: "clawbar-autocomplete-item" });
				this.callbacks.renderItem(item, itemEl);
				itemEl.addEventListener("click", () => {
					this.selectedIndex = index;
					this.select();
				});
				this.items.push(item);
				this.itemEls.push(itemEl);
			}
		}

		if (this.items.length === 0) {
			this.hide();
			return;
		}
		this.setSelected(0);
		this.el.style.display = "block";
	}

	hide() {
		this.el.style.display = "none";
		this.items = [];
		this.itemEls = [];
		this.selectedIndex = -1;
	}

	/** Returns true if the key event was consumed (dropdown open and key handled). */
	handleKeydown(e: KeyboardEvent): boolean {
		if (!this.isOpen) return false;

		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				this.navigate(1);
				return true;
			case "ArrowUp":
				e.preventDefault();
				this.navigate(-1);
				return true;
			case "Tab":
			case "Enter":
				e.preventDefault();
				this.select();
				return true;
			case "Escape":
				e.preventDefault();
				this.hide();
				return true;
		}
		return false;
	}

	destroy() {
		this.el.remove();
	}

	private navigate(direction: number) {
		if (this.items.length === 0) return;
		this.setSelected((this.selectedIndex + direction + this.items.length) % this.items.length);
		this.itemEls[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
	}

	private setSelected(index: number) {
		this.itemEls[this.selectedIndex]?.removeClass("clawbar-autocomplete-selected");
		this.selectedIndex = index;
		this.itemEls[index]?.addClass("clawbar-autocomplete-selected");
	}

	private select() {
		const item = this.items[this.selectedIndex];
		if (item === undefined) return;
		this.hide();
		this.callbacks.onSelect(item);
	}
}
