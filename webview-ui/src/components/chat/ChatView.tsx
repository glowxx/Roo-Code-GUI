import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { useDeepCompareEffect, useEvent } from "react-use"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import removeMd from "remove-markdown"
import useSound from "use-sound"
import { LRUCache } from "lru-cache"

import { useDebounceEffect } from "@src/utils/useDebounceEffect"
import { appendImages } from "@src/utils/imageUtils"
import { batchConsecutive } from "@src/utils/batchConsecutive"

import type { ClineAsk, ClineSayTool, ClineMessage, ExtensionMessage, AudioType, WebSearchMode } from "@roo-code/types"
import { isRetiredProvider } from "@roo-code/types"

import { findLast } from "@roo/array"
import { SuggestionItem } from "@roo-code/types"
import { combineApiRequests } from "@roo/combineApiRequests"
import { combineCommandSequences, COMMAND_OUTPUT_STRING } from "@roo/combineCommandSequences"
import { getApiMetrics, consolidateReportedTokenUsage } from "@roo/getApiMetrics"
import { getAllModes } from "@roo/modes"
import { ProfileValidator } from "@roo/ProfileValidator"
import { getLatestTodo } from "@roo/todo"
import { getLatestUserPrompt } from "./utils/userPrompt"

import { vscode } from "@src/utils/vscode"
import { openSettings } from "@src/utils/settingsNavigation"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useSelectedModel } from "@src/components/ui/hooks/useSelectedModel"
import RooHero from "@src/components/welcome/RooHero"
import { AgentStarters } from "@src/components/welcome/AgentStarters"
import { StandardTooltip, Button } from "@src/components/ui"
import HistoryPreview from "../history/HistoryPreview"
import Announcement from "./Announcement"
import ChatRow from "./ChatRow"
import { AgentActivity } from "./AgentActivity"
import { buildAgentFeed, type AgentFeedItem } from "./agent-feed"
import WarningRow from "./WarningRow"
import { ChatTextArea } from "./ChatTextArea"
import { cleanModelDisplayName } from "./ModelSelector"
import TaskHeader from "./TaskHeader"
import ProfileViolationWarning from "./ProfileViolationWarning"
import { CheckpointWarning } from "./CheckpointWarning"
import { QueuedMessages } from "./QueuedMessages"
import { WorktreeSelector } from "./WorktreeSelector"
import FileChangesPanel from "./FileChangesPanel"
import { useScrollLifecycle } from "@src/hooks/useScrollLifecycle"
import {
	saveDraft,
	loadDraft,
	deleteDraft,
	flushPendingDraft,
	scheduleSaveDraft,
	getActiveProvisionalId,
	setActiveProvisionalIdKey,
} from "@src/utils/draftManager"

export interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
}

export interface ChatViewRef {
	acceptInput: () => void
}

export const MAX_IMAGES_PER_MESSAGE = 20 // This is the Anthropic limit.

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0

const VirtuosoFooter = () => <div className="h-6 w-full shrink-0" />
const virtuosoComponents = { Footer: VirtuosoFooter }

