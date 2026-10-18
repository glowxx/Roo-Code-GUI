import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
const require = createRequire(new URL("../src/package.json", import.meta.url))
const puppeteer = require("puppeteer-core")
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null })
console.log("Connected to Electron")
const results = []
try {
	const page = (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()))
	console.log("Desktop page selected")
	assert.ok(page, "Desktop page loaded")
	await page.reload({waitUntil:"domcontentloaded"})
	await page.setViewport({ width: 1300, height: 880 })
	if (await page.$("#settings-modal-backdrop:not(.hidden)"))
		await page.$eval("#close-settings-modal-btn", (el) => el.click())
	await page.$eval('[data-tab="chat"]', (el) => el.click())
	const errors = []
	page.on("pageerror", (e) => errors.push(e.message))
	await page.waitForSelector("#webview-frame")
	const agent = await (await page.$("#webview-frame")).contentFrame()
	await agent.waitForSelector(".workspace-hero h1", { timeout: 30000 })
	assert.equal(await agent.$eval("html", (el) => el.lang), "pl")
	assert.match(await agent.$eval(".workspace-hero", (el) => el.textContent), /Nad czym dziś pracujemy/)
	assert.equal(await agent.$('[role="dialog"]'), null, "No upstream extension announcement on startup")
	results.push("Polish desktop and agent loaded; no blocking announcement")
	console.log(results.at(-1))
	await agent.$eval(".agent-starter", (el) => el.click())
	assert.match(await agent.$eval("textarea", (el) => el.value), /Przeanalizuj strukturę tego projektu/)
	const dimensions = await agent.$eval(".composer-model", (el) => ({
		width: el.getBoundingClientRect().width,
		text: el.innerText,
	}))
	assert.ok(dimensions.width >= 160, "Model selector remains readable")
	results.push("Starter fills composer without sending; model selector remains readable")
	console.log(
		"Layout:",
		await page.evaluate(() => ({
			scrollY,
			header: document.querySelector(".app-header").getBoundingClientRect().toJSON(),
		})),
	)
	await page.screenshot({ path: ".design-qa/home.png" })
	await page.$eval('[data-tab="files"]', (el) => el.click())
	await page.waitForSelector('.file-node[data-path="README.md"]')
	await page.$eval('.file-node[data-path="README.md"]', (el) => el.click())
	await page.waitForFunction(
		() => document.querySelector("#preview-content-area")?.innerText.includes("Projekt demonstracyjny"),
		{ polling: 100 },
	)
	results.push("Project file tree and real README preview work")
	await page.screenshot({ path: ".design-qa/files.png" })
	await page.$eval('[data-tab="diffs"]', (el) => el.click())
	assert.match(await page.$eval("#tab-diffs", (el) => el.innerText), /Brak zmian/)
	await page.$eval('[data-tab="terminal"]', (el) => el.click())
	assert.match(await page.$eval("#terminal-sessions-list", (el) => el.innerText), /sesji terminala/)
	results.push("Changes and terminal views retain their empty states")
	await page.$eval('[data-tab="native-chat"]', (el) => el.click())
	await agent.waitForSelector(".native-chat-view:not(.hidden)")
	assert.match(await agent.$eval(".native-chat-view", (el) => el.innerText), /O czym porozmawiamy/)
	await page.screenshot({ path: ".design-qa/chat.png" })
	results.push("Standalone chat opens with Polish controls")
	await page.$eval("#open-settings-btn", (el) => el.click())
	await page.waitForSelector("#settings-modal-backdrop:not(.hidden)")
	const settings = await (await page.$("#settings-webview-frame")).contentFrame()
	await settings.waitForSelector('[data-testid="tab-appearance"]', { timeout: 30000 })
	await settings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await settings.waitForSelector('[data-testid="theme-card-clean-light"]')
	await page.screenshot({ path: ".design-qa/settings-dark.png" })
	await settings.$eval('[data-testid="theme-card-clean-light"]', (el) => el.click())
	await page.waitForFunction(() => document.body.dataset.theme === "clean-light", { polling: 100 })
	await settings.waitForFunction(() => document.body.dataset.theme === "clean-light", { polling: 100 })
	await agent.waitForFunction(() => document.body.dataset.theme === "clean-light", { polling: 100 })
	await page.screenshot({ path: ".design-qa/settings-light.png" })
	const colors = await settings.evaluate(() => ({
		bg: getComputedStyle(document.body).backgroundColor,
		fg: getComputedStyle(document.body).color,
	}))
	assert.notEqual(colors.bg, colors.fg)
	await settings.waitForFunction(
		() =>
			getComputedStyle(document.querySelector('[data-testid="theme-card-linear-dark"]')).backgroundColor ===
			"rgb(250, 250, 250)",
		{ polling: 100 },
	)
	const cardBg = await settings.$eval(
		'[data-testid="theme-card-linear-dark"]',
		(el) => getComputedStyle(el).backgroundColor,
	)
	assert.equal(cardBg, "rgb(250, 250, 250)", "Theme cards use light surfaces in the light theme")
	results.push("Settings open; light theme updates both shell and settings preview")
	await settings.$eval('[data-testid="theme-card-linear-dark"]', (el) => el.click())
	await page.$eval("#close-settings-modal-btn", (el) => el.click())
	await page.$eval('[data-tab="chat"]', (el) => el.click())
	await page.$eval("#sidebar-toggle-btn", (el) => el.click())
	assert.ok(await page.$eval("#app-sidebar", (el) => el.classList.contains("collapsed")))
	await page.$eval("#sidebar-toggle-btn", (el) => el.click())
	results.push("Sidebar collapse and restore work")
	await page.setViewport({ width: 900, height: 720 })
	assert.ok(await agent.$eval(".composer-model", (el) => el.getBoundingClientRect().width >= 160))
	assert.ok(
		await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
		"No horizontal overflow at narrow desktop width",
	)
	await page.screenshot({ path: ".design-qa/narrow.png" })
	results.push("Narrow 900px layout keeps controls accessible without horizontal overflow")
	await page.setViewport({ width: 1300, height: 880 })
	assert.deepEqual(errors, [], "No renderer JavaScript errors")
	fs.writeFileSync(".design-qa/results.json", JSON.stringify({ passed: true, results, errors }, null, 2))
	console.log(results.join("\n"))
} finally {
	browser.disconnect()
}
