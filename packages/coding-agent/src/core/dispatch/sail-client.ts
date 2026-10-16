import { Client, type RunOptions, resolveConfig, Sailbox } from "@sailresearch/sdk";
import { AuthStorage } from "../auth-storage.js";

export class SailClient {
	get sdk(): Promise<Client> {
		return AuthStorage.create()
			.getApiKey("sail")
			.then((apiKey) => {
				if (!apiKey) throw new Error("Sail authentication required. Set SAIL_API_KEY or log in to Sail.");
				return Client.fromConfig({ ...resolveConfig(), apiKey });
			});
	}

	async createBox(appId: string, name: string) {
		return (await this.sdk).createSailbox({
			appId,
			name,
			size: "s",
			image: { base: "devbox" },
		});
	}

	async run(boxId: string, command: string, options: RunOptions = {}) {
		return Sailbox.fromId(boxId, { client: await this.sdk }).run(command, {
			timeoutSeconds: 300,
			check: true,
			...options,
		});
	}
}
