// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.spec.tsx

import React from "react"
import { render, waitFor, act, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import ChatView, { ChatViewProps } from "../ChatView"

// Define minimal types needed for testing
interface ClineMessage {
	type: "say" | "ask"
	say?: string
	ask?: string
	ts: number
	text?: string
	partial?: boolean
	approvalState?: string
	isAnswered?: boolean
}

interface ExtensionState {
	version: string
	clineMessages: ClineMessage[]
	taskHistory: any[]
	shouldShowAnnouncement: boolean
	allowedCommands: string[]
	alwaysAllowExecute: boolean
	[key: string]: any
}

// Mock vscode API
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

// Mock use-sound hook
const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => {
		return [mockPlayFunction]
	}),
}))

// Mock components that use ESM dependencies
vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: ClineMessage }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

// Mock react-virtuoso to render items directly without virtualization
// This allows tests to verify items rendered in the chat list
vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: ClineMessage[]
		itemContent: (index: number, item: ClineMessage) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={item.ts} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		)
	},
}))

// Mock VersionIndicator - returns null by default to prevent rendering in tests
vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

// Get the mock function after the module is mocked
const mockVersionIndicator = vi.mocked((await import("../../common/VersionIndicator")).default)

vi.mock("../Announcement", () => ({
	default: function MockAnnouncement({ hideAnnouncement }: { hideAnnouncement: () => void }) {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const React = require("react")
		return React.createElement(
			"div",
			{ "data-testid": "announcement-modal" },
			React.createElement("div", null, "What's New"),
			React.createElement("button", { onClick: hideAnnouncement }, "Close"),
		)
	},
}))

// Mock DismissibleUpsell component
vi.mock("@/components/common/DismissibleUpsell", () => ({
	default: function MockDismissibleUpsell({ children }: { children: React.ReactNode }) {
		return <div data-testid="dismissible-upsell">{children}</div>
	},
}))

// Mock QueuedMessages component
vi.mock("../QueuedMessages", () => ({
	QueuedMessages: function MockQueuedMessages({
		queue = [],
		onRemove,
	}: {
		queue?: Array<{ id: string; text: string; images?: string[] }>
		onRemove?: (index: number) => void
		onUpdate?: (index: number, newText: string) => void
	}) {
		if (!queue || queue.length === 0) {
			return null
		}
		return (
			<div data-testid="queued-messages">
				{queue.map((msg, index) => (
					<div key={msg.id}>
						<span>{msg.text}</span>
						<button aria-label="Remove message" onClick={() => onRemove?.(index)}>
							Remove
						</button>
					</div>
				))}
			</div>
		)
	},
}))

// Mock RooTips component
vi.mock("@src/components/welcome/RooTips", () => ({
	default: function MockRooTips() {
		return <div data-testid="roo-tips">Tips content</div>
	},
}))

// Mock RooHero component
vi.mock("@src/components/welcome/RooHero", () => ({
	default: function MockRooHero() {
		return <div data-testid="roo-hero">Hero content</div>
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: any) => {
			if (key === "chat:versionIndicator.ariaLabel" && options?.version) {
				return `Version ${options.version}`
			}
			return key
		},
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => {
		return <>{children || i18nKey}</>
	},
}))

interface ChatTextAreaProps {
	onSend: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	sendingDisabled?: boolean
	placeholderText?: string
	selectedImages?: string[]
	shouldDisableImages?: boolean
	onResume?: () => void
}

const mockInputRef = React.createRef<HTMLInputElement>()
const mockFocus = vi.fn()

vi.mock("../ChatTextArea", () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mockReact = require("react")

	const ChatTextAreaComponent = mockReact.forwardRef(function MockChatTextArea(
		props: ChatTextAreaProps,
		ref: React.ForwardedRef<{ focus: () => void }>,
	) {
		// Use useImperativeHandle to expose the mock focus method
		mockReact.useImperativeHandle(ref, () => ({
			focus: mockFocus,
		}))

		return (
			<div data-testid="chat-textarea">
				<input
					ref={mockInputRef}
					type="text"
					value={props.inputValue || ""}
					onChange={(e) => {
						// Use parent's setInputValue if available
						if (props.setInputValue) {
							props.setInputValue(e.target.value)
						}
					}}
					onKeyDown={(e) => {
						// Only call onSend when Enter is pressed (simulating real behavior)
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault()
							props.onSend()
						}
					}}
					data-sending-disabled={props.sendingDisabled}
				/>
				{props.onResume && <button onClick={props.onResume}>Continue</button>}
			</div>
		)
	})

	return {
		default: ChatTextAreaComponent,
		ChatTextArea: ChatTextAreaComponent, // Export as named export too
	}
})

