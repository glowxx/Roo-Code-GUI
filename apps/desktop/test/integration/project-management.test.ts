import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import path from "path"
import fs from "fs"
import os from "os"
import { DesktopAgentHost } from "../../src/main/agent-host.js"
import {
	canonicalizePath,
	arePathsEqual,
	loadDesktopConfig,
	saveDesktopConfig,
	getConfigFilePath,
	renameProject,
} from "../../src/main/config.js"

describe("Project Management & Sidebar Creation Flow (TDD)", () => {
	let tempDir: string
	let tempConfigPath: string
	let origAppData: string | undefined

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-proj-test-"))
		// Redirect config file to isolated test directory
		origAppData = process.env.APPDATA
		process.env.APPDATA = tempDir
	})

	afterEach(() => {
		process.env.APPDATA = origAppData
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {}
	})

	describe("1. DOM Structure & Accessibility: Add Project Control in Sidebar Header", () => {
		it("index.html contains #sidebar-add-project-btn inside .sidebar-section-header with accessible attributes", () => {
			const indexPath = path.resolve(__dirname, "../../src/renderer/index.html")
			expect(fs.existsSync(indexPath)).toBe(true)
			const html = fs.readFileSync(indexPath, "utf-8")

			// Check for sidebar-section-header
			expect(html).toContain("sidebar-section-header")

			// Must contain the dedicated #sidebar-add-project-btn
			expect(html).toContain('id="sidebar-add-project-btn"')

			// Must be a button element with type="button" and accessibility attributes
			const btnPattern = /<button[^>]*id="sidebar-add-project-btn"[^>]*>/i
			const match = html.match(btnPattern)
			expect(match).not.toBeNull()

			const btnTag = match![0]
			expect(btnTag).toMatch(/aria-label="(Add project|Dodaj projekt)"/)
			expect(btnTag).toMatch(/title="(Add project|Dodaj projekt)"/)
			expect(btnTag).toContain('tabindex="0"')

			// Must contain SVG plus icon
			const iconSlice = html.substring(html.indexOf('id="sidebar-add-project-btn"'), html.indexOf('id="sidebar-add-project-btn"') + 400)
			expect(iconSlice).toContain("<svg")
			expect(iconSlice).toContain("<line")

			// Preferred composition: PROJECTS label, then actions cluster containing the button and count badge
			expect(html).toContain("sidebar-section-actions")
			expect(html).toContain("sidebar-projects-count")
		})
	})

	describe("2. Windows Path Normalization & Equality", () => {
		it("normalizes drive letter, separators, and trailing slashes", () => {
			const p1 = "c:\\projects\\myapp"
			const p2 = "C:\\projects\\myapp\\"
			const p3 = "c:/projects/myapp/"

			const norm1 = canonicalizePath(p1)
			const norm2 = canonicalizePath(p2)
			const norm3 = canonicalizePath(p3)

			// Both should standardize drive letter to uppercase on Windows
			if (process.platform === "win32") {
				expect(norm1.startsWith("C:")).toBe(true)
				expect(norm2.startsWith("C:")).toBe(true)
				expect(norm3.startsWith("C:")).toBe(true)
				// Should strip trailing slash
				expect(norm2.endsWith("\\")).toBe(false)
				expect(norm3.endsWith("/")).toBe(false)
			}
		})

		it("arePathsEqual returns true regardless of casing or slash format on Windows", () => {
			const pUpper = "C:\\Projects\\MyAwesomeApp"
			const pLower = "c:\\projects\\myawesomeapp\\"
			const pForward = "C:/Projects/MyAwesomeApp/"

			if (process.platform === "win32") {
				expect(arePathsEqual(pUpper, pLower)).toBe(true)
				expect(arePathsEqual(pUpper, pForward)).toBe(true)
				expect(arePathsEqual(pLower, pForward)).toBe(true)
			} else {
				expect(arePathsEqual(pUpper, pUpper)).toBe(true)
			}

			// Different paths must not match
			expect(arePathsEqual("C:\\Projects\\App1", "C:\\Projects\\App2")).toBe(false)
		})
	})

	describe("3. Config Persistence & Duplicate Prevention", () => {
		it("renames and resets display metadata without changing workspace identity or order", () => {
			const first = path.join(tempDir, "Roo-Code")
			const second = path.join(tempDir, "Other")
			fs.mkdirSync(first)
			fs.mkdirSync(second)
			saveDesktopConfig({ lastWorkspacePath: first, recentWorkspaces: [second, first] })

			expect(renameProject(first, "  Roo Desktop  ")).toEqual({ success: true })
			const renamed = loadDesktopConfig()
			expect(renamed.projectNames?.[canonicalizePath(first)]).toBe("Roo Desktop")
			expect(renamed.recentWorkspaces).toEqual([canonicalizePath(second), canonicalizePath(first)])
			expect(renamed.lastWorkspacePath).toBe(canonicalizePath(first))
			expect(() => renameProject(first, "   ")).toThrow()
			expect(renameProject(first, null)).toEqual({ success: true })
			expect(loadDesktopConfig().projectNames?.[canonicalizePath(first)]).toBeUndefined()
			expect(fs.existsSync(first)).toBe(true)
		})

		it("keeps two names and manual order through reload and rejects multiline names", () => {
			const first = path.join(tempDir, "ProjectA")
			const second = path.join(tempDir, "ProjectB")
			fs.mkdirSync(first)
			fs.mkdirSync(second)
			saveDesktopConfig({ lastWorkspacePath: first, recentWorkspaces: [first, second] })
			renameProject(first, "Roo A")
			renameProject(second, "Roo B")
			saveDesktopConfig({ recentWorkspaces: [second, first] })
			const reloaded = loadDesktopConfig()
			expect(reloaded.recentWorkspaces).toEqual([canonicalizePath(second), canonicalizePath(first)])
			expect(reloaded.projectNames).toEqual({ [canonicalizePath(first)]: "Roo A", [canonicalizePath(second)]: "Roo B" })
			expect(reloaded.lastWorkspacePath).toBe(canonicalizePath(first))
			expect(fs.readdirSync(tempDir)).toContain("ProjectA")
			expect(fs.readdirSync(tempDir)).toContain("ProjectB")
			expect(() => renameProject(first, "Line one\nLine two")).toThrow()
			expect(loadDesktopConfig().projectNames).toEqual(reloaded.projectNames)
			renameProject(second, null)
			expect(loadDesktopConfig().projectNames).toEqual({ [canonicalizePath(first)]: "Roo A" })
		})

		it("renames a visible active project even before it is in recent workspaces", () => {
			const current = path.join(tempDir, "CurrentProject")
			fs.mkdirSync(current)
			expect(loadDesktopConfig().recentWorkspaces).toBeUndefined()
			expect(() => renameProject(current, "Hidden", [])).toThrow("Unknown project")
			expect(renameProject(current, "Visible name", [current])).toEqual({ success: true })
			const afterRestart = loadDesktopConfig()
			expect(afterRestart.recentWorkspaces).toEqual([canonicalizePath(current)])
			expect(afterRestart.projectNames?.[canonicalizePath(current)]).toBe("Visible name")
			expect(fs.existsSync(current)).toBe(true)
		})
		it("keeps a full manual project list intact when renaming a visible project outside it", () => {
			const projects = Array.from({ length: 25 }, (_, index) => path.join(tempDir, `Project${index}`))
			const current = path.join(tempDir, "ActiveOutsideRecent")
			saveDesktopConfig({ lastWorkspacePath: projects[0], recentWorkspaces: projects })
			expect(renameProject(current, "Visible name", [current])).toEqual({ success: true })
			const reloaded = loadDesktopConfig()
			expect(reloaded.recentWorkspaces).toEqual(projects.map(canonicalizePath))
			expect(reloaded.projectNames?.[canonicalizePath(current)]).toBe("Visible name")
		})
		it("preserves chat ownership, active conversation and running task during rename", async () => {
			const project = path.join(tempDir, "ProjectA")
			const tasksDir = path.join(tempDir, "global-storage", "tasks")
			fs.mkdirSync(project)
			fs.mkdirSync(tasksDir, { recursive: true })
			fs.writeFileSync(path.join(tasksDir, "_index.json"), JSON.stringify({ entries: [
				{ id: "task-a", workspace: project, task: "Active chat", ts: Date.now() },
				{ id: "task-b", workspace: project, task: "Other chat", ts: Date.now() },
			] }))
			saveDesktopConfig({ lastWorkspacePath: project, recentWorkspaces: [project] })
			const host = new DesktopAgentHost({ workspacePath: project, extensionPath: tempDir, storageDir: tempDir })
			const task = { taskId: "task-a", cwd: project, isStreaming: true, abortTask: vi.fn() }
			const runningTasks = new Map([["task-a", task]])
			host.registerWebviewProvider("mockView", { runningTasks, getCurrentTask: () => task })
			await host.setActiveTaskId("task-a")
			const before = host.getChatsByWorkspace()

			renameProject(project, "Custom name")

			expect(host.getWorkspace()).toBe(canonicalizePath(project))
			expect(host.getActiveTaskId()).toBe("task-a")
			expect(host.getChatsByWorkspace()).toEqual(before)
			expect(before[canonicalizePath(project)]?.map((chat) => chat.id)).toEqual(expect.arrayContaining(["task-a", "task-b"]))
			expect(before[canonicalizePath(project)]).toHaveLength(2)
			expect(runningTasks.get("task-a")).toBe(task)
			expect(task.abortTask).not.toHaveBeenCalled()
			expect(fs.existsSync(project)).toBe(true)
		})
		it("uses the stored workspace identity for case-insensitive rename and reset", () => {
			if (process.platform !== "win32") return
			const project = path.join(tempDir, "CaseSensitiveName")
			fs.mkdirSync(project)
			saveDesktopConfig({ recentWorkspaces: [project] })
			renameProject(project.toUpperCase(), "First")
			renameProject(project.toLowerCase(), "Second")
			expect(Object.keys(loadDesktopConfig().projectNames || {})).toHaveLength(1)
			expect(Object.values(loadDesktopConfig().projectNames || {})).toEqual(["Second"])
			renameProject(project.toUpperCase(), null)
			expect(loadDesktopConfig().projectNames).toEqual({})
		})
		it("deduplicates recentWorkspaces even when added with varied casing on Windows", () => {
			const dir1 = path.join(tempDir, "ProjectA")
			fs.mkdirSync(dir1, { recursive: true })

			// Save ProjectA with uppercase
			saveDesktopConfig({
				lastWorkspacePath: dir1,
				recentWorkspaces: [dir1],
			})

			const config1 = loadDesktopConfig()
			expect(config1.recentWorkspaces).toHaveLength(1)

			// Try adding the same directory with lowercase / trailing slash
			const dir1Variation = process.platform === "win32"
				? dir1.toLowerCase() + "\\"
				: dir1 + "/"

			saveDesktopConfig({
				lastWorkspacePath: dir1Variation,
			})

			const config2 = loadDesktopConfig()
			// Should still have only 1 entry, not 2
			expect(config2.recentWorkspaces).toHaveLength(1)
			expect(arePathsEqual(config2.recentWorkspaces![0]!, dir1)).toBe(true)
		})

		it("allows removing recent workspace without it being re-added by zero-state guard", () => {
			const dir1 = path.join(tempDir, "Proj1")
			const dir2 = path.join(tempDir, "Proj2")
			fs.mkdirSync(dir1, { recursive: true })
			fs.mkdirSync(dir2, { recursive: true })

			saveDesktopConfig({
				lastWorkspacePath: dir1,
				recentWorkspaces: [dir1, dir2],
			})

			// Remove dir1 from recentWorkspaces
			saveDesktopConfig({
				recentWorkspaces: [dir2],
			})

			const updated = loadDesktopConfig()
			expect(updated.recentWorkspaces).toHaveLength(1)
			expect(arePathsEqual(updated.recentWorkspaces![0]!, dir2)).toBe(true)
		})
	})

	describe("4. Multi-Project Runtime Concurrency & Task Preservation", () => {
		it("switching workspace or adding a project does not abort tasks from other projects", async () => {
			const projA = path.join(tempDir, "ProjectA")
			const projB = path.join(tempDir, "ProjectB")
			fs.mkdirSync(projA, { recursive: true })
			fs.mkdirSync(projB, { recursive: true })

			const host = new DesktopAgentHost({
				workspacePath: projA,
				extensionPath: tempDir,
			})

			// Mock provider with runningTasks map
			let taskUnfocusedEmitted = false
			let taskAborted = false

			const mockTaskA = {
				taskId: "task-a-123",
				cwd: projA,
				isStreaming: false,
				isWaitingForFirstChunk: false,
				askResponse: undefined,
				emit: vi.fn((event: string) => {
					if (event === "taskUnfocused") taskUnfocusedEmitted = true
				}),
				abortTask: vi.fn(() => {
					taskAborted = true
				}),
			}

			const runningTasksMap = new Map<string, any>()
			runningTasksMap.set("task-a-123", mockTaskA)

			const mockProvider = {
				runningTasks: runningTasksMap,
				getCurrentTask: () => mockTaskA,
				foregroundTaskId: "task-a-123",
				handleWorkspaceChanged: vi.fn(async (newPath: string) => {
					// ClineProvider logic simulation:
					const currentTask = mockProvider.getCurrentTask()
					if (currentTask && newPath && currentTask.cwd !== newPath) {
						currentTask.emit("taskUnfocused")
						mockProvider.foregroundTaskId = undefined as any
					}
				}),
			}

			host.registerWebviewProvider("mockView", mockProvider)

			// Record terminal log in Project A
			;(host as any).processExtensionMessage({
				type: "terminalSessionStarted",
				id: "term-proj-a",
				command: "npm run dev",
				cwd: projA,
			})

			expect(host.getTerminalLogs()).toHaveLength(1)

			// User adds/switches to Project B
			await host.setWorkspace(projB)

			// Invariant 1: Task A in Project A was NOT aborted
			expect(taskAborted).toBe(false)
			expect(runningTasksMap.has("task-a-123")).toBe(true)

			// Invariant 2: Task A was unfocused from foreground UI
			expect(taskUnfocusedEmitted).toBe(true)
			expect(mockProvider.foregroundTaskId).toBeUndefined()

			// Invariant 3: Project A's terminal logs are saved in host's workspace cache
			expect(host.getTerminalLogs()).toHaveLength(0) // Project B has no logs yet

			// Switching back to Project A restores its terminal logs
			await host.setWorkspace(projA)
			expect(host.getTerminalLogs()).toHaveLength(1)
			expect(host.getTerminalLogs()[0]!.id).toBe("term-proj-a")
		})
	})

	describe("5. Engine Is Not Reloaded on Workspace Changes", () => {
		it("setWorkspace does not re-invoke init() or re-instantiate extensionModule", async () => {
			const projA = path.join(tempDir, "ProjectA")
			const projB = path.join(tempDir, "ProjectB")
			fs.mkdirSync(projA, { recursive: true })
			fs.mkdirSync(projB, { recursive: true })

			const host = new DesktopAgentHost({
				workspacePath: projA,
				extensionPath: tempDir,
			})

			const initSpy = vi.spyOn(host, "init")

			await host.setWorkspace(projB)
			expect(host.getWorkspace()).toBe(projB)
			expect(initSpy).not.toHaveBeenCalled()

			await host.setWorkspace(projA)
			expect(host.getWorkspace()).toBe(projA)
			expect(initSpy).not.toHaveBeenCalled()
		})
	})

	describe("6. Zero-Project State & First Project Addition", () => {
		it("handles zero workspace state and successfully transitions to 1 project", async () => {
			const host = new DesktopAgentHost({
				workspacePath: "",
				extensionPath: tempDir,
			})

			expect(host.getWorkspace()).toBe("")

			const firstProj = path.join(tempDir, "FirstProject")
			fs.mkdirSync(firstProj, { recursive: true })

			await host.setWorkspace(firstProj)
			expect(host.getWorkspace()).toBe(firstProj)

			saveDesktopConfig({
				lastWorkspacePath: firstProj,
				recentWorkspaces: [firstProj],
			})

			const config = loadDesktopConfig()
			expect(config.recentWorkspaces).toHaveLength(1)
			expect(arePathsEqual(config.recentWorkspaces![0]!, firstProj)).toBe(true)
		})
	})

	describe("7. Safe Project Removal from Roo (TDD & Safety Invariants)", () => {
		it("refuses to remove project with running tasks without forceStop", async () => {
			const projPath = path.join(tempDir, "ActiveProject")
			fs.mkdirSync(projPath, { recursive: true })

			const host = new DesktopAgentHost({
				workspacePath: projPath,
				extensionPath: tempDir,
			})

			const runningTask = {
				taskId: "task-running-active",
				cwd: projPath,
				isStreaming: true,
				abortTask: vi.fn(),
			}

			const runningTasksMap = new Map()
			runningTasksMap.set("task-running-active", runningTask)

			const mockProvider = {
				runningTasks: runningTasksMap,
				getCurrentTask: () => runningTask,
				taskHistoryStore: {
					deleteTaskWithId: vi.fn(),
				},
			}
			host.registerWebviewProvider("mockView", mockProvider)

			const result = await host.removeProject(projPath, false)
			expect(result.success).toBe(false)
			expect(result.reason).toBe("requires_force_stop")
			expect(result.runningCount).toBe(1)
			expect(runningTasksMap.has("task-running-active")).toBe(true)
		})

		it("stops running tasks and removes project from Roo when forceStop is true", async () => {
			const projPath = path.join(tempDir, "ActiveProject")
			fs.mkdirSync(projPath, { recursive: true })

			saveDesktopConfig({
				lastWorkspacePath: projPath,
				recentWorkspaces: [projPath],
			})

			const host = new DesktopAgentHost({
				workspacePath: projPath,
				extensionPath: tempDir,
			})

			let aborted = false
			const runningTask = {
				taskId: "task-running-stop",
				cwd: projPath,
				isStreaming: true,
				abortTask: vi.fn(() => {
					aborted = true
				}),
			}

			const runningTasksMap = new Map()
			runningTasksMap.set("task-running-stop", runningTask)

			const mockProvider = {
				runningTasks: runningTasksMap,
				getCurrentTask: () => runningTask,
				cancelTask: vi.fn().mockImplementation(() => {
					runningTasksMap.delete("task-running-stop")
				}),
				taskHistoryStore: {
					deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn(),
			}
			host.registerWebviewProvider("mockView", mockProvider)

			const result = await host.removeProject(projPath, true)
			expect(result.success).toBe(true)
			expect(aborted || mockProvider.cancelTask).toBeTruthy()
			expect(runningTasksMap.has("task-running-stop")).toBe(false)
			expect(host.isTaskDeleted("task-running-stop")).toBe(true)

			const config = loadDesktopConfig()
			expect(config.recentWorkspaces).toHaveLength(0)
		})

		it("multi-project isolation: removing Project A does not affect Project B", async () => {
			const projA = path.join(tempDir, "ProjectA")
			const projB = path.join(tempDir, "ProjectB")
			fs.mkdirSync(projA, { recursive: true })
			fs.mkdirSync(projB, { recursive: true })

			saveDesktopConfig({
				lastWorkspacePath: projA,
				recentWorkspaces: [projA, projB],
			})

			const host = new DesktopAgentHost({
				workspacePath: projA,
				extensionPath: tempDir,
			})

			const taskB = {
				taskId: "task-b",
				cwd: projB,
				isStreaming: true,
				abortTask: vi.fn(),
			}

			const runningTasksMap = new Map()
			runningTasksMap.set("task-b", taskB)

			const mockProvider = {
				runningTasks: runningTasksMap,
				getCurrentTask: () => null,
				taskHistoryStore: {
					deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn(),
			}
			host.registerWebviewProvider("mockView", mockProvider)

			const result = await host.removeProject(projA, false)
			expect(result.success).toBe(true)

			// Project B is still in config and its running task is completely untouched
			const config = loadDesktopConfig()
			expect(config.recentWorkspaces).toHaveLength(1)
			expect(arePathsEqual(config.recentWorkspaces![0]!, projB)).toBe(true)
			expect(runningTasksMap.has("task-b")).toBe(true)
			expect(taskB.abortTask).not.toHaveBeenCalled()
		})

		it("active project removal switches to next workspace or zero-projects state", async () => {
			const proj1 = path.join(tempDir, "Project1")
			const proj2 = path.join(tempDir, "Project2")
			fs.mkdirSync(proj1, { recursive: true })
			fs.mkdirSync(proj2, { recursive: true })

			saveDesktopConfig({
				lastWorkspacePath: proj1,
				recentWorkspaces: [proj1, proj2],
			})

			const host = new DesktopAgentHost({
				workspacePath: proj1,
				extensionPath: tempDir,
			})

			const mockProvider = {
				runningTasks: new Map(),
				getCurrentTask: () => null,
				taskHistoryStore: {
					deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn(),
			}
			host.registerWebviewProvider("mockView", mockProvider)

			// Remove active project (proj1)
			await host.removeProject(proj1, false)

			// Must switch to proj2
			expect(arePathsEqual(host.getWorkspace(), proj2)).toBe(true)
			let config = loadDesktopConfig()
			expect(arePathsEqual(config.lastWorkspacePath!, proj2)).toBe(true)

			// Now remove proj2 as well
			await host.removeProject(proj2, false)
			expect(host.getWorkspace()).toBe("")
			config = loadDesktopConfig()
			expect(config.lastWorkspacePath).toBe("")
			expect(config.recentWorkspaces).toHaveLength(0)
		})

		it("HARD SAFETY SENTINEL TEST: removing project from Roo NEVER deletes workspace directory or files on disk", async () => {
			const myCriticalApp = path.join(tempDir, "MyCriticalApp")
			const sentinelFile = path.join(myCriticalApp, "DO_NOT_DELETE.txt")
			const sourceFile = path.join(myCriticalApp, "src", "app.ts")
			const gitHead = path.join(myCriticalApp, ".git", "HEAD")

			fs.mkdirSync(path.join(myCriticalApp, "src"), { recursive: true })
			fs.mkdirSync(path.join(myCriticalApp, ".git"), { recursive: true })

			const sentinelContent = "USER IMPORTANT DATA - MUST NEVER BE DELETED BY ROO CODE"
			const sourceContent = "console.log('App source code');"
			const gitContent = "ref: refs/heads/main\n"

			fs.writeFileSync(sentinelFile, sentinelContent, "utf-8")
			fs.writeFileSync(sourceFile, sourceContent, "utf-8")
			fs.writeFileSync(gitHead, gitContent, "utf-8")

			saveDesktopConfig({
				lastWorkspacePath: myCriticalApp,
				recentWorkspaces: [myCriticalApp],
			})

			const host = new DesktopAgentHost({
				workspacePath: myCriticalApp,
				extensionPath: tempDir,
			})

			const mockProvider = {
				runningTasks: new Map(),
				getCurrentTask: () => null,
				taskHistoryStore: {
					deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
				},
				postMessageToWebview: vi.fn(),
			}
			host.registerWebviewProvider("mockView", mockProvider)

			// Execute removal of project from Roo Code
			const result = await host.removeProject(myCriticalApp, true)
			expect(result.success).toBe(true)

			// VERIFY: Project was removed from Roo recent workspaces
			const config = loadDesktopConfig()
			expect(config.recentWorkspaces).toHaveLength(0)

			// CRITICAL INVARIANT: The physical directory and every single file MUST REMAIN UNTOUCHED!
			expect(fs.existsSync(myCriticalApp)).toBe(true)
			expect(fs.existsSync(sentinelFile)).toBe(true)
			expect(fs.readFileSync(sentinelFile, "utf-8")).toBe(sentinelContent)

			expect(fs.existsSync(sourceFile)).toBe(true)
			expect(fs.readFileSync(sourceFile, "utf-8")).toBe(sourceContent)

			expect(fs.existsSync(gitHead)).toBe(true)
			expect(fs.readFileSync(gitHead, "utf-8")).toBe(gitContent)
		})
	})

	describe("8. Persistent Drag Reordering & Manual Order Invariants (TDD)", () => {
		it("preserves manual order when switching active project and appends new projects to end", () => {
			const projA = path.join(tempDir, "ProjectA")
			const projB = path.join(tempDir, "ProjectB")
			const projC = path.join(tempDir, "ProjectC")
			const projD = path.join(tempDir, "ProjectD")

			// Initialize manual order: A, B, C
			saveDesktopConfig({
				lastWorkspacePath: projA,
				recentWorkspaces: [projA, projB, projC],
			})

			let config = loadDesktopConfig()
			expect(config.recentWorkspaces?.map(canonicalizePath)).toEqual([projA, projB, projC].map(canonicalizePath))

			// Switching active project to B must NOT shuffle B to index 0
			saveDesktopConfig({
				lastWorkspacePath: projB,
			})

			config = loadDesktopConfig()
			expect(config.recentWorkspaces?.map(canonicalizePath)).toEqual([projA, projB, projC].map(canonicalizePath))
			expect(arePathsEqual(config.lastWorkspacePath!, projB)).toBe(true)

			// Switching active project to C must NOT shuffle C to index 0
			saveDesktopConfig({
				lastWorkspacePath: projC,
			})

			config = loadDesktopConfig()
			expect(config.recentWorkspaces?.map(canonicalizePath)).toEqual([projA, projB, projC].map(canonicalizePath))

			// Opening a brand new project D must append it to the end without shuffling existing
			saveDesktopConfig({
				lastWorkspacePath: projD,
			})

			config = loadDesktopConfig()
			expect(config.recentWorkspaces?.map(canonicalizePath)).toEqual([projA, projB, projC, projD].map(canonicalizePath))

			// Explicit manual reorder [C, A, B, D] must be persisted as-is
			saveDesktopConfig({
				recentWorkspaces: [projC, projA, projB, projD],
			})

			config = loadDesktopConfig()
			expect(config.recentWorkspaces?.map(canonicalizePath)).toEqual([projC, projA, projB, projD].map(canonicalizePath))
		})

		it("verifies drag handle, ephemeral reorder mode, and drop indicators in renderer and styles", () => {
			const appJsPath = path.resolve(__dirname, "../../src/renderer/app.js")
			const stylesPath = path.resolve(__dirname, "../../src/renderer/styles.css")

			const appJs = fs.readFileSync(appJsPath, "utf-8")
			const styles = fs.readFileSync(stylesPath, "utf-8")

			// Dedicated drag handle exists with draggable attribute
			expect(appJs).toContain("project-drag-handle")
			expect(appJs).toContain('draggable="true"')
			expect(appJs).toContain('data-action="drag-project"')

			// Drag events wired
			expect(appJs).toContain('addEventListener("dragstart"')
			expect(appJs).toContain('addEventListener("dragover"')
			expect(appJs).toContain('addEventListener("drop"')
			expect(appJs).toContain('reorderWorkspaces')

			// Ephemeral reorder mode hides chats during reorder
			expect(styles).toContain("#sidebar-projects-list.reorder-mode .project-chats-list")
			expect(styles).toContain("display: none !important")

			// Precise drop indicators exist
			expect(styles).toContain(".sidebar-project-item.drop-before::before")
			expect(styles).toContain(".sidebar-project-item.drop-after::after")
			expect(styles).toContain(".project-drag-handle")
		})
	})
})
