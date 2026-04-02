import { App, PluginSettingTab, Setting } from "obsidian";
import ClawbarPlugin from "../main";
import type { SessionMeta } from "../claude/types";

export interface ClaudeAccount {
	id: string;
	alias: string;
	configDir: string;
}

export interface ClawbarSettings {
	claudePath: string;
	sessionIndex: SessionMeta[];
	currentSessionId: string | null;
	disabledMcpServers: string[];
	maxSavedChats: number;
	accounts: ClaudeAccount[];
	activeAccountId: string | null;
}

export const DEFAULT_SETTINGS: ClawbarSettings = {
	claudePath: "",
	sessionIndex: [],
	currentSessionId: null,
	disabledMcpServers: [],
	maxSavedChats: 50,
	accounts: [],
	activeAccountId: null,
};

export class ClawbarSettingTab extends PluginSettingTab {
	plugin: ClawbarPlugin;

	constructor(app: App, plugin: ClawbarPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Claude Code path")
			.setDesc("Full path to the Claude Code CLI (run 'which claude' in terminal to find it)")
			.addText((text) =>
				text
					.setPlaceholder("/usr/local/bin/claude")
					.setValue(this.plugin.settings.claudePath)
					.onChange(async (value) => {
						this.plugin.settings.claudePath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Maximum saved conversations")
			.setDesc("Maximum number of chat sessions to keep (oldest will be deleted when limit is reached)")
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(String(this.plugin.settings.maxSavedChats))
					.onChange(async (value) => {
						const num = parseInt(value);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.maxSavedChats = num;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Current saved conversations")
			.setDesc(`${this.plugin.settings.sessionIndex.length} of ${this.plugin.settings.maxSavedChats} chat sessions saved`)
			.setDisabled(true);

		// --- Claude Accounts ---
		containerEl.createEl("h3", { text: "Claude Accounts" });

		const accountsSection = containerEl.createDiv();

		const renderAccountsSection = () => {
			accountsSection.empty();

			// Active account dropdown
			new Setting(accountsSection)
				.setName("Active account")
				.setDesc("Sets CLAUDE_CONFIG_DIR when Claude starts. Default uses ~/.claude.")
				.addDropdown((dd) => {
					dd.addOption("", "Default (~/.claude)");
					for (const account of this.plugin.settings.accounts) {
						dd.addOption(account.id, `${account.alias} — ${account.configDir}`);
					}
					dd.setValue(this.plugin.settings.activeAccountId ?? "");
					dd.onChange(async (value) => {
						this.plugin.settings.activeAccountId = value || null;
						await this.plugin.saveSettings();
						await this.plugin.onAccountChange();
					});
				});

			// Account list with Remove buttons
			for (const account of this.plugin.settings.accounts) {
				new Setting(accountsSection)
					.setName(account.alias)
					.setDesc(account.configDir)
					.addButton((btn) => {
						btn.setButtonText("Remove").onClick(async () => {
							this.plugin.settings.accounts = this.plugin.settings.accounts.filter(
								(a) => a.id !== account.id
							);
							if (this.plugin.settings.activeAccountId === account.id) {
								this.plugin.settings.activeAccountId = null;
								await this.plugin.onAccountChange();
							}
							await this.plugin.saveSettings();
							renderAccountsSection();
						});
					});
			}

			// Add account form
			let newAlias = "";
			let newConfigDir = "";

			new Setting(accountsSection)
				.setName("Add account")
				.setDesc("Alias and config directory path (e.g. ~/.claude-work)")
				.addText((text) =>
					text.setPlaceholder("Alias").onChange((value) => {
						newAlias = value;
					})
				)
				.addText((text) =>
					text.setPlaceholder("~/.claude-work").onChange((value) => {
						newConfigDir = value;
					})
				)
				.addButton((btn) => {
					btn.setButtonText("Add").onClick(async () => {
						if (!newAlias.trim() || !newConfigDir.trim()) return;
						const account: ClaudeAccount = {
							id: `account-${Date.now()}`,
							alias: newAlias.trim(),
							configDir: newConfigDir.trim(),
						};
						this.plugin.settings.accounts.push(account);
						await this.plugin.saveSettings();
						renderAccountsSection();
					});
				});
		};

		renderAccountsSection();
	}
}
