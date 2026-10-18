import { describe, it, expect } from "vitest"
import fs from "fs"
import path from "path"
import vm from "vm"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const desktopDir = path.resolve(__dirname, "../..")
const desktopRendererDir = path.join(desktopDir, "src/renderer")

describe("Renderer Startup Script Integrity & Syntax Regression Guard (P0)", () => {
	it("1. app.js must parse with zero syntax errors via V8 vm.Script", () => {
		const appJsPath = path.join(desktopRendererDir, "app.js")
		expect(fs.existsSync(appJsPath)).toBe(true)
		const appJsCode = fs.readFileSync(appJsPath, "utf-8")

		expect(() => {
			new vm.Script(appJsCode, { filename: "app.js" })
		}).not.toThrow()
	})

	it("2. bridge.bundle.js and highlight.bundle.js must parse with zero syntax errors", () => {
		for (const bundle of ["bridge.bundle.js", "highlight.bundle.js"]) {
			const bundlePath = path.join(desktopRendererDir, bundle)
			if (fs.existsSync(bundlePath)) {
				const code = fs.readFileSync(bundlePath, "utf-8")
				expect(() => {
					new vm.Script(code, { filename: bundle })
				}).not.toThrow()
			}
		}
	})

	it("3. closeConfirmationModal must be closed with its own closing brace before Native Chat Controller", () => {
		const appJsPath = path.join(desktopRendererDir, "app.js")
		const appJsCode = fs.readFileSync(appJsPath, "utf-8")

		// Confirm closeConfirmationModal exists
		expect(appJsCode).toContain("function closeConfirmationModal()")

		// Confirm closeConfirmationModal closes before the Native AI Chat Mode section
		const modalIdx = appJsCode.indexOf("function closeConfirmationModal()")
		const chatSectionIdx = appJsCode.indexOf("Native AI Chat Mode - Sidebar Controller")
		expect(modalIdx).toBeGreaterThan(0)
		expect(chatSectionIdx).toBeGreaterThan(modalIdx)

		const block = appJsCode.slice(modalIdx, chatSectionIdx)
		expect(block).toContain("lastFocusedElement = null")
		// Must have a closing brace for closeConfirmationModal before the Native Chat section begins
		const afterLastFocus = block.slice(block.indexOf("lastFocusedElement = null"))
		expect(afterLastFocus).toMatch(/lastFocusedElement\s*=\s*null\s*\r?\n\s*\}/)
	})

	it("4. Critical desktop runtime functions must be declared in app.js", () => {
		const appJsPath = path.join(desktopRendererDir, "app.js")
		const appJsCode = fs.readFileSync(appJsPath, "utf-8")

		const criticalFunctions = [
			"function renderSidebar()",
			"function renderChatSidebar()",
			"function fetchChatSessions()",
			"function connectWebSocket()",
			"function loadWebviewFrame()",
			"function showWebviewSuccess()",
			"function showWebviewLoading(",
			"function switchDesktopTab(",
			"function updateSidebarData(",
		]

		for (const fn of criticalFunctions) {
			expect(appJsCode).toContain(fn)
		}
	})

	it("5. index.html must load scripts in correct order and start in connecting status", () => {
		const indexHtmlPath = path.join(desktopRendererDir, "index.html")
		expect(fs.existsSync(indexHtmlPath)).toBe(true)
		const html = fs.readFileSync(indexHtmlPath, "utf-8")

		// Script loading order
		const hlIdx = html.indexOf('<script src="highlight.bundle.js"></script>')
		const bridgeIdx = html.indexOf('<script src="bridge.bundle.js"></script>')
		const appIdx = html.indexOf('<script src="app.js"></script>')

		expect(hlIdx).toBeGreaterThan(0)
		expect(bridgeIdx).toBeGreaterThan(hlIdx)
		expect(appIdx).toBeGreaterThan(bridgeIdx)

		// Initial connection indicators must NOT falsely assert Connected before handshake
		expect(html).toContain('class="engine-connection-badge status-connecting"')
		expect(html).toMatch(/id="engine-connection-text">(Connecting…|Łączenie…)<\/span>/)
		expect(html).toMatch(/id="connection-status">(Connecting to engine\.\.\.|Łączę się z agentem…)<\/span>/)
	})

	it("6. Execution smoke check in simulated browser environment", () => {
		const appJsPath = path.join(desktopRendererDir, "app.js")
		const appJsCode = fs.readFileSync(appJsPath, "utf-8")

		// Build lightweight mock browser environment
		const createEl = () => ({
			addEventListener: () => {},
			classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
			style: {},
			dataset: {},
			setAttribute: () => {},
			getAttribute: () => null,
			querySelector: () => createEl(),
			querySelectorAll: () => [],
		})

		const mockDom: Record<string, any> = {
			AbortController: globalThis.AbortController,
			Date: globalThis.Date,
			Array: globalThis.Array,
			Object: globalThis.Object,
			String: globalThis.String,
			Boolean: globalThis.Boolean,
			Number: globalThis.Number,
			RegExp: globalThis.RegExp,
			Set: globalThis.Set,
			Map: globalThis.Map,
			JSON: globalThis.JSON,
			localStorage: {
				getItem: () => null,
				setItem: () => {},
			},
			sessionStorage: {
				getItem: () => null,
				setItem: () => {},
			},
			document: {
				body: createEl(),
				getElementById: () => createEl(),
				querySelector: () => createEl(),
				querySelectorAll: () => [],
				addEventListener: () => {},
				activeElement: null,
				contains: () => true,
			},
			window: {
				location: { protocol: "http:", host: "127.0.0.1:4500" },
				addEventListener: () => {},
				DesktopBridgeModule: null,
			},
			WebSocket: class MockWebSocket {
				static OPEN = 1
				readyState = 1
				send() {}
				close() {}
				addEventListener() {}
			},
			performance: { now: () => Date.now() },
			console: {
				log: () => {},
				warn: () => {},
				error: () => {},
				debug: () => {},
			},
			setTimeout: () => 1,
			clearTimeout: () => {},
			setInterval: () => 1,
			clearInterval: () => {},
			queueMicrotask: (fn: any) => setTimeout(fn, 0),
			fetch: async () => ({ ok: true, json: async () => ({}) }),
		}

		mockDom.window.document = mockDom.document
		mockDom.window.window = mockDom.window
		mockDom.window.localStorage = mockDom.localStorage
		mockDom.window.sessionStorage = mockDom.sessionStorage

		const context = vm.createContext(mockDom)

		expect(() => {
			vm.runInContext(fs.readFileSync(path.join(desktopRendererDir, "product-workspace.js"), "utf-8"), context, { filename: "product-workspace.js" })
			vm.runInContext(appJsCode, context, { filename: "app.js" })
		}).not.toThrow()
	})
})
