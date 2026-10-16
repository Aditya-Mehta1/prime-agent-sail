import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Client } from "@sailresearch/sdk";
import { SailClient } from "./sail-client.js";

export interface SailRelayConfig {
	boxId: string;
	command: string;
	cwd: string;
	env: Record<string, string>;
}

async function forwardOutput(chunks: AsyncIterable<Buffer>, output: Writable): Promise<void> {
	for await (const chunk of chunks) {
		if (!output.write(chunk)) await once(output, "drain");
	}
}

/** One attachment: missing REPL output must fail instead of silently replaying a cell. */
export async function runSailRelay(
	client: Promise<Client>,
	config: SailRelayConfig,
	input: Readable,
	output: Writable,
	diagnostics: Writable,
	signal: AbortSignal,
	onStarted: (id: string) => void,
	onExit: () => void,
): Promise<number> {
	const proc = await (await client).exec(config.boxId, config.command, {
		cwd: config.cwd,
		env: config.env,
		openStdin: true,
		outputMode: "pipe",
	});
	// Reading the ID disables SDK stream reclamation after an interruption.
	onStarted(proc.execRequestId);
	const outputs = Promise.all([
		forwardOutput(proc.stdout.raw(), output),
		forwardOutput(proc.stderr.raw(), diagnostics),
	]);
	const stdin = (async () => {
		for await (const chunk of input) await proc.writeStdin(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		await proc.closeStdin();
	})();
	let onAbort!: () => void;
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => reject(new Error("Sail relay stopped"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		await Promise.race([outputs, stdin.then(() => outputs), stopped]);
		const code = proc.poll();
		if (code === null) throw new Error("Sail exec stream ended before exit; cell delivery is uncertain");
		onExit();
		return code;
	} catch (error) {
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				(async () => {
					await proc.cancel({ force: true });
					await proc.wait();
				})(),
				new Promise<never>((_, reject) => {
					deadline = setTimeout(() => reject(new Error("SDK cleanup timed out")), 30_000);
				}),
			]);
			onExit();
		} catch (cleanupError) {
			throw new Error(
				`Sail kernel cleanup failed: ${String(cleanupError)}; manually inspect Sailbox ${config.boxId}`,
			);
		} finally {
			clearTimeout(deadline);
		}
		if (signal.aborted) return 0;
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
		proc.close();
		input.destroy();
		await Promise.allSettled([stdin, outputs]);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.once("message", (config: SailRelayConfig) => {
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.on("message", (message: unknown) => {
			if (message && typeof message === "object" && "type" in message && message.type === "stop") stop();
		});
		process.once("disconnect", stop);
		if (!process.connected) stop();
		void runSailRelay(
			new SailClient().sdk,
			config,
			process.stdin,
			process.stdout,
			process.stderr,
			controller.signal,
			(execId) => {
				if (process.connected) process.send?.({ type: "started", execId });
			},
			() => {
				if (process.connected) process.send?.({ type: "remote-exit" });
			},
		)
			.then(
				(code) => {
					process.exitCode = code;
				},
				(error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					process.stderr.write(`Sail kernel relay: ${message}\n`);
					if (process.connected) process.send?.({ type: "cleanup-error", error: message });
					process.exitCode = 1;
				},
			)
			.finally(() => {
				process.removeListener("disconnect", stop);
				if (process.connected) process.disconnect();
			});
	});
}
