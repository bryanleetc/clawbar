// Stub exports for Obsidian module — used by vitest resolve.alias

export class WorkspaceLeaf {
	app: any = { vault: { adapter: { basePath: "/test" } }, workspace: { on: () => ({ unref: () => {} }) }, metadataCache: {} };
	view: any = {};
}

export class ItemView {
	containerEl: HTMLElement;
	app: any;
	leaf: any;
	constructor(leaf: any) {
		this.leaf = leaf;
		this.app = leaf?.app ?? {};
		this.containerEl = document.createElement("div");
		this.containerEl.appendChild(document.createElement("div"));
		this.containerEl.appendChild(document.createElement("div"));
	}
	getViewType() { return ""; }
	getDisplayText() { return ""; }
	getIcon() { return ""; }
	registerEvent() {}
}

export class Modal {
	app: any;
	contentEl: HTMLElement;
	constructor(app: any) {
		this.app = app;
		this.contentEl = document.createElement("div");
	}
	open() {}
	close() {}
}

export class Component {}

export class MarkdownRenderer {
	static async render(_app: any, markdown: string, el: HTMLElement, _sourcePath: string, _component: any) {
		el.textContent = markdown;
	}
}

export class Notice {
	constructor(_msg: string) {}
}

export class TFile {
	name = "test.md";
	path = "test.md";
	basename = "test";
	extension = "md";
}

export class App {}
