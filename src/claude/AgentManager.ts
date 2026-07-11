import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SlashCommand, ModelUsage, McpServerStatus, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { dirname } from "path";
import { assistantBlocks } from "./types";
import type { SDKMessage, SDKUserMessage, PermissionResult } from "./types";

export interface SessionUsageStats {
	requestCount: number;
	totalCostUSD: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	modelUsage: Record<string, ModelUsage>;
}

/** Everything the UI needs to hear about from the agent. Detached all at once. */
export interface AgentEvents {
	onMessage: (message: SDKMessage) => void;
	onError: (error: string) => void;
	onPermission: (toolName: string, toolInput: Record<string, unknown>) => Promise<PermissionResult>;
	onSkills: (skills: SlashCommand[]) => void;
	onSessionId: (sessionId: string) => void;
	onModels: (models: ModelInfo[], currentModel: string | null) => void;
}

type QueryOptions = Parameters<typeof query>[0]["options"];

export class AgentManager {
	private events: AgentEvents | null;
	private currentModel: string | null = null;
	private availableModels: ModelInfo[] = [];
	private abortController: AbortController | null = null;
	private messageQueue: SDKUserMessage[] = [];
	private messageResolve: (() => void) | null = null;
	private running = false;
	private queryInstance: Query | null = null;
	private sessionId: string | null = null;
	// When set, assistant text is buffered here and the next result resolves the /usage request
	private usageRequest: { callback: (text: string) => void; buffer: string } | null = null;
	private usageStats: SessionUsageStats = {
		requestCount: 0,
		totalCostUSD: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheCreationTokens: 0,
		modelUsage: {},
	};

	constructor(events: AgentEvents) {
		this.events = events;
	}

	getSessionId(): string | null { return this.sessionId; }
	getUsageStats(): SessionUsageStats { return this.usageStats; }
	getCurrentModel(): string | null { return this.currentModel; }
	isRunning(): boolean { return this.running; }

	async start(cwd: string, claudePath?: string, resumeSessionId?: string, configDir?: string, model?: string): Promise<void> {
		this.abortController = new AbortController();
		this.running = true;
		// The init message (which carries the resolved model) only arrives once the
		// first user message is sent, so seed from the model we're starting with
		this.currentModel = model ?? null;

		try {
			this.queryInstance = query({
				prompt: this.messageStream(),
				options: this.buildOptions(cwd, claudePath, resumeSessionId, configDir, model),
			});

			// Fetch available skills and models after initialization
			this.loadSkills();
			this.loadModels();

			for await (const message of this.queryInstance) {
				this.handleMessage(message);
			}
		} catch (err: unknown) {
			const error = err as { name?: string; message?: string };
			if (error.name !== "AbortError") {
				this.events?.onError(error.message || "Unknown error");
			}
		} finally {
			this.running = false;
		}
	}

	sendMessage(text: string): void {
		this.messageQueue.push({
			type: "user",
			session_id: "",
			message: {
				role: "user",
				content: [{ type: "text", text }],
			},
			parent_tool_use_id: null,
		} as SDKUserMessage);
		if (this.messageResolve) {
			this.messageResolve();
			this.messageResolve = null;
		}
	}

	/** Ask the CLI for usage stats; `callback` receives the markdown response. */
	requestUsage(callback: (text: string) => void): void {
		this.usageRequest = { callback, buffer: "" };
		this.sendMessage("/usage");
	}

	async setModel(model: string): Promise<void> {
		if (!this.queryInstance) throw new Error("Agent not running");
		await this.queryInstance.setModel(model);
		this.currentModel = model;
	}

	/** Stop delivering events (e.g. before this manager is replaced). */
	detach(): void {
		this.events = null;
		this.usageRequest = null;
		this.sessionId = null;
	}

	stop(): void {
		this.abortController?.abort();
		this.running = false;
	}

	async getMcpServerStatus(): Promise<McpServerStatus[]> {
		if (!this.queryInstance) return [];
		return this.queryInstance.mcpServerStatus();
	}

	async toggleMcpServer(name: string, enabled: boolean): Promise<void> {
		if (!this.queryInstance) return;
		await this.queryInstance.toggleMcpServer(name, enabled);
	}

	// --- Internals ---

