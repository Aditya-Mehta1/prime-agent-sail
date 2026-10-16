import { isAbsolute, posix, relative, sep } from "node:path";
import type { Client, ExecOptions, ExecProcess } from "@sailresearch/sdk";
import WebSocket from "ws";
import { getBundledSkillsDir } from "../../config.js";
import type { KernelTransport } from "../kernel/shared.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
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

const activeKernels = new Map<string, string>();

export function hasDispatchKernels(boxId: string, guestStateDir?: string): boolean {
	if (guestStateDir === undefined) return [...activeKernels.values()].includes(boxId);
	const key = `${boxId}:${guestStateDir}`;
	return [...activeKernels.keys()].some((active) => active === key || active.startsWith(`${key}/`));
}

export function createDispatchKernelTransport(binding: DispatchBinding, env: Record<string, string>): KernelTransport {
	const client = new SailClient();
	const key = `${binding.boxId}:${binding.guestStateDir}`;
	const command = `exec ${shellQuote(binding.guestPython)} -u -m rlm.repl --socket`;
	const options: ExecOptions = {
		cwd: binding.guestCwd,
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
	let sdk: Client;
	let execId: string | undefined;
	let port: number;
	let handlers: Parameters<KernelTransport["start"]>[0];
	let socket: WebSocket | undefined;
	let startup: Promise<void> | undefined;
	let stopping: Promise<void> | undefined;
	let writes: Promise<void> = Promise.resolve();
	let ended = false;
	let ownsKey = false;

	const release = () => {
		const current = socket;
		socket = undefined;
		current?.close(1000);
	};
	const connect = async (): Promise<WebSocket> => {
		if (stopping || ended) throw new Error("Sail kernel has stopped");
		if (socket?.readyState === WebSocket.OPEN) return socket;
		const config = await client.config;
		const url = new URL(`/v1/sailboxes/${encodeURIComponent(binding.boxId)}/tunnel`, config.sailboxApiUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("port", String(port));
		const current = new WebSocket(url, {
			headers: { Authorization: `Bearer ${config.apiKey}` },
			handshakeTimeout: 30_000,
			perMessageDeflate: false,
		});
		socket = current;
		current.on("message", (data, binary) => {
			if (socket !== current) return;
			if (binary) handlers.data(data as Buffer);
			else {
				ended = true;
				release();
				handlers.exit();
			}
		});
		current.on("error", (error) => {
			if (socket !== current) return;
			socket = undefined;
			handlers.error(error);
		});
		current.on("close", (code, reason) => {
			if (socket !== current) return;
			socket = undefined;
			if (code === 1000) {
				ended = true;
				handlers.exit();
			} else handlers.error(new Error(`Sail tunnel closed (${code}): ${reason}`));
		});
		await new Promise<void>((resolve, reject) => {
			current.once("open", resolve);
			current.once("error", reject);
		});
		return current;
	};

	return {
		async start(callbacks) {
			if (activeKernels.has(key))
				throw new Error("Previous Sail kernel termination is unverified; cannot start another kernel");
			activeKernels.set(key, binding.boxId);
			ownsKey = true;
			handlers = callbacks;
			stopping = undefined;
			execId = undefined;
			ended = false;
			writes = Promise.resolve();
			startup = (async () => {
				sdk = await client.sdk;
				let proc: ExecProcess | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					proc = await sdk.exec(binding.boxId, command, options);
					execId = proc.execRequestId;
					const descriptor = (async () => {
						let text = "";
						for await (const chunk of proc.stdout) {
							text += chunk;
							if (!text.includes("\n")) continue;
							const value = JSON.parse(text.slice(0, text.indexOf("\n"))) as { port?: number };
							if (!Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535)
								throw new Error("Invalid Sail REPL port");
							return value.port!;
						}
						throw new Error(`Sail REPL exited before listening: ${await proc.stderr.text()}`);
					})();
					port = await Promise.race([
						descriptor,
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => reject(new Error("Sail REPL did not start listening")), 30_000);
						}),
					]);
				} finally {
					clearTimeout(timer);
					proc?.close();
				}
				await connect();
			})();
			return startup;
		},
		write(line) {
			const write = writes.then(async () => {
				const current = await connect();
				const bytes = Buffer.from(line);
				for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
					await new Promise<void>((resolve, reject) => {
						current.send(bytes.subarray(offset, offset + 1024 * 1024), (error) =>
							error ? reject(error) : resolve(),
						);
					});
				}
			});
			writes = write.catch(() => undefined);
			return write;
		},
		release,
		stop() {
			if (!ownsKey) return Promise.resolve();
			stopping ??= (async () => {
				await startup?.catch(() => undefined);
				release();
				if (!execId) {
					activeKernels.delete(key);
					ownsKey = false;
					return;
				}
				let proc: ExecProcess | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						(async () => {
							proc = await sdk.exec(binding.boxId, command, { ...options, idempotencyKey: execId });
							if (!ended) await proc.cancel({ force: true });
							await proc.wait();
						})(),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error(
											`Sail kernel cleanup timed out; inspect Sailbox ${binding.boxId} exec ${execId}`,
										),
									),
								30_000,
							);
						}),
					]);
					activeKernels.delete(key);
					ownsKey = false;
				} finally {
					clearTimeout(timer);
					proc?.close();
				}
			})();
			return stopping;
		},
	};
}
