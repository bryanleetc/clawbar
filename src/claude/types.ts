import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Re-export SDK types
export type {
	SDKMessage,
	SDKAssistantMessage,
	SDKUserMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKPartialAssistantMessage,
	PermissionResult,
	SlashCommand,
	ModelInfo,
} from "@anthropic-ai/claude-agent-sdk";

// ContentBlock stays the same shape — it's what's inside message.content
export interface ContentBlock {
	type: "text" | "tool_use" | "tool_result";
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	// tool_result content can be a string OR an array of content blocks
	content?: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

// Unified message shape used by ChatView and ConversationStore
export interface Message {
	role: "user" | "assistant" | "tool";
	blocks: ContentBlock[];
	toolName?: string;
	toolId?: string;
	toolResult?: string;
	isThinking?: boolean;
}

// Metadata for a saved conversation session (stored in data.json index)
export interface SessionMeta {
	sessionId: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
}

// --- SDK message helpers ---
// The SDK types don't narrow cleanly, so the casts live here instead of at call sites.

/** True for messages replayed by the SDK during session resume. */
export function isReplay(msg: SDKMessage): boolean {
	return "isReplay" in msg && (msg as { isReplay?: boolean }).isReplay === true;
}

/** Content blocks of an assistant message, or null if `msg` is not one. */
export function assistantBlocks(msg: SDKMessage): ContentBlock[] | null {
	if (msg.type !== "assistant" || !("message" in msg)) return null;
	return (msg as unknown as { message: { content: ContentBlock[] } }).message.content;
}

/** tool_result blocks carried by a user message (empty for anything else). */
export function toolResultBlocks(msg: SDKMessage): ContentBlock[] {
	if (msg.type !== "user" || !("message" in msg)) return [];
	const content = (msg as unknown as { message: { content: unknown } }).message.content;
	if (!Array.isArray(content)) return [];
	return content.filter((b): b is ContentBlock => b?.type === "tool_result");
}

/** Flatten tool_result content (string or block array) to plain text. */
export function toolResultText(content: ContentBlock["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
	}
	return JSON.stringify(content);
}
