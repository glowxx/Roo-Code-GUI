import crypto from "crypto"
import path from "path"
import { addLineNumbers } from "../../../integrations/misc/extract-text"

export const MAX_EDIT_RECOVERY_ATTEMPTS = 2

export enum EditFailureKind {
	RECOVERABLE_STALE_CONTENT = "RECOVERABLE_STALE_CONTENT",
	RECOVERABLE_SEARCH_MISMATCH = "RECOVERABLE_SEARCH_MISMATCH",
	RECOVERABLE_OFFSET_DRIFT = "RECOVERABLE_OFFSET_DRIFT",
	RECOVERABLE_MARKER_LEAKAGE = "RECOVERABLE_MARKER_LEAKAGE",
	RECOVERABLE_LINE_ENDING_DRIFT = "RECOVERABLE_LINE_ENDING_DRIFT",
	RECOVERABLE_SYNTAX_ERROR = "RECOVERABLE_SYNTAX_ERROR",
	NON_RECOVERABLE_IDENTICAL_RETRY = "NON_RECOVERABLE_IDENTICAL_RETRY",
	NON_RECOVERABLE_FILE_NOT_FOUND = "NON_RECOVERABLE_FILE_NOT_FOUND",
	NON_RECOVERABLE_ACCESS_DENIED = "NON_RECOVERABLE_ACCESS_DENIED",
	NON_RECOVERABLE_AMBIGUOUS_MATCH = "NON_RECOVERABLE_AMBIGUOUS_MATCH",
	NON_RECOVERABLE_SYNTAX_ERROR = "NON_RECOVERABLE_SYNTAX_ERROR",
	NON_RECOVERABLE_BUDGET_EXHAUSTED = "NON_RECOVERABLE_BUDGET_EXHAUSTED",
}

export interface EditRecoveryTelemetry {
	taskId: string
	tool: "apply_diff" | "edit_file"
	file: string
	editAttempt: number
	errorKind: EditFailureKind
	baseFileHash?: string
	currentFileHash: string
	recoveryAction: "auto_retry_context" | "escalate_to_diff_error" | "escalate_to_mistake_limit"
	mistakeCount: number
	recoveryResult?: "recovered" | "failed"
}

export function isRecoverableEditFailure(kind: EditFailureKind): boolean {
	return (
		kind === EditFailureKind.RECOVERABLE_STALE_CONTENT ||
		kind === EditFailureKind.RECOVERABLE_SEARCH_MISMATCH ||
		kind === EditFailureKind.RECOVERABLE_OFFSET_DRIFT ||
		kind === EditFailureKind.RECOVERABLE_MARKER_LEAKAGE ||
		kind === EditFailureKind.RECOVERABLE_LINE_ENDING_DRIFT ||
		kind === EditFailureKind.RECOVERABLE_SYNTAX_ERROR
	)
}

export function normalizeTaskFilePath(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, "/")
}

export function computeFileHash(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8)
}

export function classifyEditFailure(options: {
	errorMessage: string
	isIdenticalRetry: boolean
	fileExists: boolean
	isAccessAllowed: boolean
	isStaleBase: boolean
	ambiguousMatches?: boolean
	editAttempt?: number
}): EditFailureKind {
	if (!options.fileExists) return EditFailureKind.NON_RECOVERABLE_FILE_NOT_FOUND
	if (!options.isAccessAllowed) return EditFailureKind.NON_RECOVERABLE_ACCESS_DENIED
	if (options.isIdenticalRetry) return EditFailureKind.NON_RECOVERABLE_IDENTICAL_RETRY
	if (options.ambiguousMatches) return EditFailureKind.NON_RECOVERABLE_AMBIGUOUS_MATCH

	const err = options.errorMessage.toLowerCase()
	if (options.isStaleBase) return EditFailureKind.RECOVERABLE_STALE_CONTENT

	const attempt = options.editAttempt ?? 1
	if (
		err.includes("unexpected end of sequence") ||
		err.includes("missing required sections") ||
		err.includes("malformed") ||
		err.includes("invalid diff format")
	) {
		// Allow 1 bounded autonomous correction turn with parser syntax feedback on attempt 1
		return attempt <= 1 ? EditFailureKind.RECOVERABLE_SYNTAX_ERROR : EditFailureKind.NON_RECOVERABLE_SYNTAX_ERROR
	}

	if (err.includes("identical - no changes would be made") || err.includes("no changes to apply")) {
		return EditFailureKind.RECOVERABLE_SEARCH_MISMATCH
	}

	// Strip advice/tips before checking for leaked markers so advice text doesn't cause false positives
	const errorBody = err.split(/tips to resolve|debug info|recovery suggestions/i)[0] || err
	if (
		errorBody.includes(":start_line:") ||
		errorBody.includes("-------") ||
		errorBody.includes("marker '>>>>>>> replace' found in your diff content")
	) {
		return EditFailureKind.RECOVERABLE_MARKER_LEAKAGE
	}
	if (err.includes("at line:") || err.includes("offset")) {
		return EditFailureKind.RECOVERABLE_OFFSET_DRIFT
	}
	if (err.includes("line endings") || err.includes("crlf") || err.includes("eol")) {
		return EditFailureKind.RECOVERABLE_LINE_ENDING_DRIFT
	}
	return EditFailureKind.RECOVERABLE_SEARCH_MISMATCH
}

