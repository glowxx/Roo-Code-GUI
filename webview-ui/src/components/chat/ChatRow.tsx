import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import { useTranslation, Trans } from "react-i18next"
import deepEqual from "fast-deep-equal"
import { VSCodeBadge } from "@vscode/webview-ui-toolkit/react"

import type {
	ClineMessage,
	FollowUpData,
	SuggestionItem,
	ClineApiReqInfo,
	ClineAskUseMcpServer,
	ClineSayTool,
} from "@roo-code/types"

import { Mode } from "@roo/modes"

import { COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { safeJsonParse } from "@roo/core"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { findMatchingResourceOrTemplate } from "@src/utils/mcp"
import { vscode } from "@src/utils/vscode"
import { openSettings } from "@src/utils/settingsNavigation"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"
import UpdateTodoListToolBlock from "./UpdateTodoListToolBlock"
import { TodoChangeDisplay } from "./TodoChangeDisplay"
import CodeAccordion from "../common/CodeAccordion"
import MarkdownBlock from "../common/MarkdownBlock"
import { ReasoningBlock } from "./ReasoningBlock"
import { getConversationRowLayout } from "./conversation-layout"
import Thumbnails from "../common/Thumbnails"
import ImageBlock from "../common/ImageBlock"
import ErrorRow from "./ErrorRow"
import WarningRow from "./WarningRow"

import McpResourceRow from "../mcp/McpResourceRow"

import { Mention } from "./Mention"
import { CheckpointSaved } from "./checkpoints/CheckpointSaved"
import { FollowUpSuggest } from "./FollowUpSuggest"
import { BatchFilePermission } from "./BatchFilePermission"
import { BatchDiffApproval } from "./BatchDiffApproval"
import { ProgressIndicator } from "./ProgressIndicator"
import { Markdown } from "./Markdown"
import { CommandExecution } from "./CommandExecution"
import { CommandExecutionError } from "./CommandExecutionError"
import { AutoApprovedRequestLimitWarning } from "./AutoApprovedRequestLimitWarning"
import { InProgressRow, CondensationResultRow, CondensationErrorRow, TruncationResultRow } from "./context-management"
import CodebaseSearchResultsDisplay from "./CodebaseSearchResultsDisplay"
import { appendImages } from "@src/utils/imageUtils"
import { McpExecution } from "./McpExecution"
import { ChatTextArea } from "./ChatTextArea"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import { useSelectedModel } from "../ui/hooks/useSelectedModel"
import {
	Eye,
	FileDiff,
	ListTree,
	User,
	Edit,
	Trash2,
	MessageCircleQuestionMark,
	SquareArrowOutUpRight,
	FileCode2,
	PocketKnife,
	FolderTree,
	TerminalSquare,
	MessageCircle,
	Repeat2,
	Split,
	ArrowRight,
	Check,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { PathTooltip } from "../ui/PathTooltip"
import { OpenMarkdownPreviewButton } from "./OpenMarkdownPreviewButton"

// Helper function to get previous todos before a specific message
function getPreviousTodos(messages: ClineMessage[], currentMessageTs: number): any[] {
	// Find the previous updateTodoList message before the current one
	const previousUpdateIndex = messages
		.slice()
		.reverse()
		.findIndex((msg) => {
			if (msg.ts >= currentMessageTs) return false
			if (msg.type === "ask" && msg.ask === "tool") {
				try {
					const tool = JSON.parse(msg.text || "{}")
					return tool.tool === "updateTodoList"
				} catch {
					return false
				}
			}
			return false
		})

	if (previousUpdateIndex !== -1) {
		const previousMessage = messages.slice().reverse()[previousUpdateIndex]
		try {
			const tool = JSON.parse(previousMessage.text || "{}")
			return tool.todos || []
		} catch {
			return []
		}
	}

	// If no previous updateTodoList message, return empty array
	return []
}

interface ChatRowProps {
	message: ClineMessage
	lastModifiedMessage?: ClineMessage
	isExpanded: boolean
	isLast: boolean
	isStreaming: boolean
	onToggleExpand: (ts: number) => void
	onHeightChange: (isTaller: boolean) => void
	onSetEditingMessage?: (isEditing: boolean) => void
	onSuggestionClick?: (suggestion: SuggestionItem, event?: React.MouseEvent) => void
	onBatchFileResponse?: (response: { [key: string]: boolean }) => void
	onFollowUpUnmount?: () => void
	isFollowUpAnswered?: boolean
	isFollowUpAutoApprovalPaused?: boolean
	editable?: boolean
	hasCheckpoint?: boolean
	onJumpToPreviousCheckpoint?: () => void
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange, message } = props
		const { lane, spacing } = getConversationRowLayout(message)
		// Store the previous height to compare with the current height
		// This allows us to detect changes without causing re-renders
		const prevHeightRef = useRef(0)

		const isTechnicalSurface = useMemo(() => {
			if (message.ask === "command" || message.say === "command_output") {
				return true
			}
			if (message.say === "codebase_search_result") {
				return true
			}
			if (message.ask === "tool" || message.say === "tool") {
				try {
					const tool = typeof message.text === "string" ? JSON.parse(message.text || "{}") : message.text
					const t = tool?.tool
					if (
						t === "editedExistingFile" ||
						t === "appliedDiff" ||
						t === "newFileCreated" ||
						t === "searchAndReplace" ||
						t === "search_and_replace" ||
						t === "search_replace" ||
						t === "edit" ||
						t === "edit_file" ||
						t === "apply_patch" ||
						t === "apply_diff" ||
						Boolean(tool?.batchDiffs)
					) {
						return true
					}
				} catch {}
			}
			return false
		}, [message])

		const [chatrow, { height }] = useSize(
			<div className={cn("relative conversation-canvas conversation-row", `conversation-row--${spacing}`)}>
				<div
					className={cn(
						"conversation-lane",
						lane === "user" ? "conversation-lane-user" : isTechnicalSurface ? "conversation-lane-technical" : "conversation-lane-narrative",
					)}>
					<ChatRowContent {...props} />
				</div>
			</div>,
		)

		// Check if height has changed and is valid
		const isHeightValid = height !== undefined && height > 0

		useEffect(() => {
			// Existing rows may finish rendering after a newer row has been appended.
			if (isHeightValid && height !== prevHeightRef.current) {
				if (isLast || prevHeightRef.current > 0) {
					onHeightChange(prevHeightRef.current === 0 ? true : height > prevHeightRef.current)
				}
				prevHeightRef.current = height
			}
		}, [height, isLast, onHeightChange, isHeightValid])

		// we cannot return null as virtuoso does not support it, so we use a separate visibleMessages array to filter out messages that should not be rendered
		return chatrow
	},
	// Custom comparison function to prevent re-renders unless props actually change
	(prevProps, nextProps) => {
		return (
			prevProps.message === nextProps.message &&
			prevProps.lastModifiedMessage === nextProps.lastModifiedMessage &&
			prevProps.isExpanded === nextProps.isExpanded &&
			prevProps.isLast === nextProps.isLast &&
			prevProps.onHeightChange === nextProps.onHeightChange &&
			prevProps.onSetEditingMessage === nextProps.onSetEditingMessage &&
			prevProps.onToggleExpand === nextProps.onToggleExpand &&
			prevProps.isStreaming === nextProps.isStreaming &&
			prevProps.onSuggestionClick === nextProps.onSuggestionClick &&
			prevProps.onBatchFileResponse === nextProps.onBatchFileResponse &&
			prevProps.onFollowUpUnmount === nextProps.onFollowUpUnmount &&
			prevProps.isFollowUpAnswered === nextProps.isFollowUpAnswered &&
			prevProps.isFollowUpAutoApprovalPaused === nextProps.isFollowUpAutoApprovalPaused &&
			prevProps.editable === nextProps.editable &&
			prevProps.hasCheckpoint === nextProps.hasCheckpoint &&
			prevProps.onJumpToPreviousCheckpoint === nextProps.onJumpToPreviousCheckpoint
		)
	},
)