// Mock VSCode components
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: function MockVSCodeButton({
		children,
		onClick,
		appearance,
	}: {
		children: React.ReactNode
		onClick?: () => void
		appearance?: string
	}) {
		return (
			<button onClick={onClick} data-appearance={appearance}>
				{children}
			</button>
		)
	},
	VSCodeTextField: function MockVSCodeTextField({
		value,
		onInput,
		placeholder,
	}: {
		value?: string
		onInput?: (e: { target: { value: string } }) => void
		placeholder?: string
	}) {
		return (
			<input
				type="text"
				value={value}
				onChange={(e) => onInput?.({ target: { value: e.target.value } })}
				placeholder={placeholder}
			/>
		)
	},
	VSCodeLink: function MockVSCodeLink({ children, href }: { children: React.ReactNode; href?: string }) {
		return <a href={href}>{children}</a>
	},
}))

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: Partial<ExtensionState>) => {
	window.postMessage(
		{
			type: "state",
			state: {
				version: "1.0.0",
				clineMessages: [],
				taskHistory: [],
				shouldShowAnnouncement: false,
				allowedCommands: [],
				alwaysAllowExecute: false,
				cloudIsAuthenticated: false,
				...state,
			},
		},
		"*",
	)
}

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

const renderChatView = (props: Partial<ChatViewProps> = {}) => {
	return render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)
}

describe("ChatView - Sound Playing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("plays celebration sound for completion results", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add completion result
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed successfully",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("plays progress_loop sound for api failures", async () => {
		renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Add API failure
		mockPostMessage({
			soundEnabled: true, // Enable sound
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "api_req_failed",
					ts: Date.now(),
					text: "API request failed",
					partial: false, // Ensure it's not partial
				},
			],
		})

		// Wait for sound to be played
		await waitFor(() => {
			expect(mockPlayFunction).toHaveBeenCalled()
		})
	})

	it("does not play sound when resuming a task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a task that has a resumeTaskId (indicating it's resumed from history)
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
				},
			],
		})

		// Should not play sound when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})

	it("does not play sound when resuming a completed task from history", () => {
		renderChatView()

		// Clear any initial calls
		mockPlayFunction.mockClear()

		// Hydrate state with a completed task that has a resumeTaskId
		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Resumed task",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
				},
			],
		})

		// Should not play sound for completion when resuming from history
		expect(mockPlayFunction).not.toHaveBeenCalled()
	})
})

describe("ChatView - Focus Grabbing Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not grab focus when follow-up question presented", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Wait for the component to fully render and settle before clearing mocks
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Wait for the debounced focus effect to fire (50ms debounce + buffer for CI variability)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100))
		})

		// Clear any initial calls after state has settled
		mockFocus.mockClear()

		// Add follow-up question
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "followup",
					ts: Date.now(),
					text: "Should I continue?",
				},
			],
		})

		// Wait for state update to complete
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Should not grab focus for follow-up questions
		expect(mockFocus).not.toHaveBeenCalled()
	})
})

describe("ChatView - Version Indicator Tests", () => {
	it("does not display version indicator in ChatView", () => {
		const { queryByTestId } = renderChatView()

		mockPostMessage({
			version: "1.0.0",
			clineMessages: [],
		})

		expect(queryByTestId("version-indicator")).not.toBeInTheDocument()
	})
})

