import assert from "node:assert";
import test from "node:test";
import { filterSettingsItems } from "../src/components/settings-list.js";

const items = [
	{ id: "theme", label: "Theme", description: "Color theme for the interface", currentValue: "dark" },
	{ id: "colors", label: "Interface colors", description: "Pick the color theme", currentValue: "dark" },
];
const ids = (query: string) => filterSettingsItems(items, query).map((item) => item.id);
test("settings search matches descriptions without outranking label matches", () => {
	assert.deepStrictEqual(ids("pick"), ["colors"]);
	assert.deepStrictEqual(ids("theme"), ["theme", "colors"]);
});
