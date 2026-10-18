import React, { useState } from "react"
import {
	Copy,
	Check,
	RotateCw,
	Edit2,
	Globe,
	Brain,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	AlertCircle,
	User,
	Sparkles,
} from "lucide-react"
import type { ChatMessage } from "@roo-code/types"
import { openSettings } from "@src/utils/settingsNavigation"
import MarkdownBlock from "@src/components/common/MarkdownBlock"
import Thumbnails from "@src/components/common/Thumbnails"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface NativeChatMessageRowProps {
	message: ChatMessage
	isLastAssistantMessage?: boolean
	onRegenerate?: (messageId: string) => void
	onEditAndResend?: (messageId: string, newText: string) => void
}

export const NativeChatMessageRow: React.FC<NativeChatMessageRowProps> = ({
	message,
	isLastAssistantMessage,
	onRegenerate,
	onEditAndResend,
}) => {
	const { t } = useAppTranslation()
	const [copied, setCopied] = useState(false)
	const [isReasoningExpanded, setIsReasoningExpanded] = useState(false)
	const [isWebSearchExpanded, setIsWebSearchExpanded] = useState(false)
	const [isEditing, setIsEditing] = useState(false)
	const [editText, setEditText] = useState(message.content)

	const isUser = message.role === "user"

	const handleCopy = () => {
		navigator.clipboard.writeText(message.content)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	const handleSaveEdit = () => {
		if (editText.trim() && onEditAndResend) {
			onEditAndResend(message.id, editText.trim())
			setIsEditing(false)
		}
	}

	const formatTimestamp = (ts: number) => {
		return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	}

	return (
		<div
			className={`group relative py-4 px-4 sm:px-6 transition-colors ${
				isUser ? "bg-transparent" : "bg-[var(--bg-canvas)]"
			}`}>
			<div className="max-w-3xl mx-auto flex gap-3">
				{/* Avatar */}
				<div className="shrink-0 mt-0.5">
					{isUser ? (
						<div className="w-7 h-7 rounded-full bg-[var(--bg-surface-elevated)] flex items-center justify-center text-[var(--text-primary)]">
							<User className="w-4 h-4 opacity-80" />
						</div>
					) : (
						<div className="w-7 h-7 rounded-full bg-[var(--bg-surface-elevated)] flex items-center justify-center text-[var(--text-secondary)] shadow-none">
							<Sparkles className="w-4 h-4" />
						</div>
					)}
				</div>

				{/* Body */}
				<div className="flex-1 min-w-0">
					{/* Header Meta */}
					<div className="flex items-center justify-between gap-2 mb-1.5 select-none">
						<div className="flex items-center gap-2">
							<span className="text-xs font-semibold text-[var(--vscode-editor-foreground)]">
								{isUser ? t("chat:nativeChat.you", "Ty") : t("chat:nativeChat.rooAi", "Roo AI")}
							</span>
							<span className="text-[11px] text-[var(--vscode-descriptionForeground)] opacity-70">
								{formatTimestamp(message.timestamp)}
							</span>
						</div>

						{/* Action Buttons */}
						<div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
							{isUser && onEditAndResend && !isEditing && (
								<button
									type="button"
									onClick={() => setIsEditing(true)}
									className="p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-editor-foreground)] hover:bg-[var(--vscode-list-hoverBackground,rgba(255,255,255,0.08))] transition-colors cursor-pointer"
									title={t("chat:nativeChat.editAndResend", "Edytuj wiadomość & resend")}>
									<Edit2 className="w-3.5 h-3.5" />
								</button>
							)}
							<button
								type="button"
								onClick={handleCopy}
								className="p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-editor-foreground)] hover:bg-[var(--vscode-list-hoverBackground,rgba(255,255,255,0.08))] transition-colors cursor-pointer"
								title={t("chat:nativeChat.copyMessage", "Kopiuj wiadomość")}>
								{copied ? (
									<Check className="w-3.5 h-3.5 text-emerald-400" />
								) : (
									<Copy className="w-3.5 h-3.5" />
								)}
							</button>
							{!isUser && isLastAssistantMessage && onRegenerate && (
								<button
									type="button"
									onClick={() => onRegenerate(message.id)}
									className="p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-editor-foreground)] hover:bg-[var(--vscode-list-hoverBackground,rgba(255,255,255,0.08))] transition-colors cursor-pointer"
									title={t("chat:nativeChat.regenerate", "Wygeneruj ponownie")}>
									<RotateCw className="w-3.5 h-3.5" />
								</button>
							)}
						</div>
					</div>

					{/* Image Attachments */}
					{message.images && message.images.length > 0 && (
						<div className="mb-2.5">
							<Thumbnails images={message.images} />
						</div>
					)}

					{/* Web Search Section */}
					{message.webSearch && (
						<div className="mb-3 rounded-lg border border-[var(--vscode-editorWidget-border,rgba(255,255,255,0.08))] bg-[var(--vscode-editorWidget-background,rgba(255,255,255,0.02))] overflow-hidden">
							<button
								type="button"
								onClick={() => setIsWebSearchExpanded((prev) => !prev)}
								className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--vscode-editor-foreground)] hover:bg-[var(--vscode-list-hoverBackground,rgba(255,255,255,0.04))] transition-colors cursor-pointer select-none">
								<div className="flex items-center gap-2 truncate">
									<Globe className="w-3.5 h-3.5 text-[var(--text-secondary)] shrink-0" />
									<span className="truncate">
										{t("chat:nativeChat.searching", "Wyszukiwanie:")} &ldquo;{message.webSearch.query}&rdquo;
									</span>
									<span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[var(--accent-subtle)] text-[var(--text-secondary)]">
										{t("chat:nativeChat.sourcesCount", { count: message.webSearch.results.length, defaultValue: `${message.webSearch.results.length} źródeł` })}
									</span>
								</div>
								{isWebSearchExpanded ? (
									<ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-60" />
								) : (
									<ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-60" />
								)}
							</button>

							{isWebSearchExpanded && (
								<div className="p-3 border-t border-[var(--vscode-editorWidget-border,rgba(255,255,255,0.06))] space-y-2 max-h-56 overflow-y-auto">
									{message.webSearch.results.map((r, i) => (
										<div key={i} className="text-xs space-y-0.5">
											<a
												href={r.url}
												target="_blank"
												rel="noopener noreferrer"
												className="font-medium text-[var(--vscode-textLink-foreground,#3794ff)] hover:underline flex items-center gap-1">
												<span className="truncate">{r.title}</span>
												<ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
											</a>
											{r.snippet && (
												<p className="text-[11px] text-[var(--vscode-descriptionForeground)] line-clamp-2">
													{r.snippet}
												</p>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					)}

					{/* Collapsible Reasoning / Thinking Box */}
					{message.reasoning && (
						<div className="mb-3 rounded-lg border border-[var(--border-light)] bg-[var(--bg-hover)] overflow-hidden">
							<button
								type="button"
								onClick={() => setIsReasoningExpanded((prev) => !prev)}
								className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]/10 transition-colors cursor-pointer select-none">
								<div className="flex items-center gap-2">
									<Brain className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
									<span>{t("chat:nativeChat.reasoningProcess", "Tok rozumowania")}</span>
									<span className="text-[10px] text-[var(--text-secondary)]">
										({t("chat:nativeChat.wordsCount", { count: message.reasoning.split(/\s+/).length, defaultValue: `${message.reasoning.split(/\s+/).length} słów` })})
									</span>
								</div>
								{isReasoningExpanded ? (
									<ChevronDown className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
								) : (
									<ChevronRight className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
								)}
							</button>

							{isReasoningExpanded && (
								<div className="p-3 border-t border-indigo-500/10 text-xs text-[var(--vscode-descriptionForeground)] leading-relaxed whitespace-pre-wrap font-mono max-h-64 overflow-y-auto bg-black/10">
									{message.reasoning}
								</div>
							)}
						</div>
					)}

					{/* Inline Message Edit */}
					{isEditing ? (
						<div className="space-y-2 mt-1">
							<textarea
								value={editText}
								onChange={(e) => setEditText(e.target.value)}
								className="w-full p-2.5 rounded-lg border border-[var(--border-focus)] bg-[var(--bg-surface)] text-xs text-[var(--text-primary)] outline-none resize-none font-sans"
								rows={4}
							/>
							<div className="flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={() => {
										setIsEditing(false)
										setEditText(message.content)
									}}
									className="px-2.5 py-1 text-xs rounded border border-[var(--border-light)] bg-[var(--bg-surface-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-active)] cursor-pointer">
									{t("chat:nativeChat.cancel", "Anuluj")}
								</button>
								<button
									type="button"
									onClick={handleSaveEdit}
									className="px-2.5 py-1 text-xs rounded font-medium bg-[var(--text-primary)] text-[var(--bg-canvas)] hover:opacity-90 cursor-pointer">
									{t("chat:nativeChat.saveAndResend", "Zapisz i wyślij ponownie")}
								</button>
							</div>
						</div>
					) : (
						/* Message Content */
						<div className="text-sm leading-relaxed text-[var(--vscode-editor-foreground)] break-words">
							{message.content ? (
								<MarkdownBlock markdown={message.content} />
							) : message.isStreaming ? (
								message.status ? (
									<div className="flex items-center gap-2 text-xs text-[var(--vscode-descriptionForeground)] py-1 select-none">
										<Globe className="w-3.5 h-3.5 text-[var(--text-secondary)] animate-spin" />
										<span>{message.status}</span>
									</div>
								) : (
									<span className="inline-block w-2 h-4 bg-[var(--accent)] animate-pulse rounded-sm" />
								)
							) : null}
						</div>
					)}

					{/* Error Notification */}
					{message.error && (
						<div className="mt-2.5 p-2.5 rounded-lg border border-[var(--border-light)] bg-[var(--danger-subtle)] text-xs text-[var(--danger)] flex flex-col gap-2">
							<div className="flex items-start gap-2">
								<AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
								<span className="flex-1 leading-relaxed">{message.error}</span>
							</div>
							{(message.error.includes("401") ||
								message.error.includes("API key") ||
								message.error.includes("Authentication") ||
								message.error.includes("ClientApiKey")) && (
								<div className="flex items-center gap-2 pl-6">
									<button
										type="button"
										onClick={() =>
											openSettings({ section: "providers", source: "native_chat_error" })
										}
										className="px-2.5 py-1 text-xs rounded font-medium bg-[var(--vscode-button-secondaryBackground,#3a3d41)] text-[var(--vscode-button-secondaryForeground,#ffffff)] hover:bg-[var(--vscode-button-secondaryHoverBackground,#45494e)] transition-colors cursor-pointer">
										{t("chat:nativeChat.openProviderSettings", "Otwórz ustawienia dostawcy")}
									</button>
								</div>
							)}
						</div>
					)}

					{/* Footer Meta: Token Usage */}
					{!isUser && message.tokenUsage && (
						<div className="mt-2.5 pt-2 border-t border-[var(--vscode-editorWidget-border,rgba(255,255,255,0.04))] flex items-center gap-3 text-[10.5px] text-[var(--vscode-descriptionForeground)] opacity-60 select-none">
							<span>{t("chat:nativeChat.inputTokens", "Wejście:")} {message.tokenUsage.promptTokens || 0}</span>
							<span>•</span>
							<span>{t("chat:nativeChat.outputTokens", "Wyjście:")} {message.tokenUsage.completionTokens || 0}</span>
							<span>•</span>
							<span>{t("chat:nativeChat.totalTokens", "Razem:")} {message.tokenUsage.totalTokens || 0}</span>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