describe("ChatView - Welcome Content Display Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not show removed cloud upsell for returning users", () => {
		const { queryByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
	})

	it("shows RooTips when user has only run 3 tasks in their history", () => {
		const { queryByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(queryByTestId("roo-tips")).toBeInTheDocument()
	})

	it("does not show removed cloud upsell when user has run 6 or more tasks", async () => {
		const { queryByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 6000 },
				{ id: "2", ts: Date.now() - 5000 },
				{ id: "3", ts: Date.now() - 4000 },
				{ id: "4", ts: Date.now() - 3000 },
				{ id: "5", ts: Date.now() - 2000 },
				{ id: "6", ts: Date.now() - 1000 },
				{ id: "7", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		await waitFor(() => {
			expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			expect(queryByTestId("roo-hero")).toBeInTheDocument()
		})
	})

	it("does not show welcome content when there is an active task", async () => {
		const { queryByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now(),
					text: "Active task",
				},
			],
		})

		await waitFor(() => {
			expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
			expect(queryByTestId("roo-tips")).not.toBeInTheDocument()
			expect(queryByTestId("roo-hero")).not.toBeInTheDocument()
		})
	})

	it("shows RooTips for newer users", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 3000 },
				{ id: "2", ts: Date.now() - 2000 },
				{ id: "3", ts: Date.now() - 1000 },
				{ id: "4", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
	})

	it("shows RooTips when user has fewer than 6 tasks", () => {
		const { queryByTestId, getByTestId } = renderChatView()

		mockPostMessage({
			taskHistory: [
				{ id: "1", ts: Date.now() - 2000 },
				{ id: "2", ts: Date.now() - 1000 },
				{ id: "3", ts: Date.now() },
			],
			clineMessages: [], // No active task
		})

		expect(queryByTestId("dismissible-upsell")).not.toBeInTheDocument()
		expect(getByTestId("roo-tips")).toBeInTheDocument()
	})
})

describe("ChatView - Message Queueing Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the mock to clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("shows sending is disabled when task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with active task that should disable sending
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 1000,
					text: "Task in progress",
				},
				{
					type: "ask",
					ask: "tool",
					ts: Date.now(),
					text: JSON.stringify({ tool: "readFile", path: "test.txt" }),
					partial: true, // Partial messages disable sending
				},
			],
		})

		// Wait for state to be updated and check that sending is disabled
		await waitFor(() => {
			const chatTextArea = getByTestId("chat-textarea")
			const input = chatTextArea.querySelector("input")!
			expect(input.getAttribute("data-sending-disabled")).toBe("true")
		})
	})

	it("shows sending is enabled when no task is active", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed task
		mockPostMessage({
			clineMessages: [
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed",
					partial: false,
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Check that sending is enabled
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")!
		expect(input.getAttribute("data-sending-disabled")).toBe("false")
	})

	it("queues messages when API request is in progress (spinner visible)", async () => {
		const { getByTestId } = renderChatView()

		// First hydrate state with initial task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
			],
		})

		// Clear any initial calls
		vi.mocked(vscode.postMessage).mockClear()

		// Add api_req_started without cost (spinner state - API request in progress)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
		})

		// Wait for state to be updated with api_req_started
		await waitFor(() => {
			const input = getByTestId("chat-textarea").querySelector("input")!
			expect(input.getAttribute("data-sending-disabled")).toBe("true")
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user typing and sending a message during the spinner
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		// Trigger message send by simulating typing and Enter key press
		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up question during spinner" } })

			// Simulate pressing Enter to send
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was queued, not sent as askResponse
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "follow-up question during spinner",
				images: [],
			})
		})

		// Verify it was NOT sent as a direct askResponse (which would get lost)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})

	it("sends messages normally when API request is complete (cost present)", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with completed API request (cost present)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({
						apiProtocol: "anthropic",
						cost: 0.05, // Cost present = streaming complete
						tokensIn: 100,
						tokensOut: 50,
					}),
				},
				{
					type: "say",
					say: "text",
					ts: Date.now(),
					text: "Response from API",
				},
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a message when API is done
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			// Use fireEvent to properly trigger React's onChange handler
			fireEvent.change(input, { target: { value: "follow-up after completion" } })

			// Simulate pressing Enter to send
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was sent as askResponse, not queued
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "follow-up after completion",
				images: [],
			})
		})

		// Verify it was NOT queued
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
			}),
		)
	})

	it("preserves message order when messages sent during queue drain", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with API request in progress and existing queue
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now(),
					text: JSON.stringify({ apiProtocol: "anthropic" }), // No cost = still streaming
				},
			],
			messageQueue: [
				{ id: "msg1", text: "queued message 1", images: [] },
				{ id: "msg2", text: "queued message 2", images: [] },
			],
		})

		// Wait for state to be updated
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user sending a new message while queue has items
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "message during queue drain" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the new message was queued (not sent directly) to preserve order
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "message during queue drain",
				images: [],
			})
		})

		// Verify it was NOT sent as askResponse (which would break ordering)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "messageResponse",
			}),
		)
	})

	it("queues messages during command_output state instead of losing them", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state with command_output ask (Proceed While Running state)
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "ask",
					ask: "command_output",
					ts: Date.now(),
					text: "",
					partial: false, // Non-partial so buttons are enabled
				},
			],
		})

		// Wait for state to be updated - need to allow time for React effects to propagate
		// (clineAsk state update -> clineAskRef.current update)
		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		// Allow React effects to complete (clineAsk -> clineAskRef sync)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})

		// Clear message calls before simulating user input
		vi.mocked(vscode.postMessage).mockClear()

		// Simulate user typing and sending a message during command execution
		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "message during command execution" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Verify that the message was queued (not lost via terminalOperation)
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "queueMessage",
				text: "message during command execution",
				images: [],
			})
		})

		// Verify it was NOT sent as terminalOperation (which would lose the message)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "terminalOperation",
			}),
		)
	})

	it("sends message directly as askResponse after user stops task, without queueing", async () => {
		const { getByTestId } = renderChatView()

		// Hydrate state simulating a task stopped by user:
		// status is interrupted, last message is api_req_started with cancelReason user_cancelled
		mockPostMessage({
			currentTaskId: "task-stopped-ui",
			currentTaskItem: {
				id: "task-stopped-ui",
				ts: Date.now() - 3000,
				task: "Initial prompt",
				status: "interrupted",
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 3000,
					text: "Initial prompt",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now() - 1000,
					text: JSON.stringify({ request: "cancelled", cancelReason: "user_cancelled" }),
				},
			],
			messageQueue: [],
		})

		await waitFor(() => {
			expect(getByTestId("chat-textarea")).toBeInTheDocument()
		})

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50))
		})

		vi.mocked(vscode.postMessage).mockClear()

		const chatTextArea = getByTestId("chat-textarea")
		const input = chatTextArea.querySelector("input")! as HTMLInputElement

		await act(async () => {
			fireEvent.change(input, { target: { value: "teraz zrob X" } })
			fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
		})

		// Must send immediately as askResponse (new user turn) without queueing
		await waitFor(() => {
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "askResponse",
				askResponse: "messageResponse",
				text: "teraz zrob X",
				images: [],
				taskId: "task-stopped-ui",
			})
		})

		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "queueMessage",
			}),
		)
	})
})

