import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
const require = createRequire(new URL("../src/package.json", import.meta.url))
const browser = await require("puppeteer-core").connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null })
const light = process.argv.includes("--light")
const prefix = process.argv.includes("--before") ? "before" : light ? "after-light" : "after"
try {
	const page = (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()))
	await page.reload({ waitUntil: "domcontentloaded" })
	await page.bringToFront()
	await page.setViewport({ width: 1300, height: 900 })
	const agent = await (await page.$("#webview-frame")).contentFrame()
	const errors = []
	const paletteChecks = []
	page.on("pageerror", (error) => errors.push(error.message))
	await agent.waitForSelector(".composer-model")
	await agent.addStyleTag({
		content: "*, *::before, *::after { animation:none !important; transition:none !important; }",
	})
	const applyPreview = async () => {
		const theme = light ? "clean-light" : "linear-dark"
		await agent.evaluate((theme) => window.parent.postMessage({ type: "themeChange", theme }, "*"), theme)
		await agent.waitForFunction(
			(theme) =>
				document.body.dataset.theme === theme &&
				getComputedStyle(document.body).colorScheme === (theme === "clean-light" ? "light" : "dark"),
			{ polling: 100 },
			theme,
		)
	}
	await applyPreview()
	const capture = async (name) => {
		// Keep the visual preview in the requested theme when isolated control tests
		// cause a saved-state broadcast. This uses the same preview event as Settings.
		if (!name.startsWith("theme-")) await applyPreview()
		const palette = await agent.evaluate(() => {
			const s = getComputedStyle(document.body)
			return {
				theme: document.body.dataset.theme,
				colorScheme: s.colorScheme,
				badge: s.getPropertyValue("--vscode-badge-background").trim(),
				active: s.getPropertyValue("--bg-active").trim(),
				foreground: s.getPropertyValue("--vscode-foreground").trim(),
				text: s.getPropertyValue("--text-primary").trim(),
			}
		})
		assert.equal(palette.badge, palette.active, "Embedded legacy theme must not override badge colours")
		assert.equal(palette.foreground, palette.text, "Embedded and desktop foreground colours share one palette")
		assert.equal(palette.colorScheme, palette.theme === "clean-light" ? "light" : "dark")
		paletteChecks.push({ view: name, ...palette })
		await page.screenshot({ path: `.design-qa/${prefix}-${name}.png` })
	}
	const close = async () => {
		await agent.$eval('[data-state="open"][role="dialog"]', (el) => el.focus())
		await page.keyboard.press("Escape")
		await agent.waitForFunction(() => !document.querySelector('[data-state="open"][role="dialog"]'), {
			polling: 100,
		})
	}
	for (const [name, selector] of [
		["reasoning", '[data-testid="reasoning-effort-trigger"]'],
		["approval", '[data-testid="auto-approve-dropdown-trigger"]'],
		["modes", '[data-testid="mode-selector-trigger"]'],
	]) {
		if (!(await agent.$(selector))) continue
		await agent.$eval(selector, (el) => {
			el.focus()
			el.click()
		})
		await agent.waitForFunction(() => document.querySelector('[data-state="open"][role="dialog"]'), {
			polling: 100,
		})
		await capture(name)
		if (name === "approval") {
			await agent.$eval('[data-testid="dropdown-mode-auto-btn"]', (el) => el.click())
			await agent.waitForFunction(() => document.body.innerText.includes("Samodzielna praca agenta"), {
				polling: 100,
			})
			await capture("approval-auto")
			await agent.$eval('[data-testid="dropdown-mode-manual-btn"]', (el) => el.click())
		}
		assert.ok(
			await agent.$eval('[data-state="open"][role="dialog"]', (el) => {
				const r = el.getBoundingClientRect()
				return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
			}),
			`${name} panel fits inside the agent viewport`,
		)
		await close()
	}
	await page.$eval("#open-settings-btn", (el) => el.click())
	const settings = await (await page.$("#settings-webview-frame")).contentFrame()
	await settings.waitForSelector('[data-testid="tab-appearance"]')
	await settings.addStyleTag({
		content: "*, *::before, *::after { animation:none !important; transition:none !important; }",
	})
	const tabs = await settings.$$eval('[data-testid^="tab-"]', (els) =>
		els.map((el) => ({ testId: el.dataset.testid, label: el.innerText })),
	)
	fs.writeFileSync(`.design-qa/${prefix}-settings-tabs.json`, JSON.stringify(tabs, null, 2))
	for (const tab of tabs) {
		await settings.$eval(`[data-testid="${tab.testId}"]`, (el) => el.click())
		await settings.waitForFunction(
			(id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute("aria-selected") === "true",
			{ polling: 100 },
			tab.testId,
		)
		await capture(`settings-${tab.testId}`)
	}
	await page.$eval("#close-settings-modal-btn", (el) => el.click())
	for (const tab of ["files", "diffs", "terminal", "native-chat", "chat"]) {
		await page.$eval(`[data-tab="${tab}"]`, (el) => el.click())
		await capture(tab)
	}
	// Visual fixture only: no request to a model and no saved conversation.
	await page.$eval('[data-tab="native-chat"]', (el) => el.click())
	await agent.evaluate(() =>
		window.postMessage(
			{
				type: "chatSessionData",
				chatSession: {
					id: "visual-fixture",
					title: "Przegląd projektu",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					modelPreference: {
						apiProvider: "xkiro",
						modelId: "openai/gpt-5.6-terra",
						reasoningEffort: "medium",
						webSearchMode: "auto",
					},
					messages: [
						{
							id: "fixture-user",
							role: "user",
							content: "Jak najlepiej uporządkować ten projekt?",
							timestamp: Date.now(),
						},
						{
							id: "fixture-assistant",
							role: "assistant",
							content:
								"Zacznij od oddzielenia widoków od logiki.\n\n- Wspólne kontrolki umieść w jednym miejscu.\n- Używaj tych samych kolorów i odstępów.\n\n```ts\nconst theme = { surface: 'canvas' }\n```",
							reasoning: "Sprawdzam strukturę i zależności pomiędzy modułami.",
							timestamp: Date.now(),
						},
					],
				},
			},
			"*",
		),
	)
	await agent.waitForFunction(() => document.body.innerText.includes("Zacznij od oddzielenia widoków"), {
		polling: 100,
	})
	await capture("conversation")
	await agent.evaluate(() => window.postMessage({ type: "chatSessionData", chatSession: null }, "*"))
	await page.$eval('[data-tab="chat"]', (el) => el.click())
	if (!light) {
		for (const theme of ["oled-black", "midnight-navy", "cyberpunk", "linear-dark"]) {
			await agent.evaluate((theme) => window.parent.postMessage({ type: "themeChange", theme }, "*"), theme)
			await agent.waitForFunction((theme) => document.body.dataset.theme === theme, { polling: 100 }, theme)
			await capture(`theme-${theme}`)
		}
	}
	assert.deepEqual(errors, [])
	fs.writeFileSync(
		`.design-qa/${prefix}-interface-results.json`,
		JSON.stringify(
			{
				passed: true,
				settingsPages: tabs.map((tab) => tab.label),
				capturedPanels: ["reasoning", "approval", "modes"],
				paletteChecks,
				errors,
			},
			null,
			2,
		),
	)
	console.log(
		`Verified ${prefix}: composer panels, ${tabs.length} settings pages, conversation and five desktop views`,
	)
} finally {
	browser.disconnect()
}
