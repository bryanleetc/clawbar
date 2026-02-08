import { spawn, ChildProcess } from "child_process";
import { StreamMessage } from "./types";

export type MessageCallback = (message: StreamMessage) => void;
export type ErrorCallback = (error: string) => void;

export class ClaudeProcess {
	private process: ChildProcess | null = null;
	private buffer = "";
	private messageCallback: MessageCallback | null = null;
	private errorCallback: ErrorCallback | null = null;

	start(claudePath: string, cwd: string): void {
		if (this.process) {
			this.stop();
		}

		this.process = spawn(claudePath, ["--output-format", "stream-json", "--verbose"], {
			cwd,
			env: process.env,
			shell: true,
		});

		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.handleStdout(chunk.toString());
		});

		this.process.stderr?.on("data", (chunk: Buffer) => {
			const error = chunk.toString();
			console.error("[ClaudeProcess stderr]", error);
			this.errorCallback?.(error);
		});

		this.process.on("error", (err) => {
			console.error("[ClaudeProcess error]", err);
			this.errorCallback?.(err.message);
		});

		this.process.on("close", (code) => {
			console.log("[ClaudeProcess] Process exited with code:", code);
			this.process = null;
		});
	}

	private handleStdout(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			if (line.trim()) {
				try {
					const msg = JSON.parse(line) as StreamMessage;
					this.messageCallback?.(msg);
				} catch (e) {
					console.error("[ClaudeProcess] Failed to parse JSON:", line, e);
				}
			}
		}
	}

	sendMessage(text: string): void {
		if (!this.process?.stdin) {
			console.error("[ClaudeProcess] No process running");
			return;
		}
		this.process.stdin.write(text + "\n");
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
			this.process.stdin?.end();
			this.process.kill("SIGTERM");
			this.process = null;
			this.buffer = "";
		}
	}
}
