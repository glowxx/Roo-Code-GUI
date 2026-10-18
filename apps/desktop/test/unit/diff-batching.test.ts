import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import path from "path"
import fs from "fs"
import os from "os"

vi.mock("child_process", async () => {
	const actual = await vi.importActual<typeof import("child_process")>("child_process")
	return {
		...actual,
		default: {
			...actual,
			execSync: vi.fn(),
		},
		execSync: vi.fn(),
	}
})

import * as child_process from "child_process"
import { DesktopAgentHost } from "../../src/main/agent-host.js"

describe("Diff Batching & Lazy Loading (TDD)", () => {
	let tempDir: string
	let host: DesktopAgentHost

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-diff-test-"))
		host = new DesktopAgentHost({
			workspacePath: tempDir,
			extensionPath: tempDir,
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		try {
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {}
	})

	it("refreshDiffsFromGit executes batch git commands instead of per-file git show and readFileSync", () => {
		const readFileSyncSpy = vi.spyOn(fs, "readFileSync")

		const mockedExec = vi.mocked(child_process.execSync)
		mockedExec.mockImplementation(((cmd: any) => {
			const command = String(cmd)
			if (command.includes(" status --porcelain")) {
				return " M file1.ts\n M file2.ts\n?? file3.ts\n"
			}
			if (command.includes(" diff --numstat")) {
				return "10\t2\tfile1.ts\n5\t1\tfile2.ts\n"
			}
			return ""
		}) as any)

		host.refreshDiffsFromGit()
		expect(host.getNavigationCounts().diffCount).toBe(3)

		const diffs = host.getDiffFiles()
		expect(diffs).toHaveLength(3)

		// Verify file1 has additions and deletions from numstat
		const file1 = diffs.find((d) => d.filePath === "file1.ts")
		expect(file1).toBeDefined()
		expect(file1?.additions).toBe(10)
		expect(file1?.deletions).toBe(2)
		expect(file1?.status).toBe("modified")

		// Verify file3 (untracked) is recognized as added
		const file3 = diffs.find((d) => d.filePath === "file3.ts")
		expect(file3).toBeDefined()
		expect(file3?.status).toBe("added")

		// Invariant: MUST NOT call git show HEAD for each file during manifest refresh
		const gitShowCalls = mockedExec.mock.calls.filter((call) =>
			String(call[0]).includes("git show HEAD:")
		)
		expect(gitShowCalls).toHaveLength(0)

		// Invariant: MUST NOT read file contents into memory during manifest refresh
		expect(readFileSyncSpy).not.toHaveBeenCalled()
		// A manifest reset publishes removal immediately, without opening the panel.
		const changed = vi.fn()
		host.on("navigationCountsUpdated", changed)
		mockedExec.mockReturnValue("")
		host.refreshDiffsFromGit()
		expect(changed.mock.lastCall?.[0].diffCount).toBe(0)
	})

	it("intercepts tool file modifications from ask: 'tool' messages", () => {
		const emitSpy = vi.spyOn(host, "emit")

		// Simulate core engine sending ask: "tool" message for write_to_file
		const askToolMsg = {
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "write_to_file",
				path: "src/newFile.ts",
				content: "console.log('hello')",
			}),
		}

		;(host as any).processExtensionMessage(askToolMsg)

		const diffs = host.getDiffFiles()
		const created = diffs.find((d) => d.filePath === "src/newFile.ts")
		expect(created).toBeDefined()
		expect(created?.status).toBe("added")

		// Verify diffsUpdated was emitted
		expect(emitSpy).toHaveBeenCalledWith("diffsUpdated", expect.any(Array))
	})
})
