import { describe, expect, it, vi } from "vitest"
import { ClineProvider } from "../ClineProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("Stop -> New Prompt Lifecycle & Race Handling", () => {
	function createMockProvider() {
		const provider = Object.create(ClineProvider.prototype) as ClineProvider
		provider.getState = vi.fn().mockResolvedValue({
			allowedCommands: [],
			deniedCommands: [],
			mode: "code",
		}) as any
		provider.contextProxy = {
			getValues: vi.fn(() => ({})),
			getValue: vi.fn(),
			setValue: vi.fn(),
		} as any
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined) as any
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined) as any
		;(provider as any).log = vi.fn()
		return provider
	}

	it("resumes stopped task immediately upon receiving a new prompt without queueing", async () => {
		const provider = createMockProvider()

		const initialMessages = [
			{ type: "say" as const, say: "text" as const, text: "Initial task prompt", ts: 1000 },
			{ type: "say" as const, say: "api_req_started" as const, text: JSON.stringify({ request: "cancelled", cancelReason: "user_cancelled" }), ts: 1001 },
		]

		const historyItem = {
			id: "task-stopped",
			ts: 1000,
			task: "Initial task prompt",
			status: "interrupted" as const,
			workspace: "c:/test",
			promptQueue: [],
		}

		let resumeWithResponseCalled = false
		let resumedResponse: any = null
		let resumedText: any = null

		const dormantShellTask: any = {
			taskId: "task-stopped",
			instanceId: "inst-2",
			_started: false,
			abort: false,
			abandoned: false,
			isStreaming: false,
			currentAskType: undefined,
			clineMessages: [...initialMessages],
			historyItem: { ...historyItem },
			messageQueueService: {
				isEmpty: () => true,
				messages: [],
				addMessage: vi.fn(),
			},
			resumeWithResponse: vi.fn(async function (response: string, text?: string) {
				resumeWithResponseCalled = true
				resumedResponse = response
				resumedText = text
				;(provider as any).runningTasks.set("task-stopped", dormantShellTask)
				dormantShellTask._started = true
			}),
		}

		;(provider as any).runningTasks = new Map()
		;(provider as any).clineStack = [dormantShellTask]
		provider.foregroundTaskId = "task-stopped"
		provider.getCurrentTask = vi.fn(() => dormantShellTask)
		;(provider as any).hasInFlightCancel = vi.fn(() => false)
		;(provider as any).waitForCancelTask = vi.fn().mockResolvedValue(undefined)
		provider.taskHistoryStore = {
			get: vi.fn(() => historyItem),
			updateTaskHistory: vi.fn(),
		} as any

		// Simulate webview sending askResponse ("messageResponse", "teraz zrób X")
		await webviewMessageHandler(provider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "teraz zrób X",
			taskId: "task-stopped",
		})

		expect(resumeWithResponseCalled).toBe(true)
		expect(resumedResponse).toBe("messageResponse")
		expect(resumedText).toBe("teraz zrób X")
		expect(provider.runningTasks.has("task-stopped")).toBe(true)
		expect(dormantShellTask.messageQueueService.addMessage).not.toHaveBeenCalled()
	})

	it("defensively routes queueMessage to direct send when task is stopped and queue is empty", async () => {
		const provider = createMockProvider()

		const historyItem = {
			id: "task-stopped-defensive",
			ts: 1000,
			task: "Initial prompt",
			status: "interrupted" as const,
			workspace: "c:/test",
			promptQueue: [],
		}

		let resumeWithResponseCalled = false
		let resumedText: any = null

		const dormantShellTask: any = {
			taskId: "task-stopped-defensive",
			instanceId: "inst-3",
			_started: false,
			abort: false,
			abandoned: false,
			isStreaming: false,
			currentAskType: undefined,
			clineMessages: [],
			historyItem: { ...historyItem },
			messageQueueService: {
				isEmpty: () => true,
				messages: [],
				addMessage: vi.fn(),
			},
			resumeWithResponse: vi.fn(async function (response: string, text?: string) {
				resumeWithResponseCalled = true
				resumedText = text
			}),
		}

		;(provider as any).runningTasks = new Map()
		;(provider as any).clineStack = [dormantShellTask]
		provider.foregroundTaskId = "task-stopped-defensive"
		provider.getCurrentTask = vi.fn(() => dormantShellTask)
		;(provider as any).hasInFlightCancel = vi.fn(() => false)
		;(provider as any).waitForCancelTask = vi.fn().mockResolvedValue(undefined)

		// If frontend mistakenly emitted queueMessage for a stopped task with empty queue:
		await webviewMessageHandler(provider, {
			type: "queueMessage",
			text: "nowa komenda po stopie",
			taskId: "task-stopped-defensive",
		})

		// Must be executed directly instead of rotting in queue
		expect(resumeWithResponseCalled).toBe(true)
		expect(resumedText).toBe("nowa komenda po stopie")
		expect(dormantShellTask.messageQueueService.addMessage).not.toHaveBeenCalled()
	})

	it("awaits in-flight cancel task promise during immediate race before sending new prompt", async () => {
		const provider = createMockProvider()

		let cancelResolved = false
		const cancelPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				cancelResolved = true
				resolve()
			}, 50)
		})

		const dormantShellTask: any = {
			taskId: "task-race",
			instanceId: "inst-race",
			_started: false,
			abort: false,
			abandoned: false,
			isStreaming: false,
			currentAskType: undefined,
			clineMessages: [],
			messageQueueService: {
				isEmpty: () => true,
				messages: [],
				addMessage: vi.fn(),
			},
			resumeWithResponse: vi.fn(async function () {
				expect(cancelResolved).toBe(true)
			}),
		}

		;(provider as any).runningTasks = new Map()
		;(provider as any).clineStack = [dormantShellTask]
		provider.foregroundTaskId = "task-race"
		provider.getCurrentTask = vi.fn(() => dormantShellTask)
		;(provider as any).hasInFlightCancel = vi.fn(() => true)
		;(provider as any).waitForCancelTask = vi.fn(async () => {
			await cancelPromise
		})

		// Send arrives during abort cleanup
		await webviewMessageHandler(provider, {
			type: "askResponse",
			askResponse: "messageResponse",
			text: "prompt wyslany w trakcie stopu",
			taskId: "task-race",
		})

		expect(provider.waitForCancelTask).toHaveBeenCalledWith("task-race")
		expect(dormantShellTask.resumeWithResponse).toHaveBeenCalled()
	})
})
