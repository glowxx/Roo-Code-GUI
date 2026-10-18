import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
const require = createRequire(new URL("../src/package.json", import.meta.url))
const browser = await require("puppeteer-core").connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null })
const root = path.resolve(".design-qa/workspace")
const second = path.resolve(".design-qa/Drugi projekt")
fs.mkdirSync(second, { recursive: true })
fs.writeFileSync(path.join(second, "Plik z nazwą.txt"), "Drugi projekt\n")
if (!fs.existsSync(path.join(second, ".git"))) {
	for (const args of [
		["init"],
		["add", "."],
		["-c", "user.name=Interface QA", "-c", "user.email=qa@localhost", "commit", "-m", "Isolated UI fixture"],
	])
		execFileSync("git", args, { cwd: second, stdio: "ignore", windowsHide: true })
}
const results = []
try {
	const page = (await browser.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url()))
	const errors = []
	page.on("pageerror", (error) => errors.push(error.message))
	await page.reload({ waitUntil: "domcontentloaded" })
	await page.setViewport({ width: 1400, height: 920 })
	await page.waitForSelector("#project-switcher strong")
	const agent = await (await page.$("#webview-frame")).contentFrame()
	await agent.waitForSelector(".project-context-add", { timeout: 30000 })
	const staticStyle = "*, *::before, *::after { animation:none !important; transition:none !important; }"
	await page.addStyleTag({ content: staticStyle })
	await agent.addStyleTag({ content: staticStyle })
	const click = async (selector) => page.$eval(selector, (el) => el.click())
	const fill = async (selector, value) =>
		page.$eval(
			selector,
			(el, text) => {
				el.value = text
				el.dispatchEvent(new Event("input", { bubbles: true }))
			},
			value,
		)
	const open = async (folder) => {
		await click("#project-switcher")
		await page.waitForSelector("#project-path-input")
		await fill("#project-path-input", folder)
		await page.$eval(".project-path-form", (el) => el.requestSubmit())
		await page.waitForFunction(() => !document.querySelector(".product-backdrop"), { timeout: 15000, polling: 100 })
		await agent.waitForFunction(
			(folder) => document.body.innerText.includes(folder) || !!document.querySelector(".project-context-add"),
			{},
			folder,
		)
	}
	// Every run starts from the same saved palette, including after interrupted QA.
	await click("#workspace-settings-button")
	const initialSettings = await (await page.$("#settings-webview-frame")).contentFrame()
	await initialSettings.waitForSelector('[data-testid="tab-appearance"]', { timeout: 30000 })
	await initialSettings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await initialSettings.waitForSelector('[data-testid="theme-card-linear-dark"]')
	await initialSettings.$eval('[data-testid="theme-card-linear-dark"]', (el) => el.click())
	if (!(await initialSettings.$eval('[data-testid="save-button"]', (el) => el.disabled))) {
		await initialSettings.$eval('[data-testid="save-button"]', (el) => el.click())
		await initialSettings.waitForFunction(() => document.querySelector('[data-testid="save-button"]').disabled)
	}
	await click("#close-settings-modal-btn")
	await page.waitForSelector("#settings-modal-backdrop.hidden")
	await open(root)
	await agent.$eval("textarea", (el) => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "Moja robocza wiadomość")
		el.dispatchEvent(new Event("input", { bubbles: true }))
	})
	await click("#project-switcher")
	await fill("#project-path-input", path.join(root, "nie-istnieje"))
	await page.$eval(".project-path-form", (el) => el.requestSubmit())
	await page.waitForFunction(() => !!document.querySelector(".product-inline-error")?.textContent)
	assert.match(await agent.$eval("textarea", (el) => el.value), /Moja robocza/)
	assert.equal(await page.evaluate(() => document.querySelector("#project-switcher").title), root)
	await page.screenshot({ path: ".design-qa/product-project-validation.png" })
	await click(".product-dialog header button")
	results.push("Invalid project path preserves the current project and draft")
	await open(second)
	const outside = path.resolve(".design-qa/outside-editor.txt")
	fs.writeFileSync(outside, "Nie nadpisuj")
	const outsideStatus = await page.evaluate(async (file) => {
		const response = await fetch("/api/editor?path=" + encodeURIComponent(file), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: "Błąd", revision: "invalid" }),
		})
		return response.status
	}, outside)
	assert.equal(outsideStatus, 403)
	assert.equal(fs.readFileSync(outside, "utf8"), "Nie nadpisuj")
	results.push("The editor refuses writes outside the selected project")
	assert.equal(await page.evaluate(() => document.querySelector("#project-switcher").title), second)
	await click("#project-switcher")
	assert.equal((await page.$$(".project-manager-row").then((rows) => rows.length)) >= 2, true)
	await page.screenshot({ path: ".design-qa/product-projects.png" })
	await click(".product-dialog header button")
	await agent.$eval(".project-context-add", (el) => el.click())
	await agent.waitForSelector('.context-picker-files button[title="Plik z nazwą.txt"]')
	await agent.$eval('.context-picker-files button[title="Plik z nazwą.txt"]', (el) => el.click())
	assert.match(await agent.$eval("textarea", (el) => el.value), /@\/Plik\\ z\\ nazwą.txt/)
	await page.screenshot({ path: ".design-qa/product-context.png" })
	await agent.$eval(".context-picker-footer button:last-child", (el) => el.click())
	await agent.$eval(".project-context-chip button", (el) => el.click())
	assert.doesNotMatch(await agent.$eval("textarea", (el) => el.value), /Plik/)
	results.push("File context picker supports spaces, selection and removal")
	await click('[data-tab="files"]')
	await page.waitForSelector('.file-node[data-path="Plik z nazwą.txt"]')
	await click('.file-node[data-path="Plik z nazwą.txt"]')
	await page.waitForFunction(() =>
		document.querySelector("#preview-content-area").innerText.includes("Drugi projekt"),
	)
	await click("#preview-add-context-btn")
	await agent.waitForSelector(".project-context-chip")
	results.push("A file preview can attach context to the agent composer")
	await click('[data-tab="files"]')
	await click("#preview-edit-btn")
	await page.waitForSelector("#project-file-editor")
	await fill("#project-file-editor", "Zapis użytkownika ✓\n")
	await click("#editor-save")
	await page.waitForFunction(() => document.querySelector("#editor-state").textContent === "Zapisano")
	assert.equal(fs.readFileSync(path.join(second, "Plik z nazwą.txt"), "utf8"), "Zapis użytkownika ✓\n")
	await click("#project-switcher")
	await page.waitForSelector("#project-path-input")
	await click(".product-dialog header button")
	await page.waitForFunction(() => !document.querySelector("#project-file-editor"))
	await click("#preview-edit-btn")
	await page.waitForSelector("#project-file-editor")
	await fill("#project-file-editor", "Niezapisana wersja użytkownika\n")
	fs.writeFileSync(path.join(second, "Plik z nazwą.txt"), "Zmiana agenta\n")
	await click("#editor-save")
	await page.waitForFunction(() => document.querySelector("#editor-error").textContent.includes("zmieniony na dysku"))
	assert.equal(fs.readFileSync(path.join(second, "Plik z nazwą.txt"), "utf8"), "Zmiana agenta\n")
	assert.match(await page.$eval("#project-file-editor", (el) => el.value), /Niezapisana wersja/)
	await page.screenshot({ path: ".design-qa/product-editor-conflict.png" })
	await click('[data-tab="chat"]')
	await page.waitForSelector("#editor-stay")
	await click("#editor-stay")
	assert.ok(await page.$("#project-file-editor"))
	await click('[data-tab="chat"]')
	await page.waitForSelector("#editor-discard")
	await click("#editor-discard")
	await page.waitForFunction(() => document.querySelector('[data-tab="chat"]').classList.contains("active"))
	results.push("Real file save, external-write conflict and unsaved-navigation protection work")
	await click('[data-tab="diffs"]')
	await page.waitForSelector('.diff-item[data-file-path="Plik z nazwą.txt"]')
	await click('.diff-item[data-file-path="Plik z nazwą.txt"]')
	await page.waitForFunction(() => document.querySelector("#diff-content").innerText.includes("Zmiana agenta"))
	await page.screenshot({ path: ".design-qa/product-real-diff.png" })
	results.push("Actual Git changes with Polish file names open in the diff view")
	await agent.focus("textarea")
	await page.keyboard.down("Control")
	await page.keyboard.press("k")
	await page.keyboard.up("Control")
	await page.waitForSelector("#product-command-search")
	await fill("#product-command-search", "Ustawienia")
	await page.focus("#product-command-search")
	await page.keyboard.press("Enter")
	await page.waitForSelector("#settings-modal-backdrop:not(.hidden)")
	const settings = await (await page.$("#settings-webview-frame")).contentFrame()
	await settings.waitForSelector('[data-testid="tab-appearance"]', { timeout: 30000 })
	await settings.addStyleTag({ content: staticStyle })
	await settings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await settings.waitForSelector('[data-testid="theme-card-clean-light"]')
	await settings.$eval('[data-testid="theme-card-clean-light"]', (el) => el.click())
	await page.waitForFunction(() => document.body.dataset.theme === "clean-light")
	assert.equal(await page.evaluate(()=>localStorage.getItem("roo-theme")),"linear-dark","Theme preview must not save the preference")
	await page.screenshot({ path: ".design-qa/product-settings-light.png" })
	await click("#close-settings-modal-btn")
	await settings.waitForSelector('[role="alertdialog"]')
	await page.screenshot({ path: ".design-qa/product-settings-unsaved.png" })
	const actions = await settings.$$eval('[role="alertdialog"] button', (els) => els.map((el) => el.textContent))
	assert.ok(actions.length >= 2)
	await settings.$eval('[role="alertdialog"] button:last-child', (el) => el.click())
	await page.waitForSelector("#settings-modal-backdrop.hidden")
	results.push("Command palette opens settings; shell close respects unsaved settings")
	await click("#workspace-settings-button")
	await settings.waitForSelector('[data-testid="tab-appearance"]')
	await settings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await settings.$eval('[data-testid="theme-card-clean-light"]', (el) => el.click())
	await settings.waitForFunction(() => !document.querySelector('[data-testid="save-button"]').disabled)
	await settings.$eval('[data-testid="save-button"]', (el) => el.click())
	await settings.waitForFunction(() => document.querySelector('[data-testid="save-button"]').disabled)
	await click("#close-settings-modal-btn")
	await page.waitForSelector("#settings-modal-backdrop.hidden")
	assert.equal(await page.evaluate(() => localStorage.getItem("roo-theme")), "clean-light")
	results.push("Appearance saves without an API key and persists after settings close")
	await click("#project-switcher")
	await click(".project-close-current")
	await page.waitForFunction(() => !document.querySelector(".product-backdrop"))
	await agent.waitForSelector(".agent-project-empty")
	await page.screenshot({ path: ".design-qa/product-no-project.png" })
	assert.equal(await page.$eval("#workspace-new-chat", (el) => el.disabled), true)
	results.push("Closing the project leaves a guided empty state and preserves the project list")
	await page.evaluate(() => {
		window.__qaNoProjectRequests = 0
		window.addEventListener(
			"message",
			(event) => {
				if (event.data?.type === "newTask") {
					window.__qaNoProjectRequests++
					event.stopImmediatePropagation()
				}
			},
			true,
		)
	})
	await agent.$eval("textarea", (el) => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, "Sprawdź projekt")
		el.dispatchEvent(new Event("input", { bubbles: true }))
	})
	await agent.$eval("button:has(.lucide-send-horizontal)", (el) => el.click())
	await page.waitForSelector("#project-path-input")
	assert.equal(await page.evaluate(() => window.__qaNoProjectRequests), 0)
	await click(".product-dialog header button")
	results.push("Sending without a project opens the folder picker before any model request")
	await open(root)
	await fill("#workspace-project-search", "nie-ma-takiego-projektu")
	assert.equal(await page.$$eval(".sidebar-project-item", (els) => els.every((el) => el.hidden)), true)
	await fill("#workspace-project-search", "")
	await click('[data-tab="native-chat"]');await click('#workspace-new-chat')
	await page.waitForSelector('.chat-session-item')
	await fill('#workspace-project-search','rozmowa-ktorej-nie-ma')
	assert.match(await page.$eval('#chat-sidebar-view',el=>el.innerText),/Nie znaleziono/)
	await fill('#workspace-project-search','');await click('[data-tab="chat"]')
	results.push('Shared new conversation and search controls follow the active Agent or Chat view')
	await page.setViewport({ width: 940, height: 780 })
	await page.screenshot({ path: ".design-qa/product-home-narrow.png" })
	assert.ok(
		await page.$eval("#workspace-settings-button", (el) => {
			const r = el.getBoundingClientRect()
			return r.bottom < innerHeight && r.height > 0
		}),
	)
	await click("#workspace-settings-button")
	await settings.waitForSelector('[data-testid="tab-appearance"]')
	await settings.$eval('[data-testid="tab-appearance"]', (el) => el.click())
	await settings.$eval('[data-testid="theme-card-linear-dark"]', (el) => el.click())
	await settings.waitForFunction(() => !document.querySelector('[data-testid="save-button"]').disabled)
	await settings.$eval('[data-testid="save-button"]', (el) => el.click())
	await settings.waitForFunction(() => document.querySelector('[data-testid="save-button"]').disabled)
	await click("#close-settings-modal-btn")
	await page.waitForSelector("#settings-modal-backdrop.hidden")
	assert.deepEqual(errors, [])
	fs.writeFileSync(".design-qa/product-results.json", JSON.stringify({ results, errors }, null, 2))
	console.log(results.join("\n"))
} finally {
	browser.disconnect()
}
