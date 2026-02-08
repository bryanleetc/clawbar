import { Plugin } from "obsidian";
import { ChatView, VIEW_TYPE_CHAT } from "./ChatView";
import { ClawbarSettings, DEFAULT_SETTINGS, ClawbarSettingTab } from "./settings/SettingsTab";

export default class ClawbarPlugin extends Plugin {
	settings: ClawbarSettings;

	async onload() {
		await this.loadSettings();

		// Register the chat view
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf));

		// Add ribbon icon to open chat
		this.addRibbonIcon("message-square", "Open Clawbar", () => {
			this.activateView();
		});

		// Add command to open chat
		this.addCommand({
			id: "open-clawbar",
			name: "Open Clawbar",
			callback: () => {
				this.activateView();
			},
		});

		// Add settings tab
		this.addSettingTab(new ClawbarSettingTab(this.app, this));
	}

	onunload() {
		// Clean up view
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: VIEW_TYPE_CHAT,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
