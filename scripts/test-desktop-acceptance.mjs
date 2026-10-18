import fs from "node:fs"
import { execFileSync } from "node:child_process"

const results = []
const started = new Date().toISOString()
let ready = false
for (let attempt = 0; attempt < 60; attempt++) {
	try { const response = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(2000) }); if (response.ok) { ready = true; break } } catch {}
	await new Promise(resolve => setTimeout(resolve, 1000))
}
if (!ready) throw new Error("Isolated Electron preview did not start on port 9223")
for (const [file, args] of [
	["test-product-runtime.mjs", []],
	["test-design-runtime.mjs", []],
	["test-model-selector-runtime.mjs", []],
	["test-agent-conversation-runtime.mjs", []],
	["test-agent-conversation-runtime.mjs", ["--light"]],
	["audit-interface-runtime.mjs", []],
	["audit-interface-runtime.mjs", ["--light"]],
]) {
	console.log(`Checking ${file} ${args.join(" ")}…`)
	const before = Date.now()
	try {
		const output = execFileSync(process.execPath, [`scripts/${file}`, ...args], { encoding: "utf8", windowsHide: true, timeout: 180000 })
		results.push({ file, args, passed: true, durationMs: Date.now() - before, output: output.trim() })
		console.log(output.trim())
	} catch (error) {
		results.push({ file, args, passed: false, error: String(error.stderr || error.message) })
		fs.writeFileSync(".design-qa/acceptance-results.json", JSON.stringify({ passed: false, started, results }, null, 2))
		throw error
	}
}
fs.writeFileSync(".design-qa/acceptance-results.json", JSON.stringify({ passed: true, started, completed: new Date().toISOString(), runtime: process.argv.includes("--portable") ? "Windows portable executable" : "development Electron", results }, null, 2))
console.log("All desktop acceptance scenarios passed.")
