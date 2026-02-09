import {
	StreamMessage,
	AssistantMessage,
	UserMessage,
	ResultMessage,
	SystemMessage,
	ContentBlock,
} from "./types";

export type ParsedMessageCallback = (message: StreamMessage) => void;
export type ParseErrorCallback = (error: Error, rawLine: string) => void;

/**
 * Parses newline-delimited JSON stream from Claude Code CLI.
 * Handles buffering of partial lines and validates message structure.
 */
export class StreamParser {
	private buffer = "";
	private onMessage: ParsedMessageCallback | null = null;
	private onError: ParseErrorCallback | null = null;

	/**
	 * Set callback for successfully parsed messages.
	 */
	setMessageHandler(callback: ParsedMessageCallback): void {
		this.onMessage = callback;
	}

	/**
	 * Set callback for parse errors.
	 */
	setErrorHandler(callback: ParseErrorCallback): void {
		this.onError = callback;
	}

	/**
	 * Feed raw data from stdout into the parser.
	 * Handles buffering of incomplete lines.
	 */
	feed(data: string): void {
		this.buffer += data;
		const lines = this.buffer.split("\n");
		// Keep the last incomplete line in the buffer
		this.buffer = lines.pop() || "";

		for (const line of lines) {
			if (line.trim()) {
				this.parseLine(line);
			}
		}
	}

	/**
	 * Parse a single JSON line and emit the appropriate message.
	 */
	private parseLine(line: string): void {
		try {
			const parsed = JSON.parse(line);
			const message = this.validateAndCast(parsed);
			if (message) {
				this.onMessage?.(message);
			}
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e));
			this.onError?.(error, line);
		}
	}

	/**
	 * Validate the parsed JSON and cast to the appropriate message type.
	 */
	private validateAndCast(obj: unknown): StreamMessage | null {
		if (!obj || typeof obj !== "object") {
			return null;
		}

		const record = obj as Record<string, unknown>;

		switch (record.type) {
			case "assistant":
				return this.validateAssistantMessage(record);
			case "user":
				return this.validateUserMessage(record);
			case "result":
				return this.validateResultMessage(record);
			case "system":
				return this.validateSystemMessage(record);
			default:
				return null;
		}
	}

	private validateAssistantMessage(obj: Record<string, unknown>): AssistantMessage | null {
		const message = obj.message as Record<string, unknown> | undefined;
		if (!message || !Array.isArray(message.content)) {
			return null;
		}

		return {
			type: "assistant",
			message: {
				content: this.validateContentBlocks(message.content),
			},
		};
	}

	private validateUserMessage(obj: Record<string, unknown>): UserMessage | null {
		const message = obj.message as Record<string, unknown> | undefined;
		if (!message || !Array.isArray(message.content)) {
			return null;
		}

		return {
			type: "user",
			message: {
				content: this.validateContentBlocks(message.content),
			},
		};
	}

	private validateResultMessage(obj: Record<string, unknown>): ResultMessage | null {
		if (typeof obj.result !== "string") {
			return null;
		}

		return {
			type: "result",
			result: obj.result,
			cost_usd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
			session_id: typeof obj.session_id === "string" ? obj.session_id : undefined,
		};
	}

	private validateSystemMessage(obj: Record<string, unknown>): SystemMessage | null {
		return {
			type: "system",
			subtype: obj.subtype === "init" ? "init" : undefined,
			message: typeof obj.message === "string" ? obj.message : undefined,
			session_id: typeof obj.session_id === "string" ? obj.session_id : undefined,
		};
	}

	private validateContentBlocks(blocks: unknown[]): ContentBlock[] {
		return blocks
			.filter((block): block is Record<string, unknown> => {
				return block !== null && typeof block === "object";
			})
			.map((block) => this.validateContentBlock(block))
			.filter((block): block is ContentBlock => block !== null);
	}

	private validateContentBlock(block: Record<string, unknown>): ContentBlock | null {
		const type = block.type;

		if (type === "text") {
			return {
				type: "text",
				text: typeof block.text === "string" ? block.text : "",
			};
		}

		if (type === "tool_use") {
			return {
				type: "tool_use",
				id: typeof block.id === "string" ? block.id : undefined,
				name: typeof block.name === "string" ? block.name : "",
				input: typeof block.input === "object" ? (block.input as Record<string, unknown>) : {},
			};
		}

		if (type === "tool_result") {
			return {
				type: "tool_result",
				tool_use_id: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
				content: typeof block.content === "string" ? block.content : "",
			};
		}

		return null;
	}

	/**
	 * Reset the parser state (clear buffer).
	 */
	reset(): void {
		this.buffer = "";
	}
}