describe("ChatView - Context Condensing Indicator Tests", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should add a condensing message to groupedMessages when isCondensing is true", async () => {
		// This test verifies that when the condenseTaskContextStarted message is received,
		// the isCondensing state is set to true and a synthetic condensing message is added
		// to the grouped messages list
		const { getByTestId, container } = renderChatView()

		// First hydrate state with an active task
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Initial task",
				},
				{
					type: "say",
					say: "api_req_started",
					ts: Date.now() - 1000,
					text: JSON.stringify({ apiProtocol: "anthropic" }),
				},
			],
		})

		// Wait for component to render
		await waitFor(() => {
			expect(getByTestId("chat-view")).toBeInTheDocument()
		})

		// Allow time for useEvent hook to register message listener
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10))
		})

		// Dispatch a MessageEvent directly to trigger the message handler
		// This simulates the VSCode extension sending a message to the webview
		await act(async () => {
			const event = new MessageEvent("message", {
				data: {
					type: "condenseTaskContextStarted",
					text: "test-task-id",
				},
			})
			window.dispatchEvent(event)
			// Wait for React state updates
			await new Promise((resolve) => setTimeout(resolve, 0))
		})

		// Check that groupedMessages now includes a condensing message
		// With Virtuoso mocked, items render directly and we can find the ChatRow with partial condense_context message
		await waitFor(
			() => {
				const rows = container.querySelectorAll('[data-testid="chat-row"]')
				// Check for the actual message structure: partial condense_context message
				const condensingRow = Array.from(rows).find((row) => {
					const text = row.textContent || ""
					return text.includes('"say":"condense_context"') && text.includes('"partial":true')
				})
				expect(condensingRow).toBeTruthy()
			},
			{ timeout: 2000 },
		)
	})
})

