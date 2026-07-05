import { describe, it, expect, beforeEach } from "vitest";
import { patchObsidianDom } from "./__mocks__/obsidian-dom";

// Patch DOM before importing modules that use Obsidian's DOM helpers
patchObsidianDom();

import { PromptManager } from "./PromptManager";

describe("PromptManager", () => {
	let container: HTMLElement;
	let prompts: PromptManager;

	beforeEach(() => {
		container = document.createElement("div");
		prompts = new PromptManager(container);
	});

	it("renders a permission prompt for a tool request", async () => {
		prompts.request("Write", { path: "foo.md", content: "hello" });
		await Promise.resolve();

		expect(container.querySelector(".clawbar-permission-prompt")).not.toBeNull();
	});

	it("Allow button resolves promise with behavior: allow", async () => {
		const resultPromise = prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		const allowBtn = container.querySelector(".clawbar-permission-allow") as HTMLButtonElement;
		allowBtn.click();

		const result = await resultPromise;
		expect(result.behavior).toBe("allow");
		expect((result as { updatedInput: unknown }).updatedInput).toEqual({ path: "foo.md" });
	});

	it("Deny button resolves promise with behavior: deny", async () => {
		const resultPromise = prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		const denyBtn = container.querySelector(".clawbar-permission-deny") as HTMLButtonElement;
		denyBtn.click();

		const result = await resultPromise;
		expect(result.behavior).toBe("deny");
	});

	it("prompt is removed from DOM after Allow is clicked", async () => {
		const resultPromise = prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		(container.querySelector(".clawbar-permission-allow") as HTMLButtonElement).click();
		await resultPromise;

		expect(container.querySelector(".clawbar-permission-prompt")).toBeNull();
	});

	it("prompt is removed from DOM after Deny is clicked", async () => {
		const resultPromise = prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();

		(container.querySelector(".clawbar-permission-deny") as HTMLButtonElement).click();
		await resultPromise;

		expect(container.querySelector(".clawbar-permission-prompt")).toBeNull();
	});

	it("AskUserQuestion tool name routes to the question prompt", async () => {
		const input = {
			questions: [{
				question: "Pick one",
				header: "Choice",
				options: [{ label: "A", description: "Option A" }],
				multiSelect: false,
			}],
		};
		prompts.request("AskUserQuestion", input);
		await Promise.resolve();

		expect(container.querySelector(".clawbar-question-prompt")).not.toBeNull();
		expect(container.querySelector(".clawbar-permission-prompt")).toBeNull();
	});

	it("second prompt is not shown until first is answered", async () => {
		const p1 = prompts.request("Write", { path: "a.md" });
		const p2 = prompts.request("Bash", { command: "ls" });
		await Promise.resolve();

		// Only the first prompt should be in the DOM
		expect(container.querySelectorAll(".clawbar-permission-prompt").length).toBe(1);
		expect(container.querySelector(".clawbar-permission-prompt")!.textContent).toContain("Write");

		// Answer first prompt
		(container.querySelector(".clawbar-permission-allow") as HTMLButtonElement).click();
		await p1;
		// Let queue advance (two microtask hops: result.then → queue.then)
		await Promise.resolve();
		await Promise.resolve();

		// Now the second prompt should appear
		expect(container.querySelectorAll(".clawbar-permission-prompt").length).toBe(1);
		expect(container.querySelector(".clawbar-permission-prompt")!.textContent).toContain("Bash");

		// Answer second prompt to clean up
		(container.querySelector(".clawbar-permission-allow") as HTMLButtonElement).click();
		await p2;
	});

	it("reset clears pending prompts from the DOM", async () => {
		prompts.request("Write", { path: "foo.md" });
		await Promise.resolve();
		expect(container.querySelector(".clawbar-permission-prompt")).not.toBeNull();

		prompts.reset();
		expect(container.querySelector(".clawbar-permission-prompt")).toBeNull();
	});
});
