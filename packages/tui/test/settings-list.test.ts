import assert from "node:assert";
import test from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";
import { type KeybindingsConfig, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";

const theme: SettingsListTheme = { label: String, value: String, description: String, cursor: "> ", hint: String };
const items = () => [{ id: "beta", label: "Beta", currentValue: "on", values: ["on", "off"] }];
function createList(bindings: KeybindingsConfig = {}, enableSearch = false) {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings));
	const changes: string[] = [];
	const onChange = (_id: string, value: string) => changes.push(value);
	const list = new SettingsList(items(), 5, theme, onChange, () => {}, { enableSearch });
	return { list, changes };
}
test("settings activation, hint, and search follow the configured keybinding", () => {
	const { list, changes } = createList();
	list.handleInput(" ");
	assert.deepStrictEqual(changes, ["off"]);
	const rebound = createList({ "tui.settings.activate": "ctrl+t" });
	rebound.list.handleInput(" ");
	assert.deepStrictEqual(rebound.changes, [], "space must not activate after rebinding");
	rebound.list.handleInput("\x14");
	assert.deepStrictEqual(rebound.changes, ["off"], "the rebound key activates");
	assert.ok(rebound.list.render(80).join("\n").includes("Enter/Ctrl+T to change"), "hint shows the rebound key");
	const unbound = createList({ "tui.settings.activate": [] }, true);
	unbound.list.handleInput("a b");
	assert.ok(unbound.list.render(80).join("\n").includes("Beta"), "unbound space searches settings text");
});
