import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { StreamMessage } from "./types";
import { StreamParser } from "./StreamParser";

export type MessageCallback = (message: StreamMessage) => void;
export type ErrorCallback = (error: string) => void;

export class ClaudeProcess {
	private process: ChildProcess | null = null;
	private parser: StreamParser;
	private messageCallback: MessageCallback | null = null;
	private errorCallback: ErrorCallback | null = null;
	private claudePath: string = "";
	private cwd: string = "";
	private conversationId: string | null = null;

	constructor() {
		this.parser = new StreamParser();
	}

	start(claudePath: string, cwd: string): void {
		this.claudePath = claudePath;
		this.cwd = cwd;

		if (!claudePath) {
			throw new Error("Claude path not configured. Please set it in plugin settings.");
		}

		// Set up message handler on parser
		this.parser.setMessageHandler((msg) => {
			// Extract session_id for conversation continuity
			if ((msg.type === "system" || msg.type === "result") && msg.session_id) {
				this.conversationId = msg.session_id;
			}
			this.messageCallback?.(msg);
		});
	}

	sendMessage(text: string): void {
		if (!this.claudePath) {
			return;
		}

		// Kill any existing process
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}

		// Reset parser for new response
		this.parser.reset();

		// Add the directory containing claude to PATH (needed for nvm-installed node)
		const claudeDir = path.dirname(this.claudePath);
		const env = {
			...process.env,
			PATH: `${claudeDir}:${process.env.PATH || ""}`,
		};

		// Build args - use -p for print mode with the message
		// --verbose is required when using -p with --output-format stream-json
		const args = ["--output-format", "stream-json", "--verbose", "-p", text];

		// If we have a conversation ID, resume that conversation
		if (this.conversationId) {
			args.push("--resume", this.conversationId);
		}

		this.process = spawn(this.claudePath, args, {
			cwd: this.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Close stdin immediately since we're using -p with the message as an argument
		this.process.stdin?.end();

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.parser.feed(chunk.toString());
		});

		this.process.on("error", (err) => {
			this.errorCallback?.(err.message);
		});

		this.process.on("close", () => {
			this.process = null;
		});
	}

	onMessage(callback: MessageCallback): void {
		this.messageCallback = callback;
	}

	onError(callback: ErrorCallback): void {
		this.errorCallback = callback;
	}

	isRunning(): boolean {
		return this.process !== null;
	}

	stop(): void {
		if (this.process) {
			this.process.kill("SIGTERM");
			this.process = null;
		}
		this.parser.reset();
		this.conversationId = null;
	}
}
