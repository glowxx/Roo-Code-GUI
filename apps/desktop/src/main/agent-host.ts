import { createRequire } from "module"
import path from "path"
import fs from "fs"
import os from "os"
import { fileURLToPath } from "url"
import { EventEmitter } from "events"
import { execSync } from "child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
import { RooCodeEventName, type ExtensionMessage, type WebviewMessage, type TitleSource } from "@roo-code/types"
import { createVSCodeAPI, setRuntimeConfigValues } from "@roo-code/vscode-shim"
import type { AgentStatusType, TerminalLogEntry, DiffFileEntry, SidebarChatEntry, NavigationCounts } from "../shared/types.js"
export type { SidebarChatEntry }
import { canonicalizePath, arePathsEqual, loadDesktopConfig, saveDesktopConfig } from "./config.js"
import { generateConversationTitle, sanitizeTitle, semanticFallbackTitle, isBadAutoTitle } from "./title-generator.js"

export interface AgentHostOptions {
	workspacePath: string
	extensionPath: string
	storageDir?: string
}

interface ExtensionModule {
	activate: (context: unknown) => Promise<unknown>
	deactivate?: () => Promise<void>
}

/**
 * Canonical helper to sanitize and format a conversation title from task prompt / item metadata.
 * Strips markdown syntax, extracts the first meaningful line, clamps to maxLength (default 80),
 * and handles multi-line/huge prompts safely.
 */
