import assert from "node:assert";
import { it } from "node:test";
import { SelectList, type SelectListNoMatchMessage } from "../src/components/select-list.js";
import { stripAnsi } from "../src/utils.js";
import { defaultSelectListTheme } from "./test-themes.js";

const renderEmpty = (noMatchMessage?: SelectListNoMatchMessage, filter = "", width = 40): string[] => {
	const list = new SelectList([], 3, defaultSelectListTheme, { noMatchMessage });
	list.setFilter(filter);
	return list.render(width).map(stripAnsi);
};
const filterMessage = (filter: string): string => `  No ${filter} matches`;
it("renders the empty-result message", () => {
	assert.deepStrictEqual(renderEmpty(), ["  No matching commands"]);
	assert.deepStrictEqual(renderEmpty("  No matching files"), ["  No matching files"]);
	assert.deepStrictEqual(renderEmpty(filterMessage, "file", 12), ["  No file ma"]);
});
