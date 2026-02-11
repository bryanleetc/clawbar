import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import type { Message, SessionMeta } from "./claude/types";

const MAX_SESSIONS = 10;

export class ConversationStore {
	private sessionsDir: string;
	private index: SessionMeta[] = [];
	private loadPluginData: () => Promise<any>;
	private savePluginData: (data: any) => Promise<void>;

	constructor(
		pluginDir: string,
		loadData: () => Promise<any>,
		saveData: (data: any) => Promise<void>,
	) {
		this.sessionsDir = join(pluginDir, "sessions");
		this.loadPluginData = loadData;
		this.savePluginData = saveData;
	}

	async initialize(): Promise<void> {
		if (!existsSync(this.sessionsDir)) {
			mkdirSync(this.sessionsDir, { recursive: true });
		}
		const data = await this.loadPluginData();
		this.index = data?.sessionIndex ?? [];
	}

	getIndex(): SessionMeta[] {
		return [...this.index];
	}

	async saveSession(sessionId: string, messages: Message[]): Promise<void> {
		if (!sessionId || messages.length === 0) return;

		const title = this.deriveTitleFromMessages(messages);
		const now = Date.now();

		const existingIdx = this.index.findIndex(s => s.sessionId === sessionId);
		const meta: SessionMeta = {
			sessionId,
			title,
			createdAt: existingIdx >= 0 ? this.index[existingIdx].createdAt : now,
			updatedAt: now,
			messageCount: messages.length,
		};

		if (existingIdx >= 0) {
			this.index[existingIdx] = meta;
		} else {
			this.index.unshift(meta);
		}

		// Prune oldest sessions beyond the cap
		while (this.index.length > MAX_SESSIONS) {
			const removed = this.index.pop()!;
			this.deleteSessionFile(removed.sessionId);
		}

		// Write message file
		const filePath = join(this.sessionsDir, `${sessionId}.json`);
		writeFileSync(filePath, JSON.stringify({ sessionId, messages }), "utf-8");

		await this.persistIndex();
	}

	loadSession(sessionId: string): Message[] | null {
		const filePath = join(this.sessionsDir, `${sessionId}.json`);
		try {
			const raw = readFileSync(filePath, "utf-8");
			const parsed = JSON.parse(raw);
			return parsed.messages;
		} catch {
			return null;
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.index = this.index.filter(s => s.sessionId !== sessionId);
		this.deleteSessionFile(sessionId);
		await this.persistIndex();
	}

	private deleteSessionFile(sessionId: string): void {
		const filePath = join(this.sessionsDir, `${sessionId}.json`);
		try { unlinkSync(filePath); } catch { /* ignore */ }
	}

	private async persistIndex(): Promise<void> {
		const data = (await this.loadPluginData()) || {};
		data.sessionIndex = this.index;
		await this.savePluginData(data);
	}

	private deriveTitleFromMessages(messages: Message[]): string {
		const firstUser = messages.find(m => m.role === "user");
		if (!firstUser) return "New conversation";
		const textBlock = firstUser.blocks.find(b => b.type === "text" && b.text);
		const raw = textBlock?.text ?? "New conversation";
		// Strip [Active file: ...] context prefix and optional code block
		const cleaned = raw.replace(/^\[Active file:.*?\]\n(?:```[\s\S]*?```\n\n)?/m, "").trim();
		return cleaned.length > 60 ? cleaned.substring(0, 57) + "..." : cleaned;
	}
}