export function formatChatTitle(task?: unknown, title?: unknown, maxLength = 80): string {
	const raw =
		typeof title === "string" && title.trim()
			? title.trim()
			: typeof task === "string" && task.trim()
				? task.trim()
				: ""

	if (!raw) return "Untitled Task"

	const lines = raw.split(/\r?\n/)
	let candidate = ""

	for (const line of lines) {
		let cleaned = line.trim()
		if (!cleaned) continue

		// Skip code fences like ```typescript
		if (/^```[a-zA-Z0-9_-]*$/.test(cleaned)) continue

		// Strip markdown headers: #, ##, ###, etc.
		cleaned = cleaned.replace(/^#+\s*/, "")
		// Strip blockquotes: >
		cleaned = cleaned.replace(/^>\s*/, "")
		// Strip list markers and checkboxes: *, -, +, 1., [ ], [x], [X]
		cleaned = cleaned.replace(/^([-*+]|\d+\.)\s*(\[[ xX]\]\s*)?/, "")
		// Strip bold, italic, strikethrough: **text**, *text*, __text__, _text_, ~~text~~
		cleaned = cleaned.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, "$2")
		// Strip inline code backticks: `code`
		cleaned = cleaned.replace(/`([^`]+)`/g, "$1")
		// Strip markdown links: [text](url) -> text
		cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		// Strip markdown images: ![alt](url) -> alt
		cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		// Strip HTML/XML tags: <tag> -> ""
		cleaned = cleaned.replace(/<[^>]+>/g, "")
		// Collapse multiple consecutive spaces/tabs
		cleaned = cleaned.replace(/\s+/g, " ").trim()

		if (cleaned) {
			candidate = cleaned
			break
		}
	}

	if (!candidate) return "Untitled Task"

	// Code point / surrogate safe slicing for emoji and unicode
	const chars = Array.from(candidate)
	if (chars.length > maxLength) {
		return chars.slice(0, maxLength - 3).join("").trimEnd() + "..."
	}
	return candidate
}

/**
 * Extract creation timestamp in ms from task ID (UUIDv7) or fallback timestamp.
 */
export function extractCreationTimestamp(id?: string, fallbackTs?: number): number {
	if (id && typeof id === "string") {
		try {
			// Modern Roo Code task IDs are UUIDv7, where the first 48 bits (12 hex digits)
			// encode the Unix epoch milliseconds.
			const hex = id.replace(/-/g, "").substring(0, 12)
			if (/^[0-9a-fA-F]{12}$/.test(hex)) {
				const ms = parseInt(hex, 16)
				if (ms > 1577836800000 && ms < 4102444800000) {
					return ms
				}
			}
		} catch {}
	}
	return typeof fallbackTs === "number" && !isNaN(fallbackTs) ? fallbackTs : 0
}

export class DesktopAgentHost extends EventEmitter {
	private vscode: ReturnType<typeof createVSCodeAPI> | null = null
	private extensionModule: ExtensionModule | null = null
	private isReady = false
	private currentWorkspace: string
	private extensionPath: string
	private storageDir?: string
	private status: AgentStatusType = "idle"
	private activeTaskId: string | null = null
	private providerCleanupFns: Array<() => void> = []
	private terminalLogs: TerminalLogEntry[] = []
	private terminalLogsByWorkspace: Map<string, TerminalLogEntry[]> = new Map()
	private archivedTerminalLogs: Array<{ workspace: string; timestamp: number; logs: TerminalLogEntry[] }> = []
	private diffFiles: Map<string, DiffFileEntry> = new Map()
	private diffFilesByWorkspace: Map<string, Map<string, DiffFileEntry>> = new Map()
	private diffFilesByTask: Map<string, Map<string, DiffFileEntry>> = new Map()
	private provider: any = null
	private currentWorkspaceEpoch = 0
	private pendingWorkspaceChangeAbortController: AbortController | null = null
	private deletedTaskIds: Set<string> = new Set()
	private pendingTitleAbortControllers: Map<string, AbortController> = new Map()
	private titleGenerationTaskIds: Set<string> = new Set()
	private titleAiAttemptedTaskIds: Set<string> = new Set()
	private titleRepairScheduled = false
	private lastNavigationCounts?: NavigationCounts

	constructor(options: AgentHostOptions) {
		super()
		this.currentWorkspace = options.workspacePath && options.workspacePath.trim() ? canonicalizePath(options.workspacePath) : ""
		this.extensionPath = path.normalize(path.resolve(options.extensionPath))
		this.storageDir = options.storageDir
			? path.normalize(path.resolve(options.storageDir))
			: path.join(process.env.APPDATA || os.homedir(), ".roo-desktop-data")
		// These events fire after canonical state mutations, independently of panel visibility.
		for (const event of ["diffsUpdated", "terminalLog", "terminalLogsUpdated", "terminalLogsCleared"]) {
			this.on(event, () => this.publishNavigationCounts())
		}
	}

	public getNavigationCounts(): NavigationCounts {
		let terminalRunning = 0
		// The existing session registry is capped at 200. Inspect status only, never output/history.
		for (const session of this.terminalLogs) {
			if (session.status === "running") terminalRunning++
		}
		const terminalTotal = this.terminalLogs.length
		return {
			workspace: this.currentWorkspace,
			diffCount: this.diffFiles.size,
			terminalCount: terminalRunning || terminalTotal,
			terminalTotal,
			terminalRunning,
		}
	}

	private publishNavigationCounts(): void {
		const counts = this.getNavigationCounts()
		const previous = this.lastNavigationCounts
		if (
			previous && previous.workspace === counts.workspace && previous.diffCount === counts.diffCount &&
			previous.terminalTotal === counts.terminalTotal && previous.terminalRunning === counts.terminalRunning
		) return
		this.lastNavigationCounts = counts
		this.emit("navigationCountsUpdated", counts)
	}

	private workspaceStateKey(workspace: string): string {
		const normalized = canonicalizePath(workspace)
		if (arePathsEqual(normalized, this.currentWorkspace)) return this.currentWorkspace
		for (const key of this.terminalLogsByWorkspace.keys()) {
			if (arePathsEqual(normalized, key)) return key
		}
		for (const key of this.diffFilesByWorkspace.keys()) {
			if (arePathsEqual(normalized, key)) return key
		}
		return normalized
	}

	public getWorkspace(): string {
		return this.currentWorkspace
	}

	public getStorageDir(): string | undefined {
		return this.storageDir
	}

	public getChatSessionManager(): any {
		return this.provider?.chatSessionManager
	}

	public async setWorkspace(newWorkspace?: string): Promise<void> {
		this.currentWorkspaceEpoch++
		const epoch = this.currentWorkspaceEpoch

		if (this.pendingWorkspaceChangeAbortController) {
			this.pendingWorkspaceChangeAbortController.abort()
		}
		this.pendingWorkspaceChangeAbortController = new AbortController()

		// Save current workspace state before switching
		if (this.currentWorkspace) {
			this.terminalLogsByWorkspace.set(this.currentWorkspace, [...this.terminalLogs])
			this.diffFilesByWorkspace.set(this.currentWorkspace, new Map(this.diffFiles))
			if (this.terminalLogs.length > 0) {
				this.archivedTerminalLogs.push({
					workspace: this.currentWorkspace,
					timestamp: Date.now(),
					logs: [...this.terminalLogs],
				})
				if (this.archivedTerminalLogs.length > 20) {
					this.archivedTerminalLogs.shift()
				}
			}
		}

		if (!newWorkspace || typeof newWorkspace !== "string" || !newWorkspace.trim()) {
			this.currentWorkspace = ""
			this.terminalLogs = []
			this.diffFiles = new Map()
			this.emit("terminalLogsCleared")
			this.emit("diffsUpdated", [])
			if (this.vscode && (this.vscode as Record<string, unknown>).workspace) {
				const ws = (this.vscode as Record<string, unknown>).workspace as any
				if (typeof ws.setWorkspaceFolders === "function") {
					ws.setWorkspaceFolders([])
				} else {
					ws.workspaceFolders = undefined
					ws.name = undefined
				}
			}
			await this.provider?.handleWorkspaceChanged?.("", this.currentWorkspaceEpoch)
			if (this.currentWorkspaceEpoch === epoch) {
				this.emit("workspaceChanged", "")
			}
			return
		}

		const normalized = this.workspaceStateKey(newWorkspace)
		if (!fs.existsSync(normalized)) {
			console.warn(`Directory does not exist: ${normalized}`)
			return
		}

		this.currentWorkspace = normalized
		this.terminalLogs = this.terminalLogsByWorkspace.get(this.currentWorkspace) || []
		this.diffFiles = this.diffFilesByWorkspace.get(this.currentWorkspace) || new Map()
		this.refreshDiffsFromGit()
		this.emit("terminalLogsUpdated", this.terminalLogs)
		this.emit("diffsUpdated", Array.from(this.diffFiles.values()))
		if (this.vscode && (this.vscode as Record<string, unknown>).workspace) {
			const ws = (this.vscode as Record<string, unknown>).workspace as any
			if (typeof ws.setWorkspaceFolders === "function") {
				ws.setWorkspaceFolders(this.currentWorkspace)
			} else {
				const UriClass = (this.vscode as Record<string, unknown>).Uri as { file: (p: string) => unknown }
				ws.workspaceFolders = [
					{
						uri: UriClass.file(this.currentWorkspace),
						name: path.basename(this.currentWorkspace),
						index: 0,
					},
				]
				ws.name = path.basename(this.currentWorkspace)
			}
		}
		await this.provider?.handleWorkspaceChanged?.(this.currentWorkspace, this.currentWorkspaceEpoch)
		if (this.currentWorkspaceEpoch === epoch) {
			this.emit("workspaceChanged", this.currentWorkspace)
		}
	}

	public getStatus(): AgentStatusType {
		return this.status
	}

	public getTerminalLogs(): TerminalLogEntry[] {
		return [...this.terminalLogs]
	}

	public getArchivedTerminalLogs(): Array<{ workspace: string; timestamp: number; logs: TerminalLogEntry[] }> {
		return [...this.archivedTerminalLogs]
	}

	public clearTerminalLogs(): void {
		if (this.terminalLogs.length > 0) {
			this.archivedTerminalLogs.push({
				workspace: this.currentWorkspace,
				timestamp: Date.now(),
				logs: [...this.terminalLogs],
			})
			if (this.archivedTerminalLogs.length > 20) {
				this.archivedTerminalLogs.shift()
			}
		}
		this.terminalLogs = []
		this.emit("terminalLogsCleared")
	}

	public getDiffFiles(): DiffFileEntry[] {
		return Array.from(this.diffFiles.values())
	}

	public getDiffFilesForTask(taskId?: string): DiffFileEntry[] {
		if (taskId && this.diffFilesByTask.has(taskId)) {
			return Array.from(this.diffFilesByTask.get(taskId)!.values())
		}
		return this.getDiffFiles()
	}

	public refreshDiffsFromGit(): void {
		if (!this.currentWorkspace || !fs.existsSync(this.currentWorkspace)) {
			this.diffFiles.clear()
			this.emit("diffsUpdated", this.getDiffFiles())
			return
		}

		try {
			const statusOutput = execSync("git -c core.quotepath=false status --porcelain -uall", {
				cwd: this.currentWorkspace,
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			})

			if (!statusOutput || !statusOutput.trim()) {
				this.diffFiles.clear()
				this.emit("diffsUpdated", this.getDiffFiles())
				return
			}

			// Single batch git diff --numstat HEAD query for additions/deletions
			const numstatMap = new Map<string, { additions: number; deletions: number }>()
			try {
				const numstatOutput = execSync("git -c core.quotepath=false diff --numstat HEAD", {
					cwd: this.currentWorkspace,
					encoding: "utf-8",
					timeout: 5000,
					stdio: ["ignore", "pipe", "ignore"],
				})
				if (numstatOutput && numstatOutput.trim()) {
					for (const line of numstatOutput.split(/\r?\n/)) {
						const parts = line.split("\t")
						if (parts.length >= 3) {
							const add = parseInt(parts[0]!, 10)
							const del = parseInt(parts[1]!, 10)
							const p = parts.slice(2).join("\t").trim().replace(/\\/g, "/")
							numstatMap.set(p, {
								additions: isNaN(add) ? 1 : add,
								deletions: isNaN(del) ? 0 : del,
							})
						}
					}
				}
			} catch {}

			const newDiffFiles = new Map<string, DiffFileEntry>()
			const lines = statusOutput.split(/\r?\n/)
			for (const line of lines) {
				if (!line || line.length < 4) continue
				const statusCode = line.substring(0, 2).trim()
				let relPath = line.substring(3).trim()
				if (relPath.startsWith('"') && relPath.endsWith('"')) {
					relPath = relPath.slice(1, -1)
				}
				if (relPath.includes(" -> ")) {
					relPath = relPath.split(" -> ")[1]!.trim()
				}
				const normRel = relPath.replace(/\\/g, "/")

				let fileStatus: "modified" | "added" | "deleted" = "modified"
				if (statusCode === "??" || statusCode === "A") {
					fileStatus = "added"
				} else if (statusCode === "D") {
					fileStatus = "deleted"
				}

				const numstat = numstatMap.get(normRel)
				const additions = numstat ? numstat.additions : fileStatus === "added" ? 1 : 1
				const deletions = numstat ? numstat.deletions : fileStatus === "deleted" ? 1 : 0

				const existing = this.diffFiles.get(normRel)
				const entry: DiffFileEntry = {
					filePath: normRel,
					oldContent: existing?.oldContent,
					newContent: existing?.newContent,
					status: fileStatus,
					additions: numstat?.additions ?? existing?.additions ?? additions,
					deletions: numstat?.deletions ?? existing?.deletions ?? deletions,
				}
				newDiffFiles.set(normRel, entry)
			}

			this.diffFiles = newDiffFiles
		} catch {
			// Not a git repository or git command failed
		}

		this.emit("diffsUpdated", this.getDiffFiles())
	}

	public async init(): Promise<void> {
		const bundlePath = path.join(this.extensionPath, "extension.js")
		if (!fs.existsSync(bundlePath)) {
			throw new Error(`Roo Code core engine bundle not found at: ${bundlePath}. Please build it first.`)
		}

		// Ensure CommonJS package.json exists in extensionPath so Node loads bundle as CJS
		const enginePkgPath = path.join(this.extensionPath, "package.json")
		if (!fs.existsSync(enginePkgPath)) {
			try {
				fs.writeFileSync(enginePkgPath, JSON.stringify({ name: "@roo-code/engine", type: "commonjs" }, null, 2))
			} catch {
				// Read-only filesystem fallback
			}
		}

		if (this.storageDir && !fs.existsSync(this.storageDir)) {
			fs.mkdirSync(this.storageDir, { recursive: true })
		}

		// Find appRoot for VSCode API (needs node_modules/@vscode/ripgrep/bin/rg)
		const binName = process.platform === "win32" ? "rg.exe" : "rg"
		const candidateAppRoots = [
			process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist") : "",
			process.resourcesPath || "",
			path.join(__dirname, ".."), // dist/
			path.join(__dirname, "../.."), // apps/desktop
			this.extensionPath,
		].filter(Boolean)

		let appRoot = ""
		for (const candidate of candidateAppRoots) {
			if (
				fs.existsSync(path.join(candidate, "node_modules", "@vscode", "ripgrep", "bin", binName)) ||
				fs.existsSync(path.join(candidate, "bin", binName))
			) {
				appRoot = candidate
				break
			}
		}

		if (!appRoot) {
			let searchDir = path.dirname(this.extensionPath)
			while (searchDir !== path.dirname(searchDir)) {
				const directPath = path.join(searchDir, "node_modules", "@vscode", "ripgrep", "bin", binName)
				if (fs.existsSync(directPath)) {
					appRoot = searchDir
					break
				}
				const pnpmDir = path.join(searchDir, "node_modules", ".pnpm")
				if (fs.existsSync(pnpmDir)) {
					try {
						const entries = fs.readdirSync(pnpmDir)
						const rgEntry = entries.find((e) => e.startsWith("@vscode+ripgrep"))
						if (rgEntry) {
							const pnpmRgPath = path.join(pnpmDir, rgEntry)
							if (fs.existsSync(path.join(pnpmRgPath, "node_modules", "@vscode", "ripgrep", "bin", binName))) {
								appRoot = pnpmRgPath
								break
							}
						}
					} catch {}
				}
				searchDir = path.dirname(searchDir)
			}
		}

		if (!appRoot) {
			appRoot = path.join(__dirname, "..")
		}

		// Initialize VSCode API mock
		this.vscode = createVSCodeAPI(this.extensionPath, this.currentWorkspace || "", undefined, {
			appRoot,
			storageDir: this.storageDir,
		})
		// Apply the Polish edition once for new installations without overwriting existing preferences.
		// Later explicit language choices remain available in Settings.
		if (!this.vscode.context.globalState.get("polishWorkspaceEdition")) {
			if (!this.vscode.context.globalState.get("language")) {
				await this.vscode.context.globalState.update("language", "pl")
			}
			await this.vscode.context.globalState.update("polishWorkspaceEdition", true)
		}

		;(global as Record<string, unknown>).vscode = this.vscode
		;(global as Record<string, unknown>).__extensionHost = this

		const require = createRequire(import.meta.url)
		const Module = require("module")
		const originalResolve = Module._resolveFilename

		Module._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options: unknown) {
			if (request === "vscode") return "vscode-mock"
			return originalResolve.call(this, request, parent, isMain, options)
		}

		require.cache["vscode-mock"] = {
			id: "vscode-mock",
			filename: "vscode-mock",
			loaded: true,
			exports: this.vscode,
			children: [],
			paths: [],
			path: "",
			isPreloading: false,
			parent: null,
			require,
		} as unknown as NodeModule

		try {
			this.extensionModule = require(bundlePath) as ExtensionModule
		} catch (error) {
			Module._resolveFilename = originalResolve
			throw new Error(`Failed to load engine bundle: ${error instanceof Error ? error.message : String(error)}`)
		}

		Module._resolveFilename = originalResolve

		try {
			await this.extensionModule.activate(this.vscode.context)
		} catch (error) {
			throw new Error(`Failed to activate agent: ${error instanceof Error ? error.message : String(error)}`)
		}

		this.on("extensionWebviewMessage", (msg: ExtensionMessage) => {
			this.processExtensionMessage(msg)
		})
	}

	public markWebviewReady(): void {
		this.isReady = true
		this.sendToExtension({ type: "webviewDidLaunch" })
	}

	public isInInitialSetup(): boolean {
		return !this.isReady
	}

	public registerWebviewProvider(_viewId: string, provider: unknown): void {
		this.unregisterWebviewProvider(_viewId)
		this.provider = provider
		void this.repairExistingBadAutoTitles()
		if (this.provider && typeof this.provider.on === "function") {
			const onTaskStarted = (taskId?: string) => {
				this.emit("taskHistoryChanged")
				const id = taskId || this.provider?.getCurrentTask?.()?.taskId
				if (id) {
					const promptText =
						this.provider?.getCurrentTask?.()?.task || this.provider?.taskHistoryStore?.get?.(id)?.task
					if (promptText) {
						this.triggerBackgroundTitleGeneration(id, promptText)
					}
				}
			}
			const onTaskCompleted = async (taskId: string) => {
				await this.handleTaskCompleted(taskId)
			}
			const onTaskAborted = () => {
				this.emit("taskHistoryChanged")
			}
			const onTaskChanged = () => {
				this.emit("taskHistoryChanged")
			}

			this.provider.on(RooCodeEventName.TaskStarted, onTaskStarted)
			this.provider.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
			this.provider.on(RooCodeEventName.TaskAborted, onTaskAborted)
			this.provider.on(RooCodeEventName.TaskActive, onTaskChanged)
			this.provider.on(RooCodeEventName.TaskIdle, onTaskChanged)
			this.provider.on(RooCodeEventName.TaskInteractive, onTaskChanged)
			this.provider.on(RooCodeEventName.TaskResumable, onTaskChanged)
			this.provider.on(RooCodeEventName.TaskAskResponded, onTaskChanged)

			this.providerCleanupFns.push(
				() => this.provider?.off?.(RooCodeEventName.TaskStarted, onTaskStarted),
				() => this.provider?.off?.(RooCodeEventName.TaskCompleted, onTaskCompleted),
				() => this.provider?.off?.(RooCodeEventName.TaskAborted, onTaskAborted),
				() => this.provider?.off?.(RooCodeEventName.TaskActive, onTaskChanged),
				() => this.provider?.off?.(RooCodeEventName.TaskIdle, onTaskChanged),
				() => this.provider?.off?.(RooCodeEventName.TaskInteractive, onTaskChanged),
				() => this.provider?.off?.(RooCodeEventName.TaskResumable, onTaskChanged),
				() => this.provider?.off?.(RooCodeEventName.TaskAskResponded, onTaskChanged),
			)
		}
		if (this.provider?.taskHistoryStore?.initialized) {
			void this.provider.taskHistoryStore.initialized.then(() => {
				this.emit("taskHistoryChanged")
			})
		}
	}

	public unregisterWebviewProvider(_viewId: string): void {
		for (const cleanup of this.providerCleanupFns) {
			try {
				cleanup()
			} catch {}
		}
		this.providerCleanupFns = []
		this.provider = null
	}

	public getProvider(): any {
		return this.provider
	}

	public getActiveTaskId(): string | null {
		return this.activeTaskId
	}

	public async setActiveTaskId(taskId: string | null): Promise<void> {
		this.activeTaskId = taskId
		if (taskId) {
			await this.markChatRead(taskId)
		}
	}

	public async markChatRead(taskId: string): Promise<void> {
		if (!taskId || this.deletedTaskIds.has(taskId)) return
		let changed = false

		if (this.provider?.taskHistoryStore) {
			try {
				const item = this.provider.taskHistoryStore.get?.(taskId)
				if (item && item.hasUnread) {
					await this.provider.taskHistoryStore.upsert({
						...item,
						hasUnread: false,
						lastReadTs: Date.now(),
					})
					changed = true
				}
			} catch (e) {
				console.warn("[DesktopAgentHost] Error updating taskHistoryStore on markChatRead:", e)
			}
		}

		if (this.storageDir) {
			try {
				const itemPath = path.join(this.storageDir, "global-storage", "tasks", taskId, "history_item.json")
				if (fs.existsSync(itemPath)) {
					const raw = JSON.parse(fs.readFileSync(itemPath, "utf-8"))
					if (raw && raw.hasUnread) {
						raw.hasUnread = false
						raw.lastReadTs = Date.now()
						fs.writeFileSync(itemPath, JSON.stringify(raw, null, 2), "utf-8")
						changed = true
					}
				}
			} catch {}
		}

		if (changed) {
			this.emit("taskHistoryChanged")
		}
	}

	public async handleTaskCompleted(taskId: string): Promise<void> {
		if (!taskId || this.deletedTaskIds.has(taskId)) return
		const isBackground = taskId !== this.activeTaskId
		let changed = false

		if (this.provider?.taskHistoryStore) {
			try {
				const item = this.provider.taskHistoryStore.get?.(taskId)
				if (item) {
					const targetStatus = item.status === "blocked" || item.isBlockedOutcome ? "blocked" : "completed"
					const updated = {
						...item,
						status: targetStatus,
						needsAttention: false,
						hasUnread: isBackground,
						lastAssistantMessageTs: Date.now(),
						...(isBackground ? {} : { lastReadTs: Date.now() }),
					}
					await this.provider.taskHistoryStore.upsert(updated)
					changed = true
				}
			} catch (e) {
				console.warn("[DesktopAgentHost] Error updating taskHistoryStore on completion:", e)
			}
		}

		if (this.storageDir) {
			try {
				const itemPath = path.join(this.storageDir, "global-storage", "tasks", taskId, "history_item.json")
				if (fs.existsSync(itemPath)) {
					const raw = JSON.parse(fs.readFileSync(itemPath, "utf-8"))
					if (raw) {
						if (raw.status !== "blocked" && !raw.isBlockedOutcome) {
							raw.status = "completed"
						}
						raw.needsAttention = false
						raw.hasUnread = isBackground
						raw.lastAssistantMessageTs = Date.now()
						if (!isBackground) {
							raw.lastReadTs = Date.now()
						}
						fs.writeFileSync(itemPath, JSON.stringify(raw, null, 2), "utf-8")
						changed = true
					}
				}
			} catch {}
		}

		if (changed) {
			this.emit("taskHistoryChanged")
		}
		const item = this.provider?.taskHistoryStore?.get?.(taskId)
		if (item?.titleSource === "fallback" && item.task) this.triggerBackgroundTitleGeneration(taskId, item.task)
	}

	public getChatsByWorkspace(): Record<string, SidebarChatEntry[]> {
		let items: any[] = []

		// 1. Try in-memory provider.taskHistoryStore
		if (this.provider?.taskHistoryStore && typeof this.provider.taskHistoryStore.getAll === "function") {
			try {
				const storeItems = this.provider.taskHistoryStore.getAll()
				if (Array.isArray(storeItems)) {
					items = [...storeItems]
				}
			} catch (e) {
				console.warn("[DesktopAgentHost] Error getting task history from store:", e)
			}
		}

		// 2. Fallback to index on disk if empty
		if (items.length === 0 && this.storageDir) {
			try {
				const indexPath = path.join(this.storageDir, "global-storage", "tasks", "_index.json")
				if (fs.existsSync(indexPath)) {
					const content = fs.readFileSync(indexPath, "utf-8")
					const parsed = JSON.parse(content)
					if (Array.isArray(parsed?.entries)) {
						items = parsed.entries
					}
				}
			} catch {}
		}
		if (!this.titleRepairScheduled && items.length > 0 && this.provider?.taskHistoryStore) {
			void this.repairExistingBadAutoTitles()
		}

		// 3. Fallback to reading task folders on disk
		if (items.length === 0 && this.storageDir) {
			try {
				const tasksDir = path.join(this.storageDir, "global-storage", "tasks")
				if (fs.existsSync(tasksDir)) {
					const entries = fs.readdirSync(tasksDir, { withFileTypes: true })
					for (const entry of entries) {
						if (entry.isDirectory() && entry.name !== "checkpoints") {
							const itemPath = path.join(tasksDir, entry.name, "history_item.json")
							if (fs.existsSync(itemPath)) {
								try {
									const hItem = JSON.parse(fs.readFileSync(itemPath, "utf-8"))
									if (hItem && hItem.id) items.push(hItem)
								} catch {}
							}
						}
					}
				}
			} catch {}
		}

		const result: Record<string, SidebarChatEntry[]> = {}

		for (const item of items) {
			if (!item || !item.id || this.deletedTaskIds.has(String(item.id))) continue
			let ws = ""
			if (item.workspace && typeof item.workspace === "string" && item.workspace.trim()) {
				ws = canonicalizePath(item.workspace.trim())
			} else {
				ws = "__unassigned__"
			}

			let status: "running" | "needs_attention" | "queued" | "completed" | "failed" = "completed"
			const runningTask = this.provider?.runningTasks?.get(String(item.id))
			if (runningTask) {
				const lastAsk = runningTask.clineMessages
					? [...runningTask.clineMessages].reverse().find((m: any) => m.type === "ask")
					: undefined

				const isAnswered =
					runningTask.askResponse !== undefined || lastAsk?.isAnswered === true

				const pendingAskType =
					isAnswered
						? undefined
						: (runningTask.currentAskType ??
							runningTask.taskAsk?.ask ??
							(!runningTask.isStreaming ? lastAsk?.ask : undefined))

				const isUserDecisionRequired =
					!isAnswered && lastAsk?.approvalState === "USER_DECISION_REQUIRED"

				const isEvaluating =
					!isAnswered && lastAsk?.approvalState === "EVALUATING"

				const isAutoApproved =
					lastAsk?.approvalState === "AUTO_APPROVED"

				const isTaskRunning =
					runningTask.taskStatus === "running"

				const isCompleted =
					runningTask.isTaskCompleted === true ||
					pendingAskType === "resume_completed_task" ||
					(!runningTask.isStreaming && !isUserDecisionRequired && !isEvaluating && runningTask.taskStatus === "idle")

				const isAborted = runningTask.abort === true || runningTask.abandoned === true

				if (isCompleted) {
					status = "completed"
				} else if (isAborted) {
					status = item.status === "failed" ? "failed" : "completed"
				} else {
					const isWaitingInteractiveUser =
						!isAnswered &&
						!runningTask.isStreaming &&
						!runningTask.isWaitingForFirstChunk &&
						!runningTask.autoApprovalTimeoutRef &&
						!isEvaluating &&
						!isAutoApproved &&
						(isUserDecisionRequired ||
							runningTask.taskStatus === "interactive" ||
							pendingAskType === "resume_task" ||
							pendingAskType === "followup" ||
							pendingAskType === "plan_mode_response" ||
							pendingAskType === "mistake_limit_reached" ||
							pendingAskType === "auto_approval_max_req_reached" ||
							((pendingAskType === "command" ||
								pendingAskType === "tool" ||
								pendingAskType === "use_mcp_server" ||
								pendingAskType === "api_req_failed") &&
								(isUserDecisionRequired || runningTask.taskStatus === "interactive" || (runningTask.taskStatus === undefined && !isAutoApproved && !isEvaluating))))

					if (isWaitingInteractiveUser) {
						status = "needs_attention"
					} else if (
						isAnswered ||
						runningTask.isStreaming ||
						runningTask.isWaitingForFirstChunk ||
						runningTask.autoApprovalTimeoutRef ||
						isEvaluating ||
						isAutoApproved ||
						isTaskRunning
					) {
						status = "running"
					} else {
						status = isUserDecisionRequired ? "needs_attention" : (runningTask.taskStatus === "idle" ? "completed" : "running")
					}
				}
				if (runningTask.isStarted === false && !runningTask.isStreaming && !isAnswered && !isTaskRunning) {
					status = ((item.status === "interrupted" || pendingAskType === "resume_task" || isUserDecisionRequired) && item.status !== "delegated")
						? "needs_attention"
						: "completed"
				}
			} else if (item.status === "failed") {
				status = "failed"
			} else if (item.status === "completed" || item.status === "blocked" || item.status === "cancelled" || item.status === "delegated") {
				status = "completed"
			} else if (item.status === "interrupted" || item.status === "active" || (item as any).needsAttention === true) {
				status = "needs_attention"
			} else {
				status = "completed"
			}

			const isChatActive = String(item.id) === this.activeTaskId
			const hasUnread = isChatActive || item.status === "delegated" ? false : Boolean(item.hasUnread)

			const creationTs = item.createdAt ?? extractCreationTimestamp(String(item.id), typeof item.ts === "number" ? item.ts : 0)
			const list = result[ws] ?? []
			const fallback = semanticFallbackTitle(item.task)
			const displayTitle = item.titleSource === "manual"
				? formatChatTitle(item.task, item.title)
				: (!item.title || isBadAutoTitle(item.title, item.titleSource))
					? (fallback !== "New conversation task" ? fallback : formatChatTitle(item.task, item.title))
					: formatChatTitle(item.task, item.title)
			list.push({
				id: String(item.id),
				title: displayTitle,
				titleSource: item.titleSource,
				createdAt: creationTs,
				ts: typeof item.ts === "number" ? item.ts : creationTs,
				status,
				hasUnread,
				lastReadTs: typeof item.lastReadTs === "number" ? item.lastReadTs : undefined,
			})
			result[ws] = list
		}

		// Sort each workspace's chats strictly by creation timestamp descending (newest first).
		// Internal agent actions (thinking, tools, diffs, completions) never alter list position.
		for (const ws of Object.keys(result)) {
			result[ws]?.sort((a, b) => {
				const aOrder = a.createdAt ?? a.ts
				const bOrder = b.createdAt ?? b.ts
				if (bOrder !== aOrder) return bOrder - aOrder
				return String(b.id).localeCompare(String(a.id))
			})
		}

		return result
	}

	public async showTaskWithId(taskId: string): Promise<void> {
		if (!taskId || typeof taskId !== "string" || this.deletedTaskIds.has(taskId)) return
		this.activeTaskId = taskId
		await this.markChatRead(taskId)
		if (this.provider && typeof this.provider.showTaskWithId === "function") {
			try {
				await this.provider.showTaskWithId(taskId)
			} catch (err) {
				console.warn("[DesktopAgentHost] provider.showTaskWithId error:", err)
			}
		} else {
			this.sendToExtension({ type: "showTaskWithId", text: taskId } as any)
		}
	}

	public async clearTask(): Promise<void> {
		this.activeTaskId = null
		if (this.terminalLogs.length > 0) {
			this.archivedTerminalLogs.push({
				workspace: this.currentWorkspace,
				timestamp: Date.now(),
				logs: [...this.terminalLogs],
			})
			if (this.archivedTerminalLogs.length > 20) {
				this.archivedTerminalLogs.shift()
			}
		}
		// Reset active display logs for completed/cleared view, but keep workspace maps intact
		this.terminalLogs = []
		this.diffFiles.clear()
		this.emit("terminalLogsCleared")
		this.emit("diffsUpdated", [])
		if (this.provider && typeof (this.provider as any).clearTask === "function") {
			try {
				await (this.provider as any).clearTask()
			} catch (err) {
				console.warn("[DesktopAgentHost] provider.clearTask error:", err)
			}
		} else {
			this.sendToExtension({ type: "clearTask" } as any)
		}
	}

	/**
	 * Trigger asynchronous semantic conversation title generation in the background.
	 * Never blocks the task or worker startup. Runs with timeout, tombstone, and abort safety.
	 */
	public triggerBackgroundTitleGeneration(taskId: string, promptText: string): void {
		if (!taskId || typeof taskId !== "string" || this.deletedTaskIds.has(taskId)) {
			return
		}
		if (this.titleGenerationTaskIds.has(taskId)) {
			return
		}
		const existingItem = this.provider?.taskHistoryStore?.get?.(taskId)
		if (!existingItem || existingItem.titleSource === "manual" || existingItem.titleSource === "generated_ai") return

		this.titleGenerationTaskIds.add(taskId)
		const abortController = new AbortController()
		this.pendingTitleAbortControllers.set(taskId, abortController)

		void (async () => {
			try {
				// Make the sidebar useful immediately; the auxiliary request can finish later.
				if (!existingItem.title || isBadAutoTitle(existingItem.title, existingItem.titleSource)) {
					await this.applyConversationTitle(taskId, semanticFallbackTitle(promptText), "fallback", abortController.signal)
				}
				const task = this.provider?.runningTasks?.get?.(taskId) ??
					(this.provider?.getCurrentTask?.()?.taskId === taskId ? this.provider.getCurrentTask() : undefined)
				// One low-priority request, only when the worker is not actively streaming.
				if (this.titleAiAttemptedTaskIds.has(taskId) || task?.isStreaming ||
					(task?.isStarted === false && !task?.isTaskCompleted) ||
					(task?.taskStatus === "running" && !task?.isTaskCompleted)) return
				const completion = task?.api?.completePrompt
				if (typeof completion !== "function") return
				this.titleAiAttemptedTaskIds.add(taskId)
				const completeFn = async (p: string, signal?: AbortSignal): Promise<string> => {
					if (signal?.aborted) throw new Error("Title request aborted")
					return completion.call(task.api, p)
				}

				const res = await generateConversationTitle({
					taskId,
					prompt: promptText,
					completeFn,
					signal: abortController.signal,
					provider: task?.apiConfiguration?.apiProvider,
					model: task?.historyItem?.chatModelId,
					onAudit: (audit) => {
						console.log(
							`[ConversationTitleAudit] conversationId=${audit.conversationId} status=${audit.status} latency=${audit.latencyMs}ms titleSource=${audit.titleSource}`,
						)
					},
				})
				if (res.titleSource === "generated_ai") await this.applyConversationTitle(taskId, res.title, res.titleSource, abortController.signal)
			} catch (err) {
				console.warn(`[DesktopAgentHost] Background title generation error for ${taskId}:`, err)
			} finally {
				this.pendingTitleAbortControllers.delete(taskId)
				this.titleGenerationTaskIds.delete(taskId)
			}
		})()
	}

	private async applyConversationTitle(taskId: string, title: string, titleSource: TitleSource, signal?: AbortSignal): Promise<void> {
		const store = this.provider?.taskHistoryStore
		if (signal?.aborted || this.deletedTaskIds.has(taskId) || store?.isDeleted?.(taskId)) return
		const current = store?.get?.(taskId)
		if (!current || current.titleSource === "manual") return
		await store.upsert({ ...current, title, titleSource })
		const saved = store.get?.(taskId)
		if (signal?.aborted || this.deletedTaskIds.has(taskId) || !saved || saved.titleSource === "manual" || saved.title !== title) return
		this.emit("conversationTitleUpdated", { taskId, title, titleSource })
	}

	private async repairExistingBadAutoTitles(): Promise<void> {
		const store = this.provider?.taskHistoryStore
		const items = store?.getAll?.()
		if (!Array.isArray(items) || items.length === 0 || this.titleRepairScheduled) return
		this.titleRepairScheduled = true
		for (const item of items) {
			if (!isBadAutoTitle(item.title, item.titleSource) || !item.task) continue
			const title = semanticFallbackTitle(item.task)
			if (title === "New conversation task") continue
			try {
				await this.applyConversationTitle(item.id, title, "fallback")
			} catch (error) {
				console.warn(`[DesktopAgentHost] Failed to repair title for ${item.id}:`, error)
			}
		}
	}

	public async renameChat(taskId: string, newTitle: string): Promise<boolean> {
		if (!taskId || this.deletedTaskIds.has(taskId)) return false
		const cleanTitle = sanitizeTitle(newTitle, "Untitled Task")

		// Abort any pending AI title generation
		const controller = this.pendingTitleAbortControllers.get(taskId)
		if (controller) {
			controller.abort()
			this.pendingTitleAbortControllers.delete(taskId)
		}
		this.titleGenerationTaskIds.add(taskId)

		let changed = false
		if (this.provider?.taskHistoryStore) {
			const item = this.provider.taskHistoryStore.get?.(taskId)
			if (item) {
				await this.provider.taskHistoryStore.upsert({
					...item,
					title: cleanTitle,
					titleSource: "manual",
				})
				changed = true
			}
		}

		if (this.storageDir) {
			const candidatePaths = [
				path.join(this.storageDir, "global-storage", "tasks", taskId, "history_item.json"),
				path.join(this.storageDir, "tasks", taskId, "history_item.json"),
				path.join(this.storageDir, "Roo-Code", "tasks", taskId, "history_item.json"),
			]
			for (const itemPath of candidatePaths) {
				if (fs.existsSync(itemPath)) {
					try {
						const rawItem = JSON.parse(fs.readFileSync(itemPath, "utf-8"))
						rawItem.title = cleanTitle
						rawItem.titleSource = "manual"
						fs.writeFileSync(itemPath, JSON.stringify(rawItem, null, 2), "utf-8")
						changed = true
					} catch {}
				}
			}
		}

		this.emit("conversationTitleUpdated", { taskId, title: cleanTitle, titleSource: "manual" })
		this.emit("taskHistoryChanged")
		return changed
	}

	public isTaskDeleted(taskId: string): boolean {
		return this.deletedTaskIds.has(taskId)
	}

	public isTaskRunning(taskId: string): boolean {
		if (this.deletedTaskIds.has(taskId)) return false
		const runningTask = this.provider?.runningTasks?.get(taskId)
		if (runningTask) {
			return (
				runningTask.taskStatus === "running" ||
				runningTask.isStreaming === true ||
				runningTask.isWaitingForFirstChunk === true
			)
		}
		const curTask = this.provider?.getCurrentTask?.()
		if (curTask && curTask.taskId === taskId) {
			return (
				curTask.taskStatus === "running" ||
				curTask.isStreaming === true ||
				curTask.isWaitingForFirstChunk === true
			)
		}
		return false
	}

	public async stopTask(taskId: string): Promise<boolean> {
		const runningTask =
			this.provider?.runningTasks?.get(taskId) ||
			(this.provider?.getCurrentTask?.()?.taskId === taskId ? this.provider.getCurrentTask() : undefined)

		if (!runningTask) return true

		try {
			if (typeof this.provider?.cancelTask === "function") {
				await this.provider.cancelTask(taskId)
			} else {
				runningTask.cancelCurrentRequest?.()
				runningTask.abortCompaction?.()
				runningTask.abortReason = "user_cancelled"
				runningTask.abort = true
				if (typeof runningTask.abortTask === "function") {
					await runningTask.abortTask(true)
				}
				runningTask.abandoned = true
				this.provider?.runningTasks?.delete(taskId)
			}
			return true
		} catch (err) {
			console.error(`[DesktopAgentHost] Failed to stop task ${taskId}:`, err)
			return false
		}
	}

	public async deleteChat(
		taskId: string,
		forceStop: boolean = false
	): Promise<{ success: boolean; error?: string; requiresStop?: boolean; reason?: string; runningCount?: number }> {
		if (!taskId || typeof taskId !== "string") {
			return { success: false, error: "Invalid task ID" }
		}

		if (this.deletedTaskIds.has(taskId)) {
			return { success: true }
		}

		if (this.isTaskRunning(taskId)) {
			if (!forceStop) {
				return {
					success: false,
					requiresStop: true,
					reason: "requires_force_stop",
					runningCount: 1,
					error: "This chat currently has an active task.",
				}
			}
			const stopped = await this.stopTask(taskId)
			if (!stopped) {
				return { success: false, error: "Failed to stop active task before deletion." }
			}
		}

		// 1. Mark tombstone to block any late asynchronous callbacks from recreating/touching it
		this.deletedTaskIds.add(taskId)
		const pendingTitleController = this.pendingTitleAbortControllers.get(taskId)
		if (pendingTitleController) {
			pendingTitleController.abort()
			this.pendingTitleAbortControllers.delete(taskId)
		}

		// 2. Identify the workspace for this chat to handle active task fallback selection
		const chatsByWs = this.getChatsByWorkspace()
		let taskWs: string | null = null
		for (const [wsKey, chatList] of Object.entries(chatsByWs)) {
			if (chatList.some((c) => c.id === taskId)) {
				taskWs = wsKey
				break
			}
		}
		if (!taskWs) {
			taskWs = this.currentWorkspace || "__unassigned__"
		}

		// 3. If currently selected/active task is the one being deleted:
		// Pick the next newest chat in the same workspace or clear task
		const currentActiveId = this.activeTaskId || this.provider?.getCurrentTask?.()?.taskId
		const wasActive = currentActiveId === taskId
		if (wasActive) {
			const remainingChats = (chatsByWs[taskWs] || []).filter(
				(c) => c.id !== taskId && !this.deletedTaskIds.has(c.id)
			)
			if (remainingChats.length > 0) {
				await this.showTaskWithId(remainingChats[0]!.id)
			} else {
				await this.clearTask()
			}
		}

		// 4. Dispose runtime ownership
		if (this.provider?.runningTasks?.has(taskId)) {
			this.provider.runningTasks.delete(taskId)
		}
		if (this.provider?.getCurrentTask?.()?.taskId === taskId) {
			try {
				await this.provider.removeClineFromStack?.()
			} catch {}
		}

		// Clean up chat-owned terminal logs
		this.terminalLogs = this.terminalLogs.filter((s) => s.taskId !== taskId)
		for (const [wsKey, logs] of this.terminalLogsByWorkspace.entries()) {
			this.terminalLogsByWorkspace.set(
				wsKey,
				logs.filter((s) => s.taskId !== taskId)
			)
		}
		this.emit("terminalLogsUpdated", this.terminalLogs)

		// 5. Delete persistence via provider or direct fallback
		if (this.provider && typeof this.provider.deleteTaskWithId === "function") {
			try {
				await this.provider.deleteTaskWithId(taskId)
			} catch (err) {
				console.warn(`[DesktopAgentHost] provider.deleteTaskWithId error:`, err)
			}
		}

		if (this.provider?.taskHistoryStore) {
			if (typeof this.provider.taskHistoryStore.deleteTaskWithId === "function") {
				try {
					await this.provider.taskHistoryStore.deleteTaskWithId(taskId)
				} catch {}
			} else if (typeof this.provider.taskHistoryStore.delete === "function") {
				try {
					await this.provider.taskHistoryStore.delete(taskId)
				} catch {}
			}
		}

		if (this.storageDir) {
			try {
				const appDataDir = process.env.APPDATA || os.homedir()
				const candidateDirs = [
					path.join(this.storageDir, "global-storage", "tasks", taskId),
					path.join(this.storageDir, "tasks", taskId),
					path.join(this.storageDir, "Roo-Code", "tasks", taskId),
					path.join(appDataDir, "Roo-Code", "tasks", taskId),
					path.join(appDataDir, ".roo-desktop-data", "global-storage", "tasks", taskId),
					path.join(appDataDir, ".roo-desktop-data", "tasks", taskId),
				]
				for (const d of candidateDirs) {
					if (fs.existsSync(d)) {
						fs.rmSync(d, { recursive: true, force: true })
					}
				}
				const indexPath = path.join(this.storageDir, "global-storage", "tasks", "_index.json")
				if (fs.existsSync(indexPath)) {
					const content = fs.readFileSync(indexPath, "utf-8")
					const parsed = JSON.parse(content)
					if (Array.isArray(parsed?.entries)) {
						parsed.entries = parsed.entries.filter((e: any) => e.id !== taskId)
						fs.writeFileSync(indexPath, JSON.stringify(parsed, null, 2), "utf-8")
					}
				}
			} catch (err) {
				console.warn(`[DesktopAgentHost] storageDir task cleanup error:`, err)
			}
		}

		this.emit("taskHistoryChanged")
		return { success: true }
	}

	public getRunningTasksForWorkspace(workspacePath: string): string[] {
		const normWs = canonicalizePath(workspacePath)
		const running: string[] = []
		if (this.provider?.runningTasks) {
			for (const [taskId, task] of this.provider.runningTasks.entries()) {
				if (this.deletedTaskIds.has(taskId)) continue
				const taskWs = task.cwd ? canonicalizePath(task.cwd) : ""
				if (arePathsEqual(taskWs, normWs) && this.isTaskRunning(taskId)) {
					running.push(taskId)
				}
			}
		}
		const curTask = this.provider?.getCurrentTask?.()
		if (curTask && !this.deletedTaskIds.has(curTask.taskId)) {
			const taskWs = curTask.cwd ? canonicalizePath(curTask.cwd) : ""
			if (
				arePathsEqual(taskWs, normWs) &&
				this.isTaskRunning(curTask.taskId) &&
				!running.includes(curTask.taskId)
			) {
				running.push(curTask.taskId)
			}
		}
		return running
	}

	/** Reassociate an already moved project. No filesystem move or conversation deletion. */
	public async relocateProject(oldPath: string, newPath: string): Promise<void> {
		const previous = canonicalizePath(oldPath)
		const next = canonicalizePath(newPath)
		if (!previous || !next || !fs.existsSync(next) || !fs.statSync(next).isDirectory()) throw new Error("Wybierz istniejący folder projektu.")
		if (arePathsEqual(previous, next)) return
		if (this.getRunningTasksForWorkspace(previous).length || this.getRunningTasksForWorkspace(next).length) throw new Error("Zatrzymaj zadania w obu projektach przed zmianą lokalizacji.")
		const store = this.provider?.taskHistoryStore
		if (!store?.getAll || !store?.upsert) throw new Error("Historia nie jest jeszcze gotowa. Spróbuj ponownie za chwilę.")
		const affected = store.getAll().filter((item: any) => item.workspace && arePathsEqual(item.workspace, previous))
		const updated: any[] = []
		try {
			for (const item of affected) { await store.upsert({ ...item, workspace: next }); updated.push(item) }
		} catch (error) {
			for (const item of updated) await store.upsert(item)
			throw error
		}
		const config = loadDesktopConfig()
		const names = { ...config.projectNames }
		for (const key of Object.keys(names)) if (arePathsEqual(key, previous)) { const label = names[key]; if (label) names[next] = label; delete names[key] }
		const recent = (config.recentWorkspaces || []).map(value => arePathsEqual(value, previous) ? next : value)
		if (!recent.some(value => arePathsEqual(value, next))) recent.push(next)
		const saved = saveDesktopConfig({ recentWorkspaces: [...new Set(recent)], projectNames: names,
			lastWorkspacePath: arePathsEqual(config.lastWorkspacePath || "", previous) ? next : config.lastWorkspacePath })
		if (!saved.recentWorkspaces?.some(value => arePathsEqual(value, next)) || saved.recentWorkspaces.some(value => arePathsEqual(value, previous))) {
			for (const item of updated) await store.upsert(item)
			throw new Error("Nie udało się zapisać nowej lokalizacji. Dotychczasowe przypisanie zostało zachowane.")
		}
		this.terminalLogsByWorkspace.delete(previous)
		this.diffFilesByWorkspace.delete(previous)
		if (arePathsEqual(this.currentWorkspace, previous)) await this.setWorkspace(next)
		this.emit("taskHistoryChanged")
	}

	public async removeProject(
		workspacePath: string,
		forceStop: boolean = false
	): Promise<{ success: boolean; error?: string; requiresStop?: boolean; reason?: string; runningCount?: number; activeTasksCount?: number }> {
		if (!workspacePath || typeof workspacePath !== "string" || !workspacePath.trim()) {
			return { success: false, error: "Invalid workspace path" }
		}

		const normWs = canonicalizePath(workspacePath)
		const activeTaskIds = this.getRunningTasksForWorkspace(normWs)

		if (activeTaskIds.length > 0) {
			if (!forceStop) {
				return {
					success: false,
					requiresStop: true,
					reason: "requires_force_stop",
					runningCount: activeTaskIds.length,
					activeTasksCount: activeTaskIds.length,
					error: `This project has ${activeTaskIds.length} active task(s).`,
				}
			}
			for (const tId of activeTaskIds) {
				const stopped = await this.stopTask(tId)
				if (!stopped) {
					return { success: false, error: `Failed to stop active task ${tId}` }
				}
			}
		}

		// 1. HARD SAFETY CHECK: NEVER DELETE THE PHYSICAL PROJECT FOLDER ON DISK!
		// Verify that we only delete Roo-local conversation data in global-storage.

		// 2. Collect all task IDs belonging to this workspace
		const chatsByWs = this.getChatsByWorkspace()
		let projectChats: Array<{ id: string }> = []
		for (const [wsKey, chatList] of Object.entries(chatsByWs)) {
			if (arePathsEqual(wsKey, normWs)) {
				projectChats = chatList
				break
			}
		}

		const allTaskIds = new Set<string>(projectChats.map((c) => c.id))
		for (const tId of activeTaskIds) {
			allTaskIds.add(tId)
		}

		if (this.storageDir) {
			try {
				const indexPath = path.join(this.storageDir, "global-storage", "tasks", "_index.json")
				if (fs.existsSync(indexPath)) {
					const content = fs.readFileSync(indexPath, "utf-8")
					const parsed = JSON.parse(content)
					if (Array.isArray(parsed?.entries)) {
						for (const entry of parsed.entries) {
							if (entry?.workspace && arePathsEqual(canonicalizePath(entry.workspace), normWs)) {
								allTaskIds.add(String(entry.id))
							}
						}
					}
				}
			} catch {}
		}

		// 3. Tombstone and delete each chat belonging to this project
		for (const taskId of allTaskIds) {
			this.deletedTaskIds.add(taskId)
			const pendingTitleController = this.pendingTitleAbortControllers.get(taskId)
			if (pendingTitleController) {
				pendingTitleController.abort()
				this.pendingTitleAbortControllers.delete(taskId)
			}
			if (this.activeTaskId === taskId) {
				this.activeTaskId = null
			}
			if (this.provider?.runningTasks?.has(taskId)) {
				this.provider.runningTasks.delete(taskId)
			}
			if (this.provider && typeof this.provider.deleteTaskWithId === "function") {
				try {
					await this.provider.deleteTaskWithId(taskId)
				} catch {}
			}
			if (this.storageDir) {
				try {
					const candidateDirs = [
						path.join(this.storageDir, "global-storage", "tasks", taskId),
						path.join(this.storageDir, "tasks", taskId),
						path.join(this.storageDir, "Roo-Code", "tasks", taskId),
					]
					for (const d of candidateDirs) {
						if (fs.existsSync(d)) {
							fs.rmSync(d, { recursive: true, force: true })
						}
					}
				} catch {}
			}
		}

		if (this.provider?.taskHistoryStore && typeof this.provider.taskHistoryStore.deleteMany === "function") {
			try {
				await this.provider.taskHistoryStore.deleteMany(Array.from(allTaskIds))
			} catch {}
		}

		if (this.storageDir && allTaskIds.size > 0) {
			try {
				const indexPath = path.join(this.storageDir, "global-storage", "tasks", "_index.json")
				if (fs.existsSync(indexPath)) {
					const content = fs.readFileSync(indexPath, "utf-8")
					const parsed = JSON.parse(content)
					if (Array.isArray(parsed?.entries)) {
						parsed.entries = parsed.entries.filter((e: any) => !allTaskIds.has(String(e.id)))
						fs.writeFileSync(indexPath, JSON.stringify(parsed, null, 2), "utf-8")
					}
				}
			} catch {}
		}

		// 4. Clean up workspace-associated caches
		this.terminalLogsByWorkspace.delete(normWs)
		this.diffFilesByWorkspace.delete(normWs)

		// 5. Update configuration: remove from recentWorkspaces
		const curCfg = loadDesktopConfig()
		const updatedWorkspaces = (curCfg.recentWorkspaces || []).filter((p) => !arePathsEqual(p, normWs))
		const projectNames = Object.fromEntries(
			Object.entries(curCfg.projectNames || {}).filter(([projectPath]) => !arePathsEqual(projectPath, normWs))
		)
		let nextWorkspace = curCfg.lastWorkspacePath
		if (arePathsEqual(curCfg.lastWorkspacePath || "", normWs)) {
			nextWorkspace = updatedWorkspaces.length > 0 ? updatedWorkspaces[0] : ""
		}
		saveDesktopConfig({
			recentWorkspaces: updatedWorkspaces,
			lastWorkspacePath: nextWorkspace,
			projectNames,
		})

		// 6. If currently active workspace is the removed one, switch to next or empty
		if (arePathsEqual(this.currentWorkspace, normWs)) {
			if (updatedWorkspaces.length > 0) {
				await this.setWorkspace(updatedWorkspaces[0])
			} else {
				await this.setWorkspace("")
			}
		}

		this.emit("taskHistoryChanged")
		return { success: true }
	}

	public sendToExtension(message: WebviewMessage): void {
		this.emit("webviewMessage", message)
		if (
			message.type === "askResponse" ||
			message.type === "newTask"
		) {
			this.emit("taskHistoryChanged")
		}
	}

	public setStatus(status: AgentStatusType): void {
		this.status = status
		this.emit("statusChange", status)
	}

	private processExtensionMessage(msg: ExtensionMessage): void {
		const raw = msg as Record<string, any>
		const workspace = raw.workspacePath ? this.workspaceStateKey(raw.workspacePath) : this.currentWorkspace
		const isCurrentWorkspace = workspace === this.currentWorkspace
		let terminalLogs = this.terminalLogs
		let diffFiles = this.diffFiles
		if (!isCurrentWorkspace) {
			terminalLogs = this.terminalLogsByWorkspace.get(workspace) || []
			diffFiles = this.diffFilesByWorkspace.get(workspace) || new Map()
			this.terminalLogsByWorkspace.set(workspace, terminalLogs)
			this.diffFilesByWorkspace.set(workspace, diffFiles)
		}
		const emitCurrent = (event: string, payload: unknown) => {
			if (isCurrentWorkspace) this.emit(event, payload)
		}

		// Handle terminal session lifecycle events from extension
		if (raw.type === "terminalSessionStarted") {
			const id = String(raw.id || `cmd-${Date.now()}`)
			const command = String(raw.command || "")
			const cwd = String(raw.cwd || workspace || "")
			const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : Date.now()

			let session = terminalLogs.find((s) => s.id === id)
			if (!session) {
				session = {
					id,
					command,
					cwd,
					timestamp,
					output: "",
					status: "running",
				}
				terminalLogs.push(session)
				if (terminalLogs.length > 200) terminalLogs.shift()
			} else {
				if (command) session.command = command
				if (cwd) session.cwd = cwd
				session.timestamp = timestamp
				session.status = "running"
			}
			emitCurrent("terminalSessionStarted", {
				id: session.id,
				command: session.command,
				cwd: session.cwd,
				timestamp: session.timestamp,
			})
			emitCurrent("terminalLog", session)
		} else if (raw.type === "terminalOutput") {
			const id = String(raw.id || "")
			const data = String(raw.data || "")
			let session = id ? terminalLogs.find((s) => s.id === id) : undefined
			if (!id && !session && terminalLogs.length > 0) {
				session = terminalLogs[terminalLogs.length - 1]
			}
			if (session) {
				const combined = (session.output || "") + data
				session.output = combined.length > 1024 * 1024 ? combined.slice(-1024 * 1024) : combined
				emitCurrent("terminalOutput", { id: session.id, data })
			}
		} else if (raw.type === "terminalSessionEnded") {
			const id = String(raw.id || "")
			const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : 0
			let session = id ? terminalLogs.find((s) => s.id === id) : undefined
			if (!id && !session && terminalLogs.length > 0) {
				session = terminalLogs[terminalLogs.length - 1]
			}
			if (session) {
				session.exitCode = exitCode
				session.status = exitCode === 0 ? "completed" : "error"
				emitCurrent("terminalSessionEnded", { id: session.id, exitCode })
				emitCurrent("terminalLog", session)
			}
		} else if (raw.type === "commandExecutionStatus") {
			let statusObj: any = null
			try {
				statusObj = typeof raw.text === "string" ? JSON.parse(raw.text) : (raw.status ? raw : null)
			} catch {}

			if (statusObj && statusObj.executionId) {
				const execId = String(statusObj.executionId)
				let session = terminalLogs.find((s) => s.id === execId)

				if (statusObj.status === "started") {
					if (!session) {
						session = {
							id: execId,
							command: statusObj.command || "",
							cwd: workspace || "",
							timestamp: Date.now(),
							output: "",
							status: "running",
						}
						terminalLogs.push(session)
						if (terminalLogs.length > 200) terminalLogs.shift()
						emitCurrent("terminalSessionStarted", {
							id: session.id,
							command: session.command,
							cwd: session.cwd,
							timestamp: session.timestamp,
						})
						emitCurrent("terminalLog", session)
					}
				} else if (statusObj.status === "output") {
					const outData = statusObj.output || ""
					if (!session) {
						session = {
							id: execId,
							command: "",
							cwd: workspace || "",
							timestamp: Date.now(),
							output: "",
							status: "running",
						}
						terminalLogs.push(session)
						if (terminalLogs.length > 200) terminalLogs.shift()
						emitCurrent("terminalLog", session)
						session.output = outData
					} else {
						const combined = (session.output || "") + outData
						session.output = combined.length > 1024 * 1024 ? combined.slice(-1024 * 1024) : combined
					}
					emitCurrent("terminalOutput", { id: execId, data: outData })
				} else if (statusObj.status === "exited") {
					const exitCode = typeof statusObj.exitCode === "number" ? statusObj.exitCode : 0
					if (session) {
						session.exitCode = exitCode
						session.status = exitCode === 0 ? "completed" : "error"
					}
					emitCurrent("terminalSessionEnded", { id: execId, exitCode })
					if (session) emitCurrent("terminalLog", session)
				} else if (statusObj.status === "timeout" || statusObj.status === "fallback") {
					if (session) {
						session.status = "error"
						session.exitCode = -1
						emitCurrent("terminalSessionEnded", { id: execId, exitCode: -1 })
						emitCurrent("terminalLog", session)
					}
				}
			}
		}

		// Handle workspace files changed event from engine
		if (raw.type === "workspaceFilesChanged" && Array.isArray(raw.files)) {
			for (const file of raw.files) {
				const relPath = (file.path || "").replace(/\\/g, "/")
				const absPath = file.absolutePath || (workspace ? path.resolve(workspace, relPath) : relPath)
				let newContent: string | undefined = undefined
				const existing = diffFiles.get(relPath)
				let oldContent: string | undefined = existing?.oldContent

				if (file.changeType !== "deleted" && fs.existsSync(absPath)) {
					try {
						newContent = fs.readFileSync(absPath, "utf-8")
					} catch {}
				}

				const status: "modified" | "added" | "deleted" =
					file.changeType === "created" ? "added" : file.changeType === "deleted" ? "deleted" : "modified"

				const entry: DiffFileEntry = {
					filePath: relPath,
					oldContent,
					newContent,
					status,
					additions: typeof file.additions === "number" ? file.additions : 0,
					deletions: typeof file.deletions === "number" ? file.deletions : 0,
				}
				diffFiles.set(relPath, entry)
			}
			emitCurrent("workspaceFilesChanged", raw.files)
			emitCurrent("diffsUpdated", Array.from(diffFiles.values()))
		}

		if (!isCurrentWorkspace) return

		// Detect agent status transitions
		const isTool = (raw.type === "say" && raw.say === "tool") || (raw.type === "ask" && raw.ask === "tool")
		if (isTool) {
			if (raw.type === "ask") {
				this.setStatus("waiting_approval")
			} else {
				this.setStatus("executing")
			}
			try {
				const toolData = typeof raw.text === "string" ? JSON.parse(raw.text) : raw.text
				if (toolData && toolData.tool === "execute_command") {
					this.recordTerminalLog(toolData.command || "")
				}
				if (
					toolData &&
					(toolData.tool === "write_to_file" ||
						toolData.tool === "apply_diff" ||
						toolData.tool === "editedExistingFile" ||
						toolData.tool === "newFileCreated" ||
						toolData.tool === "appliedDiff")
				) {
					this.handleToolFileChange(toolData)
				}
			} catch {
				// text wasn't JSON
			}
		} else if (raw.type === "say") {
			if (raw.say === "command") {
				this.setStatus("executing")
				this.recordTerminalLog(typeof raw.text === "string" ? raw.text : "")
			} else if (raw.say === "command_output") {
				this.updateLatestTerminalOutput(typeof raw.text === "string" ? raw.text : "")
			} else if (raw.say === "task") {
				this.setStatus("thinking")
				const taskId = this.provider?.getCurrentTask?.()?.taskId || this.activeTaskId || (raw as any).taskId
				if (taskId && typeof raw.text === "string" && raw.text.trim()) {
					this.triggerBackgroundTitleGeneration(taskId, raw.text.trim())
				}
			} else if (raw.say === "api_req_started") {
				this.setStatus("thinking")
			} else if (raw.say === "completion_result") {
				this.setStatus("idle")
				this.finishRunningTerminalLogs()
				const currentId = this.provider?.getCurrentTask?.()?.taskId || this.activeTaskId
				if (currentId && !this.deletedTaskIds.has(currentId)) {
					this.handleTaskCompleted(currentId).catch(() => {})
				}
			}
		} else if (raw.type === "ask") {
			this.setStatus("waiting_approval")
		} else if (raw.type === "state" && raw.state?.currentTaskId) {
			if (!this.deletedTaskIds.has(raw.state.currentTaskId) && !this.activeTaskId) {
				this.activeTaskId = raw.state.currentTaskId
			}
		} else if (raw.type === "showTaskWithId" && raw.text) {
			if (!this.deletedTaskIds.has(raw.text)) {
				this.activeTaskId = raw.text
				this.markChatRead(raw.text).catch(() => {})
			}
		} else if (raw.type === "clearTask") {
			this.activeTaskId = null
		}

		if (
			raw.type === "taskHistoryUpdated" ||
			raw.type === "taskHistoryItemUpdated" ||
			raw.type === "relinquishControl" ||
			(raw.type === "say" && (raw.say === "task" || raw.say === "completion_result"))
		) {
			this.emit("taskHistoryChanged")
		}

		// Relay to all attached UI clients
		this.emit("messageToUI", msg)
	}

	private recordTerminalLog(command: string, taskId?: string): void {
		if (!command || !command.trim()) return

		const now = Date.now()
		// Deduplicate: If the last log is for the same command within 2000ms and still running, don't duplicate
		const lastEntry = this.terminalLogs[this.terminalLogs.length - 1]
		if (lastEntry && lastEntry.command.trim() === command.trim() && now - lastEntry.timestamp < 2000) {
			if (taskId && !lastEntry.taskId) {
				lastEntry.taskId = taskId
			}
			return
		}

		const currentTaskId = taskId || this.provider?.getCurrentTask?.()?.taskId || this.activeTaskId || undefined
		const entry: TerminalLogEntry = {
			id: `cmd-${now}-${Math.random().toString(36).substring(2, 7)}`,
			timestamp: now,
			command,
			cwd: this.currentWorkspace,
			taskId: currentTaskId,
			output: "Running command in workspace...",
			status: "running",
		}
		this.terminalLogs.push(entry)
		if (this.terminalLogs.length > 200) this.terminalLogs.shift()
		this.emit("terminalSessionStarted", {
			id: entry.id,
			command: entry.command,
			cwd: entry.cwd || "",
			timestamp: entry.timestamp,
		})
		this.emit("terminalLog", entry)
	}

	private updateLatestTerminalOutput(output: string, taskId?: string): void {
		const currentTaskId = taskId || this.provider?.getCurrentTask?.()?.taskId || this.activeTaskId
		let targetEntry: TerminalLogEntry | undefined
		for (let i = this.terminalLogs.length - 1; i >= 0; i--) {
			const entry = this.terminalLogs[i]
			if (entry && entry.status === "running") {
				if (!targetEntry) targetEntry = entry
				if (currentTaskId && entry.taskId === currentTaskId) {
					targetEntry = entry
					break
				}
			}
		}

		if (!targetEntry && this.terminalLogs.length > 0) {
			targetEntry = this.terminalLogs[this.terminalLogs.length - 1]
		}

		if (targetEntry) {
			targetEntry.output = output || "(Command completed with no output)"
			targetEntry.status = "completed"
			this.emit("terminalOutput", { id: targetEntry.id, data: output })
			this.emit("terminalLog", targetEntry)
		}
	}

	private finishRunningTerminalLogs(): void {
		for (const log of this.terminalLogs) {
			if (log.status === "running") {
				log.status = "completed"
				this.emit("terminalSessionEnded", { id: log.id, exitCode: log.exitCode ?? 0 })
				this.emit("terminalLog", log)
			}
		}
	}

	private handleToolFileChange(toolData: any): void {
		const filePath = toolData.path
		if (!filePath) return

		const absPath = path.isAbsolute(filePath)
			? path.normalize(filePath)
			: path.normalize(path.resolve(this.currentWorkspace || "", filePath))
		const relPath = this.currentWorkspace
			? path.relative(this.currentWorkspace, absPath).replace(/\\/g, "/")
			: filePath.replace(/\\/g, "/")

		let oldContent: string | undefined = toolData.originalContent
		let newContent: string | undefined = typeof toolData.content === "string" ? toolData.content : undefined
		const fileExists = fs.existsSync(absPath)

		if (fileExists && newContent === undefined) {
			try {
				newContent = fs.readFileSync(absPath, "utf-8")
			} catch {}
		}

		const existing = this.diffFiles.get(relPath)
		if (!oldContent && existing?.oldContent) {
			oldContent = existing.oldContent
		}

		let status: "modified" | "added" | "deleted" = "modified"
		if (toolData.tool === "newFileCreated" || (!fileExists && !existing)) {
			status = "added"
		} else if (toolData.tool === "deleted") {
			status = "deleted"
		}

		let additions = 0
		let deletions = 0

		if (toolData.diffStats && typeof toolData.diffStats === "object") {
			additions = toolData.diffStats.added ?? 0
			deletions = toolData.diffStats.removed ?? 0
		} else if (newContent) {
			const newLines = newContent.split("\n").length
			const oldLines = oldContent ? oldContent.split("\n").length : 0
			if (status === "added") {
				additions = newLines
				deletions = 0
			} else {
				additions = Math.max(1, newLines)
				deletions = oldLines > 0 && newLines > 0 ? Math.max(0, oldLines - newLines) : 0
			}
		}

		const entry: DiffFileEntry = {
			filePath: relPath,
			oldContent: oldContent ?? existing?.oldContent,
			newContent: newContent ?? existing?.newContent,
			status,
			additions: additions || existing?.additions || 0,
			deletions: deletions || existing?.deletions || 0,
		}

		this.diffFiles.set(relPath, entry)
		if (this.activeTaskId) {
			let taskMap = this.diffFilesByTask.get(this.activeTaskId)
			if (!taskMap) {
				taskMap = new Map()
				this.diffFilesByTask.set(this.activeTaskId, taskMap)
			}
			taskMap.set(relPath, entry)
		}
		this.emit("diffsUpdated", this.getDiffFiles())
		this.emit("workspaceFilesChanged", [
			{
				path: relPath,
				absolutePath: absPath,
				changeType: status === "added" ? "created" : status === "deleted" ? "deleted" : "modified",
				additions: entry.additions,
				deletions: entry.deletions,
			},
		])
	}

	public async refreshGitDiffs(): Promise<void> {
		this.refreshDiffsFromGit()
	}
}
