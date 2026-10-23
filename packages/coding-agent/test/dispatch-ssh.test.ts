import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SailClient } from "../src/core/dispatch/sail-client.js";
import { DispatchSshManager } from "../src/core/dispatch/ssh.js";
import type { DispatchBinding } from "../src/core/dispatch/types.js";
import * as processes from "../src/utils/child-process.js";

const binding: DispatchBinding = {
	ownsBox: true,
	boxId: "fixture-box",
	guestRepoDir: "/repo",
	guestCwd: "/repo",
	guestStateDir: "/state",
	guestPython: "/python",
	guestSkillsDir: "/skills",
	hostResourceDir: "/tmp",
	inputs: {},
};

afterEach(() => vi.restoreAllMocks());

describe("dispatch SSH", () => {
	it("closes processes independently, observes exits, and cleans up on owner disposal", async () => {
		vi.spyOn(SailClient.prototype, "sshAlias").mockResolvedValue({
			host: "fixture.sail",
			configFile: "/fixture/ssh_config",
			env: process.env,
		});
		const children: ChildProcess[] = [];
		vi.spyOn(processes, "spawnHidden").mockImplementation((_command, _args, options) => {
			const child = spawn(
				process.execPath,
				["-e", 'process.stdin.resume(); process.stderr.write("debug1: Entering interactive session.\\n");'],
				{ ...options, stdio: ["pipe", "ignore", "pipe"] },
			);
			children.push(child);
			return child;
		});
		const manager = new DispatchSshManager();
		try {
			const handles = await Promise.all(
				Array.from({ length: 3 }, () => manager.open(binding, ["-L", "8080:localhost:3000"])),
			);
			expect(new Set(handles.map(({ pid }) => pid)).size).toBe(3);
			await manager.close(handles[0].id);
			const first = children.find((child) => child.pid === handles[0].pid)!;
			expect(first.signalCode).toBe("SIGTERM");
			expect(manager.status(handles[0].id).running).toBe(false);
			expect(manager.status(handles[1].id).running).toBe(true);
			const second = children.find((child) => child.pid === handles[1].pid)!;
			const exited = once(second, "close");
			second.kill("SIGTERM");
			await exited;
			expect(manager.status(handles[1].id).running).toBe(false);
			await manager.dispose();
			for (const child of children) expect(child.signalCode).toBe("SIGTERM");
		} finally {
			for (const child of children) {
				if (child.exitCode !== null || child.signalCode !== null) continue;
				const closed = once(child, "close");
				child.kill("SIGKILL");
				await closed;
			}
			await manager.dispose();
		}
	});
});
