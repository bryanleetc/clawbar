import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock fs so ConversationStore never touches disk
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const mocked = {
		...actual,
		existsSync: vi.fn(() => true),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		unlinkSync: vi.fn(),
	};
	return { ...mocked, default: mocked };
});

import * as fs from "fs";
import { ConversationStore } from "./ConversationStore";
import type { Message } from "./claude/types";

function makeStore(maxSessions: () => number) {
	const data: Record<string, any> = {};
	const loadData = async () => ({ ...data });
	const saveData = async (d: any) => { Object.assign(data, d); };
	return new ConversationStore("/fake/plugin", loadData, saveData, maxSessions);
}

function makeMessage(text: string): Message {
	return { role: "user", blocks: [{ type: "text", text }] };
}

describe("ConversationStore — maxSessions limit", () => {
	beforeEach(() => {
		vi.mocked(fs.writeFileSync).mockClear();
		vi.mocked(fs.unlinkSync).mockClear();
	});

	it("respects a limit of 3 — prunes oldest when a 4th session is added", async () => {
		const store = makeStore(() => 3);
		await store.initialize();

		await store.saveSession("s1", [makeMessage("first")]);
		await store.saveSession("s2", [makeMessage("second")]);
		await store.saveSession("s3", [makeMessage("third")]);
		await store.saveSession("s4", [makeMessage("fourth")]);

		const index = store.getIndex();
		expect(index).toHaveLength(3);
		expect(index.map(s => s.sessionId)).toEqual(["s4", "s3", "s2"]);
	});

	it("respects a limit of 1", async () => {
		const store = makeStore(() => 1);
		await store.initialize();

		await store.saveSession("s1", [makeMessage("a")]);
		await store.saveSession("s2", [makeMessage("b")]);

		const index = store.getIndex();
		expect(index).toHaveLength(1);
		expect(index[0].sessionId).toBe("s2");
	});

	it("uses the current value of maxSessions at save time (dynamic limit)", async () => {
		let limit = 5;
		const store = makeStore(() => limit);
		await store.initialize();

		for (let i = 1; i <= 5; i++) {
			await store.saveSession(`s${i}`, [makeMessage(`msg ${i}`)]);
		}
		expect(store.getIndex()).toHaveLength(5);

		// Lower the limit — next save should prune
		limit = 2;
		await store.saveSession("s6", [makeMessage("msg 6")]);

		const index = store.getIndex();
		expect(index).toHaveLength(2);
		expect(index.map(s => s.sessionId)).toEqual(["s6", "s5"]);
	});

	it("does not prune when sessions are within the limit", async () => {
		const store = makeStore(() => 10);
		await store.initialize();

		await store.saveSession("s1", [makeMessage("a")]);
		await store.saveSession("s2", [makeMessage("b")]);

		expect(store.getIndex()).toHaveLength(2);
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});
});
