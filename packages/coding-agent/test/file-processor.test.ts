import { expect, it } from "vitest";
import { accessErrorMessage } from "../src/cli/file-processor.js";

it("reports a blocked attachment as permission denied instead of missing", () => {
	expect(accessErrorMessage({ code: "EACCES" }, "/a.png")).toBe("Error: Permission denied: /a.png");
	expect(accessErrorMessage({ code: "ENOENT" }, "/a.png")).toBe("Error: File not found: /a.png");
});
