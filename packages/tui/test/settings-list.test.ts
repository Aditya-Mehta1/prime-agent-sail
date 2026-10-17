import assert from "node:assert/strict";
import test from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";
import { getKeybindings } from "../src/keybindings.js";

const theme: SettingsListTheme = { label: String, value: String, description: String, cursor: "> ", hint: String };
const noop = (): void => {};
const items = [{ id: "a", label: "Alpha", currentValue: "on" }];
const list = new SettingsList(items, 5, theme, noop, noop);
const searchList = new SettingsList(items, 5, theme, noop, noop, { enableSearch: true });

test("settings hint shows the configured confirm and cancel keys", () => {
	const keybindings = getKeybindings();
	const previous = keybindings.getUserBindings();
	try {
		assert.equal(list.render(80).at(-1), "  Enter/Space to change · Esc/Ctrl+C to cancel");
		keybindings.setUserBindings({ "tui.select.confirm": "ctrl+o", "tui.select.cancel": "q" });
		assert.equal(searchList.render(80).at(-1), "  Type to search · Ctrl+O/Space to change · Q to cancel");
	} finally {
		keybindings.setUserBindings(previous);
	}
});
