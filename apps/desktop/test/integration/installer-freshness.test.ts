import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { fileURLToPath } from "url"
import {
	getExpectedInstallerFilename,
	getReleaseOutputDir,
	computeFileSha256,
	getGitHeadSha,
	verifyInstallerFreshness,
} from "../../installer-freshness.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopDir = path.resolve(__dirname, "../..")

describe("Windows Installer Freshness, Stale Detection & Single Installer Verification (P1)", () => {
	let testTempDir = ""

	beforeEach(() => {
		testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-installer-test-"))
	})

	afterEach(() => {
		try {
			if (fs.existsSync(testTempDir)) {
				fs.rmSync(testTempDir, { recursive: true, force: true })
			}
		} catch {}
	})

	// TEST A: Fresh package creates standard Roo Code Setup EXE
	it("TEST A: Standard package creates Roo Code Setup <version>.exe without hardcoded strings", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}

		const filename = getExpectedInstallerFilename(pkgJson)
		expect(filename).toBe("Roo Code Setup 1.0.0.exe")

		// Dynamic version test (no hardcoding)
		const pkgJsonV2 = {
			name: "@roo-code/desktop",
			version: "2.3.4",
			build: {
				productName: "Roo Code",
			},
		}
		expect(getExpectedInstallerFilename(pkgJsonV2)).toBe("Roo Code Setup 2.3.4.exe")

		// Verify fresh creation passes
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		const exePath = path.join(releaseDir, filename)
		fs.writeFileSync(exePath, "dummy-installer-binary-content-v1.0.0")

		const buildStartTimeMs = Date.now() - 1000
		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs,
			releaseDir,
			writeManifest: true,
		})

		expect(result.success).toBe(true)
		expect(result.installerFilename).toBe("Roo Code Setup 1.0.0.exe")
		expect(result.freshArtifactVerified).toBe(true)
		expect(fs.existsSync(result.manifestPath!)).toBe(true)
	})

	// TEST B: If only stale EXE exists, packaging verification fails
	it("TEST B: Stale installer with LastWriteTime predating build start triggers STALE_ARTIFACT failure", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		const exePath = path.join(releaseDir, "Roo Code Setup 1.0.0.exe")
		fs.writeFileSync(exePath, "old-stale-binary-17-53")

		// Set file time to 5 hours ago (simulating 17:53 when build starts at 22:00)
		const staleTime = new Date(Date.now() - 5 * 3600 * 1000)
		fs.utimesSync(exePath, staleTime, staleTime)

		const preBuildSnapshot = {
			exists: true,
			mtimeMs: staleTime.getTime(),
			size: 23,
		}

		const buildStartTimeMs = Date.now() // current build started now

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs,
			preBuildSnapshot,
			releaseDir,
			writeManifest: false,
		})

		expect(result.success).toBe(false)
		expect(result.code).toBe("STALE_ARTIFACT")
		expect(result.error).toContain("Stale artifact detected")
	})

	// TEST C: If electron-builder exits with error, build fails
	it("TEST C: Missing installer executable triggers NO_ARTIFACT failure", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		// No EXE created (simulates electron-builder failure)

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: false,
		})

		expect(result.success).toBe(false)
		expect(result.code).toBe("NO_ARTIFACT")
		expect(result.error).toContain("Installer executable not found")
	})

	// TEST D: If EXE is created in wrong directory, verification fails
	it("TEST D: EXE in wrong directory triggers NO_ARTIFACT failure", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
				directories: { output: "release" },
			},
		}
		// File placed in wrong directory "dist" instead of "release"
		const wrongDir = path.join(testTempDir, "dist")
		fs.mkdirSync(wrongDir, { recursive: true })
		fs.writeFileSync(path.join(wrongDir, "Roo Code Setup 1.0.0.exe"), "content")

		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: false,
		})

		expect(result.success).toBe(false)
		expect(result.code).toBe("NO_ARTIFACT")
	})

	// TEST E: Correct HEAD SHA is recorded
	it("TEST E: Correct git HEAD SHA is recorded in verification result and manifest", () => {
		const expectedGitSha = getGitHeadSha(desktopDir)
		expect(expectedGitSha).toMatch(/^[0-9a-f]{40}$/i)

		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		const exePath = path.join(releaseDir, "Roo Code Setup 1.0.0.exe")
		fs.writeFileSync(exePath, "binary-content-for-git-sha-test")

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: true,
		})

		expect(result.success).toBe(true)
		expect(result.sourceGitSha).toBe(expectedGitSha)

		const manifest = JSON.parse(fs.readFileSync(result.manifestPath!, "utf-8"))
		expect(manifest.SOURCE_GIT_SHA).toBe(expectedGitSha)
		expect(manifest.FRESH_ARTIFACT_VERIFIED).toBe(true)
	})

	// TEST F: Generated EXE has valid SHA-256 and nonzero size
	it("TEST F: Rejects 0-byte files with EMPTY_FILE and generates valid SHA-256 for non-empty files", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		const exePath = path.join(releaseDir, "Roo Code Setup 1.0.0.exe")

		// 1. Zero byte file
		fs.writeFileSync(exePath, "")
		const emptyResult = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: false,
		})
		expect(emptyResult.success).toBe(false)
		expect(emptyResult.code).toBe("EMPTY_FILE")

		// 2. Valid binary content
		const sampleContent = Buffer.from("Windows-PE-binary-sample-content-1234567890")
		fs.writeFileSync(exePath, sampleContent)
		const expectedHash = crypto.createHash("sha256").update(sampleContent).digest("hex").toUpperCase()

		const validResult = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: false,
		})
		expect(validResult.success).toBe(true)
		expect(validResult.installerSize).toBe(sampleContent.length)
		expect(validResult.installerSha256).toBe(expectedHash)
		expect(validResult.installerSha256).toMatch(/^[0-9A-F]{64}$/)
	})

	// TEST G: No duplicate Fixed-911169b installer is generated
	it("TEST G: Rejects build if an unauthorized duplicate Fixed installer was generated in this session", () => {
		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
			},
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		const exePath = path.join(releaseDir, "Roo Code Setup 1.0.0.exe")
		fs.writeFileSync(exePath, "valid-fresh-main-installer")

		// Simulate an unwanted script generating a fresh Fixed installer
		const fixedExePath = path.join(releaseDir, "Roo Code Setup 1.0.0 (Fixed-911169b).exe")
		fs.writeFileSync(fixedExePath, "unwanted-duplicate-fixed-installer")

		const buildStartTimeMs = Date.now() - 1000

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs,
			releaseDir,
			writeManifest: false,
		})

		expect(result.success).toBe(false)
		expect(result.code).toBe("DUPLICATE_FIXED_GENERATED")
		expect(result.error).toContain("Disallowed duplicate Fixed installer was generated")
	})

	// TEST H: Changing source files causes recompilation of the relevant packaged assets
	it("TEST H: Desktop build.mjs copies fresh assets and validates syntax", () => {
		const buildScriptPath = path.join(desktopDir, "build.mjs")
		expect(fs.existsSync(buildScriptPath)).toBe(true)
		const buildScriptContent = fs.readFileSync(buildScriptPath, "utf-8")

		// Confirm build.mjs compiles main, preload, validates syntax and bundles webview & engine
		expect(buildScriptContent).toContain("node -c")
		expect(buildScriptContent).toContain("dist/engine")
		expect(buildScriptContent).toContain("dist/webview")
		expect(buildScriptContent).toContain("ripgrep")
	})

	// TEST I: Normal build does not modify production storage
	it("TEST I: Verification does not modify production APPDATA or storage directories", () => {
		const realAppData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming")
		const realRooConfig = path.join(realAppData, "Roo Code", "desktop-config.json")
		const realStorageDir = path.join(process.env.USERPROFILE || "", ".roo-desktop-data")

		const configBefore = fs.existsSync(realRooConfig) ? fs.statSync(realRooConfig).mtimeMs : 0
		const storageBefore = fs.existsSync(realStorageDir) ? fs.statSync(realStorageDir).mtimeMs : 0

		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: { productName: "Roo Code" },
		}
		const releaseDir = path.join(testTempDir, "release")
		fs.mkdirSync(releaseDir, { recursive: true })
		fs.writeFileSync(path.join(releaseDir, "Roo Code Setup 1.0.0.exe"), "content")

		verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: testTempDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: true,
		})

		if (fs.existsSync(realRooConfig)) {
			expect(fs.statSync(realRooConfig).mtimeMs).toBe(configBefore)
		}
		if (fs.existsSync(realStorageDir)) {
			expect(fs.statSync(realStorageDir).mtimeMs).toBe(storageBefore)
		}
	})

	// TEST J: Package verification handles paths containing spaces and Windows special characters
	it("TEST J: Handles directories and file names with spaces, parentheses and brackets", () => {
		const specialDir = path.join(testTempDir, "Roo Code (Test [Special] & Space)")
		const releaseDir = path.join(specialDir, "release output")
		fs.mkdirSync(releaseDir, { recursive: true })

		const pkgJson = {
			name: "@roo-code/desktop",
			version: "1.0.0",
			build: {
				productName: "Roo Code",
				directories: { output: "release output" },
			},
		}

		const exeName = "Roo Code Setup 1.0.0.exe"
		const exePath = path.join(releaseDir, exeName)
		fs.writeFileSync(exePath, "special-path-binary-content")

		const result = verifyInstallerFreshness({
			packageJson: pkgJson,
			desktopDir: specialDir,
			buildStartTimeMs: Date.now() - 1000,
			releaseDir,
			writeManifest: true,
		})

		expect(result.success).toBe(true)
		expect(result.installerPath).toBe(exePath)
		expect(fs.existsSync(result.manifestPath!)).toBe(true)
	})
})
