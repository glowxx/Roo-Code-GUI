import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import { v7 as uuidv7 } from "uuid"
import EventEmitter from "events"

import { AskIgnoredError } from "./AskIgnoredError"

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import debounce from "lodash.debounce"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"
import { Package } from "../../shared/package"
import { formatToolInvocation } from "../tools/helpers/toolResultFormatting"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderName,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ContextTruncation,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type ToolProgressStatus,
	type HistoryItem,
	type CreateTaskOptions,
	type ModelInfo,
	type ClineApiReqCancelReason,
	type ClineApiReqInfo,
	type CostPrecision,
	type CostSource,
	RooCodeEventName,
	TaskStatus,
	TodoItem,
	getApiProtocol,
	getModelId,
	setModelId,
	isRetiredProvider,
	isIdleAsk,
	isInteractiveAsk,
	isResumableAsk,
	isNonBlockingAsk,
	isSafetyModelConfigured,
	type SafetyEvaluationResult,
	type CompactSafetyContext,
	type TwoStageSafetyResult,
	type UnifiedApprovalRequest,
	type ApprovalActionType,
	type ApprovalDecisionResult,
	type CanonicalConstraint,
	VerifierFailureCategory,
	QueuedMessage,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_MCP_TOOLS_THRESHOLD,
	countEnabledMcpTools,
	modelSupportsReasoning,
	cleanModelDisplayName,
	type ExtensionState,
} from "@roo-code/types"
import { CommandSafetyJudge, SAFETY_EVALUATION_FALLBACK_RESULT } from "../security/CommandSafetyJudge"
import { ApprovalOrchestrator, isDeferredRetryableCategory } from "../security/ApprovalOrchestrator"
import { DeferredApprovalRecoveryController } from "../security/DeferredApprovalRecovery"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream, GroundingSource } from "../../api/transform/stream"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { ProviderRequestCoordinator } from "../../api/coordination/ProviderRequestCoordinator"
import { RequestPriority } from "../../api/coordination/types"

// shared
import { findLast, findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { getApiMetrics, hasTokenUsageChanged, hasToolUsageChanged } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug, getModeBySlug } from "../../shared/modes"
import { DiffStrategy, type ToolUse, type ToolParamName, toolParamNames } from "../../shared/tools"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../integrations/terminal/OutputInterceptor"

// utils
import { calculateApiCostAnthropic, calculateApiCostOpenAI } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { getTaskDirectoryPath } from "../../utils/storage"
import { normalizeTaskFilePath, computeFileHash } from "../tools/edit-recovery/EditRecoveryService"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"
import { buildNativeToolsArrayWithRestrictions } from "./build-tools"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { restoreTodoListForTask } from "../tools/UpdateTodoListTool"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage } from "../assistant-message"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import { manageContext, willManageContext } from "../context-management"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import {
	type ApiMessage,
	readApiMessages,
	saveApiMessages,
	readTaskMessages,
	saveTaskMessages,
	taskMetadata,
} from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import { checkContextWindowExceededError } from "../context/context-management/context-error-handling"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { getMessagesSinceLastSummary, summarizeConversation, getEffectiveApiHistory } from "../condense"
import { compactHistory } from "../context/ContextCompactor"
import { optimizeEffectiveApiHistory } from "../context/effectiveContext"
import {
	isTokenAuditEnabled,
	prepareTokenAuditRecord,
	logTokenAudit,
	recordProviderUsage,
	recordRequestTiming,
	recordCostAudit,
	type TokenAuditRecord,
} from "../telemetry/TokenAudit"
import { MessageQueueService } from "../message-queue/MessageQueueService"
import { AutoApprovalHandler, checkAutoApproval, type CheckAutoApprovalResult } from "../auto-approval"
import { MessageManager } from "../message-manager"
import { validateAndFixToolResultIds } from "./validateToolResultIds"
import { mergeConsecutiveApiMessages } from "./mergeConsecutiveApiMessages"
import { classifyApiError } from "../../api/providers/utils/error-classifier"
import { StreamAuditTracker, type StreamPhase } from "./StreamAudit"
import { buildTaskContract } from "./TaskContract"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes
const DEFAULT_USAGE_COLLECTION_TIMEOUT_MS = 5000 // 5 seconds
const FORCED_CONTEXT_REDUCTION_PERCENT = 75 // Keep 75% of context (remove 25%) on context window errors
const MAX_CONTEXT_WINDOW_RETRIES = 3 // Maximum retries for context window errors
export const MAX_API_RETRIES = 3 // Maximum retry attempts for API failures (first-chunk and mid-stream)
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000 // 45 seconds of silence between chunks during active streaming
export const REASONING_STREAM_IDLE_TIMEOUT_MS = 75_000 // 75 seconds for reasoning streams (P95 is 34s, covers P99 gap tolerance)
export const FIRST_CHUNK_TIMEOUT_MS = 60_000 // 60 seconds base time to first chunk
export const REASONING_FIRST_CHUNK_TIMEOUT_MS = 90_000 // 90 seconds for large prompts / reasoning models (P99 is 87.5s)
export const MAX_NO_PROGRESS_TIMEOUT_MS = 240_000 // 240 seconds (4 minutes) maximum silence without meaningful progress (guards against infinite no-op spam while accommodating high-latency tool generation on free clusters)

export interface TaskOptions extends CreateTaskOptions {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
	initialTodos?: TodoItem[]
	workspacePath?: string
	/** Initial status for the task's history item (e.g., "active" for child tasks) */
	initialStatus?: "active" | "delegated" | "completed" | "interrupted"
	/** Initial in-memory clineMessages to prevent empty-state flicker during rehydration */
	initialClineMessages?: ClineMessage[]
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly rootTaskId?: string
	readonly parentTaskId?: string
	childTaskId?: string
	pendingNewTaskToolCallId?: string

	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>
	private consecutiveReplanCount: number = 0
	private totalReplanCount: number = 0
	private deniedActionHistory: string[] = []
	private unresolvedDenialState: { actionType: string; reason: string; replanGuidance?: string } | null = null
	private consecutiveAttemptCompletionCount: number = 0
	private lastCompletionFingerprint: string | null = null
	private consecutiveIdenticalCompletionCount: number = 0
	private lastCompletionResultText?: string
	private approvalOrchestrator: ApprovalOrchestrator = new ApprovalOrchestrator()
	private lastFailedRequestFingerprint?: string
	private consecutiveIdenticalFailures: number = 0

	/**
	 * The API configuration name (provider profile) associated with this task.
	 * Persisted across sessions to maintain the provider profile when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskApiConfigName()`
	 * 3. Falls back to "default" if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.apiConfigName` during construction
	 * 2. Falls back to undefined if not stored in history (for backward compatibility)
	 *
	 * ## Important
	 * If you need a non-`undefined` provider profile (e.g., for profile-dependent operations),
	 * wait for `taskApiConfigReady` first (or use `getTaskApiConfigName()`).
	 * The sync `taskApiConfigName` getter may return `undefined` for backward compatibility.
	 *
	 * @private
	 * @see {@link getTaskApiConfigName} - For safe async access
	 * @see {@link taskApiConfigName} - For sync access after initialization
	 */
	private _taskApiConfigName: string | undefined

	/**
	 * Promise that resolves when the task API config name has been initialized.
	 * This ensures async API config name initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task API config name
	 * - Ensures provider state is properly loaded before profile-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 */
	private taskApiConfigReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	currentRequestAbortController?: AbortController
	currentStreamWatchdogTimer?: NodeJS.Timeout
	skipPrevResponseIdOnce: boolean = false

	// TaskStatus
	idleAsk?: ClineMessage
	resumableAsk?: ClineMessage
	interactiveAsk?: ClineMessage

	didFinishAbortingStream = false
	abandoned = false
	abortReason?: ClineApiReqCancelReason
	isInitialized = false
	isPaused: boolean = false

	// API
	apiConfiguration: ProviderSettings
	api: ApiHandler
	public readonly taskStartModel?: string
	public readonly taskStartProvider?: string
	public readonly taskStartEffort?: string
	static get lastGlobalApiRequestTime(): number | undefined {
		return ProviderRequestCoordinator.getInstance().getLastRequestTime()
	}
	static set lastGlobalApiRequestTime(val: number | undefined) {
		if (val !== undefined) {
			ProviderRequestCoordinator.getInstance().setLastRequestTime(val)
		}
	}
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		ProviderRequestCoordinator.resetInstance()
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	terminalProcess?: RooTerminalProcess

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number
	private autoApprovalTimeoutRef?: NodeJS.Timeout
	private deferredRecoveryController?: DeferredApprovalRecoveryController

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	consecutiveMistakeCountForEditFile: Map<string, number> = new Map()
	failedDiffHashesForPath: Map<string, Set<string>> = new Map()
	trackedFileVersions: Map<string, { hash: string; lineCount: number; timestamp: number }> = new Map()
	consecutiveNoToolUseCount: number = 0
	consecutiveNoAssistantMessagesCount: number = 0
	toolUsage: ToolUsage = {}

	recordFileReadVersion(relPath: string, content: string): void {
		const normalized = normalizeTaskFilePath(relPath)
		const lines = content.split(/\r?\n/)
		this.trackedFileVersions.set(normalized, {
			hash: computeFileHash(content),
			lineCount: lines.length,
			timestamp: Date.now(),
		})
	}

	getFileTrackedVersion(relPath: string): { hash: string; lineCount: number; timestamp: number } | undefined {
		const normalized = normalizeTaskFilePath(relPath)
		return this.trackedFileVersions.get(normalized)
	}

	clearEditFailureState(relPath?: string): void {
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
	}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointTimeout: number
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Message Queue Service
	public readonly messageQueueService: MessageQueueService
	private messageQueueStateChangedHandler: (() => void) | undefined

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false
	isTaskCompleted = false
	public isDelegatingCompletion = false

	public auditLifecycleState(event: string): void {
		const provider = this.providerRef.deref()
		const isProviderActive = typeof provider?.getCurrentTask === "function" ? provider.getCurrentTask()?.taskId === this.taskId : false
		const finalMsg = this.clineMessages.at(-1)
		const finalMessagePartial = finalMsg?.partial ?? false
		console.log(
			`[TaskLifecycleAudit] taskId=${this.taskId} event=${event} isTaskCompleted=${this.isTaskCompleted} isStreaming=${this.isStreaming} pendingAsk=${this.askResponse !== undefined ? false : Boolean(this.lastMessageTs)} pendingApproval=${Boolean(this.autoApprovalTimeoutRef)} pendingTools=${this.userMessageContent.length} finalMessagePartial=${finalMessagePartial} providerActiveTask=${isProviderActive} inputBlocked=${this.isStreaming || this.isTaskCompleted}`,
		)
	}

	public markTaskCompleted(): void {
		this.isTaskCompleted = true
		this.isStreaming = false
		this.isWaitingForFirstChunk = false
		if (this.historyItem) {
			this.historyItem.status = "completed"
			this.historyItem.needsAttention = false
		}

		// Clean up any trailing unclosed api_req_started messages from previous sessions
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")
		if (lastApiReqIndex !== -1) {
			const lastApiReq = this.clineMessages[lastApiReqIndex]
			if (lastApiReq.text) {
				try {
					const data = JSON.parse(lastApiReq.text)
					if (data.cost === undefined) {
						this.clineMessages.splice(lastApiReqIndex, 1)
					}
				} catch {}
			}
		}

		console.log(`[StreamAudit] Task ${this.taskId}.${this.instanceId} marked as completed. Breaking task loop.`)
		this.auditLifecycleState("attempt_completion_accepted")
	}
	private isCompacting = false
	private compactionAbortController?: AbortController
	private currentAuditRecord?: TokenAuditRecord
	private requestsSinceLastCompaction = 0
	private tokensInAtLastCompaction = 0
	private retryRetransmissionTokens = 0

	public abortCompaction(): void {
		this.compactionAbortController?.abort()
	}

	/**
	 * Flag indicating whether the assistant message for the current streaming session
	 * has been saved to API conversation history.
	 *
	 * This is critical for parallel tool calling: tools should NOT execute until
	 * the assistant message is saved. Otherwise, if a tool like `new_task` triggers
	 * `flushPendingToolResultsToHistory()`, the user message with tool_results would
	 * appear BEFORE the assistant message with tool_uses, causing API errors.
	 *
	 * Reset to `false` at the start of each API request.
	 * Set to `true` after the assistant message is saved in `recursivelyMakeClineRequests`.
	 */
	assistantMessageSavedToHistory = false

	/**
	 * Push a tool_result block to userMessageContent, preventing duplicates.
	 * Duplicate tool_use_ids cause API errors.
	 *
	 * @param toolResult - The tool_result block to add
	 * @returns true if added, false if duplicate was skipped
	 */
	public pushToolResultToUserContent(toolResult: Anthropic.ToolResultBlockParam): boolean {
		const existingResult = this.userMessageContent.find(
			(block): block is Anthropic.ToolResultBlockParam =>
				block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
		)
		if (existingResult) {
			console.warn(
				`[Task#pushToolResultToUserContent] Skipping duplicate tool_result for tool_use_id: ${toolResult.tool_use_id}`,
			)
			return false
		}
		this.userMessageContent.push(toolResult)
		return true
	}
	didRejectTool = false
	didAlreadyUseTool = false
	didToolFailInCurrentTurn = false
	didCompleteReadingStream = false
	private _started = false
	// No streaming parser is required.
	assistantMessageParser?: undefined
	private providerProfileChangeListener?: (config: {
		name: string
		provider?: string
		targetTaskId?: string
	}) => void | Promise<void>

	// Native tool call streaming state (track which index each tool is at)
	private streamingToolCallIndices: Map<string, number> = new Map()

	// Cached model info for current streaming session (set at start of each API request)
	// This prevents excessive getModel() calls during tool execution
	cachedStreamingModel?: { id: string; info: ModelInfo }

	// Token Usage Cache
	private tokenUsageSnapshot?: TokenUsage
	private tokenUsageSnapshotAt?: number

	// Tool Usage Cache
	private toolUsageSnapshot?: ToolUsage

	// Token Usage Throttling - Debounced emit function
	private readonly TOKEN_USAGE_EMIT_INTERVAL_MS = 2000 // 2 seconds
	private debouncedEmitTokenUsage: ReturnType<typeof debounce>

	// Cloud Sync Tracking
	// Initial status for the task's history item (set at creation time to avoid race conditions)
	private readonly initialStatus?: HistoryItem["status"]
	private currentStatus?: HistoryItem["status"]
	public historyItem?: HistoryItem

	// MessageManager for high-level message operations (lazy initialized)
	private _messageManager?: MessageManager

