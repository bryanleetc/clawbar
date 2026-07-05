// Line-based diff computation and rendering for file-editing tool inputs
// (Edit, MultiEdit, Write). Used by ChatView in tool blocks and permission prompts.

export interface DiffLine {
	type: "add" | "remove" | "context";
	text: string;
}

// Guard against quadratic blowup on very large inputs
const MAX_LCS_CELLS = 250_000;
// Unchanged lines shown around each change when folding context
const CONTEXT_LINES = 3;

/**
 * Compute a line-based diff between two strings using LCS.
 * Falls back to a plain remove-all/add-all diff for very large inputs.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const n = oldLines.length;
	const m = newLines.length;

	if (n * m > MAX_LCS_CELLS) {
		return [
			...oldLines.map((text): DiffLine => ({ type: "remove", text })),
			...newLines.map((text): DiffLine => ({ type: "add", text })),
		];
	}

	// LCS length table
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	// Backtrack
	const lines: DiffLine[] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			lines.push({ type: "context", text: oldLines[i] });
			i++; j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			lines.push({ type: "remove", text: oldLines[i] });
			i++;
		} else {
			lines.push({ type: "add", text: newLines[j] });
			j++;
		}
	}
	while (i < n) lines.push({ type: "remove", text: oldLines[i++] });
	while (j < m) lines.push({ type: "add", text: newLines[j++] });
	return lines;
}

/** True if this tool call's input can be rendered as a diff view. */
export function hasDiffView(toolName: string | undefined, input: Record<string, unknown> | undefined): boolean {
	if (!input) return false;
	switch (toolName) {
		case "Edit":
			return typeof input.old_string === "string" && typeof input.new_string === "string";
		case "MultiEdit":
			return Array.isArray(input.edits);
		case "Write":
			return typeof input.content === "string";
		default:
			return false;
	}
}

/** Render a diff view for an Edit/MultiEdit/Write tool input into `container`. */
export function renderDiffView(container: HTMLElement, toolName: string | undefined, input: Record<string, unknown>): void {
	switch (toolName) {
		case "Edit":
			renderDiffLines(container, computeLineDiff(input.old_string as string, input.new_string as string));
			break;
		case "MultiEdit": {
			const edits = input.edits as Array<Record<string, unknown>>;
			for (const edit of edits) {
				if (typeof edit?.old_string !== "string" || typeof edit?.new_string !== "string") continue;
				renderDiffLines(container, computeLineDiff(edit.old_string, edit.new_string));
			}
			break;
		}
		case "Write": {
			// No previous content available — show the new file content as additions
			const lines = (input.content as string).split("\n")
				.map((text): DiffLine => ({ type: "add", text }));
			renderDiffLines(container, lines, false);
			break;
		}
	}
}

// Render diff lines, folding long runs of unchanged context down to
// CONTEXT_LINES around each change (with a "⋯" separator row).
function renderDiffLines(container: HTMLElement, lines: DiffLine[], foldContext = true) {
	const diffEl = container.createDiv({ cls: "clawbar-diff" });
	const visible = foldContext ? foldUnchanged(lines) : lines;

	for (const line of visible) {
		if (line === SKIP_MARKER) {
			diffEl.createDiv({ cls: "clawbar-diff-line clawbar-diff-skip", text: "⋯" });
			continue;
		}
		const lineEl = diffEl.createDiv({ cls: `clawbar-diff-line clawbar-diff-${line.type}` });
		const gutter = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
		lineEl.createSpan({ cls: "clawbar-diff-gutter", text: gutter });
		lineEl.createSpan({ cls: "clawbar-diff-text", text: line.text || " " });
	}
}

const SKIP_MARKER: DiffLine = { type: "context", text: "" };

function foldUnchanged(lines: DiffLine[]): DiffLine[] {
	const result: DiffLine[] = [];
	let run: DiffLine[] = [];

	const flush = (isEnd: boolean) => {
		const isStart = result.length === 0;
		// Keep CONTEXT_LINES on each side of the run that touches a change
		const keepHead = isStart ? 0 : CONTEXT_LINES;
		const keepTail = isEnd ? 0 : CONTEXT_LINES;
		if (run.length <= keepHead + keepTail + 1) {
			result.push(...run);
		} else {
			result.push(...run.slice(0, keepHead));
			result.push(SKIP_MARKER);
			result.push(...run.slice(run.length - keepTail));
		}
		run = [];
	};

	for (const line of lines) {
		if (line.type === "context") {
			run.push(line);
		} else {
			flush(false);
			result.push(line);
		}
	}
	flush(true);
	return result;
}
