import { describe, it, expect } from "vitest";
import { computeLineDiff, hasDiffView } from "./DiffView";

describe("computeLineDiff", () => {
	it("returns all context lines for identical text", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nb\nc");
		expect(diff).toEqual([
			{ type: "context", text: "a" },
			{ type: "context", text: "b" },
			{ type: "context", text: "c" },
		]);
	});

	it("detects a changed line as remove + add", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nX\nc");
		expect(diff).toEqual([
			{ type: "context", text: "a" },
			{ type: "remove", text: "b" },
			{ type: "add", text: "X" },
			{ type: "context", text: "c" },
		]);
	});

	it("detects inserted lines", () => {
		const diff = computeLineDiff("a\nc", "a\nb\nc");
		expect(diff).toEqual([
			{ type: "context", text: "a" },
			{ type: "add", text: "b" },
			{ type: "context", text: "c" },
		]);
	});

	it("detects removed lines", () => {
		const diff = computeLineDiff("a\nb\nc", "a\nc");
		expect(diff).toEqual([
			{ type: "context", text: "a" },
			{ type: "remove", text: "b" },
			{ type: "context", text: "c" },
		]);
	});

	it("handles fully different text", () => {
		const diff = computeLineDiff("a", "b");
		expect(diff).toEqual([
			{ type: "remove", text: "a" },
			{ type: "add", text: "b" },
		]);
	});

	it("handles empty old text (new file)", () => {
		const diff = computeLineDiff("", "a\nb");
		// Empty string splits to [""], which has no match in the new lines
		expect(diff.filter((l) => l.type === "add").map((l) => l.text)).toEqual(["a", "b"]);
	});

	it("falls back to remove-all/add-all on very large inputs", () => {
		const oldText = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
		const newText = Array.from({ length: 600 }, (_, i) => `line ${i} changed`).join("\n");
		const diff = computeLineDiff(oldText, newText);
		expect(diff).toHaveLength(1200);
		expect(diff.every((l) => l.type !== "context")).toBe(true);
	});
});

describe("hasDiffView", () => {
	it("accepts Edit with old_string and new_string", () => {
		expect(hasDiffView("Edit", { old_string: "a", new_string: "b" })).toBe(true);
	});

	it("rejects Edit missing new_string", () => {
		expect(hasDiffView("Edit", { old_string: "a" })).toBe(false);
	});

	it("accepts MultiEdit with edits array", () => {
		expect(hasDiffView("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }] })).toBe(true);
	});

	it("accepts Write with content", () => {
		expect(hasDiffView("Write", { content: "hello" })).toBe(true);
	});

	it("rejects other tools", () => {
		expect(hasDiffView("Bash", { command: "ls" })).toBe(false);
		expect(hasDiffView(undefined, { old_string: "a", new_string: "b" })).toBe(false);
	});
});
