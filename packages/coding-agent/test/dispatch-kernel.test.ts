import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { hasDispatchKernels } from "../src/core/dispatch/kernel.js";
import { SailClient } from "../src/core/dispatch/sail-client.js";
import type { DispatchBinding } from "../src/core/dispatch/types.js";
import { inheritDispatchWorkspace, terminateDispatchWorkspace } from "../src/core/dispatch/workspace.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "sail-kernel-"));
	const events = new EventEmitter();
	const executions = new Map<
		string,
		{
			output: ServerResponse;
			port: number;
			attached: boolean;
			exitCode?: number;
			socket?: WebSocket;
			activeId?: unknown;
		}
	>();
	const commands: Record<string, unknown>[] = [];
	const frames: Record<string, unknown>[] = [];
	const auth: (string | undefined)[] = [];
	const messages: number[] = [];
	const cancellations: string[] = [];
	let rejectCancel = false;
	let finishCancellation = () => {};
	const sdkEvent = (response: ServerResponse, value: object) => response.write(`${JSON.stringify(value)}\n`);
	const send = (socket: WebSocket, value: object) => {
		const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
		const middle = Math.floor(bytes.length / 2);
		socket.send(bytes.subarray(0, middle));
		socket.send(bytes.subarray(middle));
	};
	const done = (socket: WebSocket, id: unknown, extra: object = {}) =>
		send(socket, { event: "done", id, status: "ok", ...extra });
	const server = createServer(async (request, response) => {
		auth.push(request.headers.authorization);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const url = new URL(request.url!, "http://localhost");
		if (url.pathname.endsWith("/exec")) {
			const command = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
			commands.push(command);
			response.writeHead(200, { "Content-Type": "application/x-ndjson" });
			sdkEvent(response, { type: "started", exec_request_id: command.idempotency_key });
			if (!JSON.stringify(command.command).includes("rlm.repl")) {
				sdkEvent(response, { type: "exit", return_code: 0, status: "succeeded" });
				response.end();
				return;
			}
			const id = String(command.idempotency_key);
			const prior = executions.get(id);
			if (prior) {
				prior.output = response;
				if (prior.exitCode !== undefined) {
					sdkEvent(response, { type: "exit", return_code: prior.exitCode, status: "succeeded" });
					response.end();
				}
			} else {
				const port = 10000 + executions.size;
				executions.set(id, { output: response, port, attached: false });
				sdkEvent(response, {
					type: "stdout",
					seq: 1,
					data: Buffer.from(`${JSON.stringify({ port })}\n`).toString("base64"),
				});
			}
			return;
		}
		if (url.pathname.endsWith("/terminate")) {
			response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
			return;
		}
		const id = url.searchParams.get("exec_request_id")!;
		const exec = executions.get(id)!;
		if (url.pathname.endsWith("/cancel")) {
			cancellations.push(id);
			if (rejectCancel)
				response
					.writeHead(403, { "Content-Type": "application/json" })
					.end('{"message":"fixture cancellation denied"}');
			else {
				response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
				finishCancellation = () => {
					exec.exitCode = 137;
					sdkEvent(exec.output, { type: "exit", return_code: 137, status: "failed" });
					exec.output.end();
				};
			}
			events.emit("cancel");
			return;
		}
		if (url.pathname.endsWith("/wait")) {
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ status: "succeeded", return_code: exec.exitCode, stdout: "", stderr: "" }));
			return;
		}
		response.writeHead(404).end();
	});
	const sockets = new WebSocketServer({ server });
	sockets.on("connection", (socket, request) => {
		auth.push(request.headers.authorization);
		const url = new URL(request.url!, "http://localhost");
		expect(url.pathname).toMatch(/\/tunnel$/);
		const exec = [...executions.values()].find((item) => item.port === Number(url.searchParams.get("port")))!;
		exec.socket = socket;
		if (!exec.attached) send(socket, { event: "ready", protocol: 3 });
		exec.attached = true;
		let buffered = "";
		socket.once("close", () => events.emit("detached"));
		socket.on("message", (raw, binary) => {
			expect(binary).toBe(true);
			const packet = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			messages.push(packet.length);
			buffered += packet.toString();
			while (buffered.includes("\n")) {
				const newline = buffered.indexOf("\n");
				const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				buffered = buffered.slice(newline + 1);
				frames.push(frame);
				if (frame.type === "execute" && frame.code === "needs-host") {
					exec.activeId = frame.id;
					send(socket, {
						event: "host_request",
						id: randomUUID(),
						data: { type: "rlm.run", prompt: "remote child" },
					});
				} else if (frame.type === "host_reply") {
					send(socket, { event: "result", id: exec.activeId, text: "λ remote result" });
					done(socket, exec.activeId);
				} else if (frame.type === "execute" && frame.code === "background") {
					send(socket, {
						event: "display",
						data: {
							"application/vnd.prime-agent.bash-activity+json": { id: "a".repeat(32), pid: 99, active: true },
						},
					});
					done(socket, frame.id);
				} else if (frame.type === "execute" && frame.code === "wait") {
					exec.activeId = frame.id;
					send(socket, { event: "stdout", id: frame.id, text: "waiting" });
				} else if (frame.type === "interrupt") done(socket, exec.activeId);
				else if (frame.type === "execute" && frame.code === "drop-transport") socket.terminate();
				else if (frame.type === "restore") done(socket, frame.id, { restored: ["counter"], failed: [] });
				else if (frame.type === "snapshot") done(socket, frame.id, { saved: ["counter"], skipped: [], bytes: 12 });
				else if (frame.type === "shutdown") {
					done(socket, frame.id);
					exec.exitCode = 0;
					socket.send('{"type":"eof"}');
				} else done(socket, frame.id);
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture address");
	vi.stubEnv(ENV_AGENT_DIR, dir);
	vi.stubEnv("SAIL_API_KEY", "fixture-key");
	vi.stubEnv("SAILBOX_API_URL", `http://127.0.0.1:${address.port}`);
	const binding: DispatchBinding = {
		ownsBox: true,
		boxId: `sb_${randomUUID()}`,
		guestRepoDir: "/state/repo",
		guestCwd: "/state/repo/subdir",
		guestStateDir: "/state/session",
		guestPython: "/state/venv/bin/python",
		guestSkillsDir: "/state/skills",
		hostResourceDir: dir,
		inputs: {},
	};
	return {
		dir,
		binding,
		frames,
		commands,
		messages,
		cancellations,
		auth,
		events,
		executions,
		finishWait: () => finishCancellation(),
		denyCancel: () => {
			rejectCancel = true;
		},
		finishBackground() {
			for (const exec of executions.values())
				send(exec.socket!, {
					event: "display",
					data: {
						"application/vnd.prime-agent.bash-activity+json": { id: "a".repeat(32), pid: 99, active: false },
					},
				});
		},
		async close() {
			for (const socket of sockets.clients) socket.terminate();
			await new Promise<void>((resolve, reject) => sockets.close((error) => (error ? reject(error) : resolve())));
			for (const exec of executions.values()) exec.output.destroy();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(dir, { recursive: true, force: true });
		},
	};
}

describe("Sail kernel tunnel", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("uses current Sail credentials without forwarding them to the guest", async () => {
		const f = await fixture();
		const provisioner = new IpythonKernelProvisioner(f.dir, {
			dispatchBinding: f.binding,
			env: { SAIL_API_KEY: "secret", GH_TOKEN: "secret", PRIME_AGENT_KERNEL_OWNER_PID: "123" },
		});
		try {
			const manager = await provisioner.ensure();
			expect(provisioner.lastRestore?.restored).toEqual(["counter"]);
			const auth = AuthStorage.create();
			auth.set("sail", { type: "api_key", key: "changed-key" });
			const detached = once(f.events, "detached");
			await manager.execute("next");
			await detached;
			expect(f.auth).toContain("Bearer changed-key");
			const env = f.commands[0].env;
			expect(env).toMatchObject({
				GH_HOST: "github.com",
				VIRTUAL_ENV: "/state/venv",
				RLM_SESSION_DIR: "/state/session",
			});
			for (const key of ["SAIL_API_KEY", "GH_TOKEN", "PRIME_AGENT_KERNEL_OWNER_PID"])
				expect(env).not.toHaveProperty(key);
			await provisioner.dispose();
			expect(f.frames).toContainEqual(
				expect.objectContaining({ type: "snapshot", path: "/state/session/kernel-state.dill" }),
			);
			expect(f.cancellations).toEqual([]);
			expect(hasDispatchKernels(f.binding.boxId)).toBe(false);
			auth.logout("sail");
			vi.stubEnv("SAIL_API_KEY", undefined);
			await expect(new SailClient().sdk).rejects.toThrow("Sail authentication required");
		} finally {
			await provisioner.dispose().catch(() => undefined);
			await f.close();
		}
	});

	it("keeps callbacks and background work connected, releases idle, and chunks large requests", async () => {
		const f = await fixture();
		let answer!: () => void;
		const reply = new Promise<void>((resolve) => {
			answer = resolve;
		});
		const provisioner = new IpythonKernelProvisioner(f.dir, {
			dispatchBinding: f.binding,
			hostHandlers: {
				"rlm.run": async () => {
					f.events.emit("callback");
					await reply;
					return {};
				},
			},
		});
		try {
			const manager = await provisioner.ensure();
			const callback = once(f.events, "callback");
			const result = manager.execute("needs-host");
			await callback;
			expect([...f.executions.values()][0].socket!.readyState).toBe(1);
			answer();
			expect(await result).toMatchObject({ status: "ok", result: "λ remote result" });
			await manager.execute("background");
			expect(manager.hasBackgroundWork).toBe(true);
			const detached = once(f.events, "detached");
			f.finishBackground();
			await detached;
			expect(manager.hasBackgroundWork).toBe(false);
			const code = "x".repeat(1024 * 1024 + 20);
			expect((await manager.execute(code)).status).toBe("ok");
			expect(f.frames).toContainEqual(expect.objectContaining({ code }));
			expect(Math.max(...f.messages)).toBe(1024 * 1024);
			const controller = new AbortController();
			expect(
				(await manager.execute("wait", { signal: controller.signal, onStream: () => controller.abort() })).status,
			).toBe("aborted");
			expect((await manager.execute("still works")).status).toBe("ok");
		} finally {
			answer();
			await provisioner.dispose();
			await f.close();
		}
	});

	it("isolates shared-box kernels and verifies cancellation before replacement", async () => {
		const f = await fixture();
		const borrower = await inheritDispatchWorkspace(f.binding, join(f.dir, "child"));
		const owner = new IpythonKernelProvisioner(f.dir, { dispatchBinding: f.binding });
		const child = new IpythonKernelProvisioner(f.dir, { dispatchBinding: borrower });
		const duplicate = new IpythonKernelProvisioner(f.dir, { dispatchBinding: f.binding });
		try {
			const [parent, sub] = await Promise.all([owner.ensure(), child.ensure()]);
			await Promise.all([parent.execute("owner"), sub.execute("child")]);
			await expect(duplicate.ensure()).rejects.toThrow("termination is unverified");
			expect(hasDispatchKernels(f.binding.boxId, f.binding.guestStateDir)).toBe(true);
			await terminateDispatchWorkspace(borrower);
			const cancelled = once(f.events, "cancel");
			const stopping = child.kill();
			await cancelled;
			let stopped = false;
			void stopping.then(() => {
				stopped = true;
			});
			expect(stopped).toBe(false);
			f.finishWait();
			await stopping;
			expect(hasDispatchKernels(f.binding.boxId)).toBe(true);
			expect((await parent.execute("still works")).status).toBe("ok");
			await child.ensure();
			expect(f.executions.size).toBe(3);
			await owner.dispose();
			expect(hasDispatchKernels(f.binding.boxId, f.binding.guestStateDir)).toBe(true);
			expect(hasDispatchKernels(f.binding.boxId, `${borrower.guestStateDir}-sibling`)).toBe(false);
		} finally {
			f.finishWait();
			await Promise.all([owner.dispose(), child.dispose()]);
			await f.close();
		}
	});

	it("fails lost active delivery without replay and preserves failed cleanup", async () => {
		const f = await fixture();
		f.denyCancel();
		const provisioner = new IpythonKernelProvisioner(f.dir, { dispatchBinding: f.binding });
		try {
			const manager = await provisioner.ensure();
			await expect(manager.execute("drop-transport")).rejects.toThrow();
			const cleanup = provisioner.dispose();
			await expect(cleanup).rejects.toThrow();
			const failure = await cleanup.catch((error: unknown) => error);
			await expect(manager.shutdown()).rejects.toBe(failure);
			expect(f.executions.size).toBe(1);
			expect(f.frames.filter((frame) => frame.code === "drop-transport")).toHaveLength(1);
			expect(hasDispatchKernels(f.binding.boxId)).toBe(true);
		} finally {
			await f.close();
		}
	});
});
