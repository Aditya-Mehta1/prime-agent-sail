import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Client, SailboxTerminatedError } from "@sailresearch/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SailClient } from "../src/core/dispatch/sail-client.js";
import {
	cleanupSessionDispatchWorkspaces,
	deleteSessionArtifacts,
	deleteSessionFile,
} from "../src/core/session-file-actions.js";
import { getSessionArtifactPathForFile } from "../src/core/session-manager.js";

let root = "";

describe("deleteSessionFile removes the session artifact directory", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prime-agent-session-delete-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	it("permanently deletes <root>/session-artifacts/<id> alongside the session file", async () => {
		const sessionId = "session-xyz";
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionPath, '{"type":"session"}\n');

		const artifactDir = join(root, "session-artifacts", sessionId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");
		writeFileSync(join(artifactDir, "kernel-state.json"), "{}");
		writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');

		const result = await deleteSessionFile(sessionPath);

		expect(result.ok).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("runs the file-removed callback before deleting artifacts", async () => {
		const sessionId = "session-with-callback";
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionPath, '{"type":"session"}\n');

		const artifactDir = join(root, "session-artifacts", sessionId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");
		let wasSessionRemovedBeforeCallback = false;
		let wereArtifactsPresentDuringCallback = false;

		const result = await deleteSessionFile(sessionPath, {
			afterFileRemoved: () => {
				wasSessionRemovedBeforeCallback = !existsSync(sessionPath);
				wereArtifactsPresentDuringCallback = existsSync(artifactDir);
			},
		});

		expect(result.ok).toBe(true);
		expect(wasSessionRemovedBeforeCallback).toBe(true);
		expect(wereArtifactsPresentDuringCallback).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
	});

	it("never removes the artifacts root for a degenerate session file name", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const artifactsRoot = join(root, "session-artifacts");
		mkdirSync(join(artifactsRoot, "live-session"), { recursive: true });

		// Basename ".jsonl" strips to an empty id, which would resolve to the root.
		await deleteSessionArtifacts(join(sessionsDir, ".jsonl"));

		expect(existsSync(join(artifactsRoot, "live-session"))).toBe(true);
	});

	it("succeeds when the session has no artifact directory", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "no-artifacts.jsonl");
		writeFileSync(sessionPath, "{}\n");

		const result = await deleteSessionFile(sessionPath);
		expect(result.ok).toBe(true);
	});
	it.each(["parent", "owner", "borrower", "borrower-terminated", "shutdown"] as const)(
		"cleans the %s remote workspace without deleting unrelated state",
		async (target) => {
			const parent = join(root, "sessions", "parent.jsonl");
			const owner = join(getSessionArtifactPathForFile(parent), "sub-owner", "owner.jsonl");
			const borrower = join(dirname(owner), "sub-borrower", "borrower.jsonl");
			const siblingOwner = join(getSessionArtifactPathForFile(parent), "sub-sibling", "sibling.jsonl");
			const box = join(root, "remote-box");
			const siblingBox = join(root, "remote-sibling");
			const borrowerState = join(box, "borrower");
			for (const file of [parent, owner, borrower, siblingOwner]) {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, '{"type":"session"}\n');
			}
			for (const [file, boxId, ownsBox, guestStateDir] of [
				[owner, box, true, box],
				[borrower, box, false, borrowerState],
				[siblingOwner, siblingBox, true, siblingBox],
			] as const) {
				mkdirSync(guestStateDir, { recursive: true });
				writeFileSync(join(guestStateDir, "kernel-state.dill"), "saved");
				writeFileSync(
					join(dirname(file), "dispatch.json"),
					JSON.stringify({ ownsBox, boxId, guestCwd: "/repo", guestStateDir }),
				);
			}
			vi.spyOn(SailClient.prototype, "sdk", "get").mockResolvedValue({
				terminateSailbox: async (boxId: string) => rmSync(boxId, { recursive: true, force: true }),
				removePath: async (boxId: string, path: string) => {
					if (!existsSync(boxId)) throw new SailboxTerminatedError("Sailbox was terminated");
					rmSync(path, { recursive: true, force: true });
				},
			} as unknown as Client);
			if (target === "borrower-terminated") rmSync(box, { recursive: true, force: true });
			const session = {
				parent,
				owner,
				borrower,
				"borrower-terminated": borrower,
				shutdown: parent,
			}[target];
			if (target === "shutdown") await cleanupSessionDispatchWorkspaces([session, owner], true);
			else expect((await deleteSessionFile(session)).ok).toBe(true);
			expect(existsSync(box)).toBe(target === "borrower");
			expect(existsSync(borrowerState)).toBe(false);
			expect(existsSync(siblingBox)).toBe(
				target === "owner" || target === "borrower" || target === "borrower-terminated",
			);
			expect(existsSync(parent)).toBe(target !== "parent");
		},
	);

	it("keeps the transcript and binding when remote deletion fails, then permits retry", async () => {
		const session = join(root, "sessions", "parent.jsonl");
		const artifacts = getSessionArtifactPathForFile(session);
		const binding = join(artifacts, "sub-owner", "dispatch.json");
		mkdirSync(dirname(session), { recursive: true });
		mkdirSync(dirname(binding), { recursive: true });
		writeFileSync(session, "{}\n");
		writeFileSync(binding, JSON.stringify({ ownsBox: true, boxId: "fixture", guestCwd: "/repo" }));
		const sdk = {
			terminateSailbox: async () => {
				throw new Error("cleanup failed");
			},
		} as unknown as Client;
		vi.spyOn(SailClient.prototype, "sdk", "get").mockResolvedValue(sdk);
		expect(await deleteSessionFile(session)).toEqual({ ok: false, error: "cleanup failed" });
		expect(existsSync(session)).toBe(true);
		expect(existsSync(binding)).toBe(true);
		vi.spyOn(sdk, "terminateSailbox").mockResolvedValue(undefined);
		expect((await deleteSessionFile(session)).ok).toBe(true);
		expect(existsSync(artifacts)).toBe(false);
	});
});
