import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.js";

const dir = mkdtempSync(join(tmpdir(), "file-processor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("file attachment markup", () => {
	it("escapes special characters in the name attribute", async () => {
		const path = join(dir, "a&b'c.txt");
		writeFileSync(path, "body");
		const { text } = await processFileArguments([path]);
		expect(text).toBe(`<file name="${join(dir, "a&amp;b&#39;c.txt")}">\nbody\n</file>\n`);
	});
});
