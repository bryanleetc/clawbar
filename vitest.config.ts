import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.ts"],
		globals: true,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "src/__mocks__/obsidian.ts"),
		},
	},
});
