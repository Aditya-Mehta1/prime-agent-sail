import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client, EgressPolicy, type RunOptions, resolveConfig, Sailbox } from "@sailresearch/sdk";
import { AuthStorage } from "../auth-storage.js";

const executeFile = promisify(execFile);
const GITHUB_AUTH = "prime-dispatch-github";

export class SailClient {
	get config() {
		return AuthStorage.create()
			.getApiKey("sail")
			.then((apiKey) => {
				if (!apiKey) throw new Error("Sail authentication required. Set SAIL_API_KEY or log in to Sail.");
				return { ...resolveConfig(), apiKey };
			});
	}

	get sdk(): Promise<Client> {
		return this.config.then((config) => Client.fromConfig(config));
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

	async prepareSsh(boxId: string, signal?: AbortSignal): Promise<void> {
		await (await this.sdk).enableSsh(boxId, { timeoutSeconds: 60 });
		await this.run(
			boxId,
			`set -eu
mkdir -p /etc/ssh/sshd_config.d
printf 'ChannelTimeout direct-tcpip=5m\\nUnusedConnectionTimeout 1m\\n' > /etc/ssh/sshd_config.d/00-prime-ssh.conf
/usr/sbin/sshd -t
kill -HUP "$(cat /run/sshd.pid)"
`,
			{ timeoutSeconds: 30, signal },
		);
	}

	async sshAlias(boxId: string, signal?: AbortSignal) {
		const config = await this.config;
		const env: NodeJS.ProcessEnv = {
			...process.env,
			SAIL_API_KEY: config.apiKey,
			SAILBOX_API_URL: config.sailboxApiUrl,
			SAIL_API_URL: config.apiUrl,
		};
		const { stdout } = await executeFile("sail", ["box", "ssh", "alias", boxId, "--json"], {
			env,
			signal,
			timeout: 60_000,
			windowsHide: true,
		});
		const data = JSON.parse(stdout) as { hosts: string[]; ssh_config_path: string };
		if (!data.hosts?.[0] || !data.ssh_config_path)
			throw new Error("Sail did not return an SSH alias; the worker must have SSH enabled");
		return { host: data.hosts[0], configFile: data.ssh_config_path, env };
	}

	async run(boxId: string, command: string, options: RunOptions = {}) {
		return Sailbox.fromId(boxId, { client: await this.sdk }).run(command, {
			timeoutSeconds: 300,
			check: true,
			...options,
		});
	}
}
