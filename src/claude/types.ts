export interface ContentBlock {
	type: "text" | "tool_use" | "tool_result";
	text?: string;
	// tool_use fields
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	// tool_result fields
	tool_use_id?: string;
	content?: string;
}

export interface AssistantMessage {
	type: "assistant";
	message: {
		content: ContentBlock[];
	};
}

export interface UserMessage {
	type: "user";
	message: {
		content: ContentBlock[];
	};
}

export interface ResultMessage {
	type: "result";
	result: string;
	cost_usd: number;
	session_id?: string;
}

export interface SystemMessage {
	type: "system";
	subtype?: "init";
	message?: string;
	session_id?: string;
}

export type StreamMessage = AssistantMessage | UserMessage | ResultMessage | SystemMessage;
