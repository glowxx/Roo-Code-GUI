import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
const require = createRequire(new URL("../src/package.json", import.meta.url))
const browser = await require("puppeteer-core").connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null })
const results = []
try {
	const page = (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()))
	assert.ok(page)
	await page.bringToFront()
	await page.setViewport({ width: 1300, height: 900 })
	const errors = []
	page.on("pageerror", (e) => errors.push(e.message))
	await page.waitForSelector("#webview-frame")
	const agent = await (await page.$("#webview-frame")).contentFrame()
	await agent.waitForSelector(".composer-model", { timeout: 30000 })
	await agent.addStyleTag({
		content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
	})
	if (await agent.$(".model-selector-panel")) await page.keyboard.press("Escape")
	const open = async () => {
		await agent.$eval(".composer-model", (el) => {
			el.focus()
			el.click()
		})
		await agent.waitForSelector(".model-selector-panel")
		await agent.waitForFunction(
			() =>
				document
					.querySelector(".model-selector-panel")
					.getAnimations()
					.every((a) => a.playState === "finished"),
			{ polling: 100 },
		)
	}
	await open()
	const dimensions = await agent.$eval(".model-selector-panel", (el) => ({
		width: el.getBoundingClientRect().width,
		overflow: el.scrollWidth > el.clientWidth,
	}))
	assert.equal(dimensions.width, 456)
	assert.equal(dimensions.overflow, false)
	assert.equal(await agent.$eval(".model-selector-search input", (el) => el === document.activeElement), true)
	assert.equal(await agent.$(".model-quick-section"), null)
	await page.screenshot({ path: ".design-qa/model-picker-dark.png" })
	await agent.$eval("[data-model-family] .model-section-toggle", (el) => {
		if (el.getAttribute("aria-expanded") === "false") el.click()
	})
	assert.ok(await agent.$eval(".model-option", (el) => el.getBoundingClientRect().height >= 64))
	await agent.$eval(".model-selector-search input", (el) => el.focus())
	results.push("456px panel, readable rows, autofocus and no horizontal overflow")
	await page.keyboard.press("ArrowDown")
	assert.equal(await agent.evaluate(() => document.activeElement?.hasAttribute("data-model-option")), true)
	const chosen = await agent.evaluate(() => document.activeElement.dataset.modelId)
	await page.keyboard.press("Enter")
	await agent.waitForFunction(() => !document.querySelector(".model-selector-panel"), { polling: 100 })
	await open()
	await agent.waitForFunction(
		(id) =>
			Array.from(document.querySelectorAll('[data-model-option][aria-pressed="true"]')).some(
				(el) => el.dataset.modelId === id,
			),
		{ polling: 100 },
		chosen,
	)
	assert.equal(await agent.$('[aria-labelledby="models-recent-heading"]'), null)
	assert.equal(await agent.$('[aria-labelledby="models-recommended-heading"]'), null)
	assert.equal(
		await agent.$$eval(
			"[data-model-option]",
			(rows) => new Set(rows.map((row) => row.dataset.modelId)).size === rows.length,
		),
		true,
	)
	results.push(
		"Keyboard selection persists the active model; all models belong to families with no duplicates or quick sections",
	)
	await agent.$eval(".model-selector-search input", (el) => el.focus())
	await page.keyboard.type("no-such-model-qa")
	await agent.waitForSelector(".model-selector-empty")
	assert.equal(
		await agent.$$eval("[data-model-option]", (els) => els.length),
		1,
		"Unmatched search retains the custom model option",
	)
	assert.equal(await agent.$eval("[data-model-option]", (el) => el.dataset.modelId), "no-such-model-qa")
	await agent.$eval('[aria-label="Wyczyść wyszukiwanie"]', (el) => el.click())
	await agent.waitForSelector("[data-model-option]")
	const filter = await agent.$('.model-selector-filters button:not([aria-pressed="true"])')
	if (filter) {
		await filter.evaluate((el) => el.click())
		assert.equal(await agent.$$eval('.model-selector-filters button[aria-pressed="true"]', (els) => els.length), 1)
		await agent.$eval(".model-selector-filters button", (el) => el.click())
	}
	results.push("Search empty state, clear action and capability filters work")
	const families = await agent.$$eval("[data-model-family]", (groups) =>
		groups.map((group) => ({
			family: group.dataset.modelFamily,
			models: group.querySelectorAll("[data-model-option]").length,
		})),
	)
	assert.ok(families.length > 0)
	assert.ok(families.every((group) => group.models > 0))
	await agent.$eval(".model-selector-list", (el) => {
		el.scrollTop = 0
	})
	await page.screenshot({ path: ".design-qa/model-families-dark.png" })
	const firstFamily = families[0].family
	await agent.$eval("[data-model-family] .model-section-toggle", (el) => el.click())
	assert.equal(
		await agent.$eval("[data-model-family] .model-section-toggle", (el) => el.getAttribute("aria-expanded")),
		"true",
	)
	await page.screenshot({ path: ".design-qa/model-family-expanded.png" })
	await agent.$eval("[data-model-family] .model-section-toggle", (el) => el.click())
	assert.equal(
		await agent.$eval("[data-model-family] .model-section-toggle", (el) => el.getAttribute("aria-expanded")),
		"false",
	)
	if (families.length > 1) {
		await agent.$eval("[data-model-family]:nth-of-type(2) .model-section-toggle", (el) => el.click())
		await agent.$eval(".model-selector-search input", (el) => el.focus())
		await page.keyboard.press("ArrowDown")
		assert.notEqual(
			await agent.evaluate(() => document.activeElement.closest("[data-model-family]")?.dataset.modelFamily),
			firstFamily,
		)
		await agent.$eval("[data-model-family]:nth-of-type(2) .model-section-toggle", (el) => el.click())
	}
	results.push("Family groups contain models; families collapse; keyboard skips hidden rows")
	await page.keyboard.press("Escape")
	await page.$eval("#open-settings-btn", (el) => el.click())
	await page.waitForSelector("#settings-modal-backdrop:not(.hidden)")
	const settings = await (await page.$("#settings-webview-frame")).contentFrame()
	await settings.waitForSelector('[data-testid="tab-appearance"]', { timeout: 30000 })
	await settings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await settings.$eval('[data-testid="theme-card-linear-dark"]', (el) => el.click())
	await settings.$eval('[data-testid="theme-card-clean-light"]', (el) => el.click())
	await agent.waitForFunction(() => document.body.dataset.theme === "clean-light", { polling: 100 })
	await page.$eval("#close-settings-modal-btn", (el) => el.click())
	// Let the theme broadcast and React remount settle before opening the menu again.
	await new Promise((resolve) => setTimeout(resolve, 500))
	await open()
	await page.screenshot({ path: ".design-qa/model-picker-light.png" })
	await agent.$eval(".model-selector-list", (el) => {
		el.scrollTop = 0
	})
	await page.screenshot({ path: ".design-qa/model-families-light.png" })
	await page.keyboard.press("Escape")
	await page.setViewport({ width: 900, height: 720 })
	await open()
	await agent.waitForFunction(
		() => {
			const r = document.querySelector(".model-selector-panel").getBoundingClientRect()
			return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
		},
		{ polling: 100 },
	)
	const fits = await agent.$eval(".model-selector-panel", (el) => {
		const r = el.getBoundingClientRect()
		return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
	})
	assert.ok(fits, "Panel fits the narrow desktop viewport")
	await page.screenshot({ path: ".design-qa/model-picker-narrow.png" })
	results.push("Light theme and 900px desktop layout remain readable and inside viewport")
	await page.keyboard.press("Escape")
	await page.setViewport({ width: 1300, height: 900 })
	await page.$eval("#open-settings-btn", (el) => el.click())
	await settings.$eval('[data-testid="theme-card-linear-dark"]', (el) => el.click())
	await agent.waitForFunction(() => document.body.dataset.theme === "linear-dark", { polling: 100 })
	await page.$eval("#close-settings-modal-btn", (el) => el.click())
	assert.deepEqual(errors, [])
	fs.writeFileSync(".design-qa/model-picker-results.json", JSON.stringify({ passed: true, results, errors }, null, 2))
	console.log(results.join("\n"))
} finally {
	browser.disconnect()
}
