import * as path from "path"
import fs from "fs/promises"
import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import { ApplyDiffTool, applyDiffTool } from "../ApplyDiffTool"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import {
	classifyEditFailure,
	isRecoverableEditFailure,
	EditFailureKind,
	computeFileHash,
	normalizeTaskFilePath,
	extractSurroundingSlice,
	buildRecoveryFeedback,
} from "../edit-recovery/EditRecoveryService"

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue(""),
	},
}))

vi.mock("path", async () => {
	const originalPath = await vi.importActual("path")
	return {
		...originalPath,
		resolve: vi.fn().mockImplementation((...args) => {
			const separator = process.platform === "win32" ? "\\" : "/"
			return args.join(separator)
		}),
		isAbsolute: vi.fn().mockReturnValue(false),
		relative: vi.fn().mockImplementation((_from, to) => to),
	}
})

vi.mock("delay", () => ({
	default: vi.fn(),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../../utils/pathUtils", () => ({
	isPathOutsideWorkspace: vi.fn().mockReturnValue(false),
}))

vi.mock("../../../utils/path", () => ({
	getReadablePath: vi.fn().mockReturnValue("test/path.txt"),
}))

vi.mock("../../diff/stats", () => ({
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
}))

vi.mock("vscode", () => ({
	window: {
		showWarningMessage: vi.fn().mockResolvedValue(undefined),
	},
	env: {
		openExternal: vi.fn(),
	},
	Uri: {
		parse: vi.fn(),
	},
}))

