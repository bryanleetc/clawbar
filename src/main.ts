import { Plugin } from "obsidian";
import { ChatView, VIEW_TYPE_CHAT } from "./ChatView";
import { ClawbarSettings, DEFAULT_SETTINGS, ClawbarSettingTab } from "./settings/SettingsTab";
import { ConversationStore } from "./ConversationStore";

export default class ClawbarPlugin extends Plugin {
	settings: ClawbarSettings;
	conversationStore: ConversationStore;

	async onload() {
		await this.loadSettings();

		// Initialize conversation store
		const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
		if (vaultPath) {
			const pluginDir = `${vaultPath}/.obsidian/plugins/${this.manifest.id}`;
			this.conversationStore = new ConversationStore(
				pluginDir,
				() => this.loadData(),
				(data) => this.saveData(data),
			);
			await this.conversationStore.initialize();
		}

		// Register the chat view
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));

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

	async onAccountChange() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof ChatView) {
				await view.restartForAccountChange();
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		if (this.conversationStore) {
			this.settings.sessionIndex = this.conversationStore.getIndex();
		}
		await this.saveData(this.settings);
	}
}
