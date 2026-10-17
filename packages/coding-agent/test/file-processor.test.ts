import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.js";

it("reports a directory attachment as an expected-file error", async () => {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((message) => void errors.push(String(message)));
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`exit ${code}`);
	}) as typeof process.exit);
	const dir = fileURLToPath(new URL("../src/cli", import.meta.url));
	await expect(processFileArguments([dir])).rejects.toThrow("exit 1");
	expect(errors.join("\n")).toContain(`Expected a file, got a directory: ${dir}`);
	vi.restoreAllMocks();
});
