// npx vitest src/components/chat/__tests__/TaskHeader.spec.tsx

import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import type { ProviderSettings } from "@roo-code/types"

import TaskHeader, { TaskHeaderProps } from "../TaskHeader"

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key, // Simple mock that returns the key
	}),
	// Mock initReactI18next to prevent initialization errors in tests
	initReactI18next: {
		type: "3rdParty",
		init: vi.fn(),
	},
}))

// Mock the vscode API - use vi.hoisted to ensure the mock is available when vi.mock is hoisted
const { mockPostMessage } = vi.hoisted(() => ({
	mockPostMessage: vi.fn(),
}))
vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: mockPostMessage,
	},
}))

// Mock the VSCodeBadge component
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeBadge: ({ children }: { children: React.ReactNode }) => <div data-testid="vscode-badge">{children}</div>,
}))

// Create a variable to hold the mock state
const mockExtensionState: {
	apiConfiguration: ProviderSettings
	currentTaskItem: { id: string } | null
	clineMessages: any[]
} = {
	apiConfiguration: {
		apiProvider: "anthropic",
		apiKey: "test-api-key",
		apiModelId: "claude-3-opus-20240229",
	} as ProviderSettings,
	currentTaskItem: { id: "test-task-id" },
	clineMessages: [
		{ type: "say", ts: 1, text: "msg1" },
		{ type: "say", ts: 2, text: "msg2" },
		{ type: "say", ts: 3, text: "msg3" },
		{ type: "say", ts: 4, text: "msg4" },
	],
}

// Mock the ExtensionStateContext
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

// Mock findLastIndex from @roo/array
vi.mock("@roo/array", () => ({
	findLastIndex: (array: any[], predicate: (item: any) => boolean) => {
		for (let i = array.length - 1; i >= 0; i--) {
			if (predicate(array[i])) {
				return i
			}
		}
		return -1
	},
}))

// Create a variable to hold the mock model info for useSelectedModel
let mockModelInfo: { contextWindow: number; maxTokens: number } | undefined = undefined

// Mock useSelectedModel hook
vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		provider: "anthropic",
		id: "test-model",
		info: mockModelInfo,
		isLoading: false,
		isError: false,
	}),
}))

// Mock getModelMaxOutputTokens from @roo/api
let mockMaxOutputTokens = 0
vi.mock("@roo/api", () => ({
	getModelMaxOutputTokens: () => mockMaxOutputTokens,
}))

