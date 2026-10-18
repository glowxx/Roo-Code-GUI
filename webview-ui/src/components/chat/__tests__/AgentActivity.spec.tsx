import { render, screen, fireEvent } from "@/utils/test-utils"
import { AgentActivity } from "../AgentActivity"
import { useEffect } from "react"

describe("AgentActivity disclosure", () => {
	it("keeps the running execution mounted across folding so live output subscriptions survive", () => {
		const mounted = vi.fn()
		function LiveExecution() {
			useEffect(() => {
				mounted()
			}, [])
			return <pre>Live command output</pre>
		}
		const props = {
			messages: [{ type: "ask" as const, ask: "command" as const, ts: 9 }],
			active: true,
			open: false,
			onToggle: vi.fn(),
			onHeightChange: vi.fn(),
			renderMessage: () => <LiveExecution />,
		}
		const { rerender } = render(<AgentActivity {...props} />)
		expect(screen.getByText("Live command output")).not.toBeVisible()
		rerender(<AgentActivity {...props} open />)
		expect(screen.getByText("Live command output")).toBeVisible()
		rerender(<AgentActivity {...props} />)
		expect(screen.getByText("Live command output")).not.toBeVisible()
		expect(mounted).toHaveBeenCalledTimes(1)
	})
	const messages = [{ type: "say" as const, say: "command_output" as const, ts: 1, text: "technical output" }]
	it("does not mount technical content until the user requests it", () => {
		const renderMessage = vi.fn((message) => <pre>{message.text}</pre>)
		const onToggle = vi.fn()
		const props = { messages, active: false, open: false, onToggle, onHeightChange: vi.fn(), renderMessage }
		const { rerender } = render(<AgentActivity {...props} />)
		expect(renderMessage).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: /Work details|Szczegóły pracy/ })).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(screen.getByRole("button"))
		expect(onToggle).toHaveBeenCalledTimes(1)
		rerender(<AgentActivity {...props} open />)
		expect(screen.getByText("technical output")).toBeVisible()
		expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true")
	})
	it("shows one quiet current activity without counts or diagnostic badges", () => {
		render(
			<AgentActivity
				messages={messages}
				active
				open={false}
				onToggle={vi.fn()}
				onHeightChange={vi.fn()}
				renderMessage={() => null}
			/>,
		)
		expect(screen.getByRole("button")).toHaveTextContent(/Working in terminal|Pracuję w terminalu/)
		expect(screen.queryByText("technical output")).not.toBeInTheDocument()
	})
})
