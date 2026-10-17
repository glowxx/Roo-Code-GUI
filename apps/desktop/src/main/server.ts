import { logStartupDebug, setupGlobalCrashHandlers } from "./logger.js"

setupGlobalCrashHandlers("DesktopServer")

import http from "http"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { WebSocketServer, WebSocket } from "ws"
import { execSync, spawn } from "child_process"
import { DesktopAgentHost } from "./agent-host.js"
import { loadDesktopConfig, saveDesktopConfig, canonicalizePath, arePathsEqual, renameProject } from "./config.js"
import { createQuickProject } from "./quick-project.js"
import type { DesktopClientMessage, DesktopServerMessage, SidebarData, WorkspaceInfo } from "../shared/types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface DesktopServerOptions {
	port: number
	host?: string
	agentHost: DesktopAgentHost
	staticDir?: string
	onQuit?: () => void
}

export interface PathValidationResult {
	safe: boolean
	resolvedPath?: string
	error?: string
}

function normalizeFsPath(p: string): string {
	let normalized = path.normalize(path.resolve(p))
	if (process.platform === "win32") {
		if (normalized.startsWith("\\\\?\\UNC\\")) {
			normalized = "\\\\" + normalized.slice(8)
		} else if (normalized.startsWith("\\\\?\\")) {
			normalized = normalized.slice(4)
		}
	}
	return normalized
}

/**
 * Validates that a requested path is strictly located within an allowed root directory.
 * - Prevents null byte injection
 * - Resolves relative paths (../)
 * - Resolves symlinks using realpath to prevent symlink traversal
 * - Ensures path boundary matching (prevents /parent-other starting with /parent)
 * - Handles Windows case-insensitivity, drive letter variations, and leading slash quirks
 * - Safe against asar archives where realpathSync throws
 */
export function validatePathWithinRoot(
	targetPath: string,
	allowedRoot: string,
	options: { allowExactRoot?: boolean } = {}
): PathValidationResult {
	if (!targetPath || typeof targetPath !== "string") {
		return { safe: false, error: "Path must be a non-empty string" }
	}
	if (!allowedRoot || typeof allowedRoot !== "string" || !allowedRoot.trim()) {
		return { safe: false, error: "No root directory specified" }
	}

	// Guard against null bytes
	if (targetPath.includes("\0")) {
		return { safe: false, error: "Null byte detected in path" }
	}

	try {
		const resolvedRoot = normalizeFsPath(allowedRoot)
		let realRoot = resolvedRoot
		try {
			if (fs.existsSync(resolvedRoot)) {
				realRoot = normalizeFsPath(fs.realpathSync(resolvedRoot))
			}
		} catch {
			realRoot = resolvedRoot
		}

		let cleanTarget = targetPath.trim()
		if (process.platform === "win32") {
			// On Windows, path.isAbsolute("/src/...") returns true!
			// If path starts with / or \ but is NOT a drive letter (e.g. C:\) and NOT a UNC path (\\server\share),
			// treat it as a relative path from the allowed root.
			const isWindowsDrive = /^[a-zA-Z]:[/\\]/.test(cleanTarget)
			const isUNC = cleanTarget.startsWith("\\\\") || cleanTarget.startsWith("//")
			if (!isWindowsDrive && !isUNC && (cleanTarget.startsWith("/") || cleanTarget.startsWith("\\"))) {
				cleanTarget = cleanTarget.replace(/^[/\\]+/, "")
			}
		}

		const absoluteTarget = path.isAbsolute(cleanTarget)
			? normalizeFsPath(cleanTarget)
			: normalizeFsPath(path.resolve(resolvedRoot, cleanTarget))

		let realTarget = absoluteTarget
		if (fs.existsSync(absoluteTarget)) {
			try {
				realTarget = normalizeFsPath(fs.realpathSync(absoluteTarget))
			} catch {
				realTarget = absoluteTarget
			}
		} else {
			// If file does not exist, verify nearest existing ancestor directory
			let checkDir = path.dirname(absoluteTarget)
			while (checkDir !== path.dirname(checkDir) && !fs.existsSync(checkDir)) {
				checkDir = path.dirname(checkDir)
			}
			if (fs.existsSync(checkDir)) {
				let realAncestor = checkDir
				try {
					realAncestor = normalizeFsPath(fs.realpathSync(checkDir))
				} catch {
					realAncestor = checkDir
				}
				// Reconstruct target path using realAncestor and path.relative
				const relFromAncestor = path.relative(checkDir, absoluteTarget)
				realTarget = normalizeFsPath(path.resolve(realAncestor, relFromAncestor))

				// Check that ancestor doesn't escape allowed root via symlink
				const checkAncestorInside = (root: string) => {
					const normRoot = process.platform === "win32" ? root.toLowerCase() : root
					const normAncestor = process.platform === "win32" ? realAncestor.toLowerCase() : realAncestor
					if (normAncestor === normRoot) return true
					const rel = path.relative(normRoot, normAncestor)
					return !rel.startsWith("..") && !path.isAbsolute(rel)
				}

				if (!checkAncestorInside(realRoot) && !checkAncestorInside(resolvedRoot)) {
					return { safe: false, error: "Path resolves outside allowed directory via symlink ancestor" }
				}
			}
		}

		const checkInside = (root: string, target: string) => {
			const normRoot = process.platform === "win32" ? root.toLowerCase() : root
			const normTarget = process.platform === "win32" ? target.toLowerCase() : target

			if (options.allowExactRoot && normTarget === normRoot) {
				return true
			}

			const relative = path.relative(normRoot, normTarget)
			return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
		}

		// Verify containment against both realRoot and resolvedRoot
		// to properly support subst virtual drives and physical drive mappings
		const isInside =
			checkInside(realRoot, realTarget) ||
			checkInside(resolvedRoot, realTarget) ||
			checkInside(realRoot, absoluteTarget) ||
			checkInside(resolvedRoot, absoluteTarget)

		if (!isInside) {
			return { safe: false, error: "Access outside allowed directory forbidden" }
		}

		return { safe: true, resolvedPath: realTarget }
	} catch (err) {
		return { safe: false, error: `Path validation error: ${err instanceof Error ? err.message : String(err)}` }
	}
}

export function getGitBranch(workspacePath: string): string | undefined {
	if (!workspacePath || typeof workspacePath !== "string" || !workspacePath.trim()) {
		return undefined
	}
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", {
			cwd: workspacePath,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
		return branch || undefined
	} catch {
		return undefined
	}
}

interface ScanQueueItem {
	dirPath: string
	relPath: string
	depth: number
}

export function scanWorkspace(
	dir: string,
	maxFiles = 25000
): { files: string[]; directories: string[] } {
	if (!dir || typeof dir !== "string" || !dir.trim()) return { files: [], directories: [] }

	let normalizedDir = ""
	try {
		normalizedDir = path.normalize(path.resolve(dir))
		if (!fs.existsSync(normalizedDir)) return { files: [], directories: [] }
		const stat = fs.statSync(normalizedDir)
		if (!stat.isDirectory()) return { files: [], directories: [] }
	} catch {
		return { files: [], directories: [] }
	}

	const files: string[] = []
	const directories: string[] = []
	const visitedPaths = new Set<string>()

	try {
		visitedPaths.add(fs.realpathSync(normalizedDir))
	} catch {
		visitedPaths.add(normalizedDir)
	}

	const IGNORED_DIRS = new Set([
		".git",
		".turbo",
		".roo",
		".vscode",
		".idea",
		".next",
		".cache",
		".gemini",
		".claude",
		".antigravity",
		"node_modules",
		"dist",
		"build",
		"release",
		"out",
		"coverage",
		"temp",
		"tmp",
	])
	const IGNORED_SYSTEM_FILES = new Set([
		".ds_store",
		"thumbs.db",
		"desktop.ini",
	])

	const MAX_FILES_PER_DIR = 2000
	const MAX_DIRECTORIES = 15000

	const queue: ScanQueueItem[] = [{ dirPath: normalizedDir, relPath: "", depth: 0 }]

	while (queue.length > 0) {
		const current = queue.shift()!
		const { dirPath, relPath, depth } = current

		let entries: fs.Dirent[] = []
		try {
			entries = fs.readdirSync(dirPath, { withFileTypes: true })
		} catch {
			// Ignore directory read errors (permissions, locks, etc.)
			continue
		}

		const fileEntries: fs.Dirent[] = []
		const dirEntries: fs.Dirent[] = []

		for (const entry of entries) {
			try {
				const nameLower = entry.name.toLowerCase()
				if (IGNORED_SYSTEM_FILES.has(nameLower)) continue

				let isDirectory = false
				let isFile = false

				try {
					isDirectory = entry.isDirectory()
					isFile = entry.isFile()
				} catch {
					isDirectory = false
					isFile = false
				}

				// Handle Windows junctions, symlinks safely
				if (!isDirectory && !isFile) {
					try {
						if (entry.isSymbolicLink()) {
							const targetStat = fs.statSync(path.join(dirPath, entry.name))
							isDirectory = targetStat.isDirectory()
							isFile = targetStat.isFile()
						}
					} catch {
						continue
					}
				}

				if (isDirectory) {
					if (IGNORED_DIRS.has(entry.name) || IGNORED_DIRS.has(nameLower)) continue
					dirEntries.push(entry)
				} else if (isFile) {
					fileEntries.push(entry)
				}
			} catch {
				continue
			}
		}

		// Sort entries deterministically
		try {
			dirEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
		} catch {}

		try {
			fileEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
		} catch {}

		// 1. Process directories first (Breadth-First Search)
		for (const dir of dirEntries) {
			const subRelPath = (relPath ? `${relPath}/${dir.name}` : dir.name).replace(/\\/g, "/")
			const subDirPath = path.join(dirPath, dir.name)

			let realSubPath = subDirPath
			try {
				realSubPath = fs.realpathSync(subDirPath)
			} catch {
				realSubPath = subDirPath
			}

			if (visitedPaths.has(realSubPath)) {
				continue
			}
			visitedPaths.add(realSubPath)

			// Register directory: depth <= 2 always registered regardless of limits
			if (depth <= 2 || directories.length < MAX_DIRECTORIES) {
				directories.push(subRelPath)
			}

			// Enqueue subfolder for BFS
			if (depth <= 2 || (files.length < maxFiles && directories.length < MAX_DIRECTORIES)) {
				queue.push({
					dirPath: subDirPath,
					relPath: subRelPath,
					depth: depth + 1,
				})
			}
		}

		// 2. Process files with per-directory limit to avoid starving other branches
		let dirFileCount = 0
		for (const file of fileEntries) {
			if (files.length >= maxFiles) break
			if (dirFileCount >= MAX_FILES_PER_DIR) break

			const relFilePath = (relPath ? `${relPath}/${file.name}` : file.name).replace(/\\/g, "/")
			files.push(relFilePath)
			dirFileCount++
		}
	}

	// Sort final lists with natural numeric sorting
	files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
	directories.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))

	return { files, directories }
}

