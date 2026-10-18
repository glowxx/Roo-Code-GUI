import { useEffect, useId, useRef, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import type { ClineMessage } from "@roo-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { getAgentActivityLabel } from "./agent-feed"

interface AgentActivityProps {
	messages: ClineMessage[]
	active: boolean
	open: boolean
	onToggle: () => void
	onHeightChange: (isTaller: boolean) => void
	renderMessage: (message: ClineMessage) => ReactNode
	focusMessageTs?: number
}

export function AgentActivity({
	messages,
	active,
	open,
	onToggle,
	onHeightChange,
	renderMessage,
	focusMessageTs,
}: AgentActivityProps) {
	const { t } = useAppTranslation()
	const id = useId()
	const rootRef = useRef<HTMLDivElement>(null)
	// Keep the current execution subscribed to live terminal/MCP events while
	// folded. Historical details stay lazy; opening the log preserves this row.
	const liveMessage = active
		? messages.findLast((message) => message.ask === "command" || message.ask === "use_mcp_server")
		: undefined
	useEffect(() => {
		if (!open || focusMessageTs === undefined) return
		const frame = requestAnimationFrame(() =>
			rootRef.current
				?.querySelector(`[data-activity-message="${focusMessageTs}"]`)
				?.scrollIntoView({ block: "nearest" }),
		)
		return () => cancelAnimationFrame(frame)
	}, [open, focusMessageTs])
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		let previousHeight = root.getBoundingClientRect().height
		const observer = new ResizeObserver(() => {
			const height = root.getBoundingClientRect().height
			if (height !== previousHeight) onHeightChange(height > previousHeight)
			previousHeight = height
		})
		observer.observe(root)
		return () => observer.disconnect()
	}, [onHeightChange])
	return (
		<div ref={rootRef} className="conversation-canvas agent-activity" data-testid="agent-activity">
			<button
				type="button"
				className="agent-activity-trigger"
				aria-expanded={open}
				aria-controls={id}
				onClick={onToggle}>
				{active && <span className="agent-working-dot" aria-hidden="true" />}
				<span>{active ? getAgentActivityLabel(messages, t) : t("chat:agentActivity.details", "Work details")}</span>
				<ChevronRight size={13} aria-hidden="true" className={open ? "rotate-90" : ""} />
			</button>
			{(open || liveMessage) && (
				<div
					id={id}
					className="agent-activity-details"
					hidden={!open}
					data-testid={open ? "agent-activity-details" : undefined}>
					{(open ? messages : [liveMessage!]).map((message) => (
						<div key={message.ts} data-activity-message={message.ts}>
							{renderMessage(message)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}
