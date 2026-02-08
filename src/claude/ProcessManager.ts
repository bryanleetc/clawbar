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
		this.parser.setErrorHandler((error, rawLine) => {
			console.error("[ClaudeProcess] Parse error:", error.message, "Line:", rawLine);
		});
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
			// It's available in system init messages and result messages
			if (msg.type === "system" && msg.session_id) {
				this.conversationId = msg.session_id;
				console.log("[ClaudeProcess] Captured session_id from system:", this.conversationId);
			} else if (msg.type === "result" && msg.session_id) {
				this.conversationId = msg.session_id;
				console.log("[ClaudeProcess] Captured session_id from result:", this.conversationId);
			}
			this.messageCallback?.(msg);
		});

		console.log("[ClaudeProcess] Initialized with path:", claudePath, "cwd:", cwd);
	}

	sendMessage(text: string): void {
		if (!this.claudePath) {
			console.error("[ClaudeProcess] Not initialized");
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

		console.log("[ClaudeProcess] Spawning with args:", args);
		console.log("[ClaudeProcess] CWD:", this.cwd);

		this.process = spawn(this.claudePath, args, {
			cwd: this.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		console.log("[ClaudeProcess] Process spawned, pid:", this.process.pid);

		// Close stdin immediately since we're using -p with the message as an argument
		this.process.stdin?.end();

		this.process.stdout?.on("data", (chunk: Buffer) => {
			const data = chunk.toString();
			console.log("[ClaudeProcess] Raw stdout:", data.substring(0, 500));
			this.parser.feed(data);
		});

		this.process.stderr?.on("data", (chunk: Buffer) => {
			const data = chunk.toString();
			console.log("[ClaudeProcess] stderr:", data);
		});

		this.process.on("spawn", () => {
			console.log("[ClaudeProcess] Process spawn event fired");
		});

		this.process.on("error", (err) => {
			console.error("[ClaudeProcess] Process error:", err);
			this.errorCallback?.(err.message);
		});

		this.process.on("close", (code) => {
			console.log("[ClaudeProcess] Process exited with code:", code);
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
