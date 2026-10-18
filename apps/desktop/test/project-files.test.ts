import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readEditableFile, saveEditableFile, resolveProjectFolder } from "../src/main/project-files.js"

describe("project file editing", () => {
	let folder: string
	beforeEach(() => {
		folder = fs.mkdtempSync(path.join(os.tmpdir(), "roo-editor-"))
	})
	afterEach(() => {
		fs.rmSync(folder, { recursive: true, force: true })
	})
	it("validates folders instead of silently creating or resolving relative paths", () => {
		expect(resolveProjectFolder(folder)).toBe(fs.realpathSync(folder))
		expect(() => resolveProjectFolder("relative/path")).toThrow()
		expect(() => resolveProjectFolder(path.join(folder, "missing"))).toThrow()
	})
	it("preserves Unicode and detects concurrent edits without overwriting the file", () => {
		const file = path.join(folder, "zażółć.txt")
		fs.writeFileSync(file, "Początek\r\n")
		const original = readEditableFile(file)
		const saved = saveEditableFile(file, "Zmiana ✓\r\n", original.revision)
		expect(saved.conflict).toBe(false)
		expect(fs.readFileSync(file, "utf8")).toBe("Zmiana ✓\r\n")
		fs.writeFileSync(file, "Zmiana agenta\n")
		const conflict = saveEditableFile(file, "Zmiana użytkownika", saved.revision)
		expect(conflict.conflict).toBe(true)
		expect(conflict.content).toBe("Zmiana agenta\n")
		expect(fs.readFileSync(file, "utf8")).toBe("Zmiana agenta\n")
	})
	it("rejects binary, non UTF-8 and oversized files without modifying them", () => {
		const file = path.join(folder, "data")
		for (const data of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe, 1]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
			fs.writeFileSync(file, data)
			expect(() => readEditableFile(file)).toThrow()
			expect(fs.readFileSync(file)).toEqual(data)
		}
	})
	it("blocks path traversal and symlinks escaping allowed root", async () => {
		const { validatePathWithinRoot } = await import("../src/main/server.js")
		const outsideFolder = fs.mkdtempSync(path.join(os.tmpdir(), "roo-outside-"))
		const secretFile = path.join(outsideFolder, "secret.txt")
		fs.writeFileSync(secretFile, "sensitive data", "utf8")

		try {
			// 1. Direct path traversal
			const escapeResult = validatePathWithinRoot(path.join(folder, "..", "other.txt"), folder)
			expect(escapeResult.safe).toBe(false)

			// 2. In-workspace symlink pointing outside allowed root
			const symlinkPath = path.join(folder, "symlink-to-secret.txt")
			try {
				fs.symlinkSync(secretFile, symlinkPath)
				const symlinkResult = validatePathWithinRoot(symlinkPath, folder)
				expect(symlinkResult.safe).toBe(false)
				expect(symlinkResult.error).toMatch(/Access outside allowed directory/i)
			} catch (err: any) {
				// Windows may require elevated privileges for symlinks in some environments
				if (err?.code !== "EPERM") throw err
			}
		} finally {
			fs.rmSync(outsideFolder, { recursive: true, force: true })
		}
	})
})
