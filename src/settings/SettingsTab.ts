import { App, PluginSettingTab, Setting } from "obsidian";
import ClawbarPlugin from "../main";
import type { SessionMeta } from "../claude/types";

export interface ClawbarSettings {
	claudePath: string;
	sessionIndex: SessionMeta[];
	currentSessionId: string | null;
	disabledMcpServers: string[];
	maxSavedChats: number;
}

export const DEFAULT_SETTINGS: ClawbarSettings = {
	claudePath: "",
	sessionIndex: [],
	currentSessionId: null,
	disabledMcpServers: [],
	maxSavedChats: 50,
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
	}
}