describe("ChatView - Task Completion & Resumption Button Bar Tests", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does NOT render the oversized [ Continue ] [ New Chat ] button bar when task is completed or idle", async () => {
		const { queryByText } = renderChatView()

		// Simulate task ending with completion_result ask
		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Do some work",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now(),
					text: "Task completed successfully",
					partial: false,
				},
			],
		})

		await waitFor(() => {
			// Neither "Continue" nor "New Chat" button bar should be rendered above the textarea
			expect(queryByText("Continue")).toBeNull()
			expect(queryByText("New Chat")).toBeNull()
		})
	})

	it("does NOT render [ Continue ] [ New Chat ] when task is resumed from history in resume_completed_task state", async () => {
		const { queryByText } = renderChatView()

		mockPostMessage({
			resumeTaskId: "task-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Do some work",
				},
				{
					type: "say",
					say: "text",
					ts: Date.now() - 1000,
					text: "Final summary of completed work",
				},
				{
					type: "ask",
					ask: "resume_completed_task",
					ts: Date.now(),
					text: "",
				},
			],
		})

		await waitFor(() => {
			expect(queryByText("Continue")).toBeNull()
			expect(queryByText("New Chat")).toBeNull()
		})
	})

	it("does NOT render the oversized full-width button bar for resume_task state and renders exactly one Continue", async () => {
		const { queryByText, queryAllByText } = renderChatView()

		mockPostMessage({
			resumeTaskId: "task-paused-123",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Work paused",
				},
				{
					type: "ask",
					ask: "resume_task",
					ts: Date.now(),
					text: "",
				},
			],
		})

		await waitFor(() => {
			// Oversized "New Chat" button must never appear in chat container
			expect(queryByText("New Chat")).toBeNull()
			// Exactly ONE Continue button exists (the discrete inline button in ChatTextArea)
			const continueButtons = queryAllByText("Continue")
			expect(continueButtons.length).toBe(1)
		})
	})

	it("renders ZERO Continue buttons for delegated parent task", async () => {
		const { queryAllByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "parent-del-task",
			currentTaskItem: {
				id: "parent-del-task",
				status: "delegated",
				awaitingChildId: "child-task-99",
			},
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Parent delegated",
				},
			],
		})

		await waitFor(() => {
			const continueButtons = queryAllByText("Continue")
			expect(continueButtons.length).toBe(0)
		})
	})

	it("renders Run Command and Reject buttons when command ask is followed by non-interactive warning after chat switch", async () => {
		const { getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-test-switch",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Install dependencies",
				},
				{
					type: "ask",
					ask: "command",
					ts: Date.now() - 1000,
					text: "npm install",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: Date.now(),
					text: JSON.stringify({ isSafe: false, riskLevel: "high", reason: "Safety verification temporarily unavailable" }),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:runCommand.title")).toBeInTheDocument()
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})

		// Clicking Run Command must send yesButtonClicked askResponse
		fireEvent.click(getByText("chat:runCommand.title"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "yesButtonClicked",
			}),
		)
	})

	it("renders Run Command and Reject buttons and allows Reject when command ask is followed by non-interactive warning", async () => {
		const { getByText } = renderChatView()

		mockPostMessage({
			currentTaskId: "task-test-switch-2",
			clineMessages: [
				{
					type: "say",
					say: "task",
					ts: Date.now() - 2000,
					text: "Install dependencies",
				},
				{
					type: "ask",
					ask: "command",
					ts: Date.now() - 1000,
					text: "npm install",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: Date.now(),
					text: JSON.stringify({ isSafe: false, riskLevel: "high", reason: "Safety verification temporarily unavailable" }),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})

		// Clicking Reject must send noButtonClicked askResponse
		fireEvent.click(getByText("chat:reject.title"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "noButtonClicked",
			}),
		)
	})

	it("renders Approve and Reject buttons when completion_result ask requires user decision with safety warning", async () => {
		const { getByText } = renderChatView()

		mockPostMessage({
			clineMessages: [
				{
					type: "say",
					say: "text",
					ts: Date.now() - 3000,
					text: "Preliminary verification report",
				},
				{
					type: "say",
					say: "completion_result",
					ts: Date.now() - 2000,
					text: "Attempting completion",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now() - 1000,
					text: "",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: Date.now(),
					text: JSON.stringify({
						isSafe: false,
						riskLevel: "medium",
						reason: "Cannot complete task with 1 item(s) marked 'blocked' on the todo list without user approval.",
					}),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})
	})

	it("clicking Approve sends yesButtonClicked for completion_result requiring user decision", async () => {
		const { getByText } = renderChatView()

		mockPostMessage({
			clineMessages: [
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now() - 1000,
					text: "",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: Date.now(),
					text: JSON.stringify({
						isSafe: false,
						riskLevel: "medium",
						reason: "Cannot complete task with 1 item(s) marked 'blocked' on the todo list without user approval.",
					}),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
		})

		fireEvent.click(getByText("chat:approve.title"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "yesButtonClicked",
			}),
		)
	})

	it("clicking Reject sends noButtonClicked for completion_result requiring user decision", async () => {
		const { getByText } = renderChatView()

		mockPostMessage({
			clineMessages: [
				{
					type: "ask",
					ask: "completion_result",
					ts: Date.now() - 1000,
					text: "",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: Date.now(),
					text: JSON.stringify({
						isSafe: false,
						riskLevel: "medium",
						reason: "Cannot complete task with 1 item(s) marked 'blocked' on the todo list without user approval.",
					}),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})

		fireEvent.click(getByText("chat:reject.title"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "askResponse",
				askResponse: "noButtonClicked",
			}),
		)
	})

	it("preserves completion approval buttons across chat switch A -> B -> A", async () => {
		const { getByText, queryByText } = renderChatView()

		const taskAMessages: any[] = [
			{
				type: "say",
				say: "text",
				ts: 1000,
				text: "Task A report",
			},
			{
				type: "ask",
				ask: "completion_result",
				ts: 2000,
				text: "",
				approvalState: "USER_DECISION_REQUIRED",
			},
			{
				type: "say",
				say: "command_safety_warning",
				ts: 3000,
				text: JSON.stringify({
					isSafe: false,
					riskLevel: "medium",
					reason: "Cannot complete task with 1 item(s) marked 'blocked' on the todo list without user approval.",
				}),
			},
		]

		// Load Task A
		mockPostMessage({
			currentTaskId: "task-A",
			clineMessages: taskAMessages,
		})

		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})

		// Switch to Task B (running task with api_req_started, no buttons)
		mockPostMessage({
			currentTaskId: "task-B",
			clineMessages: [
				{
					type: "say",
					say: "api_req_started",
					ts: 4000,
					text: JSON.stringify({ cost: 0 }),
				},
			],
		})

		await waitFor(() => {
			expect(queryByText("chat:approve.title")).not.toBeInTheDocument()
			expect(queryByText("chat:reject.title")).not.toBeInTheDocument()
		})

		// Switch back to Task A
		mockPostMessage({
			currentTaskId: "task-A",
			clineMessages: taskAMessages,
		})

		// Buttons must still be present and stable
		await waitFor(() => {
			expect(getByText("chat:approve.title")).toBeInTheDocument()
			expect(getByText("chat:reject.title")).toBeInTheDocument()
		})
	})

	it("does not render STOP/PAUSE button when awaiting manual approval or deferred verifier retry", async () => {
		const { getByText, queryByRole } = renderChatView()

		mockPostMessage({
			approvalMode: "auto",
			currentTaskId: "task-guardrail-timeout",
			clineMessages: [
				{
					type: "ask",
					ask: "command",
					ts: 1000,
					text: "python script.py",
					approvalState: "USER_DECISION_REQUIRED",
				},
				{
					type: "say",
					say: "command_safety_warning",
					ts: 1001,
					text: JSON.stringify({
						isSafe: false,
						riskLevel: "medium",
						reason: "Safety verification temporarily unavailable. Review this action manually. (TIMEOUT: Approval AI evaluation timed out after 12000ms)",
						infrastructureFailure: true,
						deferredRetry: {
							attempt: 1,
							maxAttempts: 3,
							delayMs: 15000,
							nextRetryAt: Date.now() + 15000,
						},
					}),
				},
			],
		})

		await waitFor(() => {
			expect(getByText("chat:runCommand.title")).toBeInTheDocument()
			expect(getByText("chat:reject.title")).toBeInTheDocument()
			// STOP button must NOT be present
			expect(queryByRole("button", { name: "chat:stop.title" })).not.toBeInTheDocument()
		})
	})
})

