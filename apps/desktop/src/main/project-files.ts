import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export function resolveProjectFolder(input: unknown): string {
	if (typeof input !== "string" || !input.trim() || !path.isAbsolute(input.trim()))
		throw new Error("Podaj pełną ścieżkę folderu projektu.")
	const target = fs.realpathSync(input.trim())
	if (!fs.statSync(target).isDirectory()) throw new Error("Ta ścieżka nie wskazuje folderu.")
	return target
}

export function readEditableFile(filePath: string) {
	const stat = fs.statSync(filePath)
	if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Edytor obsługuje pliki tekstowe do 1 MB.")
	const data = fs.readFileSync(filePath)
	if (data.includes(0) || !Buffer.from(data.toString("utf8"), "utf8").equals(data))
		throw new Error("Edytor obsługuje pliki tekstowe w UTF-8.")
	return { content: data.toString("utf8"), revision: createHash("sha256").update(data).digest("hex") }
}

/** Optimistic concurrency: do not overwrite edits made by an agent or another editor. */
export function saveEditableFile(filePath: string, content: unknown, revision: unknown) {
	if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024)
		throw new Error("Plik przekracza limit edytora (1 MB).")
	const current = readEditableFile(filePath)
	if (typeof revision !== "string" || current.revision !== revision) {
		return { conflict: true as const, ...current }
	}
	fs.writeFileSync(filePath, content, "utf8")
	return { conflict: false as const, ...readEditableFile(filePath) }
}
