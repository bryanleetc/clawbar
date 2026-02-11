import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SlashCommand, ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { dirname } from "path";
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

export type MessageCallback = (message: SDKMessage) => void;
export type ErrorCallback = (error: string) => void;
export type PermissionCallback = (toolName: string, toolInput: unknown) => Promise<PermissionResult>;
export type SkillsCallback = (skills: SlashCommand[]) => void;
export type SessionIdCallback = (sessionId: string) => void;

export class AgentManager {
	private messageCallback: MessageCallback | null = null;
	private errorCallback: ErrorCallback | null = null;
	private permissionCallback: PermissionCallback | null = null;
	private skillsCallback: SkillsCallback | null = null;
	private sessionIdCallback: SessionIdCallback | null = null;
	private abortController: AbortController | null = null;
	private messageQueue: SDKUserMessage[] = [];
	private messageResolve: (() => void) | null = null;
	private running = false;
	private queryInstance: Query | null = null;
	private sessionId: string | null = null;
	// When set, the next assistant+result sequence is routed here instead of messageCallback
	private usageRequestCallback: ((text: string) => void) | null = null;
	private usageTextBuffer = "";
	private usageStats: SessionUsageStats = {
		requestCount: 0,
		totalCostUSD: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheCreationTokens: 0,
		modelUsage: {},
	};

	onMessage(cb: MessageCallback): void { this.messageCallback = cb; }
	onError(cb: ErrorCallback): void { this.errorCallback = cb; }
	onPermission(cb: PermissionCallback): void { this.permissionCallback = cb; }
	onSkills(cb: SkillsCallback): void { this.skillsCallback = cb; }
	onSessionId(cb: SessionIdCallback): void { this.sessionIdCallback = cb; }

	getSessionId(): string | null { return this.sessionId; }
	getUsageStats(): SessionUsageStats { return this.usageStats; }

	// Create an async iterable that yields user messages as they arrive
	private createMessageStream(): AsyncIterable<SDKUserMessage> {
		const self = this;
		return {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<SDKUserMessage>> {
						while (self.messageQueue.length === 0) {
							await new Promise<void>(resolve => {
								self.messageResolve = resolve;
							});
						}
						return { value: self.messageQueue.shift()!, done: false };
					}
				};
			}
		};
	}

	async start(cwd: string, claudePath?: string, resumeSessionId?: string): Promise<void> {
		this.abortController = new AbortController();
		this.running = true;

		const env = claudePath
			? { ...process.env, PATH: `${dirname(claudePath)}:${process.env.PATH}` }
			: undefined;

		const options: Record<string, unknown> = {
			abortController: this.abortController,
			cwd,
			env,
			pathToClaudeCodeExecutable: claudePath || undefined,
			permissionMode: "default" as const,
			// Load project and user settings to get project-specific skills/plugins
			settingSources: ["user", "project", "local"] as const,
			...(resumeSessionId ? { resume: resumeSessionId } : {}),
			canUseTool: async (
				toolName: string,
				input: Record<string, unknown>,
				opts: { signal: AbortSignal }
			): Promise<PermissionResult> => {
				if (this.permissionCallback) {
					return this.permissionCallback(toolName, input);
				}
				return { behavior: "allow" as const, updatedInput: input };
			},
		};

		try {
			this.queryInstance = query({
				prompt: this.createMessageStream(),
				options: options as Parameters<typeof query>[0]["options"],
			});

			// Fetch available skills after initialization
			this.loadSkills();

			for await (const message of this.queryInstance) {
				// Capture session_id from the first message that has one
				if (!this.sessionId && 'session_id' in message && (message as any).session_id) {
					const id: string = (message as any).session_id;
					this.sessionId = id;
					this.sessionIdCallback?.(id);
				}

				if (message.type === "result" && !message.is_error) {
					// usage fields follow BetaUsage (snake_case from Anthropic API)
					const result = message as unknown as { total_cost_usd: number; usage: Record<string, number>; modelUsage: Record<string, ModelUsage> };
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

					// Resolve pending usage request
					if (this.usageRequestCallback) {
						this.usageRequestCallback(this.usageTextBuffer);
						this.usageRequestCallback = null;
						this.usageTextBuffer = "";
						continue;
					}
				}

				// If a usage request is in flight, capture assistant text and suppress normal routing
				if (this.usageRequestCallback) {
					if (message.type === "assistant" && "message" in message) {
						const blocks = (message as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
						for (const block of blocks) {
							if (block.type === "text" && block.text) {
								this.usageTextBuffer += block.text;
							}
						}
					}
					continue;
				}

				this.messageCallback?.(message);
			}
		} catch (err: unknown) {
			const error = err as { name?: string; message?: string };
			if (error.name !== "AbortError") {
				this.errorCallback?.(error.message || "Unknown error");
			}
		} finally {
			this.running = false;
		}
	}

	private async loadSkills(): Promise<void> {
		if (!this.queryInstance || !this.skillsCallback) return;

		try {
			const skills = await this.queryInstance.supportedCommands();
			this.skillsCallback(skills);
		} catch (err) {
			console.error("Failed to load skills:", err);
		}
	}

	requestUsage(callback: (text: string) => void): void {
		this.usageRequestCallback = callback;
		this.usageTextBuffer = "";
		this.sendMessage("/usage");
	}

	sendMessage(text: string): void {
		const msg: SDKUserMessage = {
			type: "user",
			session_id: "",
			message: {
				role: "user",
				content: [{ type: "text", text }],
			},
			parent_tool_use_id: null,
		} as SDKUserMessage;
		this.messageQueue.push(msg);
		if (this.messageResolve) {
			this.messageResolve();
			this.messageResolve = null;
		}
	}

	detach(): void {
		this.messageCallback = null;
		this.errorCallback = null;
		this.permissionCallback = null;
		this.skillsCallback = null;
		this.sessionIdCallback = null;
		this.usageRequestCallback = null;
		this.sessionId = null;
	}

	stop(): void {
		this.abortController?.abort();
		this.running = false;
	}

	isRunning(): boolean { return this.running; }
}
