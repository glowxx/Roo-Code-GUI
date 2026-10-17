import { logStartupDebug, setupGlobalCrashHandlers } from "./logger.js"
import { execSync } from "child_process"

if (process.platform === "win32" && !process.env.ROO_TOKEN_AUDIT) {
	try {
		const regOut = execSync('reg query "HKCU\\Environment" /v ROO_TOKEN_AUDIT', { encoding: "utf8" })
		if (regOut.includes("true")) {
			process.env.ROO_TOKEN_AUDIT = "true"
		}
	} catch {}
}

setupGlobalCrashHandlers("DesktopMain")
logStartupDebug("=== Roo Code Desktop Starting ===")
logStartupDebug(`Versions: ${JSON.stringify(process.versions)}`)
logStartupDebug(`Process argv: ${JSON.stringify(process.argv)}`)
logStartupDebug(`Cwd: ${process.cwd()}`)
logStartupDebug(`ROO_TOKEN_AUDIT: ${process.env.ROO_TOKEN_AUDIT}`)

import path from "path"
import fs from "fs"
import os from "os"
import { fileURLToPath } from "url"
import { DesktopAgentHost } from "./agent-host.js"
import { createDesktopServer, validatePathWithinRoot, getGitBranch, listWorkspaceFiles, scanWorkspace } from "./server.js"
import { loadDesktopConfig, saveDesktopConfig, canonicalizePath } from "./config.js"
import { createQuickProject } from "./quick-project.js"
import type { WorkspaceInfo } from "../shared/types.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export interface DesktopRunOptions {
	workspacePath?: string
	port?: number
	isElectron?: boolean
	openBrowser?: boolean
	dev?: boolean
	storageDir?: string
}

