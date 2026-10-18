import React, { useCallback, useEffect, useRef, useState } from "react"
import { useEvent } from "react-use"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { type ExtensionMessage } from "@roo-code/types"

import TranslationProvider, { useAppTranslation } from "./i18n/TranslationContext"
import { vscode } from "./utils/vscode"
import { initializeSourceMaps, exposeSourceMapsForDebugging } from "./utils/sourceMapInitializer"
import { ExtensionStateContextProvider, useExtensionState } from "./context/ExtensionStateContext"
import ChatView, { ChatViewRef } from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import SettingsView, { SettingsViewRef } from "./components/settings/SettingsView"
import { openSettings } from "./utils/settingsNavigation"
import WelcomeView from "./components/welcome/WelcomeViewProvider"
import { CheckpointRestoreDialog } from "./components/chat/CheckpointRestoreDialog"
import { DeleteMessageDialog, EditMessageDialog } from "./components/chat/MessageModificationConfirmationDialog"
import ErrorBoundary from "./components/ErrorBoundary"
import { useAddNonInteractiveClickListener } from "./components/ui/hooks/useNonInteractiveClick"
import { TooltipProvider } from "./components/ui/tooltip"
import { STANDARD_TOOLTIP_DELAY } from "./components/ui/standard-tooltip"
import { NativeChatView } from "./components/native-chat/NativeChatView"

type Tab = "settings" | "history" | "chat" | "nativeChat"

interface DeleteMessageDialogState {
	isOpen: boolean
	messageTs: number
	hasCheckpoint: boolean
}

interface EditMessageDialogState {
	isOpen: boolean
	messageTs: number
	text: string
	hasCheckpoint: boolean
	images?: string[]
}

// Memoize dialog components to prevent unnecessary re-renders
const MemoizedDeleteMessageDialog = React.memo(DeleteMessageDialog)
const MemoizedEditMessageDialog = React.memo(EditMessageDialog)
const MemoizedCheckpointRestoreDialog = React.memo(CheckpointRestoreDialog)
const tabsByMessageAction: Partial<Record<NonNullable<ExtensionMessage["action"]>, Tab>> = {
	chatButtonClicked: "chat",
	settingsButtonClicked: "settings",
	historyButtonClicked: "history",
}

export const checkIsSettingsModalFrame = (): boolean => {
	if (typeof window === "undefined") return false
	return (
		window.name === "roo-settings-frame" ||
		(typeof window.location !== "undefined" && Boolean(window.location.search?.includes("view=settings")))
	)
}

export const checkIsDesktopHost = (): boolean => {
	if (typeof window === "undefined") return false
	return Boolean(
		(window as any).__ROO_DESKTOP__ ||
			(window.parent && (window.parent as any).__desktopAPI) ||
			(window as any).__desktopAPI ||
			(window.parent && window.parent !== window),
	)
}

