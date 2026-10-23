import { execFile } from "node:child_process";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Client, type DirEntry, EgressPolicy, type RunOptions, resolveConfig, Sailbox } from "@sailresearch/sdk";
import { AuthStorage } from "../auth-storage.js";

const executeFile = promisify(execFile);
const GITHUB_AUTH = "prime-dispatch-github";
export const DISPATCH_APP_NAME = "prime-agent-dispatch";

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

	async listBoxes(): Promise<Pick<Sailbox, "sailboxId" | "status">[]> {
		const client = await this.sdk;
		const app = await client.findApp(DISPATCH_APP_NAME, false);
		return Sailbox.list({ appId: app.id, client });
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

	async ls(boxId: string, path: string): Promise<DirEntry[]> {
		return Sailbox.fromId(boxId, { client: await this.sdk }).fs.ls(path);
	}

	async upload(boxId: string, localPath: string, remotePath: string): Promise<void> {
		const source = await lstat(localPath);
		if (!source.isDirectory() && !source.isFile()) throw new Error(`Unsupported source type: ${localPath}`);
		const box = Sailbox.fromId(boxId, { client: await this.sdk });
		if (source.isDirectory()) {
			await box.fs.uploadDir({ localDir: localPath, guestDir: remotePath });
			return;
		}
		await using file = await open(localPath, "r");
		using writer = await box.fs.writeStream(remotePath, { mode: source.mode & 0o777 });
		await pipeline(file.createReadStream(), writer.toWritable());
	}

	async download(boxId: string, remotePath: string, localPath: string): Promise<void> {
		const box = Sailbox.fromId(boxId, { client: await this.sdk });
		// The SDK has no stat API; inspect the source's own entry, not its contents.
		const source =
			remotePath === "/"
				? { type: "directory", mode: 0o755 }
				: (await box.fs.ls(posix.dirname(remotePath))).find((entry) => entry.name === posix.basename(remotePath));
		if (!source) throw new Error(`Source does not exist: ${remotePath}`);
		if (source.type === "directory") {
			await box.fs.downloadDir({ guestDir: remotePath, localDir: localPath });
			return;
		}
		if (source.type !== "file") throw new Error(`Unsupported source type (${source.type}): ${remotePath}`);

		await using reader = await box.fs.readStream(remotePath);
		await mkdir(dirname(localPath), { recursive: true });
		await using file = await open(localPath, "w", source.mode & 0o777);
		await file.chmod(source.mode & 0o777);
		await pipeline(reader.toReadable(), file.createWriteStream());
	}
}
