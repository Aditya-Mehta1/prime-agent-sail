import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getBundledSkillsDir } from "../../config.js";
import { spawnHidden } from "../../utils/child-process.js";
import type { KernelManagerOptions } from "../kernel/shared.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import type { SailRelayConfig } from "./relay.js";
import { SailClient } from "./sail-client.js";
import type { DispatchBinding } from "./types.js";
import { shellQuote } from "./workspace.js";

export async function prepareDispatchPythonSkills(
	binding: DispatchBinding,
	skills: readonly PythonSkillRuntimeInfo[],
	signal?: AbortSignal,
): Promise<void> {
	if (!binding.ownsBox) return;
	const packages = new Set<string>();
	for (const skill of skills) {
		const bundled = relative(getBundledSkillsDir(), skill.packagePath);
		if (!isAbsolute(bundled) && bundled !== ".." && !bundled.startsWith(`..${sep}`)) continue;
		const path = posix.resolve(
			binding.guestCwd,
			relative(binding.hostResourceDir, skill.packagePath).split(sep).join("/"),
		);
		if (path !== binding.guestRepoDir && !path.startsWith(`${binding.guestRepoDir}/`))
			throw new Error(`Python skill ${skill.name} is outside the copied dispatch project`);
		packages.add(path);
	}
	if (packages.size > 0)
		await new SailClient().run(
			binding.boxId,
			`uv pip install --python ${shellQuote(binding.guestPython)} -q ${[...packages].map(shellQuote).join(" ")}`,
			{ cwd: binding.guestCwd, signal },
		);
}

/** A session cannot replace its kernel until the previous exec is known stopped. */
const activeKernels = new Map<string, { boxId: string }>();

export function hasDispatchKernels(boxId: string): boolean {
	return [...activeKernels.values()].some((kernel) => kernel.boxId === boxId);
}

export function createDispatchKernelLauncher(
	binding: DispatchBinding,
	env: Record<string, string>,
): NonNullable<KernelManagerOptions["processLauncher"]> {
	const states = new WeakMap<ChildProcess, { done: Promise<void>; stop?: Promise<void> }>();
	return {
		spawn() {
			const key = `${binding.boxId}:${binding.guestStateDir}`;
			if (activeKernels.has(key))
				throw new Error("Previous Sail kernel termination is unverified; cannot start another kernel");
			const owner = { boxId: binding.boxId };
			activeKernels.set(key, owner);
			const release = () => {
				if (activeKernels.get(key) === owner) activeKernels.delete(key);
			};
			const compiled = fileURLToPath(new URL("./relay.js", import.meta.url));
			const entry = existsSync(compiled) ? compiled : fileURLToPath(new URL("./relay.ts", import.meta.url));
			const args = entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), entry] : [entry];
			let child: ChildProcess;
			try {
				child = spawnHidden(process.execPath, args, { stdio: ["pipe", "pipe", "pipe", "ipc"] });
			} catch (error) {
				release();
				throw error;
			}
			let execId: string | undefined;
			let resolveDone!: () => void;
			let rejectDone!: (error: Error) => void;
			const done = new Promise<void>((resolve, reject) => {
				resolveDone = resolve;
				rejectDone = reject;
			});
			void done.catch(() => undefined);
			states.set(child, { done });
			child.on("message", (value: unknown) => {
				if (!value || typeof value !== "object") return;
				const message = value as { type?: string; execId?: string; error?: string };
				if (message.type === "started") execId = message.execId;
				if (message.type === "remote-exit") {
					release();
					resolveDone();
				}
				if (message.type === "cleanup-error") rejectDone(new Error(message.error));
			});
			child.once("error", rejectDone);
			child.once("exit", () =>
				rejectDone(
					new Error(
						`Sail relay exited without confirmed cleanup; manually stop Sailbox ${binding.boxId} exec ${execId ?? "unknown"}`,
					),
				),
			);
			const config: SailRelayConfig = {
				boxId: binding.boxId,
				cwd: binding.guestCwd,
				command: `exec ${shellQuote(binding.guestPython)} -u -m rlm.repl`,
				env: {
					...Object.fromEntries(
						Object.entries(env).filter(([key]) =>
							[
								"RLM_DEPTH",
								"RLM_MAX_DEPTH",
								"PRIME_AGENT_BASH_SHELL",
								"PRIME_AGENT_BASH_COMMAND_PREFIX",
								"SERPER_API_KEY",
							].includes(key),
						),
					),
					GH_HOST: "github.com",
					VIRTUAL_ENV: posix.dirname(posix.dirname(binding.guestPython)),
					RLM_SESSION_DIR: binding.guestStateDir,
					RLM_HARNESS_STATE_DIR: `${binding.guestStateDir}/harness`,
					RLM_GLOBAL_HARNESS_STATE_DIR: `${binding.guestStateDir}/global-harness`,
					PRIME_AGENT_CODING_AGENT_DIR: binding.guestStateDir,
				},
			};
			child.send?.(config, (error) => {
				if (error) rejectDone(error);
			});
			return child;
		},
		stop(child) {
			const state = states.get(child);
			if (!state) return Promise.reject(new Error("Unknown Sail relay process"));
			state.stop ??= new Promise<void>((resolve, reject) => {
				const deadline = setTimeout(
					() => reject(new Error(`Sail kernel cleanup timed out; manually inspect Sailbox ${binding.boxId}`)),
					30_000,
				);
				void state.done.then(resolve, reject).finally(() => clearTimeout(deadline));
				if (child.connected)
					child.send({ type: "stop" }, (error) => {
						if (error) reject(error);
					});
			});
			return state.stop;
		},
	};
}
