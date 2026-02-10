import { App, Component, MarkdownRenderer, Modal } from "obsidian";

export class UsageModal extends Modal {
	private bodyEl: HTMLElement;
	private component: Component;

	constructor(app: App) {
		super(app);
		this.component = new Component();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("clawbar-usage-modal");
		contentEl.createEl("h2", { text: "Claude Usage" });

		this.bodyEl = contentEl.createDiv({ cls: "clawbar-usage-body" });
		this.showLoading();
	}

	showLoading() {
		this.bodyEl.empty();
		const spinner = this.bodyEl.createDiv({ cls: "clawbar-usage-loading" });
		spinner.createSpan({ cls: "clawbar-usage-spinner" });
		spinner.createSpan({ text: "Fetching usage data…", cls: "clawbar-usage-loading-text" });
	}

	async showContent(markdown: string) {
		this.bodyEl.empty();
		this.component.load();
		await MarkdownRenderer.render(this.app, markdown, this.bodyEl, "", this.component);
	}

	showError(message: string) {
		this.bodyEl.empty();
		this.bodyEl.createEl("p", { text: message, cls: "clawbar-usage-error" });
	}

	onClose() {
		this.component.unload();
		this.contentEl.empty();
	}
}
