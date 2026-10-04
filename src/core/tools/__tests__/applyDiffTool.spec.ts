import * as path from "path"
import fs from "fs/promises"
import type { MockedFunction } from "vitest"

import { fileExistsAtPath } from "../../../utils/fs"
import { isPathOutsideWorkspace } from "../../../utils/pathUtils"
import { getReadablePath } from "../../../utils/path"
import { ToolUse, ToolResponse } from "../../../shared/tools"
import { ApplyDiffTool, applyDiffTool } from "../ApplyDiffTool"

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

describe("ApplyDiffTool", () => {
	const testFilePath = "test/file.txt"
	const absoluteFilePath = process.platform === "win32" ? "C:\\test\\file.txt" : "/test/file.txt"
	const testFileContent = "Line 1\nLine 2\nLine 3\nLine 4"

	const mockedFileExistsAtPath = fileExistsAtPath as MockedFunction<typeof fileExistsAtPath>
	const mockedFsReadFile = fs.readFile as unknown as MockedFunction<
		(path: string, encoding: string) => Promise<string>
	>
	const mockedPathResolve = path.resolve as MockedFunction<typeof path.resolve>

	const mockTask: any = {}
	let mockAskApproval: ReturnType<typeof vi.fn>
	let mockHandleError: ReturnType<typeof vi.fn>
	let mockPushToolResult: ReturnType<typeof vi.fn>
	let toolResult: ToolResponse | undefined

	beforeEach(() => {
		vi.clearAllMocks()

		mockedPathResolve.mockReturnValue(absoluteFilePath)
		mockedFileExistsAtPath.mockResolvedValue(true)
		mockedFsReadFile.mockResolvedValue(testFileContent)

		mockTask.cwd = "/"
		mockTask.consecutiveMistakeCount = 0
		mockTask.consecutiveMistakeCountForApplyDiff = new Map()
		mockTask.failedDiffHashesForPath = new Map()
		mockTask.didEditFile = false
		mockTask.api = {
			getModel: () => ({ id: "gpt-4o" }),
		}
		mockTask.providerRef = {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: true,
					writeDelayMs: 1000,
					experiments: {},
				}),
			}),
		}
		mockTask.rooIgnoreController = {
			validateAccess: vi.fn().mockReturnValue(true),
		}
		mockTask.rooProtectedController = {
			isWriteProtected: vi.fn().mockReturnValue(false),
		}
		mockTask.diffViewProvider = {
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
		}
		mockTask.diffStrategy = {
			applyDiff: vi.fn().mockResolvedValue({
				success: true,
				content: "Modified content",
			}),
		}
		mockTask.fileContextTracker = {
			trackFileContext: vi.fn().mockResolvedValue(undefined),
		}
		mockTask.say = vi.fn().mockResolvedValue(undefined)
		mockTask.ask = vi.fn().mockResolvedValue(undefined)
		mockTask.recordToolError = vi.fn()
		mockTask.recordToolUsage = vi.fn()
		mockTask.processQueuedMessages = vi.fn()

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		toolResult = undefined
		mockPushToolResult = vi.fn((result: ToolResponse) => {
			toolResult = result
		})
	})

	const executeApplyDiff = async (params: { path?: string; diff?: string } = {}) => {
		const defaultDiff = `<<<<<<< SEARCH\n:start_line:2\n-------\nLine 2\n=======\nLine Two\n>>>>>>> REPLACE`
		const toolArgs = {
			path: params.path ?? testFilePath,
			diff: params.diff ?? defaultDiff,
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

	it("successfully applies diff and resets mistake counts and failedDiffHashes", async () => {
		mockTask.failedDiffHashesForPath.set(testFilePath, new Set(["some-old-hash"]))
		mockTask.consecutiveMistakeCount = 1

		const result = await executeApplyDiff()

		expect(result).toContain("Diff applied successfully")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.failedDiffHashesForPath.has(testFilePath)).toBe(false)
		expect(mockTask.diffStrategy.applyDiff).toHaveBeenCalledWith(
			testFileContent,
			expect.any(String),
			2,
		)
	})

	it("correctly extracts :start_line: with trailing colon (:start_line:62:)", async () => {
		const diffWithTrailingColon = `<<<<<<< SEARCH\n:start_line:62:\n-------\nLine 2\n=======\nLine Two\n>>>>>>> REPLACE`

		await executeApplyDiff({ diff: diffWithTrailingColon })

		expect(mockTask.diffStrategy.applyDiff).toHaveBeenCalledWith(
			testFileContent,
			expect.any(String),
			62,
		)
	})

	it("detects and blocks duplicate failed patch retry with actionable guidance", async () => {
		const failingDiff = `<<<<<<< SEARCH\n:start_line:10\n-------\nNonExistent\n=======\nReplacement\n>>>>>>> REPLACE`
		mockTask.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: false,
			error: "No match found",
		})

		// First failure: provides recovery context without burning global mistake count
		const result1 = await executeApplyDiff({ diff: failingDiff })
		expect(result1).toContain("No match found")
		expect(result1).toContain("<edit_recovery_context>")
		expect(mockTask.diffStrategy.applyDiff).toHaveBeenCalledTimes(1)
		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.failedDiffHashesForPath.get(testFilePath)?.has(failingDiff.trim())).toBe(true)

		// Resubmitting the exact same failed diff triggers identical retry detection and escalates
		const result2 = await executeApplyDiff({ diff: failingDiff })
		expect(result2).toContain("IDENTICAL FAILED PATCH RETRY")
		expect(result2).toContain("You submitted the exact same diff that previously failed")
		// diffStrategy.applyDiff should NOT have been invoked a second time
		expect(mockTask.diffStrategy.applyDiff).toHaveBeenCalledTimes(1)
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.say).toHaveBeenCalledWith("diff_error", expect.stringContaining("IDENTICAL FAILED PATCH RETRY"))
	})

	it("aggregates failure details across multiple failed blocks in failParts", async () => {
		const multiBlockDiff = `<<<<<<< SEARCH\n:start_line:1\n-------\nBlock 1\n=======\nNew 1\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n:start_line:3\n-------\nBlock 2\n=======\nNew 2\n>>>>>>> REPLACE`
		mockTask.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: false,
			failParts: [
				{ success: false, error: "Block 1 could not be matched" },
				{ success: false, error: "Block 2 line count mismatch", details: { line: 3 } },
			],
		})

		const result = await executeApplyDiff({ diff: multiBlockDiff })

		expect(result).toContain("[Block 1 Failure]:\nBlock 1 could not be matched")
		expect(result).toContain("[Block 2 Failure]:\nBlock 2 line count mismatch")
		expect(result).toContain('"line": 3')
		expect(result).toContain("<edit_recovery_context>")
		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("enforces bounded recovery: consecutive different failing diffs escalate to mistakeLimit", async () => {
		mockTask.consecutiveMistakeLimit = 3
		mockTask.diffStrategy.applyDiff.mockResolvedValue({
			success: false,
			error: "Diff mismatch",
		})

		const diff1 = `<<<<<<< SEARCH\n:start_line:1\n-------\nAttempt 1\n=======\nFix 1\n>>>>>>> REPLACE`
		const diff2 = `<<<<<<< SEARCH\n:start_line:1\n-------\nAttempt 2\n=======\nFix 2\n>>>>>>> REPLACE`
		const diff3 = `<<<<<<< SEARCH\n:start_line:1\n-------\nAttempt 3\n=======\nFix 3\n>>>>>>> REPLACE`

		// Attempt 1: provides recovery context without burning global mistake count
		await executeApplyDiff({ diff: diff1 })
		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get(testFilePath)).toBe(1)

		// Attempt 2: recovery attempts exhausted (MAX_EDIT_RECOVERY_ATTEMPTS = 2), escalates
		await executeApplyDiff({ diff: diff2 })
		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get(testFilePath)).toBe(2)
		expect(mockTask.didToolFailInCurrentTurn).toBe(true)

		// Attempt 3: continues escalation towards mistake limit
		await executeApplyDiff({ diff: diff3 })
		expect(mockTask.consecutiveMistakeCount).toBe(3)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get(testFilePath)).toBe(3)
	})

	it("isolates failure counts per file: errors on File A do not poison File B", async () => {
		mockTask.diffStrategy.applyDiff.mockResolvedValue({
			success: false,
			error: "Diff mismatch",
		})

		const fileADiff = `<<<<<<< SEARCH\n:start_line:1\n-------\nLine A\n=======\nNew A\n>>>>>>> REPLACE`
		const fileBDiff = `<<<<<<< SEARCH\n:start_line:1\n-------\nLine B\n=======\nNew B\n>>>>>>> REPLACE`

		// Failing diff on file A (testFilePath = "test/file.ts")
		await executeApplyDiff({ path: "fileA.ts", diff: fileADiff })
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileA.ts")).toBe(1)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileB.ts")).toBeUndefined()

		// Failing diff on file B
		await executeApplyDiff({ path: "fileB.ts", diff: fileBDiff })
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileA.ts")).toBe(1)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("fileB.ts")).toBe(1)
	})

	it("resets failure budget and cached hashes for target file upon successful mutation", async () => {
		mockTask.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: false,
			error: "Diff mismatch",
		})

		const failingDiff = `<<<<<<< SEARCH\n:start_line:1\n-------\nOld line\n=======\nBad line\n>>>>>>> REPLACE`
		await executeApplyDiff({ path: "target.ts", diff: failingDiff })
		expect(mockTask.consecutiveMistakeCountForApplyDiff.get("target.ts")).toBe(1)
		expect(mockTask.failedDiffHashesForPath.get("target.ts")?.has(failingDiff.trim())).toBe(true)

		// Now succeed
		mockTask.diffStrategy.applyDiff.mockResolvedValueOnce({
			success: true,
			content: "Successful content",
		})
		const successDiff = `<<<<<<< SEARCH\n:start_line:1\n-------\nActual old\n=======\nGood new\n>>>>>>> REPLACE`
		await executeApplyDiff({ path: "target.ts", diff: successDiff })

		expect(mockTask.consecutiveMistakeCount).toBe(0)
		expect(mockTask.consecutiveMistakeCountForApplyDiff.has("target.ts")).toBe(false)
		expect(mockTask.failedDiffHashesForPath.has("target.ts")).toBe(false)
	})
})
