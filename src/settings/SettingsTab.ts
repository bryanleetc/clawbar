import { App, PluginSettingTab, Setting } from "obsidian";
import ClawbarPlugin from "../main";
import type { SessionMeta } from "../claude/types";

export interface ClawbarSettings {
	claudePath: string;
	sessionIndex: SessionMeta[];
	currentSessionId: string | null;
}

export const DEFAULT_SETTINGS: ClawbarSettings = {
	claudePath: "",
	sessionIndex: [],
	currentSessionId: null,
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
	}
}
