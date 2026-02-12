/**
 * Patches DOM prototypes with Obsidian-specific methods used by ChatView.
 * Call this before instantiating any Obsidian view classes in tests.
 */

interface DomElementInfo {
	cls?: string;
	text?: string;
	type?: string;
	placeholder?: string;
}

function applyInfo(el: HTMLElement, info?: DomElementInfo) {
	if (!info) return;
	if (info.cls) {
		for (const c of info.cls.split(" ")) el.classList.add(c);
	}
	if (info.text) el.textContent = info.text;
	if (info.type) el.setAttribute("type", info.type);
	if (info.placeholder) el.setAttribute("placeholder", info.placeholder);
}

export function patchObsidianDom() {
	if ((Node.prototype as any)._obsidianPatched) return;
	(Node.prototype as any)._obsidianPatched = true;

	(Node.prototype as any).createDiv = function (info?: DomElementInfo) {
		const el = document.createElement("div");
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};

	(Node.prototype as any).createSpan = function (info?: DomElementInfo) {
		const el = document.createElement("span");
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};

	(Node.prototype as any).createEl = function (tag: string, info?: DomElementInfo) {
		const el = document.createElement(tag);
		applyInfo(el, info);
		this.appendChild(el);
		return el;
	};

	(Node.prototype as any).empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};

	(Element.prototype as any).setText = function (val: string) {
		this.textContent = val;
	};

	(Element.prototype as any).addClass = function (...cls: string[]) {
		this.classList.add(...cls);
	};

	(Element.prototype as any).removeClass = function (...cls: string[]) {
		this.classList.remove(...cls);
	};

	(Element.prototype as any).hasClass = function (cls: string) {
		return this.classList.contains(cls);
	};
}
