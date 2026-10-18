import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DesktopAgentHost } from "../../src/main/agent-host.js"
import { saveDesktopConfig, loadDesktopConfig, arePathsEqual } from "../../src/main/config.js"

describe("reassociating moved projects", () => {
	let folder: string
	let appdata: string | undefined
	beforeEach(() => {
		folder = fs.mkdtempSync(path.join(os.tmpdir(), "roo-relocate-"))
		appdata = process.env.APPDATA
		process.env.APPDATA = folder
	})
	afterEach(() => {
		if (appdata === undefined) delete process.env.APPDATA
		else process.env.APPDATA = appdata
		fs.rmSync(folder, { recursive: true, force: true })
	})
	function setup() {
		const old = path.join(folder, "old")
		const next = path.join(folder, "new")
		fs.mkdirSync(next)
		fs.writeFileSync(path.join(next, "sentinel.txt"), "user file")
		saveDesktopConfig({ lastWorkspacePath: old, recentWorkspaces: [old], projectNames: { [old]: "Mój projekt" } })
		const host = new DesktopAgentHost({ workspacePath: old, extensionPath: folder })
		const items = [
			{ id: "one", workspace: old },
			{ id: "other", workspace: folder },
		]
		const store = {
			getAll: () => items,
			upsert: vi.fn(async (item: any) => {
				items[items.findIndex((value) => value.id === item.id)] = item
			}),
		}
		host.registerWebviewProvider("test", {
			taskHistoryStore: store,
			runningTasks: new Map(),
			getCurrentTask: () => null,
			postMessageToWebview: vi.fn(),
		})
		return { host, old, next, items, store }
	}
	it("retains conversation IDs, project name and files when the old directory is absent", async () => {
		const { host, old, next, items } = setup()
		await host.relocateProject(old, next)
		expect(items[0]?.id).toBe("one")
		expect(arePathsEqual(items[0]!.workspace, next)).toBe(true)
		expect(items[1]!.workspace).toBe(folder)
		expect(arePathsEqual(host.getWorkspace(), next)).toBe(true)
		expect(loadDesktopConfig().projectNames?.[next]).toBe("Mój projekt")
		expect(fs.readFileSync(path.join(next, "sentinel.txt"), "utf8")).toBe("user file")
	})
	it("does not reassociate history when either project has an active task", async () => {
		const { host, old, next, items, store } = setup()
		vi.spyOn(host, "getRunningTasksForWorkspace").mockImplementation((value) =>
			arePathsEqual(value, old) ? ["one"] : [],
		)
		await expect(host.relocateProject(old, next)).rejects.toThrow(/Zatrzymaj/)
		expect(store.upsert).not.toHaveBeenCalled()
		expect(items[0]!.workspace).toBe(old)
	})
	it("keeps the original location on failed persistence", async () => {
		const { host, old, next, store } = setup()
		store.upsert.mockRejectedValueOnce(new Error("disk"))
		await expect(host.relocateProject(old, next)).rejects.toThrow("disk")
		expect(loadDesktopConfig().lastWorkspacePath).toBe(old)
	})
})
