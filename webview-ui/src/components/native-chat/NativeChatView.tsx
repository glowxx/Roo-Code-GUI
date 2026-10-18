import React, { useCallback, useEffect, useRef, useState } from "react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { ArrowDown, MessageSquarePlus, Sparkles } from "lucide-react"
import type {
	ChatMessage,
	ChatSession,
	ChatSessionSummary,
	ChatPreferences,
	ChatModelPreference,
	ExtensionMessage,
} from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { NativeChatEmptyState } from "./NativeChatEmptyState"
import { NativeChatMessageRow } from "./NativeChatMessageRow"
import { NativeChatComposer } from "./NativeChatComposer"

interface NativeChatViewProps {
	isHidden?: boolean
	onSwitchToAgent?: () => void
}

export const NativeChatView: React.FC<NativeChatViewProps> = ({ isHidden = false, onSwitchToAgent }) => {
	const { t } = useAppTranslation()
	const [session, setSession] = useState<ChatSession | null>(null)
	const [sessionsList, setSessionsList] = useState<ChatSessionSummary[]>([])
	const [preferences, setPreferences] = useState<ChatPreferences | null>(null)
	const [isStreaming, setIsStreaming] = useState(false)
	const [showScrollBottom, setShowScrollBottom] = useState(false)

	const virtuosoRef = useRef<VirtuosoHandle>(null)
	const activeSessionIdRef = useRef<string | null>(null)
	activeSessionIdRef.current = session?.id || null

	// Request initial sessions & preferences on mount
	useEffect(() => {
		vscode.postMessage({ type: "chatGetPreferences" })
		vscode.postMessage({ type: "chatListSessions" })
	}, [])

	// Listen for extension host messages
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "chatPreferencesData" && message.chatPreferences) {
				setPreferences(message.chatPreferences)
			}

			if (message.type === "chatSessionsList" && Array.isArray(message.chatSessions)) {
				setSessionsList(message.chatSessions)
				// If no active session, auto-select latest or create first
				if (!activeSessionIdRef.current && message.chatSessions.length > 0) {
					vscode.postMessage({
						type: "chatGetSession",
						chatSessionId: message.chatSessions[0].id,
					})
				}
			}

			if (message.type === "chatSessionData") {
				if (message.chatSession) {
					setSession(message.chatSession)
					const lastMsg = message.chatSession.messages[message.chatSession.messages.length - 1]
					setIsStreaming(Boolean(lastMsg && lastMsg.isStreaming))
				} else {
					setSession(null)
					setIsStreaming(false)
				}
			}

			if (message.type === "chatStreamChunk" && message.chatStreamChunk) {
				const chunk = message.chatStreamChunk

				setSession((prev) => {
					if (!prev) return prev
					const messages = [...prev.messages]
					if (messages.length === 0) return prev

					const lastIndex = messages.length - 1
					const lastMessage = { ...messages[lastIndex] }

					if (lastMessage.role !== "assistant") return prev

					if (chunk.type === "text") {
						lastMessage.status = undefined
						lastMessage.content = (lastMessage.content || "") + chunk.text
					} else if (chunk.type === "reasoning") {
						lastMessage.reasoning = (lastMessage.reasoning || "") + chunk.text
					} else if (chunk.type === "status") {
						lastMessage.status = chunk.status
					} else if (chunk.type === "webSearch") {
						lastMessage.webSearch = chunk.search
					} else if (chunk.type === "usage") {
						lastMessage.tokenUsage = chunk.usage
					} else if (chunk.type === "error") {
						lastMessage.status = undefined
						lastMessage.error = chunk.error
						lastMessage.isStreaming = false
						setIsStreaming(false)
					} else if (chunk.type === "complete") {
						lastMessage.status = undefined
						lastMessage.isStreaming = false
						setIsStreaming(false)
					}

					messages[lastIndex] = lastMessage
					return { ...prev, messages }
				})
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const handleCreateNewChat = useCallback(() => {
		vscode.postMessage({
			type: "chatCreateSession",
			chatModelPreference: session?.modelPreference || {
				apiProvider: preferences?.apiProvider || "xkiro",
				modelId: preferences?.modelId || "openai/gpt-5.6-terra",
				reasoningEffort: preferences?.reasoningEffort || "medium",
				webSearchMode: preferences?.webSearchMode || "auto",
			},
		})
	}, [session, preferences])

	const handleSend = useCallback(
		async (text: string, images?: string[], webSearchMode?: "off" | "auto" | "required") => {
			let currentSessionId = session?.id

			// Optimistic turns
			const now = Date.now()
			const optimisticUserMessage: ChatMessage = {
				id: `optimistic-u-${now}`,
				role: "user",
				content: text,
				images,
				timestamp: now,
			}
			const optimisticAssistantMessage: ChatMessage = {
				id: `optimistic-a-${now}`,
				role: "assistant",
				content: "",
				timestamp: now + 1,
				isStreaming: true,
			}

			if (session) {
				setSession({
					...session,
					messages: [...session.messages, optimisticUserMessage, optimisticAssistantMessage],
				})
			}

			setIsStreaming(true)

			if (!currentSessionId) {
				// Create session first
				vscode.postMessage({
					type: "chatCreateSession",
					text: text.slice(0, 40),
					chatModelPreference: {
						apiProvider: preferences?.apiProvider || "xkiro",
						modelId: preferences?.modelId || "openai/gpt-5.6-terra",
						reasoningEffort: preferences?.reasoningEffort || "medium",
						webSearchMode: webSearchMode || "auto",
					},
				})
				// The subsequent message send will follow upon chatSessionData event
			} else {
				vscode.postMessage({
					type: "chatSendMessage",
					chatSessionId: currentSessionId,
					text,
					images,
					chatDraft: { text: "", webSearchMode },
				})
			}

			// Scroll down
			setTimeout(() => {
				virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })
			}, 50)
		},
		[session, preferences],
	)

	const handleAbort = useCallback(() => {
		if (session?.id) {
			vscode.postMessage({
				type: "chatAbortStream",
				chatSessionId: session.id,
			})
		}
		setIsStreaming(false)
	}, [session])

	const handleRegenerate = useCallback(
		(messageId: string) => {
			if (session?.id) {
				setIsStreaming(true)
				vscode.postMessage({
					type: "chatRegenerateMessage",
					chatSessionId: session.id,
					chatMessageId: messageId,
				})
			}
		},
		[session],
	)

	const handleEditAndResend = useCallback(
		(messageId: string, newText: string) => {
			if (session?.id) {
				setIsStreaming(true)
				vscode.postMessage({
					type: "chatEditMessage",
					chatSessionId: session.id,
					chatMessageId: messageId,
					text: newText,
				})
			}
		},
		[session],
	)

	const handleModelPreferenceChange = useCallback(
		(pref: ChatModelPreference) => {
			if (session) {
				const updatedSession: ChatSession = {
					...session,
					modelPreference: pref,
				}
				setSession(updatedSession)
			}
			const newPreferences: ChatPreferences = {
				apiProvider: pref.apiProvider,
				modelId: pref.modelId,
				reasoningEffort: pref.reasoningEffort,
				webSearchMode: pref.webSearchMode,
				enabled: true,
			}
			setPreferences(newPreferences)
			vscode.postMessage({
				type: "chatSavePreferences",
				chatPreferences: newPreferences,
			})
		},
		[session],
	)

	const messages = session?.messages || []
	const hasMessages = messages.length > 0

	return (
		<div
			className={`native-chat-view flex flex-col h-full w-full bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden ${
				isHidden ? "hidden" : ""
			}`}>
			{/* Top Bar / Header */}
			<div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-canvas)] shrink-0 select-none">
				<div className="flex items-center gap-2 truncate">
					<div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--bg-hover)] border border-[var(--border-light)] text-[var(--text-secondary)] text-xs font-semibold tracking-tight shrink-0">
						<Sparkles className="w-3 h-3" />
						<span>{t("chat:nativeChat.aiChatBadge", "Czat AI")}</span>
					</div>
					<span className="text-xs font-medium text-[var(--text-primary)] truncate">
						{session?.title || t("chat:nativeChat.newChat", "Nowa rozmowa")}
					</span>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					<button
						type="button"
						onClick={handleCreateNewChat}
						className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
						title={t("chat:nativeChat.startNewChat", "Rozpocznij nową rozmowę")}>
						<MessageSquarePlus className="w-3.5 h-3.5" />
						<span>{t("chat:nativeChat.newChat", "Nowa rozmowa")}</span>
					</button>
				</div>
			</div>

			{/* Main Scrollable Conversation Area */}
			<div className="flex-1 min-h-0 relative">
				{!hasMessages ? (
					<NativeChatEmptyState onSelectStarter={(starter) => handleSend(starter)} />
				) : (
					<Virtuoso
						ref={virtuosoRef}
						data={messages}
						followOutput="auto"
						atBottomStateChange={(atBottom) => setShowScrollBottom(!atBottom)}
						itemContent={(index, msg) => (
							<NativeChatMessageRow
								key={msg.id || index}
								message={msg}
								isLastAssistantMessage={index === messages.length - 1 && msg.role === "assistant"}
								onRegenerate={handleRegenerate}
								onEditAndResend={handleEditAndResend}
							/>
						)}
						className="h-full w-full"
					/>
				)}

				{/* Floating Scroll to Bottom Button */}
				{showScrollBottom && hasMessages && (
					<button
						type="button"
						onClick={() => virtuosoRef.current?.scrollToIndex({ index: "LAST", behavior: "smooth" })}
						className="absolute bottom-4 right-6 p-2 rounded-full bg-[var(--bg-surface-elevated)] hover:bg-[var(--bg-active)] text-[var(--text-primary)] border border-[var(--border-light)] shadow-xl transition-all cursor-pointer z-20"
						title={t("chat:nativeChat.scrollToBottom", "Przejdź do najnowszej wiadomości")}>
						<ArrowDown className="w-4 h-4" />
					</button>
				)}
			</div>

			{/* Auto-growing Composer Fixed to Bottom */}
			<div className="shrink-0 bg-[var(--bg-canvas)]">
				<NativeChatComposer
					sessionId={session?.id}
					initialText={session?.draft?.text || ""}
					initialImages={session?.draft?.images || []}
					initialWebSearchMode={session?.draft?.webSearchMode || "auto"}
					modelPreference={
						session?.modelPreference || {
							apiProvider: preferences?.apiProvider || "xkiro",
							modelId: preferences?.modelId || "openai/gpt-5.6-terra",
							reasoningEffort: preferences?.reasoningEffort || "medium",
							webSearchMode: preferences?.webSearchMode || "auto",
						}
					}
					onModelPreferenceChange={handleModelPreferenceChange}
					isStreaming={isStreaming}
					onSend={handleSend}
					onAbort={handleAbort}
				/>
			</div>
		</div>
	)
}
