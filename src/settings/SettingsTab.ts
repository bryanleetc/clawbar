import { App, PluginSettingTab, Setting } from "obsidian";
import ClawbarPlugin from "../main";

export interface ClawbarSettings {
	claudePath: string;
}

export const DEFAULT_SETTINGS: ClawbarSettings = {
	claudePath: "claude",
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
			.setDesc("Path to the Claude Code CLI executable")
			.addText((text) =>
				text
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudePath)
					.onChange(async (value) => {
						this.plugin.settings.claudePath = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
