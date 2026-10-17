import assert from "node:assert/strict";
import { it } from "node:test";
import { SelectList } from "../src/index.js";
import { defaultSelectListTheme } from "./test-themes.js";

const items = Array.from({ length: 7 }, (_, index) => ({ value: `v${index}`, label: `v${index}` }));
it("pages the selection by the visible rows", () => {
	const list = new SelectList(items, 3, defaultSelectListTheme);
	for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);
	assert.strictEqual(list.getSelectedItem()?.value, "v3");
});
