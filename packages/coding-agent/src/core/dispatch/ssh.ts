import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { spawnHidden } from "../../utils/child-process.js";
import { recordOrphanProcessState } from "../orphan-process-journal.js";
import { SailClient } from "./sail-client.js";
import type { DispatchBinding } from "./types.js";

export interface SshConnectionInfo {
	id: string;
	pid: number;
	box_id: string;
	running: boolean;
	exit_code: number | null;
}

interface Connection {
	child: ChildProcess;
	boxId: string;
	closed: Promise<void>;
}

function normalizeSshArgs(args: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-N") continue;
		if (!arg.startsWith("-L")) throw new Error("rlm.ssh supports only -N and -L TCP forwarding arguments");
		const forward = arg === "-L" ? args[++i] : arg.slice(2);
		if (!forward) throw new Error("rlm.ssh -L requires a forwarding specification");
		result.push("-L", forward);
	}
	if (result.length === 0) throw new Error("rlm.ssh requires at least one -L forward");
	return result;
}

export class DispatchSshManager {
	private readonly connections = new Map<string, Connection>();
	private readonly abort = new AbortController();

	async open(binding: DispatchBinding, args: string[]): Promise<SshConnectionInfo> {
		this.abort.signal.throwIfAborted();
		const forwards = normalizeSshArgs(args);
		const access = await new SailClient().sshAlias(binding.boxId, this.abort.signal);
		this.abort.signal.throwIfAborted();
		const child = spawnHidden(
			"ssh",
			[
				"-v",
				"-F",
				access.configFile,
				"-S",
				"none",
				"-N",
				"-oForkAfterAuthentication=no",
				"-oExitOnForwardFailure=yes",
				"-oBatchMode=yes",
				"-oConnectTimeout=30",
				"-oServerAliveInterval=15",
				"-oServerAliveCountMax=3",
				...forwards,
				access.host,
			],
			{ env: access.env, stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" },
		);
		const id = randomUUID();
		const closed = new Promise<void>((resolve) => {
			child.once("close", () => {
				if (child.pid) recordOrphanProcessState(child.pid, false);
				resolve();
			});
		});
		this.connections.set(id, { child, boxId: binding.boxId, closed });
		if (child.pid) recordOrphanProcessState(child.pid, true);
		let stderr = "";
		let timer: NodeJS.Timeout | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error("SSH forwarding setup timed out")), 45_000);
				child.on("error", reject);
				child.once("close", (code) => reject(new Error(`SSH exited (${code}): ${stderr}`)));
				child.stderr!.setEncoding("utf8");
				child.stderr!.on("data", (chunk: string) => {
					stderr = (stderr + chunk).slice(-8192);
					// OpenSSH emits this after authentication and local forwarding setup.
					if (stderr.includes("Entering interactive session.")) resolve();
				});
			});
			this.abort.signal.throwIfAborted();
			return this.status(id);
		} catch (error) {
			await this.close(id);
			this.connections.delete(id);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	status(id: string): SshConnectionInfo {
		const connection = this.connections.get(id);
		if (!connection) throw new Error(`Unknown SSH connection: ${id}`);
		const { child, boxId } = connection;
		return {
			id,
			pid: child.pid!,
			box_id: boxId,
			running: child.exitCode === null && child.signalCode === null,
			exit_code: child.exitCode,
		};
	}

	async close(id: string): Promise<void> {
		const connection = this.connections.get(id);
		if (!connection) throw new Error(`Unknown SSH connection: ${id}`);
		connection.child.kill("SIGTERM");
		await connection.closed;
	}

	async dispose(): Promise<void> {
		this.abort.abort(new Error("SSH owner session closed"));
		await Promise.all([...this.connections.keys()].map((id) => this.close(id)));
	}
}