	private buildOptions(cwd: string, claudePath?: string, resumeSessionId?: string, configDir?: string, model?: string): QueryOptions {
		const env = (claudePath || configDir)
			? {
				...process.env,
				...(claudePath ? { PATH: `${dirname(claudePath)}:${process.env.PATH}` } : {}),
				...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
			}
			: undefined;

		const options: Record<string, unknown> = {
			abortController: this.abortController,
			cwd,
			env,
			pathToClaudeCodeExecutable: claudePath || undefined,
			permissionMode: "default" as const,
			// Load project and user settings to get project-specific skills/plugins
			settingSources: ["user", "project", "local"] as const,
			...(model ? { model } : {}),
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			canUseTool: async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
				if (this.events) {
					return this.events.onPermission(toolName, input);
				}
				return { behavior: "allow" as const, updatedInput: input };
			},
		};
		return options as QueryOptions;
	}

	// Async iterable of user messages, fed by sendMessage()
	private async *messageStream(): AsyncGenerator<SDKUserMessage> {
		while (true) {
			while (this.messageQueue.length > 0) {
				yield this.messageQueue.shift()!;
			}
			await new Promise<void>((resolve) => {
				this.messageResolve = resolve;
			});
		}
	}

	private handleMessage(message: SDKMessage) {
		// Capture session_id from the first message that has one
		const sessionId = (message as { session_id?: string }).session_id;
		if (!this.sessionId && sessionId) {
			this.sessionId = sessionId;
			this.events?.onSessionId(sessionId);
		}

		// Capture active model from the init message; re-notify so the
		// UI selector reflects the actual model once known
		if (message.type === "system" && "subtype" in message && message.subtype === "init" && "model" in message) {
			this.currentModel = (message as { model: string }).model;
			if (this.availableModels.length > 0) {
				this.events?.onModels(this.availableModels, this.currentModel);
			}
		}

		if (message.type === "result" && !message.is_error) {
			this.accumulateUsage(message);
			if (this.usageRequest) {
				this.usageRequest.callback(this.usageRequest.buffer);
				this.usageRequest = null;
				return;
			}
		}

		// A /usage request is in flight — buffer assistant text instead of routing to the UI
		if (this.usageRequest) {
			for (const block of assistantBlocks(message) ?? []) {
				if (block.type === "text" && block.text) {
					this.usageRequest.buffer += block.text;
				}
			}
			return;
		}

		this.events?.onMessage(message);
	}

	private accumulateUsage(message: SDKMessage) {
		// usage fields follow BetaUsage (snake_case from Anthropic API)
		const result = message as unknown as {
			total_cost_usd: number;
			usage: Record<string, number>;
			modelUsage: Record<string, ModelUsage>;
		};
		this.usageStats.requestCount++;
		this.usageStats.totalCostUSD += result.total_cost_usd ?? 0;
		this.usageStats.totalInputTokens += result.usage?.input_tokens ?? 0;
		this.usageStats.totalOutputTokens += result.usage?.output_tokens ?? 0;
		this.usageStats.totalCacheReadTokens += result.usage?.cache_read_input_tokens ?? 0;
		this.usageStats.totalCacheCreationTokens += result.usage?.cache_creation_input_tokens ?? 0;

		for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
			const existing = this.usageStats.modelUsage[model];
			if (existing) {
				existing.inputTokens += usage.inputTokens;
				existing.outputTokens += usage.outputTokens;
				existing.cacheReadInputTokens += usage.cacheReadInputTokens;
				existing.cacheCreationInputTokens += usage.cacheCreationInputTokens;
				existing.webSearchRequests += usage.webSearchRequests;
				existing.costUSD += usage.costUSD;
			} else {
				this.usageStats.modelUsage[model] = { ...usage };
			}
		}
	}

	private async loadSkills(): Promise<void> {
		if (!this.queryInstance) return;
		try {
			const skills = await this.queryInstance.supportedCommands();
			this.events?.onSkills(skills);
		} catch (err) {
			console.error("Failed to load skills:", err);
		}
	}

	private async loadModels(): Promise<void> {
		if (!this.queryInstance) return;
		try {
			this.availableModels = await this.queryInstance.supportedModels();
			this.events?.onModels(this.availableModels, this.currentModel);
		} catch (err) {
			console.error("Failed to load models:", err);
		}
	}
}
