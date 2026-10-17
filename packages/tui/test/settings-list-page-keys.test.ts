import { deepEqual } from "node:assert/strict";
import { it } from "node:test";
import { SettingsList } from "../src/components/settings-list.js";

const text = (value: string) => value;
const noop = () => {};
const theme = { label: text, value: text, description: text, cursor: ">", hint: text };
const down = "\x1b[6~";
const up = "\x1b[5~";
const selectedId = (keys: string[]) => {
	const items = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, currentValue: "", values: ["x"] }));
	const list = new SettingsList(items, 2, theme, noop, noop);
	for (const key of [...keys, "\r"]) list.handleInput(key);
	return items.find((item) => item.currentValue === "x")?.id;
};
it("pages the selection", () => deepEqual([[down], [down, down, down], [down, up]].map(selectedId), ["c", "e", "a"]));
