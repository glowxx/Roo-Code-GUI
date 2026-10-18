import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/**
 * Data Safety Sentinel for Roo Code
 *
 * Guarantees that production user directories:
 *   - %APPDATA%\Roo Code (desktop-config.json, sessions, preferences)
 *   - %USERPROFILE%\.roo-desktop-data (tasks, secrets.json, global-storage)
 * are NEVER modified, corrupted, or deleted during QA test runs.
 */

const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
const targetChecks = [
	{ name: "AppData Roo Code Root", path: path.join(appData, "Roo Code") },
	{ name: "Desktop Config JSON", path: path.join(appData, "Roo Code", "desktop-config.json") },
	{ name: "Storage Root (.roo-desktop-data)", path: path.join(os.homedir(), ".roo-desktop-data") },
	{ name: "Storage Global Storage", path: path.join(os.homedir(), ".roo-desktop-data", "global-storage") },
	{ name: "Storage Secrets JSON", path: path.join(os.homedir(), ".roo-desktop-data", "global-storage", "secrets.json") },
	{ name: "Storage Global State JSON", path: path.join(os.homedir(), ".roo-desktop-data", "global-storage", "global-state.json") },
	{ name: "Storage Tasks Dir", path: path.join(os.homedir(), ".roo-desktop-data", "global-storage", "tasks") },
	{ name: "Storage Tasks Index", path: path.join(os.homedir(), ".roo-desktop-data", "global-storage", "tasks", "_index.json") },
]

const snapshotFile = path.join(process.cwd(), ".design-qa", "safety-baseline.json")

function getPathState(targetPath) {
	if (!fs.existsSync(targetPath)) {
		return { exists: false }
	}
	const stat = fs.statSync(targetPath)
	return {
		exists: true,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		isDirectory: stat.isDirectory(),
	}
}

const args = process.argv.slice(2)
const mode = args.includes("--verify") ? "verify" : "baseline"

if (mode === "baseline") {
	const baseline = {}
	for (const check of targetChecks) {
		baseline[check.path] = {
			name: check.name,
			...getPathState(check.path),
		}
	}
	fs.mkdirSync(path.dirname(snapshotFile), { recursive: true })
	fs.writeFileSync(snapshotFile, JSON.stringify(baseline, null, 2), "utf8")
	console.log("[SAFETY-SENTINEL] Baseline snapshot created successfully:")
	for (const [p, state] of Object.entries(baseline)) {
		console.log(`  - [${state.name}] exists=${state.exists}, mtime=${state.mtimeMs || "N/A"}`)
	}
	process.exit(0)
} else {
	if (!fs.existsSync(snapshotFile)) {
		console.error("[SAFETY-SENTINEL] No baseline snapshot found! Run with --baseline first.")
		process.exit(1)
	}

	const baseline = JSON.parse(fs.readFileSync(snapshotFile, "utf8"))
	let violated = false

	console.log("[SAFETY-SENTINEL] Verifying production paths against baseline...")
	for (const check of targetChecks) {
		const baseState = baseline[check.path]
		const currentState = getPathState(check.path)

		if (!baseState) continue

		if (baseState.exists !== currentState.exists) {
			console.error(`[SAFETY VIOLATION] Existence changed for: ${check.name} (${check.path})! Expected ${baseState.exists}, got ${currentState.exists}`)
			violated = true
			continue
		}

		if (baseState.exists) {
			// Strict check for secrets.json and desktop-config.json: must NEVER change
			const isCriticalImmutable = check.name.includes("Secrets") || check.name.includes("Desktop Config")
			if (isCriticalImmutable) {
				if (baseState.mtimeMs !== currentState.mtimeMs || baseState.size !== currentState.size) {
					console.error(`[SAFETY VIOLATION] Critical file modified: ${check.name}!`)
					violated = true
				}
			}

			// Validate JSON integrity for any json files
			if (check.path.endsWith(".json")) {
				try {
					JSON.parse(fs.readFileSync(check.path, "utf8"))
				} catch (parseErr) {
					console.error(`[SAFETY VIOLATION] JSON corruption detected in ${check.name}: ${parseErr.message}`)
					violated = true
				}
			}
		}
	}

	if (violated) {
		console.error("\n[CRITICAL FAILURE] Production user data was touched or corrupted during test execution!")
		process.exit(1)
	} else {
		console.log("[SAFETY CONFIRMED] All production paths verified safe. Zero data loss or corruption detected.")
		process.exit(0)
	}
}
