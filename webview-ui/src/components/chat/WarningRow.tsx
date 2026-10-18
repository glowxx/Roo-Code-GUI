import React from "react"
import { TriangleAlert, BookOpenText } from "lucide-react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@src/utils/vscode"

export interface WarningRowProps {
	title: string
	message: string
	docsURL?: string
	actionText?: string
	onAction?: () => void
	details?: string
}

/**
 * A generic warning row component that displays a warning icon, title, and message.
 * Optionally includes a documentation link and/or an action link.
 *
 * @param title - The warning title displayed in bold
 * @param message - The warning message displayed below the title
 * @param docsURL - Optional documentation link URL (shown as "Learn more" with book icon)
 * @param actionText - Optional text for an action link appended to the message
 * @param onAction - Optional callback when the action link is clicked
 *
 * @example
 * <WarningRow
 *   title="Too many tools enabled"
 *   message="You have 50 tools enabled via 5 MCP servers."
 *   docsURL="https://docs.example.com/mcp-best-practices"
 *   actionText="Open MCP Settings"
 *   onAction={() => openSettings()}
 * />
 */
export const WarningRow: React.FC<WarningRowProps> = ({ title, message, docsURL, actionText, onAction, details }) => {
	const { t } = useAppTranslation()

	return (
		<div className="agent-notice group pr-2 py-2">
			<div className="flex items-center justify-between gap-2 break-words">
				<TriangleAlert className="w-3.5 text-vscode-descriptionForeground shrink-0" />
				<span className="font-medium text-vscode-foreground grow cursor-default">{title}</span>
				{docsURL && (
					<a
						href={docsURL}
						className="text-sm flex items-center gap-1 transition-opacity opacity-0 group-hover:opacity-100"
						onClick={(e) => {
							e.preventDefault()
							vscode.postMessage({ type: "openExternal", url: docsURL })
						}}>
						<BookOpenText className="size-3 mt-[3px]" />
						{t("chat:apiRequest.errorMessage.docs")}
					</a>
				)}
			</div>
			<div className="cursor-default mt-1 pt-0.5">
				<p className="my-0 font-light whitespace-pre-wrap break-words text-vscode-descriptionForeground">
					{message}
					{actionText && onAction && (
						<>
							{" "}
							<a
								href="#"
								className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground cursor-pointer"
								onClick={(e) => {
									e.preventDefault()
									onAction()
								}}>
								{actionText}
							</a>
						</>
					)}
				</p>
				{details && (
					<details className="agent-notice-details">
						<summary>{t("chat:warningRow.technicalDetails", "Technical details")}</summary>
						<pre>{details}</pre>
					</details>
				)}
			</div>
		</div>
	)
}

export default WarningRow