export default ChatRow

export const ChatRowContent = ({
		message,
		lastModifiedMessage,
		isExpanded,
		isLast,
		isStreaming,
		onToggleExpand,
		onSetEditingMessage,
		onSuggestionClick,
		onFollowUpUnmount,
		onBatchFileResponse,
		isFollowUpAnswered,
		isFollowUpAutoApprovalPaused,
		onJumpToPreviousCheckpoint,
	}: ChatRowContentProps) => {
	const { t, i18n } = useTranslation()

	const { mcpServers, alwaysAllowMcp, currentCheckpoint, mode, apiConfiguration, clineMessages, currentTaskItem } =
		useExtensionState()
	const { info: model } = useSelectedModel(apiConfiguration)
	const [isEditing, setIsEditing] = useState(false)
	const [editedContent, setEditedContent] = useState("")
	const [editMode, setEditMode] = useState<Mode>(mode || "code")
	const [editImages, setEditImages] = useState<string[]>([])

	// Handle message events for image selection during edit mode
	useEffect(() => {
		if (!isEditing) return

		const handleMessage = (event: MessageEvent) => {
			const msg = event.data
			if (msg.type === "selectedImages" && msg.context === "edit" && msg.messageTs === message.ts && isEditing) {
				setEditImages((prevImages) => appendImages(prevImages, msg.images, MAX_IMAGES_PER_MESSAGE))
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [isEditing, message.ts])

	// Memoized callback to prevent re-renders caused by inline arrow functions.
	const handleToggleExpand = useCallback(() => {
		onToggleExpand(message.ts)
	}, [onToggleExpand, message.ts])

	// Cleanup editing message state on unmount if editing
	useEffect(() => {
		return () => {
			if (isEditing) {
				onSetEditingMessage?.(false)
			}
		}
	}, [isEditing, onSetEditingMessage])

	// Handle edit button click
	const handleEditClick = useCallback(() => {
		onSetEditingMessage?.(true)
		setIsEditing(true)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
		// Edit mode is now handled entirely in the frontend
		// No need to notify the backend
	}, [onSetEditingMessage, message.text, message.images, mode])

	// Handle cancel edit
	const handleCancelEdit = useCallback(() => {
		setIsEditing(false)
		onSetEditingMessage?.(false)
		setEditedContent(message.text || "")
		setEditImages(message.images || [])
		setEditMode(mode || "code")
	}, [onSetEditingMessage, message.text, message.images, mode])

	// Handle save edit
	const handleSaveEdit = useCallback(() => {
		setIsEditing(false)
		onSetEditingMessage?.(false)
		// Send edited message to backend
		vscode.postMessage({
			type: "submitEditedMessage",
			value: message.ts,
			editedMessageContent: editedContent,
			images: editImages,
		})
	}, [onSetEditingMessage, message.ts, editedContent, editImages])

	// Handle image selection for editing
	const handleSelectImages = useCallback(() => {
		vscode.postMessage({ type: "selectImages", context: "edit", messageTs: message.ts })
	}, [message.ts])

	const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
		if (message.text !== null && message.text !== undefined && message.say === "api_req_started") {
			const info = safeJsonParse<ClineApiReqInfo>(message.text)
			return [info?.cost, info?.cancelReason, info?.streamingFailedMessage]
		}

		return [undefined, undefined, undefined]
	}, [message.text, message.say])

	// When resuming task, last won't be api_req_failed but a resume_task
	// message, so api_req_started will show loading spinner. That's why we just
	// remove the last api_req_started that failed without streaming anything.
	const apiRequestFailedMessage =
		isLast && lastModifiedMessage?.ask === "api_req_failed" // if request is retried then the latest message is a api_req_retried
			? lastModifiedMessage?.text
			: undefined

	const isCommandExecuting =
		isLast &&
		lastModifiedMessage?.ask === "command" &&
		(lastModifiedMessage?.text?.includes(COMMAND_OUTPUT_STRING) ||
			lastModifiedMessage?.approvalState === "AUTO_APPROVED")

	const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

	const type = message.type === "ask" ? message.ask : message.say

	const normalColor = "var(--vscode-foreground)"
	const errorColor = "var(--vscode-errorForeground)"
	const successColor = "var(--vscode-charts-green)"
	const cancelledColor = "var(--vscode-descriptionForeground)"

	const [icon, title] = useMemo(() => {
		switch (type) {
			case "error":
			case "mistake_limit_reached":
				return [null, null] // These will be handled by ErrorRow component
			case "command": {
				const isEvaluating = message.approvalState === "EVALUATING"
				const isApproved = message.approvalState === "AUTO_APPROVED"
				const isAwaitingApproval =
					message.type === "ask" &&
					!message.isAnswered &&
					!isCommandExecuting &&
					!isEvaluating &&
					(isLast || message.approvalState === "USER_DECISION_REQUIRED")
				return [
					isCommandExecuting || isEvaluating ? (
						<ProgressIndicator />
					) : (
						<TerminalSquare className="size-4" aria-label="Terminal icon" />
					),
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{isCommandExecuting
							? t("chat:commandExecution.running")
							: isEvaluating
							? t("chat:commandExecution.checkingSafety", { defaultValue: "Checking command safety..." })
							: isApproved
							? t("chat:commandExecution.autoApproved", { defaultValue: "Auto-approved" })
							: isAwaitingApproval
							? t("chat:commandExecution.awaitingApproval")
							: t("chat:commandExecution.command", { defaultValue: "Command" })}
					</span>,
				]
			}
			case "use_mcp_server":
				const mcpServerUse = safeJsonParse<ClineAskUseMcpServer>(message.text)
				if (mcpServerUse === undefined) {
					return [null, null]
				}
				return [
					isMcpServerResponding ? (
						<ProgressIndicator />
					) : (
						<span
							className="codicon codicon-server"
							style={{ color: normalColor, marginBottom: "-1.5px" }}></span>
					),
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{mcpServerUse.type === "use_mcp_tool"
							? t("chat:mcp.wantsToUseTool", { serverName: mcpServerUse.serverName })
							: t("chat:mcp.wantsToAccessResource", { serverName: mcpServerUse.serverName })}
					</span>,
				]
			case "completion_result": {
				const isApproved = message.approvalState === "AUTO_APPROVED"
				const isEvaluating = message.approvalState === "EVALUATING"
				const isDenied = message.approvalState === "DENIED"
				const isUserDecision = message.approvalState === "USER_DECISION_REQUIRED"

				if (isApproved) {
					return [
						<span
							className="codicon codicon-check"
							style={{ color: successColor, marginBottom: "-1.5px" }}></span>,
						<span style={{ color: successColor, fontWeight: "bold" }}>{t("chat:taskCompleted")}</span>,
					]
				}
				if (isEvaluating) {
					return [
						<ProgressIndicator />,
						<span style={{ color: normalColor, fontWeight: "bold" }}>
							{t("chat:verifyingCompletion", { defaultValue: "Verifying Task Completion..." })}
						</span>,
					]
				}
				if (isDenied) {
					return [
						<span
							className="codicon codicon-info"
							style={{ color: normalColor, marginBottom: "-1.5px" }}></span>,
						<span style={{ color: normalColor, fontWeight: "bold" }}>
							{t("chat:completionReviewContinued", {
								defaultValue: "Completion Review: Continued Work Required",
							})}
						</span>,
					]
				}
				if (isUserDecision) {
					return [
						<span
							className="codicon codicon-question"
							style={{ color: normalColor, marginBottom: "-1.5px" }}></span>,
						<span style={{ color: normalColor, fontWeight: "bold" }}>
							{t("chat:candidateCompletion", { defaultValue: "Proposed Task Completion" })}
						</span>,
					]
				}
				return [
					<span
						className="codicon codicon-question"
						style={{ color: normalColor, marginBottom: "-1.5px" }}></span>,
					<span style={{ color: normalColor, fontWeight: "bold" }}>
						{t("chat:candidateCompletion", { defaultValue: "Proposed Task Completion" })}
					</span>,
				]
			}
			case "api_req_rate_limit_wait":
				return []
			case "api_req_retry_delayed":
				return []
			case "api_req_started":
				const getIconSpan = (iconName: string, color: string) => (
					<div
						style={{
							width: 16,
							height: 16,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}>
						<span
							className={`codicon codicon-${iconName}`}
							style={{ color, fontSize: 16, marginBottom: "-1.5px" }}
						/>
					</div>
				)
				return [
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							getIconSpan("error", cancelledColor)
						) : (
							getIconSpan("error", errorColor)
						)
					) : cost !== null && cost !== undefined ? (
						getIconSpan("arrow-swap", normalColor)
					) : apiRequestFailedMessage ? (
						getIconSpan("error", errorColor)
					) : isLast ? (
						<ProgressIndicator />
					) : (
						getIconSpan("arrow-swap", normalColor)
					),
					apiReqCancelReason !== null && apiReqCancelReason !== undefined ? (
						apiReqCancelReason === "user_cancelled" ? (
							<span style={{ color: normalColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.cancelled")}
							</span>
						) : (
							<span style={{ color: errorColor, fontWeight: "bold" }}>
								{t("chat:apiRequest.streamingFailed")}
							</span>
						)
					) : cost !== null && cost !== undefined ? (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.title")}</span>
					) : apiRequestFailedMessage ? (
						<span style={{ color: errorColor }}>{t("chat:apiRequest.failed")}</span>
					) : (
						<span style={{ color: normalColor }}>{t("chat:apiRequest.streaming")}</span>
					),
				]
			case "followup":
				return [
					<MessageCircleQuestionMark className="w-4 shrink-0" aria-label="Question icon" />,
					<span style={{ color: normalColor, fontWeight: "bold" }}>{t("chat:questions.hasQuestion")}</span>,
				]
			default:
				return [null, null]
		}
	}, [
		type,
		isCommandExecuting,
		message,
		isMcpServerResponding,
		apiReqCancelReason,
		cost,
		apiRequestFailedMessage,
		t,
		isLast,
	])

	const headerStyle: React.CSSProperties = {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		cursor: "default",
		marginBottom: "6px",
		wordBreak: "break-word",
	}

	const tool = useMemo(
		() => (message.ask === "tool" ? safeJsonParse<ClineSayTool>(message.text) : null),
		[message.ask, message.text],
	)

	// Unified diff content (provided by backend when relevant)
	const unifiedDiff = useMemo(() => {
		if (!tool) return undefined
		return (tool.content ?? tool.diff) as string | undefined
	}, [tool])

	const onJumpToCreatedFile = useMemo(() => {
		if (!tool || tool.tool !== "newFileCreated" || !tool.path) {
			return undefined
		}

		return () => vscode.postMessage({ type: "openFile", text: "./" + tool.path })
	}, [tool])

	const followUpData = useMemo(() => {
		if (message.type === "ask" && message.ask === "followup" && !message.partial) {
			return safeJsonParse<FollowUpData>(message.text)
		}
		return null
	}, [message.type, message.ask, message.partial, message.text])

	if (tool) {
		const toolIcon = (name: string) => (
			<span
				className={`codicon codicon-${name}`}
				style={{ color: "var(--vscode-foreground)", marginBottom: "-1.5px" }}></span>
		)

		switch (tool.tool as string) {
			case "editedExistingFile":
			case "appliedDiff":
			case "newFileCreated":
			case "searchAndReplace":
			case "search_and_replace":
			case "search_replace":
			case "edit":
			case "edit_file":
			case "apply_patch":
			case "apply_diff":
				// Check if this is a batch diff request
				if (message.type === "ask" && tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
					return (
						<>
							<div style={headerStyle}>
								<FileDiff className="w-4 shrink-0" aria-label="Batch diff icon" />
								<span style={{ fontWeight: "bold" }}>
									{t("chat:fileOperations.wantsToApplyBatchChanges")}
								</span>
							</div>
							<BatchDiffApproval files={tool.batchDiffs} ts={message.ts} />
						</>
					)
				}

				// Regular single file diff
				return (
					<>
						<div style={headerStyle}>
							{tool.isProtected ? (
								<span
									className="codicon codicon-lock"
									style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
								/>
							) : (
								toolIcon("diff")
							)}
							<span style={{ fontWeight: "bold" }}>
								{tool.isProtected
									? t("chat:fileOperations.wantsToEditProtected")
									: tool.isOutsideWorkspace
										? t("chat:fileOperations.wantsToEditOutsideWorkspace")
										: t("chat:fileOperations.wantsToEdit")}
							</span>
						</div>
						<div className="ml-5">
							<CodeAccordion
								path={tool.path}
								code={unifiedDiff ?? tool.content ?? tool.diff ?? ""}
								language="diff"
								progressStatus={message.progressStatus}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								onJumpToFile={onJumpToCreatedFile}
								diffStats={tool.diffStats}
							/>
						</div>
					</>
				)
			case "insertContent":
				return (
					<>
						<div style={headerStyle}>
							{tool.isProtected ? (
								<span
									className="codicon codicon-lock"
									style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
								/>
							) : (
								toolIcon("insert")
							)}
							<span style={{ fontWeight: "bold" }}>
								{tool.isProtected
									? t("chat:fileOperations.wantsToEditProtected")
									: tool.isOutsideWorkspace
										? t("chat:fileOperations.wantsToEditOutsideWorkspace")
										: tool.lineNumber === 0
											? t("chat:fileOperations.wantsToInsertAtEnd")
											: t("chat:fileOperations.wantsToInsertWithLineNumber", {
													lineNumber: tool.lineNumber,
												})}
							</span>
						</div>
						<div className="ml-5">
							<CodeAccordion
								path={tool.path}
								code={unifiedDiff ?? tool.diff}
								language="diff"
								progressStatus={message.progressStatus}
								isLoading={message.partial}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								diffStats={tool.diffStats}
							/>
						</div>
					</>
				)
			case "codebaseSearch": {
				return (
					<div style={headerStyle}>
						{toolIcon("search")}
						<span style={{ fontWeight: "bold" }}>
							{tool.path ? (
								<Trans
									i18nKey="chat:codebaseSearch.wantsToSearchWithPath"
									components={{ code: <code></code> }}
									values={{ query: tool.query, path: tool.path }}
								/>
							) : (
								<Trans
									i18nKey="chat:codebaseSearch.wantsToSearch"
									components={{ code: <code></code> }}
									values={{ query: tool.query }}
								/>
							)}
						</span>
					</div>
				)
			}
			case "updateTodoList" as any: {
				const todos = (tool as any).todos || []
				// Get previous todos from the latest todos in the task context
				const previousTodos = getPreviousTodos(clineMessages, message.ts)

				return <TodoChangeDisplay previousTodos={previousTodos} newTodos={todos} />
			}
			case "readFile":
				// Check if this is a batch file permission request
				const isBatchRequest = message.type === "ask" && tool.batchFiles && Array.isArray(tool.batchFiles)

				if (isBatchRequest) {
					return (
						<>
							<div style={headerStyle}>
								<Eye className="w-4 shrink-0" aria-label="View files icon" />
								<span style={{ fontWeight: "bold" }}>
									{t("chat:fileOperations.wantsToReadMultiple")}
								</span>
							</div>
							<BatchFilePermission
								files={tool.batchFiles || []}
								onPermissionResponse={(response) => {
									onBatchFileResponse?.(response)
								}}
								ts={message?.ts}
							/>
						</>
					)
				}

				// Regular single file read request
				if (message.type !== "ask") {
					return (
						<div
							className="flex items-center gap-2 py-1 px-2.5 my-0.5 text-xs rounded-md bg-card/40 border border-border/20 text-muted-foreground hover:text-foreground transition-colors group cursor-pointer"
							onClick={() =>
								vscode.postMessage({
									type: "openFile",
									text: tool.content,
									values: tool.startLine ? { line: tool.startLine } : undefined,
								})
							}>
							<FileCode2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground/80" aria-label="Read file icon" />
							<span className="font-medium text-foreground/80">{t("chat:fileOperations.didRead")}</span>
							<span className="text-border/60">·</span>
							<PathTooltip content={formatPathTooltip(tool.path, tool.reason)}>
								<span className="font-mono text-xs truncate rtl max-w-[240px]">
									{tool.path?.startsWith(".") && <span>.</span>}
									{formatPathTooltip(tool.path, tool.reason)}
								</span>
							</PathTooltip>
							<div className="flex-1" />
							<SquareArrowOutUpRight
								className="w-3.5 h-3.5 shrink-0 codicon codicon-link-external opacity-0 group-hover:opacity-100 transition-opacity"
							/>
						</div>
					)
				}

				return (
					<>
						<div style={headerStyle}>
							<FileCode2 className="w-4 shrink-0" aria-label="Read file icon" />
							<span style={{ fontWeight: "bold" }}>
								{tool.isOutsideWorkspace
									? t("chat:fileOperations.wantsToReadOutsideWorkspace")
									: tool.additionalFileCount && tool.additionalFileCount > 0
										? t("chat:fileOperations.wantsToReadAndXMore", {
												count: tool.additionalFileCount,
											})
										: t("chat:fileOperations.wantsToRead")}
							</span>
						</div>
						<div className="ml-5">
							<ToolUseBlock>
								<ToolUseBlockHeader
									className="group"
									onClick={() =>
										vscode.postMessage({
											type: "openFile",
											text: tool.content,
											values: tool.startLine ? { line: tool.startLine } : undefined,
										})
									}>
									{tool.path?.startsWith(".") && <span>.</span>}
									<PathTooltip content={formatPathTooltip(tool.path, tool.reason)}>
										<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left mr-2 rtl">
											{formatPathTooltip(tool.path, tool.reason)}
										</span>
									</PathTooltip>
									<div style={{ flexGrow: 1 }}></div>
									<SquareArrowOutUpRight
										className="w-4 shrink-0 codicon codicon-link-external opacity-0 group-hover:opacity-100 transition-opacity"
										style={{ fontSize: 13.5, margin: "1px 0" }}
									/>
								</ToolUseBlockHeader>
							</ToolUseBlock>
						</div>
					</>
				)
			case "skill": {
				const skillInfo = tool
				if (message.type === "ask") {
					return (
						<>
							<div style={headerStyle}>
								{toolIcon("book")}
								<span style={{ fontWeight: "bold" }}>
									{t("chat:skill.wantsToLoad")}
								</span>
							</div>
							<div
								className="mt-1 rounded-lg border border-border/30 bg-card/40 overflow-hidden cursor-pointer"
								onClick={handleToggleExpand}>
								<ToolUseBlockHeader
									className="group flex items-center justify-between p-2.5">
									<div className="flex items-center gap-2">
										<span className="font-medium text-sm">
											{skillInfo.skill}
										</span>
										{skillInfo.source && (
											<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
												{skillInfo.source}
											</VSCodeBadge>
										)}
									</div>
									<span
										className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
								</ToolUseBlockHeader>
								{isExpanded && (skillInfo.args || skillInfo.description) && (
									<div className="px-3 py-2 border-t border-border/20 flex flex-col gap-2 text-xs">
										{skillInfo.description && (
											<div className="text-muted-foreground">
												{skillInfo.description}
											</div>
										)}
										{skillInfo.args && (
											<div>
												<span className="font-medium">Arguments: </span>
												<span className="text-muted-foreground">
													{skillInfo.args}
												</span>
											</div>
										)}
									</div>
								)}
							</div>
						</>
					)
				}

				return (
					<div
						className="inline-flex flex-wrap items-center gap-1.5 py-1 px-2.5 my-0.5 rounded-md bg-secondary/25 hover:bg-secondary/40 border border-border/20 text-xs cursor-pointer transition-colors max-w-full"
						onClick={handleToggleExpand}>
						{toolIcon("book")}
						<span className="text-muted-foreground">
							{t("chat:skill.didLoad", { defaultValue: "Loaded skill:" })}
						</span>
						<span className="font-mono font-medium text-foreground">
							{skillInfo.skill}
						</span>
						{skillInfo.source && (
							<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
								{skillInfo.source}
							</VSCodeBadge>
						)}
						{(skillInfo.args || skillInfo.description) && (
							<span className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} text-muted-foreground ml-0.5`} />
						)}
						{isExpanded && (skillInfo.args || skillInfo.description) && (
							<div className="w-full mt-1.5 pt-1.5 border-t border-border/20 flex flex-col gap-1 text-[11px] text-muted-foreground">
								{skillInfo.description && <div>{skillInfo.description}</div>}
								{skillInfo.args && (
									<div>
										<span className="font-medium text-foreground">Arguments: </span>
										<span>{skillInfo.args}</span>
									</div>
								)}
							</div>
						)}
					</div>
				)
			}
			case "listFilesTopLevel":
				return (
					<>
						<div style={headerStyle}>
							<ListTree className="w-4 shrink-0" aria-label="List files icon" />
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:directoryOperations.wantsToViewTopLevelOutsideWorkspace")
										: t("chat:directoryOperations.wantsToViewTopLevel")
									: tool.isOutsideWorkspace
										? t("chat:directoryOperations.didViewTopLevelOutsideWorkspace")
										: t("chat:directoryOperations.didViewTopLevel")}
							</span>
						</div>
						<div className="ml-5">
							<CodeAccordion
								path={tool.path}
								code={tool.content}
								language="shell-session"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</>
				)
			case "listFilesRecursive":
				return (
					<>
						<div style={headerStyle}>
							<FolderTree className="w-4 shrink-0" aria-label="Folder tree icon" />
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? tool.isOutsideWorkspace
										? t("chat:directoryOperations.wantsToViewRecursiveOutsideWorkspace")
										: t("chat:directoryOperations.wantsToViewRecursive")
									: tool.isOutsideWorkspace
										? t("chat:directoryOperations.didViewRecursiveOutsideWorkspace")
										: t("chat:directoryOperations.didViewRecursive")}
							</span>
						</div>
						<div className="ml-5">
							<CodeAccordion
								path={tool.path}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</>
				)
			case "searchFiles":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("search")}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask" ? (
									<Trans
										i18nKey={
											tool.isOutsideWorkspace
												? "chat:directoryOperations.wantsToSearchOutsideWorkspace"
												: "chat:directoryOperations.wantsToSearch"
										}
										components={{ code: <code className="font-medium">{tool.regex}</code> }}
										values={{ regex: tool.regex }}
									/>
								) : (
									<Trans
										i18nKey={
											tool.isOutsideWorkspace
												? "chat:directoryOperations.didSearchOutsideWorkspace"
												: "chat:directoryOperations.didSearch"
										}
										components={{ code: <code className="font-medium">{tool.regex}</code> }}
										values={{ regex: tool.regex }}
									/>
								)}
							</span>
						</div>
						<div className="ml-5">
							<CodeAccordion
								path={tool.path! + (tool.filePattern ? `/(${tool.filePattern})` : "")}
								code={tool.content}
								language="shellsession"
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					</>
				)
			case "switchMode":
				return (
					<>
						<div style={headerStyle}>
							<PocketKnife className="w-4 shrink-0" aria-label="Switch mode icon" />
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask" ? (
									<>
										{tool.reason ? (
											<Trans
												i18nKey="chat:modes.wantsToSwitchWithReason"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode, reason: tool.reason }}
											/>
										) : (
											<Trans
												i18nKey="chat:modes.wantsToSwitch"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode }}
											/>
										)}
									</>
								) : (
									<>
										{tool.reason ? (
											<Trans
												i18nKey="chat:modes.didSwitchWithReason"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode, reason: tool.reason }}
											/>
										) : (
											<Trans
												i18nKey="chat:modes.didSwitch"
												components={{ code: <code className="font-medium">{tool.mode}</code> }}
												values={{ mode: tool.mode }}
											/>
										)}
									</>
								)}
							</span>
						</div>
					</>
				)
			case "newTask":
				// Find all newTask messages to determine which child task ID corresponds to this message
				const newTaskMessages = clineMessages.filter((msg) => {
					if (msg.type === "ask" && msg.ask === "tool") {
						const t = safeJsonParse<ClineSayTool>(msg.text)
						return t?.tool === "newTask"
					}
					return false
				})
				const thisNewTaskIndex = newTaskMessages.findIndex((msg) => msg.ts === message.ts)
				const childIds = currentTaskItem?.childIds || []

				// Only get the child task ID if this newTask has been approved (has a corresponding entry in childIds)
				// This prevents showing a link to a previous task when the current newTask is still awaiting approval
				// Note: We don't use delegatedToId here because it persists after child tasks complete and would
				// incorrectly point to the previous task when a new newTask is awaiting approval
				const childTaskId =
					thisNewTaskIndex >= 0 && thisNewTaskIndex < childIds.length ? childIds[thisNewTaskIndex] : undefined

				// Check if the next message is a subtask_result - if so, don't show the button
				// since the result is displayed right after this message
				const currentMessageIndex = clineMessages.findIndex((msg) => msg.ts === message.ts)
				const nextMessage = currentMessageIndex >= 0 ? clineMessages[currentMessageIndex + 1] : undefined
				const isFollowedBySubtaskResult = nextMessage?.type === "say" && nextMessage?.say === "subtask_result"

				return (
					<>
						<div style={headerStyle}>
							<Split className="size-4" />
							<span style={{ fontWeight: "bold" }}>
								<Trans
									i18nKey="chat:subtasks.wantsToCreate"
									components={{ code: <code>{tool.mode}</code> }}
									values={{ mode: tool.mode }}
								/>
							</span>
						</div>
						<div className="border-l border-muted-foreground/80 ml-2 pl-4 pb-1">
							<MarkdownBlock markdown={tool.content} />
							<div>
								{childTaskId && !isFollowedBySubtaskResult && (
									<button
										className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
										onClick={() =>
											vscode.postMessage({ type: "showTaskWithId", text: childTaskId })
										}>
										{t("chat:subtasks.goToSubtask")}
										<ArrowRight className="size-3" />
									</button>
								)}
							</div>
						</div>
					</>
				)
			case "finishTask":
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("check-all")}
							<span style={{ fontWeight: "bold" }}>{t("chat:subtasks.wantsToFinish")}</span>
						</div>
						<div className="text-muted-foreground ml-5">
							<MarkdownBlock markdown={t("chat:subtasks.completionInstructions")} />
						</div>
					</>
				)
			case "runSlashCommand": {
				const slashCommandInfo = tool
				return (
					<>
						<div style={headerStyle}>
							{toolIcon("play")}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? t("chat:slashCommand.wantsToRun")
									: t("chat:slashCommand.didRun")}
							</span>
						</div>
						<div
							className="mt-1 rounded-lg border border-border/30 bg-card/40 overflow-hidden cursor-pointer"
							onClick={handleToggleExpand}>
							<ToolUseBlockHeader
								className="group flex items-center justify-between p-2.5">
								<div className="flex items-center gap-2">
									<span className="font-medium text-sm">
										/{slashCommandInfo.command}
									</span>
									{slashCommandInfo.source && (
										<VSCodeBadge style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
											{slashCommandInfo.source}
										</VSCodeBadge>
									)}
								</div>
								<span
									className={`codicon codicon-chevron-${isExpanded ? "up" : "down"} opacity-0 group-hover:opacity-100 transition-opacity duration-200`}></span>
							</ToolUseBlockHeader>
							{isExpanded && (slashCommandInfo.args || slashCommandInfo.description) && (
								<div className="px-3 py-2 border-t border-border/20 flex flex-col gap-2 text-xs">
									{slashCommandInfo.args && (
										<div>
											<span className="font-medium">Arguments: </span>
											<span className="text-muted-foreground">
												{slashCommandInfo.args}
											</span>
										</div>
									)}
									{slashCommandInfo.description && (
										<div className="text-muted-foreground">
											{slashCommandInfo.description}
										</div>
									)}
								</div>
							)}
						</div>
					</>
				)
			}
			case "generateImage":
				return (
					<>
						<div style={headerStyle}>
							{tool.isProtected ? (
								<span
									className="codicon codicon-lock"
									style={{ color: "var(--vscode-editorWarning-foreground)", marginBottom: "-1.5px" }}
								/>
							) : (
								toolIcon("file-media")
							)}
							<span style={{ fontWeight: "bold" }}>
								{message.type === "ask"
									? tool.isProtected
										? t("chat:fileOperations.wantsToGenerateImageProtected")
										: tool.isOutsideWorkspace
											? t("chat:fileOperations.wantsToGenerateImageOutsideWorkspace")
											: t("chat:fileOperations.wantsToGenerateImage")
									: t("chat:fileOperations.didGenerateImage")}
							</span>
						</div>
						{message.type === "ask" && (
							<div className="pl-6">
								<ToolUseBlock>
									<div className="p-2">
										<div className="mb-2 break-words">{tool.content}</div>
										<div className="flex items-center gap-1 text-xs text-vscode-descriptionForeground">
											{tool.path}
										</div>
									</div>
								</ToolUseBlock>
							</div>
						)}
					</>
				)
			default:
				return null
		}
	}

	switch (message.type) {
		case "say":
			switch (message.say) {
				case "diff_error":
					return (
						<ErrorRow
							type="diff_error"
							message={message.text || ""}
							expandable={true}
							showCopyButton={true}
						/>
					)
				case "subtask_result":
					// Get the child task ID that produced this result
					const completedChildTaskId = currentTaskItem?.completedByChildId
					return (
						<div className="border-l border-muted-foreground/80 ml-2 pl-4 pt-2 pb-1 -mt-5">
							<div style={headerStyle}>
								<span style={{ fontWeight: "bold" }}>{t("chat:subtasks.resultContent")}</span>
								<Check className="size-3" />
							</div>
							<MarkdownBlock markdown={message.text} />
							{completedChildTaskId && (
								<button
									className="cursor-pointer flex gap-1 items-center mt-2 text-vscode-descriptionForeground hover:text-vscode-descriptionForeground hover:underline font-normal"
									onClick={() =>
										vscode.postMessage({ type: "showTaskWithId", text: completedChildTaskId })
									}>
									{t("chat:subtasks.goToSubtask")}
									<ArrowRight className="size-3" />
								</button>
							)}
						</div>
					)
				case "reasoning":
					return (
						<ReasoningBlock
							content={message.text || ""}
							ts={message.ts}
							isStreaming={isStreaming}
							isLast={isLast}
						/>
					)
				case "api_req_started":
					// Determine if the API request is in progress
					const isApiRequestInProgress =
						apiReqCancelReason === undefined && apiRequestFailedMessage === undefined && cost === undefined

					return (
						<>
							<div
								className={`group text-xs transition-opacity ${
									isApiRequestInProgress ? "opacity-100" : "opacity-45 hover:opacity-100"
								}`}
								style={{
									...headerStyle,
									marginBottom:
										((cost === null || cost === undefined) && apiRequestFailedMessage) ||
										apiReqStreamingFailedMessage
											? 8
											: 0,
									justifyContent: "space-between",
								}}>
								<div style={{ display: "flex", alignItems: "center", gap: "8px", flexGrow: 1 }}>
									{icon}
									{title}
								</div>
								{cost !== null && cost !== undefined && cost > 0 && (
									<div
										className="text-[11px] font-mono text-vscode-descriptionForeground border-vscode-dropdown-border/40 border px-1.5 py-0.5 rounded">
										${Number(cost || 0)?.toFixed(4)}
									</div>
								)}
							</div>
							{(((cost === null || cost === undefined) && apiRequestFailedMessage) ||
								apiReqStreamingFailedMessage) && (
								<ErrorRow
									type="api_failure"
									message={apiRequestFailedMessage || apiReqStreamingFailedMessage || ""}
									docsURL={
										apiRequestFailedMessage?.toLowerCase().includes("powershell")
											? "https://github.com/cline/cline/wiki/TroubleShooting-%E2%80%90-%22PowerShell-is-not-recognized-as-an-internal-or-external-command%22"
											: undefined
									}
									errorDetails={apiReqStreamingFailedMessage}
								/>
							)}
						</>
					)
				case "api_req_retry_delayed":
					const textLower = (message.text || "").toLowerCase()
					const isStalledRetry =
						textLower.includes("stalled") ||
						textLower.includes("zawieszone") ||
						textLower.includes("retrying automatically") ||
						message.text === "stalledRetrying"

					if (isStalledRetry) {
						const notificationText =
							message.text === "stalledRetrying"
								? t("chat:apiRequest.stalledRetrying", {
										defaultValue: "Connection temporarily stalled — retrying automatically...",
								  })
								: message.text

						return (
							<div className="flex items-center gap-2 py-2 px-3 my-1 rounded bg-vscode-editor-inactiveSelectionBackground text-vscode-descriptionForeground text-xs">
								<Repeat2 className="size-3.5 animate-spin" strokeWidth={1.5} />
								<span>{notificationText}</span>
							</div>
						)
					}

					let body = t(`chat:apiRequest.failed`)
					let retryInfo, rawError, code, docsURL
					if (message.text !== undefined) {
						// Try to show richer error message for that code, if available
						const potentialCode = parseInt(message.text.substring(0, 3))
						if (!isNaN(potentialCode) && potentialCode >= 400) {
							code = potentialCode
							const stringForError = `chat:apiRequest.errorMessage.${code}`
							if (i18n.exists(stringForError)) {
								body = t(stringForError)
								// Fill this out in upcoming PRs
								// Do not remove this
								// switch(code) {
								// 	case ERROR_CODE:
								// 		docsURL = ???
								// 		break;
								// }
							} else {
								// Non-HTTP-status-code error message - store full text as errorDetails
								body = t("chat:apiRequest.errorMessage.unknown")
								docsURL = "https://github.com/RooCodeInc/Roo-Code/issues/new?template=bug_report.yml"
							}
						}

						// This isn't pretty, but since the retry logic happens at a lower level
						// and the message object is just a flat string, we need to extract the
						// retry information using this "tag" as a convention
						const retryTimerMatch = message.text.match(/<retry_timer>(.*?)<\/retry_timer>/)
						const retryTimer = retryTimerMatch && retryTimerMatch[1] ? parseInt(retryTimerMatch[1], 10) : 0
						rawError = message.text.replace(/<retry_timer>(.*?)<\/retry_timer>/, "").trim()
						retryInfo = retryTimer > 0 && (
							<p
								className={cn(
									"mt-2 font-light text-xs  text-vscode-descriptionForeground cursor-default flex items-center gap-1 transition-all duration-1000",
									retryTimer === 0 ? "opacity-0 max-h-0" : "max-h-2 opacity-100",
								)}>
								<Repeat2 className="size-3" strokeWidth={1.5} />
								<span>{retryTimer}s</span>
							</p>
						)
					}
					return (
						<ErrorRow
							type="api_req_retry_delayed"
							code={code}
							message={body}
							docsURL={docsURL}
							additionalContent={retryInfo}
							errorDetails={rawError}
						/>
					)
				case "api_req_rate_limit_wait": {
					const isWaiting = message.partial === true

					const waitSeconds = (() => {
						if (!message.text) return undefined
						try {
							const data = JSON.parse(message.text)
							return typeof data.seconds === "number" ? data.seconds : undefined
						} catch {
							return undefined
						}
					})()

					return isWaiting && waitSeconds !== undefined ? (
						<div
							className={`group text-sm transition-opacity opacity-100`}
							style={{
								...headerStyle,
								marginBottom: 0,
								justifyContent: "space-between",
							}}>
							<div style={{ display: "flex", alignItems: "center", gap: "10px", flexGrow: 1 }}>
								<ProgressIndicator />
								<span style={{ color: normalColor }}>{t("chat:apiRequest.rateLimitWait")}</span>
							</div>
							<span className="text-xs font-light text-vscode-descriptionForeground">{waitSeconds}s</span>
						</div>
					) : null
				}
				case "api_req_finished":
					return null // we should never see this message type
				case "text":
					return (
						<div className="group">
							<div style={headerStyle}>
								<MessageCircle className="w-4 shrink-0" aria-label="Speech bubble icon" />
								<span style={{ fontWeight: "bold" }}>{t("chat:text.rooSaid")}</span>
								<div style={{ flexGrow: 1 }} />
								<OpenMarkdownPreviewButton markdown={message.text} />
							</div>
							<div className="border-l-2 border-border/30 ml-2 pl-3 pb-0.5 prose-measure">
								<Markdown markdown={message.text} partial={message.partial} />
								{message.images && message.images.length > 0 && (
									<div style={{ marginTop: "10px" }}>
										{message.images.map((image, index) => (
											<ImageBlock key={index} imageData={image} />
										))}
									</div>
								)}
							</div>
						</div>
					)
				case "user_feedback":
					return (
						<div className="group">
							<div style={headerStyle}>
								<User className="w-4 shrink-0" aria-label="User icon" />
								<span style={{ fontWeight: "bold" }}>{t("chat:feedback.youSaid")}</span>
							</div>
							<div
								className={cn(
									"border rounded-lg overflow-hidden whitespace-pre-wrap transition-colors prose-measure",
									isEditing
										? "bg-card text-foreground border-border/40 p-2"
										: "cursor-text p-2.5 bg-card/60 hover:bg-card/80 border-l-2 border-l-vscode-focusBorder border-y border-r border-border/30 text-foreground",
								)}>
								{isEditing ? (
									<div className="flex flex-col gap-2">
										<ChatTextArea
											inputValue={editedContent}
											setInputValue={setEditedContent}
											sendingDisabled={false}
											selectApiConfigDisabled={true}
											placeholderText={t("chat:editMessage.placeholder")}
											selectedImages={editImages}
											setSelectedImages={setEditImages}
											onSend={handleSaveEdit}
											onSelectImages={handleSelectImages}
											shouldDisableImages={!model?.supportsImages}
											mode={editMode}
											setMode={setEditMode}
											modeShortcutText=""
											isEditMode={true}
											onCancel={handleCancelEdit}
										/>
									</div>
								) : (
									<div className="flex justify-between">
										<div
											className="flex-grow px-1 py-0.5 wrap-anywhere rounded transition-colors"
											onClick={(e) => {
												e.stopPropagation()
												if (!isStreaming) {
													handleEditClick()
												}
											}}
											title={t("chat:queuedMessages.clickToEdit")}>
											<Mention text={message.text} />
										</div>
										<div className="flex gap-2 pr-1">
											<div
												className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
												style={{ visibility: isStreaming ? "hidden" : "visible" }}
												onClick={(e) => {
													e.stopPropagation()
													handleEditClick()
												}}>
												<Edit className="w-4 shrink-0" aria-label="Edit message icon" />
											</div>
											<div
												className="cursor-pointer shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
												style={{ visibility: isStreaming ? "hidden" : "visible" }}
												onClick={(e) => {
													e.stopPropagation()
													vscode.postMessage({ type: "deleteMessage", value: message.ts })
												}}>
												<Trash2 className="w-4 shrink-0" aria-label="Delete message icon" />
											</div>
										</div>
									</div>
								)}
								{!isEditing && message.images && message.images.length > 0 && (
									<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
								)}
							</div>
						</div>
					)
				case "user_feedback_diff":
					const tool = safeJsonParse<ClineSayTool>(message.text)
					return (
						<div style={{ marginTop: -10, width: "100%" }}>
							<CodeAccordion
								code={tool?.diff}
								language="diff"
								isFeedback={true}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
							/>
						</div>
					)
				case "error":
					// Check if this is a model response error based on marker strings from backend
					const isNoToolsUsedError = message.text === "MODEL_NO_TOOLS_USED"
					const isNoAssistantMessagesError = message.text === "MODEL_NO_ASSISTANT_MESSAGES"

					if (isNoToolsUsedError) {
						return (
							<ErrorRow
								type="error"
								title={t("chat:modelResponseIncomplete")}
								message={t("chat:modelResponseErrors.noToolsUsed")}
								errorDetails={t("chat:modelResponseErrors.noToolsUsedDetails")}
							/>
						)
					}

					if (isNoAssistantMessagesError) {
						return (
							<ErrorRow
								type="error"
								title={t("chat:modelResponseIncomplete")}
								message={t("chat:modelResponseErrors.noAssistantMessages")}
								errorDetails={t("chat:modelResponseErrors.noAssistantMessagesDetails")}
							/>
						)
					}

					// Fallback for generic errors
					return (
						<ErrorRow type="error" message={message.text || t("chat:error")} errorDetails={message.text} />
					)
				case "completion_result": {
					const borderColor =
						message.approvalState === "AUTO_APPROVED"
							? "border-emerald-500/40"
							: message.approvalState === "DENIED"
								? "border-amber-500/40"
								: "border-blue-500/40"
					return (
						<div className="group">
							<div style={headerStyle}>
								{icon}
								{title}
								<div style={{ flexGrow: 1 }} />
								<OpenMarkdownPreviewButton markdown={message.text} />
							</div>
							<div className={`border-l-2 ${borderColor} ml-2 pl-3 pb-1 prose-measure`}>
								<Markdown markdown={message.text} />
							</div>
						</div>
					)
				}
				case "shell_integration_warning":
					return <CommandExecutionError />
				case "checkpoint_saved":
					return (
						<CheckpointSaved
							ts={message.ts!}
							commitHash={message.text!}
							currentHash={currentCheckpoint}
							checkpoint={message.checkpoint}
							onJumpToPreviousCheckpoint={onJumpToPreviousCheckpoint}
						/>
					)
				case "condense_context":
					// In-progress state
					if (message.partial) {
						return <InProgressRow eventType="condense_context" />
					}
					// Completed state
					if (message.contextCondense) {
						return <CondensationResultRow data={message.contextCondense} />
					}
					return null
				case "condense_context_error":
					return <CondensationErrorRow errorText={message.text} />
				case "sliding_window_truncation":
					// In-progress state
					if (message.partial) {
						return <InProgressRow eventType="sliding_window_truncation" />
					}
					// Completed state
					if (message.contextTruncation) {
						return <TruncationResultRow data={message.contextTruncation} />
					}
					return null
				case "codebase_search_result":
					let parsed: {
						content: {
							query: string
							results: Array<{
								filePath: string
								score: number
								startLine: number
								endLine: number
								codeChunk: string
							}>
						}
					} | null = null

					try {
						if (message.text) {
							parsed = JSON.parse(message.text)
						}
					} catch (error) {
						console.error("Failed to parse codebaseSearch content:", error)
					}

					if (parsed && !parsed?.content) {
						console.error("Invalid codebaseSearch content structure:", parsed.content)
						return <div>Error displaying search results.</div>
					}

					const { results = [] } = parsed?.content || {}

					return <CodebaseSearchResultsDisplay results={results} />
				case "user_edit_todos":
					return <UpdateTodoListToolBlock userEdited onChange={() => {}} />
				case "tool" as any:
					// Handle say tool messages
					const sayTool = safeJsonParse<ClineSayTool>(message.text)
					if (!sayTool) return null

					switch (sayTool.tool) {
						case "runSlashCommand": {
							const slashCommandInfo = sayTool
							return (
								<>
									<div style={headerStyle}>
										<span
											className="codicon codicon-terminal-cmd"
											style={{
												color: "var(--vscode-foreground)",
												marginBottom: "-1.5px",
											}}></span>
										<span style={{ fontWeight: "bold" }}>{t("chat:slashCommand.didRun")}</span>
									</div>
									<div className="ml-5">
										<ToolUseBlock>
											<ToolUseBlockHeader
												style={{
													display: "flex",
													flexDirection: "column",
													alignItems: "flex-start",
													gap: "4px",
													padding: "10px 12px",
												}}>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "8px",
														width: "100%",
													}}>
													<span
														style={{
															fontWeight: "500",
															fontSize: "var(--vscode-font-size)",
														}}>
														/{slashCommandInfo.command}
													</span>
													{slashCommandInfo.args && (
														<span
															style={{
																color: "var(--vscode-descriptionForeground)",
																fontSize: "var(--vscode-font-size)",
															}}>
															{slashCommandInfo.args}
														</span>
													)}
												</div>
												{slashCommandInfo.description && (
													<div
														style={{
															color: "var(--vscode-descriptionForeground)",
															fontSize: "calc(var(--vscode-font-size) - 1px)",
														}}>
														{slashCommandInfo.description}
													</div>
												)}
												{slashCommandInfo.source && (
													<div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
														<VSCodeBadge
															style={{ fontSize: "calc(var(--vscode-font-size) - 2px)" }}>
															{slashCommandInfo.source}
														</VSCodeBadge>
													</div>
												)}
											</ToolUseBlockHeader>
										</ToolUseBlock>
									</div>
								</>
							)
						}
						case "readCommandOutput": {
							const formatBytes = (bytes: number) => {
								if (bytes < 1024) return `${bytes} B`
								if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
								return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
							}

							// Determine if this is a search operation
							const isSearch = sayTool.searchPattern !== undefined

							let infoText = ""
							if (isSearch) {
								// Search mode: show pattern and match count
								const matchText =
									sayTool.matchCount !== undefined
										? sayTool.matchCount === 1
											? "1 match"
											: `${sayTool.matchCount} matches`
										: ""
								infoText = `search: "${sayTool.searchPattern}"${matchText ? ` • ${matchText}` : ""}`
							} else if (
								sayTool.readStart !== undefined &&
								sayTool.readEnd !== undefined &&
								sayTool.totalBytes !== undefined
							) {
								// Read mode: show byte range
								infoText = `${formatBytes(sayTool.readStart)} - ${formatBytes(sayTool.readEnd)} of ${formatBytes(sayTool.totalBytes)}`
							} else if (sayTool.totalBytes !== undefined) {
								infoText = formatBytes(sayTool.totalBytes)
							}

							return (
								<div style={headerStyle}>
									<FileCode2 className="w-4 shrink-0" aria-label="Read command output icon" />
									<span style={{ fontWeight: "bold" }}>{t("chat:readCommandOutput.title")}</span>
									{infoText && (
										<span
											className="text-xs ml-1"
											style={{ color: "var(--vscode-descriptionForeground)" }}>
											({infoText})
										</span>
									)}
								</div>
							)
						}
						default:
							return null
					}
				case "image":
					// Parse the JSON to get imageUri and imagePath
					const imageInfo = safeJsonParse<{ imageUri: string; imagePath: string }>(message.text || "{}")
					if (!imageInfo) {
						return null
					}
					return (
						<div style={{ marginTop: "10px" }}>
							<ImageBlock imageUri={imageInfo.imageUri} imagePath={imageInfo.imagePath} />
						</div>
					)
				case "too_many_tools_warning": {
					const warningData = safeJsonParse<{
						toolCount: number
						serverCount: number
						threshold: number
					}>(message.text || "{}")
					if (!warningData) return null
					const toolsPart = t("chat:tooManyTools.toolsPart", { count: warningData.toolCount })
					const serversPart = t("chat:tooManyTools.serversPart", { count: warningData.serverCount })
					return (
						<WarningRow
							title={t("chat:tooManyTools.title")}
							message={t("chat:tooManyTools.messageTemplate", {
								tools: toolsPart,
								servers: serversPart,
								threshold: warningData.threshold,
							})}
							actionText={t("chat:tooManyTools.openMcpSettings")}
							onAction={() => openSettings({ section: "mcp", source: "chat_row_mcp" })}
						/>
					)
				}
				case "command_safety_warning": {
					const evaluation = safeJsonParse<{
						isSafe: boolean
						riskLevel: string
						reason: string
						infrastructureFailure?: boolean
						deferredRetry?: {
							attempt: number
							maxAttempts: number
							delayMs: number
							nextRetryAt: number
						}
					}>(message.text || "{}")
					if (!evaluation) return null
					const isRejected = evaluation.reason?.includes("Safety verification rejected this action")
					const isModelUnavailable =
						evaluation.reason?.includes("Safety verification model is unavailable") ||
						evaluation.reason?.includes("Verification model unavailable")
					const isRateLimited = evaluation.reason?.includes("temporarily rate limited")
					const isTemporarilyUnavailable =
						evaluation.reason?.includes("Safety verification temporarily unavailable") ||
						evaluation.reason?.includes("Safety verification is in cooldown")
					const isInfra =
						evaluation.infrastructureFailure ||
						isModelUnavailable ||
						isRateLimited ||
						isTemporarilyUnavailable ||
						evaluation.reason?.includes("Approval response schema validation") ||
						evaluation.reason?.includes("Malformed JSON response from Approval Authority model")
					const title = isRejected
						? `🛡️ AI Command Safety Guardrail: ACTION REJECTED`
						: isModelUnavailable
							? `🛡️ AI Command Safety Guardrail: VERIFIER MODEL UNAVAILABLE`
							: isRateLimited
								? `🛡️ AI Command Safety Guardrail: VERIFIER RATE LIMITED`
								: isTemporarilyUnavailable
									? `🛡️ AI Command Safety Guardrail: VERIFICATION TEMPORARILY UNAVAILABLE`
									: isInfra
										? `🛡️ AI Command Safety Guardrail: VERIFICATION FAILED (Fail-Closed)`
										: `🛡️ AI Command Safety Guardrail: ${(evaluation.riskLevel || "unknown").toUpperCase()} RISK DETECTED`

					let messageText = evaluation.reason
					if (evaluation.deferredRetry) {
						const seconds = Math.max(1, Math.round(evaluation.deferredRetry.delayMs / 1000))
						messageText = `${evaluation.reason}\n\n⏳ Retrying verification in ~${seconds}s (Attempt ${evaluation.deferredRetry.attempt} of ${evaluation.deferredRetry.maxAttempts}). You can still Run or Deny manually at any time.`
					}

					return (
						<WarningRow
							title={title}
							message={messageText}
							actionText="Configure Safety Guardrail"
							onAction={() =>
								openSettings({ section: "commandSafety", source: "command_safety_warning" })
							}
						/>
					)
				}
				default:
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div style={{ paddingTop: 10 }}>
								<Markdown markdown={message.text} partial={message.partial} />
							</div>
						</>
					)
			}
		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
					if (message.isAnswered) {
						return null
					}
					return <ErrorRow type="mistake_limit" message={message.text || ""} errorDetails={message.text} />
				case "command":
					return (
						<CommandExecution
							executionId={message.ts.toString()}
							text={message.text}
							icon={icon}
							title={title}
						/>
					)
				case "use_mcp_server":
					// Parse the message text to get the MCP server request
					const messageJson = safeJsonParse<any>(message.text, {})

					// Extract the response field if it exists
					const { response, ...mcpServerRequest } = messageJson

					// Create the useMcpServer object with the response field
					const useMcpServer: ClineAskUseMcpServer = {
						...mcpServerRequest,
						response,
					}

					if (!useMcpServer) {
						return null
					}

					const server = mcpServers.find((server) => server.name === useMcpServer.serverName)

					return (
						<>
							<div style={headerStyle}>
								{icon}
								{title}
							</div>
							<div className="w-full bg-card/40 border border-border/30 rounded-lg p-2.5 mt-1.5">
								{useMcpServer.type === "access_mcp_resource" && (
									<McpResourceRow
										item={{
											// Use the matched resource/template details, with fallbacks
											...(findMatchingResourceOrTemplate(
												useMcpServer.uri || "",
												server?.resources,
												server?.resourceTemplates,
											) || {
												name: "",
												mimeType: "",
												description: "",
											}),
											// Always use the actual URI from the request
											uri: useMcpServer.uri || "",
										}}
									/>
								)}
								{useMcpServer.type === "use_mcp_tool" && (
									<McpExecution
										executionId={message.ts.toString()}
										text={useMcpServer.arguments !== "{}" ? useMcpServer.arguments : undefined}
										serverName={useMcpServer.serverName}
										toolName={useMcpServer.toolName}
										isArguments={true}
										server={server}
										useMcpServer={useMcpServer}
										alwaysAllowMcp={alwaysAllowMcp}
									/>
								)}
							</div>
						</>
					)
				case "completion_result":
					if (message.text) {
						const borderColor =
							message.approvalState === "DENIED"
								? "border-amber-500/40"
								: message.approvalState === "EVALUATING"
									? "border-blue-500/40"
									: "border-emerald-500/40"
						return (
							<div className="group">
								<div style={headerStyle}>
									{icon}
									{title}
									<div style={{ flexGrow: 1 }} />
									<OpenMarkdownPreviewButton markdown={message.text} />
								</div>
								<div className={`border-l-2 ${borderColor} ml-2 pl-3 pb-1`}>
									<Markdown markdown={message.text} partial={message.partial} />
								</div>
							</div>
						)
					} else {
						return null // Don't render anything when we get a completion_result ask without text
					}
				case "followup":
					return (
						<>
							{title && (
								<div style={headerStyle}>
									{icon}
									{title}
								</div>
							)}
							<div className="flex flex-col gap-2 ml-6">
								<Markdown
									markdown={message.partial === true ? message?.text : followUpData?.question}
								/>
								<FollowUpSuggest
									suggestions={followUpData?.suggest}
									onSuggestionClick={onSuggestionClick}
									ts={message?.ts}
									onCancelAutoApproval={onFollowUpUnmount}
									isAnswered={isFollowUpAnswered}
									isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
								/>
							</div>
						</>
					)
				case "auto_approval_max_req_reached": {
					return <AutoApprovedRequestLimitWarning message={message} />
				}
				default:
					return null
			}
	}
}
