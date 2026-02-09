import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { dirname } from "path";
import type { SDKMessage, SDKUserMessage, PermissionResult } from "./types";

export type MessageCallback = (message: SDKMessage) => void;
export type ErrorCallback = (error: string) => void;
export type PermissionCallback = (toolName: string, toolInput: unknown) => Promise<PermissionResult>;
export type SkillsCallback = (skills: SlashCommand[]) => void;

export class AgentManager {
	private messageCallback: MessageCallback | null = null;
	private errorCallback: ErrorCallback | null = null;
	private permissionCallback: PermissionCallback | null = null;
	private skillsCallback: SkillsCallback | null = null;
	private abortController: AbortController | null = null;
	private messageQueue: SDKUserMessage[] = [];
	private messageResolve: (() => void) | null = null;
	private running = false;
	private queryInstance: Query | null = null;

	onMessage(cb: MessageCallback): void { this.messageCallback = cb; }
	onError(cb: ErrorCallback): void { this.errorCallback = cb; }
	onPermission(cb: PermissionCallback): void { this.permissionCallback = cb; }
	onSkills(cb: SkillsCallback): void { this.skillsCallback = cb; }

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

	async start(cwd: string, claudePath?: string): Promise<void> {
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

	stop(): void {
		this.abortController?.abort();
		this.running = false;
	}

	isRunning(): boolean { return this.running; }
}
