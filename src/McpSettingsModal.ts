import { App, Modal, Setting } from "obsidian";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { AgentManager } from "./claude/AgentManager";
import type ClawbarPlugin from "./main";

export class McpSettingsModal extends Modal {
	private agent: AgentManager;
	private plugin: ClawbarPlugin;
	private pendingChanges = new Map<string, boolean>();
	private mcpBodyEl: HTMLElement;

	constructor(app: App, agent: AgentManager, plugin: ClawbarPlugin) {
		super(app);
		this.agent = agent;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("clawbar-mcp-modal");
		contentEl.createEl("h2", { text: "Settings" });

		// MCP Servers section
		const section = contentEl.createDiv({ cls: "clawbar-mcp-section" });
		section.createEl("h3", { text: "MCP Servers" });

		this.mcpBodyEl = section.createDiv({ cls: "clawbar-mcp-body" });
		this.renderLoading();
		this.loadMcpServers();

		// Footer actions
		const footer = contentEl.createDiv({ cls: "clawbar-mcp-footer" });

		const saveBtn = footer.createEl("button", {
			cls: "clawbar-mcp-save mod-cta",
			text: "Save",
		});
		saveBtn.addEventListener("click", () => this.save());

		const cancelBtn = footer.createEl("button", {
			cls: "clawbar-mcp-cancel",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	private renderLoading() {
		this.mcpBodyEl.empty();
		const loading = this.mcpBodyEl.createDiv({ cls: "clawbar-mcp-loading" });
		loading.createSpan({ cls: "clawbar-usage-spinner" });
		loading.createSpan({ text: "Loading MCP servers…", cls: "clawbar-mcp-loading-text" });
	}

	private async loadMcpServers() {
		let servers: McpServerStatus[];
		try {
			servers = await this.agent.getMcpServerStatus();
		} catch {
			this.mcpBodyEl.empty();
			this.mcpBodyEl.createEl("p", {
				text: "Could not load MCP servers. Is Claude running?",
				cls: "clawbar-mcp-error",
			});
			return;
		}

		this.mcpBodyEl.empty();

		if (servers.length === 0) {
			this.mcpBodyEl.createEl("p", {
				text: "No MCP servers configured.",
				cls: "clawbar-mcp-empty",
			});
			return;
		}

		const disabledInSettings = new Set(this.plugin.settings.disabledMcpServers);

		for (const server of servers) {
			const isEnabled = server.status !== "disabled" && !disabledInSettings.has(server.name);

			new Setting(this.mcpBodyEl)
				.setName(server.name)
				.setDesc(this.descForStatus(server))
				.addToggle((toggle) => {
					toggle.setValue(isEnabled).onChange((value) => {
						this.pendingChanges.set(server.name, value);
					});
				});
		}
	}

	private descForStatus(server: McpServerStatus): string {
		switch (server.status) {
			case "connected": return `Connected${server.serverInfo ? ` · ${server.serverInfo.name} ${server.serverInfo.version}` : ""}`;
			case "failed": return `Failed${server.error ? `: ${server.error}` : ""}`;
			case "needs-auth": return "Needs authentication";
			case "pending": return "Connecting…";
			case "disabled": return "Disabled";
			default: return server.status;
		}
	}

	private async save() {
		if (this.pendingChanges.size > 0) {
			const disabledSet = new Set(this.plugin.settings.disabledMcpServers);

			for (const [name, enabled] of this.pendingChanges) {
				try {
					await this.agent.toggleMcpServer(name, enabled);
					console.log(`[Clawbar] MCP server ${enabled ? "enabled" : "disabled"}: ${name}`);
				} catch (err) {
					console.error(`[Clawbar] Failed to toggle MCP server "${name}":`, err);
				}

				if (enabled) {
					disabledSet.delete(name);
				} else {
					disabledSet.add(name);
				}
			}

			this.plugin.settings.disabledMcpServers = Array.from(disabledSet);
			await this.plugin.saveSettings();
			console.log("[Clawbar] MCP settings saved. Disabled servers:", this.plugin.settings.disabledMcpServers);
		}

		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
