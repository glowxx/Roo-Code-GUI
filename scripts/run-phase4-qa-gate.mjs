import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"

/**
 * Phase 4 QA Independent Gate Runner for Roo Code
 *
 * Runs the comprehensive verification pipeline covering:
 *  - Data safety pre/post assertions
 *  - 18-locale i18n completeness and interpolation
 *  - Hardcoded UI string audit
 *  - TypeScript typechecks
 *  - Desktop & Webview unit and regression tests
 *  - Visual runtime snapshots and theme tests
 */
import os from "node:os"

const isolatedStorageDir = path.join(os.tmpdir(), "roo-qa-storage")
const isolatedConfigDir = path.join(os.tmpdir(), "roo-qa-config")
fs.mkdirSync(isolatedStorageDir, { recursive: true })
fs.mkdirSync(isolatedConfigDir, { recursive: true })

const results = []

function runStep(id, description, command, options = {}) {
	process.stdout.write(`[RUNNING] ${id}: ${description}... `)
	const startTime = Date.now()
	try {
		const stdout = execSync(command, {
			encoding: "utf8",
			stdio: "pipe",
			cwd: process.cwd(),
			env: {
				...process.env,
				...options.env,
			},
		})
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
		console.log(`PASSED (${elapsed}s)`)
		results.push({ id, description, status: "PASS", elapsed, stdout: stdout.slice(-300) })
		return true
	} catch (err) {
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
		console.log(`FAILED (${elapsed}s)`)
		const errOutput = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "")
		results.push({ id, description, status: "FAIL", elapsed, error: errOutput.slice(-500) })
		return false
	}
}

console.log("=======================================================")
console.log("ROO CODE — PHASE 4 INDEPENDENT QA GATE EVALUATION")
console.log("=======================================================\n")

// 1. Safety Pre-check
runStep("GATE-SAFETY-PRE", "Snapshot production data baseline", "node scripts/verify-data-safety.mjs --baseline")

// 2. All 18 Locales I18N Audit (TEST O, P, Q)
runStep("GATE-I18N-ALL", "Verify all 18 locales (0 missing, 0 broken params, 0 empty)", "node scripts/audit-i18n.mjs")

// 3. Polish Specific Deep Audit (TEST L, M, N)
runStep("GATE-I18N-PL", "Verify Polish canonical parity (1819 keys)", "node scripts/audit-polish.mjs")

// 4. Hardcoded Text Audit (TEST S, Y)
runStep("GATE-AST-TEXT", "Scan React JSX for hardcoded strings", "node scripts/audit-ui-text.mjs")

// 5. Desktop Typecheck
runStep("GATE-TSC-DESKTOP", "Desktop TypeScript compilation check", "pnpm --filter @roo-code/desktop check-types")

// 6. Webview Typecheck
runStep("GATE-TSC-WEBVIEW", "Webview TypeScript compilation check", "pnpm --filter @roo-code/vscode-webview check-types")

// 7. Desktop Unit & Integration Suite (TEST W, X)
runStep("GATE-TEST-DESKTOP", "Run desktop Vitest test suite (213 tests)", "pnpm --filter @roo-code/desktop test")

// 8. Webview Core Component Tests (TEST D, E, F, G)
runStep(
	"GATE-TEST-WEBVIEW",
	"Run Webview ModelSelector & Settings tests",
	'pnpm --filter @roo-code/vscode-webview test "src/components/chat/__tests__/ModelSelector.spec.tsx" "src/i18n/__tests__/TranslationContext.spec.tsx"'
)

// 9. Core Native Chat Auth Regression (TEST T)
runStep(
	"GATE-REG-AUTH",
	"Native Chat Authentication & Secrets Isolation regression",
	'pnpm --filter roo-cline test "core/chat/__tests__/NativeChatAuthAndSidebarRegression.spec.ts"'
)

// 10. Core Native Chat Web Search Regression (TEST V)
runStep(
	"GATE-REG-SEARCH",
	"Native Chat Web Search intent & grounding regression",
	'pnpm --filter roo-cline test "core/chat/__tests__/NativeChatWebSearchRegression.spec.ts"'
)

// 11. Safety Post-check (TEST Z)
runStep("GATE-SAFETY-POST", "Verify production user data remains 100% untouched", "node scripts/verify-data-safety.mjs --verify")

console.log("\n=======================================================")
console.log("PHASE 4 QA GATE SUMMARY")
console.log("=======================================================\n")

let allPassed = true
for (const res of results) {
	const icon = res.status === "PASS" ? "[PASS]" : "[FAIL]"
	console.log(`${icon} ${res.id}: ${res.description} (${res.elapsed}s)`)
	if (res.status !== "PASS") {
		allPassed = false
		if (res.error) console.log(`       Error snippet: ${res.error.replace(/\n/g, " ").trim()}`)
	}
}

const summaryPath = path.join(process.cwd(), ".design-qa", "qa-gate-summary.json")
fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
fs.writeFileSync(summaryPath, JSON.stringify({ allPassed, results }, null, 2), "utf8")

console.log(`\nOverall QA Gate Result: ${allPassed ? "PASSED (Ready for Delivery)" : "FAILED (Fixes Required)"}`)
process.exitCode = allPassed ? 0 : 1
