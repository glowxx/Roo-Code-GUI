import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(new URL("../src/package.json", import.meta.url))
const browser = await require("puppeteer-core").connect({ browserURL: "http://127.0.0.1:9223", defaultViewport: null })
const theme = process.argv.includes("--light") ? "clean-light" : "linear-dark"
const prefix = theme === "clean-light" ? "conversation-light" : "conversation-dark"
const results = []
try {
	const page = (await browser.pages()).find((page) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url()))
	const errors = []
	page.on("pageerror", (error) => errors.push(error.message))
	await page.setViewport({ width: 1300, height: 1000 })
	// These fixtures use the real agent view and its normal state event, without
	// persisting a task. Block outbound actions before exercising approval controls.
	await page.evaluateOnNewDocument(() => {
		window.__qaActions = []
		window.addEventListener(
			"message",
			(event) => {
				if (event.data?.type === "state" && !window.__qaInject) window.__qaBaseState = event.data.state
				if (
					window.__qaFixture &&
					event.source === document.getElementById("webview-frame")?.contentWindow &&
					event.data?.type !== "themeChange"
				) {
					window.__qaActions.push(event.data)
					event.stopImmediatePropagation()
				}
			},
			true,
		)
	})
	await page.reload({ waitUntil: "domcontentloaded" })
	const agent = await (await page.waitForSelector("#webview-frame")).contentFrame()
	await agent.waitForFunction(() => !!window.__qaBaseState?.apiConfiguration, { polling: 100 })
	await page.evaluate(() => {
		window.__qaFixture = true
	})
	const say = (ts, type, text, extra = {}) => ({ ts, type: "say", say: type, text, ...extra })
	const tool = (ts, name, path, extra = {}) => ({
		ts,
		type: "ask",
		ask: "tool",
		isAnswered: true,
		text: JSON.stringify({ tool: name, path, ...extra }),
	})
	const history = [
		say(1000, "text", "Popraw walidację formularza logowania i sprawdź testy."),
		say(1001, "text", "Sprawdzę formularz i jego testy. Zacznę od walidacji adresu e-mail."),
		say(1002, "api_req_started", JSON.stringify({ cost: 0.04, tokensIn: 1200, tokensOut: 400 })),
		tool(1003, "readFile", "src/login.ts"),
		tool(1004, "listFilesTopLevel", "src"),
		say(1005, "reasoning", "Wewnętrzne rozumowanie pozostaje w szczegółach."),
		say(1006, "error", "ENOENT: no such file or directory, old/login.ts"),
		say(
			1007,
			"command_safety_warning",
			JSON.stringify({
				reason: "Approval Model is not configured or lacks API key. Manual approval required.",
				riskLevel: "high",
			}),
		),
		tool(1008, "readFile", "src/login.spec.ts"),
		say(1009, "text", "Walidacja przepuszczała adres bez domeny. Poprawiam ten warunek i dodaję test regresji."),
		tool(1010, "appliedDiff", "src/login.ts", {
			content: "@@ -1 +1 @@\n-old validation\n+new validation",
			diffStats: { added: 1, removed: 1 },
		}),
		tool(1011, "appliedDiff", "src/login.spec.ts", {
			content: "@@ -1 +1 @@\n-old test\n+new test",
			diffStats: { added: 1, removed: 1 },
		}),
		say(1012, "text", "Zmiana i test regresji są gotowe. Uruchamiam testy formularza."),
		{
			ts: 1013,
			type: "ask",
			ask: "command",
			approvalState: "AUTO_APPROVED",
			text: "pnpm test -- login.spec.ts",
			isAnswered: true,
		},
		say(1014, "command_output", "TERMINAL_FIXTURE_OUTPUT: running tests"),
	]
	const inject = async (messages, status = "active") => {
		await agent.evaluate(
			({ messages, status, theme }) => {
				window.__qaInject = true
				window.__qaSequence = (window.__qaSequence || window.__qaBaseState.clineMessagesSeq || 0) + 1
				window.postMessage(
					{
						type: "state",
						state: {
							...window.__qaBaseState,
							clineMessages: messages,
							clineMessagesSeq: window.__qaSequence,
							currentTaskId: "visual-agent-fixture",
							currentTaskItem: { id: "visual-agent-fixture", ts: 1000, task: messages[0].text, status },
							soundEnabled: false,
							ttsEnabled: false,
							autoApprovalEnabled: false,
							approvalMode: "manual",
							theme,
							currentTaskTodos: [],
						},
					},
					"*",
				)
			},
			{ messages, status, theme },
		)
		await agent.waitForSelector(".agent-work-view .agent-message")
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	const capture = async (name) => {
		assert.equal(await agent.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
		const palette = await agent.evaluate(() => {
			const style = getComputedStyle(document.body)
			return {
				canvas: style.getPropertyValue("--bg-canvas").trim(),
				badge: style.getPropertyValue("--vscode-badge-background").trim(),
				active: style.getPropertyValue("--bg-active").trim(),
			}
		})
		assert.equal(
			palette.canvas,
			theme === "clean-light" ? "#ffffff" : "#202123",
			"Desktop palette stays independent of injected VS Code colours",
		)
		assert.equal(palette.badge, palette.active)
		await page.screenshot({ path: `.design-qa/${prefix}-${name}.png` })
	}
	await inject(history)
	assert.equal(await agent.$('[data-testid="agent-activity-details"]'), null)
	const visible = await agent.evaluate(() => document.body.innerText)
	assert.ok(visible.includes("Walidacja przepuszczała adres bez domeny."))
	assert.ok(!visible.includes("TERMINAL_FIXTURE_OUTPUT"))
	assert.ok(!visible.includes("ENOENT") && !visible.includes("HIGH RISK") && !visible.includes("Zapytanie API"))
	assert.equal(await agent.$('[data-testid="task-token-usage"]'), null)
	await capture("working")
	results.push(
		"Progress stays conversational; technical operations, reasoning, repeated warnings, output and token totals folded by default",
	)
	await agent.evaluate(() => {
		for (const event of [
			{ executionId: "1013", status: "started", pid: 123 },
			{ executionId: "1013", status: "output", output: "LIVE_STREAM_FIXTURE" },
		]) {
			window.postMessage({ type: "commandExecutionStatus", text: JSON.stringify(event) }, "*")
		}
	})
	const triggers = await agent.$$('[data-testid="agent-activity"] button.agent-activity-trigger')
	await triggers[0].focus()
	await page.keyboard.press("Enter")
	await agent.waitForSelector('[data-testid="agent-activity-details"]')
	assert.ok((await agent.evaluate(() => document.body.innerText)).includes("src/login.ts"))
	await capture("details")
	await triggers[0].click()
	await agent.waitForFunction(() => !document.querySelector('[data-testid="agent-activity-details"]'), {
		polling: 100,
	})
	results.push("Technical history expands and collapses by keyboard without losing file operations")
	await triggers.at(-1).click()
	await agent.waitForFunction(() => document.body.innerText.includes("LIVE_STREAM_FIXTURE"), { polling: 100 })
	await triggers.at(-1).click()
	results.push("Running terminal output remains subscribed while folded and appears when expanded")
	const pending = {
		ts: 1015,
		type: "ask",
		ask: "command",
		approvalState: "USER_DECISION_REQUIRED",
		text: "pnpm test -- login.spec.ts",
		isAnswered: false,
	}
	await inject([
		...history,
		pending,
		say(
			1016,
			"command_safety_warning",
			JSON.stringify({
				reason: "Approval Model is not configured or lacks API key. Manual approval required.",
				riskLevel: "high",
			}),
		),
	])
	await agent.evaluate(() => {
		const list = document.querySelector('[data-virtuoso-scroller="true"]')
		if (list) list.scrollTop = list.scrollHeight
	})
	try {
		await agent.waitForFunction(() => document.body.innerText.includes("Potrzebna jest Twoja decyzja"), {
			polling: 100,
			timeout: 5000,
		})
	} catch (error) {
		await capture("approval-failure")
		console.log(await agent.evaluate(() => document.body.innerText))
		throw error
	}
	assert.ok(
		(await agent.evaluate(() => document.body.innerText)).includes(pending.text),
		"Command to approve must stay visible",
	)
	assert.equal(await agent.$(".agent-notice-details[open]"), null)
	await capture("approval")
	await agent.$$eval("button", (buttons) => {
		const button = buttons.find((button) => button.textContent.trim() === "Uruchom")
		if (!button || button.disabled) throw new Error("Approval control unavailable")
		button.click()
	})
	await page.waitForFunction(
		() =>
			window.__qaActions.some(
				(action) => action.type === "askResponse" && action.askResponse === "yesButtonClicked",
			),
		{ polling: 100 },
	)
	results.push("Pending command scope and decision controls remain visible; raw verifier reason stays folded")
	await inject([
		...history,
		{
			ts: 1017,
			type: "ask",
			ask: "followup",
			text: JSON.stringify({
				question: "Czy komunikat o błędzie ma pojawiać się pod polem?",
				suggest: [{ answer: "Tak, pod polem" }, { answer: "Nad formularzem" }],
			}),
		},
	])
	await agent.waitForSelector(".agent-question button")
	assert.ok((await agent.evaluate(() => document.body.innerText)).includes("Czy komunikat o błędzie"))
	await capture("question")
	await agent.$eval(".agent-question button", (button) => button.click())
	await page.waitForFunction(
		() =>
			window.__qaActions.some(
				(action) => action.type === "askResponse" && action.askResponse === "messageResponse",
			),
		{ polling: 100 },
	)
	results.push("Follow-up questions and suggested answers remain directly actionable")
	await inject(
		[
			...history,
			say(
				1018,
				"api_req_started",
				JSON.stringify({
					streamingFailedMessage: "API_FIXTURE_CONNECTION_RESET",
					cancelReason: "streaming_failed",
				}),
			),
			{ ts: 1019, type: "ask", ask: "api_req_failed", text: "API_FIXTURE_CONNECTION_RESET" },
		],
		"interrupted",
	)
	await agent.waitForSelector(".agent-problem")
	assert.ok((await agent.evaluate(() => document.body.innerText)).includes("Nie udało się uzyskać odpowiedzi"))
	assert.ok(!(await agent.evaluate(() => document.body.innerText)).includes("API_FIXTURE_CONNECTION_RESET"))
	await agent.$eval(".agent-problem button", (button) => button.click())
	await agent.waitForSelector('[data-slot="dialog-content"]')
	assert.ok((await agent.evaluate(() => document.body.innerText)).includes("API_FIXTURE_CONNECTION_RESET"))
	await page.keyboard.press("Escape")
	results.push("Current response failures stay visible; exact diagnostics remain available on demand")
	const finished = [
		...history,
		{
			ts: 1020,
			type: "ask",
			ask: "completion_result",
			text: "Poprawiłem walidację adresu e-mail i dodałem test regresji.\n\nTesty formularza przeszły: **12/12**.",
			approvalState: "AUTO_APPROVED",
		},
	]
	await inject(finished, "completed")
	await agent.waitForSelector(".agent-completion")
	assert.ok(!(await agent.evaluate(() => document.body.innerText)).includes("Odrzuć"))
	assert.equal(await agent.$('[data-testid="agent-activity-details"]'), null)
	await capture("complete")
	await page.setViewport({ width: 900, height: 900 })
	await capture("narrow")
	results.push("Final answer remains a plain message; completed and narrow layouts fit the viewport")
	assert.deepEqual(errors, [])
	fs.writeFileSync(
		`.design-qa/${prefix}-results.json`,
		JSON.stringify({ theme, fixtureOnly: true, errors, results }, null, 2),
	)
	console.log(results.join("\n"))
} finally {
	// Reload resets all visual-only state and outbound interception.
	const page = (await browser.pages()).find((page) => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url()))
	if (page) await page.reload({ waitUntil: "domcontentloaded" })
	browser.disconnect()
}
