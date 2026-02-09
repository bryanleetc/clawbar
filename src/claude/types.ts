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