	constructor({
		provider,
		apiConfiguration,
		enableCheckpoints = true,
		checkpointTimeout = DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		taskId,
		task,
		images,
		historyItem,
		experiments: experimentsConfig,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
		initialTodos,
		workspacePath,
		initialStatus,
		initialClineMessages,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		if (
			!checkpointTimeout ||
			checkpointTimeout > MAX_CHECKPOINT_TIMEOUT_SECONDS ||
			checkpointTimeout < MIN_CHECKPOINT_TIMEOUT_SECONDS
		) {
			throw new Error(
				"checkpointTimeout must be between " +
					MIN_CHECKPOINT_TIMEOUT_SECONDS +
					" and " +
					MAX_CHECKPOINT_TIMEOUT_SECONDS +
					" seconds",
			)
		}

		this.taskId = historyItem ? historyItem.id : (taskId ?? uuidv7())
		this.rootTaskId = historyItem ? historyItem.rootTaskId : rootTask?.taskId
		this.parentTaskId = historyItem ? historyItem.parentTaskId : parentTask?.taskId
		this.childTaskId = undefined

		this.metadata = {
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: (workspacePath ?? getWorkspacePath(path.join(os.homedir(), "Desktop")))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize()?.catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = structuredClone(apiConfiguration)
		const executionModel = historyItem?.executionModelId || historyItem?.chatModelId
		if (executionModel) {
			const provider = (historyItem?.executionProvider || historyItem?.chatProvider || this.apiConfiguration.apiProvider) as ProviderName | undefined
			if (provider) {
				this.apiConfiguration.apiProvider = provider
				setModelId(this.apiConfiguration, provider, executionModel)
			}
			const effort = historyItem?.executionReasoningEffort !== undefined ? historyItem.executionReasoningEffort : historyItem?.chatReasoningEffort
			if (effort !== undefined) {
				if (effort === "disable") {
					this.apiConfiguration.reasoningEffort = "disable" as any
					this.apiConfiguration.enableReasoningEffort = false
				} else {
					this.apiConfiguration.reasoningEffort = effort as any
					this.apiConfiguration.enableReasoningEffort = true
				}
			}
		}
		this.taskStartModel = getModelId(this.apiConfiguration)
		this.taskStartProvider = this.apiConfiguration.apiProvider
		this.taskStartEffort = (this.apiConfiguration as any).reasoningEffort
		this.api = buildApiHandler(this.apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.checkpointTimeout = checkpointTimeout

		this.parentTask = parentTask
		this.taskNumber = taskNumber
		this.initialStatus = initialStatus
		this.historyItem = historyItem
		if (this.historyItem) {
			this.historyItem.executionModelId = this.historyItem.executionModelId || this.taskStartModel
			this.historyItem.executionProvider = this.historyItem.executionProvider || this.taskStartProvider
			if (this.historyItem.executionReasoningEffort === undefined) {
				this.historyItem.executionReasoningEffort = this.taskStartEffort
			}
			this.historyItem.chatModelId = this.historyItem.chatModelId || this.taskStartModel
			this.historyItem.chatProvider = this.historyItem.chatProvider || this.taskStartProvider
			if (this.historyItem.chatReasoningEffort === undefined) {
				this.historyItem.chatReasoningEffort = this.taskStartEffort
			}
		}

		if (initialClineMessages && initialClineMessages.length > 0) {
			this.clineMessages = [...initialClineMessages]
		}

		if (this.initialStatus === "completed" || this.historyItem?.status === "completed") {
			this.isTaskCompleted = true
		}
		this.currentStatus = this.initialStatus ?? this.historyItem?.status

		this.assistantMessageParser = undefined

		this.messageQueueService = new MessageQueueService(this.historyItem?.promptQueue ?? [])

		this.messageQueueStateChangedHandler = () => {
			this.emit(RooCodeEventName.TaskUserMessage, this.taskId)
			this.emit(RooCodeEventName.QueuedMessagesUpdated, this.taskId, this.messageQueueService.messages)
			this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()
			const currentQueue = structuredClone(this.messageQueueService.messages)
			if (this.historyItem) {
				this.historyItem.promptQueue = currentQueue
			}
			const provider = this.providerRef.deref()
			if (provider) {
				provider
					.updateTaskHistory({
						...(this.historyItem ?? { id: this.taskId }),
						id: this.taskId,
						promptQueue: currentQueue,
					} as HistoryItem)
					.catch((err) =>
						console.error(`[Task] Failed to persist promptQueue update for ${this.taskId}:`, err),
					)
			}
		}

		this.messageQueueService.on("stateChanged", this.messageQueueStateChangedHandler)

		// Listen for provider profile changes to update parser state
		this.setupProviderProfileChangeListener(provider)

		// Set up diff strategy
		this.diffStrategy = new MultiSearchReplaceDiffStrategy()

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		// Initialize todo list if provided
		if (initialTodos && initialTodos.length > 0) {
			this.todoList = initialTodos
		}

		// Initialize debounced token usage emit function
		// Uses debounce with maxWait to achieve throttle-like behavior:
		// - leading: true  - Emit immediately on first call
		// - trailing: true - Emit final state when updates stop
		// - maxWait        - Ensures at most one emit per interval during rapid updates (throttle behavior)
		this.debouncedEmitTokenUsage = debounce(
			(tokenUsage: TokenUsage, toolUsage: ToolUsage) => {
				const tokenChanged = hasTokenUsageChanged(tokenUsage, this.tokenUsageSnapshot)
				const toolChanged = hasToolUsageChanged(toolUsage, this.toolUsageSnapshot)

				if (tokenChanged || toolChanged) {
					this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage, toolUsage)
					this.tokenUsageSnapshot = tokenUsage
					this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts
					// Deep copy tool usage for snapshot
					this.toolUsageSnapshot = JSON.parse(JSON.stringify(toolUsage))
				}
			},
			this.TOKEN_USAGE_EMIT_INTERVAL_MS,
			{ leading: true, trailing: true, maxWait: this.TOKEN_USAGE_EMIT_INTERVAL_MS },
		)

		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this._taskApiConfigName = historyItem.apiConfigName
			this.taskModeReady = Promise.resolve()
			this.taskApiConfigReady = Promise.resolve()
		} else {
			this._taskMode = undefined
			this._taskApiConfigName = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			this.taskApiConfigReady = this.initializeTaskApiConfigName(provider)
		}

		onCreated?.(this)

		if (startTask) {
			this._started = true
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			if (typeof provider?.log === "function") {
				provider.log(errorMessage)
			} else {
				console.log(errorMessage)
			}
		}
	}

	/**
	 * Initialize the task API config name from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current API config name from provider state
	 * 2. Sets `_taskApiConfigName` to the fetched name or "default" if unavailable
	 * 3. Handles errors gracefully by falling back to "default"
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to "default" to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskApiConfigName(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()

			// Avoid clobbering a newer value that may have been set while awaiting provider state
			// (e.g., user switches provider profile immediately after task creation).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = state?.currentApiConfigName ?? "default"
			}
		} catch (error) {
			// If there's an error getting state, use the default profile (unless a newer value was set).
			if (this._taskApiConfigName === undefined) {
				this._taskApiConfigName = "default"
			}
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task API config name: ${error instanceof Error ? error.message : String(error)}`
			if (typeof provider?.log === "function") {
				provider.log(errorMessage)
			} else {
				console.log(errorMessage)
			}
		}
	}

	/**
	 * Sets up a listener for provider profile changes.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to listen to
	 */
	private setupProviderProfileChangeListener(provider: ClineProvider): void {
		// Only set up listener if provider has the on method (may not exist in test mocks)
		if (typeof provider.on !== "function") {
			return
		}

		this.providerProfileChangeListener = async (payload: {
			name: string
			provider?: string
			targetTaskId?: string
		}) => {
			try {
				const isForeground =
					!("foregroundTaskId" in provider) || (provider as any).foregroundTaskId === this.taskId
				const isTargeted = payload?.targetTaskId ? payload.targetTaskId === this.taskId : isForeground
				if (!isTargeted) {
					return
				}
				// INVARIANT: An active task's worker model is immutable throughout its entire lifecycle.
				// Profile changes occurring while a task is active are deferred to the next task.
				if (!this.isTaskCompleted && !this.abort) {
					return
				}
				const newState = await provider.getState()
				if (newState?.apiConfiguration) {
					this.updateApiConfiguration(newState.apiConfiguration)
				}
			} catch (error) {
				console.error(
					`[Task#${this.taskId}.${this.instanceId}] Failed to update API configuration on profile change:`,
					error,
				)
			}
		}

		provider.on(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}

		return this._taskMode
	}

	/**
	 * Wait for the task API config name to be initialized before proceeding.
	 * This method ensures that any operations depending on the task's provider profile
	 * will have access to the correct value.
	 *
	 * ## When to use
	 * - Before accessing provider profile-specific configurations
	 * - When switching between tasks with different provider profiles
	 * - Before operations that depend on the provider profile
	 *
	 * @returns Promise that resolves when the task API config name is initialized
	 * @public
	 */
	public async waitForApiConfigInitialization(): Promise<void> {
		return this.taskApiConfigReady
	}

	/**
	 * Get the task API config name asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task's provider profile as it guarantees
	 * the value is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskApiConfigReady` promise to resolve
	 * - Returns the initialized API config name or undefined as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * @returns Promise resolving to the task API config name string or undefined
	 * @public
	 */
	public async getTaskApiConfigName(): Promise<string | undefined> {
		await this.taskApiConfigReady
		return this._taskApiConfigName
	}

	/**
	 * Get the task API config name synchronously. This should only be used when you're certain
	 * that the value has already been initialized (e.g., after waitForApiConfigInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForApiConfigInitialization()`
	 * - In event handlers or callbacks where API config name is guaranteed to be initialized
	 *
	 * Note: Unlike taskMode, this getter does not throw if uninitialized since the API config
	 * name can legitimately be undefined (backward compatibility with tasks created before
	 * this feature was added).
	 *
	 * @returns The task API config name string or undefined
	 * @public
	 */
	public get taskApiConfigName(): string | undefined {
		return this._taskApiConfigName
	}

	/**
	 * Update the task's API config name. This is called when the user switches
	 * provider profiles while a task is active, allowing the task to remember
	 * its new provider profile.
	 *
	 * @param apiConfigName - The new API config name to set
	 * @internal
	 */
	public setTaskApiConfigName(apiConfigName: string | undefined): void {
		this._taskApiConfigName = apiConfigName
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string) {
		// Capture the encrypted_content / thought signatures from the provider (e.g., OpenAI Responses API, Google GenAI) if present.
		// We only persist data reported by the current response body.
		const handler = this.api as ApiHandler & {
			getResponseId?: () => string | undefined
			getEncryptedContent?: () => { encrypted_content: string; id?: string } | undefined
			getThoughtSignature?: () => string | undefined
			getSummary?: () => any[] | undefined
			getReasoningDetails?: () => any[] | undefined
		}

		if (message.role === "assistant") {
			const responseId = handler.getResponseId?.()
			const reasoningData = handler.getEncryptedContent?.()
			const thoughtSignature = handler.getThoughtSignature?.()
			const reasoningSummary = handler.getSummary?.()
			const reasoningDetails = handler.getReasoningDetails?.()

			// Only Anthropic's API expects/validates the special `thinking` content block signature.
			// Other providers (notably Gemini 3) use different signature semantics (e.g. `thoughtSignature`)
			// and require round-tripping the signature in their own format.
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)
			const isAnthropicProtocol = apiProtocol === "anthropic"

			// Start from the original assistant message
			const messageWithTs: any = {
				...message,
				...(responseId ? { id: responseId } : {}),
				ts: Date.now(),
			}

			// Store reasoning_details array if present (for models like Gemini 3)
			if (reasoningDetails) {
				messageWithTs.reasoning_details = reasoningDetails
			}

			// Store reasoning: Anthropic thinking (with signature), plain text (most providers), or encrypted (OpenAI Native)
			// Skip if reasoning_details already contains the reasoning (to avoid duplication)
			if (isAnthropicProtocol && reasoning && thoughtSignature && !reasoningDetails) {
				// Anthropic provider with extended thinking: Store as proper `thinking` block
				// This format passes through anthropic-filter.ts and is properly round-tripped
				// for interleaved thinking with tool use (required by Anthropic API)
				const thinkingBlock = {
					type: "thinking",
					thinking: reasoning,
					signature: thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						thinkingBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [thinkingBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thinkingBlock]
				}
			} else if (reasoning && !reasoningDetails) {
				// Other providers (non-Anthropic): Store as generic reasoning block
				const reasoningBlock = {
					type: "reasoning",
					text: reasoning,
					summary: reasoningSummary ?? ([] as any[]),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			} else if (reasoningData?.encrypted_content) {
				// OpenAI Native encrypted reasoning
				const reasoningBlock = {
					type: "reasoning",
					summary: [] as any[],
					encrypted_content: reasoningData.encrypted_content,
					...(reasoningData.id ? { id: reasoningData.id } : {}),
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						reasoningBlock,
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [reasoningBlock, ...messageWithTs.content]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [reasoningBlock]
				}
			}

			// For non-Anthropic providers (e.g., Gemini 3), persist the thought signature as its own
			// content block so converters can attach it back to the correct provider-specific fields.
			// Note: For Anthropic extended thinking, the signature is already included in the thinking block above.
			if (thoughtSignature && !isAnthropicProtocol) {
				const thoughtSignatureBlock = {
					type: "thoughtSignature",
					thoughtSignature,
				}

				if (typeof messageWithTs.content === "string") {
					messageWithTs.content = [
						{ type: "text", text: messageWithTs.content } satisfies Anthropic.Messages.TextBlockParam,
						thoughtSignatureBlock,
					]
				} else if (Array.isArray(messageWithTs.content)) {
					messageWithTs.content = [...messageWithTs.content, thoughtSignatureBlock]
				} else if (!messageWithTs.content) {
					messageWithTs.content = [thoughtSignatureBlock]
				}
			}

			this.apiConversationHistory.push(messageWithTs)
		} else {
			// For user messages, validate tool_result IDs ONLY when the immediately previous *effective* message
			// is an assistant message.
			//
			// If the previous effective message is also a user message (e.g., summary + a new user message),
			// validating against any earlier assistant message can incorrectly inject placeholder tool_results.
			const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
			const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
			const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []

			// If the previous effective message is NOT an assistant, convert tool_result blocks to text blocks.
			// This prevents orphaned tool_results from being filtered out by getEffectiveApiHistory.
			// This can happen when condensing occurs after the assistant sends tool_uses but before
			// the user responds - the tool_use blocks get condensed away, leaving orphaned tool_results.
			let messageToAdd = message
			if (lastEffective?.role !== "assistant" && Array.isArray(message.content)) {
				messageToAdd = {
					...message,
					content: message.content.map((block) =>
						block.type === "tool_result"
							? {
									type: "text" as const,
									text: `Tool result:\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
								}
							: block,
					),
				}
			}

			const isTaskActuallyCompleted =
				this.isTaskCompleted ||
				this.historyItem?.status === "completed" ||
				this.initialStatus === "completed"
			const validatedMessage = validateAndFixToolResultIds(messageToAdd, historyForValidation, {
				isTaskCompleted: isTaskActuallyCompleted,
			})
			const messageWithTs = { ...validatedMessage, ts: Date.now() }
			this.apiConversationHistory.push(messageWithTs)
		}

		await this.saveApiConversationHistory()
	}

	// NOTE: We intentionally do NOT mutate stored messages to merge consecutive user turns.
	// For API requests, consecutive same-role messages are merged via mergeConsecutiveApiMessages()
	// so rewind/edit behavior can still reference original message boundaries.

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	/**
	 * Flush any pending tool results to the API conversation history.
	 *
	 * This is critical when the task is about to be
	 * delegated (e.g., via new_task). Before delegation, if other tools were
	 * called in the same turn before new_task, their tool_result blocks are
	 * accumulated in `userMessageContent` but haven't been saved to the API
	 * history yet. If we don't flush them before the parent is disposed,
	 * the API conversation will be incomplete and cause 400 errors when
	 * the parent resumes (missing tool_result for tool_use blocks).
	 *
	 * NOTE: The assistant message is typically already in history by the time
	 * tools execute (added in recursivelyMakeClineRequests after streaming completes).
	 * So we usually only need to flush the pending user message with tool_results.
	 */
	public async flushPendingToolResultsToHistory(): Promise<boolean> {
		// Only flush if there's actually pending content to save
		if (this.userMessageContent.length === 0) {
			return true
		}

		// CRITICAL: Wait for the assistant message to be saved to API history first.
		// Without this, tool_result blocks would appear BEFORE tool_use blocks in the
		// conversation history, causing API errors like:
		// "unexpected `tool_use_id` found in `tool_result` blocks"
		//
		// This can happen when parallel tools are called (e.g., update_todo_list + new_task).
		// Tools execute during streaming via presentAssistantMessage, BEFORE the assistant
		// message is saved. When new_task triggers delegation, it calls this method to
		// flush pending results - but the assistant message hasn't been saved yet.
		//
		// The assistantMessageSavedToHistory flag is:
		// - Reset to false at the start of each API request
		// - Set to true after the assistant message is saved in recursivelyMakeClineRequests
		if (!this.assistantMessageSavedToHistory) {
			await pWaitFor(() => this.assistantMessageSavedToHistory || this.abort, {
				interval: 50,
				timeout: 30_000, // 30 second timeout as safety net
			}).catch(() => {
				// If timeout or abort, log and proceed anyway to avoid hanging
				console.warn(
					`[Task#${this.taskId}] flushPendingToolResultsToHistory: timed out waiting for assistant message to be saved`,
				)
			})
		}

		// If task was aborted while waiting, don't flush
		if (this.abort) {
			return false
		}

		// Save the user message with tool_result blocks
		const userMessage: Anthropic.MessageParam = {
			role: "user",
			content: this.userMessageContent,
		}

		// Validate and fix tool_result IDs when the previous *effective* message is an assistant message.
		const effectiveHistoryForValidation = getEffectiveApiHistory(this.apiConversationHistory)
		const lastEffective = effectiveHistoryForValidation[effectiveHistoryForValidation.length - 1]
		const historyForValidation = lastEffective?.role === "assistant" ? effectiveHistoryForValidation : []
		const isTaskActuallyCompleted =
			this.isTaskCompleted ||
			this.historyItem?.status === "completed" ||
			this.initialStatus === "completed"
		const validatedMessage = validateAndFixToolResultIds(userMessage, historyForValidation, {
			isTaskCompleted: isTaskActuallyCompleted,
		})
		const userMessageWithTs = { ...validatedMessage, ts: Date.now() }
		this.apiConversationHistory.push(userMessageWithTs as ApiMessage)

		const saved = await this.saveApiConversationHistory()

		if (saved) {
			// Clear the pending content since it's now saved
			this.userMessageContent = []
		} else {
			console.warn(
				`[Task#${this.taskId}] flushPendingToolResultsToHistory: save failed, retaining pending tool results in memory`,
			)
		}

		return saved
	}

	private async saveApiConversationHistory(): Promise<boolean> {
		try {
			await saveApiMessages({
				messages: structuredClone(this.apiConversationHistory),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
			return true
		} catch (error) {
			console.error("Failed to save API conversation history:", error)
			return false
		}
	}

	/**
	 * Public wrapper to retry saving the API conversation history.
	 * Uses exponential backoff: up to 3 attempts with delays of 100 ms, 500 ms, 1500 ms.
	 * Used by delegation flow when flushPendingToolResultsToHistory reports failure.
	 */
	public async retrySaveApiConversationHistory(): Promise<boolean> {
		const delays = [100, 500, 1500]

		for (let attempt = 0; attempt < delays.length; attempt++) {
			await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
			console.warn(
				`[Task#${this.taskId}] retrySaveApiConversationHistory: retry attempt ${attempt + 1}/${delays.length}`,
			)

			const success = await this.saveApiConversationHistory()

			if (success) {
				return true
			}
		}

		return false
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		const isForeground =
			!provider ||
			!("foregroundTaskId" in provider) ||
			(provider as any).foregroundTaskId === this.taskId
		if (isForeground) {
			// Avoid resending large, mostly-static fields (notably taskHistory) on every chat message update.
			// taskHistory is maintained in-memory in the webview and updated via taskHistoryItemUpdated.
			await provider?.postStateToWebviewWithoutTaskHistory()
		}
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	public async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		const isForeground =
			!provider ||
			!("foregroundTaskId" in provider) ||
			(provider as any).foregroundTaskId === this.taskId
		if (isForeground) {
			await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		}
		this.emit(RooCodeEventName.Message, { action: "updated", message })
	}

	public async saveClineMessages(): Promise<boolean> {
		try {
			await saveTaskMessages({
				messages: structuredClone(this.clineMessages),
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			if (this._taskApiConfigName === undefined) {
				await this.taskApiConfigReady
			}

			const currentStatus =
				this.isTaskCompleted || this.historyItem?.status === "completed"
					? "completed"
					: this.historyItem?.status === "delegated"
					? "delegated"
					: this.currentStatus ?? this.initialStatus

			const awaitingChildId = this.historyItem?.awaitingChildId
			const delegatedToId = this.historyItem?.delegatedToId
			const childIds = this.historyItem?.childIds

			const { historyItem, tokenUsage } = await taskMetadata({
				taskId: this.taskId,
				rootTaskId: this.rootTaskId,
				parentTaskId: this.parentTaskId,
				taskNumber: this.taskNumber,
				messages: this.clineMessages,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode.
				apiConfigName: this._taskApiConfigName, // Use the task's own provider profile, not the current provider profile.
				initialStatus: currentStatus,
				awaitingChildId,
				delegatedToId,
				childIds,
				chatModelId: this.historyItem?.chatModelId || getModelId(this.apiConfiguration),
				chatProvider: this.historyItem?.chatProvider || this.apiConfiguration?.apiProvider,
				chatReasoningEffort: this.historyItem?.chatReasoningEffort ?? (this.apiConfiguration as any)?.reasoningEffort,
				executionModelId: this.taskStartModel || this.historyItem?.executionModelId || getModelId(this.apiConfiguration),
				executionProvider: this.taskStartProvider || this.historyItem?.executionProvider || this.apiConfiguration?.apiProvider,
				executionReasoningEffort: this.taskStartEffort !== undefined ? this.taskStartEffort : this.historyItem?.executionReasoningEffort,
			})

			this.historyItem = historyItem

			// Emit token/tool usage updates using debounced function
			// The debounce with maxWait ensures:
			// - Immediate first emit (leading: true)
			// - At most one emit per interval during rapid updates (maxWait)
			// - Final state is emitted when updates stop (trailing: true)
			this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)

			if (this.messageQueueService) {
				historyItem.promptQueue = structuredClone(this.messageQueueService.messages)
			}

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
			return true
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
			return false
		}
	}

	private findMessageByTimestamp(ts: number): ClineMessage | undefined {
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].ts === ts) {
				return this.clineMessages[i]
			}
		}

		return undefined
	}

	private extractExplicitConstraints(): {
		constraints: string[]
		scopedWriteAllows: string[]
		supplementalWriteAllows: string[]
		scopedWriteDenies: string[]
		scopedGitAllows: string[]
		scopedGitDenies: string[]
		canonicalConstraints: CanonicalConstraint[]
	} {
		const constraints: string[] = []
		const canonicalConstraints: CanonicalConstraint[] = []
		const initialGoal = this.metadata?.task || ""

		// Negative modification directives
		const noModifyRegex = /(?:nie\s+(?:modyfikuj|zmieniaj|ruszaj|poprawiaj|naprawiaj)|do\s+not\s+(?:modify|change|touch)|don't\s+(?:modify|change|touch)|read-only|tylko\s+do\s+odczytu)/i
		const globalNoModifyRegex = /(?:(?:do\s+not|don't)\s+(?:modify|change|touch)\s+(?:code|files|anything)(?!\s+in\b)|nie\s+(?:modyfikuj|zmieniaj|ruszaj|poprawiaj|naprawiaj)\s+(?:kodu|plików|niczego)(?!\s+w\b)|read-only|tylko\s+do\s+odczytu)/i
		// Deactivation / lifting directives (positive overrides)
		const deactivationModifyRegex =
			/(?:disable.*read-only|lift.*read-only|remove.*read-only|allow.*modify|zezwalam.*modyfikacj|wyłącz.*read-only|zdejmij.*read-only|odblokuj.*edycj|odblokuj.*modyfikacj|you\s+can\s+modify|możesz(?:\s+jednak)?\s+modyfikować|now\s+fix|napraw|popraw|zaimplementuj|implement|update|edit|refactor|write\s+authorization)/i
		// Negative commit directives
		const noCommitRegex = /(?:nie\s+commituj|do\s+not\s+commit|don't\s+commit|no\s+commits?)/i
		// Negative build directives
		const noBuildRegex = /(?:nie\s+buduj(?:\s+candidate)?|do\s+not\s+build)/i
		// Negative sign directives
		const noSignRegex = /(?:nie\s+podpisuj(?:\s+release)?|do\s+not\s+sign)/i
		// Negative production activation directives
		const noActivateRegex = /(?:nie\s+wykonuj\s+production\s+activation|do\s+not\s+activate)/i
		// Negative promotion directives
		const noPromoteRegex = /(?:nie\s+promuj|do\s+not\s+promote)/i

		const scopedWriteDenies: string[] = []
		const scopedWriteAllows: string[] = []
		const supplementalWriteAllows: string[] = []
		const scopedGitDenies: string[] = []
		const scopedGitAllows: string[] = []
		const scopedNoTouch = /(?:nie\s+(?:ruszaj|zmieniaj|modyfikuj)|do\s+not\s+(?:touch|change|modify)|don't\s+(?:touch|change|modify))\s+(?:już\s+)?([^\n,;.]+)/i
		const scopedPostfixDeny = /([a-z0-9_./\\-]+)\s+(?:już\s+)?nie\s+(?:ruszaj|zmieniaj|modyfikuj)/i
		const normalizeScope = (scope: string) => scope.trim().replace(/^(backend|frontend)u$/i, "$1")

		// Scoped modify in initial goal
		const scopedModifyDenyMatch = initialGoal.match(
			/(?:nie\s+modyfikuj\s+(?:plików\s+w|kodu\s+w)?|do\s+not\s+modify\s+(?:files\s+in|code\s+in)?)\s*([^\n.;]+)/i
		)
		const scopedModifyAllowMatch = initialGoal.match(
			/(?:możesz\s+modyfikować\s+wyłącznie|modyfikuj\s+wyłącznie|you\s+may\s+modify\s+only|modify\s+only|write\s+authorization:\s*you\s+may\s+modify\s+only:?)\s*([^\n.;]+)/i
		)
		if (scopedModifyDenyMatch && scopedModifyDenyMatch[1]) {
			const clean = scopedModifyDenyMatch[1].replace(/[\(\)].*$/, "").trim()
			if (clean && !/^(kodu|code|all\s+files|wszystko)$/i.test(clean)) {
				scopedWriteDenies.push(clean)
			}
		}
		const initialNoTouchMatches = [
			...initialGoal.matchAll(new RegExp(scopedNoTouch.source, "gi")),
			...initialGoal.matchAll(new RegExp(scopedPostfixDeny.source, "gi")),
		]
		for (const match of initialNoTouchMatches) {
			if (match[1] && !/^(?:code|files|anything|kodu|plików|niczego)$/i.test(match[1].trim())) {
				const scope = normalizeScope(match[1])
				if (!scopedWriteDenies.includes(scope)) scopedWriteDenies.push(scope)
			}
		}
		if (scopedModifyAllowMatch && scopedModifyAllowMatch[1]) {
			const clean = scopedModifyAllowMatch[1].replace(/[\(\)].*$/, "").trim()
			if (clean && !/^(kodu|code|all\s+files|wszystko)$/i.test(clean)) {
				scopedWriteAllows.push(clean)
			}
		}

		// Scoped commit in initial goal
		const scopedCommitDenyMatch = initialGoal.match(
			/(?:nie\s+commituj\s+zmian|do\s+not\s+commit\s+changes\s+to)\s*([^\n.;]+)/i
		)
		const scopedCommitAllowMatch = initialGoal.match(
			/(?:masz\s+pozwolenie\s+na:\s*commit\s+wyłącznie|commit\s+wyłącznie|you\s+(?:may|can)\s+commit\s+only)\s*([^\n.;]+)/i
		)
		if (scopedCommitDenyMatch && scopedCommitDenyMatch[1]) {
			scopedGitDenies.push(scopedCommitDenyMatch[1].trim())
		}
		if (scopedCommitAllowMatch && scopedCommitAllowMatch[1]) {
			scopedGitAllows.push(scopedCommitAllowMatch[1].trim())
		}

		// Initial prompt flags
		const explicitGlobalNoModify = globalNoModifyRegex.test(initialGoal)
		let hasNoModify = explicitGlobalNoModify || (noModifyRegex.test(initialGoal) && scopedWriteDenies.length === 0 && scopedWriteAllows.length === 0)
		let hasNoCommit = noCommitRegex.test(initialGoal) && !scopedCommitDenyMatch && !scopedCommitAllowMatch
		let hasNoBuild = noBuildRegex.test(initialGoal)
		let hasNoSign = noSignRegex.test(initialGoal)
		let hasNoActivate = noActivateRegex.test(initialGoal)
		let hasNoPromote = noPromoteRegex.test(initialGoal)
		let pendingScopeAsk: ClineMessage | undefined

		// Check subsequent user instructions in conversation history
		for (const msg of this.clineMessages) {
			if (msg.type === "ask" && !msg.partial) {
				pendingScopeAsk = msg
				continue
			}
			if (msg.type === "say" && msg.say === "user_feedback" && msg.text) {
				const text = msg.text
				if (pendingScopeAsk?.ask === "followup" && /^(?:tak|yes|ok|proceed|go ahead)[.!]?$/i.test(text.trim())) {
					const askedScope = pendingScopeAsk.text?.match(/(?:modify|edit|change|touch|zmodyfikować|modyfikować|edytować|zmieniać|ruszać)\s+([a-z0-9_./\\-]+)/i)?.[1]
					if (askedScope && (/[./\\]/.test(askedScope) || /^(?:backend|frontend|shared)$/i.test(askedScope))) {
						const scope = normalizeScope(askedScope)
						if (!supplementalWriteAllows.includes(scope)) supplementalWriteAllows.push(scope)
						const priorDeny = scopedWriteDenies.indexOf(scope)
						if (priorDeny !== -1) scopedWriteDenies.splice(priorDeny, 1)
					}
				}
				pendingScopeAsk = undefined
				const noTouch = text.match(scopedNoTouch) || text.match(scopedPostfixDeny)
				const scopedDeny = Boolean(noTouch?.[1] && !/^(?:code|files|anything|kodu|plików|niczego)$/i.test(noTouch[1].trim()))
				if (scopedDeny && noTouch?.[1]) {
					const scope = normalizeScope(noTouch[1])
					if (!scopedWriteDenies.includes(scope)) scopedWriteDenies.push(scope)
					const priorAllow = supplementalWriteAllows.indexOf(scope)
					if (priorAllow !== -1) supplementalWriteAllows.splice(priorAllow, 1)
				}
				const additiveAllow = text.match(
					/(?:możesz(?:\s+teraz)?\s+(?:modyfikować|zmieniać|edytować)|you\s+may\s+(?:modify|change|edit))\s+([^\n,;.]+)/i,
				)
				const isScopedAdditive = Boolean(additiveAllow?.[1] && !/^(?:wyłącznie|tylko|only|code|files|anything|kodu|pliki|wszystko)\b/i.test(additiveAllow[1]))
				if (isScopedAdditive && additiveAllow?.[1]) {
					const scope = normalizeScope(additiveAllow[1])
					if (scope && !supplementalWriteAllows.includes(scope)) supplementalWriteAllows.push(scope)
					const priorDeny = scopedWriteDenies.indexOf(scope)
					if (priorDeny !== -1) scopedWriteDenies.splice(priorDeny, 1)
				}

				// Positive override checking for modification (Lexical Override Trap Prevention)
				if (deactivationModifyRegex.test(text) && !isScopedAdditive) {
					hasNoModify = false
					// Reconcile todoList items that were blocked by read-only constraint
					if (this.todoList && this.todoList.length > 0) {
						for (const item of this.todoList) {
							if (item.status === "blocked") {
								item.status = "pending"
							}
						}
					}
				} else if (noModifyRegex.test(text) && (!scopedDeny || globalNoModifyRegex.test(text)) && !/applies\s+only|tylko\s+do/i.test(text)) {
					hasNoModify = true
				}

				// Check follow-up scoped write allowances/denials
				const followUpModifyAllow = text.match(
					/(?:możesz\s+modyfikować\s+wyłącznie|modyfikuj\s+wyłącznie|you\s+may\s+modify\s+only|modify\s+only|write\s+authorization:\s*you\s+may\s+modify\s+only:?)\s*([^\n.;]+)/i
				)
				if (followUpModifyAllow && followUpModifyAllow[1]) {
					const cleanScope = followUpModifyAllow[1].replace(/[\(\)].*$/, "").trim()
					if (cleanScope && !scopedWriteAllows.includes(cleanScope)) {
						scopedWriteAllows.push(cleanScope)
					}
					hasNoModify = false
				}

				if (
					/(?:możesz(?:\s+jednak)?\s+commitować|you\s+can\s+commit|you\s+may\s+commit|stwórz\s+commit|zrób\s+commit|commits?:|commituj|proceed\s+with.*(?:commit|add)|yes.*(?:commit|add)|tak.*commit)/i.test(
						text
					)
				) {
					hasNoCommit = false
				} else if (noCommitRegex.test(text) && !/proceed\s+with|applies\s+only|tylko\s+do/i.test(text)) {
					hasNoCommit = true
				}

				// Check follow-up scoped allow/confirmations for commit
				const followUpAllow = text.match(
					/(?:commit\s+for|commit\s+wyłącznie|proceed\s+with\s+git\s+add\s+and\s+commit\s+for)\s*([^\n.;]+)/i
				)
				if (followUpAllow && followUpAllow[1]) {
					const cleanScope = followUpAllow[1].replace(/\s+only.*$/i, "").trim()
					if (cleanScope && !scopedGitAllows.includes(cleanScope)) {
						scopedGitAllows.push(cleanScope)
					}
					hasNoCommit = false
				}

				if (noBuildRegex.test(text)) hasNoBuild = true
				if (noSignRegex.test(text)) hasNoSign = true
				if (noActivateRegex.test(text)) hasNoActivate = true
				if (noPromoteRegex.test(text)) hasNoPromote = true
			}
		}
		if (hasNoModify) {
			constraints.push("DO NOT modify code (READ-ONLY review)")
			canonicalConstraints.push({
				action: "file_write",
				scope: "workspace",
				decision: "DENY",
				priority: "USER_GENERAL",
				reason: "User specified read-only review",
			})
		}
		for (const d of scopedWriteDenies) {
			constraints.push(`DO NOT modify files in ${d}`)
			canonicalConstraints.push({
				action: "file_write",
				scope: d,
				decision: "DENY",
				priority: "USER_SCOPED",
				reason: `User explicitly forbade modifications to ${d}`,
			})
		}
		for (const a of scopedWriteAllows) {
			constraints.push(`ALLOWED to modify ${a}`)
			canonicalConstraints.push({
				action: "file_write",
				scope: a,
				decision: "ALLOW",
				priority: "USER_SCOPED",
				reason: `User explicitly authorized modifications to ${a}`,
			})
		}
		for (const a of supplementalWriteAllows) {
			constraints.push(`ALLOWED to modify ${a}`)
			canonicalConstraints.push({
				action: "file_write",
				scope: a,
				decision: "ALLOW",
				priority: "LATEST_SCOPED_USER",
				reason: `User explicitly authorized modifications to ${a}`,
			})
		}

		if (hasNoCommit) {
			constraints.push("DO NOT commit changes (NIE commituj)")
			canonicalConstraints.push({
				action: "git_commit",
				scope: "workspace",
				decision: "DENY",
				priority: "USER_GENERAL",
				reason: "User forbade git commits",
			})
		}
		for (const d of scopedGitDenies) {
			constraints.push(`DO NOT commit changes to ${d} (NIE commituj zmian ${d})`)
			canonicalConstraints.push({
				action: "git_commit",
				scope: d,
				decision: "DENY",
				priority: "USER_SCOPED",
				reason: `User explicitly forbade commits to ${d}`,
			})
		}
		for (const a of scopedGitAllows) {
			constraints.push(`ALLOWED to commit ${a} (Masz pozwolenie na commit ${a})`)
			canonicalConstraints.push({
				action: "git_commit",
				scope: a,
				decision: "ALLOW",
				priority: "USER_SCOPED",
				reason: `User explicitly authorized commits to ${a}`,
			})
		}

		if (hasNoBuild) constraints.push("DO NOT build release candidate (NIE buduj candidate)")
		if (hasNoSign) constraints.push("DO NOT sign release (NIE podpisuj release)")
		if (hasNoActivate) constraints.push("DO NOT perform production activation (NIE wykonuj production activation)")
		if (hasNoPromote) constraints.push("DO NOT promote build (NIE promuj)")

		return {
			constraints,
			scopedWriteAllows,
			supplementalWriteAllows,
			scopedWriteDenies,
			scopedGitAllows,
			scopedGitDenies,
			canonicalConstraints,
		}
	}

	private buildApprovalRequest({
		askType,
		text,
		isProtected,
		askTs,
	}: {
		askType: ClineAsk
		text?: string
		isProtected?: boolean
		askTs: number
	}): UnifiedApprovalRequest {
		const authorizationState = this.extractExplicitConstraints()
		const {
			constraints: explicitConstraints,
			scopedWriteAllows,
			supplementalWriteAllows,
			scopedWriteDenies,
			canonicalConstraints,
		} = authorizationState
		const contract = buildTaskContract(this.metadata?.task || "", this.clineMessages, {
			explicitConstraints,
			scopedWriteAllows,
			supplementalWriteAllows,
			scopedWriteDenies,
			canonicalConstraints,
		})
		const latestSubstantive = contract.latestSubstantiveInstruction
		const latestUserInstruction = contract.latestUserInstruction
		const activeGoal = contract.currentGoal

		let activeStep: string | undefined = undefined
		if (this.todoList && this.todoList.length > 0) {
			const inProgressIndex = this.todoList.findIndex((t) => t.status === "in_progress")
			const activeIndex =
				inProgressIndex !== -1
					? inProgressIndex
					: this.todoList.findIndex((t) => t.status === "pending")
			if (activeIndex !== -1) {
				const item = this.todoList[activeIndex]
				activeStep = `Step ${activeIndex + 1}/${this.todoList.length}: ${item.content} (${item.status})`
			}
		}

		const isWithinWorkspace = Boolean(
			this.workspacePath &&
				(this.cwd === this.workspacePath ||
					this.cwd.startsWith(this.workspacePath + path.sep) ||
					this.cwd.startsWith(this.workspacePath + "/"))
		)

		let actionType: ApprovalActionType = "execute_command"
		const target: UnifiedApprovalRequest["target"] = {}

		if (askType === "command") {
			actionType = "execute_command"
			target.command = text || ""
			target.cwd = this.cwd
		} else if (askType === "tool") {
			let tool: any
			try {
				tool = JSON.parse(text || "{}")
			} catch {}

			const toolName = tool?.tool
			if (toolName === "newFileCreated") {
				actionType = "write_to_file"
				target.filePath = tool.path
				target.isProtected = isProtected
				target.isOutsideWorkspace = !!tool.isOutsideWorkspace
			} else if (toolName === "editedExistingFile" || toolName === "appliedDiff") {
				actionType = "replace_file_content"
				target.filePath = tool.path
				target.diff = tool.diff
				target.isProtected = isProtected
				target.isOutsideWorkspace = !!tool.isOutsideWorkspace
			} else if (toolName === "readFile") {
				actionType = "read_file"
				target.filePath = tool.path
				target.isOutsideWorkspace = !!tool.isOutsideWorkspace
			} else if (
				toolName === "listFiles" ||
				toolName === "listFilesTopLevel" ||
				toolName === "listFilesRecursive"
			) {
				actionType = "read_file"
				target.filePath = tool.path
				target.isOutsideWorkspace = !!tool.isOutsideWorkspace
			} else if (toolName === "searchFiles" || toolName === "codebaseSearch") {
				actionType = "read_file"
				target.filePath = tool.path
			} else if (toolName === "switchMode") {
				actionType = "switch_mode"
			} else if (toolName === "newTask") {
				actionType = "new_task"
				target.subtaskMode = tool.mode
				target.subtaskMessage = tool.content
			} else if (toolName === "updateTodoList" || toolName === "update_todo_list") {
				actionType = "update_todo_list"
			} else if (toolName === "finishTask") {
				actionType = "attempt_completion"
			} else {
				actionType = "write_to_file"
				target.filePath = tool?.path
				target.isProtected = isProtected
				target.isOutsideWorkspace = !!tool?.isOutsideWorkspace
			}
		} else if (askType === "use_mcp_server") {
			let mcp: any
			try {
				mcp = JSON.parse(text || "{}")
			} catch {}
			if (mcp?.type === "access_mcp_resource") {
				actionType = "access_mcp_resource"
				target.mcpServerName = mcp.serverName
			} else {
				actionType = "use_mcp_tool"
				target.mcpServerName = mcp?.serverName
				target.mcpToolName = mcp?.toolName
				target.mcpArguments = mcp?.arguments
			}
		} else if (askType === "completion_result") {
			actionType = "attempt_completion"
			target.completionResult = text || this.lastCompletionResultText || ""
			target.todoListSnapshot = this.todoList ? structuredClone(this.todoList) : []
			target.completionCriteria = this.extractCompletionCriteria()
			try {
				target.activeTerminalsCount = TerminalRegistry.getTerminals(true, this.taskId).length
			} catch {
				target.activeTerminalsCount = 0
			}
		}

		let workerReason: string | undefined = undefined
		if (this.assistantMessageContent && this.assistantMessageContent.length > 0) {
			const textBlocks = (this.assistantMessageContent as any[])
				.slice(0, this.currentStreamingContentIndex)
				.filter(
					(b) => b && b.type === "text" && typeof b.content === "string" && b.content.trim().length > 0
				)
			if (textBlocks.length > 0) {
				workerReason = textBlocks[textBlocks.length - 1].content.trim()
			}
		}
		if (!workerReason && this.clineMessages && this.clineMessages.length > 0) {
			const lastAssistantMsg = [...this.clineMessages]
				.reverse()
				.find((m) => m.type === "say" && m.say === "text" && m.text && m.text.trim().length > 0)
			if (lastAssistantMsg?.text) {
				workerReason = lastAssistantMsg.text.trim()
			}
		}
		if (workerReason && workerReason.length > 500) {
			workerReason = workerReason.slice(0, 500) + "..."
		}

		target.workerReason = workerReason

		return {
			id: `req_${this.taskId}_${askTs}`,
			taskId: this.taskId,
			actionType,
			timestamp: askTs,
			target,
			taskContext: {
				userTask: this.metadata?.task || "",
				latestUserInstruction,
				latestSubstantiveInstruction: latestSubstantive,
				activeGoal,
				currentStep: activeStep,
				workerReason,
				workspacePath: this.workspacePath || this.cwd,
				isWithinWorkspace,
				recentActionSignatures: [...(this.deniedActionHistory || [])],
				explicitConstraints,
				scopedWriteAllows,
				supplementalWriteAllows,
				scopedWriteDenies,
				canonicalConstraints,
			},
		}
	}

	private computeActionSignature(req: UnifiedApprovalRequest): string {
		const targetStr =
			req.target.command ||
			req.target.filePath ||
			req.target.mcpToolName ||
			req.target.completionSummary ||
			req.target.completionResult ||
			""
		return `${req.actionType}:${targetStr.trim()}`
	}

	private computeCompletionFingerprint(req: UnifiedApprovalRequest): string {
		const openTodos = (req.target.todoListSnapshot || [])
			.filter((t: any) => t.status === "in_progress" || t.status === "pending")
			.map((t: any) => `${t.id || ""}:${t.status}:${(t.content || "").trim()}`)
			.sort()
			.join("|")

		const constraints = (req.taskContext.explicitConstraints || []).slice().sort().join("|")
		const denialReason = this.unresolvedDenialState?.reason || ""
		const activeGoal = req.taskContext.activeGoal || ""
		const criteria = (req.target.completionCriteria || []).slice().sort().join("|")

		return `${openTodos}#${constraints}#${denialReason}#${activeGoal}#${criteria}`
	}

	public setLastCompletionResultText(text: string): void {
		this.lastCompletionResultText = text
	}

	public resetCompletionAttempts(): void {
		this.consecutiveAttemptCompletionCount = 0
	}

	private extractCompletionCriteria(): string[] {
		const criteria = buildTaskContract(this.metadata?.task || "", this.clineMessages).completionCriteria
		if (criteria.length > 0) return criteria.map((c) => (c.length > 300 ? c.slice(0, 297) + "..." : c))

		// 1. Check for context compaction handoff in conversation history
		for (const msg of [...this.clineMessages].reverse()) {
			const text = msg.text || ""
			if (text.includes("### CONTEXT COMPACTION HANDOFF")) {
				const match = text.match(
					/\*\*(?:Completion Criteria & Required Report Structure|Completion Criteria)\*\*:\s*([\s\S]*?)(?=\n- \*\*|\n\n|$)/i
				)
				if (match && match[1]) {
					const lines = match[1]
						.split("\n")
						.map((l) => l.replace(/^[-*•\d.]\s*/, "").trim())
						.filter((l) => l.length > 0 && !l.startsWith("["))
					criteria.push(...lines)
					if (criteria.length > 0) {
						return criteria.slice(0, 15).map((c) => (c.length > 300 ? c.slice(0, 297) + "..." : c))
					}
				}
			}
		}

		// 2. Check latest user instruction or initial task
		const latestUserFeedback = [...this.clineMessages]
			.reverse()
			.find((m) => m.type === "say" && m.say === "user_feedback" && m.text)
		const sourceText = latestUserFeedback?.text || this.metadata?.task || ""

		if (sourceText) {
			const lines = sourceText.split("\n")
			for (const line of lines) {
				const trimmed = line.trim()
				const listMatch = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/)
				if (listMatch && listMatch[1] && listMatch[1].length > 3) {
					criteria.push(listMatch[1].trim())
				}
			}
		}

		return criteria.slice(0, 15).map((c) => (c.length > 300 ? c.slice(0, 297) + "..." : c))
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		this.clearStreamWatchdog()

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					// console.log("Task#ask: current ask promise was ignored (#1)")
					throw new AskIgnoredError("updating existing partial")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					// console.log("Task#ask: current ask promise was ignored (#2)")
					throw new AskIgnoredError("new partial")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({
						ts: askTs,
						type: "ask",
						ask: type,
						text,
						isProtected,
						approvalState: type === "completion_result" ? "EVALUATING" : undefined,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
				isProtected,
				approvalState: type === "completion_result" ? "EVALUATING" : undefined,
			})
		}

		let timeouts: NodeJS.Timeout[] = []

		// Automatically approve if the ask according to the user's settings.
		const provider = this.providerRef.deref()
		const state = provider ? await provider.getState() : undefined
		let approval: CheckAutoApprovalResult = { decision: "ask" }

		if (state?.approvalMode === "auto") {
			if (isNonBlockingAsk(type)) {
				this.approveAsk()
			} else if (
				type === "followup" ||
				type === "auto_approval_max_req_reached" ||
				type === "mistake_limit_reached" ||
				type === "api_req_failed" ||
				type === "resume_task" ||
				type === "resume_completed_task"
			) {
				approval = await checkAutoApproval({ state, ask: type, text, isProtected })
				if (approval.decision === "approve") {
					this.approveAsk()
				} else if (approval.decision === "deny") {
					this.denyAsk()
				} else if (approval.decision === "timeout") {
					const timeoutApproval = approval
					this.autoApprovalTimeoutRef = setTimeout(() => {
						const { askResponse, text, images } = timeoutApproval.fn()
						this.handleWebviewAskResponse(askResponse, text, images)
						this.autoApprovalTimeoutRef = undefined
					}, timeoutApproval.timeout)
					timeouts.push(this.autoApprovalTimeoutRef)
				} else {
					const askMsg = this.clineMessages.find((m) => m.ts === askTs)
					if (askMsg) {
						askMsg.approvalState = "USER_DECISION_REQUIRED"
						this.updateClineMessage(askMsg)
					}
				}
			} else {
				const request = this.buildApprovalRequest({ askType: type, text, isProtected, askTs })
				const askMsg = this.clineMessages.find((m) => m.ts === askTs)
				if (askMsg) {
					askMsg.approvalState = "EVALUATING"
					this.updateClineMessage(askMsg)
				}
				if (request.actionType === "attempt_completion") {
					const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
					if (completionSayMsg) {
						completionSayMsg.approvalState = "EVALUATING"
						this.updateClineMessage(completionSayMsg)
					}
				}
				let decisionResult: ApprovalDecisionResult
				try {
					// The worker can be locked to a task-specific profile while the global
					// selection changes in another chat. Compare the verifier to this worker.
					decisionResult = await this.approvalOrchestrator.evaluate(
						request,
						{
							...state,
							apiConfiguration: this.apiConfiguration,
						},
						{ signal: this.currentRequestAbortController?.signal }
					)
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err)
					console.error(`[ApprovalOrchestrator] evaluate threw an unexpected error:`, err)
					decisionResult = {
						decision: "MANUAL_APPROVAL",
						risk: "high",
						reason: `Safety verification temporarily unavailable. Review this action manually. (INFRASTRUCTURE_ERROR: ${errorMsg})`,
						taskAligned: false,
						infrastructureFailure: true,
						verifierUnavailable: false,
						approvalAttemptCount: 1,
						auditLog: `[ApprovalAudit] taskId=${this.taskId} actionId=${request.id} actionType=${request.actionType} mode=auto fastPath=false infrastructureFailure=true finalDecision=MANUAL_APPROVAL reason="Unexpected evaluate error: ${errorMsg}" workerReinvoked=false`,
					}
				}

				if (decisionResult.auditLog) {
					console.log(decisionResult.auditLog)
				}

				if (decisionResult.decision === "ALLOW_AUTO") {
					if (request.actionType === "attempt_completion") {
						this.consecutiveAttemptCompletionCount = (this.consecutiveAttemptCompletionCount || 0) + 1
						if (this.consecutiveAttemptCompletionCount > 2) {
							// Hard loop protection: require explicit manual review if completion is repeatedly attempted
							decisionResult.decision = "MANUAL_APPROVAL"
							approval = { decision: "ask" }
							if (askMsg) {
								askMsg.approvalState = "USER_DECISION_REQUIRED"
								this.updateClineMessage(askMsg)
							}
							const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
							if (completionSayMsg) {
								completionSayMsg.approvalState = "USER_DECISION_REQUIRED"
								this.updateClineMessage(completionSayMsg)
							}
							const warningPayload: SafetyEvaluationResult = {
								isSafe: false,
								riskLevel: "medium",
								reason: `Completion loop guard triggered: Worker attempted completion multiple times consecutively. Manual review required.`,
							}
							await this.say("command_safety_warning", JSON.stringify(warningPayload))
							this.lastMessageTs = askTs
						} else {
							if (askMsg) {
								askMsg.approvalState = "AUTO_APPROVED"
								this.updateClineMessage(askMsg)
							}
							const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
							if (completionSayMsg) {
								completionSayMsg.approvalState = "AUTO_APPROVED"
								this.updateClineMessage(completionSayMsg)
							}
							approval = { decision: "approve" }
							this.approveAsk()
							this.consecutiveReplanCount = 0
							this.unresolvedDenialState = null
						}
					} else {
						if (askMsg) {
							askMsg.approvalState = "AUTO_APPROVED"
							this.updateClineMessage(askMsg)
						}
						approval = { decision: "approve" }
						this.approveAsk()
						this.consecutiveReplanCount = 0
						const isPassiveCheck =
							(request.actionType === "execute_command" &&
								/^(?:git\s+(?:status|diff|log)|ls|dir|pwd|echo)\b/i.test(request.target.command || "")) ||
							request.actionType === "read_file"
						if (!isPassiveCheck) {
							this.consecutiveAttemptCompletionCount = 0
							this.consecutiveIdenticalCompletionCount = 0
							this.lastCompletionFingerprint = null
							this.unresolvedDenialState = null
						}
					}
				} else if (decisionResult.decision === "CONTINUE_WORK") {
					this.consecutiveAttemptCompletionCount = (this.consecutiveAttemptCompletionCount || 0) + 1
					const currentFingerprint = this.computeCompletionFingerprint(request)
					const isIdenticalRetry =
						this.lastCompletionFingerprint !== null &&
						this.lastCompletionFingerprint === currentFingerprint

					if (isIdenticalRetry) {
						this.consecutiveIdenticalCompletionCount = (this.consecutiveIdenticalCompletionCount || 0) + 1
					} else {
						this.consecutiveIdenticalCompletionCount = 1
						this.lastCompletionFingerprint = currentFingerprint
					}

					// Loop protection: 2 consecutive attempts with identical state (zero progress) OR 3 total consecutive completion attempts
					const isLoopDetected =
						this.consecutiveIdenticalCompletionCount >= 2 ||
						this.consecutiveAttemptCompletionCount >= 3

					if (isLoopDetected) {
						approval = { decision: "ask" }
						if (askMsg) {
							askMsg.approvalState = "USER_DECISION_REQUIRED"
							this.updateClineMessage(askMsg)
						}
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "USER_DECISION_REQUIRED"
							this.updateClineMessage(completionSayMsg)
						}
						const loopReason =
							this.consecutiveIdenticalCompletionCount >= 2
								? `Completion loop guard triggered: Worker attempted completion repeatedly without resolving unfinished items or making progress (${decisionResult.reason}). Manual review required.`
								: `Completion loop guard triggered: Worker attempted completion 3 times consecutively without resolving unfinished items (${decisionResult.reason}). Manual review required.`

						const warningPayload: SafetyEvaluationResult = {
							isSafe: false,
							riskLevel: "medium",
							reason: loopReason,
						}
						await this.say("command_safety_warning", JSON.stringify(warningPayload))
						this.lastMessageTs = askTs
						this.interactiveAsk = askMsg
						this.emit(RooCodeEventName.TaskInteractive, this.taskId)
						const prov = this.providerRef.deref()
						prov?.postMessageToWebview({ type: "interactionRequired" })
					} else {
						if (askMsg) {
							askMsg.approvalState = "DENIED"
							this.updateClineMessage(askMsg)
						}
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "DENIED"
							this.updateClineMessage(completionSayMsg)
						}
						approval = { decision: "deny" }
						const payload = formatResponse.continueWork({
							reason: decisionResult.reason,
							unresolvedItems: decisionResult.unresolvedItems?.map((item) => ({
								type: item.type,
								content: item.content,
								guidance: item.guidance ?? undefined,
							})),
							missingCriteria: decisionResult.missingCriteria,
							guidance: decisionResult.replanGuidance || undefined,
						})
						this.denyAsk({ text: payload })
					}
				} else if (
					decisionResult.decision === "DENY_AND_REPLAN" ||
					decisionResult.decision === "HARD_BLOCK"
				) {
					this.unresolvedDenialState = {
						actionType: request.actionType,
						reason: decisionResult.reason,
						replanGuidance: decisionResult.replanGuidance || undefined,
					}
					const signature = this.computeActionSignature(request)
					const isRepeated = this.deniedActionHistory.includes(signature)
					this.deniedActionHistory.push(signature)
					if (this.deniedActionHistory.length > 5) {
						this.deniedActionHistory.shift()
					}
					this.consecutiveReplanCount = (this.consecutiveReplanCount || 0) + 1
					this.totalReplanCount = (this.totalReplanCount || 0) + 1

					const isHardConstraintOrBoundary =
						decisionResult.decision === "HARD_BLOCK" ||
						decisionResult.hardBoundaryViolation === true ||
						decisionResult.isUserConstraintViolation === true ||
						/nie\s+modyfikuj|do\s+not\s+modify|read-only|nie\s+commituj|do\s+not\s+commit|user\s+constraint/i.test(decisionResult.reason)

					if (isHardConstraintOrBoundary) {
						// HARD CONSTRAINT OR BOUNDARY VIOLATION:
						// RUN MUST NEVER BE OFFERED IN AUTO MODE!
						if (askMsg) {
							askMsg.approvalState = "DENIED"
							this.updateClineMessage(askMsg)
						}
						approval = { decision: "deny" }

						let guidance = decisionResult.replanGuidance || "Execute a safe compliant alternative."
						if (isRepeated || this.consecutiveReplanCount > 1) {
							const constraintLabel = decisionResult.violatedConstraint || "Explicit user constraint"
							guidance = `[EXPLICIT CONSTRAINT ENFORCEMENT - ATTEMPT ${this.consecutiveReplanCount}]
This proposed action is STRICTLY FORBIDDEN by active user constraints: "${constraintLabel}".
Reason: ${decisionResult.reason}
THE NEXT ACTION MUST NOT:
- edit or modify any files
- stage or commit changes
- repeat the forbidden action
You MUST continue the task using strictly compliant, read-only inspection or alternative compliant tools.`
						}

						const payload =
							decisionResult.decision === "HARD_BLOCK"
								? formatResponse.toolHardBlocked(decisionResult.reason, guidance)
								: formatResponse.toolDeniedAndReplan(decisionResult.reason, guidance)
						this.denyAsk({ text: payload })
					} else {
						// Loop / thrashing protection: repeated rejected action or consecutive limit > 3 or total > 10
						const isThrashing = isRepeated || this.consecutiveReplanCount > 3 || this.totalReplanCount > 10

						if (isThrashing) {
							approval = { decision: "ask" }
							if (askMsg) {
								askMsg.approvalState = "USER_DECISION_REQUIRED"
								this.updateClineMessage(askMsg)
							}
							if (request.actionType === "attempt_completion") {
								const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
								if (completionSayMsg) {
									completionSayMsg.approvalState = "USER_DECISION_REQUIRED"
									this.updateClineMessage(completionSayMsg)
								}
							}
							const warningPayload: SafetyEvaluationResult = {
								isSafe: false,
								riskLevel: decisionResult.risk || "high",
								reason: `Safety replan limit reached or action repeated (${decisionResult.reason}). Manual approval required.`,
							}
							await this.say("command_safety_warning", JSON.stringify(warningPayload))
							this.lastMessageTs = askTs
						} else {
							if (askMsg) {
								askMsg.approvalState = "DENIED"
								this.updateClineMessage(askMsg)
							}
							if (request.actionType === "attempt_completion") {
								const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
								if (completionSayMsg) {
									completionSayMsg.approvalState = "DENIED"
									this.updateClineMessage(completionSayMsg)
								}
							}
							approval = { decision: "deny" }
							const payload =
								decisionResult.decision === "HARD_BLOCK"
									? formatResponse.toolHardBlocked(decisionResult.reason, decisionResult.replanGuidance)
									: formatResponse.toolDeniedAndReplan(decisionResult.reason, decisionResult.replanGuidance)
							this.denyAsk({ text: payload })
						}
					}
				} else {
					// MANUAL_APPROVAL (or fail-closed)
					approval = { decision: "ask" }
					if (askMsg) {
						askMsg.approvalState = "USER_DECISION_REQUIRED"
						this.updateClineMessage(askMsg)
					}
					if (request.actionType === "attempt_completion") {
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "USER_DECISION_REQUIRED"
							this.updateClineMessage(completionSayMsg)
						}
					}
					const warningPayload: SafetyEvaluationResult = {
						isSafe: false,
						riskLevel: decisionResult.risk || "high",
						reason: decisionResult.reason,
						infrastructureFailure: decisionResult.infrastructureFailure,
					}
					await this.say("command_safety_warning", JSON.stringify(warningPayload))
					this.lastMessageTs = askTs

					if (
						decisionResult.infrastructureFailure &&
						isDeferredRetryableCategory(decisionResult.verifierFailureCategory)
					) {
						this.startDeferredApprovalRecovery({
							request,
							state: { ...state, apiConfiguration: this.apiConfiguration },
							askMsg,
							askTs,
							initialDecision: decisionResult,
						})
					}
				}
			}
		} else {
			approval = await checkAutoApproval({ state, ask: type, text, isProtected })

			if (approval.decision === "approve") {
				if (type === "command") {
					if (isSafetyModelConfigured(state)) {
						const recentCommands = this.clineMessages
							.filter((m) => m.ask === "command" && m.text && m.ts !== askTs)
							.slice(-5)
							.map((m) => m.text!)

						// Extract compact safety context from Task
						const latestUserFeedback = [...this.clineMessages]
							.reverse()
							.find((m) => m.type === "say" && m.say === "user_feedback" && m.text)
						const latestUserInstruction = latestUserFeedback?.text || this.metadata?.task || ""

						let activeTodo: CompactSafetyContext["activeTodo"] = undefined
						if (this.todoList && this.todoList.length > 0) {
							const inProgressIndex = this.todoList.findIndex((t) => t.status === "in_progress")
							const activeIndex =
								inProgressIndex !== -1
									? inProgressIndex
									: this.todoList.findIndex((t) => t.status === "pending")
							if (activeIndex !== -1) {
								const item = this.todoList[activeIndex]
								activeTodo = {
									content: item.content,
									status: item.status,
									stepIndex: activeIndex + 1,
									totalSteps: this.todoList.length,
								}
							}
						}

						const isWithinWorkspace = Boolean(
							this.workspacePath &&
								(this.cwd === this.workspacePath ||
									this.cwd.startsWith(this.workspacePath + path.sep) ||
									this.cwd.startsWith(this.workspacePath + "/"))
						)

						const context: CompactSafetyContext = {
							taskGoal: this.metadata?.task || "",
							latestUserInstruction,
							activeTodo,
							workspacePath: this.workspacePath || this.cwd,
							commandCwd: this.cwd,
							isWithinWorkspace,
							taskMode: this._taskMode,
							recentCommands,
						}

						let twoStageResult: TwoStageSafetyResult
						try {
							twoStageResult = await CommandSafetyJudge.evaluateTwoStage({
								command: text || "",
								cwd: this.cwd,
								taskId: this.taskId,
								context,
								recentCommands,
								config: state?.commandSafetyConfig!,
								state,
							})
						} catch (error) {
							const errorDetail = error instanceof Error ? error.message : String(error)
							const fallbackStage1: SafetyEvaluationResult = {
								isSafe: false,
								riskLevel: "critical",
								reason: `Command safety verification failed: ${errorDetail || "Unknown error"}. Manual approval required.`,
							}
							twoStageResult = {
								decision: "ask",
								stage1: fallbackStage1,
								finalReason: fallbackStage1.reason,
								auditLog: `[CommandSafety] commandId=${this.taskId} stage1=ERROR target=unknown stage2=ERROR final=MANUAL reason="${fallbackStage1.reason}"`,
							}
						}

						if (twoStageResult.auditLog) {
							console.log(twoStageResult.auditLog)
						}

						if (twoStageResult.decision === "approve") {
							this.approveAsk()
						} else {
							approval = { decision: "ask" }
							const askMsg = this.clineMessages.find((m) => m.ts === askTs)
							if (askMsg) {
								askMsg.approvalState = "USER_DECISION_REQUIRED"
								this.updateClineMessage(askMsg)
							}
							const warningPayload: SafetyEvaluationResult = {
								isSafe: twoStageResult.stage1?.isSafe ?? false,
								riskLevel: twoStageResult.stage1?.riskLevel ?? "critical",
								reason: twoStageResult.finalReason || twoStageResult.stage1?.reason || SAFETY_EVALUATION_FALLBACK_RESULT.reason,
							}
							await this.say("command_safety_warning", JSON.stringify(warningPayload))
							this.lastMessageTs = askTs
						}
					} else {
						this.approveAsk()
					}
				} else {
					this.approveAsk()
				}
			} else if (approval.decision === "deny") {
				this.denyAsk()
			} else if (approval.decision === "timeout") {
				const timeoutApproval = approval
				// Store the auto-approval timeout so it can be cancelled if user interacts
				this.autoApprovalTimeoutRef = setTimeout(() => {
					const { askResponse, text, images } = timeoutApproval.fn()
					this.handleWebviewAskResponse(askResponse, text, images)
					this.autoApprovalTimeoutRef = undefined
				}, timeoutApproval.timeout)
				timeouts.push(this.autoApprovalTimeoutRef)
			}
		}

		// The state is mutable if the message is complete and the task will
		// block (via the `pWaitFor`).
		const isBlocking = !(this.askResponse !== undefined || this.lastMessageTs !== askTs)
		const isMessageQueued = !this.messageQueueService.isEmpty()
		// Only drain queued prompts when the task has reached completion / awaiting next turn!
		// Queued messages must NEVER be consumed as approvals for tools/commands or followups.
		const shouldDrainQueuedMessageForAsk = type === "resume_completed_task"
		const isStatusMutable =
			!partial && isBlocking && !(isMessageQueued && shouldDrainQueuedMessageForAsk) && approval.decision === "ask"

		if (isStatusMutable) {
			const statusMutationTimeout = 2_000

			if (isInteractiveAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.interactiveAsk = message
							this.emit(RooCodeEventName.TaskInteractive, this.taskId)
							provider?.postMessageToWebview({ type: "interactionRequired" })
						}
					}, statusMutationTimeout),
				)
			} else if (isResumableAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.resumableAsk = message
							this.emit(RooCodeEventName.TaskResumable, this.taskId)
						}
					}, statusMutationTimeout),
				)
			} else if (isIdleAsk(type)) {
				timeouts.push(
					setTimeout(() => {
						const message = this.findMessageByTimestamp(askTs)

						if (message) {
							this.idleAsk = message
							this.emit(RooCodeEventName.TaskIdle, this.taskId)
						}
					}, statusMutationTimeout),
				)
			}
		} else if (isMessageQueued && shouldDrainQueuedMessageForAsk) {
			const message = this.messageQueueService.dequeueMessage()

			if (message) {
				this.handleWebviewAskResponse("messageResponse", message.text, message.images)
			}
		}

		// Wait for askResponse to be set
		await pWaitFor(
			() => {
				if (this.abort) {
					throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
				}
				if (this.askResponse !== undefined || this.lastMessageTs !== askTs) {
					return true
				}

				// If a queued message arrives while we're blocked on resume_completed_task,
				// consume it immediately to start the next conversational turn.
				if (shouldDrainQueuedMessageForAsk && !this.messageQueueService.isEmpty()) {
					const message = this.messageQueueService.dequeueMessage()
					if (message) {
						this.handleWebviewAskResponse("messageResponse", message.text, message.images)
					}
				}

				return false
			},
			{ interval: 100 },
		)

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new AskIgnoredError("superseded")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Cancel the timeouts if they are still running.
		timeouts.forEach((timeout) => clearTimeout(timeout))

		// Switch back to an active state.
		if (this.idleAsk || this.resumableAsk || this.interactiveAsk) {
			this.idleAsk = undefined
			this.resumableAsk = undefined
			this.interactiveAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		// Clear any pending auto-approval timeout when user responds
		this.cancelAutoApprovalTimeout()

		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images

		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined
		this.emit(RooCodeEventName.TaskActive, this.taskId)
		this.emit(RooCodeEventName.TaskAskResponded)

		// Reset turn-boundary loop counters and unresolved denial state when user responds or approves
		if (askResponse === "messageResponse" || askResponse === "yesButtonClicked") {
			this.consecutiveAttemptCompletionCount = 0
			this.consecutiveIdenticalCompletionCount = 0
			this.consecutiveReplanCount = 0
			this.lastCompletionFingerprint = null
			this.unresolvedDenialState = null
		}

		// Create a checkpoint whenever the user sends a message.
		// Use allowEmpty=true to ensure a checkpoint is recorded even if there are no file changes.
		// Suppress the checkpoint_saved chat row for this particular checkpoint to keep the timeline clean.
		if (askResponse === "messageResponse") {
			void this.checkpointSave(false, true)
		}

		// Mark the pending ask as answered and update approvalState
		const lastPendingAskIndex = findLastIndex(
			this.clineMessages,
			(msg) => msg.type === "ask" && !msg.isAnswered,
		)
		if (lastPendingAskIndex !== -1) {
			const pendingAsk = this.clineMessages[lastPendingAskIndex]
			pendingAsk.isAnswered = true
			if (askResponse === "yesButtonClicked") {
				if (pendingAsk.approvalState === "USER_DECISION_REQUIRED") {
					pendingAsk.approvalState = "AUTO_APPROVED"
				}
			} else if (askResponse === "noButtonClicked") {
				if (pendingAsk.approvalState === "USER_DECISION_REQUIRED") {
					pendingAsk.approvalState = "DENIED"
				}
			}
			void this.updateClineMessage(pendingAsk)
			this.saveClineMessages().catch((error) => {
				console.error("Failed to save answered ask state:", error)
			})
		}
	}

	/**
	 * Cancel any pending auto-approval timeout.
	 * Called when user interacts (types, clicks buttons, etc.) to prevent the timeout from firing.
	 */
	public cancelAutoApprovalTimeout(): void {
		if (this.autoApprovalTimeoutRef) {
			clearTimeout(this.autoApprovalTimeoutRef)
			this.autoApprovalTimeoutRef = undefined
		}
		if (this.deferredRecoveryController) {
			this.deferredRecoveryController.cancel("user_interaction")
			this.deferredRecoveryController = undefined
		}
	}

	public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("yesButtonClicked", text, images)
	}

	public denyAsk({ text, images }: { text?: string; images?: string[] } = {}) {
		this.handleWebviewAskResponse("noButtonClicked", text, images)
	}

	public supersedePendingAsk(): void {
		this.lastMessageTs = Date.now()
	}

	/**
	 * Starts bounded deferred recovery for transient verifier failures (e.g. timeout, rate limit, provider error).
	 * Fails closed (maintains USER_DECISION_REQUIRED), does not hold semaphores/locks during wait,
	 * respects Retry-After with fallback to exponential backoff with jitter (max 3 attempts).
	 * If the user interacts/runs/denies, recovery is immediately cancelled and executed exactly once.
	 */
	private startDeferredApprovalRecovery({
		request,
		state,
		askMsg,
		askTs,
		initialDecision,
	}: {
		request: UnifiedApprovalRequest
		state: Partial<ExtensionState>
		askMsg?: ClineMessage
		askTs: number
		initialDecision: ApprovalDecisionResult
	}): void {
		// Clean up any previous controller
		if (this.deferredRecoveryController) {
			this.deferredRecoveryController.cancel("superseded")
			this.deferredRecoveryController = undefined
		}

		const controller = new DeferredApprovalRecoveryController({
			maxAttempts: 3,
			baseDelayMs: 15000,
			maxDelayMs: 60000,
			minDelayMs: 5000,
			jitterRatio: 0.2,
		})
		this.deferredRecoveryController = controller

		void (async () => {
			let currentDecision = initialDecision
			while (
				!controller.isCancelled &&
				!this.abort &&
				this.askResponse === undefined &&
				this.lastMessageTs === askTs
			) {
				const retryAfter = currentDecision.retryAfterMs
				const scheduled = controller.scheduleAttempt(retryAfter)
				if (!scheduled) {
					// Max attempts reached or cancelled
					break
				}

				console.log(
					`[DeferredRecovery] Scheduled attempt ${scheduled.schedule.attempt}/${scheduled.schedule.maxAttempts} in ${scheduled.schedule.delayMs}ms for ${request.id}`,
				)

				// Update command_safety_warning with deferredRetry schedule
				const warningPayload: SafetyEvaluationResult = {
					isSafe: false,
					riskLevel: currentDecision.risk || "high",
					reason: currentDecision.reason,
					infrastructureFailure: true,
					deferredRetry: scheduled.schedule,
				}
				const lastWarning = findLast(this.clineMessages, (m) => m.say === "command_safety_warning")
				if (lastWarning) {
					lastWarning.text = JSON.stringify(warningPayload)
					void this.updateClineMessage(lastWarning)
				}

				// Wait for backoff timer to fire (or cancellation)
				const waitFired = await scheduled.waitPromise
				if (
					!waitFired ||
					controller.isCancelled ||
					this.abort ||
					this.askResponse !== undefined ||
					this.lastMessageTs !== askTs
				) {
					console.log(`[DeferredRecovery] Cancelled or superseded during wait for ${request.id}`)
					break
				}

				console.log(`[DeferredRecovery] Executing attempt ${scheduled.schedule.attempt} for ${request.id}`)

				// Execute verification with abort signal
				let retryResult: ApprovalDecisionResult
				try {
					retryResult = await this.approvalOrchestrator.evaluate(request, state, {
						signal: scheduled.abortSignal,
					})
				} catch (error) {
					console.error(`[DeferredRecovery] Error during evaluation attempt ${scheduled.schedule.attempt}:`, error)
					retryResult = {
						decision: "MANUAL_APPROVAL",
						risk: "high",
						reason: `Safety verification temporarily unavailable. Review this action manually. (${error instanceof Error ? error.message : String(error)})`,
						taskAligned: false,
						infrastructureFailure: true,
						verifierFailureCategory: VerifierFailureCategory.OTHER_TRANSIENT,
						auditLog: `[ApprovalAudit] taskId=${this.taskId} actionId=${request.id} deferredRetryAttempt=${scheduled.schedule.attempt} error="${error instanceof Error ? error.message : String(error)}"`,
					}
				}

				// Check again if user interacted or task aborted during evaluation
				if (
					controller.isCancelled ||
					this.abort ||
					this.askResponse !== undefined ||
					this.lastMessageTs !== askTs
				) {
					console.log(`[DeferredRecovery] Ignored retry result because ask was answered or aborted for ${request.id}`)
					break
				}

				currentDecision = retryResult

				if (retryResult.decision === "ALLOW_AUTO") {
					console.log(`[DeferredRecovery] Attempt ${scheduled.schedule.attempt} SUCCEEDED with ALLOW_AUTO for ${request.id}`)
					if (request.actionType === "attempt_completion") {
						this.consecutiveAttemptCompletionCount = (this.consecutiveAttemptCompletionCount || 0) + 1
						if (this.consecutiveAttemptCompletionCount > 2) {
							// Hard loop protection
							if (askMsg) {
								askMsg.approvalState = "USER_DECISION_REQUIRED"
								void this.updateClineMessage(askMsg)
							}
							break
						}
					}
					if (askMsg) {
						askMsg.approvalState = "AUTO_APPROVED"
						void this.updateClineMessage(askMsg)
					}
					if (request.actionType === "attempt_completion") {
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "AUTO_APPROVED"
							void this.updateClineMessage(completionSayMsg)
						}
					}
					this.approveAsk()
					this.consecutiveReplanCount = 0
					this.unresolvedDenialState = null
					break
				} else if (retryResult.decision === "DENY_AND_REPLAN" || retryResult.decision === "HARD_BLOCK") {
					console.log(`[DeferredRecovery] Attempt ${scheduled.schedule.attempt} rejected with ${retryResult.decision} for ${request.id}`)
					if (askMsg) {
						askMsg.approvalState = "DENIED"
						void this.updateClineMessage(askMsg)
					}
					if (request.actionType === "attempt_completion") {
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "DENIED"
							void this.updateClineMessage(completionSayMsg)
						}
					}
					const payload =
						retryResult.decision === "HARD_BLOCK"
							? formatResponse.toolHardBlocked(retryResult.reason, retryResult.replanGuidance)
							: formatResponse.toolDeniedAndReplan(retryResult.reason, retryResult.replanGuidance)
					this.denyAsk({ text: payload })
					break
				} else if (retryResult.decision === "CONTINUE_WORK") {
					if (askMsg) {
						askMsg.approvalState = "DENIED"
						void this.updateClineMessage(askMsg)
					}
					const payload = formatResponse.continueWork({
						reason: retryResult.reason,
						unresolvedItems: retryResult.unresolvedItems?.map((item) => ({
							type: item.type,
							content: item.content,
							guidance: item.guidance ?? undefined,
						})),
						missingCriteria: retryResult.missingCriteria,
						guidance: retryResult.replanGuidance || undefined,
					})
					this.denyAsk({ text: payload })
					break
				} else {
					// Still MANUAL_APPROVAL
					if (!retryResult.infrastructureFailure || !isDeferredRetryableCategory(retryResult.verifierFailureCategory)) {
						console.log(`[DeferredRecovery] Attempt ${scheduled.schedule.attempt} returned non-retryable MANUAL_APPROVAL for ${request.id}`)
						const finalWarningPayload: SafetyEvaluationResult = {
							isSafe: false,
							riskLevel: retryResult.risk || "high",
							reason: retryResult.reason,
							infrastructureFailure: retryResult.infrastructureFailure,
						}
						const lastWarning = findLast(this.clineMessages, (m) => m.say === "command_safety_warning")
						if (lastWarning) {
							lastWarning.text = JSON.stringify(finalWarningPayload)
							void this.updateClineMessage(lastWarning)
						}
						break
					}
				}
			}

			// Clean up warning if retries exhausted without success
			if (
				!controller.isCancelled &&
				this.askResponse === undefined &&
				this.lastMessageTs === askTs &&
				controller.currentAttempt >= 3
			) {
				const finalWarningPayload: SafetyEvaluationResult = {
					isSafe: false,
					riskLevel: currentDecision.risk || "high",
					reason: currentDecision.reason,
					infrastructureFailure: currentDecision.infrastructureFailure,
				}
				const lastWarning = findLast(this.clineMessages, (m) => m.say === "command_safety_warning")
				if (lastWarning) {
					lastWarning.text = JSON.stringify(finalWarningPayload)
					void this.updateClineMessage(lastWarning)
				}
			}

			if (this.deferredRecoveryController === controller) {
				this.deferredRecoveryController = undefined
			}
		})()
	}

	/**
	 * Updates the API configuration and rebuilds the API handler.
	 * There is no tool-protocol switching or tool parser swapping.
	 *
	 * @param newApiConfiguration - The new API configuration to use
	 */
	public updateApiConfiguration(newApiConfiguration: ProviderSettings, force: boolean = false): void {
		// INVARIANT: An active task's worker model is immutable throughout its entire lifecycle.
		// Model changes occurring while a task is active are deferred to the next task.
		if (!force && !this.isTaskCompleted && !this.abort) {
			console.warn(`[TaskModelLock] Blocked attempt to mutate API configuration of active task ${this.taskId}`)
			return
		}

		const prevModelId = this.apiConfiguration?.apiModelId
		const nextModelId = newApiConfiguration?.apiModelId
		const prevProvider = this.apiConfiguration?.apiProvider
		const nextProvider = newApiConfiguration?.apiProvider

		// Update the configuration and rebuild the API handler
		this.apiConfiguration = structuredClone(newApiConfiguration)
		this.api = buildApiHandler(this.apiConfiguration)

		// Reset ACAC metrics if model or provider changed to prevent immediate spurious compaction
		if (prevModelId !== nextModelId || prevProvider !== nextProvider) {
			this.requestsSinceLastCompaction = 0
			const { totalTokensIn } = this.getTokenUsage()
			this.tokensInAtLastCompaction = totalTokensIn ?? 0
			this.retryRetransmissionTokens = 0
		}
	}

	public async submitUserMessage(
		text: string,
		images?: string[],
		mode?: string,
		providerProfile?: string,
	): Promise<void> {
		try {
			text = (text ?? "").trim()
			images = images ?? []

			if (text.length === 0 && images.length === 0) {
				return
			}

			const provider = this.providerRef.deref()

			if (provider) {
				if (mode) {
					await provider.setMode(mode)
				}

				if (providerProfile) {
					await provider.setProviderProfile(providerProfile)
					// Note: Profile change applies to provider for subsequent tasks;
					// active task execution configuration remains locked.
				}

				this.emit(RooCodeEventName.TaskUserMessage, this.taskId)

				// Handle the message directly instead of routing through the webview.
				// This avoids a race condition where the webview's message state hasn't
				// hydrated yet, causing it to interpret the message as a new task request.
				this.handleWebviewAskResponse("messageResponse", text, images)
			} else {
				console.error("[Task#submitUserMessage] Provider reference lost")
			}
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	private async getFilesReadByRooSafely(context: string): Promise<string[] | undefined> {
		try {
			return await this.fileContextTracker.getFilesReadByRoo()
		} catch (error) {
			console.error(`[Task#${context}] Failed to get files read by Roo:`, error)
			return undefined
		}
	}

	public async condenseContext(): Promise<void> {
		// CRITICAL: Flush any pending tool results before condensing
		// to ensure tool_use/tool_result pairs are complete in history
		await this.flushPendingToolResultsToHistory()

		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		const state = await this.providerRef.deref()?.getState()
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE
		const mode = this.taskMode || state?.mode || defaultModeSlug

		const { contextTokens: prevContextTokens } = this.getTokenUsage()

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const modelInfo = this.api.getModel().info
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration: this.apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}
		// Generate environment details to include in the condensed summary
		const environmentDetails = await getEnvironmentDetails(this, true)

		const filesReadByRoo = await this.getFilesReadByRooSafely("condenseContext")

		this.compactionAbortController = new AbortController()

		try {
			const {
				messages,
				summary,
				cost,
				newContextTokens = 0,
				error,
				errorDetails,
				condenseId,
			} = await summarizeConversation({
				messages: this.apiConversationHistory,
				apiHandler: this.api,
				systemPrompt,
				taskId: this.taskId,
				isAutomaticTrigger: false,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd: this.cwd,
				rooIgnoreController: this.rooIgnoreController,
				abortSignal: this.compactionAbortController.signal,
			})
			if (error) {
				await this.say(
					"condense_context_error",
					error,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
				)
				return
			}
			if (this.compactionAbortController?.signal.aborted || this.abort) {
				return
			}
			await this.overwriteApiConversationHistory(messages)

			const contextCondense: ContextCondense = {
				summary,
				cost,
				newContextTokens,
				prevContextTokens,
				condenseId: condenseId!,
			}
			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)

			this.recordCompactionCompletion()
		} finally {
			this.compactionAbortController = undefined
		}
	}

	private recordCompactionCompletion(): void {
		this.requestsSinceLastCompaction = 0
		this.retryRetransmissionTokens = 0
		const { totalTokensIn } = this.getTokenUsage()
		this.tokensInAtLastCompaction = totalTokensIn ?? 0
	}

	public static readonly AUTO_COMPACT_THRESHOLD = 0.85
	public static readonly DEFAULT_ECONOMIC_CONTEXT_CAP = 200_000

	public checkContextCompactionThreshold(): boolean {
		const { contextTokens, totalTokensIn } = this.getTokenUsage()
		if (!contextTokens) {
			return false
		}
		const modelInfo = this.api.getModel().info
		const contextWindow = modelInfo.contextWindow
		if (!contextWindow || contextWindow <= 0) {
			return false
		}
		const hardModelLimit = contextWindow * Task.AUTO_COMPACT_THRESHOLD

		// Check if economic cap is bypassed via environment or config
		const disableEconomicCap =
			process.env.ROO_DISABLE_ECONOMIC_CAP === "true" ||
			process.env.ROO_DISABLE_ECONOMIC_CAP === "1"

		if (disableEconomicCap) {
			return contextTokens >= hardModelLimit
		}

		// Configurable economic soft cap - only applied if explicitly configured by the user via environment variable
		// Models with 1M+ context window operate at their native capacity (hardModelLimit) unless explicitly capped.
		const customCap = process.env.ROO_MAX_WORKING_CONTEXT_TOKENS
			? parseInt(process.env.ROO_MAX_WORKING_CONTEXT_TOKENS, 10)
			: undefined

		const capacityLimit = customCap ? Math.min(hardModelLimit, customCap) : hardModelLimit
		if (contextTokens >= capacityLimit) {
			return true
		}

		// Adaptive Cost-Aware Compaction (ACAC) Trigger:
		// Triggers compaction when cumulative retransmission drag or long plateaus accumulate,
		// preventing millions of redundant tokens on models with 128k, 200k, or 1M+ context windows.
		// Constraints to protect 1M+ models and large single-turn ingests:
		// 1. Minimum economic floor: 30k for free models, 40k for paid models
		// 2. High-capacity grace period: at least 10 turns since task start / last compaction
		// 3. Novelty ratio gate: if recent turn added > 35% new tokens, defer compaction

		const modelId = this.api.getModel().id
		const isFreeModel = Boolean(
			modelInfo.isFree ||
			(typeof modelInfo.inputPrice === "number" && modelInfo.inputPrice === 0 && modelInfo.outputPrice === 0) ||
			modelId?.toLowerCase().endsWith(":free")
		)

		const MIN_ECONOMIC_FLOOR = isFreeModel ? 30_000 : 40_000
		const GRACE_PERIOD_REQUESTS = 10

		// Retransmission drag threshold:
		// Free models on aggregators like xKiro burn daily quotas (e.g. 16M) on cache reads,
		// so they require tighter drag thresholds (default 400k tokens).
		// Paid models with fast, cheap prompt prefix caching benefit from preserving prefix cache,
		// so they allow up to 1.2M+ tokens of cumulative drag before compacting.
		const defaultDragThreshold = isFreeModel ? 400_000 : 1_200_000
		const RETRANSMISSION_DRAG_THRESHOLD = isFreeModel
			? (process.env.ROO_ACAC_FREE_RETRANS_THRESHOLD
				? parseInt(process.env.ROO_ACAC_FREE_RETRANS_THRESHOLD, 10)
				: (process.env.ROO_ACAC_RETRANS_THRESHOLD
					? parseInt(process.env.ROO_ACAC_RETRANS_THRESHOLD, 10)
					: defaultDragThreshold))
			: (process.env.ROO_ACAC_RETRANS_THRESHOLD
				? parseInt(process.env.ROO_ACAC_RETRANS_THRESHOLD, 10)
				: defaultDragThreshold)

		const PLATEAU_REQUEST_THRESHOLD = isFreeModel ? 15 : 20
		const PLATEAU_CONTEXT_FLOOR = isFreeModel ? 40_000 : 60_000

		// Agile working set soft cap for free models (default 65,000) applied only after grace period
		const freeWorkingCap = process.env.ROO_FREE_WORKING_CONTEXT_TOKENS
			? parseInt(process.env.ROO_FREE_WORKING_CONTEXT_TOKENS, 10)
			: 65_000

		if (isFreeModel && this.requestsSinceLastCompaction >= GRACE_PERIOD_REQUESTS && contextTokens >= freeWorkingCap) {
			return true
		}

		if (contextTokens < MIN_ECONOMIC_FLOOR) {
			return false
		}

		if (this.requestsSinceLastCompaction < GRACE_PERIOD_REQUESTS) {
			return false
		}

		// Novelty ratio gate: if latest message contains significant fresh input (> 35%),
		// defer compaction so the model can process it first without disruption.
		const lastMsg = this.apiConversationHistory[this.apiConversationHistory.length - 1]
		if (lastMsg && lastMsg.content) {
			const lastContentStr =
				typeof lastMsg.content === "string" ? lastMsg.content : JSON.stringify(lastMsg.content)
			const estimatedLastTokens = Math.ceil(lastContentStr.length / 4)
			const noveltyRatio = estimatedLastTokens / contextTokens
			if (noveltyRatio >= 0.35) {
				return false
			}
		}

		const tokensSinceLastCompaction = Math.max(
			0,
			(totalTokensIn ?? 0) + this.retryRetransmissionTokens - this.tokensInAtLastCompaction,
		)
		const isCumulativeDragTriggered = tokensSinceLastCompaction >= RETRANSMISSION_DRAG_THRESHOLD
		const isPlateauTriggered =
			this.requestsSinceLastCompaction >= PLATEAU_REQUEST_THRESHOLD && contextTokens >= PLATEAU_CONTEXT_FLOOR

		return isCumulativeDragTriggered || isPlateauTriggered
	}

	public async compactContext(autoTriggered = true): Promise<void> {
		if (this.isCompacting) {
			if (!autoTriggered) {
				throw new Error("Context compaction is already in progress.")
			}
			return
		}

		// When auto-triggered from attemptApiRequest, the request is in its pre-flight setup
		// phase before any streaming has started. Waiting for !isStreaming here causes a
		// deterministic deadlock when the caller sets isStreaming = true.
		// Only external/manual triggers need to wait for active generation to complete.
		if (!autoTriggered) {
			try {
				await pWaitFor(
					() => !this.isStreaming && !this.isWaitingForFirstChunk && !this.presentAssistantMessageLocked,
					{ timeout: 60000, interval: 100 },
				)
			} catch (error) {
				console.warn(
					`[Task#${this.taskId}] compactContext: wait for streaming/locks timed out, proceeding with caution`,
					error,
				)
			}
		}

		if (this.isCompacting) {
			if (!autoTriggered) {
				throw new Error("Context compaction is already in progress.")
			}
			return
		}

		this.isCompacting = true
		this.compactionAbortController = new AbortController()

		try {
			await this.flushPendingToolResultsToHistory()

			const systemPrompt = await this.getSystemPrompt()
			const authorizationState = this.extractExplicitConstraints()
			const { scopedWriteAllows, supplementalWriteAllows, scopedWriteDenies } = authorizationState
			const taskContract = buildTaskContract(this.metadata?.task || "", this.clineMessages, {
				explicitConstraints: authorizationState.constraints,
				scopedWriteAllows,
				supplementalWriteAllows,
				scopedWriteDenies,
				canonicalConstraints: authorizationState.canonicalConstraints,
			})

			const {
				newHistory,
				summary,
				previousTokens,
				newTokens,
				cost,
			} = await compactHistory({
				messages: this.apiConversationHistory,
				apiHandler: this.api,
				systemPrompt,
				taskId: this.taskId,
				cwd: this.cwd,
				rooIgnoreController: this.rooIgnoreController,
				abortSignal: this.compactionAbortController.signal,
				scopedAllows: scopedWriteAllows,
				supplementalAllows: supplementalWriteAllows,
				scopedDenies: scopedWriteDenies,
				activeGoal: taskContract.currentGoal,
				taskContract,
				todoList: this.todoList,
				workspacePath: this.workspacePath || this.cwd,
			})

			// If condensation was aborted, do not overwrite history on disk
			if (this.compactionAbortController?.signal.aborted || this.abort) {
				return
			}

			await this.overwriteApiConversationHistory(newHistory)

			const contextCondense: ContextCondense = {
				summary,
				cost,
				prevContextTokens: previousTokens,
				newContextTokens: newTokens,
			}

			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)

			const savedTokens = Math.max(0, previousTokens - newTokens)
			const savedTokensPercentage =
				previousTokens > 0 ? Math.round((savedTokens / previousTokens) * 100) : 0

			const provider = this.providerRef.deref()
			await provider?.postMessageToWebview({
				type: "taskCompacted",
				text: this.taskId,
				previousTokens,
				newTokens,
				savedTokensPercentage,
				payload: {
					taskId: this.taskId,
					previousTokens,
					newTokens,
					savedTokens,
					savedTokensPercentage,
				},
			})
			await provider?.postMessageToWebview({
				type: "condenseTaskContextResponse",
				text: this.taskId,
			})

			await this.saveClineMessages()
			this.recordCompactionCompletion()
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			if (
				errorMessage.includes("truncated") ||
				errorMessage.includes("finish_reason") ||
				errorMessage.includes("incomplete")
			) {
				await this.say(
					"condense_context_error",
					errorMessage,
					undefined,
					false,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			console.error(`[Task#${this.taskId}] Context compaction failed:`, error)
			if (!autoTriggered) {
				throw error
			}
		} finally {
			this.isCompacting = false
			this.compactionAbortController = undefined
		}
	}

	public async compactConversation(
		customInstructions?: string,
	): Promise<{ previousTokens: number; newTokens: number; savedTokensPercentage: number }> {
		if (this.isCompacting) {
			throw new Error("Context compaction is already in progress.")
		}

		try {
			await pWaitFor(
				() => !this.isStreaming && !this.isWaitingForFirstChunk && !this.presentAssistantMessageLocked,
				{ timeout: 60000, interval: 100 },
			)
		} catch (error) {
			throw new Error(
				"Cannot compact context: active streaming or tool execution did not finish within 60 seconds. Please try again when the assistant is idle.",
			)
		}

		if (this.isCompacting) {
			throw new Error("Context compaction is already in progress.")
		}

		this.isCompacting = true
		this.compactionAbortController = new AbortController()

		try {
			await this.flushPendingToolResultsToHistory()

			const systemPrompt = await this.getSystemPrompt()
			const authorizationState = this.extractExplicitConstraints()
			const { scopedWriteAllows, supplementalWriteAllows, scopedWriteDenies } = authorizationState
			const taskContract = buildTaskContract(this.metadata?.task || "", this.clineMessages, {
				explicitConstraints: authorizationState.constraints,
				scopedWriteAllows,
				supplementalWriteAllows,
				scopedWriteDenies,
				canonicalConstraints: authorizationState.canonicalConstraints,
			})

			const {
				newHistory,
				summary,
				previousTokens,
				newTokens,
				cost,
			} = await compactHistory({
				messages: this.apiConversationHistory,
				apiHandler: this.api,
				systemPrompt,
				taskId: this.taskId,
				customInstructions,
				cwd: this.cwd,
				rooIgnoreController: this.rooIgnoreController,
				abortSignal: this.compactionAbortController.signal,
				scopedAllows: scopedWriteAllows,
				supplementalAllows: supplementalWriteAllows,
				scopedDenies: scopedWriteDenies,
				activeGoal: taskContract.currentGoal,
				taskContract,
				todoList: this.todoList,
				workspacePath: this.workspacePath || this.cwd,
			})

			// If condensation was aborted, do not overwrite history on disk
			if (this.compactionAbortController?.signal.aborted || this.abort) {
				throw new Error("Context condensation was aborted.")
			}

			await this.overwriteApiConversationHistory(newHistory)

			const contextCondense: ContextCondense = {
				summary,
				cost,
				prevContextTokens: previousTokens,
				newContextTokens: newTokens,
			}

			await this.say(
				"condense_context",
				undefined /* text */,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
				contextCondense,
			)

			const savedTokens = Math.max(0, previousTokens - newTokens)
			const savedTokensPercentage =
				previousTokens > 0 ? Math.round((savedTokens / previousTokens) * 100) : 0

			const provider = this.providerRef.deref()
			await provider?.postMessageToWebview({
				type: "taskCompacted",
				text: this.taskId,
				previousTokens,
				newTokens,
				savedTokensPercentage,
				payload: {
					taskId: this.taskId,
					previousTokens,
					newTokens,
					savedTokens,
					savedTokensPercentage,
				},
			})
			await provider?.postMessageToWebview({
				type: "condenseTaskContextResponse",
				text: this.taskId,
			})

			this.recordCompactionCompletion()

			return { previousTokens, newTokens, savedTokensPercentage }
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			if (
				errorMessage.includes("truncated") ||
				errorMessage.includes("finish_reason") ||
				errorMessage.includes("incomplete")
			) {
				await this.say(
					"condense_context_error",
					errorMessage,
					undefined,
					false,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			throw error
		} finally {
			this.isCompacting = false
			this.compactionAbortController = undefined
		}
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
		} = {},
		contextCondense?: ContextCondense,
		contextTruncation?: ContextTruncation,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		const isNonInteractive = options.isNonInteractive ?? (type === "command_safety_warning")

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						contextTruncation,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						contextTruncation,
						approvalState: type === "completion_result" ? "EVALUATING" : undefined,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
				contextTruncation,
				approvalState: type === "completion_result" ? "EVALUATING" : undefined,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Lifecycle
	// Start / Resume / Abort / Dispose

	/**
	 * Get enabled MCP tools count for this task.
	 * Returns the count along with the number of servers contributing.
	 *
	 * @returns Object with enabledToolCount and enabledServerCount
	 */
	private async getEnabledMcpToolsCount(): Promise<{ enabledToolCount: number; enabledServerCount: number }> {
		try {
			const provider = this.providerRef.deref()
			if (!provider) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const { mcpEnabled } = (await provider.getState()) ?? {}
			if (!(mcpEnabled ?? true)) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const mcpHub = await McpServerManager.getInstance(provider.context, provider)
			if (!mcpHub) {
				return { enabledToolCount: 0, enabledServerCount: 0 }
			}

			const servers = mcpHub.getServers()
			return countEnabledMcpTools(servers)
		} catch (error) {
			console.error("[Task#getEnabledMcpToolsCount] Error counting MCP tools:", error)
			return { enabledToolCount: 0, enabledServerCount: 0 }
		}
	}

	/**
	 * Manually start a **new** task when it was created with `startTask: false`.
	 *
	 * This fires `startTask` as a background async operation for the
	 * `task/images` code-path only.  It does **not** handle the
	 * `historyItem` resume path (use the constructor with `startTask: true`
	 * for that).  The primary use-case is in the delegation flow where the
	 * parent's metadata must be persisted to globalState **before** the
	 * child task begins writing its own history (avoiding a read-modify-write
	 * race on globalState).
	 */
	public start(): void {
		if (this._started) {
			return
		}
		this._started = true

		const { task, images } = this.metadata

		if (task || images) {
			this.startTask(task ?? undefined, images ?? undefined)
		}
	}

	private async startTask(task?: string, images?: string[]): Promise<void> {
		try {
			// `conversationHistory` (for API) and `clineMessages` (for webview)
			// need to be in sync.
			// If the extension process were killed, then on restart the
			// `clineMessages` might not be empty, so we need to set it to [] when
			// we create a new Cline client (otherwise webview would show stale
			// messages from previous session).
			this.clineMessages = []
			this.apiConversationHistory = []

			// The todo list is already set in the constructor if initialTodos were provided
			// No need to add any messages - the todoList property is already set

			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			await this.say("text", task, images)

			// Check for too many MCP tools and warn the user
			const { enabledToolCount, enabledServerCount } = await this.getEnabledMcpToolsCount()
			if (enabledToolCount > MAX_MCP_TOOLS_THRESHOLD) {
				await this.say(
					"too_many_tools_warning",
					JSON.stringify({
						toolCount: enabledToolCount,
						serverCount: enabledServerCount,
						threshold: MAX_MCP_TOOLS_THRESHOLD,
					}),
					undefined,
					undefined,
					undefined,
					undefined,
					{ isNonInteractive: true },
				)
			}
			this.isInitialized = true

			const imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

			// Task starting
			let nextUserContent: Anthropic.Messages.ContentBlockParam[] = [
				{
					type: "text",
					text: `<user_message>\n${task}\n</user_message>`,
				},
				...imageBlocks,
			]

			while (!this.abort && !this.abandoned) {
				await this.initiateTaskLoop(nextUserContent).catch((error) => {
					// Swallow loop rejection when the task was intentionally abandoned/aborted
					// during delegation or user cancellation to prevent unhandled rejections.
					if (this.abandoned === true || this.abortReason === "user_cancelled") {
						return
					}
					throw error
				})

				if (this.abort || this.abandoned) {
					break
				}

				this.auditLifecycleState("task_idle")

				// The task loop for this turn has ended (e.g. task completed or idle).
				// Transition to idle awaiting user continuation.
				const { response, text: nextText, images: nextImages } = await this.ask("resume_completed_task")

				if (response === "messageResponse" && (nextText || (nextImages && nextImages.length > 0))) {
					this.auditLifecycleState("next_user_message_accepted")
					this.isTaskCompleted = false
					await this.say("user_feedback", nextText, nextImages)
					const nextImageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(nextImages)
					nextUserContent = [
						{
							type: "text",
							text: `<user_message>\n${nextText || ""}\n</user_message>`,
						},
						...nextImageBlocks,
					]
				} else {
					break
				}
			}
		} catch (error) {
			// In tests and some UX flows, tasks can be aborted while `startTask` is still
			// initializing. Treat abort/abandon as expected and avoid unhandled rejections.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	private async resumeTaskFromHistory() {
		try {
			const modifiedClineMessages = await this.getSavedClineMessages()

			// Remove any resume messages that may have been added before.
			const lastRelevantMessageIndex = findLastIndex(
				modifiedClineMessages,
				(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
			)

			if (lastRelevantMessageIndex !== -1) {
				modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
			}

			// Remove any trailing reasoning-only UI messages that were not part of the persisted API conversation
			while (modifiedClineMessages.length > 0) {
				const last = modifiedClineMessages[modifiedClineMessages.length - 1]
				if (last.type === "say" && last.say === "reasoning") {
					modifiedClineMessages.pop()
				} else {
					break
				}
			}

			// Since we don't use `api_req_finished` anymore, we need to check if the
			// last `api_req_started` has a cost value, if it doesn't and no
			// cancellation reason to present, then we remove it since it indicates
			// an api request without any partial content streamed.
			const lastApiReqStartedIndex = findLastIndex(
				modifiedClineMessages,
				(m) => m.type === "say" && m.say === "api_req_started",
			)

			if (lastApiReqStartedIndex !== -1) {
				const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
				const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

				if (cost === undefined && cancelReason === undefined) {
					modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
				}
			}

			await this.overwriteClineMessages(modifiedClineMessages)
			this.clineMessages = await this.getSavedClineMessages()

			// Now present the cline messages to the user and ask if they want to
			// resume (NOTE: we ran into a bug before where the
			// apiConversationHistory wouldn't be initialized when opening a old
			// task, and it was because we were waiting for resume).
			// This is important in case the user deletes messages without resuming
			// the task first.
			this.apiConversationHistory = await this.getSavedApiConversationHistory()

			const lastClineMessage = this.clineMessages
				.slice()
				.reverse()
				.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

			// Check if there is an unresolved actionable ask waiting for user approval/decision.
			// If so, we must preserve it, not emit a new resume ask, and not mark the task completed.
			const lastAsk = [...this.clineMessages].reverse().find((m) => m.type === "ask")
			if (lastAsk && !lastAsk.isAnswered && lastAsk.approvalState === "EVALUATING") {
				lastAsk.approvalState = "USER_DECISION_REQUIRED"
				void this.updateClineMessage(lastAsk)
			}
			const trailingAfterAsk = lastAsk ? this.clineMessages.slice(this.clineMessages.lastIndexOf(lastAsk) + 1) : []
			const hasTrailingSafetyWarning = trailingAfterAsk.some((m) => m.say === "command_safety_warning")
			const trailingAllNonSubstantive = trailingAfterAsk.every(
				(m) =>
					m.type === "say" &&
					(m.say === "command_safety_warning" ||
						m.say === "api_req_rate_limit_wait" ||
						m.say === "api_req_retry_delayed" ||
						m.say === "api_req_started" ||
						m.say === "api_req_finished"),
			)

			const isCompletionRequiringApproval =
				lastAsk?.ask === "completion_result" &&
				(lastAsk.approvalState === "USER_DECISION_REQUIRED" || hasTrailingSafetyWarning)

			const isOtherActionableAsk =
				lastAsk &&
				lastAsk.ask !== "completion_result" &&
				lastAsk.ask !== "resume_completed_task" &&
				lastAsk.ask !== "resume_task" &&
				lastAsk.approvalState !== "AUTO_APPROVED" &&
				lastAsk.approvalState !== "DENIED" &&
				lastAsk.approvalState !== "EVALUATING"

			const isPendingActionableAsk = Boolean(
				lastAsk &&
					!lastAsk.isAnswered &&
					trailingAllNonSubstantive &&
					(isCompletionRequiringApproval || isOtherActionableAsk),
			)

			let responseText: string | undefined
			let responseImages: string[] | undefined

			if (isPendingActionableAsk && lastAsk) {
				this.isInitialized = true
				this.interactiveAsk = lastAsk
				this.lastMessageTs = lastAsk.ts
				if (this.historyItem) {
					this.historyItem.needsAttention = true
					if (this.historyItem.status !== "active") {
						this.historyItem.status = "interrupted"
					}
					await this.providerRef.deref()?.updateTaskHistory(this.historyItem)
				}
				this.emit(RooCodeEventName.TaskInteractive, this.taskId)
				await this.providerRef.deref()?.postStateToWebview()

				// Wait for the user to respond to this existing pending ask
				await pWaitFor(
					() => {
						if (this.abort) {
							return true
						}
						return this.askResponse !== undefined
					},
					{ interval: 100 },
				)

				if (this.abort) {
					return
				}

				const response = this.askResponse!
				const text = this.askResponseText
				const images = this.askResponseImages
				this.askResponse = undefined
				this.askResponseText = undefined
				this.askResponseImages = undefined
				this.interactiveAsk = undefined
				this.emit(RooCodeEventName.TaskActive, this.taskId)
				this.emit(RooCodeEventName.TaskAskResponded)

				if (lastAsk.ask === "completion_result") {
					if (response === "yesButtonClicked") {
						this.isTaskCompleted = true
						if (this.historyItem) {
							this.historyItem.status = "completed"
							this.historyItem.needsAttention = false
							await this.providerRef.deref()?.updateTaskHistory(this.historyItem)
						}
						lastAsk.approvalState = "AUTO_APPROVED"
						lastAsk.isAnswered = true
						this.updateClineMessage(lastAsk)
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "AUTO_APPROVED"
							this.updateClineMessage(completionSayMsg)
						}
						await this.saveClineMessages()
						await this.say("completion_result", "Task completed successfully.")
						await this.providerRef.deref()?.postStateToWebview()
						return
					} else {
						this.isTaskCompleted = false
						this.currentStatus = "active"
						if (this.historyItem) {
							this.historyItem.status = "active"
							this.historyItem.needsAttention = false
							await this.providerRef.deref()?.updateTaskHistory(this.historyItem)
						}
						lastAsk.approvalState = "DENIED"
						lastAsk.isAnswered = true
						this.updateClineMessage(lastAsk)
						const completionSayMsg = findLast(this.clineMessages, (m) => m.say === "completion_result")
						if (completionSayMsg) {
							completionSayMsg.approvalState = "DENIED"
							this.updateClineMessage(completionSayMsg)
						}
						await this.saveClineMessages()
						await this.say("user_feedback", text || "Completion denied by user. Continue working.", images)
						responseText = text || "Completion denied by user. Continue working."
						responseImages = images
					}
				} else if (response === "messageResponse") {
					this.isTaskCompleted = false
					this.currentStatus = "active"
					if (this.historyItem) {
						this.historyItem.status = "active"
						this.historyItem.needsAttention = false
						await this.providerRef.deref()?.updateTaskHistory(this.historyItem)
					}
					await this.say("user_feedback", text, images)
					responseText = text
					responseImages = images
				} else {
					this.isTaskCompleted = false
					this.currentStatus = "active"
					if (this.historyItem) {
						this.historyItem.status = "active"
						this.historyItem.needsAttention = false
						await this.providerRef.deref()?.updateTaskHistory(this.historyItem)
					}
					lastAsk.isAnswered = true
					if (response === "yesButtonClicked") {
						lastAsk.approvalState = "AUTO_APPROVED"
					} else if (response === "noButtonClicked") {
						lastAsk.approvalState = "DENIED"
					}
					this.updateClineMessage(lastAsk)
					await this.saveClineMessages()
				}
			} else {
				// Determine whether the task is completed or resting in an idle state.
				// A task is completed/idle if:
				// 1. Its status is "completed".
				// 2. The last message is a confirmed completion_result (ask or say).
				// 3. Any message in history is a completion_result without pending user decision.
				// 4. The model finished presenting output (e.g. say: "text") without unhandled errors or cancellations.
				const hasCompletionMessage =
					(lastClineMessage?.ask === "completion_result" ||
						lastClineMessage?.say === "completion_result" ||
						this.clineMessages.some((m) => m.ask === "completion_result" || m.say === "completion_result")) &&
					lastClineMessage?.approvalState !== "USER_DECISION_REQUIRED" &&
					lastClineMessage?.approvalState !== "DENIED" &&
					lastClineMessage?.approvalState !== "EVALUATING" &&
					!hasTrailingSafetyWarning

				const isFinishedTextResponse =
					lastClineMessage?.say === "text" &&
					!lastClineMessage.partial &&
					!this.clineMessages.some((m) => m.say === "error" && m === lastClineMessage)

				const isTaskCompletedOrIdle =
					this.initialStatus === "completed" ||
					this.historyItem?.status === "completed" ||
					hasCompletionMessage ||
					isFinishedTextResponse

				if (this.historyItem?.status === "delegated" && this.historyItem?.awaitingChildId) {
					this.isInitialized = true
					await this.providerRef.deref()?.postStateToWebview()
					return
				}

				let askType: ClineAsk
				if (isTaskCompletedOrIdle) {
					this.isTaskCompleted = true
					if (this.historyItem) {
						this.historyItem.status = "completed"
						this.historyItem.needsAttention = false
					}
					askType = "resume_completed_task"
				} else {
					askType = "resume_task"
				}

				this.isInitialized = true

				const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

				if (response === "messageResponse") {
					this.isTaskCompleted = false
					this.currentStatus = "active"
					if (this.historyItem) {
						this.historyItem.status = "active"
						this.historyItem.needsAttention = false
					}
					await this.say("user_feedback", text, images)
					responseText = text
					responseImages = images
				} else if (isTaskCompletedOrIdle) {
					// Task is completed/idle and user did not submit a continuation message.
					// Do not make any API requests.
					return
				}
			}

			// Make sure that the api conversation history can be resumed by the API,
			// even if it goes out of sync with cline messages.
			let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

			// Tool blocks are always preserved; native tool calling only.

			// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
			// if there's no tool use and only a text block, then we can just add a user message
			// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

			// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

			let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
			let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
			if (existingApiConversationHistory.length > 0) {
				const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

				if (lastMessage.isSummary) {
					// IMPORTANT: If the last message is a condensation summary, we must preserve it
					// intact. The summary message carries critical metadata (isSummary, condenseId)
					// that getEffectiveApiHistory() uses to filter out condensed messages.
					// Removing or merging it would destroy this metadata, causing all condensed
					// messages to become "orphaned" and restored to active status — effectively
					// undoing the condensation and sending the full history to the API.
					// See: https://github.com/RooCodeInc/Roo-Code/issues/11487
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				} else if (lastMessage.role === "assistant") {
					const content = Array.isArray(lastMessage.content)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					const hasToolUse = content.some((block) => block.type === "tool_use")

					if (hasToolUse) {
						const toolUseBlocks = content.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]
						const isTaskActuallyCompleted =
							this.isTaskCompleted ||
							this.historyItem?.status === "completed" ||
							this.initialStatus === "completed"
						const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
							type: "tool_result",
							tool_use_id: block.id,
							content:
								block.name === "attempt_completion" && isTaskActuallyCompleted
									? "Task completed successfully."
									: "Task was interrupted before this tool call could be completed.",
						}))
						modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
						modifiedOldUserContent = [...toolResponses]
					} else {
						modifiedApiConversationHistory = [...existingApiConversationHistory]
						modifiedOldUserContent = []
					}
				} else if (lastMessage.role === "user") {
					const previousAssistantMessage: ApiMessage | undefined =
						existingApiConversationHistory[existingApiConversationHistory.length - 2]

					const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(
						lastMessage.content,
					)
						? lastMessage.content
						: [{ type: "text", text: lastMessage.content }]
					if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
						const assistantContent = Array.isArray(previousAssistantMessage.content)
							? previousAssistantMessage.content
							: [{ type: "text", text: previousAssistantMessage.content }]

						const toolUseBlocks = assistantContent.filter(
							(block) => block.type === "tool_use",
						) as Anthropic.Messages.ToolUseBlock[]

						if (toolUseBlocks.length > 0) {
							const existingToolResults = existingUserContent.filter(
								(block) => block.type === "tool_result",
							) as Anthropic.ToolResultBlockParam[]

							const isTaskActuallyCompleted =
								this.isTaskCompleted ||
								this.historyItem?.status === "completed" ||
								this.initialStatus === "completed"
							const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
								.filter(
									(toolUse) =>
										!existingToolResults.some((result) => result.tool_use_id === toolUse.id),
								)
								.map((toolUse) => ({
									type: "tool_result",
									tool_use_id: toolUse.id,
									content:
										toolUse.name === "attempt_completion" && isTaskActuallyCompleted
											? "Task completed successfully."
											: "Task was interrupted before this tool call could be completed.",
								}))

							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
							modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
						} else {
							modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
							modifiedOldUserContent = [...existingUserContent]
						}
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					throw new Error("Unexpected: Last message is not a user or assistant message")
				}
			} else {
				throw new Error("Unexpected: No existing API conversation history")
			}

			let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

			const agoText = ((): string => {
				const timestamp = lastClineMessage?.ts ?? Date.now()
				const now = Date.now()
				const diff = now - timestamp
				const minutes = Math.floor(diff / 60000)
				const hours = Math.floor(minutes / 60)
				const days = Math.floor(hours / 24)

				if (days > 0) {
					return `${days} day${days > 1 ? "s" : ""} ago`
				}
				if (hours > 0) {
					return `${hours} hour${hours > 1 ? "s" : ""} ago`
				}
				if (minutes > 0) {
					return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
				}
				return "just now"
			})()

			if (responseText) {
				newUserContent.push({
					type: "text",
					text: `<user_message>\n${responseText}\n</user_message>`,
				})
			}

			if (responseImages && responseImages.length > 0) {
				newUserContent.push(...formatResponse.imageBlocks(responseImages))
			}

			// Ensure we have at least some content to send to the API.
			// If newUserContent is empty, add a minimal resumption message.
			if (newUserContent.length === 0) {
				newUserContent.push({
					type: "text",
					text: "[TASK RESUMPTION] Resuming task...",
				})
			}

			await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

			// Task resuming from history item.
			let currentLoopUserContent = newUserContent
			while (!this.abort && !this.abandoned) {
				await this.initiateTaskLoop(currentLoopUserContent)

				if (this.abort || this.abandoned) {
					break
				}

				this.auditLifecycleState("task_idle")

				// Transition to completed/idle state, actively awaiting user continuation
				const { response: contResponse, text: nextText, images: nextImages } = await this.ask("resume_completed_task")

				if (contResponse === "messageResponse" && (nextText || (nextImages && nextImages.length > 0))) {
					this.auditLifecycleState("next_user_message_accepted")
					this.isTaskCompleted = false
					await this.say("user_feedback", nextText, nextImages)
					const nextImageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(nextImages)
					currentLoopUserContent = [
						{
							type: "text",
							text: `<user_message>\n${nextText || ""}\n</user_message>`,
						},
						...nextImageBlocks,
					]
				} else {
					break
				}
			}
		} catch (error) {
			// Resume and cancellation can race when users issue repeated cancels.
			// Treat intentional abort/abandon flows as expected and avoid process-level crashes.
			if (this.abandoned === true || this.abort === true || this.abortReason === "user_cancelled") {
				return
			}
			throw error
		}
	}

	/**
	 * Clears any active stream watchdog timer to prevent stale timeouts during prompts or retry waits.
	 */
	public clearStreamWatchdog(): void {
		if (this.currentStreamWatchdogTimer) {
			clearTimeout(this.currentStreamWatchdogTimer)
			this.currentStreamWatchdogTimer = undefined
		}
	}

	/**
	 * Cancels the current HTTP request if one is in progress.
	 * This immediately aborts the underlying stream rather than waiting for the next chunk.
	 */
	public cancelCurrentRequest(): void {
		this.clearStreamWatchdog()
		if (this.currentRequestAbortController) {
			console.log(`[Task#${this.taskId}.${this.instanceId}] Aborting current HTTP request`)
			this.currentRequestAbortController.abort()
			this.currentRequestAbortController = undefined
		}
	}

	/**
	 * Resets all ephemeral streaming state flags between API turns, auto-recovery retries,
	 * and manual user retries. Crucially unlatches `didFinishAbortingStream` so that future
	 * stream aborts in the same task lifecycle are never skipped.
	 */
	public resetStreamingState(): void {
		this.didFinishAbortingStream = false
		this.currentStreamingContentIndex = 0
		this.currentStreamingDidCheckpoint = false
		this.assistantMessageContent = []
		this.didCompleteReadingStream = false
		this.userMessageContent = []
		this.userMessageContentReady = false
		this.didRejectTool = false
		this.didAlreadyUseTool = false
		this.assistantMessageSavedToHistory = false
		this.didToolFailInCurrentTurn = false
		this.presentAssistantMessageLocked = false
		this.presentAssistantMessageHasPendingUpdates = false
		this.streamingToolCallIndices.clear()
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	}

	/**
	 * Force emit a final token usage update, ignoring throttle.
	 * Called before task completion or abort to ensure final stats are captured.
	 * Triggers the debounce with current values and immediately flushes to ensure emit.
	 */
	public emitFinalTokenUsageUpdate(): void {
		const tokenUsage = this.getTokenUsage()
		this.debouncedEmitTokenUsage(tokenUsage, this.toolUsage)
		this.debouncedEmitTokenUsage.flush()
	}

	public async abortTask(isAbandoned = false) {
		// Aborting task

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.isStreaming = false
		this.isWaitingForFirstChunk = false
		this.clearStreamWatchdog()

		// Defensively finalize partial messages and api_req_started
		for (let i = this.clineMessages.length - 1; i >= 0; i--) {
			if (this.clineMessages[i].partial) {
				this.clineMessages[i].partial = false
			}
		}
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")
		if (lastApiReqIndex !== -1) {
			const lastMsg = this.clineMessages[lastApiReqIndex]
			try {
				const info = JSON.parse(lastMsg.text || "{}")
				if (info.cost === undefined && info.cancelReason === undefined) {
					info.cancelReason = this.abortReason || "user_cancelled"
					info.cost = 0
					info.costSource = "local-estimate"
					info.precision = "estimated"
					lastMsg.text = JSON.stringify(info)
				}
			} catch {}
		}

		// Immediately abort any in-progress context compaction
		this.compactionAbortController?.abort()

		// Reset consecutive error counters on abort (manual intervention)
		this.consecutiveNoToolUseCount = 0
		this.consecutiveNoAssistantMessagesCount = 0

		// Force final token usage update before abort event
		this.emitFinalTokenUsageUpdate()

		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	public dispose(): void {
		console.log(`[Task#dispose] disposing task ${this.taskId}.${this.instanceId}`)

		// Cancel any in-progress compaction
		try {
			this.compactionAbortController?.abort()
		} catch (error) {
			console.error("Error cancelling compaction:", error)
		}

		// Cancel any deferred approval recovery
		try {
			this.deferredRecoveryController?.cancel("task_disposed")
			this.deferredRecoveryController = undefined
		} catch (error) {
			console.error("Error cancelling deferred recovery:", error)
		}

		// Cancel any in-progress HTTP request
		try {
			this.cancelCurrentRequest()
		} catch (error) {
			console.error("Error cancelling current request:", error)
		}

		// Abort any active terminal process
		try {
			if (this.terminalProcess) {
				this.terminalProcess.abort()
				this.terminalProcess = undefined
			}
		} catch (error) {
			console.error("Error aborting terminal process during dispose:", error)
		}

		// Remove provider profile change listener
		try {
			if (this.providerProfileChangeListener) {
				const provider = this.providerRef.deref()
				if (provider) {
					provider.off(RooCodeEventName.ProviderProfileChanged, this.providerProfileChangeListener)
				}
				this.providerProfileChangeListener = undefined
			}
		} catch (error) {
			console.error("Error removing provider profile change listener:", error)
		}

		// Dispose message queue and remove event listeners.
		try {
			if (this.messageQueueStateChangedHandler) {
				this.messageQueueService.removeListener("stateChanged", this.messageQueueStateChangedHandler)
				this.messageQueueStateChangedHandler = undefined
			}

			this.messageQueueService.dispose()
		} catch (error) {
			console.error("Error disposing message queue:", error)
		}

		// Remove all event listeners to prevent memory leaks.
		try {
			this.removeAllListeners()
		} catch (error) {
			console.error("Error removing event listeners:", error)
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		// Cleanup command output artifacts
		getTaskDirectoryPath(this.globalStoragePath, this.taskId)
			.then((taskDir) => {
				const outputDir = path.join(taskDir, "command-output")
				return OutputInterceptor.cleanup(outputDir)
			})
			.catch((error) => {
				console.error("Error cleaning up command output artifacts:", error)
			})

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	// Subtasks
	// Spawn / Wait / Complete

	public async startSubtask(message: string, initialTodos: TodoItem[], mode: string) {
		const provider = this.providerRef.deref()

		if (!provider) {
			throw new Error("Provider not available")
		}

		const child = await (provider as any).delegateParentAndOpenChild({
			parentTaskId: this.taskId,
			message,
			initialTodos,
			mode,
		})
		return child
	}

	/**
	 * Resume parent task after delegation completion without showing resume ask.
	 * Used in metadata-driven subtask flow.
	 *
	 * This method:
	 * - Clears any pending ask states
	 * - Resets abort and streaming flags
	 * - Ensures next API call includes full context
	 * - Immediately continues task loop without user interaction
	 */
	public async resumeAfterDelegation(): Promise<void> {
		// Clear any ask states that might have been set during history load
		this.idleAsk = undefined
		this.resumableAsk = undefined
		this.interactiveAsk = undefined

		// Reset abort and streaming state to ensure clean continuation
		this.abort = false
		this.abandoned = false
		this.abortReason = undefined
		this.didFinishAbortingStream = false
		this.isStreaming = false
		this.isWaitingForFirstChunk = false

		// Ensure next API call includes full context after delegation
		this.skipPrevResponseIdOnce = true

		// Mark as initialized and active
		this.isInitialized = true
		this.currentStatus = "active"
		if (this.historyItem) {
			this.historyItem.status = "active"
			this.historyItem.needsAttention = false
			this.historyItem.awaitingChildId = undefined
		}
		this.emit(RooCodeEventName.TaskActive, this.taskId)

		// Load conversation history if not already loaded
		if (this.apiConversationHistory.length === 0) {
			this.apiConversationHistory = await this.getSavedApiConversationHistory()
		}

		// Add environment details to the existing last user message (which contains the tool_result)
		// This avoids creating a new user message which would cause consecutive user messages
		const environmentDetails = await getEnvironmentDetails(this, true)
		let lastUserMsgIndex = -1
		for (let i = this.apiConversationHistory.length - 1; i >= 0; i--) {
			if (this.apiConversationHistory[i].role === "user") {
				lastUserMsgIndex = i
				break
			}
		}
		if (lastUserMsgIndex >= 0 && lastUserMsgIndex === this.apiConversationHistory.length - 1) {
			const lastUserMsg = this.apiConversationHistory[lastUserMsgIndex]
			if (Array.isArray(lastUserMsg.content)) {
				// Remove any existing environment_details blocks before adding fresh ones
				const contentWithoutEnvDetails = lastUserMsg.content.filter(
					(block: Anthropic.Messages.ContentBlockParam) => {
						if (block.type === "text" && typeof block.text === "string") {
							const isEnvironmentDetailsBlock =
								block.text.trim().startsWith("<environment_details>") &&
								block.text.trim().endsWith("</environment_details>")
							return !isEnvironmentDetailsBlock
						}
						return true
					},
				)
				// Add fresh environment details
				lastUserMsg.content = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			}
		}

		// Save the updated history
		await this.saveApiConversationHistory()

		// Continue task loop - pass empty array to signal no new user content needed
		// The initiateTaskLoop will handle this by skipping user message addition
		await this.initiateTaskLoop([])
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort && !this.isTaskCompleted) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. When attempt_completion
			// succeeds or the task is marked completed, the loop breaks cleanly.
			// Otherwise, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop || this.isTaskCompleted) {
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		interface StackItem {
			userContent: Anthropic.Messages.ContentBlockParam[]
			includeFileDetails: boolean
			retryAttempt?: number
			userMessageWasRemoved?: boolean // Track if user message was removed due to empty response
		}

		const stack: StackItem[] = [{ userContent, includeFileDetails, retryAttempt: 0 }]

		while (stack.length > 0) {
			if (this.abort) {
				throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			if (this.isTaskCompleted) {
				return true
			}

			const currentItem = stack.pop()!
			const currentUserContent = currentItem.userContent
			const currentIncludeFileDetails = currentItem.includeFileDetails

			if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
				const { response, text, images } = await this.ask(
					"mistake_limit_reached",
					t("common:errors.mistake_limit_guidance"),
				)

				if (response === "messageResponse") {
					currentUserContent.push(
						...[
							{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
							...formatResponse.imageBlocks(images),
						],
					)

					await this.say("user_feedback", text, images)
				}

				this.clearEditFailureState()
			}

			// Getting verbose details is an expensive operation, it uses ripgrep to
			// top-down build file structure of project which for large projects can
			// take a few seconds. For the best UX we show a placeholder api_req_started
			// message with a loading spinner as this happens.

			// Determine API protocol based on provider and model
			const modelId = getModelId(this.apiConfiguration)
			const apiProvider = this.apiConfiguration.apiProvider
			const apiProtocol = getApiProtocol(
				apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
				modelId,
			)

			// Invariant verification: ensure worker model has not drifted from taskStartModel
			const currentHandlerModel = this.api.getModel().id
			if (this.taskStartModel && currentHandlerModel !== this.taskStartModel) {
				console.warn(
					`[TaskModelAudit#${this.taskId}] Model drift detected! Initial: ${this.taskStartModel}, Current: ${currentHandlerModel}. Active tasks must preserve their initial model.`,
				)
			}

			// Respect user-configured provider rate limiting BEFORE we emit api_req_started.
			// This prevents the UI from showing an "API Request..." spinner while we are
			// intentionally waiting due to the rate limit slider.
			//
			// NOTE: We also set Task.lastGlobalApiRequestTime here to reserve this slot
			// before we build environment details (which can take time).
			// This ensures subsequent requests (including subtasks) still honour the
			// provider rate-limit window.
			await this.maybeWaitForProviderRateLimit(currentItem.retryAttempt ?? 0)
			Task.lastGlobalApiRequestTime = performance.now()

			if (this.isTaskCompleted) {
				return true
			}

			await this.say(
				"api_req_started",
				JSON.stringify({
					apiProtocol,
				}),
			)

			const provider = this.providerRef.deref()
			const state = provider ? await provider.getState() : undefined

			const showRooIgnoredFiles = state?.showRooIgnoredFiles ?? false
			const includeDiagnosticMessages = state?.includeDiagnosticMessages ?? true
			const maxDiagnosticMessages = state?.maxDiagnosticMessages ?? 50
			const currentMode = state?.mode ?? defaultModeSlug

			const { content: parsedUserContent, mode: slashCommandMode } = await processUserContentMentions({
				userContent: currentUserContent,
				cwd: this.cwd,
				fileContextTracker: this.fileContextTracker,
				rooIgnoreController: this.rooIgnoreController,
				showRooIgnoredFiles,
				includeDiagnosticMessages,
				maxDiagnosticMessages,
				skillsManager: typeof provider?.getSkillsManager === "function" ? provider.getSkillsManager() : undefined,
				currentMode,
			})

			// Switch mode if specified in a slash command's frontmatter
			if (slashCommandMode) {
				const provider = this.providerRef.deref()
				if (provider) {
					const state = await provider.getState()
					const targetMode = getModeBySlug(slashCommandMode, state?.customModes)
					if (targetMode) {
						await provider.handleModeSwitch(slashCommandMode)
					}
				}
			}

			const environmentDetails = await getEnvironmentDetails(this, currentIncludeFileDetails)

			// Remove any existing environment_details blocks before adding fresh ones.
			// This prevents duplicate environment details when resuming tasks,
			// where the old user message content may already contain environment details from the previous session.
			// We check for both opening and closing tags to ensure we're matching complete environment detail blocks,
			// not just mentions of the tag in regular content.
			const contentWithoutEnvDetails = parsedUserContent.filter((block) => {
				if (block.type === "text" && typeof block.text === "string") {
					// Check if this text block is a complete environment_details block
					// by verifying it starts with the opening tag and ends with the closing tag
					const isEnvironmentDetailsBlock =
						block.text.trim().startsWith("<environment_details>") &&
						block.text.trim().endsWith("</environment_details>")
					return !isEnvironmentDetailsBlock
				}
				return true
			})

			// Add environment details as its own text block, separate from tool
			// results.
			let finalUserContent = [...contentWithoutEnvDetails, { type: "text" as const, text: environmentDetails }]
			// Only add user message to conversation history if:
			// 1. This is the first attempt (retryAttempt === 0), AND
			// 2. The original userContent was not empty (empty signals delegation resume where
			//    the user message with tool_result and env details is already in history), OR
			// 3. The message was removed in a previous iteration (userMessageWasRemoved === true)
			// This prevents consecutive user messages while allowing re-add when needed
			const isEmptyUserContent = currentUserContent.length === 0
			const shouldAddUserMessage =
				((currentItem.retryAttempt ?? 0) === 0 && !isEmptyUserContent) || currentItem.userMessageWasRemoved
			if (shouldAddUserMessage) {
				await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
			}

			// Since we sent off a placeholder api_req_started message to update the
			// webview while waiting to actually start the API request (to load
			// potential details for example), we need to update the text of that
			// message.
			const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

			this.clineMessages[lastApiReqIndex].text = JSON.stringify({
				apiProtocol,
			} satisfies ClineApiReqInfo)

			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

			try {
				let cacheWriteTokens = 0
				let cacheReadTokens = 0
				let inputTokens = 0
				let outputTokens = 0
				let usageReported = false
				let totalCost: number | undefined

				// We can't use `api_req_finished` anymore since it's a unique case
				// where it could come after a streaming message (i.e. in the middle
				// of being updated or executed).
				// Fortunately `api_req_finished` was always parsed out for the GUI
				// anyways, so it remains solely for legacy purposes to keep track
				// of prices in tasks from history (it's worth removing a few months
				// from now).
				const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (lastApiReqIndex < 0 || !this.clineMessages[lastApiReqIndex]) {
						return
					}

					const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")

					// Calculate total tokens and cost using provider-aware function
					const modelId = getModelId(this.apiConfiguration)
					const apiProvider = this.apiConfiguration.apiProvider
					const apiProtocol = getApiProtocol(
						apiProvider && !isRetiredProvider(apiProvider) ? apiProvider : undefined,
						modelId,
					)

					const effectiveInputTokens =
						inputTokens > 0
							? inputTokens
							: (cancelReason === "streaming_failed" && this.currentAuditRecord?.estimatedInputTokens)
								? this.currentAuditRecord.estimatedInputTokens
								: 0

					const costResult =
						apiProtocol === "anthropic"
							? calculateApiCostAnthropic(
									streamModelInfo,
									effectiveInputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)
							: calculateApiCostOpenAI(
									streamModelInfo,
									effectiveInputTokens,
									outputTokens,
									cacheWriteTokens,
									cacheReadTokens,
								)

					let costSource: CostSource
					let precision: CostPrecision
					let finalCost: number

					if (totalCost !== undefined) {
						costSource = "provider-reported"
						precision = "exact"
						finalCost = totalCost
					} else {
						finalCost = costResult.totalCost
						if (inputTokens === 0 && effectiveInputTokens > 0) {
							costSource = "local-estimate"
							precision = "estimated"
						} else if (
							(this.apiConfiguration as any).xkiroCustomModelInfo ||
							this.apiConfiguration.openAiCustomModelInfo
						) {
							costSource = "configured-pricing"
							precision = "exact"
						} else if (costResult.costSource) {
							costSource = costResult.costSource
							precision = costResult.precision ?? "estimated"
						} else if (
							this.apiConfiguration.apiProvider === "openrouter" ||
							this.apiConfiguration.apiProvider === "xkiro"
						) {
							costSource = "live-provider-pricing"
							precision =
								this.apiConfiguration.apiProvider === "xkiro"
									? "estimated"
									: "exact"
						} else {
							costSource = "local-estimate"
							precision = "estimated"
						}
					}

					this.clineMessages[lastApiReqIndex].text = JSON.stringify({
						...existingData,
						tokensIn: costResult.totalInputTokens,
						tokensOut: costResult.totalOutputTokens,
						cacheWrites: cacheWriteTokens,
						cacheReads: cacheReadTokens,
						tokenUsageSource: usageReported
							? this.apiConfiguration.apiProvider === "vscode-lm" ? "estimated" : "provider"
							: effectiveInputTokens > 0 ? "estimated" : "unavailable",
						cost: finalCost,
						costSource,
						precision,
						cancelReason,
						streamingFailedMessage,
					} satisfies ClineApiReqInfo)

					if (isTokenAuditEnabled()) {
						recordCostAudit(this.taskId, {
							requestId: this.currentAuditRecord?.requestId,
							model: modelId ?? "unknown",
							provider: apiProvider,
							inputTokens: costResult.totalInputTokens,
							outputTokens: costResult.totalOutputTokens,
							cacheReadTokens,
							cacheWriteTokens,
							cost: finalCost,
							costSource,
							precision,
						})
					}
				}

				const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
					if (this.diffViewProvider.isEditing) {
						await this.diffViewProvider.revertChanges() // closes diff view
					}

					// Defensively finalize any partial messages
					for (let i = this.clineMessages.length - 1; i >= 0; i--) {
						if (this.clineMessages[i].partial) {
							this.clineMessages[i].partial = false
						}
					}

					this.isStreaming = false
					this.isWaitingForFirstChunk = false

					// Update `api_req_started` to have cancelled and cost, so that
					// we can display the cost of the partial stream and the cancellation reason
					updateApiReqMsg(cancelReason, streamingFailedMessage)
					await this.saveClineMessages()
					await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

					console.log(
						`[StreamAudit] Task ${this.taskId}.${this.instanceId} stream aborted. Reason: ${cancelReason}, message: ${streamingFailedMessage ?? "none"}`,
					)

					// Signals to provider that it can retrieve the saved messages
					// from disk, as abortTask can not be awaited on in nature.
					this.didFinishAbortingStream = true
				}

				// Reset streaming state for each new API request
				this.resetStreamingState()

				await this.diffViewProvider.reset()

				// Cache model info once per API request to avoid repeated calls during streaming
				// Cache model info once per API request to avoid repeated calls during streaming
				// This is especially important for tools and background usage collection
				this.cachedStreamingModel = this.api.getModel()
				const streamModelInfo = this.cachedStreamingModel.info
				const cachedModelId = this.cachedStreamingModel.id

				const isReasoningModel = Boolean(
					(streamModelInfo as any)?.reasoning ||
					(streamModelInfo as any)?.thinking ||
					(streamModelInfo as any)?.supportsReasoningEffort ||
					(streamModelInfo as any)?.supportsReasoningBudget ||
					(streamModelInfo as any)?.preserveReasoning ||
					modelSupportsReasoning(cachedModelId, streamModelInfo) ||
					cachedModelId.toLowerCase().includes("reason") ||
					cachedModelId.toLowerCase().includes("think") ||
					cachedModelId.toLowerCase().includes("qwen") ||
					cachedModelId.toLowerCase().includes("deepseek-r1") ||
					cachedModelId.toLowerCase().includes("claude-3-7-sonnet") ||
					cachedModelId.toLowerCase().includes("o1") ||
					cachedModelId.toLowerCase().includes("o3") ||
					cachedModelId.toLowerCase().includes("o4") ||
					cachedModelId.toLowerCase().includes("gpt-5") ||
					cachedModelId.toLowerCase().includes("gpt-6") ||
					cachedModelId.toLowerCase().includes("astra") ||
					cachedModelId.toLowerCase().includes("sol"),
				)

				// Adaptive first-chunk timeout:
				// Base: 90s for reasoning models (P99 is 87.5s), 60s for standard models.
				// For large prompts (>30k tokens), scale dynamically because server-side prefill adds latency across all providers.
				const estimatedInputTokens =
					this.currentAuditRecord?.estimatedInputTokens ??
					this.currentAuditRecord?.providerInputTokens ??
					(currentUserContent ? JSON.stringify(currentUserContent).length / 4 : 0)
				const promptSizeMarginMs =
					estimatedInputTokens > 30_000
						? Math.min(60_000, Math.floor(estimatedInputTokens / 20_000) * 15_000)
						: 0

				const initialFirstChunkTimeout =
					(isReasoningModel ? REASONING_FIRST_CHUNK_TIMEOUT_MS : FIRST_CHUNK_TIMEOUT_MS) + promptSizeMarginMs
				let currentIdleTimeout = isReasoningModel ? REASONING_STREAM_IDLE_TIMEOUT_MS : DEFAULT_STREAM_IDLE_TIMEOUT_MS
				let currentWatchdogTimeout = initialFirstChunkTimeout
				let currentStreamPhase: StreamPhase = "waiting_first_chunk"
				let hadReasoning = false
				let lastMeaningfulEventTime = performance.now()

				const getPhaseTimeoutErrorMessage = (phase: StreamPhase, timeoutMs: number) => {
					const seconds = Math.round(timeoutMs / 1000)
					switch (phase) {
						case "waiting_first_chunk":
							return `First chunk timeout: no data received from provider for ${seconds} seconds`
						case "reasoning":
							return `Reasoning stream timeout: no reasoning data received from provider for ${seconds} seconds`
						case "post_reasoning_wait":
							return `Stream idle timeout: no data received after reasoning completed for ${seconds} seconds`
						case "content":
							return `Stream idle timeout: content generation stalled, no data received from provider for ${seconds} seconds`
						case "tool_call":
							return `Stream idle timeout: tool call generation stalled, no data received from provider for ${seconds} seconds`
						default:
							return `Stream idle timeout: no data received from provider for ${seconds} seconds`
					}
				}

				const currentRetry = currentItem.retryAttempt ?? 0
				const streamAudit = new StreamAuditTracker(
					this.taskId,
					this.instanceId,
					this.apiConfiguration.apiProvider,
					cachedModelId,
					currentRetry,
					initialFirstChunkTimeout,
				)

				// Yields only if the first chunk is successful, otherwise will
				// allow the user to retry the request (most likely due to rate
				// limit error, which gets thrown on the first chunk).
				const stream = this.attemptApiRequest(currentItem.retryAttempt ?? 0, { skipProviderRateLimit: true })
				let streamIterator: AsyncIterator<any> | undefined
				let assistantMessage = ""
				let reasoningMessage = ""
				let pendingGroundingSources: GroundingSource[] = []
				// Note: Do not set this.isStreaming = true here. attemptApiRequest is still
				// preparing the request and may trigger auto-compaction. Setting it prematurely
				// causes a deadlock with compactContext. isStreaming is set once the first chunk arrives.
				let lastChunkTime = performance.now()

				try {
					const iterator = stream[Symbol.asyncIterator]()
					streamIterator = iterator

					// Helper to race iterator.next() with abort signal and adaptive stream idle watchdog
					const nextChunkWithAbort = async (timeoutMs?: number, phase?: StreamPhase) => {
						const nextPromise = iterator.next()
						const activePhase = phase ?? currentStreamPhase
						streamAudit.recordPhase(activePhase)
						currentWatchdogTimeout = timeoutMs ?? currentWatchdogTimeout

						// If we have an abort controller, race it with the next chunk
						let abortCleanup: (() => void) | undefined
						const abortPromise = new Promise<never>((_, reject) => {
							if (this.currentRequestAbortController) {
								const signal = this.currentRequestAbortController.signal
								if (signal.aborted) {
									reject(new Error("Request cancelled by user"))
								} else {
									const onAbort = () => reject(new Error("Request cancelled by user"))
									signal.addEventListener("abort", onAbort, { once: true })
									abortCleanup = () => signal.removeEventListener("abort", onAbort)
								}
							}
						})

						// Stream idle watchdog: during active streaming, detect stalled connections
						// after timeoutMs of complete silence.
						let idleTimer: NodeJS.Timeout | undefined
						const idlePromise = timeoutMs
							? new Promise<never>((_, reject) => {
									idleTimer = setTimeout(() => {
										streamAudit.recordIdleTimeout(true)
										reject(new Error(getPhaseTimeoutErrorMessage(activePhase, timeoutMs)))
									}, timeoutMs)
									this.currentStreamWatchdogTimer = idleTimer
							  })
							: null

						try {
							const raceList: Promise<any>[] = [nextPromise, abortPromise]
							if (idlePromise) {
								raceList.push(idlePromise)
							}
							const res = await Promise.race(raceList)
							lastChunkTime = performance.now()
							return res
						} finally {
							if (idleTimer) {
								clearTimeout(idleTimer)
								if (this.currentStreamWatchdogTimer === idleTimer) {
									this.currentStreamWatchdogTimer = undefined
								}
							}
							if (abortCleanup) abortCleanup()
						}
					}

					let item = await nextChunkWithAbort(initialFirstChunkTimeout, "waiting_first_chunk")
					this.isStreaming = true
					while (!item.done) {
						const chunk = item.value
						if (!chunk) {
							// Sometimes chunk is undefined, no idea that can cause
							// it, but this workaround seems to fix it.
							if (currentStreamPhase === "reasoning") {
								currentStreamPhase = "post_reasoning_wait"
							}
							item = await nextChunkWithAbort(currentIdleTimeout, currentStreamPhase)
							continue
						}

						// Guard against infinite no-op/heartbeat spam without meaningful progress
						if (performance.now() - lastMeaningfulEventTime > MAX_NO_PROGRESS_TIMEOUT_MS) {
							throw new Error(
								`Stream no-progress timeout: received heartbeat/keep-alive frames but no content for ${MAX_NO_PROGRESS_TIMEOUT_MS / 1000} seconds`,
							)
						}

						switch (chunk.type) {
							case "heartbeat": {
								// Transport activity without assistant content (SSE comment, keepalive ping, role-only frame).
								// Watchdog was reset by chunk arrival, but no message content is created.
								streamAudit.recordChunk("heartbeat")
								if (hadReasoning) {
									currentStreamPhase = "post_reasoning_wait"
								}
								if (
									currentStreamPhase === "waiting_first_chunk" ||
									currentStreamPhase === "reasoning" ||
									currentStreamPhase === "post_reasoning_wait"
								) {
									currentIdleTimeout = isReasoningModel
										? REASONING_STREAM_IDLE_TIMEOUT_MS
										: DEFAULT_STREAM_IDLE_TIMEOUT_MS
								}
								break
							}
							case "reasoning": {
								hadReasoning = true
								currentStreamPhase = "reasoning"
								currentIdleTimeout = REASONING_STREAM_IDLE_TIMEOUT_MS
								lastMeaningfulEventTime = performance.now()
								streamAudit.recordChunk("reasoning", chunk.text.length)
								reasoningMessage += chunk.text
								// Only apply formatting if the message contains sentence-ending punctuation followed by **
								let formattedReasoning = reasoningMessage
								if (reasoningMessage.includes("**")) {
									// Add line breaks before **Title** patterns that appear after sentence endings
									// This targets section headers like "...end of sentence.**Title Here**"
									// Handles periods, exclamation marks, and question marks
									formattedReasoning = reasoningMessage.replace(
										/([.!?])\*\*([^*\n]+)\*\*/g,
										"$1\n\n**$2**",
									)
								}
								await this.say("reasoning", formattedReasoning, undefined, true)
								break
							}
							case "usage":
								streamAudit.recordChunk("usage")
								usageReported ||= chunk.inputTokens > 0 || chunk.outputTokens > 0
								inputTokens += chunk.inputTokens
								outputTokens += chunk.outputTokens
								cacheWriteTokens += chunk.cacheWriteTokens ?? 0
								cacheReadTokens += chunk.cacheReadTokens ?? 0
								totalCost = chunk.totalCost
								if (isTokenAuditEnabled() && this.currentAuditRecord) {
									recordProviderUsage(this.taskId, this.currentAuditRecord, {
										inputTokens: chunk.inputTokens,
										outputTokens: chunk.outputTokens,
										cacheReadTokens: chunk.cacheReadTokens,
									})
								}
								break
							case "grounding":
								streamAudit.recordChunk("grounding")
								// Handle grounding sources separately from regular content
								// to prevent state persistence issues - store them separately
								if (chunk.sources && chunk.sources.length > 0) {
									pendingGroundingSources.push(...chunk.sources)
								}
								break
							case "tool_call_partial": {
								currentStreamPhase = "tool_call"
								currentIdleTimeout = DEFAULT_STREAM_IDLE_TIMEOUT_MS
								lastMeaningfulEventTime = performance.now()
								streamAudit.recordChunk("tool_call_partial", chunk.arguments?.length || 0)
								// Process raw tool call chunk through NativeToolCallParser
								// which handles tracking, buffering, and emits events
								const events = NativeToolCallParser.processRawChunk({
									index: chunk.index,
									id: chunk.id,
									name: chunk.name,
									arguments: chunk.arguments,
								})

								for (const event of events) {
									if (event.type === "tool_call_start") {
										// Guard against duplicate tool_call_start events for the same tool ID.
										// This can occur due to stream retry, reconnection, or API quirks.
										// Without this check, duplicate tool_use blocks with the same ID would
										// be added to assistantMessageContent, causing API 400 errors:
										// "tool_use ids must be unique"
										if (this.streamingToolCallIndices.has(event.id)) {
											console.warn(
												`[Task#${this.taskId}] Ignoring duplicate tool_call_start for ID: ${event.id} (tool: ${event.name})`,
											)
											continue
										}

										// Initialize streaming in NativeToolCallParser
										NativeToolCallParser.startStreamingToolCall(event.id, event.name as ToolName)

										// Before adding a new tool, finalize any preceding text block
										// This prevents the text block from blocking tool presentation
										const lastBlock =
											this.assistantMessageContent[this.assistantMessageContent.length - 1]
										if (lastBlock?.type === "text" && lastBlock.partial) {
											lastBlock.partial = false
										}

										// Track the index where this tool will be stored
										const toolUseIndex = this.assistantMessageContent.length
										this.streamingToolCallIndices.set(event.id, toolUseIndex)

										// Create initial partial tool use
										const partialToolUse: ToolUse = {
											type: "tool_use",
											name: event.name as ToolName,
											params: {},
											partial: true,
										}

										// Store the ID for native protocol
										;(partialToolUse as any).id = event.id

										// Add to content and present
										this.assistantMessageContent.push(partialToolUse)
										this.userMessageContentReady = false
										presentAssistantMessage(this)
									} else if (event.type === "tool_call_delta") {
										// Process chunk using streaming JSON parser
										const partialToolUse = NativeToolCallParser.processStreamingChunk(
											event.id,
											event.delta,
										)

										if (partialToolUse) {
											// Get the index for this tool call
											const toolUseIndex = this.streamingToolCallIndices.get(event.id)
											if (toolUseIndex !== undefined) {
												// Store the ID for native protocol
												;(partialToolUse as any).id = event.id

												// Update the existing tool use with new partial data
												this.assistantMessageContent[toolUseIndex] = partialToolUse

												// Present updated tool use
												presentAssistantMessage(this)
											}
										}
									} else if (event.type === "tool_call_end") {
										// Finalize the streaming tool call
										const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

										// Get the index for this tool call
										const toolUseIndex = this.streamingToolCallIndices.get(event.id)

										if (finalToolUse) {
											// Store the tool call ID
											;(finalToolUse as any).id = event.id

											// Get the index and replace partial with final
											if (toolUseIndex !== undefined) {
												this.assistantMessageContent[toolUseIndex] = finalToolUse
											}

											// Clean up tracking
											this.streamingToolCallIndices.delete(event.id)

											// Mark that we have new content to process
											this.userMessageContentReady = false

											// Present the finalized tool call
											presentAssistantMessage(this)
										} else if (toolUseIndex !== undefined) {
											// finalizeStreamingToolCall returned null (malformed JSON or missing args)
											// Mark the tool as non-partial so it's presented as complete, but execution
											// will be short-circuited in presentAssistantMessage with a structured tool_result.
											const existingToolUse = this.assistantMessageContent[toolUseIndex]
											if (existingToolUse && existingToolUse.type === "tool_use") {
												existingToolUse.partial = false
												// Ensure it has the ID for native protocol
												;(existingToolUse as any).id = event.id
											}

											// Clean up tracking
											this.streamingToolCallIndices.delete(event.id)

											// Mark that we have new content to process
											this.userMessageContentReady = false

											// Present the tool call - validation will handle missing params
											presentAssistantMessage(this)
										}
									}
								}
								break
							}

							case "tool_call": {
								currentStreamPhase = "tool_call"
								currentIdleTimeout = DEFAULT_STREAM_IDLE_TIMEOUT_MS
								lastMeaningfulEventTime = performance.now()
								streamAudit.recordChunk("tool_call", chunk.arguments?.length || 0)
								// Legacy: Handle complete tool calls (for backward compatibility)
								// Convert native tool call to ToolUse format
								const toolUse = NativeToolCallParser.parseToolCall({
									id: chunk.id,
									name: chunk.name as ToolName,
									arguments: chunk.arguments,
								})

								if (!toolUse) {
									console.error(`Failed to parse tool call for task ${this.taskId}:`, chunk)
									break
								}

								// Store the tool call ID on the ToolUse object for later reference
								// This is needed to create tool_result blocks that reference the correct tool_use_id
								toolUse.id = chunk.id

								// Add the tool use to assistant message content
								this.assistantMessageContent.push(toolUse)

								// Mark that we have new content to process
								this.userMessageContentReady = false

								// Present the tool call to user - presentAssistantMessage will execute
								// tools sequentially and accumulate all results in userMessageContent
								presentAssistantMessage(this)
								break
							}
							case "text": {
								currentStreamPhase = "content"
								currentIdleTimeout = DEFAULT_STREAM_IDLE_TIMEOUT_MS
								lastMeaningfulEventTime = performance.now()
								streamAudit.recordChunk("text", chunk.text.length)
								assistantMessage += chunk.text

								// Native tool calling: text chunks are plain text.
								// Create or update a text content block directly
								const lastBlock = this.assistantMessageContent[this.assistantMessageContent.length - 1]
								if (lastBlock?.type === "text" && lastBlock.partial) {
									lastBlock.content = assistantMessage
								} else {
									this.assistantMessageContent.push({
										type: "text",
										content: assistantMessage,
										partial: true,
									})
									this.userMessageContentReady = false
								}
								presentAssistantMessage(this)
								break
							}
						}

						if (this.abort) {
							console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

							if (!this.didFinishAbortingStream) {
								await abortStream("user_cancelled")
							}

							break // Aborts the stream.
						}

						if (this.didRejectTool) {
							// `userContent` has a tool rejection, so interrupt the
							// assistant's response to present the user's feedback.
							assistantMessage += "\n\n[Response interrupted by user feedback]"
							// Instead of setting this preemptively, we allow the
							// present iterator to finish and set
							// userMessageContentReady when its ready.
							// this.userMessageContentReady = true
							break
						}

						if (this.didAlreadyUseTool) {
							assistantMessage +=
								"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
							break
						}

						item = await nextChunkWithAbort(currentIdleTimeout, currentStreamPhase)
					}

					streamAudit.recordOutcome(true)
					streamAudit.log()

					if (isTokenAuditEnabled() && this.currentAuditRecord) {
						recordRequestTiming(this.taskId, this.currentAuditRecord, {
							lastChunkAgoMs: performance.now() - lastChunkTime,
						})
					}

					// Create a copy of current token values to avoid race conditions
					const currentTokens = {
						input: inputTokens,
						output: outputTokens,
						cacheWrite: cacheWriteTokens,
						cacheRead: cacheReadTokens,
						total: totalCost,
					}

					const drainStreamInBackgroundToFindAllUsage = async (apiReqIndex: number) => {
						const timeoutMs = DEFAULT_USAGE_COLLECTION_TIMEOUT_MS
						const startTime = performance.now()
						const modelId = getModelId(this.apiConfiguration)

						// Local variables to accumulate usage data without affecting the main flow
						let bgInputTokens = currentTokens.input
						let bgOutputTokens = currentTokens.output
						let bgCacheWriteTokens = currentTokens.cacheWrite
						let bgCacheReadTokens = currentTokens.cacheRead
						let bgTotalCost = currentTokens.total

						// Helper function to update messages
						const captureUsageData = async (
							tokens: {
								input: number
								output: number
								cacheWrite: number
								cacheRead: number
								total?: number
							},
							messageIndex: number = apiReqIndex,
						) => {
							if (
								tokens.input > 0 ||
								tokens.output > 0 ||
								tokens.cacheWrite > 0 ||
								tokens.cacheRead > 0
							) {
								inputTokens = tokens.input
								outputTokens = tokens.output
								cacheWriteTokens = tokens.cacheWrite
								cacheReadTokens = tokens.cacheRead
								totalCost = tokens.total

								updateApiReqMsg()
								await this.saveClineMessages()

								const apiReqMessage = this.clineMessages[messageIndex]
								if (apiReqMessage) {
									await this.updateClineMessage(apiReqMessage)
								}
							}
						}

						try {
							// Continue processing the original stream from where the main loop left off
							let usageFound = false
							let chunkCount = 0

							// Use the same iterator that the main loop was using
							while (!item.done) {
								// Check for timeout
								if (performance.now() - startTime > timeoutMs) {
									console.warn(
										`[Background Usage Collection] Timed out after ${timeoutMs}ms for model: ${modelId}, processed ${chunkCount} chunks`,
									)
									// Clean up the iterator before breaking
									if (iterator.return) {
										await iterator.return(undefined)
									}
									break
								}

								const chunk = item.value
								item = await iterator.next()
								chunkCount++

								if (chunk && chunk.type === "usage") {
									usageFound = true
									usageReported ||= chunk.inputTokens > 0 || chunk.outputTokens > 0
									bgInputTokens += chunk.inputTokens
									bgOutputTokens += chunk.outputTokens
									bgCacheWriteTokens += chunk.cacheWriteTokens ?? 0
									bgCacheReadTokens += chunk.cacheReadTokens ?? 0
									bgTotalCost = chunk.totalCost
								}
							}

							if (
								usageFound ||
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								// We have usage data either from a usage chunk or accumulated tokens
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							} else {
								console.warn(
									`[Background Usage Collection] Suspicious: request ${apiReqIndex} is complete, but no usage info was found. Model: ${modelId}`,
								)
							}
						} catch (error) {
							console.error("Error draining stream for usage data:", error)
							// Still try to capture whatever usage data we have collected so far
							if (
								bgInputTokens > 0 ||
								bgOutputTokens > 0 ||
								bgCacheWriteTokens > 0 ||
								bgCacheReadTokens > 0
							) {
								await captureUsageData(
									{
										input: bgInputTokens,
										output: bgOutputTokens,
										cacheWrite: bgCacheWriteTokens,
										cacheRead: bgCacheReadTokens,
										total: bgTotalCost,
									},
									lastApiReqIndex,
								)
							}
						}
					}

					// Start the background task and handle any errors
					drainStreamInBackgroundToFindAllUsage(lastApiReqIndex).catch((error) => {
						console.error("Background usage collection failed:", error)
					})
				} catch (error: any) {
					if (isTokenAuditEnabled() && this.currentAuditRecord) {
						recordRequestTiming(this.taskId, this.currentAuditRecord, {
							lastChunkAgoMs: performance.now() - lastChunkTime,
						})
					}

					const isUserCancelled =
						this.abort ||
						this.abortReason === "user_cancelled" ||
						error?.name === "AbortError" ||
						error?.message?.includes("Request cancelled by user") ||
						error?.message?.includes("cancelled by user")

					if (isUserCancelled) {
						this.abort = true
						this.abortReason = "user_cancelled"
						if (!this.didFinishAbortingStream) {
							await abortStream("user_cancelled")
						}
						await this.abortTask()
						break
					}

					// Abandoned happens when extension is no longer waiting for the
					// Cline instance to finish aborting (error is thrown here when
					// any function in the for loop throws due to this.abort).
					if (!this.abandoned) {
						const rawErrorMessage = error?.message ?? JSON.stringify(serializeError(error), null, 2)
						const classification = classifyApiError(error)
						const currentRetry = currentItem.retryAttempt ?? 0
						const isStreamIdle = classification.category === "stream_idle"
						const isSafeToAutoRetry =
							!this.didAlreadyUseTool &&
							this.userMessageContent.length === 0 &&
							!this.currentStreamingDidCheckpoint

						const state = await this.providerRef.deref()?.getState()
						const autoApproval = !!state?.autoApprovalEnabled
						const maxStreamIdleRetries = autoApproval
							? Math.max(4, classification.maxRetries)
							: Math.max(2, classification.maxRetries)

						// Safe automatic recovery: retry for stream idle stalls if no side-effects executed
						if (isStreamIdle && isSafeToAutoRetry && currentRetry < maxStreamIdleRetries && !this.abort) {
							console.warn(
								`[Task#${this.taskId}.${this.instanceId}] Transient stream idle timeout detected. Attempting automatic recovery (retry ${currentRetry + 1}/${maxStreamIdleRetries})`,
							)
							streamAudit.recordOutcome(false, rawErrorMessage, true)
							streamAudit.log()

							// Revert diff view changes if currently editing
							if (this.diffViewProvider.isEditing) {
								await this.diffViewProvider.revertChanges()
							}

							// Clean up any uncommitted partial assistant/reasoning messages from this streaming turn
							if (lastApiReqIndex >= 0 && this.clineMessages.length > lastApiReqIndex + 1) {
								this.clineMessages.splice(lastApiReqIndex + 1)
							} else {
								const lastMsg = this.clineMessages.at(-1)
								if (lastMsg && lastMsg.partial) {
									this.clineMessages.pop()
								}
							}

							// Reset partial streaming state
							this.assistantMessageContent = []
							this.streamingToolCallIndices.clear()
							NativeToolCallParser.clearAllStreamingToolCalls()
							NativeToolCallParser.clearRawChunkState()

							await this.saveClineMessages()
							await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

							// Subtle retry notification UX instead of scary red error box
							await this.say("api_req_retry_delayed", t("common:interruption.connectionStalledRetrying"))

							// Adaptive backoff with jitter - abortable on TaskAborted/abort
							// For stream idle stalls, allow realistic upstream recovery intervals (e.g. 5s, 15s, 45s) rather than immediate rapid bursts
							const baseSeconds = isStreamIdle ? 5 : (classification.retryAfterSeconds ?? 3)
							const backoffMultiplier = isStreamIdle ? Math.pow(3, currentRetry) : Math.pow(2, currentRetry)
							const backoffMs = Math.min(60_000, baseSeconds * backoffMultiplier * 1000)
							const jitterMs = Math.floor(Math.random() * 1500)
							const waitMs = backoffMs + jitterMs

							// Coordinate provider-scoped cooldown so concurrent sibling chats don't hammer degraded gateway
							try {
								const providerKey = ProviderRequestCoordinator.getInstance().deriveProviderKey(
									this.apiConfiguration?.apiProvider,
									this.apiConfiguration?.apiKey,
									state?.currentApiConfigName,
								)
								ProviderRequestCoordinator.getInstance().reportTransientStall(providerKey, Math.ceil(waitMs / 1000))
							} catch (e) {
								// Ignore coordination errors
							}

							await new Promise<void>((resolve) => {
								let timer: NodeJS.Timeout | undefined
								const onAbort = () => {
									if (timer) clearTimeout(timer)
									this.off(RooCodeEventName.TaskAborted, onAbort)
									resolve()
								}
								if (this.abort) {
									resolve()
								}
								this.once(RooCodeEventName.TaskAborted, onAbort)
								timer = setTimeout(() => {
									this.off(RooCodeEventName.TaskAborted, onAbort)
									resolve()
								}, waitMs)
							})

							if (this.abort) {
								this.abortReason = "user_cancelled"
								await this.abortTask()
								break
							}

							// Clean up in-flight request, socket, and watchdog before next attempt
							this.resetStreamingState()
							this.clearStreamWatchdog()
							this.cancelCurrentRequest()
							try {
								await stream.return(undefined)
								await streamIterator?.return?.(undefined)
							} catch (e) {
								// Ignore errors during iterator cancellation
							}
							this.currentRequestAbortController = undefined

							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: currentRetry + 1,
							})
							continue
						}

						streamAudit.recordOutcome(false, rawErrorMessage, false)
						streamAudit.log()

						// Determine cancellation reason
						const cancelReason: ClineApiReqCancelReason = this.abort ? "user_cancelled" : "streaming_failed"

						const formattedModelName = cleanModelDisplayName(cachedModelId)
						const providerDisplayName =
							this.apiConfiguration.apiProvider === "xkiro"
								? "xKiro"
								: (this.apiConfiguration.apiProvider || "Provider")

						const phaseDisplay =
							currentStreamPhase === "waiting_first_chunk"
								? "first-chunk"
								: currentStreamPhase === "reasoning"
								? "reasoning"
								: currentStreamPhase === "post_reasoning_wait"
								? "post-reasoning"
								: currentStreamPhase === "tool_call"
								? "tool-call"
								: "content"

						const effectiveMaxRetries = isStreamIdle
							? maxStreamIdleRetries
							: classification.maxRetries

						const streamingFailedDetails = isStreamIdle
							? [
									`Error type: Stream idle timeout`,
									`Phase: ${phaseDisplay}`,
									`Timeout: ${Math.round(currentWatchdogTimeout / 1000)}s`,
									`Auto retries: ${currentRetry}/${effectiveMaxRetries}`,
									`Last valid event: ${streamAudit.data.lastEventType}`,
									`Request ID: ${streamAudit.data.requestId}`,
							  ].join("\n")
							: ""

						const errorPrefix =
							classification.category === "network_error"
								? t("common:interruption.responseInterruptedByApiError")
								: t("common:interruption.streamTerminatedByProvider")

						const streamingFailedMessage = this.abort
							? undefined
							: streamingFailedDetails
							? `${errorPrefix}: ${rawErrorMessage}\n\n${streamingFailedDetails}`
							: `${errorPrefix}: ${rawErrorMessage}`

						// Clean up partial state
						if (!this.didFinishAbortingStream) {
							await abortStream(cancelReason, streamingFailedMessage)
						}

						if (this.abort) {
							// User cancelled - abort the entire task
							this.abortReason = cancelReason
							await this.abortTask()
							break
						} else {
							// Stream failed - log the error and retry with the same content
							// The existing rate limiting will prevent rapid retries
							console.error(
								`[Task#${this.taskId}.${this.instanceId}] Stream failed: ${streamingFailedMessage}`,
							)

							const maxAllowedRetries = Math.min(MAX_API_RETRIES, classification.maxRetries)

							if (!classification.retryable || currentRetry >= maxAllowedRetries || isStreamIdle) {
								console.error(
									`[Task#${this.taskId}.${this.instanceId}] Max mid-stream retries (${maxAllowedRetries}) or deterministic failure (${classification.category}): ${streamingFailedMessage}`,
								)
								let reasonText: string
								if (isStreamIdle) {
									reasonText = `${providerDisplayName} connection temporarily unavailable\n\nThe provider did not send stream data for ${Math.round(
										currentWatchdogTimeout / 1000,
									)} seconds.\nAutomatic recovery was attempted ${currentRetry} time(s).\n\nTask progress has been preserved.\nYou can click "Retry" to continue this task, or change the model in settings/header and retry.\n\nModel:\n${formattedModelName}`
								} else if (!classification.retryable) {
									reasonText = `Deterministic stream failure (${classification.category}): ${streamingFailedMessage}`
								} else {
									reasonText = `Max stream retries (${maxAllowedRetries}) exceeded: ${streamingFailedMessage}`
								}
								this.clearStreamWatchdog()
								this.cancelCurrentRequest()
								try {
									await stream.return(undefined)
									await streamIterator?.return?.(undefined)
								} catch (e) {
									// ignore
								}
								this.currentRequestAbortController = undefined
								const { response } = await this.ask("api_req_failed", reasonText)
								if (response !== "yesButtonClicked") {
									this.abortReason = "streaming_failed"
									await this.abortTask()
									break
								}
								await this.say("api_req_retried")
								this.resetStreamingState()
								this.clearStreamWatchdog()
								this.cancelCurrentRequest()
								try {
									await stream.return(undefined)
									await streamIterator?.return?.(undefined)
								} catch (e) {
									// ignore
								}
								this.currentRequestAbortController = undefined
								stack.push({
									userContent: currentUserContent,
									includeFileDetails: false,
									retryAttempt: 0,
								})
								continue
							}

							// Apply exponential backoff similar to first-chunk errors
							await this.backoffAndAnnounce(currentRetry, error, classification.retryAfterSeconds)

							// Check if task was aborted during the backoff
							if (this.abort) {
								console.log(
									`[Task#${this.taskId}.${this.instanceId}] Task aborted during mid-stream retry backoff`,
								)
								// Abort the entire task
								this.abortReason = "user_cancelled"
								await this.abortTask()
								break
							}

							// Push the same content back onto the stack to retry, incrementing the retry attempt counter
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: currentRetry + 1,
							})

							// Continue to retry the request
							continue
						}
					}
				} finally {
					this.isStreaming = false
					// Clean up the abort controller when streaming completes
					this.currentRequestAbortController = undefined
				}

				// Need to call here in case the stream was aborted.
				if (this.abort || this.abandoned) {
					throw new Error(
						`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`,
					)
				}

				this.didCompleteReadingStream = true
				console.log(
					`[StreamAudit] Task ${this.taskId}.${this.instanceId} stream ended successfully. Blocks: ${this.assistantMessageContent.length}, inputTokens: ${inputTokens}, outputTokens: ${outputTokens}, totalCost: ${totalCost}`,
				)

				// Set any blocks to be complete to allow `presentAssistantMessage`
				// to finish and set `userMessageContentReady` to true.
				// (Could be a text block that had no subsequent tool uses, or a
				// text block at the very end, or an invalid tool use, etc. Whatever
				// the case, `presentAssistantMessage` relies on these blocks either
				// to be completed or the user to reject a block in order to proceed
				// and eventually set userMessageContentReady to true.)

				// Finalize any remaining streaming tool calls that weren't explicitly ended
				// This is critical for MCP tools which need tool_call_end events to be properly
				// converted from ToolUse to McpToolUse via finalizeStreamingToolCall()
				const finalizeEvents = NativeToolCallParser.finalizeRawChunks()
				for (const event of finalizeEvents) {
					if (event.type === "tool_call_end") {
						// Finalize the streaming tool call
						const finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id)

						// Get the index for this tool call
						const toolUseIndex = this.streamingToolCallIndices.get(event.id)

						if (finalToolUse) {
							// Store the tool call ID
							;(finalToolUse as any).id = event.id

							// Get the index and replace partial with final
							if (toolUseIndex !== undefined) {
								this.assistantMessageContent[toolUseIndex] = finalToolUse
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the finalized tool call
							presentAssistantMessage(this)
						} else if (toolUseIndex !== undefined) {
							// finalizeStreamingToolCall returned null (malformed JSON or missing args)
							// We still need to mark the tool as non-partial so it gets executed
							// The tool's validation will catch any missing required parameters
							const existingToolUse = this.assistantMessageContent[toolUseIndex]
							if (existingToolUse && existingToolUse.type === "tool_use") {
								existingToolUse.partial = false
								// Ensure it has the ID for native protocol
								;(existingToolUse as any).id = event.id
							}

							// Clean up tracking
							this.streamingToolCallIndices.delete(event.id)

							// Mark that we have new content to process
							this.userMessageContentReady = false

							// Present the tool call - validation will handle missing params
							presentAssistantMessage(this)
						}
					}
				}

				// IMPORTANT: Capture partialBlocks AFTER finalizeRawChunks() to avoid double-presentation.
				// Tools finalized above are already presented, so we only want blocks still partial after finalization.
				const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
				partialBlocks.forEach((block) => (block.partial = false))

				// Can't just do this b/c a tool could be in the middle of executing.
				// this.assistantMessageContent.forEach((e) => (e.partial = false))

				// No legacy streaming parser to finalize.

				// Note: updateApiReqMsg() is now called from within drainStreamInBackgroundToFindAllUsage
				// to ensure usage data is captured even when the stream is interrupted. The background task
				// uses local variables to accumulate usage data before atomically updating the shared state.

				// Complete the reasoning message if it exists
				// We can't use say() here because the reasoning message may not be the last message
				// (other messages like text blocks or tool uses may have been added after it during streaming)
				if (reasoningMessage) {
					const lastReasoningIndex = findLastIndex(
						this.clineMessages,
						(m) => m.type === "say" && m.say === "reasoning",
					)

					if (lastReasoningIndex !== -1 && this.clineMessages[lastReasoningIndex].partial) {
						this.clineMessages[lastReasoningIndex].partial = false
						await this.updateClineMessage(this.clineMessages[lastReasoningIndex])
					}
				}

				await this.saveClineMessages()
				await this.providerRef.deref()?.postStateToWebviewWithoutTaskHistory()

				// No legacy text-stream tool parser state to reset.

				// CRITICAL: Save assistant message to API history BEFORE executing tools.
				// This ensures that when new_task triggers delegation and calls flushPendingToolResultsToHistory(),
				// the assistant message is already in history. Otherwise, tool_result blocks would appear
				// BEFORE their corresponding tool_use blocks, causing API errors.

				// Check if we have any content to process (text or tool uses)
				const hasTextContent = assistantMessage.length > 0

				const hasToolUses = this.assistantMessageContent.some(
					(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
				)

				if (hasTextContent || hasToolUses) {
					// Reset counter when we get a successful response with content
					this.consecutiveNoAssistantMessagesCount = 0
					// Display grounding sources to the user if they exist
					if (pendingGroundingSources.length > 0) {
						const citationLinks = pendingGroundingSources.map((source, i) => `[${i + 1}](${source.url})`)
						const sourcesText = `${t("common:gemini.sources")} ${citationLinks.join(", ")}`

						await this.say("text", sourcesText, undefined, false, undefined, undefined, {
							isNonInteractive: true,
						})
					}

					// Build the assistant message content array
					const assistantContent: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = []

					// Add text content if present
					if (assistantMessage) {
						assistantContent.push({
							type: "text" as const,
							text: assistantMessage,
						})
					}

					// Add tool_use blocks with their IDs for native protocol
					// This handles both regular ToolUse and McpToolUse types
					// IMPORTANT: Track seen IDs to prevent duplicates in the API request.
					// Duplicate tool_use IDs cause Anthropic API 400 errors:
					// "tool_use ids must be unique"
					const seenToolUseIds = new Set<string>()
					const toolUseBlocks = this.assistantMessageContent.filter(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)
					for (const block of toolUseBlocks) {
						if (block.type === "mcp_tool_use") {
							// McpToolUse already has the original tool name (e.g., "mcp_serverName_toolName")
							// The arguments are the raw tool arguments (matching the simplified schema)
							const mcpBlock = block as import("../../shared/tools").McpToolUse
							if (mcpBlock.id) {
								const sanitizedId = sanitizeToolUseId(mcpBlock.id)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate MCP tool_use ID: ${sanitizedId} (tool: ${mcpBlock.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: mcpBlock.name,
									input: mcpBlock.arguments,
								})
							}
						} else {
							// Regular ToolUse
							const toolUse = block as import("../../shared/tools").ToolUse
							const toolCallId = toolUse.id
							if (toolCallId) {
								const sanitizedId = sanitizeToolUseId(toolCallId)
								// Pre-flight deduplication: Skip if we've already added this ID
								if (seenToolUseIds.has(sanitizedId)) {
									console.warn(
										`[Task#${this.taskId}] Pre-flight deduplication: Skipping duplicate tool_use ID: ${sanitizedId} (tool: ${toolUse.name})`,
									)
									continue
								}
								seenToolUseIds.add(sanitizedId)
								const input = toolUse.nativeArgs || toolUse.params

								// Use originalName (alias) if present for API history consistency.
								// When tool aliases are used (e.g., "edit_file" -> "search_and_replace" -> "edit" (current canonical name)),
								// we want the alias name in the conversation history to match what the model
								// was told the tool was named, preventing confusion in multi-turn conversations.
								const toolNameForHistory = toolUse.originalName ?? toolUse.name

								assistantContent.push({
									type: "tool_use" as const,
									id: sanitizedId,
									name: toolNameForHistory,
									input,
								})
							}
						}
					}

					// Enforce new_task isolation: if new_task is called alongside other tools,
					// truncate any tools that come after it and inject error tool_results.
					// This prevents orphaned tools when delegation disposes the parent task.
					const newTaskIndex = assistantContent.findIndex(
						(block) => block.type === "tool_use" && block.name === "new_task",
					)

					if (newTaskIndex !== -1 && newTaskIndex < assistantContent.length - 1) {
						const truncatedTools = assistantContent.slice(newTaskIndex + 1)
						assistantContent.length = newTaskIndex + 1

						const executionNewTaskIndex = this.assistantMessageContent.findIndex(
							(block) => block.type === "tool_use" && block.name === "new_task",
						)
						if (executionNewTaskIndex !== -1) {
							this.assistantMessageContent.length = executionNewTaskIndex + 1
						}

						for (const tool of truncatedTools) {
							if (tool.type === "tool_use" && (tool as Anthropic.ToolUseBlockParam).id) {
								this.pushToolResultToUserContent({
									type: "tool_result",
									tool_use_id: (tool as Anthropic.ToolUseBlockParam).id,
									content:
										"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
									is_error: true,
								})
							}
						}
					}

					// Save assistant message BEFORE executing tools.
					await this.addToApiConversationHistory(
						{ role: "assistant", content: assistantContent },
						reasoningMessage || undefined,
					)
					this.assistantMessageSavedToHistory = true
				}

				// Present any partial blocks that were just completed.
				// Tool calls are typically presented during streaming via tool_call_partial events,
				// but we still present here if any partial blocks remain (e.g., malformed streams).
				// NOTE: This MUST happen AFTER saving the assistant message to API history.
				// When new_task is in the batch, it triggers delegation which calls flushPendingToolResultsToHistory().
				// If the assistant message isn't saved yet, tool_results would appear before tool_use blocks.
				if (partialBlocks.length > 0) {
					// If there is content to update then it will complete and
					// update `this.userMessageContentReady` to true, which we
					// `pWaitFor` before making the next request.
					presentAssistantMessage(this)
				}

				if (hasTextContent || hasToolUses) {
					// NOTE: This comment is here for future reference - this was a
					// workaround for `userMessageContent` not getting set to true.
					// It was due to it not recursively calling for partial blocks
					// when `didRejectTool`, so it would get stuck waiting for a
					// partial block to complete before it could continue.
					// In case the content blocks finished it may be the api stream
					// finished after the last parsed content block was executed, so
					// we are able to detect out of bounds and set
					// `userMessageContentReady` to true (note you should not call
					// `presentAssistantMessage` since if the last block i
					//  completed it will be presented again).
					// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
					// if (this.currentStreamingContentIndex >= completeBlocks.length) {
					// 	this.userMessageContentReady = true
					// }

					await pWaitFor(() => this.userMessageContentReady)

					// If the task was marked completed, flush pending tool results and terminate
					if (this.isTaskCompleted) {
						await this.flushPendingToolResultsToHistory()
						this.userMessageContent = []
						return true
					}

					// If the model did not tool use, then we need to tell it to
					// either use a tool or attempt_completion.
					const didToolUse = this.assistantMessageContent.some(
						(block) => block.type === "tool_use" || block.type === "mcp_tool_use",
					)

					if (!didToolUse) {
						// Increment consecutive no-tool-use counter
						this.consecutiveNoToolUseCount++

						// Only show error and count toward mistake limit after 2 consecutive failures
						if (this.consecutiveNoToolUseCount >= 2) {
							await this.say("error", "MODEL_NO_TOOLS_USED")
							// Only count toward mistake limit after second consecutive failure
							this.consecutiveMistakeCount++
						}

						// Use the task's locked protocol for consistent behavior
						this.userMessageContent.push({
							type: "text",
							text: formatResponse.noToolsUsed(),
						})
					} else {
						// Reset counter when tools are used successfully
						this.consecutiveNoToolUseCount = 0
					}

					// Push to stack if there's content OR if we're paused waiting for a subtask.
					// When paused, we push an empty item so the loop continues to the pause check.
					if (this.userMessageContent.length > 0 || this.isPaused) {
						stack.push({
							userContent: [...this.userMessageContent], // Create a copy to avoid mutation issues
							includeFileDetails: false, // Subsequent iterations don't need file details
						})

						// Add periodic yielding to prevent blocking
						await new Promise((resolve) => setImmediate(resolve))
					}

					continue
				} else {
					// If there's no assistant_responses, that means we got no text
					// or tool_use content blocks from API which we should assume is
					// an error.

					// Increment consecutive no-assistant-messages counter
					this.consecutiveNoAssistantMessagesCount++

					// Only show error and count toward mistake limit after 2 consecutive failures
					// This provides a "grace retry" - first failure retries silently
					if (this.consecutiveNoAssistantMessagesCount >= 2) {
						await this.say("error", "MODEL_NO_ASSISTANT_MESSAGES")
					}

					// IMPORTANT: We already added the user message to
					// apiConversationHistory at line 1876. Since the assistant failed to respond,
					// we need to remove that message before retrying to avoid having two consecutive
					// user messages (which would cause tool_result validation errors).
					let state = await this.providerRef.deref()?.getState()
					if (this.apiConversationHistory.length > 0) {
						const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
						if (lastMessage.role === "user") {
							// Remove the last user message that we added earlier
							this.apiConversationHistory.pop()
						}
					}

					// Check if we should auto-retry or prompt the user
					// Reuse the state variable from above
					if (state?.autoApprovalEnabled) {
						// Auto-retry with backoff - don't persist failure message when retrying
						await this.backoffAndAnnounce(
							currentItem.retryAttempt ?? 0,
							new Error(
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							),
						)

						// Check if task was aborted during the backoff
						if (this.abort) {
							console.log(
								`[Task#${this.taskId}.${this.instanceId}] Task aborted during empty-assistant retry backoff`,
							)
							break
						}

						// Push the same content back onto the stack to retry, incrementing the retry attempt counter
						// Mark that user message was removed so it gets re-added on retry
						stack.push({
							userContent: currentUserContent,
							includeFileDetails: false,
							retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							userMessageWasRemoved: true,
						})

						// Continue to retry the request
						continue
					} else {
						// Prompt the user for retry decision
						const { response } = await this.ask(
							"api_req_failed",
							"The model returned no assistant messages. This may indicate an issue with the API or the model's output.",
						)

						if (response === "yesButtonClicked") {
							await this.say("api_req_retried")

							// Push the same content back to retry
							stack.push({
								userContent: currentUserContent,
								includeFileDetails: false,
								retryAttempt: (currentItem.retryAttempt ?? 0) + 1,
							})

							// Continue to retry the request
							continue
						} else {
							// User declined to retry
							// Re-add the user message we removed.
							await this.addToApiConversationHistory({
								role: "user",
								content: currentUserContent,
							})

							await this.say(
								"error",
								"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
							)

							await this.addToApiConversationHistory({
								role: "assistant",
								content: [{ type: "text", text: "Failure: I did not provide a response." }],
							})
						}
					}
				}

				// If we reach here without continuing, return false (will always be false for now)
				return false
			} catch (error) {
				// This should never happen since the only thing that can throw an
				// error is the attemptApiRequest, which is wrapped in a try catch
				// that sends an ask where if noButtonClicked, will clear current
				// task and destroy this instance. However to avoid unhandled
				// promise rejection, we will end this loop which will end execution
				// of this instance (see `startTask`).
				return true // Needs to be true so parent loop knows to end task.
			}
		}

		// If we exit the while loop normally (stack is empty), return false
		return false
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			mode: globalMode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			language,
			apiConfiguration,
			enableSubfolderRules,
		} = state ?? {}

		const mode = this.taskMode || globalMode || defaultModeSlug

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			const modelInfo = this.api.getModel().info

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				false,
				mcpHub,
				this.diffStrategy,
				mode,
				customModePrompts,
				customModes,
				customInstructions,
				experiments,
				language,
				rooIgnoreInstructions,
				{
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules:
						vscode.workspace.getConfiguration(Package.name).get<boolean>("useAgentRules") ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					newTaskRequireTodos: vscode.workspace
						.getConfiguration(Package.name)
						.get<boolean>("newTaskRequireTodos", false),
					isStealthModel: modelInfo?.isStealthModel,
				},
				undefined, // todoList
				this.api.getModel().id,
				provider.getSkillsManager(),
			)
		})()
	}

	private getCurrentProfileId(state: any): string {
		const targetProfileName = this.taskApiConfigName || state?.currentApiConfigName || "default"
		return (
			state?.listApiConfigMeta?.find((profile: any) => profile.name === targetProfileName)?.id ??
			"default"
		)
	}

	private async handleContextWindowExceededError(): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const { profileThresholds = {}, mode } = state ?? {}

		const { contextTokens } = this.getTokenUsage()
		const modelInfo = this.api.getModel().info

		const maxTokens = getModelMaxOutputTokens({
			modelId: this.api.getModel().id,
			model: modelInfo,
			settings: this.apiConfiguration,
		})

		const contextWindow = modelInfo.contextWindow

		// Get the current profile ID using the helper method
		const currentProfileId = this.getCurrentProfileId(state)

		// Log the context window error for debugging
		console.warn(
			`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
				`Current tokens: ${contextTokens}, Context window: ${contextWindow}. ` +
				`Forcing truncation to ${FORCED_CONTEXT_REDUCTION_PERCENT}% of current context.`,
		)
		// Send condenseTaskContextStarted to show in-progress indicator
		await this.providerRef.deref()?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })

		// Build tools for condensing metadata (same tools used for normal API calls)
		const provider = this.providerRef.deref()
		let allTools: import("openai").default.Chat.ChatCompletionTool[] = []
		if (provider) {
			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration: this.apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: false,
			})
			allTools = toolsResult.tools
		}

		// Build metadata with tools and taskId for the condensing API call
		const metadata: ApiHandlerCreateMessageMetadata = {
			mode,
			taskId: this.taskId,
			...(allTools.length > 0
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
					}
				: {}),
		}

		try {
			// Generate environment details to include in the condensed summary
			const environmentDetails = await getEnvironmentDetails(this, true)

			// Force aggressive truncation by keeping only 75% of the conversation history
			const truncateResult = await manageContext({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens || 0,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext: true,
				autoCondenseContextPercent: FORCED_CONTEXT_REDUCTION_PERCENT,
				systemPrompt: await this.getSystemPrompt(),
				taskId: this.taskId,
				profileThresholds,
				currentProfileId,
				metadata,
				environmentDetails,
			})

			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}

			if (truncateResult.summary) {
				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			} else if (truncateResult.truncationId) {
				// Sliding window truncation occurred (fallback when condensing fails or is disabled)
				const contextTruncation: ContextTruncation = {
					truncationId: truncateResult.truncationId,
					messagesRemoved: truncateResult.messagesRemoved ?? 0,
					prevContextTokens: truncateResult.prevContextTokens,
					newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
				}
				await this.say(
					"sliding_window_truncation",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					undefined /* contextCondense */,
					contextTruncation,
				)
			}
		} finally {
			// Notify webview that context management is complete (removes in-progress spinner)
			// IMPORTANT: Must always be sent to dismiss the spinner, even on error
			await this.providerRef
				.deref()
				?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
		}
	}

	/**
	 * Enforce the user-configured provider rate limit.
	 *
	 * NOTE: This is intentionally treated as expected behavior and is surfaced via
	 * the `api_req_rate_limit_wait` say type (not an error).
	 */
	private async maybeWaitForProviderRateLimit(retryAttempt: number): Promise<void> {
		const state = await this.providerRef.deref()?.getState()
		const rateLimitSeconds =
			state?.apiConfiguration?.rateLimitSeconds ?? this.apiConfiguration?.rateLimitSeconds ?? 0

		const coordinator = ProviderRequestCoordinator.getInstance()
		const providerKey = coordinator.deriveProviderKey(
			this.apiConfiguration?.apiProvider,
			this.apiConfiguration?.apiKey,
			this.taskApiConfigName || state?.currentApiConfigName,
		)
		const lastRequestTime = coordinator.getLastRequestTime(providerKey) ?? Task.lastGlobalApiRequestTime

		if (rateLimitSeconds <= 0 || !lastRequestTime) {
			return
		}

		const now = performance.now()
		const timeSinceLastRequest = now - lastRequestTime
		const rateLimitDelay = Math.ceil(
			Math.min(rateLimitSeconds, Math.max(0, rateLimitSeconds * 1000 - timeSinceLastRequest) / 1000),
		)

		// Only show the countdown UX on the first attempt. Retry flows have their own delay messaging.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			for (let i = rateLimitDelay; i > 0; i--) {
				// Send structured JSON data for i18n-safe transport
				const delayMessage = JSON.stringify({ seconds: i })
				await this.say("api_req_rate_limit_wait", delayMessage, undefined, true)
				await delay(1000)
			}
			// Finalize the partial message so the UI doesn't keep rendering an in-progress spinner.
			await this.say("api_req_rate_limit_wait", undefined, undefined, false)
		}
	}

	public async *attemptApiRequest(
		retryAttempt: number = 0,
		options: { skipProviderRateLimit?: boolean } = {},
	): ApiStream {
		if (this.abort || this.isTaskCompleted) {
			return
		}

		const state = await this.providerRef.deref()?.getState()

		const {
			autoApprovalEnabled,
			requestDelaySeconds,
			mode: globalMode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}

		const mode = this.taskMode || globalMode || defaultModeSlug

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customSupportPrompts?.CONDENSE

		if (!options.skipProviderRateLimit) {
			await this.maybeWaitForProviderRateLimit(retryAttempt)
		}

		// Update last request time right before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		//
		// NOTE: When recursivelyMakeClineRequests handles rate limiting, it sets the
		// timestamp earlier to include the environment details build. We still set it
		// here for direct callers (tests) and for the case where we didn't rate-limit
		// in the caller.
		const coordinator = ProviderRequestCoordinator.getInstance()
		const providerKey = coordinator.deriveProviderKey(
			this.apiConfiguration?.apiProvider,
			this.apiConfiguration?.apiKey,
			state?.currentApiConfigName,
		)
		coordinator.setLastRequestTime(performance.now(), providerKey)
		Task.lastGlobalApiRequestTime = performance.now()
		this.requestsSinceLastCompaction++

		const systemPrompt = await this.getSystemPrompt()
		const { contextTokens } = this.getTokenUsage()

		if (retryAttempt > 0) {
			const estimatedRetryTokens =
				contextTokens ||
				Math.ceil(
					this.apiConversationHistory.reduce(
						(acc, m) => acc + (typeof m.content === "string" ? m.content.length : 100),
						0,
					) / 4,
				)
			this.retryRetransmissionTokens += estimatedRetryTokens
		}

		let autoCompacted = false
		if (this.checkContextCompactionThreshold()) {
			await this.compactContext(true)
			autoCompacted = true
		}

		if (!autoCompacted && contextTokens && this.apiConversationHistory.length > 0) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			// Get the current profile ID using the helper method
			const currentProfileId = this.getCurrentProfileId(state)
			// Check if context management will likely run (threshold check)
			// This allows us to show an in-progress indicator to the user
			// We use the centralized willManageContext helper to avoid duplicating threshold logic
			const lastMessage = this.apiConversationHistory[this.apiConversationHistory.length - 1]
			const lastMessageContent = lastMessage?.content
			let lastMessageTokens = 0
			if (lastMessageContent) {
				lastMessageTokens = Array.isArray(lastMessageContent)
					? await this.api.countTokens(lastMessageContent)
					: await this.api.countTokens([{ type: "text", text: lastMessageContent as string }])
			}

			const contextManagementWillRun = willManageContext({
				totalTokens: contextTokens,
				contextWindow,
				maxTokens,
				autoCondenseContext,
				autoCondenseContextPercent,
				profileThresholds,
				currentProfileId,
				lastMessageTokens,
			})

			// Send condenseTaskContextStarted BEFORE manageContext to show in-progress indicator
			// This notification must be sent here (not earlier) because the early check uses stale token count
			// (before user message is added to history), which could incorrectly skip showing the indicator
			if (contextManagementWillRun && autoCondenseContext) {
				await this.providerRef
					.deref()
					?.postMessageToWebview({ type: "condenseTaskContextStarted", text: this.taskId })
			}

			// Build tools for condensing metadata (same tools used for normal API calls)
			// This ensures the condensing API call includes tool definitions for providers that need them
			let contextMgmtTools: import("openai").default.Chat.ChatCompletionTool[] = []
			{
				const provider = this.providerRef.deref()
				if (provider) {
					const toolsResult = await buildNativeToolsArrayWithRestrictions({
						provider,
						cwd: this.cwd,
						mode,
						customModes: state?.customModes,
						experiments: state?.experiments,
						apiConfiguration: this.apiConfiguration,
						disabledTools: state?.disabledTools,
						modelInfo,
						includeAllToolsWithRestrictions: false,
					})
					contextMgmtTools = toolsResult.tools
				}
			}

			// Build metadata with tools and taskId for the condensing API call
			const contextMgmtMetadata: ApiHandlerCreateMessageMetadata = {
				mode,
				taskId: this.taskId,
				...(contextMgmtTools.length > 0
					? {
							tools: contextMgmtTools,
							tool_choice: "auto",
							parallelToolCalls: true,
						}
					: {}),
			}

			// Only generate environment details when context management will actually run.
			// getEnvironmentDetails(this, true) triggers a recursive workspace listing which
			// adds overhead - avoid this for the common case where context is below threshold.
			const contextMgmtEnvironmentDetails = contextManagementWillRun
				? await getEnvironmentDetails(this, true)
				: undefined

			// Get files read by Roo for code folding - only when context management will run
			const contextMgmtFilesReadByRoo =
				contextManagementWillRun && autoCondenseContext
					? await this.getFilesReadByRooSafely("attemptApiRequest")
					: undefined

			try {
				const truncateResult = await manageContext({
					messages: this.apiConversationHistory,
					totalTokens: contextTokens,
					maxTokens,
					contextWindow,
					apiHandler: this.api,
					autoCondenseContext,
					autoCondenseContextPercent,
					systemPrompt,
					taskId: this.taskId,
					customCondensingPrompt,
					profileThresholds,
					currentProfileId,
					metadata: contextMgmtMetadata,
					environmentDetails: contextMgmtEnvironmentDetails,
					filesReadByRoo: contextMgmtFilesReadByRoo,
					cwd: this.cwd,
					rooIgnoreController: this.rooIgnoreController,
				})
				if (truncateResult.messages !== this.apiConversationHistory) {
					await this.overwriteApiConversationHistory(truncateResult.messages)
				}
				if (truncateResult.error) {
					await this.say("condense_context_error", truncateResult.error)
				}
				if (truncateResult.summary) {
					const { summary, cost, prevContextTokens, newContextTokens = 0, condenseId } = truncateResult
					const contextCondense: ContextCondense = {
						summary,
						cost,
						newContextTokens,
						prevContextTokens,
						condenseId,
					}
					await this.say(
						"condense_context",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						contextCondense,
					)
				} else if (truncateResult.truncationId) {
					// Sliding window truncation occurred (fallback when condensing fails or is disabled)
					const contextTruncation: ContextTruncation = {
						truncationId: truncateResult.truncationId,
						messagesRemoved: truncateResult.messagesRemoved ?? 0,
						prevContextTokens: truncateResult.prevContextTokens,
						newContextTokens: truncateResult.newContextTokensAfterTruncation ?? 0,
					}
					await this.say(
						"sliding_window_truncation",
						undefined /* text */,
						undefined /* images */,
						false /* partial */,
						undefined /* checkpoint */,
						undefined /* progressStatus */,
						{ isNonInteractive: true } /* options */,
						undefined /* contextCondense */,
						contextTruncation,
					)
				}
			} finally {
				// Notify webview that context management is complete (sets isCondensing = false)
				// This removes the in-progress spinner and allows the completed result to show
				// IMPORTANT: Must always be sent to dismiss the spinner, even on error
				if (contextManagementWillRun && autoCondenseContext) {
					await this.providerRef
						.deref()
						?.postMessageToWebview({ type: "condenseTaskContextResponse", text: this.taskId })
				}
			}
		}

		// Get the effective API history by filtering out condensed messages
		// This allows non-destructive condensing where messages are tagged but not deleted,
		// enabling accurate rewind operations while still sending condensed history to the API.
		const effectiveHistory = getEffectiveApiHistory(this.apiConversationHistory)
		const messagesSinceLastSummary = getMessagesSinceLastSummary(effectiveHistory)
		// For API only: merge consecutive user messages (excludes summary messages per
		// mergeConsecutiveApiMessages implementation) without mutating stored history.
		const mergedForApi = mergeConsecutiveApiMessages(messagesSinceLastSummary, { roles: ["user"] })
		const messagesWithoutImages = maybeRemoveImageBlocks(mergedForApi, this.api)
		const optimizedForApi = optimizeEffectiveApiHistory(messagesWithoutImages as ApiMessage[])
		const cleanConversationHistory = this.buildCleanConversationHistory(optimizedForApi)

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Whether we include tools is determined by whether we have any tools to send.
		const modelInfo = this.api.getModel().info

		// Build complete tools array: native tools + dynamic MCP tools
		// When includeAllToolsWithRestrictions is true, returns all tools but provides
		// allowedFunctionNames for providers (like Gemini) that need to see all tool
		// definitions in history while restricting callable tools for the current mode.
		// Only Gemini currently supports this - other providers filter tools normally.
		let allTools: OpenAI.Chat.ChatCompletionTool[] = []
		let allowedFunctionNames: string[] | undefined

		// Gemini requires all tool definitions to be present for history compatibility,
		// but uses allowedFunctionNames to restrict which tools can be called.
		// Other providers (Anthropic, OpenAI, etc.) don't support this feature yet,
		// so they continue to receive only the filtered tools for the current mode.
		const supportsAllowedFunctionNames = this.apiConfiguration?.apiProvider === "gemini"

		{
			const provider = this.providerRef.deref()
			if (!provider) {
				throw new Error("Provider reference lost during tool building")
			}

			const toolsResult = await buildNativeToolsArrayWithRestrictions({
				provider,
				cwd: this.cwd,
				mode,
				customModes: state?.customModes,
				experiments: state?.experiments,
				apiConfiguration: this.apiConfiguration,
				disabledTools: state?.disabledTools,
				modelInfo,
				includeAllToolsWithRestrictions: supportsAllowedFunctionNames,
			})
			allTools = toolsResult.tools
			allowedFunctionNames = toolsResult.allowedFunctionNames
		}

		const shouldIncludeTools = allTools.length > 0

		// Create an AbortController to allow cancelling the request mid-stream
		this.currentRequestAbortController = new AbortController()
		const abortSignal = this.currentRequestAbortController.signal
		// Reset the flag after using it
		this.skipPrevResponseIdOnce = false

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			suppressPreviousResponseId: this.skipPrevResponseIdOnce,
			signal: abortSignal,
			// Include tools whenever they are present.
			...(shouldIncludeTools
				? {
						tools: allTools,
						tool_choice: "auto",
						parallelToolCalls: true,
						// When mode restricts tools, provide allowedFunctionNames so providers
						// like Gemini can see all tools in history but only call allowed ones
						...(allowedFunctionNames ? { allowedFunctionNames } : {}),
					}
				: {}),
		}

		// Prepare token audit telemetry if enabled
		const requestStartTime = performance.now()
		if (isTokenAuditEnabled()) {
			this.currentAuditRecord = prepareTokenAuditRecord({
				taskId: this.taskId,
				model: this.api.getModel().id,
				systemPrompt,
				nativeTools: allTools,
				messages: cleanConversationHistory,
				isRetry: (retryAttempt ?? 0) > 0,
				retryNumber: retryAttempt ?? 0,
				retryReason: (retryAttempt ?? 0) > 0 ? "retry" : undefined,
				compactionState: this.isCompacting ? "compacting" : "normal",
			})
			logTokenAudit(this.currentAuditRecord)
		}

		const currentFingerprint = this.calculateRequestFingerprint(
			this.api.getModel().id,
			systemPrompt,
			cleanConversationHistory,
			allTools,
		)

		const providerDeref = this.providerRef.deref()
		const isForeground =
			!providerDeref ||
			!("foregroundTaskId" in providerDeref) ||
			(providerDeref as any).foregroundTaskId === this.taskId
		const priority = isForeground ? RequestPriority.FOREGROUND : RequestPriority.BACKGROUND

		const ticket = await coordinator.acquireTicket({
			providerKey,
			taskId: this.taskId,
			priority,
			abortSignal,
		})

		if (this.isTaskCompleted) {
			console.warn(`[TerminalStateGuard] Suppressing createMessage on completed task ${this.taskId}`)
			ticket.release()
			return
		}

		try {
			console.log(
				`[RequestAudit] taskId=${this.taskId} provider=${this.apiConfiguration?.apiProvider} model=${getModelId(this.apiConfiguration)} effort=${(this.apiConfiguration as any)?.reasoningEffort} executionSnapshotModel=${this.taskStartModel}`,
			)
			// The provider accepts reasoning items alongside standard messages; cast to the expected parameter type.
			const stream = this.api.createMessage(
				systemPrompt,
				cleanConversationHistory as unknown as Anthropic.Messages.MessageParam[],
				metadata,
			)
			const iterator = stream[Symbol.asyncIterator]()

			// Set up abort handling - when the signal is aborted, clean up the controller reference
			abortSignal.addEventListener("abort", () => {
				console.log(`[Task#${this.taskId}.${this.instanceId}] AbortSignal triggered for current request`)
				this.currentRequestAbortController = undefined
			})

			try {
				// Awaiting first chunk to see if it will throw an error.
				this.isWaitingForFirstChunk = true

				// Race between the first chunk and the abort signal
				const firstChunkPromise = iterator.next()
				const abortPromise = new Promise<never>((_, reject) => {
					if (abortSignal.aborted) {
						reject(new Error("Request cancelled by user"))
					} else {
						abortSignal.addEventListener("abort", () => {
							reject(new Error("Request cancelled by user"))
						})
					}
				})

				const firstChunk = await Promise.race([firstChunkPromise, abortPromise])
				coordinator.reportSuccess(providerKey)
				if (isTokenAuditEnabled() && this.currentAuditRecord) {
					const timeToFirstChunkMs = performance.now() - requestStartTime
					recordRequestTiming(this.taskId, this.currentAuditRecord, {
						timeToFirstChunkMs,
					})
				}
				yield firstChunk.value
				this.isWaitingForFirstChunk = false
				this.consecutiveIdenticalFailures = 0
				this.lastFailedRequestFingerprint = undefined
			} catch (error: any) {
				ticket.release()
				this.isWaitingForFirstChunk = false
				this.currentRequestAbortController = undefined
				if (isTokenAuditEnabled() && this.currentAuditRecord) {
					const requestDurationMs = performance.now() - requestStartTime
					recordRequestTiming(this.taskId, this.currentAuditRecord, {
						requestDurationMs,
					})
				}

				const isUserCancelled =
					this.abort ||
					this.abortReason === "user_cancelled" ||
					error?.name === "AbortError" ||
					error?.message?.includes("Request cancelled by user") ||
					error?.message?.includes("cancelled by user")

				if (isUserCancelled) {
					this.abortReason = "user_cancelled"
					throw error
				}

				const isContextWindowExceededError = checkContextWindowExceededError(error)

				// If it's a context window error and we haven't exceeded max retries for this error type
				if (isContextWindowExceededError && retryAttempt < MAX_CONTEXT_WINDOW_RETRIES) {
					console.warn(
						`[Task#${this.taskId}] Context window exceeded for model ${this.api.getModel().id}. ` +
							`Retry attempt ${retryAttempt + 1}/${MAX_CONTEXT_WINDOW_RETRIES}. ` +
							`Attempting automatic truncation...`,
					)
					await this.handleContextWindowExceededError()
					// Retry the request after handling the context window error
					yield* this.attemptApiRequest(retryAttempt + 1)
					return
				}

				const classification = classifyApiError(error)
				const maxAllowedRetries = Math.min(MAX_API_RETRIES, classification.maxRetries)

				if (this.lastFailedRequestFingerprint === currentFingerprint) {
					this.consecutiveIdenticalFailures++
				} else {
					this.lastFailedRequestFingerprint = currentFingerprint
					this.consecutiveIdenticalFailures = 1
				}

				const isCircuitBroken = this.consecutiveIdenticalFailures > maxAllowedRetries

				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
				if (autoApprovalEnabled) {
					if (!classification.retryable || isCircuitBroken || retryAttempt >= maxAllowedRetries) {
						const reasonText = !classification.retryable
							? `Deterministic API error (${classification.category}): ${error?.message || "Unknown error"}`
							: isCircuitBroken
								? `Circuit breaker: identical request failed consecutively (${error?.message || "Unknown error"}). Auto-retry stopped to prevent token waste.`
								: `Max retries (${maxAllowedRetries}) exceeded: ${error?.message ?? JSON.stringify(serializeError(error), null, 2)}`

						console.error(
							`[Task#attemptApiRequest] ${reasonText} for task ${this.taskId}.${this.instanceId}. Error: ${error?.message}`,
						)
						this.clearStreamWatchdog()
						const { response } = await this.ask("api_req_failed", reasonText)
						if (response !== "yesButtonClicked") {
							throw new Error(`API request failed: ${reasonText}`)
						}
						await this.say("api_req_retried")
						this.consecutiveIdenticalFailures = 0
						this.lastFailedRequestFingerprint = undefined
						yield* this.attemptApiRequest(0)
						return
					}

					// Apply shared exponential backoff and countdown UX
					await this.backoffAndAnnounce(retryAttempt, error, classification.retryAfterSeconds)

					// CRITICAL: Check if task was aborted during the backoff countdown
					// This prevents infinite loops when users cancel during auto-retry
					// Without this check, the recursive call below would continue even after abort
					if (this.abort) {
						throw new Error(
							`[Task#attemptApiRequest] task ${this.taskId}.${this.instanceId} aborted during retry`,
						)
					}

					// Delegate generator output from the recursive call with
					// incremented retry count.
					yield* this.attemptApiRequest(retryAttempt + 1)

					return
				} else {
					this.clearStreamWatchdog()
					const { response } = await this.ask(
						"api_req_failed",
						error?.message ?? JSON.stringify(serializeError(error), null, 2),
					)

					if (response !== "yesButtonClicked") {
						// This will never happen since if noButtonClicked, we will
						// clear current task, aborting this instance.
						throw new Error("API request failed")
					}

					await this.say("api_req_retried")
					this.consecutiveIdenticalFailures = 0
					this.lastFailedRequestFingerprint = undefined

					// Delegate generator output from the recursive call.
					yield* this.attemptApiRequest()
					return
				}
			}

			// No error, so we can continue to yield all remaining chunks.
			// (Needs to be placed outside of try/catch since it we want caller to
			// handle errors not with api_req_failed as that is reserved for first
			// chunk failures only.)
			// This delegates to another generator or iterable object. In this case,
			// it's saying "yield all remaining values from this iterator". This
			// effectively passes along all subsequent chunks from the original
			// stream.
			yield* iterator
		} finally {
			ticket.release()
		}
	}

	private calculateRequestFingerprint(
		modelId: string,
		systemPrompt: string,
		messages: unknown[],
		tools: unknown[],
	): string {
		const hash = crypto.createHash("sha256")
		hash.update(modelId || "")
		hash.update("::")
		hash.update(systemPrompt || "")
		hash.update("::")
		hash.update(JSON.stringify(messages || []))
		hash.update("::")
		hash.update(JSON.stringify(tools || []))
		return hash.digest("hex")
	}

	// Shared exponential backoff for retries (first-chunk and mid-stream)
	private async backoffAndAnnounce(retryAttempt: number, error: any, overrideDelaySeconds?: number): Promise<void> {
		this.clearStreamWatchdog()
		try {
			const state = await this.providerRef.deref()?.getState()
			const baseDelay = state?.requestDelaySeconds || 5

			let exponentialDelay = Math.min(
				Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
				MAX_EXPONENTIAL_BACKOFF_SECONDS,
			)

			// Respect provider rate limit window
			let rateLimitDelay = 0
			const rateLimit = (state?.apiConfiguration ?? this.apiConfiguration)?.rateLimitSeconds || 0
			const coordinator = ProviderRequestCoordinator.getInstance()
			const providerKey = coordinator.deriveProviderKey(
				this.apiConfiguration?.apiProvider,
				this.apiConfiguration?.apiKey,
				this.taskApiConfigName || state?.currentApiConfigName,
			)
			const lastRequestTime = coordinator.getLastRequestTime(providerKey) ?? Task.lastGlobalApiRequestTime
			if (lastRequestTime && rateLimit > 0) {
				const elapsed = performance.now() - lastRequestTime
				rateLimitDelay = Math.ceil(Math.min(rateLimit, Math.max(0, rateLimit * 1000 - elapsed) / 1000))
			}

			// Prefer explicit override, error.retryAfter, or RetryInfo on 429
			if (typeof overrideDelaySeconds === "number" && overrideDelaySeconds > 0) {
				exponentialDelay = overrideDelaySeconds + 1
			} else if (error?.retryAfter && typeof error.retryAfter === "number") {
				exponentialDelay = error.retryAfter + 1
			} else if (error?.status === 429) {
				const retryInfo = error?.errorDetails?.find(
					(d: any) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
				)
				const match = retryInfo?.retryDelay?.match?.(/^(\d+(?:\.\d+)?)s$/)
				if (match) {
					exponentialDelay = Math.ceil(Number(match[1])) + 1
				}
			}

			const finalDelay = Math.max(exponentialDelay, rateLimitDelay)
			if (finalDelay <= 0) {
				return
			}

			if (error?.status === 429 || overrideDelaySeconds || error?.retryAfter) {
				coordinator.reportRateLimit(providerKey, finalDelay)
			}

			// Build header text; fall back to error message if none provided
			let headerText
			if (error.status) {
				// Include both status code (for ChatRow parsing) and detailed message (for error details)
				// Format: "<status>\n<message>" allows ChatRow to extract status via parseInt(text.substring(0,3))
				// while preserving the full error message in errorDetails for debugging
				const errorMessage = error?.message || "Unknown error"
				headerText = `${error.status}\n${errorMessage}`
			} else if (error?.message) {
				headerText = error.message
			} else {
				headerText = "Unknown error"
			}

			headerText = headerText ? `${headerText}\n` : ""

			// Show countdown timer with exponential backoff
			for (let i = finalDelay; i > 0; i--) {
				// Check abort flag during countdown to allow early exit
				if (this.abort) {
					throw new Error(`[Task#${this.taskId}] Aborted during retry countdown`)
				}

				await this.say("api_req_retry_delayed", `${headerText}<retry_timer>${i}</retry_timer>`, undefined, true)
				await delay(1000)
			}

			await this.say("api_req_retry_delayed", headerText, undefined, false)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)

			if (this.abort && message.includes("Aborted during retry countdown")) {
				return
			}

			console.error("Exponential backoff failed:", err)
		}
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false, suppressMessage: boolean = false) {
		return checkpointSave(this, force, suppressMessage)
	}

	private buildCleanConversationHistory(
		messages: ApiMessage[],
	): Array<
		Anthropic.Messages.MessageParam | { type: "reasoning"; encrypted_content: string; id?: string; summary?: any[] }
	> {
		type ReasoningItemForRequest = {
			type: "reasoning"
			encrypted_content: string
			id?: string
			summary?: any[]
		}

		const cleanConversationHistory: (Anthropic.Messages.MessageParam | ReasoningItemForRequest)[] = []

		for (const msg of messages) {
			// Standalone reasoning: send encrypted, skip plain text
			if (msg.type === "reasoning") {
				if (msg.encrypted_content) {
					cleanConversationHistory.push({
						type: "reasoning",
						summary: msg.summary,
						encrypted_content: msg.encrypted_content!,
						...(msg.id ? { id: msg.id } : {}),
					})
				}
				continue
			}

			// Preferred path: assistant message with embedded reasoning as first content block
			if (msg.role === "assistant") {
				const rawContent = msg.content

				const contentArray: Anthropic.Messages.ContentBlockParam[] = Array.isArray(rawContent)
					? (rawContent as Anthropic.Messages.ContentBlockParam[])
					: rawContent !== undefined
						? ([
								{ type: "text", text: rawContent } satisfies Anthropic.Messages.TextBlockParam,
							] as Anthropic.Messages.ContentBlockParam[])
						: []

				const [first, ...rest] = contentArray

				// Check if this message has reasoning_details (OpenRouter format for Gemini 3, etc.)
				const msgWithDetails = msg
				if (msgWithDetails.reasoning_details && Array.isArray(msgWithDetails.reasoning_details)) {
					// Build the assistant message with reasoning_details
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (contentArray.length === 0) {
						assistantContent = ""
					} else if (contentArray.length === 1 && contentArray[0].type === "text") {
						assistantContent = (contentArray[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = contentArray
					}

					// Create message with reasoning_details property
					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
						reasoning_details: msgWithDetails.reasoning_details,
					} as any)

					continue
				}

				// Embedded reasoning: encrypted (send) or plain text (skip)
				const hasEncryptedReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).encrypted_content === "string"
				const hasPlainTextReasoning =
					first && (first as any).type === "reasoning" && typeof (first as any).text === "string"

				if (hasEncryptedReasoning) {
					const reasoningBlock = first as any

					// Send as separate reasoning item (OpenAI Native)
					cleanConversationHistory.push({
						type: "reasoning",
						summary: reasoningBlock.summary ?? [],
						encrypted_content: reasoningBlock.encrypted_content,
						...(reasoningBlock.id ? { id: reasoningBlock.id } : {}),
					})

					// Send assistant message without reasoning
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (rest.length === 0) {
						assistantContent = ""
					} else if (rest.length === 1 && rest[0].type === "text") {
						assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
					} else {
						assistantContent = rest
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				} else if (hasPlainTextReasoning) {
					// Check if the model's preserveReasoning flag is set
					// If true, include the reasoning block in API requests
					// If false/undefined, strip it out (stored for history only, not sent back to API)
					const shouldPreserveForApi = this.api.getModel().info.preserveReasoning === true
					let assistantContent: Anthropic.Messages.MessageParam["content"]

					if (shouldPreserveForApi) {
						// Include reasoning block in the content sent to API
						assistantContent = contentArray
					} else {
						// Strip reasoning out - stored for history only, not sent back to API
						if (rest.length === 0) {
							assistantContent = ""
						} else if (rest.length === 1 && rest[0].type === "text") {
							assistantContent = (rest[0] as Anthropic.Messages.TextBlockParam).text
						} else {
							assistantContent = rest
						}
					}

					cleanConversationHistory.push({
						role: "assistant",
						content: assistantContent,
					} satisfies Anthropic.Messages.MessageParam)

					continue
				}
			}

			// Default path for regular messages (no embedded reasoning)
			if (msg.role) {
				cleanConversationHistory.push({
					role: msg.role,
					content: msg.content as Anthropic.Messages.ContentBlockParam[] | string,
				})
			}
		}

		return cleanConversationHistory
	}
	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	// Getters
	public get isStarted(): boolean {
		return this._started
	}

	public get taskStatus(): TaskStatus {
		if (!this._started) {
			return TaskStatus.Idle
		}
		if (this.interactiveAsk) {
			return TaskStatus.Interactive
		}

		if (this.resumableAsk) {
			return TaskStatus.Resumable
		}

		if (this.idleAsk) {
			return TaskStatus.Idle
		}

		return TaskStatus.Running
	}

	public get taskAsk(): ClineMessage | undefined {
		return this.idleAsk || this.resumableAsk || this.interactiveAsk
	}

	public get currentAskType(): ClineAsk | undefined {
		if (this.askResponse !== undefined) {
			return undefined
		}
		const lastAsk = findLast(this.clineMessages, (m) => m.type === "ask")
		if (lastAsk && (this.lastMessageTs === lastAsk.ts || !this.isStreaming)) {
			return lastAsk.ask
		}
		return this.taskAsk?.ask
	}

	public get queuedMessages(): QueuedMessage[] {
		return this.messageQueueService.messages
	}

	public get tokenUsage(): TokenUsage | undefined {
		if (this.tokenUsageSnapshot && this.tokenUsageSnapshotAt) {
			return this.tokenUsageSnapshot
		}

		this.tokenUsageSnapshot = this.getTokenUsage()
		this.tokenUsageSnapshotAt = this.clineMessages.at(-1)?.ts

		return this.tokenUsageSnapshot
	}

	public get cwd() {
		return this.workspacePath
	}

	/**
	 * Provides convenient access to high-level message operations.
	 * Uses lazy initialization - the MessageManager is only created when first accessed.
	 * Subsequent accesses return the same cached instance.
	 *
	 * ## Important: Single Coordination Point
	 *
	 * **All MessageManager operations must go through this getter** rather than
	 * instantiating `new MessageManager(task)` directly. This ensures:
	 * - A single shared instance for consistent behavior
	 * - Centralized coordination of all rewind/message operations
	 * - Ability to add internal state or instrumentation in the future
	 *
	 * @example
	 * ```typescript
	 * // Correct: Use the getter
	 * await task.messageManager.rewindToTimestamp(ts)
	 *
	 * // Incorrect: Do NOT create new instances directly
	 * // const manager = new MessageManager(task) // Don't do this!
	 * ```
	 */
	get messageManager(): MessageManager {
		if (!this._messageManager) {
			this._messageManager = new MessageManager(this)
		}
		return this._messageManager
	}

	/**
	 * Process any queued messages by dequeuing and submitting them.
	 * This ensures that queued user messages are sent when appropriate,
	 * preventing them from getting stuck in the queue.
	 *
	 * @param context - Context string for logging (e.g., the calling tool name)
	 */
	public processQueuedMessages(): void {
		if (this.abort || this.abandoned || this.abortReason === "user_cancelled") {
			return
		}
		try {
			if (!this.messageQueueService.isEmpty()) {
				const queued = this.messageQueueService.dequeueMessage()
				if (queued) {
					setTimeout(() => {
						if (this.abort || this.abandoned || this.abortReason === "user_cancelled") {
							return
						}
						this.submitUserMessage(queued.text, queued.images).catch((err) =>
							console.error(`[Task] Failed to submit queued message:`, err),
						)
					}, 0)
				}
			}
		} catch (e) {
			console.error(`[Task] Queue processing error:`, e)
		}
	}
}