export async function startDesktopApp(options: DesktopRunOptions = {}) {
	logStartupDebug(`startDesktopApp called with options: ${JSON.stringify(options)}`)
	// Determine workspace:
	// 1. Check CLI arguments (-w / --workspace)
	const args = process.argv.slice(2)
	const wsArgIdx = args.indexOf("-w") !== -1 ? args.indexOf("-w") : args.indexOf("--workspace")
	let explicitWsFromArg: string | undefined
	if (wsArgIdx !== -1 && args[wsArgIdx + 1]) {
		explicitWsFromArg = args[wsArgIdx + 1]
	} else {
		const wsEqualArg = args.find((a) => a.startsWith("-w=") || a.startsWith("--workspace="))
		if (wsEqualArg) {
			explicitWsFromArg = wsEqualArg.split("=").slice(1).join("=")
		}
	}

	let workspacePath = ""
	if (explicitWsFromArg && explicitWsFromArg.trim()) {
		const resolvedArg = canonicalizePath(explicitWsFromArg.trim())
		if (fs.existsSync(resolvedArg)) {
			try {
				if (fs.statSync(resolvedArg).isDirectory()) {
					workspacePath = resolvedArg
					saveDesktopConfig({ lastWorkspacePath: resolvedArg })
				}
			} catch {}
		}
	} else if (options.workspacePath && options.workspacePath.trim()) {
		const resolvedOpt = canonicalizePath(options.workspacePath.trim())
		if (fs.existsSync(resolvedOpt)) {
			try {
				if (fs.statSync(resolvedOpt).isDirectory()) {
					workspacePath = resolvedOpt
				}
			} catch {}
		}
	}

	// If no explicit workspace was resolved from CLI or options, restore lastWorkspacePath from config
	if (!workspacePath) {
		const config = loadDesktopConfig()
		if (config.lastWorkspacePath && fs.existsSync(config.lastWorkspacePath)) {
			try {
				if (fs.statSync(config.lastWorkspacePath).isDirectory()) {
					workspacePath = canonicalizePath(config.lastWorkspacePath)
				}
			} catch {}
		}
	}

	// Zero-state resilience: do not force process.cwd() when no workspace is selected!
	workspacePath = workspacePath && workspacePath.trim() ? canonicalizePath(workspacePath) : ""
	const port = options.port || 4500
	const storageDir = options.storageDir || process.env.ROO_STORAGE_DIR || path.join(os.homedir(), ".roo-desktop-data")
	if (!fs.existsSync(storageDir)) {
		fs.mkdirSync(storageDir, { recursive: true })
	}

	// Locate extension bundle
	let extensionPath = ""
	const candidateEnginePaths = [
		process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "engine") : "",
		process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "dist", "engine") : "",
		process.resourcesPath ? path.join(process.resourcesPath, "engine") : "",
		path.join(__dirname, "..", "engine"),
		path.join(__dirname, "engine"),
	].filter(Boolean)

	for (const candidate of candidateEnginePaths) {
		if (fs.existsSync(path.join(candidate, "extension.js"))) {
			extensionPath = candidate
			break
		}
	}

	if (!extensionPath) {
		let rootDir = __dirname
		while (rootDir !== path.dirname(rootDir)) {
			if (fs.existsSync(path.join(rootDir, "src", "dist", "extension.js"))) {
				extensionPath = path.join(rootDir, "src", "dist")
				break
			}
			rootDir = path.dirname(rootDir)
		}
	}

	let staticDir = ""
	const candidateStaticDirs = [
		process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "renderer") : "",
		process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "dist", "renderer") : "",
		path.join(__dirname, "renderer"),
		path.join(__dirname, "..", "renderer"),
		process.resourcesPath ? path.join(process.resourcesPath, "renderer") : "",
	].filter(Boolean)

	for (const candidate of candidateStaticDirs) {
		if (fs.existsSync(path.join(candidate, "index.html"))) {
			staticDir = candidate
			break
		}
	}

	logStartupDebug("⚡ Starting Roo Code Desktop...")
	logStartupDebug(`📁 Workspace: ${workspacePath || "(none - zero-state)"}`)
	logStartupDebug(`📦 Core Engine: ${extensionPath}`)
	logStartupDebug(`💾 Storage: ${storageDir}`)
	logStartupDebug(`🌐 Static Dir: ${staticDir}`)

	const agentHost = new DesktopAgentHost({
		workspacePath,
		extensionPath,
		storageDir,
	})

	logStartupDebug("Initializing DesktopAgentHost...")
	await agentHost.init()
	logStartupDebug("🤖 Agent Engine initialized successfully.")
	console.log("🤖 Agent Engine initialized successfully.")

	let onQuitHandler: (() => void) | undefined = async () => {
		logStartupDebug("[EXIT] Default onQuitHandler triggered. Stopping desktopServer...")
		try {
			await desktopServer.stop()
		} catch {}
		process.exit(0)
	}

	const desktopServer = createDesktopServer({
		port,
		host: "127.0.0.1",
		agentHost,
		staticDir,
		onQuit: () => {
			logStartupDebug("[SERVER] onQuit callback triggered")
			onQuitHandler?.()
		},
	})

	process.on("SIGINT", () => {
		logStartupDebug("[PROCESS] SIGINT signal received")
		onQuitHandler?.()
	})
	process.on("SIGTERM", () => {
		logStartupDebug("[PROCESS] SIGTERM signal received")
		onQuitHandler?.()
	})

	logStartupDebug(`Starting DesktopServer on port ${port}...`)
	const actualPort = await desktopServer.start()
	const appUrl = `http://127.0.0.1:${actualPort}`
	logStartupDebug(`🚀 Roo Code Desktop running at: ${appUrl}`)
	console.log(`🚀 Roo Code Desktop running at: ${appUrl}`)

	if (options.isElectron && process.versions.electron) {
		try {
			logStartupDebug("Electron detected, importing electron module...")
			const electron = await import("electron")
			const electronObj = (electron as any).app ? electron : ((electron as any).default || electron)
			const { app, BrowserWindow, dialog, ipcMain, Menu, shell, screen } = electronObj

			try {
				if (app) {
					app.name = "Roo Code"
					if (typeof app.setName === "function") {
						app.setName("Roo Code")
					}
					if (process.env.ROO_CONFIG_DIR) {
						const isolatedUserData = path.join(process.env.ROO_CONFIG_DIR, "userData")
						if (!fs.existsSync(isolatedUserData)) {
							fs.mkdirSync(isolatedUserData, { recursive: true })
						}
						app.setPath("userData", isolatedUserData)
					}
				}
			} catch {}

			logStartupDebug("Waiting for app.whenReady()...")
			await app.whenReady()
			logStartupDebug("app.whenReady() resolved successfully")

			const gotTheLock = app.requestSingleInstanceLock()
			if (!gotTheLock) {
				logStartupDebug("Another instance of Roo Code Desktop is already running. Quitting.")
				app.quit()
				process.exit(0)
			}

			const config = loadDesktopConfig()
			const windowBounds = config.windowBounds

			let windowX = windowBounds?.x
			let windowY = windowBounds?.y
			if (typeof windowX === "number" && typeof windowY === "number") {
				const displays = screen.getAllDisplays()
				const isVisible = displays.some((d: any) => {
					const { x, y, width, height } = d.bounds
					return (
						windowX! >= x - 50 &&
						windowX! < x + width &&
						windowY! >= y - 50 &&
						windowY! < y + height
					)
				})
				if (!isVisible) {
					windowX = undefined
					windowY = undefined
				}
			}

			let preloadPath = path.join(__dirname, "..", "preload", "index.js")
			const candidatePreloadPaths = [
				process.resourcesPath ? path.join(process.resourcesPath, "app.asar.unpacked", "dist", "preload", "index.js") : "",
				process.resourcesPath ? path.join(process.resourcesPath, "app.asar", "dist", "preload", "index.js") : "",
				preloadPath,
				path.join(__dirname, "preload", "index.js"),
			].filter(Boolean)
			for (const cp of candidatePreloadPaths) {
				if (fs.existsSync(cp)) {
					preloadPath = cp
					break
				}
			}
			logStartupDebug(`Resolved preload script: ${preloadPath}`)

			const iconCandidate = path.join(staticDir, "icon.png")
			logStartupDebug(`Creating BrowserWindow (icon: ${iconCandidate})...`)
			const win = new BrowserWindow({
				width: windowBounds?.width ?? 1300,
				height: windowBounds?.height ?? 880,
				x: windowX,
				y: windowY,
				minWidth: 900,
				minHeight: 600,
				title: "Roo Code Desktop",
				backgroundColor: "#202123",
				icon: fs.existsSync(iconCandidate) ? iconCandidate : undefined,
				frame: false,
				titleBarStyle: "hidden",
				titleBarOverlay: false,
				webPreferences: {
					preload: preloadPath,
					contextIsolation: true,
					nodeIntegration: false,
				},
			})
			logStartupDebug(`BrowserWindow created (id: ${win.id})`)

			if (windowBounds?.isMaximized) {
				win.maximize()
			}

			const saveBounds = () => {
				if (win.isDestroyed()) return
				const isMaximized = win.isMaximized()
				if (isMaximized) {
					saveDesktopConfig({
						windowBounds: {
							...(loadDesktopConfig().windowBounds || { width: 1300, height: 880 }),
							isMaximized: true,
						},
					})
				} else {
					const bounds = win.getBounds()
					saveDesktopConfig({
						windowBounds: {
							width: bounds.width,
							height: bounds.height,
							x: bounds.x,
							y: bounds.y,
							isMaximized: false,
						},
					})
				}
			}

			let saveBoundsTimeout: NodeJS.Timeout | null = null
			const debouncedSaveBounds = () => {
				if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout)
				saveBoundsTimeout = setTimeout(saveBounds, 500)
			}

			win.on("resize", debouncedSaveBounds)
			win.on("move", debouncedSaveBounds)
			win.on("maximize", saveBounds)
			win.on("unmaximize", debouncedSaveBounds)
			win.on("close", () => {
				if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout)
				saveBounds()
			})

			// Forward agentHost terminal events to Electron renderer
			agentHost.on("terminalSessionStarted", (session) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "terminalSessionStarted", ...session })
				}
			})
			agentHost.on("terminalOutput", (output) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "terminalOutput", ...output })
				}
			})
			agentHost.on("terminalSessionEnded", (result) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "terminalSessionEnded", ...result })
				}
			})
			agentHost.on("terminalLog", (entry) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "terminalLog", entry })
				}
			})
			agentHost.on("workspaceFilesChanged", (files) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "workspaceFilesChanged", files })
				}
			})
			agentHost.on("diffsUpdated", (diffs) => {
				if (!win.isDestroyed()) {
					win.webContents.send("desktop:message-from-extension", { type: "diffsUpdated", diffs })
				}
			})

			// IPC Handlers for communication with renderer
			ipcMain.on("desktop:message-to-extension", (_event: any, message: any) => {
				agentHost.sendToExtension(message as any)
			})

			// Window control IPC handlers
			ipcMain.on("desktop:window-minimize", () => {
				logStartupDebug("IPC received: desktop:window-minimize")
				if (!win.isDestroyed()) win.minimize()
			})
			ipcMain.on("desktop:window-maximize", () => {
				logStartupDebug("IPC received: desktop:window-maximize")
				if (!win.isDestroyed()) {
					if (win.isMaximized()) {
						win.unmaximize()
					} else {
						win.maximize()
					}
				}
			})
			ipcMain.on("desktop:window-close", () => {
				logStartupDebug("IPC received: desktop:window-close")
				if (!win.isDestroyed()) win.close()
			})

			const handleSelectFolder = async () => {
				const result = await dialog.showOpenDialog(win, {
					properties: ["openDirectory"],
					defaultPath: agentHost.getWorkspace() || undefined,
				})
				if (!result.canceled && result.filePaths.length > 0) {
					const selectedPath = result.filePaths[0]
					if (selectedPath) {
						console.log(`Switching workspace to: ${selectedPath}`)
						const normalized = path.normalize(path.resolve(selectedPath))
						await agentHost.setWorkspace(normalized)
						saveDesktopConfig({ lastWorkspacePath: normalized })
						const scan = scanWorkspace(normalized)
						const newWs: WorkspaceInfo = {
							path: normalized,
							name: path.basename(normalized),
							branch: getGitBranch(normalized),
							files: scan.files,
							directories: scan.directories,
						}
						if (!win.isDestroyed()) {
							win.webContents.send("desktop:message-from-extension", { type: "workspaceInfo", workspace: newWs })
							win.webContents.send("desktop:message-from-extension", { type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
						}
						return normalized
					}
				}
				return null
			}

			ipcMain.handle("desktop:select-folder", handleSelectFolder)
			ipcMain.handle("desktop:select-workspace", handleSelectFolder)

			ipcMain.handle("desktop:create-quick-project", async () => {
				const result = await createQuickProject(agentHost, {
					broadcast: (msg) => {
						if (!win.isDestroyed()) {
							win.webContents.send("desktop:message-from-extension", msg)
						}
					},
					broadcastSidebarData: () => {
						if (!win.isDestroyed()) {
							const cfg = loadDesktopConfig()
							win.webContents.send("desktop:message-from-extension", {
								type: "sidebarData",
								data: {
									recentWorkspaces: cfg.recentWorkspaces || [],
									projectNames: cfg.projectNames || {},
									currentWorkspace: agentHost.getWorkspace(),
									activeTaskId: agentHost.getActiveTaskId(),
									chats: agentHost.getChatsByWorkspace(),
								},
							})
						}
					},
				})
				return result
			})

			ipcMain.handle("desktop:show-item", async (_event: any, filePath: string) => {
				if (filePath && typeof filePath === "string") {
					const rawWs = agentHost.getWorkspace()
					if (!rawWs || !rawWs.trim()) return false
					const wsRoot = path.normalize(path.resolve(rawWs))
					const validation = validatePathWithinRoot(filePath, wsRoot)
					if (validation.safe && validation.resolvedPath && fs.existsSync(validation.resolvedPath)) {
						shell.showItemInFolder(validation.resolvedPath)
						return true
					}
				}
				return false
			})

			ipcMain.handle("desktop:open-path", async (_event: any, filePath: string) => {
				if (filePath && typeof filePath === "string") {
					const rawWs = agentHost.getWorkspace()
					if (!rawWs || !rawWs.trim()) return false
					const wsRoot = path.normalize(path.resolve(rawWs))
					const validation = validatePathWithinRoot(filePath, wsRoot)
					if (validation.safe && validation.resolvedPath && fs.existsSync(validation.resolvedPath)) {
						await shell.openPath(validation.resolvedPath)
						return true
					}
				}
				return false
			})

			// Create application menu
			const menuTemplate: Electron.MenuItemConstructorOptions[] = [
				{
					label: "Plik",
					submenu: [
						{
							label: "Otwórz folder projektu…",
							accelerator: "CmdOrCtrl+O",
							click: async () => {
								await handleSelectFolder()
							},
						},
						{ type: "separator" },
						{ role: "quit", label: "Zakończ" },
					],
				},
				{
					label: "Edycja",
					submenu: [
						{ role: "undo", label: "Cofnij" },
						{ role: "redo", label: "Ponów" },
						{ type: "separator" },
						{ role: "cut", label: "Wytnij" },
						{ role: "copy", label: "Kopiuj" },
						{ role: "paste", label: "Wklej" },
						{ role: "selectAll", label: "Zaznacz wszystko" },
					],
				},
				{
					label: "Widok",
					submenu: [
						{ role: "reload", label: "Odśwież" },
						{ role: "forceReload", label: "Wymuś odświeżenie" },
						{ role: "toggleDevTools", label: "Narzędzia programistyczne" },
						{ type: "separator" },
						{ role: "resetZoom", label: "Rozmiar rzeczywisty" },
						{ role: "zoomIn", label: "Powiększ" },
						{ role: "zoomOut", label: "Pomniejsz" },
						{ type: "separator" },
						{ role: "togglefullscreen", label: "Pełny ekran" },
					],
				},
			]

			const menu = Menu.buildFromTemplate(menuTemplate)
			Menu.setApplicationMenu(menu)

			win.webContents.on("console-message", (_event: any, level: number, message: string, line: number, sourceId: string) => {
				logStartupDebug(`[RENDERER CONSOLE lvl:${level}] ${message} (${sourceId}:${line})`)
			})

			win.webContents.on("did-finish-load", () => {
				logStartupDebug("BrowserWindow webContents 'did-finish-load' fired")
				if (!win.isDestroyed()) {
					const rawWs = agentHost.getWorkspace()
					const curWs = rawWs && rawWs.trim() ? path.normalize(path.resolve(rawWs)) : ""
					const scan = curWs ? scanWorkspace(curWs) : { files: [], directories: [] }
					const newWs: WorkspaceInfo = {
						path: curWs,
						name: curWs ? path.basename(curWs) : "",
						branch: curWs ? getGitBranch(curWs) : undefined,
						files: scan.files,
						directories: scan.directories,
					}
					win.webContents.send("desktop:message-from-extension", { type: "workspaceInfo", workspace: newWs })
					win.webContents.send("desktop:message-from-extension", { type: "diffsUpdated", diffs: agentHost.getDiffFiles() })
				}
			})

			win.webContents.on("did-fail-load", (_event: any, errorCode: any, errorDescription: any, validatedURL: any) => {
				logStartupDebug(`BrowserWindow did-fail-load: ${errorCode} - ${errorDescription} (${validatedURL})`)
			})

			win.webContents.on("render-process-gone", (_event: any, details: any) => {
				logStartupDebug(`BrowserWindow render-process-gone: ${JSON.stringify(details)}`)
			})

			app.on("second-instance", () => {
				logStartupDebug("app 'second-instance' event fired - restoring window")
				if (win && !win.isDestroyed()) {
					if (win.isMinimized()) win.restore()
					win.focus()
				}
			})

			logStartupDebug(`Loading appUrl in BrowserWindow: ${appUrl}`)
			await win.loadURL(appUrl)
			logStartupDebug("win.loadURL completed successfully")

			let isShuttingDown = false
			const terminateApp = async (reason: string) => {
				if (isShuttingDown) return
				isShuttingDown = true
				logStartupDebug(`[EXIT] Terminating application (trigger: ${reason}). Stopping servers...`)
				try {
					if (desktopServer) {
						await desktopServer.stop()
						logStartupDebug("[EXIT] desktopServer.stop() completed successfully.")
					}
				} catch (e) {
					logStartupDebug(`[EXIT] Error stopping desktopServer: ${e}`)
				}
				logStartupDebug("[EXIT] Calling app.quit() and scheduling force exit...")
				try {
					app.quit()
				} catch {}
				setTimeout(() => {
					logStartupDebug("[EXIT] Forcing process.exit(0)")
					process.exit(0)
				}, 300).unref()
			}

			onQuitHandler = () => terminateApp("onQuitHandler")

			win.on("closed", () => {
				logStartupDebug("BrowserWindow closed")
				terminateApp("win.on('closed')")
			})

			app.on("window-all-closed", () => {
				logStartupDebug("app window-all-closed")
				terminateApp("app.on('window-all-closed')")
			})

			app.on("before-quit", () => {
				logStartupDebug("app before-quit")
				terminateApp("app.on('before-quit')")
			})
			return
		} catch (err) {
			const msg = `Electron GUI could not be initialized, falling back to Web Desktop: ${err instanceof Error ? err.stack : String(err)}`
			logStartupDebug(msg)
			console.warn(msg)
		}
	}

	if (options.openBrowser) {
		try {
			const { default: open } = await import("open")
			await open(appUrl)
		} catch {
			// ignore open error
		}
	}

	return { url: appUrl, stop: desktopServer.stop }
}