const ChatViewComponent: React.ForwardRefRenderFunction<ChatViewRef, ChatViewProps> = (
	{ isHidden, showAnnouncement, hideAnnouncement },
	ref,
) => {
	const [audioBaseUri] = useState(() => {
		return (window as unknown as { AUDIO_BASE_URI?: string }).AUDIO_BASE_URI || ""
	})

	const { t } = useAppTranslation()
	const modeShortcutText = `${isMac ? "⌘" : "Ctrl"} + . ${t("chat:forNextMode")}, ${isMac ? "⌘" : "Ctrl"} + Shift + . ${t("chat:forPreviousMode")}`

	const {
		clineMessages: messages,
		currentTaskId,
		currentTaskItem,
		currentTaskTodos,
		taskHistory,
		apiConfiguration,
		organizationAllowList,
		mode,
		setMode,
		alwaysAllowModeSwitch,
		customModes,
		soundEnabled,
		soundVolume,
		messageQueue = [],
		showWorktreesInHomeScreen,
		approvalMode,
		cwd,
	} = useExtensionState()

	// Show a WarningRow when the user sends a message with a retired provider.
	const [showRetiredProviderWarning, setShowRetiredProviderWarning] = useState(false)

	// When the provider changes, clear the retired-provider warning.
	const providerName = apiConfiguration?.apiProvider
	useEffect(() => {
		setShowRetiredProviderWarning(false)
	}, [providerName])

	const messagesRef = useRef(messages)

	useEffect(() => {
		messagesRef.current = messages
	}, [messages])

	// Leaving this less safe version here since if the first message is not a
	// task, then the extension is in a bad state and needs to be debugged (see
	// Cline.abort).
	const task = useMemo(() => messages.at(0), [messages])
	const latestUserPrompt = useMemo(() => getLatestUserPrompt(messages), [messages])

	const latestTodos = useMemo(() => {
		// First check if we have initial todos from the state (for new subtasks)
		if (currentTaskTodos && currentTaskTodos.length > 0) {
			// Check if there are any todo updates in messages
			const messageBasedTodos = getLatestTodo(messages)
			// If there are message-based todos, they take precedence (user has updated them)
			if (messageBasedTodos && messageBasedTodos.length > 0) {
				return messageBasedTodos
			}
			// Otherwise use the initial todos from state
			return currentTaskTodos
		}
		// Fall back to extracting from messages
		return getLatestTodo(messages)
	}, [messages, currentTaskTodos])

	const modifiedMessages = useMemo(() => combineApiRequests(combineCommandSequences(messages.slice(1))), [messages])

	// Has to be after api_req_finished are all reduced into api_req_started messages.
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])
	const reportedUsage = useMemo(() => consolidateReportedTokenUsage(modifiedMessages), [modifiedMessages])

	const [inputValue, setInputValue] = useState("")
	const inputValueRef = useRef(inputValue)
	const textAreaRef = useRef<HTMLTextAreaElement>(null)
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const [selectedImages, setSelectedImages] = useState<string[]>([])
	const [webSearchMode, setWebSearchMode] = useState<WebSearchMode>("auto")
	const webSearchModeRef = useRef<WebSearchMode>(webSearchMode)
	useEffect(() => {
		webSearchModeRef.current = webSearchMode
	}, [webSearchMode])

	// We need to hold on to the ask because useEffect > lastMessage will always
	// let us know when an ask comes in and handle it, but by the time
	// handleMessage is called, the last message might not be the ask anymore
	// (it could be a say that followed).
	const [clineAsk, setClineAsk] = useState<ClineAsk | undefined>(undefined)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>(undefined)
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>(undefined)

	const selectedModel = useSelectedModel(apiConfiguration)
	const model = selectedModel.info

	const isModelDiffDuringFailure = useMemo(() => {
		if (clineAsk !== "api_req_failed") return false
		const execModel = currentTaskItem?.executionModelId
		const execProvider = currentTaskItem?.executionProvider
		if (!execModel) return false
		const selectedId = selectedModel.id
		const selectedProvider = apiConfiguration?.apiProvider
		const isModelDiff = Boolean(selectedId && selectedId !== execModel)
		const isProviderDiff = Boolean(selectedProvider && execProvider && selectedProvider !== execProvider)
		return isModelDiff || isProviderDiff
	}, [
		clineAsk,
		currentTaskItem?.executionModelId,
		currentTaskItem?.executionProvider,
		selectedModel.id,
		apiConfiguration?.apiProvider,
	])

	const [_didClickCancel, setDidClickCancel] = useState(false)
	const [isStopping, setIsStopping] = useState(false)
	const [isResuming, setIsResuming] = useState(false)
	const [stopError, setStopError] = useState(false)
	const stopRequestIdRef = useRef<string | null>(null)
	const stopAckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const prevExpandedRowsRef = useRef<Record<number, boolean>>()
	const scrollContainerRef = useRef<HTMLDivElement>(null)
	const lastTtsRef = useRef<string>("")
	const [wasStreaming, setWasStreaming] = useState<boolean>(false)
	const [checkpointWarning, setCheckpointWarning] = useState<
		{ type: "WAIT_TIMEOUT" | "INIT_TIMEOUT"; timeout: number } | undefined
	>(undefined)
	const [isCondensing, setIsCondensing] = useState<boolean>(false)
	const [compactionError, setCompactionError] = useState<string | null>(null)
	const [showAnnouncementModal, setShowAnnouncementModal] = useState(false)
	const everVisibleMessagesTsRef = useRef<LRUCache<number, boolean>>(
		new LRUCache({
			max: 100,
			ttl: 1000 * 60 * 5,
		}),
	)
	const autoApproveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
	const userRespondedRef = useRef<boolean>(false)
	const [currentFollowUpTs, setCurrentFollowUpTs] = useState<number | null>(null)

	const clineAskRef = useRef(clineAsk)
	useEffect(() => {
		clineAskRef.current = clineAsk
	}, [clineAsk])

	// Keep inputValueRef in sync with inputValue state
	useEffect(() => {
		inputValueRef.current = inputValue
	}, [inputValue])

	// Compute whether auto-approval is paused (user is typing in a followup)
	const isFollowUpAutoApprovalPaused = useMemo(() => {
		return !!(inputValue && inputValue.trim().length > 0 && clineAsk === "followup")
	}, [inputValue, clineAsk])

	// Cancel auto-approval timeout when user starts typing
	useEffect(() => {
		// Only send cancel if there's actual input (user is typing)
		// and we have a pending follow-up question
		if (isFollowUpAutoApprovalPaused) {
			vscode.postMessage({ type: "cancelAutoApproval", taskId: currentTaskItem?.id })
		}
	}, [isFollowUpAutoApprovalPaused, currentTaskItem?.id])

	const selectedImagesRef = useRef(selectedImages)
	useEffect(() => {
		selectedImagesRef.current = selectedImages
	}, [selectedImages])

	// Unique ID for provisional (new) chat drafts before a task ID is assigned
	const [activeProvisionalId, setActiveProvisionalId] = useState<string>(() => {
		const existing = getActiveProvisionalId(cwd || "global")
		if (existing) return existing
		const fresh = `provisional_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
		setActiveProvisionalIdKey(cwd || "global", fresh)
		return fresh
	})
	const activeProvisionalIdRef = useRef(activeProvisionalId)
	useEffect(() => {
		activeProvisionalIdRef.current = activeProvisionalId
	}, [activeProvisionalId])

	const assignNewProvisionalId = useCallback(() => {
		const fresh = `provisional_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
		setActiveProvisionalId(fresh)
		setActiveProvisionalIdKey(cwd || "global", fresh)
		return fresh
	}, [cwd])

	const currentChatKey = currentTaskItem?.id ? `task_${currentTaskItem.id}` : activeProvisionalId
	const currentChatKeyRef = useRef(currentChatKey)
	useEffect(() => {
		currentChatKeyRef.current = currentChatKey
	}, [currentChatKey])

	const prevChatKeyRef = useRef<string>(currentChatKey)
	const isRestoringDraftRef = useRef(false)
	const inFlightDraftRef = useRef<{
		key: string
		text: string
		images: string[]
		webSearchMode?: WebSearchMode
	} | null>(null)

	// Restore draft on initial mount
	useEffect(() => {
		const restored = loadDraft(cwd || "global", currentChatKey)
		if (restored && !inputValueRef.current) {
			setInputValue(restored.text || "")
			setSelectedImages(restored.images || [])
			if (restored.webSearchMode) {
				setWebSearchMode(restored.webSearchMode)
			}
		}
	}, [])

	// Save previous draft and restore target chat draft on chat switch
	useEffect(() => {
		if (prevChatKeyRef.current !== currentChatKey) {
			flushPendingDraft()
			saveDraft(cwd || "global", prevChatKeyRef.current, {
				text: inputValueRef.current,
				images: selectedImagesRef.current,
				webSearchMode: webSearchModeRef.current,
			})

			const restored = loadDraft(cwd || "global", currentChatKey)
			isRestoringDraftRef.current = true
			if (restored) {
				setInputValue(restored.text || "")
				setSelectedImages(restored.images || [])
				setWebSearchMode(restored.webSearchMode || "auto")
			} else {
				setInputValue("")
				setSelectedImages([])
				setWebSearchMode("auto")
			}
			prevChatKeyRef.current = currentChatKey
			const timer = setTimeout(() => {
				isRestoringDraftRef.current = false
			}, 50)
			return () => clearTimeout(timer)
		}
	}, [currentChatKey, cwd])

	// Debounced draft save on input/image change
	useEffect(() => {
		if (isRestoringDraftRef.current) return
		scheduleSaveDraft(cwd || "global", currentChatKey, {
			text: inputValue,
			images: selectedImages,
			webSearchMode,
		})
	}, [inputValue, selectedImages, webSearchMode, currentChatKey, cwd])

	// Window blur and beforeunload forced flush
	useEffect(() => {
		const handleFlush = () => {
			flushPendingDraft()
			saveDraft(cwd || "global", currentChatKeyRef.current, {
				text: inputValueRef.current,
				images: selectedImagesRef.current,
				webSearchMode: webSearchModeRef.current,
			})
		}
		window.addEventListener("blur", handleFlush)
		window.addEventListener("beforeunload", handleFlush)
		return () => {
			window.removeEventListener("blur", handleFlush)
			window.removeEventListener("beforeunload", handleFlush)
		}
	}, [cwd])

	// Clean up provisional draft upon task creation confirmation
	useEffect(() => {
		if (currentTaskItem?.id && inFlightDraftRef.current) {
			deleteDraft(cwd || "global", inFlightDraftRef.current.key)
			if (inFlightDraftRef.current.key.startsWith("provisional_")) {
				// Allocate new provisional ID for the next empty chat so sent draft does not leak
				assignNewProvisionalId()
			}
			inFlightDraftRef.current = null
		}
	}, [currentTaskItem?.id, cwd, assignNewProvisionalId])

	const isProfileDisabled = useMemo(
		() => !!apiConfiguration && !ProfileValidator.isProfileAllowed(apiConfiguration, organizationAllowList),
		[apiConfiguration, organizationAllowList],
	)

	// UI layout depends on the last 2 messages (since it relies on the content
	// of these messages, we are deep comparing) i.e. the button state after
	// hitting button sets enableButtons to false,  and this effect otherwise
	// would have to true again even if messages didn't change.
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])

	const activeAskMessage = useMemo(() => {
		const lastAsk = [...messages].reverse().find((m) => m.type === "ask" && !m.isAnswered)
		if (!lastAsk) return undefined
		const lastAskIdx = messages.lastIndexOf(lastAsk)
		const trailingMessages = messages.slice(lastAskIdx + 1)
		const isStillPending = trailingMessages.every(
			(m) =>
				m.type === "say" &&
				(m.say === "command_safety_warning" ||
					m.say === "api_req_rate_limit_wait" ||
					m.say === "api_req_retry_delayed"),
		)
		return isStillPending ? lastAsk : undefined
	}, [messages])

	const volume = typeof soundVolume === "number" ? soundVolume : 0.5
	const [playNotification] = useSound(`${audioBaseUri}/notification.wav`, { volume, soundEnabled, interrupt: true })
	const [playCelebration] = useSound(`${audioBaseUri}/celebration.wav`, { volume, soundEnabled, interrupt: true })
	const [playProgressLoop] = useSound(`${audioBaseUri}/progress_loop.wav`, { volume, soundEnabled, interrupt: true })

	const lastPlayedRef = useRef<Record<string, number>>({})
	const lastCelebratedMsgTsRef = useRef<number | null>(null)

	const playSound = useCallback(
		(audioType: AudioType) => {
			if (!soundEnabled) {
				return
			}

			const now = Date.now()
			const lastPlayed = lastPlayedRef.current[audioType] ?? 0
			if (now - lastPlayed < 100) {
				return
			} // debounce: skip if played within 100ms
			lastPlayedRef.current[audioType] = now

			switch (audioType) {
				case "notification":
					playNotification()
					break
				case "celebration":
					playCelebration()
					break
				case "progress_loop":
					playProgressLoop()
					break
				default:
					console.warn(`Unknown audio type: ${audioType}`)
			}
		},
		[soundEnabled, playNotification, playCelebration, playProgressLoop],
	)

	const playErrorSound = useCallback(() => {
		playSound("notification")
	}, [playSound])

	function playTts(text: string) {
		vscode.postMessage({ type: "playTts", text })
	}

	useDeepCompareEffect(() => {
		// if last message is an ask, show user ask UI
		// if user finished a task, then start a new task with a new conversation history since in this moment that the extension is waiting for user response, the user could close the extension and the conversation history would be lost.
		// basically as long as a task is active, the conversation history will be persisted
		if (lastMessage) {
			const messageToHandle = lastMessage.type === "say" && activeAskMessage ? activeAskMessage : lastMessage
			const isPartial = messageToHandle.partial === true
			switch (messageToHandle.type) {
				case "ask":
					// Reset user response flag when a new ask arrives to allow auto-approval
					userRespondedRef.current = false
					switch (messageToHandle.ask) {
						case "api_req_failed":
							playSound("progress_loop")
							setSendingDisabled(true)
							setClineAsk("api_req_failed")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:retry.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "mistake_limit_reached":
							playSound("progress_loop")
							setSendingDisabled(false)
							setClineAsk("mistake_limit_reached")
							setEnableButtons(true)
							setPrimaryButtonText(t("chat:proceedAnyways.title"))
							setSecondaryButtonText(t("chat:startNewTask.title"))
							break
						case "followup":
							setSendingDisabled(isPartial)
							setClineAsk("followup")
							// setting enable buttons to `false` would trigger a focus grab when
							// the text area is enabled which is undesirable.
							// We have no buttons for this tool, so no problem having them "enabled"
							// to workaround this issue.  See #1358.
							setEnableButtons(true)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						case "tool": {
							const isEvaluating =
								approvalMode === "auto" && messageToHandle.approvalState === "EVALUATING"
							const isAutoSuppress =
								approvalMode === "auto" && messageToHandle.approvalState !== "USER_DECISION_REQUIRED"
							setSendingDisabled(isPartial || isEvaluating)
							setClineAsk("tool")
							if (isEvaluating || isAutoSuppress) {
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
							} else {
								setEnableButtons(!isPartial)
								const tool = JSON.parse(messageToHandle.text || "{}") as ClineSayTool
								switch (tool.tool) {
									case "editedExistingFile":
									case "appliedDiff":
									case "newFileCreated":
										if (tool.batchDiffs && Array.isArray(tool.batchDiffs)) {
											setPrimaryButtonText(t("chat:edit-batch.approve.title"))
											setSecondaryButtonText(t("chat:edit-batch.deny.title"))
										} else {
											setPrimaryButtonText(t("chat:save.title"))
											setSecondaryButtonText(t("chat:reject.title"))
										}
										break
									case "generateImage":
										setPrimaryButtonText(t("chat:save.title"))
										setSecondaryButtonText(t("chat:reject.title"))
										break
									case "finishTask":
										setPrimaryButtonText(t("chat:completeSubtaskAndReturn"))
										setSecondaryButtonText(undefined)
										break
									case "readFile":
										if (tool.batchFiles && Array.isArray(tool.batchFiles)) {
											setPrimaryButtonText(t("chat:read-batch.approve.title"))
											setSecondaryButtonText(t("chat:read-batch.deny.title"))
										} else {
											setPrimaryButtonText(t("chat:approve.title"))
											setSecondaryButtonText(t("chat:reject.title"))
										}
										break
									case "listFilesTopLevel":
									case "listFilesRecursive":
										if (tool.batchDirs && Array.isArray(tool.batchDirs)) {
											setPrimaryButtonText(t("chat:list-batch.approve.title"))
											setSecondaryButtonText(t("chat:list-batch.deny.title"))
										} else {
											setPrimaryButtonText(t("chat:approve.title"))
											setSecondaryButtonText(t("chat:reject.title"))
										}
										break
									default:
										setPrimaryButtonText(t("chat:approve.title"))
										setSecondaryButtonText(t("chat:reject.title"))
										break
								}
							}
							break
						}
						case "command": {
							const isExecuting =
								!!messageToHandle?.text?.includes(COMMAND_OUTPUT_STRING) ||
								messageToHandle?.approvalState === "AUTO_APPROVED"
							const isEvaluating =
								approvalMode === "auto" && messageToHandle.approvalState === "EVALUATING"
							const isAutoSuppress =
								approvalMode === "auto" && messageToHandle.approvalState !== "USER_DECISION_REQUIRED"
							setSendingDisabled(isPartial || isEvaluating)
							setClineAsk("command")
							if (isAutoSuppress) {
								if (isExecuting) {
									setEnableButtons(true)
									setPrimaryButtonText(undefined)
									setSecondaryButtonText(t("chat:cancel.title"))
								} else {
									setEnableButtons(false)
									setPrimaryButtonText(undefined)
									setSecondaryButtonText(undefined)
								}
							} else if (isExecuting) {
								setEnableButtons(true)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(t("chat:cancel.title"))
							} else if (isEvaluating) {
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
							} else {
								setEnableButtons(!isPartial)
								setPrimaryButtonText(t("chat:runCommand.title"))
								setSecondaryButtonText(t("chat:reject.title"))
							}
							break
						}
						case "command_output":
							setSendingDisabled(false)
							setClineAsk("command_output")
							if (approvalMode === "auto") {
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
							} else {
								setEnableButtons(true)
								setPrimaryButtonText(t("chat:proceedWhileRunning.title"))
								setSecondaryButtonText(t("chat:killCommand.title"))
							}
							break
						case "use_mcp_server": {
							const isEvaluating =
								approvalMode === "auto" && messageToHandle.approvalState === "EVALUATING"
							const isAutoSuppress =
								approvalMode === "auto" && messageToHandle.approvalState !== "USER_DECISION_REQUIRED"
							setSendingDisabled(isPartial || isEvaluating)
							setClineAsk("use_mcp_server")
							if (isEvaluating || isAutoSuppress) {
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
							} else {
								setEnableButtons(!isPartial)
								setPrimaryButtonText(t("chat:approve.title"))
								setSecondaryButtonText(t("chat:reject.title"))
							}
							break
						}
						case "completion_result": {
							const isEvaluating = messageToHandle.approvalState === "EVALUATING"
							const hasTrailingSafetyWarning = messages
								.slice(messages.lastIndexOf(messageToHandle) + 1)
								.some((m) => m.say === "command_safety_warning")
							const isUserDecision =
								messageToHandle.approvalState === "USER_DECISION_REQUIRED" ||
								(!messageToHandle.isAnswered && hasTrailingSafetyWarning && !isEvaluating)

							const isBlockedOutcome =
								currentTaskItem?.status === "blocked" ||
								currentTaskItem?.isBlockedOutcome === true ||
								Boolean(
									messageToHandle.text &&
										/status:\s*BLOCKED|concluded as BLOCKED|item\(s\) marked 'blocked'/i.test(
											messageToHandle.text,
										),
								)

							// Only play celebration sound if task completion is confirmed (not evaluating, denied, or requiring user decision)
							// and there are no queued messages, and not a blocked outcome.
							if (
								!isPartial &&
								messageQueue.length === 0 &&
								!isEvaluating &&
								messageToHandle.approvalState !== "EVALUATING" &&
								!isUserDecision &&
								!isBlockedOutcome &&
								messageToHandle.approvalState !== "DENIED"
							) {
								if (!messageToHandle.ts || lastCelebratedMsgTsRef.current !== messageToHandle.ts) {
									if (messageToHandle.ts) {
										lastCelebratedMsgTsRef.current = messageToHandle.ts
									}
									playSound("celebration")
								}
							}
							setSendingDisabled(isPartial || isEvaluating)
							setClineAsk("completion_result")
							if (isUserDecision) {
								setEnableButtons(!isPartial)
								if (currentTaskItem?.parentTaskId) {
									setPrimaryButtonText(t("chat:completeSubtaskAndReturn"))
								} else {
									setPrimaryButtonText(t("chat:approve.title"))
								}
								setSecondaryButtonText(t("chat:reject.title"))
							} else {
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
							}
							break
						}
						case "resume_task": {
							if (messageToHandle.isAnswered || currentTaskItem?.status === "active") {
								setClineAsk(undefined)
								setEnableButtons(false)
								setPrimaryButtonText(undefined)
								setSecondaryButtonText(undefined)
								break
							}
							setSendingDisabled(false)
							setClineAsk("resume_task")
							setEnableButtons(false)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							setDidClickCancel(false) // special case where we reset the cancel button state
							break
						}
						case "resume_completed_task":
							setSendingDisabled(false)
							setClineAsk("resume_completed_task")
							setEnableButtons(false)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							setDidClickCancel(false)
							break
					}
					break
				case "say":
					// Don't want to reset since there could be a "say" after
					// an "ask" while ask is waiting for response.
					switch (lastMessage.say) {
						case "api_req_retry_delayed":
						case "api_req_rate_limit_wait":
							setSendingDisabled(true)
							break
						case "api_req_started": {
							// Clear button state when a new API request starts
							// This fixes buttons persisting when the task continues
							let reqData: any
							try {
								reqData = JSON.parse(lastMessage.text || "{}")
							} catch {}
							const isCancelled =
								reqData?.cancelReason !== undefined ||
								currentTaskItem?.status === "interrupted" ||
								currentTaskItem?.status === "completed"
							if (!isCancelled && reqData?.cost === undefined) {
								setSendingDisabled(true)
							} else {
								setSendingDisabled(false)
							}
							// Note: Do NOT clear selectedImages here. This handler fires
							// every time the backend starts an API call, which would wipe
							// images the user has pasted while the chat is in progress.
							// Images are already cleared in the appropriate user-action
							// handlers (handleSendMessage, handlePrimaryButtonClick, etc.).
							setClineAsk(undefined)
							setEnableButtons(false)
							setPrimaryButtonText(undefined)
							setSecondaryButtonText(undefined)
							break
						}
						case "api_req_finished":
						case "error":
						case "text":
						case "command_output":
						case "mcp_server_request_started":
						case "mcp_server_response":
							if (
								!isPartial &&
								messageQueue.length === 0 &&
								lastMessage.approvalState === "AUTO_APPROVED"
							) {
								if (!lastMessage.ts || lastCelebratedMsgTsRef.current !== lastMessage.ts) {
									if (lastMessage.ts) {
										lastCelebratedMsgTsRef.current = lastMessage.ts
									}
									playSound("celebration")
								}
							}
							break
						case "completion_result": {
							const isBlockedOutcome =
								currentTaskItem?.status === "blocked" ||
								currentTaskItem?.isBlockedOutcome === true ||
								Boolean(
									lastMessage.text &&
										/status:\s*BLOCKED|concluded as BLOCKED|item\(s\) marked 'blocked'/i.test(
											lastMessage.text,
										),
								)

							if (
								!isPartial &&
								messageQueue.length === 0 &&
								!isBlockedOutcome &&
								lastMessage.approvalState === "AUTO_APPROVED"
							) {
								if (!lastMessage.ts || lastCelebratedMsgTsRef.current !== lastMessage.ts) {
									if (lastMessage.ts) {
										lastCelebratedMsgTsRef.current = lastMessage.ts
									}
									playSound("celebration")
								}
							}
							break
						}
					}
					break
			}
		}
	}, [lastMessage, secondLastMessage, activeAskMessage, approvalMode, currentTaskItem?.status])

	useEffect(() => {
		if (messages.length === 0) {
			setSendingDisabled(false)
			setClineAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		}
	}, [messages.length])

	useEffect(() => {
		if (
			currentTaskItem?.status === "interrupted" ||
			currentTaskItem?.status === "completed" ||
			currentTaskItem?.status === "blocked"
		) {
			setSendingDisabled(false)
		}
	}, [currentTaskItem?.status])

	useEffect(() => {
		setExpandedRows({})
		everVisibleMessagesTsRef.current.clear()
		setCurrentFollowUpTs(null)
		setIsCondensing(false)

		if (!task?.ts) {
			setSendingDisabled(false)
		}

		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		userRespondedRef.current = false
	}, [task?.ts])

	useEffect(() => {
		if (isHidden) {
			everVisibleMessagesTsRef.current.clear()
		}
	}, [isHidden])

	useEffect(() => {
		const cache = everVisibleMessagesTsRef.current
		return () => {
			cache.clear()
		}
	}, [])

	const isStreaming = useMemo(() => {
		// Checking clineAsk isn't enough since messages effect may be called
		// again for a tool for example, set clineAsk to its value, and if the
		// next message is not an ask then it doesn't reset. This is likely due
		// to how much more often we're updating messages as compared to before,
		// and should be resolved with optimizations as it's likely a rendering
		// bug. But as a final guard for now, the cancel button will show if the
		// last message is not an ask.
		const isLastAsk = !!(modifiedMessages.at(-1)?.ask || activeAskMessage?.ask)

		const isToolCurrentlyAsking =
			isLastAsk && clineAsk !== undefined && enableButtons && primaryButtonText !== undefined

		if (isToolCurrentlyAsking) {
			return false
		}

		if (clineAsk === "resume_completed_task" || clineAsk === "resume_task") {
			return false
		}

		const isLastMessagePartial = modifiedMessages.at(-1)?.partial === true

		if (isLastMessagePartial) {
			return true
		} else {
			const lastApiReqStarted = findLast(
				modifiedMessages,
				(message: ClineMessage) => message.say === "api_req_started",
			)

			if (
				lastApiReqStarted &&
				lastApiReqStarted.text !== null &&
				lastApiReqStarted.text !== undefined &&
				lastApiReqStarted.say === "api_req_started"
			) {
				try {
					const parsed = JSON.parse(lastApiReqStarted.text)
					if (parsed.cancelReason !== undefined) {
						return false
					}
					const cost = parsed.cost

					if (cost === undefined) {
						return true // API request has not finished yet.
					}
				} catch {}
			}
		}

		return false
	}, [modifiedMessages, activeAskMessage, clineAsk, enableButtons, primaryButtonText])

	useEffect(() => {
		if (isStopping && !stopRequestIdRef.current) {
			const isTaskStopped =
				!isStreaming &&
				(clineAsk === "resume_task" ||
					clineAsk === "resume_completed_task" ||
					clineAsk === "completion_result" ||
					modifiedMessages.at(-1)?.partial !== true)
			if (isTaskStopped) {
				setIsStopping(false)
			}
		}
	}, [isStopping, isStreaming, clineAsk, modifiedMessages])

	useEffect(() => {
		if (stopAckTimeoutRef.current) clearTimeout(stopAckTimeoutRef.current)
		stopAckTimeoutRef.current = null
		stopRequestIdRef.current = null
		setIsStopping(false)
		setStopError(false)
	}, [currentTaskItem?.id])

	useEffect(
		() => () => {
			if (stopAckTimeoutRef.current) clearTimeout(stopAckTimeoutRef.current)
		},
		[],
	)

	useEffect(() => {
		setIsResuming(false)
	}, [currentTaskItem?.id, currentTaskItem?.status])
	const isInterruptedOrStopped = useMemo(() => {
		return (
			currentTaskItem?.status === "interrupted" ||
			currentTaskItem?.status === "completed" ||
			currentTaskItem?.status === "blocked"
		)
	}, [currentTaskItem?.status])

	const isTaskActive = useMemo(() => {
		if (!currentTaskItem) {
			return false
		}
		if (isStopping) {
			return true
		}
		if (isStreaming) {
			return true
		}
		if (
			clineAsk === "resume_task" ||
			clineAsk === "resume_completed_task" ||
			clineAsk === "completion_result" ||
			clineAsk === "api_req_failed"
		) {
			return false
		}
		if (clineAsk !== undefined && enableButtons && primaryButtonText !== undefined) {
			return false
		}
		if (activeAskMessage) {
			if (activeAskMessage.approvalState === "EVALUATING") {
				return true
			}
			if (activeAskMessage.ask !== "command_output") {
				return false
			}
		}
		const lastMsg = modifiedMessages.at(-1)
		if (
			(lastMsg?.say === "completion_result" && lastMsg.approvalState !== "DENIED") ||
			lastMsg?.ask === "completion_result"
		) {
			return false
		}
		if (lastMsg?.type === "ask" && !lastMsg.isAnswered && lastMsg.ask !== "command_output") {
			return false
		}
		if (clineAsk === "command_output") {
			return true
		}
		if (
			lastMsg?.ask === "command" &&
			(lastMsg?.approvalState === "AUTO_APPROVED" || lastMsg?.text?.includes(COMMAND_OUTPUT_STRING))
		) {
			return true
		}
		if (currentTaskItem.status === "active") {
			return true
		}
		return false
	}, [
		currentTaskItem,
		isStopping,
		isStreaming,
		clineAsk,
		enableButtons,
		primaryButtonText,
		activeAskMessage,
		modifiedMessages,
	])

	const isExecutionActive = useMemo(() => {
		if (isStreaming || isStopping || isTaskActive) {
			return true
		}
		if (currentTaskItem?.status === "active") {
			return true
		}
		if (activeAskMessage?.approvalState === "EVALUATING") {
			return true
		}
		if (clineAsk === "command_output") {
			return true
		}
		if (
			lastMessage?.ask === "command" &&
			(lastMessage?.approvalState === "AUTO_APPROVED" || lastMessage?.text?.includes(COMMAND_OUTPUT_STRING))
		) {
			return true
		}
		return false
	}, [isStreaming, isStopping, isTaskActive, currentTaskItem?.status, activeAskMessage, clineAsk, lastMessage])

	const canResume = useMemo(() => {
		// INVARIANT: When any execution is active, or task is actively transitioning/resuming, Continue MUST NEVER be visible.
		if (isExecutionActive || isResuming) {
			return false
		}
		// Task must not be delegated, awaiting child, completed, or blocked.
		if (
			currentTaskItem?.status === "delegated" ||
			currentTaskItem?.status === "completed" ||
			currentTaskItem?.status === "blocked" ||
			currentTaskItem?.awaitingChildId
		) {
			return false
		}
		if (clineAsk === "api_req_failed") {
			return false
		}
		// If there is an active ask requiring user decision (e.g. tool approval, command approval, followup, api_req_failed),
		// approval/decision controls take precedence over resume.
		if (
			activeAskMessage &&
			activeAskMessage.ask !== "resume_task" &&
			(activeAskMessage.approvalState === "USER_DECISION_REQUIRED" ||
				activeAskMessage.ask === "followup" ||
				activeAskMessage.ask === "tool" ||
				activeAskMessage.ask === "command" ||
				activeAskMessage.ask === "use_mcp_server" ||
				activeAskMessage.ask === "api_req_failed")
		) {
			return false
		}
		// Task is resumable if its canonical status is interrupted, or there is an actionable resume_task ask.
		const isStatusInterrupted = currentTaskItem?.status === "interrupted"
		const isActionableResumeAsk =
			(activeAskMessage?.ask === "resume_task" && !activeAskMessage.isAnswered) ||
			(clineAsk === "resume_task" &&
				(!lastMessage || lastMessage.ask !== "resume_task" || !lastMessage.isAnswered))

		return isStatusInterrupted || isActionableResumeAsk
	}, [
		isExecutionActive,
		isResuming,
		currentTaskItem?.status,
		currentTaskItem?.awaitingChildId,
		activeAskMessage,
		clineAsk,
		lastMessage,
	])

	const isModelDiff = useMemo(() => {
		const execModel = currentTaskItem?.executionModelId
		const execProvider = currentTaskItem?.executionProvider
		if (!execModel) return false
		const selectedId = selectedModel.id
		const selectedProvider = apiConfiguration?.apiProvider
		const isModelChanged = Boolean(selectedId && selectedId !== execModel)
		const isProviderChanged = Boolean(selectedProvider && execProvider && selectedProvider !== execProvider)
		return isModelChanged || isProviderChanged
	}, [
		currentTaskItem?.executionModelId,
		currentTaskItem?.executionProvider,
		selectedModel.id,
		apiConfiguration?.apiProvider,
	])

	const isModelDiffDuringResume = useMemo(() => {
		if (!canResume) return false
		return isModelDiff
	}, [canResume, isModelDiff])

	const resumeTargetName = useMemo(() => {
		return cleanModelDisplayName(selectedModel.id, selectedModel.info)
	}, [selectedModel.id, selectedModel.info])

	const resumeButtonText = useMemo(() => {
		if (isModelDiffDuringResume) {
			return `Switch to ${resumeTargetName} & Continue`
		}
		return undefined
	}, [isModelDiffDuringResume, resumeTargetName])

	const resumeButtonTooltip = useMemo(() => {
		if (isModelDiffDuringResume) {
			return `Switch execution to ${resumeTargetName} and continue the task`
		}
		return undefined
	}, [isModelDiffDuringResume, resumeTargetName])

	const effectivePrimaryButtonText = useMemo(() => {
		if (clineAsk === "api_req_failed" && isModelDiffDuringFailure) {
			return `Switch to ${resumeTargetName} & Resume`
		}
		if (primaryButtonText && isModelDiffDuringResume) {
			return `Switch to ${resumeTargetName} & Continue`
		}
		return primaryButtonText
	}, [clineAsk, isModelDiffDuringFailure, isModelDiffDuringResume, resumeTargetName, primaryButtonText])

	const effectiveSecondaryButtonText = useMemo(() => {
		if (clineAsk === "api_req_failed" && isModelDiffDuringFailure) {
			return `Retry with ${cleanModelDisplayName(currentTaskItem?.executionModelId || "original model")}`
		}
		if (secondaryButtonText && isModelDiffDuringResume) {
			return `Resume with ${cleanModelDisplayName(currentTaskItem?.executionModelId || "original model")}`
		}
		return secondaryButtonText
	}, [
		clineAsk,
		isModelDiffDuringFailure,
		isModelDiffDuringResume,
		currentTaskItem?.executionModelId,
		secondaryButtonText,
	])

	const markFollowUpAsAnswered = useCallback(() => {
		const lastFollowUpMessage = messagesRef.current.findLast((msg: ClineMessage) => msg.ask === "followup")
		if (lastFollowUpMessage) {
			setCurrentFollowUpTs(lastFollowUpMessage.ts)
		}
	}, [])

	const handleChatReset = useCallback(() => {
		// Clear any pending auto-approval timeout
		if (autoApproveTimeoutRef.current) {
			clearTimeout(autoApproveTimeoutRef.current)
			autoApproveTimeoutRef.current = null
		}
		// Reset user response flag for new message
		userRespondedRef.current = false

		// Only reset message-specific state, preserving mode.
		setInputValue("")
		setSendingDisabled(false)
		setSelectedImages([])
		setClineAsk(undefined)
		setEnableButtons(false)
		// Do not reset mode here as it should persist.
		// setPrimaryButtonText(undefined)
		// setSecondaryButtonText(undefined)
	}, [])

	/**
	 * Handles sending messages to the extension
	 * @param text - The message text to send
	 * @param images - Array of image data URLs to send with the message
	 */
	const handleSendMessage = useCallback(
		(text: string, images: string[]) => {
			if (!cwd && Boolean((window as any).__ROO_DESKTOP__)) {
				window.parent.postMessage({ type: "openProjectManager" }, "*")
				return
			}
			text = text.trim()

			if (text === "/compact") {
				if (currentTaskItem?.id) {
					setIsCondensing(true)
					setSendingDisabled(true)
					vscode.postMessage({ type: "compactTask", taskId: currentTaskItem.id })
				}
				setInputValue("")
				setSelectedImages([])
				return
			}

			if (text || images.length > 0) {
				// Intercept when the active provider is retired — show a
				// WarningRow instead of sending anything to the backend.
				if (apiConfiguration?.apiProvider && isRetiredProvider(apiConfiguration.apiProvider)) {
					setShowRetiredProviderWarning(true)
					return
				}
				// Queue message ONLY if task actively owns execution and cannot accept new turn:
				// - Queue has items (preserve FIFO order)
				// - API streaming is actively in progress (isStreaming)
				// - Command is running (command_output) - user's message should be queued for AI, not sent to terminal
				// - Task is busy (sendingDisabled), UNLESS the task is stopped/interrupted/completed/blocked
				const shouldQueue =
					messageQueue.length > 0 ||
					isStreaming ||
					clineAskRef.current === "command_output" ||
					(sendingDisabled && !isInterruptedOrStopped)

				const activeWebSearchMode = webSearchModeRef.current
				const webSearchModeProp =
					activeWebSearchMode && activeWebSearchMode !== "auto" ? { webSearchMode: activeWebSearchMode } : {}

				if (shouldQueue) {
					try {
						const queueDecisionSource =
							messageQueue.length > 0
								? "QUEUE_NON_EMPTY"
								: isStreaming
									? "STREAMING"
									: clineAskRef.current === "command_output"
										? "COMMAND_OUTPUT"
										: "SENDING_DISABLED"
						console.log(
							`[handleSendMessage] Queueing message (decision source: ${queueDecisionSource}, sendingDisabled=${sendingDisabled}, isInterruptedOrStopped=${isInterruptedOrStopped})`,
							text,
							images,
						)
						deleteDraft(cwd || "global", currentChatKeyRef.current)
						vscode.postMessage({
							type: "queueMessage",
							text,
							images,
							taskId: currentTaskItem?.id,
							...webSearchModeProp,
						})
						setInputValue("")
						setSelectedImages([])
						setWebSearchMode("auto")
					} catch (error) {
						console.error(
							`Failed to queue message: ${error instanceof Error ? error.message : String(error)}`,
						)
					}

					return
				}

				// Mark that user has responded - this prevents any pending auto-approvals.
				userRespondedRef.current = true

				if (messagesRef.current.length === 0) {
					inFlightDraftRef.current = {
						key: currentChatKeyRef.current,
						text,
						images,
						webSearchMode: activeWebSearchMode,
					}
					vscode.postMessage({ type: "newTask", text, images, ...webSearchModeProp })
				} else if (clineAskRef.current) {
					deleteDraft(cwd || "global", currentChatKeyRef.current)
					if (clineAskRef.current === "followup") {
						markFollowUpAsAnswered()
					}

					const shouldSwitchModel = isModelDiff

					// Use clineAskRef.current
					switch (
						clineAskRef.current // Use clineAskRef.current
					) {
						case "followup":
						case "tool":
						case "command": // User can provide feedback to a tool or command use.
						case "use_mcp_server":
						case "completion_result": // If this happens then the user has feedback for the completion result.
						case "resume_task":
						case "resume_completed_task":
						case "mistake_limit_reached":
							vscode.postMessage({
								type: "askResponse",
								askResponse: "messageResponse",
								...(shouldSwitchModel ? { switchModel: true, apiConfiguration } : {}),
								text,
								images,
								taskId: currentTaskItem?.id,
								...webSearchModeProp,
							})
							break
						// There is no other case that a textfield should be enabled.
					}
				} else {
					deleteDraft(cwd || "global", currentChatKeyRef.current)
					const shouldSwitchModel = isModelDiff
					// This is a new message in an ongoing task.
					vscode.postMessage({
						type: "askResponse",
						askResponse: "messageResponse",
						...(shouldSwitchModel ? { switchModel: true, apiConfiguration } : {}),
						text,
						images,
						taskId: currentTaskItem?.id,
						...webSearchModeProp,
					})
				}

				handleChatReset()
			}
		},
		[
			handleChatReset,
			markFollowUpAsAnswered,
			sendingDisabled,
			isStreaming,
			messageQueue.length,
			apiConfiguration,
			isModelDiff,
			isExecutionActive,
			currentTaskItem?.id,
			currentTaskItem?.status,
			cwd,
		], // messagesRef and clineAskRef are stable
	)

	const handleSetChatBoxMessage = useCallback(
		(text: string, images: string[]) => {
			// Avoid nested template literals by breaking down the logic
			let newValue = text

			if (inputValue !== "") {
				newValue = inputValue + " " + text
			}

			setInputValue(newValue)
			setSelectedImages([...selectedImages, ...images])
		},
		[inputValue, selectedImages],
	)

	const startNewTask = useCallback(() => {
		setShowRetiredProviderWarning(false)
		flushPendingDraft()
		saveDraft(cwd || "global", currentChatKeyRef.current, {
			text: inputValueRef.current,
			images: selectedImagesRef.current,
			webSearchMode: webSearchModeRef.current,
		})
		assignNewProvisionalId()
		vscode.postMessage({ type: "clearTask" })
	}, [cwd, assignNewProvisionalId])

	// Handle stop button click from textarea or header
	const handleStopTask = useCallback(() => {
		const taskId = currentTaskItem?.id || currentTaskId
		if (!taskId) return
		if (stopRequestIdRef.current?.startsWith(`${taskId}:`)) return
		const requestId = `${taskId}:${Date.now()}`
		stopRequestIdRef.current = requestId
		setStopError(false)
		setIsStopping(true)
		vscode.postMessage({ type: "cancelTask", taskId, requestId })
		setDidClickCancel(true)
		if (stopAckTimeoutRef.current) clearTimeout(stopAckTimeoutRef.current)
		stopAckTimeoutRef.current = setTimeout(() => {
			if (stopRequestIdRef.current === requestId) {
				stopRequestIdRef.current = null
				setIsStopping(false)
				setStopError(true)
			}
		}, 15000)
	}, [setDidClickCancel, currentTaskItem?.id, currentTaskId])

	// Handle enqueue button click from textarea
	const handleEnqueueCurrentMessage = useCallback(() => {
		const text = inputValue.trim()
		const activeWebSearchMode = webSearchModeRef.current
		const webSearchModeProp =
			activeWebSearchMode && activeWebSearchMode !== "auto" ? { webSearchMode: activeWebSearchMode } : {}
		if (text || selectedImages.length > 0) {
			vscode.postMessage({
				type: "queueMessage",
				text,
				images: selectedImages,
				taskId: currentTaskItem?.id,
				...webSearchModeProp,
			})
			setInputValue("")
			setSelectedImages([])
			setWebSearchMode("auto")
		}
	}, [inputValue, selectedImages, currentTaskItem?.id])

	const handleResumeTask = useCallback(() => {
		if (isResuming || isExecutionActive) {
			return
		}
		setIsResuming(true)
		vscode.postMessage({
			type: "askResponse",
			askResponse: "yesButtonClicked",
			...(isModelDiffDuringResume ? { switchModel: true, apiConfiguration } : {}),
			taskId: currentTaskItem?.id,
		})
		setClineAsk(undefined)
	}, [isResuming, isExecutionActive, isModelDiffDuringResume, apiConfiguration, currentTaskItem?.id])

	// This logic depends on the useEffect[messages] above to set clineAsk,
	// after which buttons are shown and we then send an askResponse to the
	// extension.
	const handlePrimaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = text?.trim()

			if (isModelDiffDuringResume) {
				vscode.postMessage({
					type: "askResponse",
					askResponse: "yesButtonClicked",
					switchModel: true,
					apiConfiguration,
					text: trimmedInput,
					images: images,
					taskId: currentTaskItem?.id,
				})
				setInputValue("")
				setSelectedImages([])
				setSendingDisabled(true)
				setClineAsk(undefined)
				setEnableButtons(false)
				setPrimaryButtonText(undefined)
				setSecondaryButtonText(undefined)
				return
			}

			switch (clineAsk) {
				case "api_req_failed":
				case "command":
				case "tool":
				case "use_mcp_server":
				case "mistake_limit_reached":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							switchModel: clineAsk === "api_req_failed" && isModelDiffDuringFailure ? true : undefined,
							apiConfiguration:
								clineAsk === "api_req_failed" && isModelDiffDuringFailure
									? apiConfiguration
									: undefined,
							text: trimmedInput,
							images: images,
							taskId: currentTaskItem?.id,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							switchModel: clineAsk === "api_req_failed" && isModelDiffDuringFailure ? true : undefined,
							apiConfiguration:
								clineAsk === "api_req_failed" && isModelDiffDuringFailure
									? apiConfiguration
									: undefined,
							taskId: currentTaskItem?.id,
						})
					}
					break
				case "resume_task":
					// For completed subtasks (tasks with a parentTaskId and a completion_result),
					// start a new task instead of resuming since the subtask is done
					const isCompletedSubtaskForClick =
						currentTaskItem?.parentTaskId &&
						messagesRef.current.some(
							(msg) =>
								(msg.ask === "completion_result" || msg.say === "completion_result") &&
								msg.approvalState !== "DENIED",
						)
					if (isCompletedSubtaskForClick) {
						startNewTask()
					} else {
						// Only send text/images if they exist
						if (trimmedInput || (images && images.length > 0)) {
							vscode.postMessage({
								type: "askResponse",
								askResponse: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								taskId: currentTaskItem?.id,
							})
							// Clear input state after sending
							setInputValue("")
							setSelectedImages([])
						} else {
							vscode.postMessage({
								type: "askResponse",
								askResponse: "yesButtonClicked",
								taskId: currentTaskItem?.id,
							})
						}
					}
					break
				case "completion_result":
					if (
						primaryButtonText === t("chat:approve.title") ||
						primaryButtonText === t("chat:completeSubtaskAndReturn")
					) {
						if (trimmedInput || (images && images.length > 0)) {
							vscode.postMessage({
								type: "askResponse",
								askResponse: "yesButtonClicked",
								text: trimmedInput,
								images: images,
								taskId: currentTaskItem?.id,
							})
							setInputValue("")
							setSelectedImages([])
						} else {
							vscode.postMessage({
								type: "askResponse",
								askResponse: "yesButtonClicked",
								taskId: currentTaskItem?.id,
							})
						}
					} else {
						startNewTask()
					}
					break
				case "resume_completed_task":
					// Waiting for feedback, but we can just present a new task button
					startNewTask()
					break
				case "command_output":
					vscode.postMessage({
						type: "terminalOperation",
						terminalOperation: "continue",
						taskId: currentTaskItem?.id,
					})
					break
			}

			setSendingDisabled(true)
			setClineAsk(undefined)
			setEnableButtons(false)
			setPrimaryButtonText(undefined)
			setSecondaryButtonText(undefined)
		},
		[
			clineAsk,
			startNewTask,
			currentTaskItem?.parentTaskId,
			currentTaskItem?.id,
			primaryButtonText,
			t,
			isModelDiffDuringFailure,
			isModelDiffDuringResume,
			apiConfiguration,
		],
	)

	const handleSecondaryButtonClick = useCallback(
		(text?: string, images?: string[]) => {
			// Mark that user has responded
			userRespondedRef.current = true

			const trimmedInput = text?.trim()

			if (isStreaming) {
				handleStopTask()
				return
			}

			if (isModelDiffDuringResume) {
				vscode.postMessage({
					type: "askResponse",
					askResponse: "yesButtonClicked",
					switchModel: false,
					text: trimmedInput,
					images: images,
					taskId: currentTaskItem?.id,
				})
				setInputValue("")
				setSelectedImages([])
				setSendingDisabled(true)
				setClineAsk(undefined)
				setEnableButtons(false)
				setPrimaryButtonText(undefined)
				setSecondaryButtonText(undefined)
				return
			}

			switch (clineAsk) {
				case "api_req_failed":
					if (isModelDiffDuringFailure) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							switchModel: false,
							taskId: currentTaskItem?.id,
						})
					} else {
						startNewTask()
					}
					break
				case "mistake_limit_reached":
					startNewTask()
					break
				case "completion_result":
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images,
							taskId: currentTaskItem?.id,
						})
						setInputValue("")
						setSelectedImages([])
					} else {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							taskId: currentTaskItem?.id,
						})
					}
					break
				case "command":
					if (
						secondaryButtonText === t("chat:cancel.title") ||
						messagesRef.current.at(-1)?.text?.includes(COMMAND_OUTPUT_STRING)
					) {
						handleStopTask()
						break
					}
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images,
							taskId: currentTaskItem?.id,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						// Responds to the API with a "This operation failed" and lets it try again
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							taskId: currentTaskItem?.id,
						})
					}
					break
				case "tool":
				case "use_mcp_server":
					// Only send text/images if they exist
					if (trimmedInput || (images && images.length > 0)) {
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							text: trimmedInput,
							images: images,
							taskId: currentTaskItem?.id,
						})
						// Clear input state after sending
						setInputValue("")
						setSelectedImages([])
					} else {
						// Responds to the API with a "This operation failed" and lets it try again
						vscode.postMessage({
							type: "askResponse",
							askResponse: "noButtonClicked",
							taskId: currentTaskItem?.id,
						})
					}
					break
				case "command_output":
					vscode.postMessage({
						type: "terminalOperation",
						terminalOperation: "abort",
						taskId: currentTaskItem?.id,
					})
					break
			}
			setSendingDisabled(true)
			setClineAsk(undefined)
			setEnableButtons(false)
		},
		[
			clineAsk,
			startNewTask,
			isStreaming,
			setDidClickCancel,
			secondaryButtonText,
			t,
			currentTaskItem?.id,
			handleStopTask,
			isModelDiffDuringFailure,
			isModelDiffDuringResume,
		],
	)

	const selectImages = useCallback(() => vscode.postMessage({ type: "selectImages" }), [])

	const shouldDisableImages = !model?.supportsImages || selectedImages.length >= MAX_IMAGES_PER_MESSAGE

	const handleMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			switch (message.type) {
				case "taskStopAcknowledged":
					if (message.requestId === stopRequestIdRef.current) {
						if (stopAckTimeoutRef.current) clearTimeout(stopAckTimeoutRef.current)
						stopAckTimeoutRef.current = null
						stopRequestIdRef.current = null
						setIsStopping(false)
						setStopError(message.success !== true)
						setSendingDisabled(false)
					}
					break
				case "action":
					switch (message.action!) {
						case "didBecomeVisible":
							if (!isHidden && !sendingDisabled && !enableButtons) {
								textAreaRef.current?.focus({ preventScroll: true })
							}
							break
						case "focusInput":
							textAreaRef.current?.focus({ preventScroll: true })
							break
						case "clearTask":
							flushPendingDraft()
							saveDraft(cwd || "global", currentChatKeyRef.current, {
								text: inputValueRef.current,
								images: selectedImagesRef.current,
								webSearchMode: webSearchModeRef.current,
							})
							assignNewProvisionalId()
							handleChatReset()
							break
					}
					break
				case "selectedImages":
					// Only handle selectedImages if it's not for editing context
					// When context is "edit", ChatRow will handle the images
					if (message.context !== "edit") {
						setSelectedImages((prevImages: string[]) =>
							appendImages(prevImages, message.images, MAX_IMAGES_PER_MESSAGE),
						)
					}
					break
				case "invoke":
					switch (message.invoke!) {
						case "newChat":
							flushPendingDraft()
							saveDraft(cwd || "global", currentChatKeyRef.current, {
								text: inputValueRef.current,
								images: selectedImagesRef.current,
								webSearchMode: webSearchModeRef.current,
							})
							assignNewProvisionalId()
							handleChatReset()
							break
						case "sendMessage":
							handleSendMessage(message.text ?? "", message.images ?? [])
							break
						case "setChatBoxMessage":
							handleSetChatBoxMessage(message.text ?? "", message.images ?? [])
							break
						case "primaryButtonClick":
							handlePrimaryButtonClick(message.text ?? "", message.images ?? [])
							break
						case "secondaryButtonClick":
							handleSecondaryButtonClick(message.text ?? "", message.images ?? [])
							break
					}
					break
				case "compactTaskProgress":
					setIsCondensing(true)
					setCompactionError(null)
					break
				case "taskCompacted":
					setIsCondensing(false)
					setSendingDisabled(false)
					if (message.error) {
						playErrorSound()
						setCompactionError(message.error)
					} else {
						setCompactionError(null)
						playSound("notification")
					}
					break
				case "condenseTaskContextStarted":
					// Handle both manual and automatic condensation start
					// In multi-task concurrency, only show spinner if message matches the active chat
					if (message.text) {
						if (!currentTaskItem?.id || message.text === currentTaskItem.id) {
							setIsCondensing(true)
						}
					}
					break
				case "condenseTaskContextResponse":
					if (message.text) {
						if (!currentTaskItem?.id || message.text === currentTaskItem.id) {
							if (isCondensing && sendingDisabled) {
								setSendingDisabled(false)
							}
							setIsCondensing(false)
						}
					}
					break
				case "checkpointInitWarning":
					setCheckpointWarning(message.checkpointWarning)
					break
				case "interactionRequired":
					playSound("notification")
					break
			}
			// textAreaRef.current is not explicitly required here since React
			// guarantees that ref will be stable across re-renders, and we're
			// not using its value but its reference.
		},
		[
			isCondensing,
			isHidden,
			sendingDisabled,
			enableButtons,
			handleChatReset,
			handleSendMessage,
			handleSetChatBoxMessage,
			handlePrimaryButtonClick,
			handleSecondaryButtonClick,
			setCheckpointWarning,
			playSound,
			playErrorSound,
		],
	)

	useEvent("message", handleMessage)

	const visibleMessages = useMemo(() => {
		// Pre-compute checkpoint hashes that have associated user messages for O(1) lookup
		const userMessageCheckpointHashes = new Set<string>()
		modifiedMessages.forEach((msg) => {
			if (
				msg.say === "user_feedback" &&
				msg.checkpoint &&
				msg.checkpoint["type"] === "user_message" &&
				msg.checkpoint["hash"]
			) {
				userMessageCheckpointHashes.add(msg.checkpoint["hash"] as string)
			}
		})

		// Remove the 500-message limit to prevent array index shifting
		// Virtuoso is designed to efficiently handle large lists through virtualization
		const newVisibleMessages = modifiedMessages.filter((message) => {
			// Filter out checkpoint_saved messages that should be suppressed
			if (message.say === "checkpoint_saved") {
				// Check if this checkpoint has the suppressMessage flag set
				if (
					message.checkpoint &&
					typeof message.checkpoint === "object" &&
					"suppressMessage" in message.checkpoint &&
					message.checkpoint.suppressMessage
				) {
					return false
				}
				// Also filter out checkpoint messages associated with user messages (legacy behavior)
				if (message.text && userMessageCheckpointHashes.has(message.text)) {
					return false
				}
			}

			if (everVisibleMessagesTsRef.current.has(message.ts)) {
				const alwaysHiddenOnceProcessedAsk: ClineAsk[] = [
					"api_req_failed",
					"resume_task",
					"resume_completed_task",
				]
				const alwaysHiddenOnceProcessedSay = [
					"api_req_finished",
					"api_req_retried",
					"api_req_deleted",
					"mcp_server_request_started",
				]
				if (message.ask && alwaysHiddenOnceProcessedAsk.includes(message.ask)) return false
				if (message.say && alwaysHiddenOnceProcessedSay.includes(message.say)) return false
				if (message.say === "text" && (message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				return true
			}

			switch (message.ask) {
				case "completion_result":
					if (message.text === "") return false
					break
				case "api_req_failed":
				case "resume_task":
				case "resume_completed_task":
					return false
			}
			switch (message.say) {
				case "api_req_finished":
				case "api_req_retried":
				case "api_req_deleted":
					return false
				case "api_req_retry_delayed":
				case "api_req_rate_limit_wait":
					const last1 = modifiedMessages.at(-1)
					const last2 = modifiedMessages.at(-2)
					if (last1?.ask === "resume_task" && last2 === message) {
						return true
					} else if (message !== last1) {
						return false
					}
					break
				case "text":
					if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) return false
					break
				case "mcp_server_request_started":
					return false
			}
			return true
		})

		const viewportStart = Math.max(0, newVisibleMessages.length - 100)
		newVisibleMessages
			.slice(viewportStart)
			.forEach((msg: ClineMessage) => everVisibleMessagesTsRef.current.set(msg.ts, true))

		return newVisibleMessages
	}, [modifiedMessages])

	useEffect(() => {
		const cleanupInterval = setInterval(() => {
			const cache = everVisibleMessagesTsRef.current
			const currentMessageIds = new Set(modifiedMessages.map((m: ClineMessage) => m.ts))
			const viewportMessages = visibleMessages.slice(Math.max(0, visibleMessages.length - 100))
			const viewportMessageIds = new Set(viewportMessages.map((m: ClineMessage) => m.ts))

			cache.forEach((_value: boolean, key: number) => {
				if (!currentMessageIds.has(key) && !viewportMessageIds.has(key)) {
					cache.delete(key)
				}
			})
		}, 60000)

		return () => clearInterval(cleanupInterval)
	}, [modifiedMessages, visibleMessages])

	useDebounceEffect(
		() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus({ preventScroll: true })
			}
		},
		50,
		[isHidden, sendingDisabled, enableButtons],
	)

	useEffect(() => {
		// This ensures the first message is not read, future user messages are
		// labeled as `user_feedback`.
		if (lastMessage && messages.length > 1) {
			if (
				typeof lastMessage.text === "string" && // has text (must be string for startsWith)
				(lastMessage.say === "text" || lastMessage.say === "completion_result") && // is a text message
				!lastMessage.partial && // not a partial message
				!lastMessage.text.startsWith("{") // not a json object
			) {
				let text = lastMessage?.text || ""
				const mermaidRegex = /```mermaid[\s\S]*?```/g
				// remove mermaid diagrams from text
				text = text.replace(mermaidRegex, "")
				// remove markdown from text
				text = removeMd(text)

				// ensure message is not a duplicate of last read message
				if (text !== lastTtsRef.current) {
					try {
						playTts(text)
						lastTtsRef.current = text
					} catch (error) {
						console.error("Failed to execute text-to-speech:", error)
					}
				}
			}
		}

		// Update previous value.
		setWasStreaming(isStreaming)
	}, [isStreaming, lastMessage, wasStreaming, messages.length])

	const groupedMessages = useMemo(() => {
		const filtered: ClineMessage[] = visibleMessages
		const isPendingAsk = (msg: ClineMessage) => msg.ts === activeAskMessage?.ts && !msg.isAnswered

		// Helper to check if a message is a read_file ask that should be batched
		const isReadFileAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool" || isPendingAsk(msg)) return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return tool.tool === "readFile" && !tool.batchFiles // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Helper to check if a message is a list_files ask that should be batched
		const isListFilesAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool" || isPendingAsk(msg)) return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return (
					(tool.tool === "listFilesTopLevel" || tool.tool === "listFilesRecursive") && !tool.batchDirs // Don't re-batch already batched
				)
			} catch {
				return false
			}
		}

		// Set of tool names that represent file-editing operations
		const editFileTools = new Set([
			"editedExistingFile",
			"appliedDiff",
			"newFileCreated",
			"insertContent",
			"searchAndReplace",
		])

		// Helper to check if a message is a file-edit ask that should be batched
		const isEditFileAsk = (msg: ClineMessage): boolean => {
			if (msg.type !== "ask" || msg.ask !== "tool" || isPendingAsk(msg)) return false
			try {
				const tool = JSON.parse(msg.text || "{}")
				return editFileTools.has(tool.tool) && !tool.batchDiffs // Don't re-batch already batched
			} catch {
				return false
			}
		}

		// Synthesize a batch of consecutive read_file asks into a single message
		const synthesizeReadFileBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchFiles = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						lineSnippet: tool.reason || "",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: `${tool.path}${tool.reason ? ` (${tool.reason})` : ""}`,
						content: tool.content || "",
					}
				} catch {
					return { path: "", lineSnippet: "", key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchFiles }),
			}
		}

		// Synthesize a batch of consecutive list_files asks into a single message
		const synthesizeListFilesBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchDirs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						recursive: tool.tool === "listFilesRecursive",
						isOutsideWorkspace: tool.isOutsideWorkspace || false,
						key: tool.path || "",
					}
				} catch {
					return { path: "", recursive: false, key: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDirs }),
			}
		}

		// Synthesize a batch of consecutive file-edit asks into a single message
		const synthesizeEditFileBatch = (batch: ClineMessage[]): ClineMessage => {
			const batchDiffs = batch.map((batchMsg) => {
				try {
					const tool = JSON.parse(batchMsg.text || "{}")
					return {
						path: tool.path || "",
						changeCount: 1,
						key: tool.path || "",
						content: tool.content || tool.diff || "",
						diffStats: tool.diffStats,
					}
				} catch {
					return { path: "", changeCount: 0, key: "", content: "" }
				}
			})

			let firstTool
			try {
				firstTool = JSON.parse(batch[0].text || "{}")
			} catch {
				return batch[0]
			}
			return {
				...batch[0],
				text: JSON.stringify({ ...firstTool, batchDiffs }),
			}
		}

		// Consolidate consecutive ask messages into batches
		const readFileBatched = batchConsecutive(filtered, isReadFileAsk, synthesizeReadFileBatch)
		const listFilesBatched = batchConsecutive(readFileBatched, isListFilesAsk, synthesizeListFilesBatch)
		const result = batchConsecutive(listFilesBatched, isEditFileAsk, synthesizeEditFileBatch)

		if (isCondensing) {
			result.push({
				type: "say",
				say: "condense_context",
				ts: Date.now(),
				partial: true,
			} as ClineMessage)
		}
		return result
	}, [isCondensing, visibleMessages, activeAskMessage])

	const [expandedActivities, setExpandedActivities] = useState<Record<number, boolean>>({})
	const [focusedActivityMessage, setFocusedActivityMessage] = useState<number>()
	useEffect(() => {
		setExpandedActivities({})
		setFocusedActivityMessage(undefined)
	}, [task?.ts])
	const feed = useMemo(
		() =>
			buildAgentFeed(
				groupedMessages,
				enableButtons && primaryButtonText ? activeAskMessage?.ts : undefined,
				clineAsk === "api_req_failed",
			),
		[groupedMessages, activeAskMessage?.ts, enableButtons, primaryButtonText, clineAsk],
	)

	const checkpointTargets = useMemo(() => {
		const targets: { index: number; ts: number }[] = []
		for (let i = 0; i < feed.length; i++) {
			const item = feed[i]
			if (item.kind === "activity") {
				for (const message of item.messages) {
					if (message.say === "checkpoint_saved") targets.push({ index: i, ts: message.ts })
				}
			}
		}
		return targets
	}, [feed])
	const checkpointIndices = useMemo(() => checkpointTargets.map((target) => target.index), [checkpointTargets])

	const hasLatestCheckpoint = checkpointIndices.length > 0
	const checkpointJumpCursorRef = useRef<number | null>(null)

	useEffect(() => {
		checkpointJumpCursorRef.current = null
		prevExpandedRowsRef.current = undefined
	}, [task?.ts, checkpointIndices])

	// Scroll lifecycle is managed by a dedicated hook to keep ChatView focused
	// on message handling and UI orchestration.
	const {
		showScrollToBottom,
		handleRowHeightChange,
		handleListHeightChange,
		handleScrollToBottomClick,
		enterUserBrowsingHistory,
		followOutputCallback,
		atBottomStateChangeCallback,
		scrollToBottomAuto,
		setEditingMessage,
		isAtBottomRef,
		scrollPhaseRef,
	} = useScrollLifecycle({
		virtuosoRef,
		scrollContainerRef,
		taskTs: task?.ts,
		isStreaming,
		isHidden,
		hasTask: !!task,
	})

	// Expanding a row indicates the user is browsing; disable sticky follow.
	// Placed after the hook call so enterUserBrowsingHistory is defined.
	useEffect(() => {
		const prev = prevExpandedRowsRef.current
		let wasAnyRowExpandedByUser = false
		if (prev) {
			for (const [tsKey, isExpanded] of Object.entries(expandedRows)) {
				const ts = Number(tsKey)
				if (isExpanded && !(prev[ts] ?? false)) {
					wasAnyRowExpandedByUser = true
					break
				}
			}
		}

		if (wasAnyRowExpandedByUser) {
			enterUserBrowsingHistory("row-expansion")
		}

		prevExpandedRowsRef.current = expandedRows
	}, [enterUserBrowsingHistory, expandedRows])

	const handleSetExpandedRow = useCallback(
		(ts: number, expand?: boolean) => {
			setExpandedRows((prev: Record<number, boolean>) => ({
				...prev,
				[ts]: expand === undefined ? !prev[ts] : expand,
			}))
		},
		[setExpandedRows], // setExpandedRows is stable
	)

	// Scroll when user toggles certain rows.
	const toggleRowExpansion = useCallback(
		(ts: number) => {
			handleSetExpandedRow(ts)
			// The logic to set disableAutoScrollRef.current = true on expansion
			// is now handled by the useEffect hook that observes expandedRows.
		},
		[handleSetExpandedRow],
	)

	// Effect to clear checkpoint warning when messages appear or task changes
	useEffect(() => {
		if (isHidden || !task) {
			setCheckpointWarning(undefined)
		}
	}, [modifiedMessages.length, isStreaming, isHidden, task])

	const placeholderText = task ? t("chat:typeMessage") : t("chat:typeTask")

	const switchToMode = useCallback(
		(modeSlug: string): void => {
			// Update local state and notify extension to sync mode change.
			setMode(modeSlug)

			// Send the mode switch message.
			vscode.postMessage({ type: "mode", text: modeSlug })
		},
		[setMode],
	)

	const handleSuggestionClickInRow = useCallback(
		(suggestion: SuggestionItem, event?: React.MouseEvent) => {
			// Mark that user has responded if this is a manual click (not auto-approval)
			if (event) {
				userRespondedRef.current = true
			}

			// Mark the current follow-up question as answered when a suggestion is clicked
			if (clineAsk === "followup" && !event?.shiftKey) {
				markFollowUpAsAnswered()
			}

			// Check if we need to switch modes
			if (suggestion.mode) {
				// Only switch modes if it's a manual click (event exists) or auto-approval is allowed
				const isManualClick = !!event
				if (isManualClick || alwaysAllowModeSwitch) {
					// Switch mode without waiting
					switchToMode(suggestion.mode)
				}
			}

			if (event?.shiftKey) {
				// Always append to existing text, don't overwrite
				setInputValue((currentValue: string) => {
					return currentValue !== "" ? `${currentValue} \n${suggestion.answer}` : suggestion.answer
				})
			} else {
				// Don't clear the input value when sending a follow-up choice
				// The message should be sent but the text area should preserve what the user typed
				const preservedInput = inputValueRef.current
				handleSendMessage(suggestion.answer, [])
				// Restore the input value after sending
				setInputValue(preservedInput)
			}
		},
		[handleSendMessage, setInputValue, switchToMode, alwaysAllowModeSwitch, clineAsk, markFollowUpAsAnswered],
	)

	const handleBatchFileResponse = useCallback(
		(response: { [key: string]: boolean }) => {
			// Handle batch file response, e.g., for file uploads
			vscode.postMessage({
				type: "askResponse",
				askResponse: "objectResponse",
				text: JSON.stringify(response),
				taskId: currentTaskItem?.id,
			})
		},
		[currentTaskItem?.id],
	)

	// Cancel backend auto-approval timeout when FollowUpSuggest's countdown effect cleans up.
	// This is called when auto-approve is toggled off, a suggestion is clicked, or the component unmounts.
	const handleFollowUpUnmount = useCallback(() => {
		vscode.postMessage({ type: "cancelAutoApproval", taskId: currentTaskItem?.id })
	}, [currentTaskItem?.id])

	const handleScrollToBottomAndResetCheckpointCursor = useCallback(() => {
		checkpointJumpCursorRef.current = null
		handleScrollToBottomClick()
	}, [handleScrollToBottomClick])

	const handleScrollToLatestCheckpoint = useCallback(() => {
		if (checkpointIndices.length === 0) {
			return
		}

		const previousCursor = checkpointJumpCursorRef.current
		const nextCursor = previousCursor === null ? checkpointIndices.length - 1 : Math.max(0, previousCursor - 1)
		const nextCheckpointIndex = checkpointIndices[nextCursor]
		const checkpointItem = feed[nextCheckpointIndex]
		setExpandedActivities((previous) => ({ ...previous, [checkpointItem.ts]: true }))
		setFocusedActivityMessage(checkpointTargets[nextCursor].ts)
		checkpointJumpCursorRef.current = nextCursor

		enterUserBrowsingHistory("keyboard-nav-up")
		virtuosoRef.current?.scrollToIndex({
			index: nextCheckpointIndex,
			align: "center",
			behavior: "smooth",
		})
	}, [checkpointIndices, checkpointTargets, enterUserBrowsingHistory, feed])

	const renderFeedMessage = useCallback(
		(messageOrGroup: ClineMessage) => {
			const hasCheckpoint = modifiedMessages.some((message) => message.say === "checkpoint_saved")
			const isLast = messageOrGroup.ts === groupedMessages.at(-1)?.ts

			// regular message
			return (
				<ChatRow
					key={messageOrGroup.ts}
					message={messageOrGroup}
					isExpanded={expandedRows[messageOrGroup.ts] || false}
					onToggleExpand={toggleRowExpansion} // This was already stabilized
					lastModifiedMessage={isLast ? modifiedMessages.at(-1) : undefined}
					isLast={isLast}
					onHeightChange={handleRowHeightChange}
					onSetEditingMessage={setEditingMessage}
					isStreaming={isStreaming}
					onSuggestionClick={handleSuggestionClickInRow} // This was already stabilized
					onBatchFileResponse={handleBatchFileResponse}
					onFollowUpUnmount={handleFollowUpUnmount}
					isFollowUpAnswered={messageOrGroup.isAnswered === true || messageOrGroup.ts === currentFollowUpTs}
					isFollowUpAutoApprovalPaused={isFollowUpAutoApprovalPaused}
					editable={
						messageOrGroup.type === "ask" &&
						messageOrGroup.ask === "tool" &&
						(() => {
							let tool: any = {}
							try {
								tool = JSON.parse(messageOrGroup.text || "{}")
							} catch (_) {
								if (messageOrGroup.text?.includes("updateTodoList")) {
									tool = { tool: "updateTodoList" }
								}
							}
							return tool.tool === "updateTodoList" && enableButtons && !!primaryButtonText
						})()
					}
					hasCheckpoint={hasCheckpoint}
					onJumpToPreviousCheckpoint={handleScrollToLatestCheckpoint}
				/>
			)
		},
		[
			expandedRows,
			toggleRowExpansion,
			modifiedMessages,
			groupedMessages,
			handleRowHeightChange,
			setEditingMessage,
			isStreaming,
			handleSuggestionClickInRow,
			handleBatchFileResponse,
			handleFollowUpUnmount,
			currentFollowUpTs,
			isFollowUpAutoApprovalPaused,
			enableButtons,
			primaryButtonText,
			handleScrollToLatestCheckpoint,
		],
	)

	const itemContent = useCallback(
		(index: number, item: AgentFeedItem) => {
			if (item.kind === "message") return renderFeedMessage(item.message)
			return (
				<AgentActivity
					messages={item.messages}
					active={index === feed.length - 1 && isExecutionActive && !isStopping}
					open={!!expandedActivities[item.ts]}
					onToggle={() =>
						setExpandedActivities((previous) => ({ ...previous, [item.ts]: !previous[item.ts] }))
					}
					onHeightChange={handleRowHeightChange}
					renderMessage={renderFeedMessage}
					focusMessageTs={focusedActivityMessage}
				/>
			)
		},
		[
			renderFeedMessage,
			feed.length,
			isExecutionActive,
			isStopping,
			expandedActivities,
			handleRowHeightChange,
			focusedActivityMessage,
		],
	)

	// Function to handle mode switching
	const switchToNextMode = useCallback(() => {
		const allModes = getAllModes(customModes)
		const currentModeIndex = allModes.findIndex((m) => m.slug === mode)
		const nextModeIndex = (currentModeIndex + 1) % allModes.length
		// Update local state and notify extension to sync mode change
		switchToMode(allModes[nextModeIndex].slug)
	}, [mode, customModes, switchToMode])

	// Function to handle switching to previous mode
	const switchToPreviousMode = useCallback(() => {
		const allModes = getAllModes(customModes)
		const currentModeIndex = allModes.findIndex((m) => m.slug === mode)
		const previousModeIndex = (currentModeIndex - 1 + allModes.length) % allModes.length
		// Update local state and notify extension to sync mode change
		switchToMode(allModes[previousModeIndex].slug)
	}, [mode, customModes, switchToMode])

	// Mode switching keyboard handler. Scroll-intent keyboard detection
	// (PageUp, Home, ArrowUp) is handled by useScrollLifecycle.
	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === ".") {
				event.preventDefault()
				if (event.shiftKey) {
					switchToPreviousMode()
				} else {
					switchToNextMode()
				}
			}
		},
		[switchToNextMode, switchToPreviousMode],
	)

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown)

		return () => {
			window.removeEventListener("keydown", handleKeyDown)
		}
	}, [handleKeyDown])

	useImperativeHandle(ref, () => ({
		acceptInput: () => {
			const hasInput = inputValue.trim() || selectedImages.length > 0

			// Special case: during command_output, queue the message instead of
			// triggering the primary button action (which would lose the message)
			if (clineAskRef.current === "command_output" && hasInput) {
				vscode.postMessage({
					type: "queueMessage",
					text: inputValue.trim(),
					images: selectedImages,
					taskId: currentTaskItem?.id,
				})
				setInputValue("")
				setSelectedImages([])
				return
			}

			const canSend =
				(!sendingDisabled ||
					currentTaskItem?.status === "interrupted" ||
					currentTaskItem?.status === "completed" ||
					currentTaskItem?.status === "blocked") &&
				!isProfileDisabled &&
				hasInput

			if (enableButtons && (effectivePrimaryButtonText || primaryButtonText)) {
				handlePrimaryButtonClick(inputValue, selectedImages)
			} else if (canSend) {
				handleSendMessage(inputValue, selectedImages)
			}
		},
	}))

	const handleCondenseContext = (taskId: string) => {
		if (isCondensing || sendingDisabled) {
			return
		}
		setIsCondensing(true)
		setSendingDisabled(true)
		vscode.postMessage({ type: "compactTask", taskId })
		vscode.postMessage({ type: "condenseTaskContextRequest", text: taskId })
	}

	const areButtonsVisible =
		showScrollToBottom ||
		effectivePrimaryButtonText ||
		effectiveSecondaryButtonText ||
		primaryButtonText ||
		secondaryButtonText

	const isHydratingPersistedTask =
		!task &&
		Boolean(
			(currentTaskId &&
				!currentTaskId.startsWith("provisional_") &&
				(!taskHistory.length || taskHistory.some((h) => h.id === currentTaskId))) ||
				(currentTaskItem?.id &&
					!currentTaskItem.id.startsWith("provisional_") &&
					(!taskHistory.length || taskHistory.some((h) => h.id === currentTaskItem.id))),
		)

	return (
		<div
			data-testid="chat-view"
			className={
				isHidden
					? "hidden"
					: "agent-work-view fixed top-0 left-0 right-0 bottom-0 flex flex-col overflow-hidden"
			}>
			{(showAnnouncement || showAnnouncementModal) && (
				<Announcement
					hideAnnouncement={() => {
						if (showAnnouncementModal) {
							setShowAnnouncementModal(false)
						}
						if (showAnnouncement) {
							hideAnnouncement()
						}
					}}
				/>
			)}
			{task ? (
				<>
					<TaskHeader
						task={task}
						latestUserPrompt={latestUserPrompt}
						tokensIn={reportedUsage.inputTokens}
						tokensOut={reportedUsage.outputTokens}
						usageIncomplete={reportedUsage.incomplete}
						requestsWithUsage={reportedUsage.requestsWithUsage}
						cacheWrites={apiMetrics.totalCacheWrites}
						cacheReads={apiMetrics.totalCacheReads}
						parentTaskId={currentTaskItem?.parentTaskId}
						contextTokens={apiMetrics.contextTokens}
						buttonsDisabled={(sendingDisabled && !isInterruptedOrStopped) || isCondensing}
						isCondensing={isCondensing}
						handleCondenseContext={handleCondenseContext}
						todos={latestTodos}
						isTaskActive={isTaskActive}
						isStopping={isStopping}
						onStop={handleStopTask}
						onNewChat={startNewTask}
					/>
					{stopError && (
						<div role="alert" className="px-4 text-vscode-errorForeground">
							{t("chat:stop.failed")}
						</div>
					)}

					{checkpointWarning && (
						<div className="w-full canvas-narrative">
							<CheckpointWarning warning={checkpointWarning} />
						</div>
					)}
				</>
			) : isHydratingPersistedTask ? (
				<div className="flex flex-col h-full items-center justify-center p-6 min-h-0 overflow-y-auto gap-3 text-vscode-descriptionForeground">
					<span className="codicon codicon-loading codicon-modifier-spin text-2xl" />
					<span className="text-sm">{t("chat:loadingTask", "Loading conversation...")}</span>
				</div>
			) : (
				<div className="agent-home">
					<div className="agent-home-inner">
						<div>
							<RooHero />
							{!cwd && (
								<div className="agent-project-empty">
									<p>{t("chat:emptyProject.description", "Select a project folder. The agent will work with its files, and conversations will be saved in the sidebar.")}</p>
									<button type="button" onClick={() => window.parent.postMessage({ type: "openProjectManager" }, "*")}>
										{t("chat:emptyProject.openButton", "Open project")}
									</button>
								</div>
							)}
							{taskHistory.length < 6 && (
								<div data-testid="roo-tips">
									<AgentStarters onSelect={(prompt) => { setInputValue(prompt); textAreaRef.current?.focus() }} />
								</div>
							)}
							{/* Everyone should see their task history if any */}
							{taskHistory.length > 0 && <HistoryPreview />}
						</div>
					</div>
				</div>
			)}

			{!task && !isHydratingPersistedTask && showWorktreesInHomeScreen && <WorktreeSelector />}

			{task && (
				<>
					<div className="grow flex" ref={scrollContainerRef}>
						<Virtuoso
							ref={virtuosoRef}
							key={task.ts}
							className="scrollable grow overflow-y-scroll mb-1"
							increaseViewportBy={{ top: 800, bottom: 400 }}
							data={feed}
							computeItemKey={(_, item) => item.ts}
							itemContent={itemContent}
							components={virtuosoComponents}
							followOutput={followOutputCallback}
							atBottomStateChange={atBottomStateChangeCallback}
							totalListHeightChanged={handleListHeightChange}
							atBottomThreshold={30}
						/>
					</div>
					<FileChangesPanel clineMessages={messages} />
					{areButtonsVisible && (
						<div className="w-full canvas-narrative">
							<div
								className={`agent-decision-actions flex h-9 items-center mb-1 ${
									showScrollToBottom ? "opacity-100" : enableButtons ? "opacity-100" : "opacity-50"
								}`}>
								{showScrollToBottom ? (
									<>
										<StandardTooltip content={t("chat:scrollToBottom")}>
											<Button
												variant="secondary"
												className={hasLatestCheckpoint ? "flex-1 mr-[6px]" : "flex-[2]"}
												onClick={handleScrollToBottomAndResetCheckpointCursor}>
												<span className="codicon codicon-chevron-down"></span>
											</Button>
										</StandardTooltip>
										{hasLatestCheckpoint && (
											<StandardTooltip content={t("chat:scrollToLatestCheckpoint")}>
												<Button
													variant="secondary"
													className="flex-1 ml-[6px]"
													onClick={handleScrollToLatestCheckpoint}
													aria-label={t("chat:scrollToLatestCheckpoint")}>
													<span className="codicon codicon-history"></span>
												</Button>
											</StandardTooltip>
										)}
									</>
								) : (
									<>
										{effectivePrimaryButtonText && (
											<StandardTooltip
												content={
													isModelDiffDuringFailure || isModelDiffDuringResume
														? "Switch execution to the newly selected model and resume the task"
														: effectivePrimaryButtonText === t("chat:retry.title")
															? t("chat:retry.tooltip")
															: effectivePrimaryButtonText === t("chat:save.title")
																? t("chat:save.tooltip")
																: effectivePrimaryButtonText === t("chat:approve.title")
																	? t("chat:approve.tooltip")
																	: effectivePrimaryButtonText ===
																		  t("chat:runCommand.title")
																		? t("chat:runCommand.tooltip")
																		: effectivePrimaryButtonText ===
																			  t("chat:startNewTask.title")
																			? t("chat:startNewTask.tooltip")
																			: effectivePrimaryButtonText ===
																				  t("chat:proceedAnyways.title")
																				? t("chat:proceedAnyways.tooltip")
																				: effectivePrimaryButtonText ===
																					  t(
																							"chat:proceedWhileRunning.title",
																					  )
																					? t(
																							"chat:proceedWhileRunning.tooltip",
																						)
																					: undefined
												}>
												<Button
													variant="primary"
													disabled={
														!enableButtons &&
														!isModelDiffDuringFailure &&
														!isModelDiffDuringResume
													}
													className={
														effectiveSecondaryButtonText
															? "flex-1 mr-[6px]"
															: "flex-[2] mr-0"
													}
													onClick={() =>
														handlePrimaryButtonClick(inputValue, selectedImages)
													}>
													{effectivePrimaryButtonText}
												</Button>
											</StandardTooltip>
										)}
										{effectiveSecondaryButtonText && (
											<StandardTooltip
												content={
													isModelDiffDuringFailure || isModelDiffDuringResume
														? `Resume the task using the current task model (${currentTaskItem?.executionModelId})`
														: effectiveSecondaryButtonText === t("chat:startNewTask.title")
															? t("chat:startNewTask.tooltip")
															: effectiveSecondaryButtonText === t("chat:reject.title")
																? t("chat:reject.tooltip")
																: effectiveSecondaryButtonText ===
																	  t("chat:killCommand.title")
																	? t("chat:killCommand.tooltip")
																	: effectiveSecondaryButtonText ===
																		  t("chat:cancel.title")
																		? t("chat:cancel.tooltip")
																		: undefined
												}>
												<Button
													variant="secondary"
													disabled={
														!enableButtons &&
														!isModelDiffDuringFailure &&
														!isModelDiffDuringResume
													}
													className={
														effectivePrimaryButtonText ? "flex-1 ml-[6px]" : "w-full"
													}
													onClick={() =>
														handleSecondaryButtonClick(inputValue, selectedImages)
													}>
													{effectiveSecondaryButtonText}
												</Button>
											</StandardTooltip>
										)}
									</>
								)}
							</div>
						</div>
					)}
				</>
			)}

			<div className="w-full canvas-narrative">
				<QueuedMessages
					queue={messageQueue}
					onRemove={(idOrIndex, index) => {
						const msg =
							typeof idOrIndex === "string"
								? messageQueue.find((m) => m.id === idOrIndex)
								: (messageQueue[idOrIndex] ?? (index !== undefined ? messageQueue[index] : undefined))
						const messageId = msg ? msg.id : typeof idOrIndex === "string" ? idOrIndex : undefined
						if (messageId) {
							vscode.postMessage({
								type: "removeQueuedMessage",
								text: messageId,
								taskId: currentTaskItem?.id,
							})
						}
					}}
					onUpdate={(index, newText) => {
						if (messageQueue[index]) {
							vscode.postMessage({
								type: "editQueuedMessage",
								payload: {
									id: messageQueue[index].id,
									text: newText,
									images: messageQueue[index].images,
								},
								taskId: currentTaskItem?.id,
							})
						}
					}}
				/>
				{showRetiredProviderWarning && (
					<div className="py-1">
						<WarningRow
							title={t("chat:retiredProvider.title")}
							message={t(
								apiConfiguration?.apiProvider === "roo"
									? "chat:retiredProvider.rooMessage"
									: "chat:retiredProvider.message",
							)}
							actionText={t("chat:retiredProvider.openSettings")}
							onAction={() => openSettings({ section: "providers", source: "retired_provider_warning" })}
						/>
					</div>
				)}
				{compactionError && (
					<div className="py-1">
						<WarningRow
							title={t("chat:compactionError.title", { defaultValue: "Context Compaction Failed" })}
							message={compactionError}
							actionText={t("chat:compactionError.dismiss", { defaultValue: "Dismiss" })}
							onAction={() => setCompactionError(null)}
						/>
					</div>
				)}
			</div>
			<ChatTextArea
				ref={textAreaRef}
				inputValue={inputValue}
				setInputValue={setInputValue}
				sendingDisabled={(sendingDisabled && !isInterruptedOrStopped) || isProfileDisabled}
				selectApiConfigDisabled={isStreaming}
				placeholderText={placeholderText}
				selectedImages={selectedImages}
				setSelectedImages={setSelectedImages}
				onSend={() => handleSendMessage(inputValue, selectedImages)}
				onResume={canResume ? handleResumeTask : undefined}
				resumeButtonText={resumeButtonText}
				resumeButtonTooltip={resumeButtonTooltip}
				onSelectImages={selectImages}
				shouldDisableImages={shouldDisableImages}
				onHeightChange={() => {
					if (isAtBottomRef.current && scrollPhaseRef.current !== "USER_BROWSING_HISTORY") {
						scrollToBottomAuto()
					}
				}}
				mode={mode}
				setMode={setMode}
				modeShortcutText={modeShortcutText}
				isStreaming={isStreaming}
				isTaskActive={isTaskActive}
				isStopping={isStopping}
				onStop={handleStopTask}
				onEnqueueMessage={handleEnqueueCurrentMessage}
				contextTokens={apiMetrics.contextTokens}
				webSearchMode={webSearchMode}
				setWebSearchMode={setWebSearchMode}
			/>

			{isProfileDisabled && (
				<div className="w-full canvas-narrative">
					<ProfileViolationWarning />
				</div>
			)}

			<div id="roo-portal" />
		</div>
	)
}

const ChatView = forwardRef(ChatViewComponent)

export default ChatView