export function listWorkspaceFiles(dir: string, maxFiles = 25000): string[] {
	return scanWorkspace(dir, maxFiles).files
}

export function createDesktopServer(options: DesktopServerOptions): {
	server: http.Server
	wss: WebSocketServer
	start: () => Promise<number>
	stop: () => Promise<void>
} {
	const { port, host = "127.0.0.1", agentHost, staticDir } = options
	// Seed the lightweight file registry once at startup, not on tab activation.
	agentHost.refreshDiffsFromGit()
	const clients = new Set<WebSocket>()

	function safeSend(ws: WebSocket, msg: unknown) {
		if (ws && ws.readyState === WebSocket.OPEN) {
			try {
				ws.send(typeof msg === "string" ? msg : JSON.stringify(msg))
			} catch (err) {
				logStartupDebug(`[WS] Error in safeSend: ${err}`)
			}
		}
	}

	function broadcast(msg: DesktopServerMessage) {
		const payload = JSON.stringify(msg)
		for (const client of clients) {
			if (client.readyState === WebSocket.OPEN) {
				try {
					client.send(payload)
				} catch {
					// client error
				}
			}
		}
	}

	function getSidebarData(): SidebarData {
		const config = loadDesktopConfig()
		let recent = Array.isArray(config.recentWorkspaces) ? [...config.recentWorkspaces] : []
		if (recent.length === 0 && config.lastWorkspacePath) {
			recent = [canonicalizePath(config.lastWorkspacePath)]
		}
		const curWs = agentHost.getWorkspace()
		if (curWs) {
			const canonCur = canonicalizePath(curWs)
			if (!recent.some((p) => arePathsEqual(p, canonCur))) {
				recent.push(canonCur)
			}
		}
		const chats = agentHost.getChatsByWorkspace()
		return {
			recentWorkspaces: recent,
			projectNames: config.projectNames || {},
			currentWorkspace: curWs,
			activeTaskId: agentHost.getActiveTaskId(),
			chats,
		}
	}

	function broadcastSidebarData() {
		broadcast({ type: "sidebarData", data: getSidebarData() })
	}

	// Listen to agent host events and broadcast to webview
	const onNavigationCounts = (counts: ReturnType<DesktopAgentHost["getNavigationCounts"]>) => {
		broadcast({ type: "navigationCounts", ...counts })
	}
	const onTerminalLogsUpdated = () => {
		broadcast({ type: "terminalLogsInvalidated" })
	}
	agentHost.on("navigationCountsUpdated", onNavigationCounts)
	agentHost.on("terminalLogsUpdated", onTerminalLogsUpdated)
	agentHost.on("messageToUI", (message) => {
		broadcast({ type: "extensionMessage", message })
	})
	agentHost.on("statusChange", (status) => {
		broadcast({ type: "agentStatus", status })
		broadcastSidebarData()
	})
	agentHost.on("terminalLog", (entry) => {
		broadcast({ type: "terminalLog", entry })
	})
	agentHost.on("terminalSessionStarted", (session) => {
		broadcast({ type: "terminalSessionStarted", ...session })
	})
	agentHost.on("terminalOutput", (output) => {
		broadcast({ type: "terminalOutput", ...output })
	})
	agentHost.on("terminalSessionEnded", (result) => {
		broadcast({ type: "terminalSessionEnded", ...result })
	})
	agentHost.on("diffsUpdated", (diffs) => {
		broadcast({ type: "diffsUpdated", diffs })
	})
	agentHost.on("workspaceFilesChanged", (files) => {
		broadcast({ type: "workspaceFilesChanged", files })
	})
	agentHost.on("terminalLogsCleared", () => {
		broadcast({ type: "terminalLogsCleared" } as any)
	})
	agentHost.on("workspaceChanged", (wsPath) => {
		const normalized = wsPath && wsPath.trim() ? path.normalize(path.resolve(wsPath)) : ""
		const scan = normalized ? scanWorkspace(normalized) : { files: [], directories: [] }
		const newWs: WorkspaceInfo = {
			path: normalized,
			name: normalized ? path.basename(normalized) : "",
			branch: normalized ? getGitBranch(normalized) : undefined,
			files: scan.files,
			directories: scan.directories,
		}
		broadcast({ type: "workspaceInfo", workspace: newWs })
		broadcast({ type: "navigationCounts", ...agentHost.getNavigationCounts() })
		broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
		broadcastSidebarData()
	})
	agentHost.on("taskHistoryChanged", () => {
		broadcastSidebarData()
	})
	agentHost.on("conversationTitleUpdated", (payload) => {
		broadcast({
			type: "conversationTitleUpdated",
			taskId: payload.taskId,
			title: payload.title,
			titleSource: payload.titleSource,
		})
	})

	const server = http.createServer((req, res) => {
		const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
		const pathname = parsedUrl.pathname

		// Enable CORS restricted to localhost/local origins
		const origin = req.headers.origin || ""
		if (!origin || origin.includes("localhost") || origin.includes("127.0.0.1")) {
			res.setHeader("Access-Control-Allow-Origin", origin || "*")
		}
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		res.setHeader("Access-Control-Allow-Headers", "Content-Type")

		if (req.method === "OPTIONS") {
			res.writeHead(204)
			res.end()
			return
		}

		// Healthcheck endpoint for cold-start and readiness check
		if (pathname === "/api/health") {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					status: "ok",
					ready: true,
					uptime: process.uptime(),
					timestamp: Date.now(),
				})
			)
			return
		}

		// Graceful exit endpoint for clean teardown and automation
		if (pathname === "/api/quit") {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ status: "quitting" }))
			if (typeof options.onQuit === "function") {
				setTimeout(() => options.onQuit!(), 50).unref()
			}
			return
		}

		// API endpoints
		if (pathname === "/api/workspace") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						const requestedPath = data.path
						if (requestedPath && typeof requestedPath === "string" && fs.existsSync(requestedPath)) {
							const normalized = path.normalize(path.resolve(requestedPath))
							if (fs.statSync(normalized).isDirectory()) {
								await agentHost.setWorkspace(normalized)
								saveDesktopConfig({ lastWorkspacePath: normalized })
								const folderScan = scanWorkspace(normalized)
								const newWs: WorkspaceInfo = {
									path: normalized,
									name: path.basename(normalized),
									branch: getGitBranch(normalized),
									files: folderScan.files,
									directories: folderScan.directories,
								}
								broadcast({ type: "workspaceInfo", workspace: newWs })
								broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
								broadcastSidebarData()
								res.writeHead(200, { "Content-Type": "application/json" })
								res.end(JSON.stringify(newWs))
								return
							}
						}
						res.writeHead(400, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: "Invalid directory path" }))
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: String(e) }))
					}
				})
				return
			}

			let wsPath = ""
			try {
				const ws = agentHost.getWorkspace()
				if (ws && ws.trim()) {
					wsPath = path.normalize(path.resolve(ws))
				}
			} catch {
				wsPath = ""
			}
			const scan = wsPath ? scanWorkspace(wsPath) : { files: [], directories: [] }
			const info: WorkspaceInfo = {
				path: wsPath,
				name: wsPath ? path.basename(wsPath) : "",
				branch: wsPath ? getGitBranch(wsPath) : undefined,
				files: scan.files,
				directories: scan.directories,
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(info))
			return
		}

		if (pathname === "/api/sidebar-data") {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(getSidebarData()))
			return
		}

		if (pathname === "/api/quick-project") {
			if (req.method === "POST") {
				void (async () => {
					try {
						const result = await createQuickProject(agentHost, {
							broadcast,
							broadcastSidebarData,
						})
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify(result))
					} catch (err: any) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: err?.message || String(err) }))
					}
				})()
				return
			}
		}

		if (pathname === "/api/chat/switch") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						const taskId = data.taskId
						if (!taskId || typeof taskId !== "string") {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing or invalid taskId" }))
							return
						}

						const requestedWs = data.workspacePath
						if (requestedWs && typeof requestedWs === "string" && fs.existsSync(requestedWs)) {
							const normReq = path.normalize(path.resolve(requestedWs))
							const curWs = agentHost.getWorkspace()
							if (!curWs || path.normalize(path.resolve(curWs)) !== normReq) {
								await agentHost.setWorkspace(normReq)
								saveDesktopConfig({ lastWorkspacePath: normReq })
								const folderScan = scanWorkspace(normReq)
								const newWs: WorkspaceInfo = {
									path: normReq,
									name: path.basename(normReq),
									branch: getGitBranch(normReq),
									files: folderScan.files,
									directories: folderScan.directories,
								}
								broadcast({ type: "workspaceInfo", workspace: newWs })
								broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
							}
						}

						await agentHost.showTaskWithId(taskId)
						broadcastSidebarData()
						broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })

						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ success: true, taskId }))
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat/read") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						const taskId = data.taskId
						if (!taskId || typeof taskId !== "string") {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing or invalid taskId" }))
							return
						}
						await agentHost.markChatRead(taskId)
						broadcastSidebarData()
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ success: true, taskId }))
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat/delete") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						const taskId = data.taskId
						if (!taskId || typeof taskId !== "string") {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing or invalid taskId" }))
							return
						}
						const forceStop = Boolean(data.forceStop)
						const result = await agentHost.deleteChat(taskId, forceStop)
						if (result.success) {
							broadcastSidebarData()
						}
						res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" })
						res.end(JSON.stringify(result))
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat-sessions") {
			void (async () => {
				const chatSessionManager = agentHost.getChatSessionManager()
				if (!chatSessionManager) {
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ sessions: [] }))
					return
				}
				try {
					const sessions = await chatSessionManager.listSessions()
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ sessions }))
				} catch (e: any) {
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: e?.message || String(e) }))
				}
			})()
			return
		}

		if (pathname === "/api/chat-sessions/create") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					const chatSessionManager = agentHost.getChatSessionManager()
					if (!chatSessionManager) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: "ChatSessionManager not initialized" }))
						return
					}
					try {
						const data = JSON.parse(body || "{}")
						const session = await chatSessionManager.createSession({
							title: data.title,
							modelPreference: data.modelPreference,
						})
						broadcast({ type: "chatSessionsUpdated" })
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ session }))
					} catch (e: any) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: e?.message || String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat-sessions/delete") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					const chatSessionManager = agentHost.getChatSessionManager()
					if (!chatSessionManager) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: "ChatSessionManager not initialized" }))
						return
					}
					try {
						const data = JSON.parse(body || "{}")
						if (!data.id) {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing session id" }))
							return
						}
						await chatSessionManager.deleteSession(data.id)
						broadcast({ type: "chatSessionsUpdated" })
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ success: true }))
					} catch (e: any) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: e?.message || String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat-sessions/rename") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					const chatSessionManager = agentHost.getChatSessionManager()
					if (!chatSessionManager) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: "ChatSessionManager not initialized" }))
						return
					}
					try {
						const data = JSON.parse(body || "{}")
						if (!data.id || !data.title) {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing session id or title" }))
							return
						}
						await chatSessionManager.renameSession(data.id, data.title)
						broadcast({ type: "chatSessionsUpdated" })
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ success: true }))
					} catch (e: any) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: e?.message || String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/chat-preferences") {
			const chatSessionManager = agentHost.getChatSessionManager()
			if (!chatSessionManager) {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({}))
				return
			}
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						await chatSessionManager.savePreferences(data)
						res.writeHead(200, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ success: true }))
					} catch (e: any) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: e?.message || String(e) }))
					}
				})
				return
			}
			void (async () => {
				try {
					const prefs = await chatSessionManager.getPreferences()
					res.writeHead(200, { "Content-Type": "application/json" })
					res.end(JSON.stringify(prefs))
				} catch (e: any) {
					res.writeHead(500, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: e?.message || String(e) }))
				}
			})()
			return
		}

		if (pathname === "/api/project/remove") {
			if (req.method === "POST") {
				let body = ""
				req.on("data", (chunk) => {
					body += chunk
				})
				req.on("end", async () => {
					try {
						const data = JSON.parse(body || "{}")
						const projectPath = data.path
						if (!projectPath || typeof projectPath !== "string") {
							res.writeHead(400, { "Content-Type": "application/json" })
							res.end(JSON.stringify({ error: "Missing or invalid project path" }))
							return
						}
						const forceStop = Boolean(data.forceStop)
						const result = await agentHost.removeProject(projectPath, forceStop)
						if (result.success) {
							broadcastSidebarData()
						}
						res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" })
						res.end(JSON.stringify(result))
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" })
						res.end(JSON.stringify({ error: String(e) }))
					}
				})
				return
			}
			res.writeHead(405, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ error: "Method not allowed" }))
			return
		}

		if (pathname === "/api/files") {
			let scan = { files: [] as string[], directories: [] as string[] }
			try {
				const ws = agentHost.getWorkspace()
				if (ws && ws.trim()) {
					const wsPath = path.normalize(path.resolve(ws))
					scan = scanWorkspace(wsPath)
				}
			} catch {
				scan = { files: [], directories: [] }
			}
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify({ files: scan.files, directories: scan.directories }))
			return
		}

		if (pathname === "/api/file") {
			const filePath = parsedUrl.searchParams.get("path")
			if (!filePath) {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Missing path parameter" }))
				return
			}
			const rawWs = agentHost.getWorkspace()
			if (!rawWs || !rawWs.trim()) {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "No workspace open" }))
				return
			}
			const wsRoot = path.normalize(path.resolve(rawWs))
			const validation = validatePathWithinRoot(filePath, wsRoot)

			// Path traversal check
			if (!validation.safe || !validation.resolvedPath) {
				res.writeHead(403, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: validation.error || "Access outside workspace forbidden" }))
				return
			}
			const absPath = validation.resolvedPath

			try {
				if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
					res.writeHead(404, { "Content-Type": "application/json" })
					res.end(JSON.stringify({ error: "File not found" }))
					return
				}
				const ext = path.extname(absPath).toLowerCase()
				const mimeTypes: Record<string, string> = {
					".png": "image/png",
					".jpg": "image/jpeg",
					".jpeg": "image/jpeg",
					".gif": "image/gif",
					".webp": "image/webp",
					".ico": "image/x-icon",
					".bmp": "image/bmp",
					".svg": "image/svg+xml",
					".html": "text/html; charset=utf-8",
					".css": "text/css; charset=utf-8",
					".js": "application/javascript; charset=utf-8",
					".mjs": "application/javascript; charset=utf-8",
					".ts": "text/plain; charset=utf-8",
					".tsx": "text/plain; charset=utf-8",
					".json": "application/json; charset=utf-8",
					".md": "text/markdown; charset=utf-8",
					".txt": "text/plain; charset=utf-8",
					".pdf": "application/pdf",
					".mp3": "audio/mpeg",
					".wav": "audio/wav",
					".mp4": "video/mp4",
				}
				const contentType = mimeTypes[ext] || "application/octet-stream"
				res.writeHead(200, { "Content-Type": contentType })
				const fileStream = fs.createReadStream(absPath)
				fileStream.on("error", (err) => {
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "text/plain" })
						res.end("File read error")
					}
				})
				fileStream.pipe(res)
			} catch {
				res.writeHead(500, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Error reading file" }))
			}
			return
		}

		if (pathname === "/api/diffs") {
			const taskId = parsedUrl.searchParams.get("taskId")
			const files = [...agentHost.getDiffFilesForTask(taskId || undefined)]

			// If taskId provided, ensure mutating tool files in this task are included
			if (taskId) {
				try {
					const storageDir =
						agentHost.getStorageDir() ||
						path.join(process.env.USERPROFILE || process.env.HOME || "", ".roo-desktop-data")
					const uiMsgsPath = path.join(storageDir, "global-storage", "tasks", taskId, "ui_messages.json")
					if (fs.existsSync(uiMsgsPath)) {
						const MUTATING_TOOLS = new Set([
							"writeToFile",
							"write_to_file",
							"apply_diff",
							"newFileCreated",
							"editedExistingFile",
							"appliedDiff",
						])
						const msgs = JSON.parse(fs.readFileSync(uiMsgsPath, "utf-8"))
						for (const m of msgs) {
							if (m.ask === "tool" || m.say === "tool") {
								try {
									const toolData = typeof m.text === "string" ? JSON.parse(m.text) : m.text
									if (toolData && toolData.path && MUTATING_TOOLS.has(toolData.tool)) {
										const normPath = toolData.path.replace(/\\/g, "/").replace(/^\.\//, "")
										if (!files.some((f) => f.filePath.replace(/\\/g, "/") === normPath)) {
											const status: "modified" | "added" | "deleted" =
												toolData.tool === "newFileCreated" ? "added" : "modified"
											files.push({
												filePath: normPath,
												status,
												additions: 1,
												deletions: 0,
											})
										}
									}
								} catch {}
							}
						}
					}
				} catch {}
			}

			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(files))
			return
		}

		if (pathname === "/api/diff") {
			const targetFilePath = parsedUrl.searchParams.get("path")
			if (!targetFilePath) {
				res.writeHead(400, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ error: "Missing path parameter" }))
				return
			}
			const wsQuery = parsedUrl.searchParams.get("workspace")
			const taskId = parsedUrl.searchParams.get("taskId")
			let curWs = wsQuery && fs.existsSync(wsQuery) ? wsQuery : agentHost.getWorkspace()

			if ((!curWs || !fs.existsSync(curWs)) && taskId) {
				try {
					const storageDir =
						agentHost.getStorageDir() ||
						path.join(process.env.USERPROFILE || process.env.HOME || "", ".roo-desktop-data")
					const histItemPath = path.join(storageDir, "global-storage", "tasks", taskId, "history_item.json")
					if (fs.existsSync(histItemPath)) {
						const histItem = JSON.parse(fs.readFileSync(histItemPath, "utf-8"))
						if (histItem.workspace && fs.existsSync(histItem.workspace)) {
							curWs = histItem.workspace
						}
					}
				} catch {}
			}

			const normTarget = targetFilePath.replace(/\\/g, "/").replace(/^\.\//, "")
			const diffFiles = agentHost.getDiffFilesForTask(taskId || undefined)
			const entry = diffFiles.find((f) => f.filePath.replace(/\\/g, "/") === normTarget)

			let oldContent = entry?.oldContent
			let newContent = entry?.newContent
			let diffText = ""
			let resolvedStatus: "modified" | "added" | "deleted" = entry?.status || "modified"

			// Check task ui_messages.json for exact patches or file contents
			if (taskId) {
				try {
					const storageDir =
						agentHost.getStorageDir() ||
						path.join(process.env.USERPROFILE || process.env.HOME || "", ".roo-desktop-data")
					const uiMsgsPath = path.join(storageDir, "global-storage", "tasks", taskId, "ui_messages.json")
					if (fs.existsSync(uiMsgsPath)) {
						const msgs = JSON.parse(fs.readFileSync(uiMsgsPath, "utf-8"))
						for (let i = msgs.length - 1; i >= 0; i--) {
							const m = msgs[i]
							if (m.ask === "tool" || m.say === "tool") {
								try {
									const toolData = typeof m.text === "string" ? JSON.parse(m.text) : m.text
									if (toolData && toolData.path) {
										const toolNormPath = toolData.path.replace(/\\/g, "/").replace(/^\.\//, "")
										if (
											toolNormPath === normTarget ||
											normTarget.endsWith(toolNormPath) ||
											toolNormPath.endsWith(normTarget)
										) {
											if (toolData.tool === "newFileCreated") {
												resolvedStatus = "added"
												newContent = toolData.content ?? ""
												oldContent = ""
												break
											} else if (
												toolData.tool === "appliedDiff" ||
												toolData.tool === "editedExistingFile"
											) {
												resolvedStatus = "modified"
												if (toolData.diff) diffText = toolData.diff
												if (toolData.content && newContent === undefined)
													newContent = toolData.content
												break
											}
										}
									}
								} catch {}
							}
						}
					}
				} catch {}
			}

			const absPath = curWs && fs.existsSync(curWs)
				? (path.isAbsolute(targetFilePath) ? targetFilePath : path.resolve(curWs, normTarget))
				: (path.isAbsolute(targetFilePath) ? targetFilePath : "")
			const fileExists = absPath ? fs.existsSync(absPath) : false
			let diskStat: fs.Stats | null = null
			if (fileExists) {
				try {
					diskStat = fs.statSync(absPath)
				} catch {}
			}

			if (newContent === undefined && fileExists && diskStat?.isFile()) {
				try {
					newContent = fs.readFileSync(absPath, "utf-8")
				} catch {}
			}

			// Try git diff / git status / git check-ignore if we have a workspace
			if (curWs && fs.existsSync(curWs)) {
				if (!diffText) {
					try {
						diffText = execSync(`git diff HEAD -- "${normTarget}"`, {
							cwd: curWs,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "ignore"],
							timeout: 4000,
						})
					} catch {}
				}

				if (!diffText) {
					try {
						diffText = execSync(`git diff -- "${normTarget}"`, {
							cwd: curWs,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "ignore"],
							timeout: 3000,
						})
					} catch {}
				}

				if (oldContent === undefined) {
					try {
						oldContent = execSync(`git show HEAD:"${normTarget}"`, {
							cwd: curWs,
							encoding: "utf-8",
							stdio: ["ignore", "pipe", "ignore"],
							timeout: 3000,
						})
					} catch {
						if (fileExists) {
							// Check if ignored or untracked
							let isIgnored = false
							try {
								const ignoredCheck = execSync(`git check-ignore "${normTarget}"`, {
									cwd: curWs,
									encoding: "utf-8",
									stdio: ["ignore", "pipe", "ignore"],
									timeout: 2000,
								}).trim()
								if (ignoredCheck.length > 0) isIgnored = true
							} catch {}

							try {
								const gitStatus = execSync(`git status --porcelain -- "${normTarget}"`, {
									cwd: curWs,
									encoding: "utf-8",
									stdio: ["ignore", "pipe", "ignore"],
									timeout: 2000,
								}).trim()
								if (isIgnored || gitStatus.startsWith("??") || gitStatus.startsWith("A")) {
									resolvedStatus = "added"
									oldContent = ""
								}
							} catch {
								if (isIgnored) {
									resolvedStatus = "added"
									oldContent = ""
								}
							}
						}
					}
				}

				if (!fileExists && oldContent) {
					resolvedStatus = "deleted"
					newContent = ""
				}
			}

			const isActuallyEmpty = fileExists && diskStat?.size === 0
			let contentUnavailable = false
			let reason: string | undefined = undefined

			if (!fileExists && oldContent === undefined && (newContent === undefined || newContent === "")) {
				contentUnavailable = true
				reason = "File does not exist on disk"
			} else if (fileExists && newContent === undefined && !isActuallyEmpty) {
				contentUnavailable = true
				reason = "Unable to read file content (may be binary or permission error)"
			}

			let additions = entry?.additions ?? 0
			let deletions = entry?.deletions ?? 0
			if (!additions && !deletions) {
				if (diffText) {
					const diffLines = diffText.split("\n")
					for (const dl of diffLines) {
						if (dl.startsWith("+") && !dl.startsWith("+++")) additions++
						else if (dl.startsWith("-") && !dl.startsWith("---")) deletions++
					}
				} else if (newContent !== undefined && oldContent !== undefined) {
					const nLines = newContent ? newContent.split("\n").length : 0
					const oLines = oldContent ? oldContent.split("\n").length : 0
					if (resolvedStatus === "added") additions = nLines
					else if (resolvedStatus === "deleted") deletions = oLines
					else {
						additions = Math.max(0, nLines - oLines)
						deletions = Math.max(0, oLines - nLines)
					}
				}
			}

			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(
				JSON.stringify({
					filePath: normTarget,
					status: resolvedStatus,
					oldContent: oldContent ?? (resolvedStatus === "added" ? "" : null),
					newContent: newContent ?? (isActuallyEmpty ? "" : null),
					diff: diffText,
					additions,
					deletions,
					isActuallyEmpty,
					contentUnavailable,
					reason,
				}),
			)
			return
		}

		if (pathname === "/api/terminal-logs") {
			res.writeHead(200, { "Content-Type": "application/json" })
			res.end(JSON.stringify(agentHost.getTerminalLogs()))
			return
		}

		// Handle /webview and /assets routes
		if (pathname.startsWith("/webview") || pathname.startsWith("/assets/")) {
			let webviewBuildDir = ""
			const candidateWebviewPaths = [
				process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "webview") : "",
				process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "dist", "webview") : "",
				process.resourcesPath ? path.join(process.resourcesPath, "webview") : "",
				path.join(__dirname, "..", "webview"),
				path.join(__dirname, "webview"),
			].filter(Boolean)

			for (const candidate of candidateWebviewPaths) {
				if (fs.existsSync(path.join(candidate, "index.html"))) {
					webviewBuildDir = candidate
					break
				}
			}

			if (!webviewBuildDir) {
				let rootDir = __dirname
				while (rootDir !== path.dirname(rootDir)) {
					if (fs.existsSync(path.join(rootDir, "src", "webview-ui", "build"))) {
						webviewBuildDir = path.join(rootDir, "src", "webview-ui", "build")
						break
					}
					rootDir = path.dirname(rootDir)
				}
			}
			let relWebviewPath = pathname.startsWith("/webview")
				? pathname.replace(/^\/webview\/?/, "") || "index.html"
				: pathname.replace(/^\//, "")

			const webviewValidation = validatePathWithinRoot(relWebviewPath, webviewBuildDir, { allowExactRoot: true })
			let targetWebviewPath = webviewValidation.safe && webviewValidation.resolvedPath
				? webviewValidation.resolvedPath
				: path.join(webviewBuildDir, "index.html")

			if (!fs.existsSync(targetWebviewPath) || fs.statSync(targetWebviewPath).isDirectory()) {
				targetWebviewPath = path.join(webviewBuildDir, "index.html")
			}

			if (fs.existsSync(targetWebviewPath) && fs.statSync(targetWebviewPath).isFile()) {
				const ext = path.extname(targetWebviewPath).toLowerCase()
				const mimeTypes: Record<string, string> = {
					".html": "text/html; charset=utf-8",
					".js": "application/javascript; charset=utf-8",
					".mjs": "application/javascript; charset=utf-8",
					".css": "text/css; charset=utf-8",
					".json": "application/json; charset=utf-8",
					".png": "image/png",
					".jpg": "image/jpeg",
					".svg": "image/svg+xml",
					".woff": "font/woff",
					".woff2": "font/woff2",
					".ttf": "font/ttf",
				}
				const contentType = mimeTypes[ext] || "application/octet-stream"

				if (ext === ".html") {
					let html = fs.readFileSync(targetWebviewPath, "utf-8")
					const polyfillAndTheme = `
<style id="vscode-theme-tokens">
/* 1. Linear Dark (PR #1 Target Default: Graphite / Linear / Raycast Tier) */
:root,
[data-theme="linear-dark"] {
	--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
	--vscode-font-size: 14px;
	--vscode-font-weight: 400;
	--vscode-editor-font-family: "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
	--vscode-editor-font-size: 13px;

	--agent-canvas-narrative: 860px;
	--agent-canvas-technical: 1380px;
	--agent-reading-measure: 72ch;

	/* Linear Dark Tokens */
	--vscode-editor-background: #202123;
	--vscode-editor-foreground: #edeef0;
	--vscode-foreground: #edeef0;
	--vscode-descriptionForeground: #b2b3b9;
	--vscode-disabledForeground: #93959d;
	--vscode-errorForeground: #f19a98;

	--vscode-input-background: #28292c;
	--vscode-input-foreground: #edeef0;
	--vscode-input-border: #ffffff20;
	--vscode-input-placeholderForeground: #93959d;
	--vscode-focusBorder: #8aaef0;

	--vscode-button-background: #edeef0;
	--vscode-button-foreground: #202123;
	--vscode-button-hoverBackground: #b2b3b9;
	--vscode-button-secondaryBackground: #303135;
	--vscode-button-secondaryForeground: #edeef0;
	--vscode-button-secondaryHoverBackground: #ffffff12;

	--vscode-dropdown-background: #28292c;
	--vscode-dropdown-foreground: #edeef0;
	--vscode-dropdown-border: #ffffff20;
	--vscode-dropdown-listBackground: #28292c;

	--vscode-menu-background: #303135;
	--vscode-menu-foreground: #edeef0;
	--vscode-menu-border: #ffffff20;
	--vscode-menu-selectionBackground: #ffffff12;
	--vscode-menu-selectionForeground: #edeef0;

	--vscode-list-hoverBackground: #ffffff0a;
	--vscode-list-hoverForeground: #edeef0;
	--vscode-list-activeSelectionBackground: #ffffff12;
	--vscode-list-activeSelectionForeground: #edeef0;
	--vscode-list-focusBackground: #ffffff12;

	--vscode-badge-background: #ffffff12;
	--vscode-badge-foreground: #b2b3b9;

	--vscode-textLink-foreground: #a8c7fa;
	--vscode-textLink-activeForeground: #c3d8fc;
	--vscode-textCodeBlock-background: #191a1c;

	--vscode-sideBar-background: #202123;
	--vscode-sideBar-foreground: #edeef0;
	--vscode-sideBar-border: #ffffff0e;
	--vscode-sideBarSectionHeader-background: #28292c;
	--vscode-sideBarSectionHeader-foreground: #edeef0;
	--vscode-panel-border: #ffffff0e;
	--vscode-editorGroup-border: #ffffff0e;
	--vscode-editorWidget-background: #28292c;
	--vscode-editorWidget-border: #ffffff20;
	--vscode-editorHoverWidget-background: #303135;
	--vscode-editorHoverWidget-foreground: #edeef0;
	--vscode-editorHoverWidget-border: #ffffff20;
	--vscode-widget-border: #ffffff20;
	--vscode-widget-shadow: rgba(0, 0, 0, 0.4);

	--vscode-scrollbarSlider-background: rgba(255, 255, 255, 0.12);
	--vscode-scrollbarSlider-hoverBackground: rgba(255, 255, 255, 0.25);
	--vscode-scrollbarSlider-activeBackground: rgba(255, 255, 255, 0.35);

	--vscode-charts-red: #f19a98;
	--vscode-charts-blue: #a8c7fa;
	--vscode-charts-yellow: #e6c58a;
	--vscode-charts-green: #8fc6a4;
	--vscode-charts-orange: #e6c58a;

	/* Design token aliases */
	--bg-canvas: #202123;
	--bg-header: #191a1c;
	--bg-surface: #28292c;
	--bg-surface-elevated: #303135;
	--text-primary: #edeef0;
	--text-secondary: #b2b3b9;
	--text-muted: #93959d;
	--accent: #a8c7fa;
	--border-subtle: #ffffff0e;
	--border-light: #ffffff20;
	--border-focus: #8aaef0;
}

/* 2. OLED Black (Pure Black, Maximum Contrast) */
[data-theme="oled-black"] {
	--vscode-editor-background: #000000;
	--vscode-editor-foreground: #f5f5f5;
	--vscode-foreground: #f5f5f5;
	--vscode-descriptionForeground: #b2b2b9;
	--vscode-disabledForeground: #929299;
	--vscode-errorForeground: #f19a98;
	--vscode-input-background: #0a0a0a;
	--vscode-input-foreground: #f5f5f5;
	--vscode-input-border: #ffffff20;
	--vscode-focusBorder: #8aaef0;
	--vscode-button-background: #f5f5f5;
	--vscode-button-foreground: #000000;
	--vscode-button-hoverBackground: #b2b2b9;
	--vscode-button-secondaryBackground: #161616;
	--vscode-button-secondaryForeground: #f5f5f5;
	--vscode-dropdown-background: #0a0a0a;
	--vscode-dropdown-foreground: #f5f5f5;
	--vscode-dropdown-border: #ffffff20;
	--vscode-dropdown-listBackground: #0a0a0a;
	--vscode-menu-background: #161616;
	--vscode-menu-foreground: #f5f5f5;
	--vscode-sideBar-background: #000000;
	--vscode-sideBar-foreground: #f5f5f5;
	--vscode-sideBarSectionHeader-background: #0a0a0a;
	--vscode-editorWidget-background: #0a0a0a;
	--vscode-editorHoverWidget-background: #161616;
	--vscode-panel-border: rgba(255, 255, 255, 0.12);
	--vscode-editorGroup-border: rgba(255, 255, 255, 0.12);
	--vscode-badge-background: rgba(255, 255, 255, 0.1);
	--vscode-textLink-foreground: #a8c7fa;
	--vscode-textCodeBlock-background: #050505;

	--bg-canvas: #000000;
	--bg-header: #050505;
	--bg-surface: #0a0a0a;
	--bg-surface-elevated: #161616;
	--text-primary: #f5f5f5;
	--text-secondary: #b2b2b9;
	--text-muted: #929299;
}

/* 3. Midnight Navy (GitHub Dark Dimmed Tone) */
[data-theme="midnight-navy"] {
	--vscode-editor-background: #161c25;
	--vscode-editor-foreground: #e6edf3;
	--vscode-foreground: #e6edf3;
	--vscode-descriptionForeground: #acb7c6;
	--vscode-disabledForeground: #8f9db0;
	--vscode-errorForeground: #f19a98;
	--vscode-input-background: #1d2531;
	--vscode-input-foreground: #e6edf3;
	--vscode-input-border: #ffffff20;
	--vscode-focusBorder: #8aaef0;
	--vscode-button-background: #e6edf3;
	--vscode-button-foreground: #161c25;
	--vscode-button-hoverBackground: #acb7c6;
	--vscode-button-secondaryBackground: #27303e;
	--vscode-button-secondaryForeground: #e6edf3;
	--vscode-dropdown-background: #1d2531;
	--vscode-dropdown-foreground: #e6edf3;
	--vscode-dropdown-border: #ffffff20;
	--vscode-dropdown-listBackground: #1d2531;
	--vscode-menu-background: #27303e;
	--vscode-menu-foreground: #e6edf3;
	--vscode-sideBar-background: #161c25;
	--vscode-sideBar-foreground: #e6edf3;
	--vscode-sideBarSectionHeader-background: #1d2531;
	--vscode-editorWidget-background: #1d2531;
	--vscode-editorHoverWidget-background: #27303e;
	--vscode-panel-border: rgba(255, 255, 255, 0.1);
	--vscode-editorGroup-border: rgba(255, 255, 255, 0.1);
	--vscode-badge-background: rgba(255, 255, 255, 0.1);
	--vscode-textLink-foreground: #a8c7fa;
	--vscode-textCodeBlock-background: #10161e;

	--bg-canvas: #161c25;
	--bg-header: #10161e;
	--bg-surface: #1d2531;
	--bg-surface-elevated: #27303e;
	--text-primary: #e6edf3;
	--text-secondary: #acb7c6;
	--text-muted: #8f9db0;
}

/* 4. Cyberpunk (Cool Graphite with Neon Cyan) */
[data-theme="cyberpunk"] {
	--vscode-editor-background: #101b22;
	--vscode-editor-foreground: #e1f0f2;
	--vscode-foreground: #e1f0f2;
	--vscode-descriptionForeground: #abc2c8;
	--vscode-disabledForeground: #8ba6ae;
	--vscode-errorForeground: #f19a98;
	--vscode-input-background: #152630;
	--vscode-input-foreground: #e1f0f2;
	--vscode-input-border: #ffffff20;
	--vscode-focusBorder: #83c9d5;
	--vscode-button-background: #83c9d5;
	--vscode-button-foreground: #101b22;
	--vscode-button-hoverBackground: #a2dfea;
	--vscode-button-secondaryBackground: #1d3440;
	--vscode-button-secondaryForeground: #e1f0f2;
	--vscode-dropdown-background: #152630;
	--vscode-dropdown-foreground: #e1f0f2;
	--vscode-dropdown-border: #ffffff20;
	--vscode-dropdown-listBackground: #152630;
	--vscode-menu-background: #1d3440;
	--vscode-menu-foreground: #e1f0f2;
	--vscode-sideBar-background: #101b22;
	--vscode-sideBar-foreground: #e1f0f2;
	--vscode-sideBarSectionHeader-background: #152630;
	--vscode-editorWidget-background: #152630;
	--vscode-editorHoverWidget-background: #1d3440;
	--vscode-panel-border: rgba(0, 240, 255, 0.15);
	--vscode-editorGroup-border: rgba(0, 240, 255, 0.15);
	--vscode-badge-background: rgba(131, 201, 213, 0.15);
	--vscode-textLink-foreground: #83c9d5;
	--vscode-textCodeBlock-background: #0b141a;

	--bg-canvas: #101b22;
	--bg-header: #0b141a;
	--bg-surface: #152630;
	--bg-surface-elevated: #1d3440;
	--text-primary: #e1f0f2;
	--text-secondary: #abc2c8;
	--text-muted: #8ba6ae;
	--accent: #83c9d5;
	--border-focus: #83c9d5;
}

/* 5. Clean Light (Warm Paper Slate) */
body.vscode-light,
[data-theme="clean-light"] {
	--vscode-editor-background: #ffffff;
	--vscode-editor-foreground: #242528;
	--vscode-foreground: #242528;
	--vscode-descriptionForeground: #60636b;
	--vscode-disabledForeground: #71747c;
	--vscode-errorForeground: #b83c39;

	--vscode-input-background: #fafafa;
	--vscode-input-foreground: #242528;
	--vscode-input-border: #00000020;
	--vscode-input-placeholderForeground: #71747c;
	--vscode-focusBorder: #416bad;

	--vscode-button-background: #242528;
	--vscode-button-foreground: #ffffff;
	--vscode-button-hoverBackground: #60636b;
	--vscode-button-secondaryBackground: #ffffff;
	--vscode-button-secondaryForeground: #242528;
	--vscode-button-secondaryHoverBackground: #0000000c;

	--vscode-dropdown-background: #fafafa;
	--vscode-dropdown-foreground: #242528;
	--vscode-dropdown-border: #00000020;
	--vscode-dropdown-listBackground: #ffffff;

	--vscode-menu-background: #ffffff;
	--vscode-menu-foreground: #242528;
	--vscode-menu-border: #00000020;
	--vscode-menu-selectionBackground: #0000000c;
	--vscode-menu-selectionForeground: #242528;

	--vscode-list-hoverBackground: #00000006;
	--vscode-list-hoverForeground: #242528;
	--vscode-list-activeSelectionBackground: #0000000c;
	--vscode-list-activeSelectionForeground: #242528;

	--vscode-badge-background: #0000000c;
	--vscode-badge-foreground: #60636b;

	--vscode-textLink-foreground: #355f9e;
	--vscode-textLink-activeForeground: #284a7c;
	--vscode-textCodeBlock-background: #f5f5f5;

	--vscode-sideBar-background: #ffffff;
	--vscode-sideBar-foreground: #242528;
	--vscode-sideBar-border: #0000000d;
	--vscode-sideBarSectionHeader-background: #fafafa;
	--vscode-sideBarSectionHeader-foreground: #242528;
	--vscode-panel-border: #0000000d;
	--vscode-editorGroup-border: #0000000d;
	--vscode-editorWidget-background: #fafafa;
	--vscode-editorWidget-border: #00000020;
	--vscode-editorHoverWidget-background: #ffffff;
	--vscode-editorHoverWidget-foreground: #242528;
	--vscode-editorHoverWidget-border: #00000020;
	--vscode-widget-border: #00000020;
	--vscode-widget-shadow: rgba(0, 0, 0, 0.08);

	--vscode-scrollbarSlider-background: rgba(0, 0, 0, 0.15);
	--vscode-scrollbarSlider-hoverBackground: rgba(0, 0, 0, 0.28);
	--vscode-scrollbarSlider-activeBackground: rgba(0, 0, 0, 0.4);

	--bg-canvas: #ffffff;
	--bg-header: #f5f5f5;
	--bg-surface: #fafafa;
	--bg-surface-elevated: #ffffff;
	--text-primary: #242528;
	--text-secondary: #60636b;
	--text-muted: #71747c;
	--accent: #355f9e;
	--border-subtle: #0000000d;
	--border-light: #00000020;
	--border-focus: #416bad;
}

html, body {
	height: 100%;
	width: 100%;
	margin: 0;
	padding: 0;
	overflow: hidden;
	background-color: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	-webkit-font-smoothing: antialiased;
}

#root {
	height: 100%;
	width: 100%;
	display: flex;
	flex-direction: column;
}

/* Polished onboarding/settings width constraints */
[data-tab-content], .tab-content {
	max-width: 860px;
	margin: 0 auto;
	width: 100%;
}

/* Polished custom scrollbars */
::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
::-webkit-scrollbar-track {
	background: transparent;
}
::-webkit-scrollbar-thumb {
	background: rgba(150, 150, 150, 0.2);
	border-radius: 9999px;
}
::-webkit-scrollbar-thumb:hover {
	background: rgba(150, 150, 150, 0.35);
}
</style>
<script>
window.__ROO_DESKTOP__ = true;
window.acquireVsCodeApi = function() {
	return {
		postMessage: function(message) {
			window.parent.postMessage(message, "*");
		},
		getState: function() {
			try { return JSON.parse(localStorage.getItem("vscodeState") || "{}"); } catch(e) { return {}; }
		},
		setState: function(state) {
			try { localStorage.setItem("vscodeState", JSON.stringify(state)); } catch(e) {}
			return state;
		}
	};
};

// Intercept state message to eliminate unwanted/weak Welcome View and land straight in Chat
window.addEventListener("message", function(e) {
	if (e.data && e.data.type === "state" && e.data.state) {
		e.data.state.showWelcome = false;
		e.data.state.shouldShowAnnouncement = false;
		if (!e.data.state.apiConfiguration || (!e.data.state.apiConfiguration.apiKey && !e.data.state.apiConfiguration.xkiroApiKey)) {
			e.data.state.apiConfiguration = e.data.state.apiConfiguration || {};
			if (!e.data.state.apiConfiguration.apiProvider) {
				e.data.state.apiConfiguration.apiProvider = "xkiro";
			}
			e.data.state.apiConfiguration.ollamaModelId = e.data.state.apiConfiguration.ollamaModelId ?? "auto";
		}
	}
}, true);

// Forward Ctrl+B / Cmd+B to desktop app to toggle sidebar
window.addEventListener("keydown", function(e) {
	if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B") && !e.shiftKey && !e.altKey) {
		e.preventDefault();
		window.parent.postMessage({ type: "toggleSidebar" }, "*");
	}
}, true);

(function() {
	function syncTheme() {
		try {
			var theme = localStorage.getItem("roo-theme") || "linear-dark";
			var isLight = theme === "clean-light" || theme === "light";
			var cls = isLight ? "vscode-light" : "vscode-dark";
			document.body.className = cls;
			document.body.setAttribute("data-vscode-theme-kind", cls);
			document.body.setAttribute("data-desktop-shell", "true");
			document.documentElement.className = cls;
			document.documentElement.setAttribute("data-theme", theme);
			document.documentElement.setAttribute("data-desktop-shell", "true");
			document.body.setAttribute("data-theme", theme);
		} catch(e) {}
	}
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", syncTheme);
	} else {
		syncTheme();
	}
	window.addEventListener("message", function(e) {
		if (e.data && e.data.type === "themeChange") {
			var theme = e.data.theme || "linear-dark";
			var isLight = theme === "clean-light" || theme === "light";
			var cls = isLight ? "vscode-light" : "vscode-dark";
			document.body.className = cls;
			document.body.setAttribute("data-vscode-theme-kind", cls);
			document.body.setAttribute("data-desktop-shell", "true");
			document.documentElement.className = cls;
			document.documentElement.setAttribute("data-theme", theme);
			document.documentElement.setAttribute("data-desktop-shell", "true");
			document.body.setAttribute("data-theme", theme);
			try { localStorage.setItem("roo-theme", theme); } catch(err) {}
		}
	});
})();
</script>
`
					html = html.replace("<html", `<html data-desktop-shell="true"`)
					html = html.replace("<head>", `<head>${polyfillAndTheme}`)
					html = html.replace("<body>", `<body class="vscode-dark" data-vscode-theme-kind="vscode-dark" data-desktop-shell="true" data-theme="linear-dark">`)
					res.writeHead(200, { "Content-Type": contentType })
					res.end(html)
					return
				}

				res.writeHead(200, { "Content-Type": contentType })
				const fileStream = fs.createReadStream(targetWebviewPath)
				fileStream.on("error", (err) => {
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "text/plain" })
						res.end("File read error")
					}
				})
				fileStream.pipe(res)
				return
			}
		}

		// Serve static frontend assets
		if (staticDir && fs.existsSync(staticDir)) {
			let relativeFilePath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "")
			const staticValidation = validatePathWithinRoot(relativeFilePath, staticDir, { allowExactRoot: true })
			let targetPath = staticValidation.safe && staticValidation.resolvedPath
				? staticValidation.resolvedPath
				: path.join(staticDir, "index.html")

			if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
				targetPath = path.join(staticDir, "index.html")
			}

			if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
				const ext = path.extname(targetPath).toLowerCase()
				const mimeTypes: Record<string, string> = {
					".html": "text/html; charset=utf-8",
					".js": "application/javascript; charset=utf-8",
					".mjs": "application/javascript; charset=utf-8",
					".css": "text/css; charset=utf-8",
					".json": "application/json; charset=utf-8",
					".png": "image/png",
					".jpg": "image/jpeg",
					".svg": "image/svg+xml",
					".ico": "image/x-icon",
					".woff": "font/woff",
					".woff2": "font/woff2",
					".ttf": "font/ttf",
				}
				const contentType = mimeTypes[ext] || "application/octet-stream"
				res.writeHead(200, { "Content-Type": contentType })
				const fileStream = fs.createReadStream(targetPath)
				fileStream.on("error", (err) => {
					if (!res.headersSent) {
						res.writeHead(500, { "Content-Type": "text/plain" })
						res.end("File read error")
					}
				})
				fileStream.pipe(res)
				return
			}
		}

		res.writeHead(404, { "Content-Type": "text/plain" })
		res.end("Not Found")
	})

	const wss = new WebSocketServer({ server, path: "/ws" })

	wss.on("error", (err) => {
		logStartupDebug(`[WSS ERROR] ${err?.stack || err}`)
	})

	wss.on("connection", (ws, req) => {
		clients.add(ws)
		logStartupDebug(`[WS] Client connected from ${req?.socket?.remoteAddress || "unknown"}. Total clients: ${clients.size}`)

		ws.on("error", (err) => {
			logStartupDebug(`[WS CLIENT ERROR] ${err?.stack || err}`)
		})

		try {
			// Send initial state to newly connected client
			let wsPath = ""
			try {
				const rawWs = agentHost.getWorkspace()
				if (rawWs && rawWs.trim()) {
					wsPath = path.normalize(path.resolve(rawWs))
				}
			} catch {
				wsPath = ""
			}
			const scan = wsPath ? scanWorkspace(wsPath) : { files: [], directories: [] }
			const initialWorkspace: WorkspaceInfo = {
				path: wsPath,
				name: wsPath ? path.basename(wsPath) : "",
				branch: wsPath ? getGitBranch(wsPath) : undefined,
				files: scan.files,
				directories: scan.directories,
			}
			safeSend(ws, { type: "workspaceInfo", workspace: initialWorkspace })
			safeSend(ws, { type: "navigationCounts", ...agentHost.getNavigationCounts() })
			safeSend(ws, { type: "agentStatus", status: agentHost.getStatus() })
			safeSend(ws, { type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
			safeSend(ws, { type: "sidebarData", data: getSidebarData() })
			logStartupDebug("[WS] Initial state dispatched successfully.")
		} catch (err) {
			logStartupDebug(`[WS] Error during initial connection state dispatch: ${err}`)
		}

		ws.on("message", async (raw) => {
			try {
				const clientMsg = JSON.parse(raw.toString()) as DesktopClientMessage
				if (clientMsg.type === "webviewMessage") {
					agentHost.sendToExtension(clientMsg.message)
				} else if (clientMsg.type === "getWorkspaceInfo") {
					let curPath = ""
					try {
						const rawWs = agentHost.getWorkspace()
						if (rawWs && rawWs.trim()) {
							curPath = path.normalize(path.resolve(rawWs))
						}
					} catch {
						curPath = ""
					}
					const curScan = curPath ? scanWorkspace(curPath) : { files: [], directories: [] }
					safeSend(ws, {
						type: "workspaceInfo",
						workspace: {
							path: curPath,
							name: curPath ? path.basename(curPath) : "",
							branch: curPath ? getGitBranch(curPath) : undefined,
							files: curScan.files,
							directories: curScan.directories,
						},
					})
				} else if (clientMsg.type === "selectFolder") {
					if (clientMsg.path && fs.existsSync(clientMsg.path)) {
						try {
							const normalized = path.normalize(path.resolve(clientMsg.path))
							await agentHost.setWorkspace(normalized)
							saveDesktopConfig({ lastWorkspacePath: normalized })
							const rawWs = agentHost.getWorkspace()
							const curPath = rawWs && rawWs.trim() ? path.normalize(path.resolve(rawWs)) : ""
							const folderScan = curPath ? scanWorkspace(curPath) : { files: [], directories: [] }
							const newWs: WorkspaceInfo = {
								path: curPath,
								name: curPath ? path.basename(curPath) : "",
								branch: curPath ? getGitBranch(curPath) : undefined,
								files: folderScan.files,
								directories: folderScan.directories,
							}
							broadcast({ type: "workspaceInfo", workspace: newWs })
							broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
						} catch (err) {
							safeSend(ws, { type: "error", message: String(err) })
						}
					} else {
						safeSend(ws, { type: "error", message: `Folder does not exist: ${clientMsg.path}` })
					}
				} else if (clientMsg.type === "createQuickProject") {
					try {
						const result = await createQuickProject(agentHost, {
							broadcast,
							broadcastSidebarData,
						})
						safeSend(ws, { type: "quickProjectCreated", ...result })
					} catch (err: any) {
						safeSend(ws, { type: "error", message: err?.message || String(err) })
					}
				} else if (clientMsg.type === "readFile") {
					const rawWs = agentHost.getWorkspace()
					if (!rawWs || !rawWs.trim()) {
						safeSend(ws, { type: "error", message: "No workspace open" })
						return
					}
					const wsRoot = path.normalize(path.resolve(rawWs))
					const validation = validatePathWithinRoot(clientMsg.filePath, wsRoot)
					if (!validation.safe || !validation.resolvedPath) {
						safeSend(ws, { type: "error", message: validation.error || "Access outside workspace forbidden" })
						return
					}
					const abs = validation.resolvedPath
					if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
						try {
							const stat = fs.statSync(abs)
							const ext = path.extname(abs).toLowerCase()
							const mimeTypes: Record<string, string> = {
								".png": "image/png",
								".jpg": "image/jpeg",
								".jpeg": "image/jpeg",
								".gif": "image/gif",
								".webp": "image/webp",
								".ico": "image/x-icon",
								".bmp": "image/bmp",
								".svg": "image/svg+xml",
								".mp3": "audio/mpeg",
								".wav": "audio/wav",
								".ogg": "audio/ogg",
								".mp4": "video/mp4",
								".webm": "video/webm",
								".pdf": "application/pdf",
							}

							const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"].includes(ext)
							const isSvg = ext === ".svg"
							const isMedia = [".mp3", ".wav", ".ogg", ".mp4", ".webm"].includes(ext)
							const isPdf = ext === ".pdf"

							if (isImage || isMedia || isPdf) {
								const buf = fs.readFileSync(abs)
								const mime = mimeTypes[ext] || "application/octet-stream"
								const dataUrl = `data:${mime};base64,${buf.toString("base64")}`
								safeSend(ws, {
									type: "fileContent",
									filePath: clientMsg.filePath,
									fileType: isImage ? "image" : isMedia ? "media" : "pdf",
									mimeType: mime,
									size: stat.size,
									content: dataUrl,
									fileName: path.basename(abs),
									ext: ext.replace(/^\./, ""),
								})
							} else if (isSvg) {
								const text = fs.readFileSync(abs, "utf-8")
								const mime = "image/svg+xml"
								const dataUrl = `data:${mime};base64,${Buffer.from(text).toString("base64")}`
								safeSend(ws, {
									type: "fileContent",
									filePath: clientMsg.filePath,
									fileType: "svg",
									mimeType: mime,
									size: stat.size,
									content: dataUrl,
									rawText: text,
									fileName: path.basename(abs),
									ext: "svg",
								})
							} else {
								// Detect binary by reading first 1024 bytes and checking for null bytes
								let fd: number | undefined
								let sample: Buffer
								try {
									fd = fs.openSync(abs, "r")
									sample = Buffer.alloc(Math.min(1024, stat.size))
									fs.readSync(fd, sample, 0, sample.length, 0)
								} finally {
									if (fd !== undefined) {
										fs.closeSync(fd)
									}
								}

								let isBinary = false
								for (let i = 0; i < sample.length; i++) {
									if (sample[i] === 0) {
										isBinary = true
										break
									}
								}

								if (isBinary || stat.size > 3 * 1024 * 1024) {
									safeSend(ws, {
										type: "fileContent",
										filePath: clientMsg.filePath,
										fileType: "binary",
										size: stat.size,
										fileName: path.basename(abs),
										ext: ext.replace(/^\./, ""),
										mtime: stat.mtimeMs,
									})
								} else {
									const content = fs.readFileSync(abs, "utf-8")
									safeSend(ws, {
										type: "fileContent",
										filePath: clientMsg.filePath,
										fileType: ext === ".md" ? "markdown" : ext === ".json" ? "json" : "text",
										size: stat.size,
										content,
										fileName: path.basename(abs),
										ext: ext.replace(/^\./, ""),
									})
								}
							}
						} catch (err) {
							safeSend(ws, { type: "error", message: `Failed to read file: ${String(err)}` })
						}
					} else {
						safeSend(ws, { type: "error", message: "File not found or outside workspace" })
					}
				} else if (clientMsg.type === "showItem" || clientMsg.type === "openFile") {
					const rawWs = agentHost.getWorkspace()
					if (!rawWs || !rawWs.trim()) {
						safeSend(ws, { type: "error", message: "No workspace open" })
						return
					}
					const wsRoot = path.normalize(path.resolve(rawWs))
					const validation = validatePathWithinRoot(clientMsg.filePath, wsRoot)
					if (validation.safe && validation.resolvedPath && fs.existsSync(validation.resolvedPath)) {
						const abs = validation.resolvedPath
						try {
							if (process.versions?.electron) {
								try {
									const electron = await import("electron")
									const shell = electron.shell || (electron as any).default?.shell
									if (shell) {
										if (clientMsg.type === "showItem") {
											shell.showItemInFolder(abs)
										} else {
											await shell.openPath(abs)
										}
									}
								} catch {
									if (process.platform === "win32") {
										if (clientMsg.type === "showItem") {
											spawn("explorer.exe", ["/select,", abs], { shell: false })
										} else {
											spawn("explorer.exe", [abs], { shell: false })
										}
									}
								}
							} else if (process.platform === "win32") {
								if (clientMsg.type === "showItem") {
									spawn("explorer.exe", ["/select,", abs], { shell: false })
								} else {
									spawn("explorer.exe", [abs], { shell: false })
								}
							}
						} catch {}
					} else {
						safeSend(ws, { type: "error", message: validation.error || "Access outside workspace forbidden" })
					}
				} else if (clientMsg.type === "getDiffs") {
					safeSend(ws, { type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
				} else if (clientMsg.type === "getTerminalLogs") {
					safeSend(ws, { type: "terminalLogsUpdated", entries: agentHost.getTerminalLogs() })
				} else if (clientMsg.type === "clearTerminalLogs") {
					if (typeof (agentHost as any).clearTerminalLogs === "function") {
						;(agentHost as any).clearTerminalLogs()
					}
					safeSend(ws, { type: "terminalLogsCleared" } as any)
				} else if (clientMsg.type === "getSidebarData") {
					safeSend(ws, { type: "sidebarData", data: getSidebarData() })
				} else if (clientMsg.type === "markChatRead") {
					if (clientMsg.taskId) {
						await agentHost.markChatRead(clientMsg.taskId)
						broadcastSidebarData()
					}
				} else if (clientMsg.type === "switchChat") {
					if (clientMsg.workspacePath && fs.existsSync(clientMsg.workspacePath)) {
						try {
							const normReq = path.normalize(path.resolve(clientMsg.workspacePath))
							const curWs = agentHost.getWorkspace()
							if (!curWs || path.normalize(path.resolve(curWs)) !== normReq) {
								await agentHost.setWorkspace(normReq)
								saveDesktopConfig({ lastWorkspacePath: normReq })
								const folderScan = scanWorkspace(normReq)
								const newWs: WorkspaceInfo = {
									path: normReq,
									name: path.basename(normReq),
									branch: getGitBranch(normReq),
									files: folderScan.files,
									directories: folderScan.directories,
								}
								broadcast({ type: "workspaceInfo", workspace: newWs })
								broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
							}
						} catch (err) {
							safeSend(ws, { type: "error", message: `Failed to switch workspace: ${String(err)}` })
						}
					}
					await agentHost.showTaskWithId(clientMsg.taskId)
					broadcastSidebarData()
					broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
				} else if (clientMsg.type === "newChat") {
					if (clientMsg.workspacePath && fs.existsSync(clientMsg.workspacePath)) {
						try {
							const normReq = path.normalize(path.resolve(clientMsg.workspacePath))
							const curWs = agentHost.getWorkspace()
							if (!curWs || path.normalize(path.resolve(curWs)) !== normReq) {
								await agentHost.setWorkspace(normReq)
								saveDesktopConfig({ lastWorkspacePath: normReq })
								const folderScan = scanWorkspace(normReq)
								const newWs: WorkspaceInfo = {
									path: normReq,
									name: path.basename(normReq),
									branch: getGitBranch(normReq),
									files: folderScan.files,
									directories: folderScan.directories,
								}
								broadcast({ type: "workspaceInfo", workspace: newWs })
								broadcast({ type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
							}
						} catch (err) {
							safeSend(ws, { type: "error", message: `Failed to switch workspace: ${String(err)}` })
						}
					}
					await agentHost.clearTask()
					broadcastSidebarData()
				} else if (clientMsg.type === "removeRecentWorkspace") {
					const curCfg = loadDesktopConfig()
					const removePath = clientMsg.path
					const updated = (curCfg.recentWorkspaces || []).filter(
						(p) => !arePathsEqual(p, removePath)
					)
					saveDesktopConfig({ recentWorkspaces: updated })
					broadcastSidebarData()
				} else if (clientMsg.type === "deleteChat") {
					const taskId = clientMsg.taskId
					const forceStop = Boolean(clientMsg.forceStop)
					const result = await agentHost.deleteChat(taskId, forceStop)
					safeSend(ws, {
						type: "chatDeleted",
						taskId,
						success: result.success,
						error: result.error,
						requiresStop: result.requiresStop,
					})
					if (result.success) {
						broadcastSidebarData()
					}
				} else if (clientMsg.type === "renameProject") {
					try {
						const sidebar = getSidebarData()
						renameProject(clientMsg.path, clientMsg.name, [sidebar.currentWorkspace, ...Object.keys(sidebar.chats)])
						broadcastSidebarData()
						safeSend(ws, { type: "projectRenameResult", path: clientMsg.path, success: true })
					} catch (error) {
						safeSend(ws, { type: "projectRenameResult", path: clientMsg.path, success: false, error: error instanceof Error ? error.message : "Unable to rename project" })
					}
				} else if (clientMsg.type === "removeProject") {
					const projectPath = clientMsg.path
					const forceStop = Boolean(clientMsg.forceStop)
					const result = await agentHost.removeProject(projectPath, forceStop)
					safeSend(ws, {
						type: "projectRemoved",
						path: projectPath,
						success: result.success,
						error: result.error,
						requiresStop: result.requiresStop,
						activeTasksCount: result.activeTasksCount,
					})
					if (result.success) {
						broadcastSidebarData()
					}
				} else if (clientMsg.type === "openProjectFolder") {
					const p = clientMsg.path
					if (p && typeof p === "string" && fs.existsSync(p)) {
						const norm = canonicalizePath(p)
						const allowedWorkspaces = [
							agentHost.getWorkspace(),
							...(loadDesktopConfig().recentWorkspaces || [])
						].filter(Boolean).map(canonicalizePath)
						const isAuthorized = allowedWorkspaces.some(w => arePathsEqual(w, norm))
						if (!isAuthorized) {
							safeSend(ws, { type: "error", message: "Forbidden: folder is not an authorized workspace" })
							return
						}
						try {
							if (process.versions?.electron) {
								try {
									const electron = await import("electron")
									const shell = electron.shell || (electron as any).default?.shell
									if (shell) {
										await shell.openPath(norm)
									}
								} catch {
									if (process.platform === "win32") {
										spawn("explorer.exe", [norm], { shell: false })
									}
								}
							} else if (process.platform === "win32") {
								spawn("explorer.exe", [norm], { shell: false })
							}
						} catch (e) {
							safeSend(ws, { type: "error", message: `Failed to open folder: ${String(e)}` })
						}
					}
				} else if (clientMsg.type === "renameChat") {
					const taskId = clientMsg.taskId
					const title = clientMsg.title
					if (taskId && title) {
						await agentHost.renameChat(taskId, title)
					}
				} else if (clientMsg.type === "reorderWorkspaces") {
					const incoming = Array.isArray(clientMsg.workspaces) ? clientMsg.workspaces : []
					const deduped: string[] = []
					for (const p of incoming) {
						if (!p || typeof p !== "string" || !p.trim()) continue
						const canon = canonicalizePath(p)
						if (!deduped.some((existing) => arePathsEqual(existing, canon))) {
							deduped.push(canon)
						}
					}
					saveDesktopConfig({ recentWorkspaces: deduped })
					broadcastSidebarData()
				}
			} catch (err) {
				safeSend(ws, { type: "error", message: String(err) })
			}
		})

		ws.on("close", (code, reason) => {
			clients.delete(ws)
			logStartupDebug(`[WS] Client disconnected (code: ${code}, reason: ${reason?.toString() || "none"}). Remaining clients: ${clients.size}`)
		})
	})

	return {
		server,
		wss,
		start: () =>
			new Promise((resolve, reject) => {
				logStartupDebug(`desktopServer.start() attempting to listen on ${host}:${port}...`)
				server.once("error", (err) => {
					logStartupDebug(`HTTP server error during listen: ${err?.stack || err}`)
					reject(err)
				})
				server.listen(port, host, () => {
					const addr = server.address()
					const actualPort = typeof addr === "object" && addr ? addr.port : port
					logStartupDebug(`HTTP server successfully listening on ${host}:${actualPort}`)
					resolve(actualPort)
				})
			}),
		stop: () =>
			new Promise((resolve) => {
				agentHost.off("navigationCountsUpdated", onNavigationCounts)
				agentHost.off("terminalLogsUpdated", onTerminalLogsUpdated)
				logStartupDebug(`[SERVER] Stopping desktopServer... Active clients: ${clients.size}`)
				for (const client of clients) {
					try {
						client.terminate()
					} catch (e) {
						logStartupDebug(`[SERVER] Error terminating client WS: ${e}`)
					}
				}
				clients.clear()

				let wssClosed = false
				let serverClosed = false
				const checkDone = () => {
					if (wssClosed && serverClosed) {
						logStartupDebug("[SERVER] Both WSS and HTTP server stopped cleanly.")
						resolve()
					}
				}

				const forceTimeout = setTimeout(() => {
					logStartupDebug("[SERVER] Forcefully resolving stop() after timeout.")
					resolve()
				}, 2000)

				wss.close((err) => {
					if (err) logStartupDebug(`[SERVER] WSS close error: ${err}`)
					else logStartupDebug("[SERVER] WSS closed.")
					wssClosed = true
					checkDone()
				})

				if (typeof (server as any).closeAllConnections === "function") {
					try {
						;(server as any).closeAllConnections()
					} catch (err) {
						logStartupDebug(`[SERVER] closeAllConnections error: ${err}`)
					}
				}

				server.close((err) => {
					if (err) logStartupDebug(`[SERVER] HTTP server close error: ${err}`)
					else logStartupDebug("[SERVER] HTTP server closed.")
					serverClosed = true
					clearTimeout(forceTimeout)
					checkDone()
				})
			}),
	}
}
