import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"
import {
	getExpectedInstallerFilename,
	getReleaseOutputDir,
	verifyInstallerFreshness,
} from "./installer-freshness.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Runs Windows packaging with fresh artifact verification.
 *
 * @param {Object} [options]
 * @param {boolean} [options.skipBuild=false]
 * @param {boolean} [options.verifyOnly=false]
 * @param {string} [options.desktopDir=__dirname]
 */
export async function runPackageAndVerify(options = {}) {
	const {
		skipBuild = false,
		verifyOnly = false,
		desktopDir = __dirname,
	} = options

	const pkgJsonPath = path.join(desktopDir, "package.json")
	const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"))
	const releaseDir = getReleaseOutputDir(pkgJson, desktopDir)
	const expectedFilename = getExpectedInstallerFilename(pkgJson)
	const installerPath = path.join(releaseDir, expectedFilename)

	// Ensure release directory exists
	if (!fs.existsSync(releaseDir)) {
		fs.mkdirSync(releaseDir, { recursive: true })
	}

	// 1. Take pre-build snapshot of the expected installer
	/** @type {{ exists: boolean, mtimeMs: number, size: number } | null} */
	let preBuildSnapshot = null
	if (fs.existsSync(installerPath)) {
		const stats = fs.statSync(installerPath)
		preBuildSnapshot = {
			exists: true,
			mtimeMs: stats.mtimeMs,
			size: stats.size,
		}
	} else {
		preBuildSnapshot = { exists: false, mtimeMs: 0, size: 0 }
	}

	const buildStartTimeMs = Date.now()
	const buildStartedAt = new Date(buildStartTimeMs).toISOString()

	if (!verifyOnly) {
		// Step A: Build application dist
		if (!skipBuild) {
			console.log("\n🔨 [PACKAGER] Step 1: Compiling application dist (build.mjs)...")
			try {
				execSync("node build.mjs", {
					cwd: desktopDir,
					stdio: "inherit",
					env: process.env,
				})
			} catch (err) {
				console.error("\n❌ [PACKAGER] Dist compilation failed (build.mjs returned non-zero exit code).")
				throw err
			}
		} else {
			console.log("\n⏩ [PACKAGER] Step 1: Skipping dist compilation (--skip-build specified).")
		}

		// Step B: Package Windows installer via electron-builder
		console.log("\n📦 [PACKAGER] Step 2: Packaging Windows installer via electron-builder...")
		let builderBin = "electron-builder"
		const localBin = path.join(desktopDir, "node_modules/.bin/electron-builder.cmd")
		const rootBin = path.join(desktopDir, "../../node_modules/.bin/electron-builder.cmd")
		if (fs.existsSync(localBin)) {
			builderBin = `"${localBin}"`
		} else if (fs.existsSync(rootBin)) {
			builderBin = `"${rootBin}"`
		}

		try {
			execSync(`${builderBin} --win --x64`, {
				cwd: desktopDir,
				stdio: "inherit",
				env: process.env,
			})
		} catch (err) {
			console.error("\n❌ [PACKAGER] electron-builder execution failed with non-zero exit code.")
			throw err
		}
	}

	// Step C: Verify artifact freshness and integrity
	console.log("\n🔍 [PACKAGER] Step 3: Verifying installer freshness and integrity...")
	const result = verifyInstallerFreshness({
		packageJson: pkgJson,
		desktopDir,
		buildStartTimeMs,
		preBuildSnapshot,
		releaseDir,
	})

	if (!result.success) {
		console.error(`\n❌ [PACKAGER] FRESHNESS VERIFICATION FAILED [${result.code}]: ${result.error}`)
		throw new Error(`FRESHNESS_VERIFICATION_FAILED: ${result.code} - ${result.error}`)
	}

	const buildFinishedAt = new Date().toISOString()
	console.log("\n=======================================================")
	console.log("ROO CODE GUI — WINDOWS INSTALLER BUILD SUCCESS")
	console.log("=======================================================")
	console.log(`STATUS:                    SUCCESS`)
	console.log(`SOURCE_GIT_SHA:            ${result.sourceGitSha}`)
	console.log(`BUILD_STARTED_AT:          ${buildStartedAt}`)
	console.log(`BUILD_FINISHED_AT:         ${buildFinishedAt}`)
	console.log(`INSTALLER_FILENAME:        ${result.installerFilename}`)
	console.log(`INSTALLER_PATH:            ${result.installerPath}`)
	console.log(`INSTALLER_SIZE:            ${result.installerSize?.toLocaleString()} bytes`)
	console.log(`INSTALLER_SHA256:          ${result.installerSha256}`)
	console.log(`INSTALLER_LAST_WRITE_TIME: ${result.installerLastWriteTime?.toISOString()}`)
	console.log(`FRESH_ARTIFACT_VERIFIED:   YES`)
	console.log(`MANIFEST_PATH:             ${result.manifestPath}`)
	console.log("=======================================================\n")

	return result
}

// Direct CLI execution
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const skipBuild = process.argv.includes("--skip-build")
	const verifyOnly = process.argv.includes("--verify-only")

	runPackageAndVerify({ skipBuild, verifyOnly })
		.then(() => process.exit(0))
		.catch((err) => {
			console.error(`\n❌ Packaging process failed: ${err.message}`)
			process.exit(1)
		})
}