// Auto-start when executed directly in an Electron process (e.g. electron . or packaged app)
if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
	const args = process.argv.slice(2)
	let workspacePath: string | undefined
	const wsArgIdx = args.indexOf("-w") !== -1 ? args.indexOf("-w") : args.indexOf("--workspace")
	if (wsArgIdx !== -1 && args[wsArgIdx + 1]) {
		workspacePath = args[wsArgIdx + 1]!
	} else {
		const wsEqualArg = args.find((a) => a.startsWith("-w=") || a.startsWith("--workspace="))
		if (wsEqualArg) {
			workspacePath = wsEqualArg.split("=").slice(1).join("=")
		}
	}
	let port: number | undefined
	const portIdx = args.indexOf("-p") !== -1 ? args.indexOf("-p") : args.indexOf("--port")
	if (portIdx !== -1 && args[portIdx + 1]) {
		const parsedPort = parseInt(args[portIdx + 1]!, 10)
		if (!isNaN(parsedPort)) port = parsedPort
	} else {
		const portEqualArg = args.find((a) => a.startsWith("-p=") || a.startsWith("--port="))
		if (portEqualArg) {
			const parsedPort = parseInt(portEqualArg.split("=")[1]!, 10)
			if (!isNaN(parsedPort)) port = parsedPort
		}
	}

	let storageDir: string | undefined
	const storageIdx = args.indexOf("-s") !== -1 ? args.indexOf("-s") : args.indexOf("--storage-dir")
	if (storageIdx !== -1 && args[storageIdx + 1]) {
		storageDir = args[storageIdx + 1]!
	} else {
		const storageEqualArg = args.find((a) => a.startsWith("-s=") || a.startsWith("--storage-dir="))
		if (storageEqualArg) {
			storageDir = storageEqualArg.split("=").slice(1).join("=")
		}
	}

	if (workspacePath && workspacePath.trim()) {
		const resolvedArg = path.normalize(path.resolve(workspacePath.trim()))
		if (fs.existsSync(resolvedArg)) {
			try {
				if (fs.statSync(resolvedArg).isDirectory()) {
					workspacePath = resolvedArg
					saveDesktopConfig({ lastWorkspacePath: resolvedArg })
				} else {
					workspacePath = undefined
				}
			} catch {
				workspacePath = undefined
			}
		} else {
			workspacePath = undefined
		}
	}

	if (!workspacePath) {
		const config = loadDesktopConfig()
		if (config.lastWorkspacePath && fs.existsSync(config.lastWorkspacePath)) {
			try {
				if (fs.statSync(config.lastWorkspacePath).isDirectory()) {
					workspacePath = path.normalize(path.resolve(config.lastWorkspacePath))
				}
			} catch {}
		}
	}

	logStartupDebug(`Electron auto-start resolved workspacePath: ${workspacePath || "(none)"}, port: ${port || 4500}, storageDir: ${storageDir || "(default)"}`)
	startDesktopApp({
		workspacePath: workspacePath || "",
		port,
		storageDir,
		isElectron: true,
	}).catch((err) => {
		const msg = `Failed to start Roo Code Desktop in Electron: ${err?.stack || err}`
		logStartupDebug(msg)
		console.error(msg)
	})
}