export function extractSurroundingSlice(
	content: string,
	targetLineHint?: number,
	searchSnippet?: string,
	contextRadius = 25,
): {
	startLine: number
	endLine: number
	totalLines: number
	contentSnippet: string
} {
	const lines = content.split(/\r?\n/)
	const totalLines = lines.length

	if (totalLines === 0) {
		return { startLine: 1, endLine: 1, totalLines: 0, contentSnippet: "" }
	}

	let centerLine = 1
	if (targetLineHint && !isNaN(targetLineHint) && targetLineHint > 0) {
		centerLine = Math.min(totalLines, Math.max(1, targetLineHint))
	} else if (searchSnippet && searchSnippet.trim().length > 0) {
		const firstSearchLine = searchSnippet.split(/\r?\n/)[0]?.trim() || ""
		if (firstSearchLine.length > 3) {
			const foundIdx = lines.findIndex((l) => l.includes(firstSearchLine))
			if (foundIdx !== -1) {
				centerLine = foundIdx + 1
			}
		}
	}

	const startLine = Math.max(1, centerLine - contextRadius)
	const endLine = Math.min(totalLines, centerLine + contextRadius)
	const slice = lines.slice(startLine - 1, endLine).join("\n")
	const contentSnippet = addLineNumbers(slice, startLine)

	return {
		startLine,
		endLine,
		totalLines,
		contentSnippet,
	}
}

export function buildRecoveryFeedback(options: {
	relPath: string
	failureKind: EditFailureKind
	attemptNumber: number
	maxAttempts: number
	rawError: string
	diskContent: string
	targetLineHint?: number
	searchSnippet?: string
	baseHash?: string
	currentHash: string
}): string {
	const {
		relPath,
		failureKind,
		attemptNumber,
		maxAttempts,
		rawError,
		diskContent,
		targetLineHint,
		searchSnippet,
		baseHash,
		currentHash,
	} = options

	const slice = extractSurroundingSlice(diskContent, targetLineHint, searchSnippet)

	let conflictNotice = ""
	if (failureKind === EditFailureKind.RECOVERABLE_STALE_CONTENT) {
		conflictNotice = `\n[FILE CONFLICT]: The file content on disk has changed since it was last read (previous revision: ${baseHash ?? "unknown"}, current disk revision: ${currentHash}).`
	} else if (failureKind === EditFailureKind.RECOVERABLE_MARKER_LEAKAGE) {
		conflictNotice = `\n[DIFF MARKER LEAKAGE]: Diff markers (such as :start_line: or -------) were found inside the search block content. Do NOT include diff syntax markers inside SEARCH blocks.`
	} else if (failureKind === EditFailureKind.RECOVERABLE_OFFSET_DRIFT) {
		conflictNotice = `\n[LINE OFFSET DRIFT]: The line number or offset shifted compared to the current file state on disk.`
	} else if (failureKind === EditFailureKind.RECOVERABLE_SYNTAX_ERROR) {
		conflictNotice = `\n[DIFF SYNTAX ERROR]: Diff markers or block delimiters were malformed or missing (e.g. unclosed '>>>>>>> REPLACE'). Please ensure valid SEARCH/REPLACE format.`
	}

	return `${rawError}

<edit_recovery_context>
[AUTONOMOUS EDIT RECOVERY - Attempt ${attemptNumber} of ${maxAttempts}]${conflictNotice}
Target file: ${relPath} (current revision: ${currentHash}, total lines: ${slice.totalLines})

Current on-disk section around lines ${slice.startLine}-${slice.endLine}:
${slice.contentSnippet}

Actionable recovery instructions:
1. Compare your SEARCH block against the exact current on-disk content, indentation, and line breaks shown above.
2. Formulate your replacement against this current file state.
3. Submit a corrected patch. Do not repeat the exact same failed patch.
</edit_recovery_context>`
}

export function logEditRecoveryTelemetry(telemetry: EditRecoveryTelemetry): void {
	// Debug logging with zero sensitive contents or secrets
	console.debug(
		`[EditRecovery] taskId=${telemetry.taskId} tool=${telemetry.tool} file=${telemetry.file} attempt=${telemetry.editAttempt} kind=${telemetry.errorKind} action=${telemetry.recoveryAction} mistakes=${telemetry.mistakeCount}`,
	)
}
