import path from "path"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { getReadablePath } from "../../utils/path"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import {
	classifyEditFailure,
	isRecoverableEditFailure,
	buildRecoveryFeedback,
	computeFileHash,
	normalizeTaskFilePath,
	MAX_EDIT_RECOVERY_ATTEMPTS,
	logEditRecoveryTelemetry,
	EditFailureKind,
} from "./edit-recovery/EditRecoveryService"

interface ApplyDiffParams {
	path: string
	diff: string
}

export class ApplyDiffTool extends BaseTool<"apply_diff"> {
	readonly name = "apply_diff" as const

	async execute(params: ApplyDiffParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		let { path: relPath, diff: diffContent } = params

		if (diffContent && !task.api.getModel().id.includes("claude")) {
			diffContent = unescapeHtmlEntities(diffContent)
		}

		try {
			if (!relPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "path"))
				return
			}

			if (!diffContent) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				pushToolResult(await task.sayAndCreateMissingParamError("apply_diff", "diff"))
				return
			}

			const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

			if (!accessAllowed) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}

			const absolutePath = path.resolve(task.cwd, relPath)
			const fileExists = await fileExistsAtPath(absolutePath)

			if (!fileExists) {
				task.consecutiveMistakeCount++
				task.recordToolError("apply_diff")
				const formattedError = `File does not exist at path: ${absolutePath}\n\n<error_details>\nThe specified file could not be found. Please verify the file path and try again.\n</error_details>`
				await task.say("error", formattedError)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formattedError)
				return
			}

			const normalizedRelPath = normalizeTaskFilePath(relPath)
			const patchFingerprint = diffContent.trim()
			const failedHashes = task.failedDiffHashesForPath?.get(normalizedRelPath) || new Set<string>()

			// Detect identical failed patch retry before running expensive diff matching
			if (failedHashes.has(patchFingerprint)) {
				task.consecutiveMistakeCount++
				task.didToolFailInCurrentTurn = true
				const currentCount = (task.consecutiveMistakeCountForApplyDiff.get(normalizedRelPath) || 0) + 1
				task.consecutiveMistakeCountForApplyDiff.set(normalizedRelPath, currentCount)
				const mistakeLimit = task.consecutiveMistakeLimit || 3
				if (currentCount >= mistakeLimit) {
					task.consecutiveMistakeCount = Math.max(task.consecutiveMistakeCount, mistakeLimit)
				}
				const formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\nIDENTICAL FAILED PATCH RETRY: You submitted the exact same diff that previously failed for this file without changing the search or replacement content.\n\nTips to resolve:\n1. The file content on disk differs from your SEARCH block.\n2. Use read_file to inspect the current file content, indentation, and line breaks.\n3. Verify diff markers (:start_line:, -------) are not placed inside SEARCH or REPLACE blocks.\n4. Modify your SEARCH block to match the actual file lines before retrying.\n</error_details>`
				logEditRecoveryTelemetry({
					taskId: task.taskId,
					tool: "apply_diff",
					file: normalizedRelPath,
					editAttempt: currentCount,
					errorKind: EditFailureKind.NON_RECOVERABLE_IDENTICAL_RETRY,
					currentFileHash: "",
					recoveryAction: currentCount >= mistakeLimit ? "escalate_to_mistake_limit" : "escalate_to_diff_error",
					mistakeCount: task.consecutiveMistakeCount,
				})
				await task.say("diff_error", formattedError)
				task.recordToolError("apply_diff", formattedError)
				pushToolResult(formattedError)
				return
			}

			const originalContent: string = await fs.readFile(absolutePath, "utf-8")
			const currentFileHash = computeFileHash(originalContent)
			const trackedVersion = task.getFileTrackedVersion?.(normalizedRelPath)
			const isStaleBase = !!(trackedVersion && trackedVersion.hash !== currentFileHash)

			// Apply the diff to the original content
			const parsedStartLine = parseInt(params.diff.match(/:start_line:\s*(\d+)/i)?.[1] ?? "")
			const diffResult = (await task.diffStrategy?.applyDiff(
				originalContent,
				diffContent,
				isNaN(parsedStartLine) ? undefined : parsedStartLine,
			)) ?? {
				success: false,
				error: "No diff strategy available",
			}

			if (!diffResult.success) {
				const currentCount = (task.consecutiveMistakeCountForApplyDiff.get(normalizedRelPath) || 0) + 1
				task.consecutiveMistakeCountForApplyDiff.set(normalizedRelPath, currentCount)
				failedHashes.add(patchFingerprint)
				task.failedDiffHashesForPath?.set(normalizedRelPath, failedHashes)

				let formattedError = ""

				if (diffResult.failParts && diffResult.failParts.length > 0) {
					const failingParts = diffResult.failParts.filter((part) => !part.success)
					if (failingParts.length > 0) {
						const partErrors = failingParts.map((failPart, idx) => {
							const errorDetails = failPart.details ? JSON.stringify(failPart.details, null, 2) : ""
							return `[Block ${idx + 1} Failure]:\n${failPart.error}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}`
						})
						formattedError = `<error_details>\n${partErrors.join("\n\n---\n\n")}\n</error_details>`
					} else {
						formattedError = `<error_details>\n${diffResult.error ?? "Diff application failed"}\n</error_details>`
					}
				} else {
					const errorDetails = diffResult.details ? JSON.stringify(diffResult.details, null, 2) : ""

					formattedError = `Unable to apply diff to file: ${absolutePath}\n\n<error_details>\n${
						diffResult.error
					}${errorDetails ? `\n\nDetails:\n${errorDetails}` : ""}\n</error_details>`
				}

				const failureKind = classifyEditFailure({
					errorMessage: diffResult.error || formattedError,
					isIdenticalRetry: false,
					fileExists: true,
					isAccessAllowed: true,
					isStaleBase,
				})
				const isRecoverable = isRecoverableEditFailure(failureKind)

				if (isRecoverable && currentCount < MAX_EDIT_RECOVERY_ATTEMPTS) {
					logEditRecoveryTelemetry({
						taskId: task.taskId,
						tool: "apply_diff",
						file: normalizedRelPath,
						editAttempt: currentCount,
						errorKind: failureKind,
						baseFileHash: trackedVersion?.hash,
						currentFileHash,
						recoveryAction: "auto_retry_context",
						mistakeCount: task.consecutiveMistakeCount,
					})
					const recoveryFeedback = buildRecoveryFeedback({
						relPath: normalizedRelPath,
						failureKind,
						attemptNumber: currentCount,
						maxAttempts: MAX_EDIT_RECOVERY_ATTEMPTS,
						rawError: formattedError,
						diskContent: originalContent,
						targetLineHint: isNaN(parsedStartLine) ? undefined : parsedStartLine,
						searchSnippet: diffContent,
						baseHash: trackedVersion?.hash,
						currentHash: currentFileHash,
					})
					pushToolResult(recoveryFeedback)
					return
				}

				task.consecutiveMistakeCount++
				task.didToolFailInCurrentTurn = true
				const mistakeLimit = task.consecutiveMistakeLimit || 3
				if (currentCount >= mistakeLimit) {
					task.consecutiveMistakeCount = Math.max(task.consecutiveMistakeCount, mistakeLimit)
				}
				logEditRecoveryTelemetry({
					taskId: task.taskId,
					tool: "apply_diff",
					file: normalizedRelPath,
					editAttempt: currentCount,
					errorKind: failureKind,
					baseFileHash: trackedVersion?.hash,
					currentFileHash,
					recoveryAction: currentCount >= mistakeLimit ? "escalate_to_mistake_limit" : "escalate_to_diff_error",
					mistakeCount: task.consecutiveMistakeCount,
				})

				if (currentCount >= 2) {
					await task.say("diff_error", formattedError)
				}

				task.recordToolError("apply_diff", formattedError)

				pushToolResult(formattedError)
				return
			}

			task.consecutiveMistakeCount = 0
			if (task.clearEditFailureState) {
				task.clearEditFailureState(normalizedRelPath)
			} else {
				task.consecutiveMistakeCountForApplyDiff?.delete(relPath)
				task.consecutiveMistakeCountForApplyDiff?.delete(normalizedRelPath)
				task.failedDiffHashesForPath?.delete(relPath)
				task.failedDiffHashesForPath?.delete(normalizedRelPath)
			}
			task.recordFileReadVersion?.(normalizedRelPath, diffResult.content)

			// Generate backend-unified diff for display in chat/webview
			const unifiedPatchRaw = formatResponse.createPrettyPatch(relPath, originalContent, diffResult.content)
			const unifiedPatch = sanitizeUnifiedDiff(unifiedPatchRaw)
			const diffStats = computeDiffStats(unifiedPatch) || undefined

			// Check if preventFocusDisruption experiment is enabled
			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			const isPreventFocusDisruptionEnabled = experiments.isEnabled(
				state?.experiments ?? {},
				EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION,
			)

			// Check if file is write-protected
			const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

			const sharedMessageProps: ClineSayTool = {
				tool: "appliedDiff",
				path: getReadablePath(task.cwd, relPath),
				diff: diffContent,
			}

			if (isPreventFocusDisruptionEnabled) {
				// Direct file write without diff view
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					return
				}

				// Save directly without showing diff view or opening the file
				task.diffViewProvider.editType = "modify"
				task.diffViewProvider.originalContent = originalContent
				await task.diffViewProvider.saveDirectly(
					relPath,
					diffResult.content,
					false,
					diagnosticsEnabled,
					writeDelayMs,
				)
			} else {
				// Original behavior with diff view
				// Show diff view before asking for approval
				task.diffViewProvider.editType = "modify"
				await task.diffViewProvider.open(relPath)
				await task.diffViewProvider.update(diffResult.content, true)
				task.diffViewProvider.scrollToFirstDiff()

				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					diff: diffContent,
					content: unifiedPatch,
					originalContent,
					diffStats,
					isProtected: isWriteProtected,
				} satisfies ClineSayTool)

				let toolProgressStatus

				if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
					const block: ToolUse<"apply_diff"> = {
						type: "tool_use",
						name: "apply_diff",
						params: { path: relPath, diff: diffContent },
						partial: false,
					}
					toolProgressStatus = task.diffStrategy.getProgressStatus(block, diffResult)
				}

				const didApprove = await askApproval("tool", completeMessage, toolProgressStatus, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					task.processQueuedMessages()
					return
				}

				// Call saveChanges to update the DiffViewProvider properties
				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			// Track file edit operation
			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			// Used to determine if we should wait for busy terminal to update before sending api request
			task.didEditFile = true
			let partFailHint = ""

			if (diffResult.failParts && diffResult.failParts.length > 0) {
				partFailHint = `But unable to apply all diff parts to file: ${absolutePath}. Use the read_file tool to check the newest file version and re-apply diffs.\n`
			}

			// Get the formatted response message
			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			// Check for single SEARCH/REPLACE block warning
			const searchBlocks = (diffContent.match(/<<<<<<< SEARCH/g) || []).length
			const singleBlockNotice =
				searchBlocks === 1
					? "\n<notice>Making multiple related changes in a single apply_diff is more efficient. If other changes are needed in this file, please include them as additional SEARCH/REPLACE blocks.</notice>"
					: ""

			if (partFailHint) {
				pushToolResult(partFailHint + message + singleBlockNotice)
			} else {
				pushToolResult(message + singleBlockNotice)
			}

			await task.diffViewProvider.reset()
			this.resetPartialState()

			// Process any queued messages after file edit completes
			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("applying diff", error as Error)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			task.processQueuedMessages()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"apply_diff">): Promise<void> {
		const relPath: string | undefined = block.params.path
		const diffContent: string | undefined = block.params.diff

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath)) {
			return
		}

		const sharedMessageProps: ClineSayTool = {
			tool: "appliedDiff",
			path: getReadablePath(task.cwd, relPath),
			diff: diffContent,
		}

		let toolProgressStatus

		if (task.diffStrategy && task.diffStrategy.getProgressStatus) {
			toolProgressStatus = task.diffStrategy.getProgressStatus(block)
		}

		if (toolProgressStatus && Object.keys(toolProgressStatus).length === 0) {
			return
		}

		await task.ask("tool", JSON.stringify(sharedMessageProps), block.partial, toolProgressStatus).catch(() => {})
	}
}

export const applyDiffTool = new ApplyDiffTool()
