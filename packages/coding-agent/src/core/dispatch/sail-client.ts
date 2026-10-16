import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, type RunOptions, Sailbox } from "@sailresearch/sdk";
import { AuthStorage } from "../auth-storage.js";

export class SailClient {
	private readonly apiKey: string | undefined;
	private readonly baseUrl: string;
	private readonly appsUrl: string;

	constructor(options: { apiKey?: string; baseUrl?: string; appsUrl?: string } = {}) {
		this.apiKey = options.apiKey;
		this.baseUrl =
			options.baseUrl ?? process.env.PRIME_AGENT_SAILBOX_URL ?? "https://sailbox-api.sailresearch.com/v1";
		this.appsUrl = options.appsUrl ?? process.env.PRIME_AGENT_SAIL_APPS_URL ?? "https://api.sailresearch.com/v1";
	}

	get sdk(): Promise<Client> {
		return this.resolveApiKey().then((apiKey) =>
			Client.fromConfig({
				apiKey,
				sailboxApiUrl: this.baseUrl.replace(/\/v1\/?$/, ""),
				apiUrl: this.appsUrl.replace(/\/v1\/?$/, ""),
			}),
		);
	}

	private async resolveApiKey(): Promise<string> {
		const apiKey = this.apiKey ?? (await AuthStorage.create().getApiKey("sail"));
		if (!apiKey) throw new Error("Sail authentication required. Set SAIL_API_KEY or log in to Sail.");
		return apiKey;
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
