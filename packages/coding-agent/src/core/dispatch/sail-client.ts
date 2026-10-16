import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, resolveConfig, type RunOptions, Sailbox } from "@sailresearch/sdk";
import { AuthStorage } from "../auth-storage.js";

export class SailClient {
	get sdk(): Promise<Client> {
		return AuthStorage.create().getApiKey("sail").then((apiKey) => {
			if (!apiKey) throw new Error("Sail authentication required. Set SAIL_API_KEY or log in to Sail.");
			return Client.fromConfig({ ...resolveConfig(), apiKey });
		});
	}

	async createBox(appId: string, name: string) {
		return (await this.sdk).createSailbox({
			appId,
			name,
			size: "s",
			memoryLimitGib: 2,
			diskLimitGib: 8,
			image: { base: "devbox" },
		});
	}

	async writeFile(boxId: string, path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		using writer = await (await this.sdk).writeStream(boxId, path);
		await pipeline(Readable.from([data]), writer.toWritable(), { signal });
	}

	async run(boxId: string, command: string, options: RunOptions = {}) {
		return Sailbox.fromId(boxId, { client: await this.sdk }).run(command, {
			timeoutSeconds: 300,
			check: true,
			...options,
		});
	}
}
