// Re-export SDK types
export type {
	SDKMessage,
	SDKAssistantMessage,
	SDKUserMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKPartialAssistantMessage,
	PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

// ContentBlock stays the same shape — it's what's inside message.content
export interface ContentBlock {
	type: "text" | "tool_use" | "tool_result";
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string;
}
