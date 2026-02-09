export interface SlashCommandDef {
	name: string;
	description: string;
	argumentHint?: string;
	isSkill?: boolean; // True if this is a Claude skill
}

// Built-in slash commands (not skills)
export const SLASH_COMMANDS: SlashCommandDef[] = [
	{ name: "clear", description: "Clear conversation history" },
	{ name: "reset", description: "Reset the conversation" },
	{ name: "tasks", description: "Show active tasks" },
];
