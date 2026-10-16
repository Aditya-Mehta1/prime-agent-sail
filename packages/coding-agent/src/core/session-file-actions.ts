import { existsSync } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { NotFoundError, SailboxTerminatedError } from "@sailresearch/sdk";
import { spawnSyncHidden } from "../utils/child-process.js";
import { hasDispatchKernels } from "./dispatch/kernel.js";
import { SailClient } from "./dispatch/sail-client.js";
import type { DispatchBinding } from "./dispatch/types.js";
import { loadDispatchBinding, terminateDispatchWorkspace } from "./dispatch/workspace.js";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

export async function cleanupSessionDispatchWorkspaces(
	sessionPaths: readonly string[],
	ownersOnly = false,
): Promise<void> {
	const bindings = new Map<string, DispatchBinding>();
	for (const sessionPath of sessionPaths) {
		if (!basename(sessionPath).replace(/\.jsonl$/, "")) continue;
		const sessionDir = dirname(sessionPath);
		const binding = loadDispatchBinding(sessionDir);
		if (binding) {
			bindings.set(sessionDir, binding);
			continue;
		}
		try {
			for (const entry of await readdir(getSessionArtifactPathForFile(sessionPath), {
				recursive: true,
				withFileTypes: true,
			})) {
				if (!entry.isFile() || entry.name !== "dispatch.json") continue;
				const binding = loadDispatchBinding(entry.parentPath);
				if (binding?.ownsBox) bindings.set(entry.parentPath, binding);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const ownedBoxes = new Set<string>();
	for (const binding of bindings.values()) {
		if (!binding.ownsBox || ownedBoxes.has(binding.boxId)) continue;
		await terminateDispatchWorkspace(binding);
		ownedBoxes.add(binding.boxId);
	}
	if (ownersOnly) return;
	for (const binding of bindings.values()) {
		if (binding.ownsBox || ownedBoxes.has(binding.boxId)) continue;
		if (hasDispatchKernels(binding.boxId, binding.guestStateDir)) {
			throw new Error(`Sailbox ${binding.boxId} still has an active kernel for ${binding.guestStateDir}`);
		}
		try {
			await (await new SailClient().sdk).removePath(binding.boxId, binding.guestStateDir);
		} catch (error) {
			if (!(error instanceof NotFoundError) && !(error instanceof SailboxTerminatedError)) throw error;
		}
	}
}

export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await cleanupSessionDispatchWorkspaces([sessionPath]);
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSyncHidden("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	try {
		await cleanupSessionDispatchWorkspaces([sessionPath]);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		if (basename(sessionPath).replace(/\.jsonl$/, "")) {
			await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
		}
	}
	return result;
}
