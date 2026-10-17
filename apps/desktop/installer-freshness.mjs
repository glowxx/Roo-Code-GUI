import fs from "fs"
import path from "path"
import crypto from "crypto"
import { execSync } from "child_process"

/**
 * Resolves the expected installer filename from package.json and electron-builder build settings.
 * If build.artifactName is set, interpolates ${productName}, ${version}, ${arch}, and ${ext}.
 * Otherwise defaults to standard NSIS naming: `${productName} Setup ${version}.${ext}`.
 *
 * @param {Record<string, any>} pkgJson
 * @param {string} [arch="x64"]
 * @param {string} [ext="exe"]
 * @returns {string}
 */
export function getExpectedInstallerFilename(pkgJson, arch = "x64", ext = "exe") {
	const buildConfig = pkgJson.build || {}
	const productName = buildConfig.productName || pkgJson.name || "Roo Code"
	const version = pkgJson.version || "1.0.0"

	if (buildConfig.artifactName) {
		return buildConfig.artifactName
			.replace(/\${productName}/g, productName)
			.replace(/\${version}/g, version)
			.replace(/\${arch}/g, arch)
			.replace(/\${ext}/g, ext)
	}

	return `${productName} Setup ${version}.${ext}`
}

/**
 * Resolves the release output directory from package.json build settings.
 *
 * @param {Record<string, any>} pkgJson
 * @param {string} baseDir
 * @returns {string}
 */
export function getReleaseOutputDir(pkgJson, baseDir) {
	const out = pkgJson.build?.directories?.output || "release"
	return path.resolve(baseDir, out)
}

/**
 * Computes SHA-256 hash of a file.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileSha256(filePath) {
	const hash = crypto.createHash("sha256")
	const fileBuffer = fs.readFileSync(filePath)
	hash.update(fileBuffer)
	return hash.digest("hex").toUpperCase()
}

/**
 * Resolves the current git HEAD SHA.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
export function getGitHeadSha(cwd) {
	try {
		return execSync("git rev-parse HEAD", {
			cwd: cwd || process.cwd(),
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return "UNKNOWN"
	}
}

/**
 * Verifies that the installer in release directory is fresh, non-empty,
 * matches the current build session, and that no duplicate Fixed-911169b was generated.
 *
 * @param {Object} params
 * @param {Record<string, any>} params.packageJson
 * @param {string} params.desktopDir
 * @param {number} params.buildStartTimeMs
 * @param {{ exists: boolean, mtimeMs: number, size: number, sha256?: string } | null} [params.preBuildSnapshot]
 * @param {string} [params.releaseDir]
 * @param {string} [params.gitSha]
 * @param {boolean} [params.writeManifest=true]
 * @param {string} [params.manifestFilename="installer-manifest.json"]
 * @returns {{
 *   success: boolean,
 *   code?: string,
 *   error?: string,
 *   sourceGitSha?: string,
 *   installerFilename?: string,
 *   installerPath?: string,
 *   installerSize?: number,
 *   installerSha256?: string,
 *   installerLastWriteTime?: Date,
 *   manifestPath?: string,
 *   freshArtifactVerified?: boolean,
 * }}
 */
export function verifyInstallerFreshness(params) {
	const {
		packageJson,
		desktopDir,
		buildStartTimeMs,
		preBuildSnapshot = null,
		releaseDir = getReleaseOutputDir(packageJson, desktopDir),
		gitSha = null,
		writeManifest = true,
		manifestFilename = "installer-manifest.json",
	} = params

	const expectedFilename = getExpectedInstallerFilename(packageJson)
	const installerPath = path.join(releaseDir, expectedFilename)

	// 1. Check existence
	if (!fs.existsSync(installerPath)) {
		return {
			success: false,
			code: "NO_ARTIFACT",
			error: `Installer executable not found at expected location: ${installerPath}`,
		}
	}

	// 2. Check stats & size
	const stats = fs.statSync(installerPath)
	if (stats.size <= 0) {
		return {
			success: false,
			code: "EMPTY_FILE",
			error: `Generated installer has zero bytes: ${installerPath}`,
		}
	}

	// 3. Check for unauthorized duplicate Fixed installer generation
	if (fs.existsSync(releaseDir)) {
		const files = fs.readdirSync(releaseDir)
		for (const file of files) {
			if (file.toLowerCase().includes("fixed") && file.toLowerCase().endsWith(".exe")) {
				const fullPath = path.join(releaseDir, file)
				try {
					const fStats = fs.statSync(fullPath)
					// If a Fixed EXE was created or modified during this build:
					if (fStats.mtimeMs >= buildStartTimeMs - 2000) {
						return {
							success: false,
							code: "DUPLICATE_FIXED_GENERATED",
							error: `Disallowed duplicate Fixed installer was generated in this build session: ${file}`,
						}
					}
				} catch {}
			}
		}
	}

	// 4. Freshness check: Did the file get modified / created in this build?
	// Clock skew allowance: 2000ms
	const isMtimeStale = stats.mtimeMs < buildStartTimeMs - 2000
	const isUnchangedFromSnapshot =
		preBuildSnapshot &&
		preBuildSnapshot.exists &&
		stats.mtimeMs === preBuildSnapshot.mtimeMs &&
		stats.size === preBuildSnapshot.size

	if (isMtimeStale || isUnchangedFromSnapshot) {
		return {
			success: false,
			code: "STALE_ARTIFACT",
			error: `Stale artifact detected: LastWriteTime (${new Date(stats.mtimeMs).toISOString()}) predates or matches pre-build state without fresh output.`,
		}
	}

	// 5. Compute SHA-256
	const sha256 = computeFileSha256(installerPath)

	// 6. Source Git SHA
	const sourceGitSha = gitSha || getGitHeadSha(desktopDir)

	// 7. Write Manifest
	let manifestPath = ""
	if (writeManifest) {
		manifestPath = path.join(releaseDir, manifestFilename)
		const manifestData = {
			BUILD_STARTED_AT: new Date(buildStartTimeMs).toISOString(),
			BUILD_FINISHED_AT: new Date().toISOString(),
			SOURCE_GIT_SHA: sourceGitSha,
			INSTALLER_FILENAME: expectedFilename,
			INSTALLER_PATH: installerPath,
			INSTALLER_SIZE: stats.size,
			INSTALLER_SHA256: sha256,
			INSTALLER_LAST_WRITE_TIME: stats.mtime.toISOString(),
			FRESH_ARTIFACT_VERIFIED: true,
		}
		fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), "utf-8")
	}

	return {
		success: true,
		sourceGitSha,
		installerFilename: expectedFilename,
		installerPath,
		installerSize: stats.size,
		installerSha256: sha256,
		installerLastWriteTime: stats.mtime,
		manifestPath,
		freshArtifactVerified: true,
	}
}
