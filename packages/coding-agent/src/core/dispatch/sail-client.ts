import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client, EgressPolicy, type RunOptions, resolveConfig, Sailbox } from "@sailresearch/sdk";

import { AuthStorage } from "../auth-storage.js";

const executeFile = promisify(execFile);
// shortcut: shared credentials assume one GitHub identity; scope per user before multi-user use.
const GITHUB_AUTH = "prime-dispatch-github";

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
		const sdk = await this.sdk;
		const { stdout } = await executeFile("gh", ["auth", "token", "--hostname", "github.com"]);
		const token = stdout.trim();
		if (!token) throw new Error("Dispatch requires gh auth login --hostname github.com");
		await sdk.setSecret(GITHUB_AUTH, `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`);
		const policies = await EgressPolicy.list({ client: sdk, search: GITHUB_AUTH });
		const headers = { authorization: `\${secrets.${GITHUB_AUTH}}` };
		const policy =
			policies.find((policy) => policy.name === GITHUB_AUTH) ??
			(await EgressPolicy.create(
				GITHUB_AUTH,
				{
					rules: {
						"github.com": [{ request: { set: { headers } } }],
						"api.github.com": [{ request: { set: { headers } } }],
					},
				},
				{ client: sdk },
			));
		return sdk.createSailbox({
			appId,
			name,
			size: "s",
			image: { base: "devbox" },
			egressPolicy: policy,
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