describe("TaskHeader", () => {
	const defaultProps: TaskHeaderProps = {
		task: { type: "say", ts: Date.now(), text: "Test task", images: [] },
		tokensIn: 100,
		tokensOut: 50,
		requestsWithUsage: 1,
		contextTokens: 200,
		buttonsDisabled: false,
		handleCondenseContext: vi.fn(),
	}

	const queryClient = new QueryClient()

	const renderTaskHeader = (props: Partial<TaskHeaderProps> = {}) => {
		return render(
			<QueryClientProvider client={queryClient}>
				<TaskHeader {...defaultProps} {...props} />
			</QueryClientProvider>,
		)
	}

	it("shows separate provider input and output totals without cost", () => {
		renderTaskHeader()
		expect(screen.queryByTestId("task-token-usage")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Test task"))
		expect(screen.getByTestId("task-token-usage")).toHaveTextContent("chat:task.inputTokens 100")
		expect(screen.getByTestId("task-token-usage")).toHaveTextContent("chat:task.outputTokens 50")
		expect(screen.queryByText(/\\$/)).not.toBeInTheDocument()
	})

	it("shows unavailable usage instead of an invented zero", () => {
		renderTaskHeader({ tokensIn: 0, tokensOut: 0, requestsWithUsage: 0, usageIncomplete: true })
		fireEvent.click(screen.getByText("Test task"))
		expect(screen.getByTestId("task-token-usage")).toHaveTextContent("chat:task.inputTokens —")
		expect(screen.getByTestId("task-token-usage")).toHaveTextContent("(chat:task.partial)")
	})
	it("should render the condense context button when expanded", () => {
		renderTaskHeader()
		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Now find the condense button in the expanded state
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton?.querySelector("svg")).toBeInTheDocument()
	})

	it("should call handleCondenseContext when condense context button is clicked", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ handleCondenseContext })

		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Find the button that contains the FoldVertical icon
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).toHaveBeenCalledWith("test-task-id")
	})

	it("should disable the condense context button when buttonsDisabled is true", () => {
		const handleCondenseContext = vi.fn()
		renderTaskHeader({ buttonsDisabled: true, handleCondenseContext })

		// First click to expand the task header
		const taskHeader = screen.getByText("Test task")
		fireEvent.click(taskHeader)

		// Find the button that contains the FoldVertical icon
		const buttons = screen.getAllByRole("button")
		const condenseButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(condenseButton).toBeDefined()
		expect(condenseButton).toBeDisabled()
		fireEvent.click(condenseButton!)
		expect(handleCondenseContext).not.toHaveBeenCalled()
	})

	it("should render compact button in collapsed state", () => {
		mockModelInfo = { contextWindow: 4000, maxTokens: 1000 }
		renderTaskHeader()

		const buttons = screen.getAllByRole("button")
		const compactButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(compactButton).toBeDefined()
		expect(compactButton?.querySelector("svg")).toBeInTheDocument()
	})

	it("should disable compact button when task has fewer than 4 messages", () => {
		mockModelInfo = { contextWindow: 4000, maxTokens: 1000 }
		const prev = mockExtensionState.clineMessages
		mockExtensionState.clineMessages = [{ type: "say", ts: 1, text: "only one" }]

		renderTaskHeader()
		const buttons = screen.getAllByRole("button")
		const compactButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(compactButton).toBeDefined()
		expect(compactButton).toBeDisabled()

		mockExtensionState.clineMessages = prev
	})

	it("should dispatch compactTask message to vscode on click", () => {
		mockPostMessage.mockClear()
		mockModelInfo = { contextWindow: 4000, maxTokens: 1000 }
		renderTaskHeader()

		const buttons = screen.getAllByRole("button")
		const compactButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(compactButton).toBeDefined()
		fireEvent.click(compactButton!)

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "compactTask",
			taskId: "test-task-id",
		})
	})

	it("should show spinning animation when isCondensing is true", () => {
		mockModelInfo = { contextWindow: 4000, maxTokens: 1000 }
		renderTaskHeader({ isCondensing: true })

		const buttons = screen.getAllByRole("button")
		const compactButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
		expect(compactButton).toBeDefined()
		expect(compactButton).toBeDisabled()
		const svg = compactButton?.querySelector("svg.lucide-fold-vertical")
		expect(svg).toHaveClass("animate-spin")
	})

	describe("Back to parent task button", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		it("should not show back button when parentTaskId is not provided", () => {
			renderTaskHeader()
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should not show back button when parentTaskId is undefined", () => {
			renderTaskHeader({ parentTaskId: undefined })
			expect(screen.queryByText("chat:task.backToParentTask")).not.toBeInTheDocument()
		})

		it("should show back button when parentTaskId is provided", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })
			expect(screen.getByText("chat:task.backToParentTask")).toBeInTheDocument()
		})

		it("should call vscode.postMessage with showTaskWithId when back button is clicked", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			const backButton = screen.getByText("chat:task.backToParentTask")
			fireEvent.click(backButton)

			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "showTaskWithId",
				text: "parent-task-123",
			})
		})

		it("should show back button with ArrowLeft icon", () => {
			renderTaskHeader({ parentTaskId: "parent-task-123" })

			// Find the button containing the back text and verify it has the ArrowLeft icon
			const backButton = screen.getByText("chat:task.backToParentTask").closest("button")
			expect(backButton).toBeInTheDocument()
			expect(backButton?.querySelector("svg.lucide-arrow-left")).toBeInTheDocument()
		})
	})

	describe("New Chat button", () => {
		beforeEach(() => {
			mockPostMessage.mockClear()
		})

		it("should render new chat button and post clearTask message when clicked", () => {
			renderTaskHeader()
			const newChatButton = screen.getByTestId("header-new-chat-btn")
			expect(newChatButton).toBeInTheDocument()

			fireEvent.click(newChatButton)
			expect(mockPostMessage).toHaveBeenCalledWith({
				type: "clearTask",
			})
		})
	})

	describe("Context window percentage calculation", () => {
		// The percentage should be calculated as:
		// contextTokens / (contextWindow - reservedForOutput) * 100
		// This represents the percentage of AVAILABLE input space used,
		// not the percentage of the total context window.

		beforeEach(() => {
			// Set up mock model with known contextWindow
			mockModelInfo = { contextWindow: 1000, maxTokens: 200 }
			// Set up mock for getModelMaxOutputTokens to return reservedForOutput
			mockMaxOutputTokens = 200
		})

		afterEach(() => {
			// Reset mocks
			mockModelInfo = undefined
			mockMaxOutputTokens = 0
		})

		it("should not render context window percentage in collapsed state, keeping header clean while preserving compactButton", () => {
			renderTaskHeader({ contextTokens: 200 })

			// The percentage indicator has been relocated to ChatTextArea
			expect(screen.queryByText("25%")).not.toBeInTheDocument()
			expect(screen.queryByText("40%")).not.toBeInTheDocument()

			// Compact button remains preserved in the header
			const buttons = screen.getAllByRole("button")
			const compactButton = buttons.find((button) => button.querySelector("svg.lucide-fold-vertical"))
			expect(compactButton).toBeDefined()
		})
	})

	describe("Prompt presentation: latestUserPrompt vs task fallback", () => {
		it("renders task.text when latestUserPrompt is not provided", () => {
			renderTaskHeader({
				task: { type: "say", ts: 1000, text: "Initial Task A" },
			})
			expect(screen.getByText("Initial Task A")).toBeInTheDocument()
		})

		it("renders latestUserPrompt.text when provided", () => {
			renderTaskHeader({
				task: { type: "say", ts: 1000, text: "Initial Task A" },
				latestUserPrompt: { type: "say", ts: 1004, text: "Latest User Feedback C" },
			})
			expect(screen.getByText("Latest User Feedback C")).toBeInTheDocument()
			expect(screen.queryByText("Initial Task A")).not.toBeInTheDocument()
		})
	})

	describe("Task token usage", () => {
		it("shows the same task totals when expanded", () => {
			renderTaskHeader({ tokensIn: 1250, tokensOut: 300, requestsWithUsage: 2 })
			const headerCard = screen.getByText("Test task").closest(".cursor-pointer")
			fireEvent.click(headerCard!)
			expect(screen.getByText(/chat:task.inputTokens/)).toBeInTheDocument()
			expect(screen.queryByText(/\\$/)).not.toBeInTheDocument()
		})
	})
})
