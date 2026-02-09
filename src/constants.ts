export interface SlashCommandDef {
	name: string;
	description: string;
	argumentHint?: string;
}

// Built-in commands handled by Claude Code CLI (not skills)
export const BUILTIN_COMMANDS: SlashCommandDef[] = [
	{
		name: "help",
		description: "Get help with using Claude Code",
	},
	{
		name: "usage",
		description: "Show token usage statistics",
	},
	{
		name: "clear",
		description: "Clear the conversation",
	},
	{
		name: "tasks",
		description: "List running background tasks",
	},
	{
		name: "fast",
		description: "Toggle fast mode (faster output with same model)",
	},
	{
		name: "remember",
		description: "Save information for future conversations",
		argumentHint: "<fact>",
	},
	{
		name: "forget",
		description: "Remove remembered information",
		argumentHint: "<fact>",
	},
];
