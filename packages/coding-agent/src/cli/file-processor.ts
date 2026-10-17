import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.js";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.js";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	autoResizeImages?: boolean;
}

type FileArgumentInspection = { ok: true; stats: Stats } | { ok: false; error: string };

async function inspectFileArgument(absolutePath: string): Promise<FileArgumentInspection> {
	let stats: Stats;
	try {
		stats = await stat(absolutePath);
	} catch {
		return { ok: false, error: `File not found: ${absolutePath}` };
	}

	if (stats.isDirectory()) {
		return { ok: false, error: `Expected a file, got a directory: ${absolutePath}` };
	}

	return { ok: true, stats };
}

export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		const inspection = await inspectFileArgument(absolutePath);
		if (!inspection.ok) {
			console.error(chalk.red(`Error: ${inspection.error}`));
			process.exit(1);
		}

		if (inspection.stats.size === 0) {
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			const content = await readFile(absolutePath);
			const base64Content = content.toString("base64");

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: base64Content,
				};
			}

			images.push(attachment);

			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			try {
				const content = await readFile(absolutePath, "utf-8");
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
