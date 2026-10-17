import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDispatchProject, loadDispatchBinding } from "../src/core/dispatch/workspace.js";

describe("dispatch workspace", () => {
	it.each([
		["git@github.com:fixture/my-project.git", "my-project"],
		["ssh://git@github.com/fixture/project.tools.git", "project.tools"],
		["https://user:fixture-secret@github.com/fixture/my-project.git", "my-project"],
	])("resolves a credential-free GitHub origin and relative cwd from %s", async (origin, name) => {
		const directory = await mkdtemp(join(tmpdir(), "dispatch-snapshot-"));
		const repo = join(directory, "repo");
		await mkdir(repo);
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		try {
			git("init", "-q");
			git("config", "user.name", "Fixture O'Example");
			git("config", "user.email", "fixture@localhost");
			await writeFile(join(repo, "tracked"), "initial");
			await mkdir(join(repo, "sub"));
			git("add", "tracked");
			git("commit", "-qm", "base");
			git("remote", "add", "origin", origin);
			await writeFile(join(repo, "tracked"), "staged");
			git("add", "tracked");
			await writeFile(join(repo, "tracked"), "working tree");
			await writeFile(join(repo, "new file\nname"), "new");
			const before = git("status", "--porcelain=v1");
			const index = await readFile(join(repo, ".git", "index"));
			const metadata = await getDispatchProject(join(repo, "sub"));
			expect(metadata.cwdRelative).toBe("sub");
			expect(metadata.origin).toBe(`https://github.com/fixture/${name}.git`);
			expect(metadata.guestRepoDir).toBe(`/workspace/${name}`);
			expect(metadata.userName).toBe("Fixture O'Example");
			expect(metadata.userEmail).toBe("fixture@localhost");
			expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
			expect(git("status", "--porcelain=v1")).toBe(before);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("loads persisted identity and rejects an invalid binding", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dispatch-binding-"));
		try {
			expect(loadDispatchBinding(directory)).toBeUndefined();
			await writeFile(
				join(directory, "dispatch.json"),
				JSON.stringify({ ownsBox: true, boxId: "box-retained", guestCwd: "/repo" }),
			);
			expect(loadDispatchBinding(directory)?.boxId).toBe("box-retained");
			await writeFile(
				join(directory, "dispatch.json"),
				JSON.stringify({ boxId: "box-retained", guestCwd: "/repo" }),
			);
			expect(() => loadDispatchBinding(directory)).toThrow("Invalid dispatch binding");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