const App = () => {
	useEffect(() => {
		if (!checkIsDesktopHost() || checkIsSettingsModalFrame()) return
		const shortcut = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase()
			if ((event.ctrlKey || event.metaKey) && !event.shiftKey && ["k", "o", "n", ",", "b"].includes(key)) {
				event.preventDefault()
				window.parent.postMessage({ type: "desktopShortcut", key }, "*")
			}
		}
		window.addEventListener("keydown", shortcut)
		return () => window.removeEventListener("keydown", shortcut)
	}, [])
	const { t } = useAppTranslation()
	const { didHydrateState, showWelcome, shouldShowAnnouncement, renderContext, theme } = useExtensionState()

	const [showAnnouncement, setShowAnnouncement] = useState(false)
	const [tab, setTab] = useState<Tab>("chat")
	const tabRef = useRef<Tab>("chat")
	tabRef.current = tab

	const [deleteMessageDialogState, setDeleteMessageDialogState] = useState<DeleteMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		hasCheckpoint: false,
	})

	const [editMessageDialogState, setEditMessageDialogState] = useState<EditMessageDialogState>({
		isOpen: false,
		messageTs: 0,
		text: "",
		hasCheckpoint: false,
		images: [],
	})

	const settingsRef = useRef<SettingsViewRef>(null)
	const chatViewRef = useRef<ChatViewRef>(null)

	const [currentSection, setCurrentSection] = useState<string | undefined>(undefined)
	const currentSectionRef = useRef<string | undefined>(undefined)
	currentSectionRef.current = currentSection

	const switchTab = useCallback((newTab: Tab, origin: "user" | "sync" = "user", section?: string) => {
		// Idempotency check: if tab and section are already active, do nothing
		if (tabRef.current === newTab && (section === undefined || section === currentSectionRef.current)) {
			return
		}

		const applySwitch = () => {
			setTab(newTab)
			tabRef.current = newTab
			if (section !== undefined) {
				setCurrentSection(section)
				currentSectionRef.current = section
			} else {
				setCurrentSection(undefined)
				currentSectionRef.current = undefined
			}
			// Only notify parent shell when initiated by user action within webview
			if (origin === "user") {
				window.parent?.postMessage({ type: "switchTab", tab: newTab, origin: "webview" }, "*")
			}
		}

		if (settingsRef.current?.checkUnsaveChanges) {
			settingsRef.current.checkUnsaveChanges(applySwitch)
		} else {
			applySwitch()
		}
	}, [])

	useEffect(() => {
		if (theme) {
			document.documentElement.setAttribute("data-theme", theme)
			document.body.setAttribute("data-theme", theme)
			const isLight = (theme as string) === "clean-light" || (theme as string) === "light"
			document.body.classList.toggle("vscode-light", isLight)
			document.body.classList.toggle("vscode-dark", !isLight)
		}
	}, [theme])

	const onMessage = useCallback(
		(e: MessageEvent) => {
			const message: ExtensionMessage = e.data

			if ((message as any)?.type === "themeChange") {
				const currentTheme = (message as any).theme
				if (currentTheme) {
					document.documentElement.setAttribute("data-theme", currentTheme)
					document.body.setAttribute("data-theme", currentTheme)
					const isLight = currentTheme === "clean-light" || currentTheme === "light"
					document.body.classList.toggle("vscode-light", isLight)
					document.body.classList.toggle("vscode-dark", !isLight)
				}
				return
			}

			if ((message as any)?.type === "openSettings") {
				const targetSection = (message as any).section || (message as any).values?.section
				if (checkIsDesktopHost() && !checkIsSettingsModalFrame()) {
					openSettings({ section: targetSection, source: "desktop_chat_event" })
					return
				}
				switchTab("settings", "sync", targetSection)
				return
			}

			if ((message as any)?.type === "switchTab" && (message as any).tab) {
				const targetTab = (message as any).tab as Tab
				const targetSection = (message as any).values?.section as string | undefined
				if (targetTab === "settings" && checkIsDesktopHost() && !checkIsSettingsModalFrame()) {
					openSettings({ section: targetSection, source: "desktop_chat_event" })
					return
				}
				switchTab(targetTab, "sync", targetSection)
				return
			}

			if (message.type === "action" && message.action) {
				// Handle switchTab action with tab parameter
				if (message.action === "switchTab" && message.tab) {
					const targetTab = message.tab as Tab
					const targetSection = message.values?.section as string | undefined
					if (targetTab === "settings" && checkIsDesktopHost() && !checkIsSettingsModalFrame()) {
						openSettings({ section: targetSection, source: "desktop_chat_event" })
						return
					}
					switchTab(targetTab, "sync", targetSection)
				} else {
					// Handle other actions using the mapping
					const newTab = tabsByMessageAction[message.action]
					const section = message.values?.section as string | undefined

					if (newTab === "settings" && checkIsDesktopHost() && !checkIsSettingsModalFrame()) {
						openSettings({ section, source: "desktop_chat_event" })
						return
					}

					if (newTab) {
						switchTab(newTab, "sync", section)
					}
				}
			}

			if (message.type === "showDeleteMessageDialog" && message.messageTs) {
				setDeleteMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					hasCheckpoint: message.hasCheckpoint || false,
				})
			}

			if (message.type === "showEditMessageDialog" && message.messageTs && message.text) {
				setEditMessageDialogState({
					isOpen: true,
					messageTs: message.messageTs,
					text: message.text,
					hasCheckpoint: message.hasCheckpoint || false,
					images: message.images || [],
				})
			}

			if (message.type === "acceptInput") {
				chatViewRef.current?.acceptInput()
			}
		},
		[switchTab],
	)

	useEvent("message", onMessage)

	useEffect(() => {
		if (shouldShowAnnouncement && tab === "chat") {
			setShowAnnouncement(true)
			vscode.postMessage({ type: "didShowAnnouncement" })
		}
	}, [shouldShowAnnouncement, tab])

	// Tell the extension that we are ready to receive messages.
	useEffect(() => vscode.postMessage({ type: "webviewDidLaunch" }), [])

	// Initialize source map support for better error reporting
	useEffect(() => {
		// Initialize source maps for better error reporting in production
		initializeSourceMaps()

		// Expose source map debugging utilities in production
		if (process.env.NODE_ENV === "production") {
			exposeSourceMapsForDebugging()
		}

		// Log initialization for debugging
		console.debug("App initialized with source map support")
	}, [])

	// Focus the WebView when non-interactive content is clicked (only in editor/tab mode)
	useAddNonInteractiveClickListener(
		useCallback(() => {
			// Only send focus request if we're in editor (tab) mode, not sidebar
			if (renderContext === "editor") {
				vscode.postMessage({ type: "focusPanelRequest" })
			}
		}, [renderContext]),
	)

	const [hydrationTimeout, setHydrationTimeout] = useState(false)

	useEffect(() => {
		if (didHydrateState) return
		const timer = setTimeout(() => {
			setHydrationTimeout(true)
		}, 3500)
		return () => clearTimeout(timer)
	}, [didHydrateState])

	if (!didHydrateState) {
		return (
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					height: "100vh",
					width: "100%",
					backgroundColor: "var(--vscode-editor-background, #090a0f)",
					color: "var(--vscode-foreground, #f2f4f7)",
					fontFamily:
						'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
					fontSize: "var(--vscode-font-size, 13px)",
					padding: "20px",
					boxSizing: "border-box",
					textAlign: "center",
					userSelect: "none",
				}}>
				<div
					style={{
						width: "32px",
						height: "32px",
						border: "3px solid rgba(255, 255, 255, 0.1)",
						borderTopColor: "var(--vscode-button-background, #3b82f6)",
						borderRadius: "50%",
						marginBottom: "16px",
						animation: "spin 0.8s linear infinite",
					}}
				/>
				<div style={{ fontSize: "14px", fontWeight: 500, marginBottom: "6px" }}>
					{t("common:loading.initializing", "Initializing Roo Code view...")}
				</div>
				{hydrationTimeout && (
					<div
						style={{
							marginTop: "12px",
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: "10px",
						}}>
						<p
							style={{
								fontSize: "12px",
								color: "var(--vscode-descriptionForeground, #98a2b3)",
								margin: 0,
								maxWidth: "360px",
								lineHeight: "1.4",
							}}>
							{t(
								"common:loading.slowResponse",
								"Waiting for engine response is taking longer than usual...",
							)}
						</p>
						<div style={{ display: "flex", gap: "8px" }}>
							<button
								type="button"
								onClick={() => vscode.postMessage({ type: "webviewDidLaunch" })}
								style={{
									padding: "6px 14px",
									fontSize: "12px",
									fontWeight: 500,
									backgroundColor: "var(--vscode-button-background, #2563eb)",
									color: "var(--vscode-button-foreground, #ffffff)",
									border: "none",
									borderRadius: "6px",
									cursor: "pointer",
								}}>
								{t("common:loading.sendReadySignal", "Send ready signal")}
							</button>
							<button
								type="button"
								onClick={() => window.location.reload()}
								style={{
									padding: "6px 14px",
									fontSize: "12px",
									fontWeight: 500,
									backgroundColor: "var(--vscode-button-secondaryBackground, #181b26)",
									color: "var(--vscode-button-secondaryForeground, #f2f4f7)",
									border: "1px solid rgba(255, 255, 255, 0.1)",
									borderRadius: "6px",
									cursor: "pointer",
								}}>
								{t("common:loading.refresh", "Refresh")}
							</button>
						</div>
					</div>
				)}
			</div>
		)
	}

	// Do not conditionally load ChatView, it's expensive and there's state we
	// don't want to lose (user input, disableInput, askResponse promise, etc.)
	return showWelcome ? (
		<WelcomeView />
	) : (
		<>
			{tab === "history" && <HistoryView onDone={() => switchTab("chat")} />}
			{tab === "settings" && (
				<SettingsView
					ref={settingsRef}
					onDone={() => {
						setTab("chat")
						window.parent?.postMessage({ type: "action", action: "chatButtonClicked" }, "*")
					}}
					targetSection={currentSection}
				/>
			)}
			<ChatView
				ref={chatViewRef}
				isHidden={tab !== "chat"}
				showAnnouncement={showAnnouncement}
				hideAnnouncement={() => setShowAnnouncement(false)}
			/>
			<NativeChatView isHidden={tab !== "nativeChat"} onSwitchToAgent={() => switchTab("chat")} />
			{deleteMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={deleteMessageDialogState.isOpen}
					type="delete"
					hasCheckpoint={deleteMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={(restoreCheckpoint: boolean) => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							messageTs: deleteMessageDialogState.messageTs,
							restoreCheckpoint,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			) : (
				<MemoizedDeleteMessageDialog
					open={deleteMessageDialogState.isOpen}
					onOpenChange={(open: boolean) => setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={() => {
						vscode.postMessage({
							type: "deleteMessageConfirm",
							messageTs: deleteMessageDialogState.messageTs,
						})
						setDeleteMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			)}
			{editMessageDialogState.hasCheckpoint ? (
				<MemoizedCheckpointRestoreDialog
					open={editMessageDialogState.isOpen}
					type="edit"
					hasCheckpoint={editMessageDialogState.hasCheckpoint}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={(restoreCheckpoint: boolean) => {
						vscode.postMessage({
							type: "editMessageConfirm",
							messageTs: editMessageDialogState.messageTs,
							text: editMessageDialogState.text,
							restoreCheckpoint,
						})
						setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			) : (
				<MemoizedEditMessageDialog
					open={editMessageDialogState.isOpen}
					onOpenChange={(open: boolean) => setEditMessageDialogState((prev) => ({ ...prev, isOpen: open }))}
					onConfirm={() => {
						vscode.postMessage({
							type: "editMessageConfirm",
							messageTs: editMessageDialogState.messageTs,
							text: editMessageDialogState.text,
							images: editMessageDialogState.images,
						})
						setEditMessageDialogState((prev) => ({ ...prev, isOpen: false }))
					}}
				/>
			)}
		</>
	)
}

const queryClient = new QueryClient()

const AppWithProviders = () => (
	<ErrorBoundary>
		<ExtensionStateContextProvider>
			<TranslationProvider>
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delayDuration={STANDARD_TOOLTIP_DELAY}>
						<App />
					</TooltipProvider>
				</QueryClientProvider>
			</TranslationProvider>
		</ExtensionStateContextProvider>
	</ErrorBoundary>
)

export default AppWithProviders
