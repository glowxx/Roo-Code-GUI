import React, { memo, useState } from "react"
import { Trans } from "react-i18next"

import type { ClineMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

type AutoApprovedRequestLimitWarningProps = {
	message: ClineMessage
}

export const AutoApprovedRequestLimitWarning = memo(({ message }: AutoApprovedRequestLimitWarningProps) => {
	const [buttonClicked, setButtonClicked] = useState(false)
	const { count, type = "requests" } = JSON.parse(message.text ?? "{}")

	if (buttonClicked) {
		return null
	}

	const isCostLimit = type === "cost"
	const titleKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.title"
		: "ask.autoApprovedRequestLimitReached.title"
	const descriptionKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.description"
		: "ask.autoApprovedRequestLimitReached.description"
	const buttonKey = isCostLimit
		? "ask.autoApprovedCostLimitReached.button"
		: "ask.autoApprovedRequestLimitReached.button"

	return (
		<div className="agent-notice">
			<div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--vscode-foreground)" }}>
				<span className="codicon codicon-warning" />
				<span style={{ fontWeight: 500 }}>
					<Trans i18nKey={titleKey} ns="chat" />
				</span>
			</div>

			<div
				className="flex flex-col gap-3"
				style={{
					borderRadius: "4px",
					display: "flex",
					marginTop: "8px",
					padding: "0",
					justifyContent: "center",
				}}>
				<div className="flex justify-between items-center">
					<Trans i18nKey={descriptionKey} ns="chat" values={{ count }} />
				</div>
				<Button
					variant="secondary"
					style={{ width: "fit-content", padding: "6px 12px", borderRadius: "8px" }}
					onClick={(e) => {
						e.preventDefault()
						setButtonClicked(true)
						vscode.postMessage({
							type: "askResponse",
							askResponse: "yesButtonClicked",
							taskId: message.taskId,
						})
					}}>
					<Trans i18nKey={buttonKey} ns="chat" />
				</Button>
			</div>
		</div>
	)
})