describe("Phase 21: Comprehensive Edit Recovery Matrix & Phase 22 Real Replays", () => {
	const testFilePath = "src/index.ts"
	const absoluteFilePath = process.platform === "win32" ? "C:\\workspace\\src\\index.ts" : "/workspace/src/index.ts"
	const baseFileContent = `import React from 'react'

export function App() {
  const [count, setCount] = useState(0)

  return (
    <div>
      <h1>Counter</h1>
      <p>{count}</p>
    </div>
  )
}`

	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedFsReadFile = fs.readFile as unknown as MockedFunction<
		(path: string, encoding: string) => Promise<string>
	>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>

	let mockTask: any
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedFsReadFile.mockResolvedValue(baseFileContent)

		mockTask = {
			cwd: "/workspace",
			consecutiveMistakeCount: 0,
			consecutiveMistakeLimit: 3,
			consecutiveMistakeCountForApplyDiff: new Map(),
			consecutiveMistakeCountForEditFile: new Map(),
			failedDiffHashesForPath: new Map(),
			trackedFileVersions: new Map(),
			didToolFailInCurrentTurn: false,
			api: {
				getModel: () => ({ id: "gpt-4o" }),
			},
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						diagnosticsEnabled: true,
						writeDelayMs: 1000,
						experiments: {},
					}),
				}),
			},
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			},
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			},
			diffViewProvider: {
				editType: undefined,
				isEditing: false,
				originalContent: "",
				open: vi.fn().mockResolvedValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				reset: vi.fn().mockResolvedValue(undefined),
				revertChanges: vi.fn().mockResolvedValue(undefined),
				saveChanges: vi.fn().mockResolvedValue({
					newProblemsMessage: "",
					userEdits: null,
					finalContent: "final content",
				}),
				saveDirectly: vi.fn().mockResolvedValue(undefined),
				scrollToFirstDiff: vi.fn(),
				pushToolWriteResult: vi.fn().mockResolvedValue("Diff applied successfully"),
			},
			diffStrategy: new MultiSearchReplaceDiffStrategy(),
			fileContextTracker: {
				trackFileContext: vi.fn().mockResolvedValue(undefined),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			processQueuedMessages: vi.fn(),
			recordFileReadVersion: function (relPath: string, content: string) {
				const normalized = normalizeTaskFilePath(relPath)
				const lines = content.split(/\r?\n/)
				this.trackedFileVersions.set(normalized, {
					hash: computeFileHash(content),
					lineCount: lines.length,
					timestamp: Date.now(),
				})
			},
			getFileTrackedVersion: function (relPath: string) {
				const normalized = normalizeTaskFilePath(relPath)
				return this.trackedFileVersions.get(normalized)
			},
			clearEditFailureState: function (relPath?: string) {
				if (relPath) {
					const normalized = normalizeTaskFilePath(relPath)
					this.consecutiveMistakeCountForApplyDiff.delete(normalized)
					this.consecutiveMistakeCountForApplyDiff.delete(relPath)
					this.consecutiveMistakeCountForEditFile.delete(normalized)
					this.consecutiveMistakeCountForEditFile.delete(relPath)
					this.failedDiffHashesForPath?.delete(normalized)
					this.failedDiffHashesForPath?.delete(relPath)
				} else {
					this.consecutiveMistakeCount = 0
					this.consecutiveMistakeCountForApplyDiff.clear()
					this.consecutiveMistakeCountForEditFile.clear()
					this.failedDiffHashesForPath?.clear()
				}
			},
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		toolResult = undefined
		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})
	})

	const executeApplyDiff = async (params: { path?: string; diff: string }) => {
		const toolArgs = {
			path: params.path ?? testFilePath,
			diff: params.diff,
		}
		const toolUse: ToolUse<"apply_diff"> = {
			type: "tool_use",
			name: "apply_diff",
			params: toolArgs,
			nativeArgs: toolArgs as any,
			partial: false,
		}

		await applyDiffTool.handle(mockTask, toolUse, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		return toolResult
	}

	// 1. Exact match patch -> success -> reset mistake count
	it("Case 1: Exact match patch -> success -> reset mistake count", async () => {
		mockTask.consecutiveMistakeCount = 2
		const exactDiff = `<<<<<<< SEARCH
:start_line:8
-------
      <h1>Counter</h1>
=======
      <h1>Updated Counter</h1>
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: exactDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 2. Minor whitespace drift -> success -> reset mistake count
	it("Case 2: Minor whitespace drift -> success -> reset mistake count", async () => {
		mockTask.consecutiveMistakeCount = 1
		const whitespaceDriftDiff = `<<<<<<< SEARCH
:start_line:8
-------
      <h1>Counter</h1>   
=======
      <h1>New Counter</h1>
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: whitespaceDriftDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 3. CRLF target file + LF patch -> success
	it("Case 3: CRLF target file + LF patch -> success", async () => {
		const crlfContent = baseFileContent.replace(/\n/g, "\r\n")
		mockedFsReadFile.mockResolvedValue(crlfContent)

		const lfDiff = `<<<<<<< SEARCH
:start_line:4
-------
  const [count, setCount] = useState(0)
=======
  const [count, setCount] = useState(10)
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: lfDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 4. LF target file + CRLF patch -> success
	it("Case 4: LF target file + CRLF patch -> success", async () => {
		mockedFsReadFile.mockResolvedValue(baseFileContent)

		const crlfDiff = `<<<<<<< SEARCH\r
:start_line:4\r
-------\r
  const [count, setCount] = useState(0)\r
=======\r
  const [count, setCount] = useState(42)\r
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: crlfDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 5. Re-read on stale file -> updated patch -> success
	it("Case 5: OCC detected stale base -> autonomous recovery feedback -> updated patch succeeds", async () => {
		// Initial read was recorded with old version
		mockTask.recordFileReadVersion(testFilePath, "old content that got modified")

		// Disk now has baseFileContent
		mockedFsReadFile.mockResolvedValue(baseFileContent)

		// Model tries diff based on stale belief
		const staleDiff = `<<<<<<< SEARCH
:start_line:1
-------
non existent old line
=======
new replacement
>>>>>>> REPLACE`

		const result1 = await executeApplyDiff({ diff: staleDiff })
		expect(result1).toContain("<edit_recovery_context>")
		expect(result1).toContain("[FILE CONFLICT]: The file content on disk has changed")
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		// Model submits updated patch using fresh context
		const updatedDiff = `<<<<<<< SEARCH
:start_line:8
-------
      <h1>Counter</h1>
=======
      <h1>Refreshed Counter</h1>
>>>>>>> REPLACE`

		const result2 = await executeApplyDiff({ diff: updatedDiff })
		expect(result2).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 6. Leaked :start_line: marker in search block -> sanitized or autonomous recovery -> success
	it("Case 6: Leaked :start_line: marker inside search block -> sanitized automatically -> success", async () => {
		const leakedStartLineDiff = `<<<<<<< SEARCH
:start_line:8
-------
:start_line:8
      <h1>Counter</h1>
=======
      <h1>Clean Counter</h1>
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: leakedStartLineDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 7. Leaked ------- separator in search block -> sanitized or autonomous recovery -> success
	it("Case 7: Leaked ------- separator in search block -> sanitized automatically -> success", async () => {
		const leakedSeparatorDiff = `<<<<<<< SEARCH
:start_line:8
-------
-------
      <h1>Counter</h1>
=======
      <h1>Separated Counter</h1>
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: leakedSeparatorDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 8. Similarity 99% (single line whitespace difference) -> recovery -> success
	it("Case 8: Similarity 99% mismatch provides rich recovery context without burning budget", async () => {
		const nearMatchDiff = `<<<<<<< SEARCH
:start_line:3
-------
export function App() {
  const [count, setCount] = useState(999999999)
=======
export function App() {
  const [count, setCount] = useState(1)
>>>>>>> REPLACE`

		const result1 = await executeApplyDiff({ diff: nearMatchDiff })
		expect(result1).toContain("<edit_recovery_context>")
		expect(result1).toContain("Current on-disk section")
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		// Recompute patch with exact on-disk line
		const correctDiff = `<<<<<<< SEARCH
:start_line:3
-------
export function App() {
  const [count, setCount] = useState(0)
=======
export function App() {
  const [count, setCount] = useState(1)
>>>>>>> REPLACE`

		const result2 = await executeApplyDiff({ diff: correctDiff })
		expect(result2).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 9. Identical failed patch retried twice -> blocked immediately with guidance
	it("Case 9: Identical failed patch retried twice -> blocked immediately with guidance", async () => {
		const failingDiff = `<<<<<<< SEARCH
:start_line:1
-------
NonExistentFunction()
=======
FixedFunction()
>>>>>>> REPLACE`

		const result1 = await executeApplyDiff({ diff: failingDiff })
		expect(result1).toContain("<edit_recovery_context>")
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		// Resubmit identical failed diff
		const result2 = await executeApplyDiff({ diff: failingDiff })
		expect(result2).toContain("IDENTICAL FAILED PATCH RETRY")
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.stringContaining("IDENTICAL FAILED PATCH RETRY"))
	})

	// 10. Different patch retried -> allowed
	it("Case 10: Different patch retried -> allowed without identical retry block", async () => {
		const failDiff1 = `<<<<<<< SEARCH
:start_line:1
-------
Mismatch1
=======
Fix1
>>>>>>> REPLACE`

		const failDiff2 = `<<<<<<< SEARCH
:start_line:1
-------
Mismatch2
=======
Fix2
>>>>>>> REPLACE`

		await executeApplyDiff({ diff: failDiff1 })
		const result2 = await executeApplyDiff({ diff: failDiff2 })

		// Should not be blocked as identical retry
		expect(result2).not.toContain("IDENTICAL FAILED PATCH RETRY")
	})

	// 11. Bounded recovery exhausted (2-3 failures) -> escalation
	it("Case 11: Bounded recovery exhausted -> escalates to consecutiveMistakeCount and diff_error", async () => {
		const fail1 = `<<<<<<< SEARCH\n:start_line:1\n-------\nDiff 1\n=======\nRep 1\n>>>>>>> REPLACE`
		const fail2 = `<<<<<<< SEARCH\n:start_line:1\n-------\nDiff 2\n=======\nRep 2\n>>>>>>> REPLACE`

		await executeApplyDiff({ diff: fail1 })
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		await executeApplyDiff({ diff: fail2 })
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.any(String))
	})

	// 12. Mistake count NOT incremented on recoverable attempt #1
	it("Case 12: Mistake count NOT incremented on recoverable attempt #1", async () => {
		const diff = `<<<<<<< SEARCH\n:start_line:2\n-------\nWrong Search\n=======\nReplace\n>>>>>>> REPLACE`
		await executeApplyDiff({ diff })
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// 13. Mistake count incremented on unrecoverable syntax error
	it("Case 13: Mistake count incremented on unrecoverable syntax error", async () => {
		const malformedDiff = `<<<<<<< SEARCH\nmalformed without separator`
		const result = await executeApplyDiff({ diff: malformedDiff })
		expect(result).toContain("Unexpected end of sequence")
		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	// 14. Mistake count incremented on identical retry
	it("Case 14: Mistake count incremented on identical retry", async () => {
		const diff = `<<<<<<< SEARCH\n:start_line:1\n-------\nWrong\n=======\nRight\n>>>>>>> REPLACE`
		await executeApplyDiff({ diff })
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		await executeApplyDiff({ diff })
		expect(mockTask.consecutiveMistakeCount).toBe(1)
	})

	// 15. diff_error NOT emitted on recoverable attempt #1
	it("Case 15: diff_error NOT emitted on recoverable attempt #1", async () => {
		const diff = `<<<<<<< SEARCH\n:start_line:1\n-------\nWrong\n=======\nRight\n>>>>>>> REPLACE`
		await executeApplyDiff({ diff })
		expect(mockTask.say).not.toHaveBeenCalledWith("diff_error", expect.any(String))
	})

	// 16. diff_error emitted on attempt #2
	it("Case 16: diff_error emitted on attempt #2", async () => {
		const diff1 = `<<<<<<< SEARCH\n:start_line:1\n-------\nWrong1\n=======\nRight1\n>>>>>>> REPLACE`
		const diff2 = `<<<<<<< SEARCH\n:start_line:1\n-------\nWrong2\n=======\nRight2\n>>>>>>> REPLACE`
		await executeApplyDiff({ diff: diff1 })
		await executeApplyDiff({ diff: diff2 })
		expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.any(String))
	})

	// 17. mistake_limit_reached triggered ONLY after bounded exhaustion
	it("Case 17: mistake_limit_reached triggered ONLY after bounded exhaustion reaches limit", async () => {
		mockTask.consecutiveMistakeLimit = 3
		const d1 = `<<<<<<< SEARCH\n:start_line:1\n-------\nErr1\n=======\nFix1\n>>>>>>> REPLACE`
		const d2 = `<<<<<<< SEARCH\n:start_line:1\n-------\nErr2\n=======\nFix2\n>>>>>>> REPLACE`
		const d3 = `<<<<<<< SEARCH\n:start_line:1\n-------\nErr3\n=======\nFix3\n>>>>>>> REPLACE`

		await executeApplyDiff({ diff: d1 })
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		await executeApplyDiff({ diff: d2 })
		expect(mockTask.consecutiveMistakeCount).toBe(1)

		await executeApplyDiff({ diff: d3 })
		expect(mockTask.consecutiveMistakeCount).toBe(3)
		expect(mockTask.consecutiveMistakeCount).toBeGreaterThanOrEqual(mockTask.consecutiveMistakeLimit)
	})

	// 18. Edit failure on File A does not pollute File B
	it("Case 18: Edit failure on File A does not pollute File B", async () => {
		const diffA = `<<<<<<< SEARCH\n:start_line:1\n-------\nMissing A\n=======\nFix A\n>>>>>>> REPLACE`
		const diffB = `<<<<<<< SEARCH\n:start_line:1\n-------\nMissing B\n=======\nFix B\n>>>>>>> REPLACE`

		await executeApplyDiff({ path: "fileA.ts", diff: diffA })
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileA.ts")).toBe(1)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileB.ts")).toBeUndefined()

		await executeApplyDiff({ path: "fileB.ts", diff: diffB })
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileB.ts")).toBe(1)
	})

	// Phase 22 Replay 1: Real Forensics Incident (99% similarity failure due to leaked marker / minor whitespace)
	it("Phase 22 Replay 1: Forensics 99% similarity mismatch with leaked :start_line: marker recovers autonomously", async () => {
		// Model submitted diff with leaked :start_line: and dashed separator at top of search block
		const forensicIncidentDiff = `<<<<<<< SEARCH
:start_line:6
-------
:start_line:6
-------
    <div>
      <h1>Counter</h1>
      <p>{count}</p>
    </div>
=======
    <div>
      <h1>Cleaned Counter</h1>
      <p>{count}</p>
    </div>
>>>>>>> REPLACE`

		const result = await executeApplyDiff({ diff: forensicIncidentDiff })
		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	// Phase 22 Replay 2: Real Forensics Incident (stale file between read and edit)
	it("Phase 22 Replay 2: Forensics stale file conflict returns fresh on-disk slice enabling clean recovery", async () => {
		// Task recorded reading file revision v1
		mockTask.recordFileReadVersion("app.ts", "const PORT = 3000;\nconst HOST = 'localhost';\n")

		// Disk was updated externally or by formatter to revision v2
		const v2Content = "const PORT = 8080;\nconst HOST = '0.0.0.0';\nconst DEBUG = true;\n"
		mockedFsReadFile.mockResolvedValue(v2Content)

		// Model attempts to edit assuming revision v1
		const staleDiff = `<<<<<<< SEARCH
:start_line:1
-------
const PORT = 3000;
const HOST = 'localhost';
=======
const PORT = 4000;
const HOST = 'localhost';
>>>>>>> REPLACE`

		const result1 = await executeApplyDiff({ path: "app.ts", diff: staleDiff })
		expect(result1).toContain("<edit_recovery_context>")
		expect(result1).toContain("[FILE CONFLICT]")
		expect(result1).toContain("current revision:")
		expect(result1).toContain("const PORT = 8080;")
		expect(mockTask.consecutiveMistakeCount).toBe(0)

		// Model regenerates patch against fresh disk content
		const recoveredDiff = `<<<<<<< SEARCH
:start_line:1
-------
const PORT = 8080;
=======
const PORT = 4000;
>>>>>>> REPLACE`

		const result2 = await executeApplyDiff({ path: "app.ts", diff: recoveredDiff })
		expect(result2).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})
})
