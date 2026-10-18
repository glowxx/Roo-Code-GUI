import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useEvent } from "react-use"
import DynamicTextArea from "react-textarea-autosize"
import { VolumeX, WandSparkles, SendHorizontal, X, ListEnd, Square, Loader2 } from "lucide-react"

import { type ExtensionMessage, type Command, type WebSearchMode, getModelContextWindow } from "@roo-code/types"

import { mentionRegex, mentionRegexGlobal, commandRegexGlobal, unescapeSpaces } from "@roo/context-mentions"
import { WebviewMessage } from "@roo/WebviewMessage"
import { Mode, getAllModes } from "@roo/modes"

import { vscode } from "@src/utils/vscode"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import {
	ContextMenuOptionType,
	getContextMenuOptions,
	insertMention,
	removeMention,
	shouldShowContextMenu,
	SearchResult,
} from "@src/utils/context-mentions"
import { cn } from "@src/lib/utils"
import { convertToMentionPath } from "@src/utils/path-mentions"
import { StandardTooltip } from "@src/components/ui"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { getModelMaxOutputTokens } from "@roo/api"

import Thumbnails from "../common/Thumbnails"
import { ModeSelector } from "./ModeSelector"
import { ModelSelector } from "./ModelSelector"
import { ReasoningEffortButton } from "./ReasoningEffortButton"
import { AutoApproveDropdown } from "./AutoApproveDropdown"
import { WebSearchButton } from "./WebSearchButton"
import { MAX_IMAGES_PER_MESSAGE } from "./ChatView"
import ContextMenu from "./ContextMenu"
import { ProjectContext } from "./ProjectContext"
import { usePromptHistory } from "./hooks/usePromptHistory"
import { ContextWindowProgress } from "./ContextWindowProgress"

interface ChatTextAreaProps {
	inputValue: string
	setInputValue: (value: string) => void
	sendingDisabled: boolean
	selectApiConfigDisabled: boolean
	placeholderText: string
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	onSend: () => void
	onSelectImages: () => void
	shouldDisableImages: boolean
	onHeightChange?: (height: number) => void
	mode: Mode
	setMode: (mode: Mode) => void
	modeShortcutText: string
	// Edit mode props
	isEditMode?: boolean
	onCancel?: () => void
	// Stop/Queue functionality
	isStreaming?: boolean
	isTaskActive?: boolean
	isStopping?: boolean
	onStop?: () => void
	onEnqueueMessage?: () => void
	onResume?: () => void
	resumeButtonText?: string
	resumeButtonTooltip?: string
	contextTokens?: number
	webSearchMode?: WebSearchMode
	setWebSearchMode?: (mode: WebSearchMode) => void
}

export const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue,
			selectApiConfigDisabled,
			placeholderText,
			selectedImages,
			setSelectedImages,
			onSend,
			onSelectImages: _onSelectImages,
			shouldDisableImages,
			onHeightChange,
			mode,
			setMode,
			modeShortcutText,
			isEditMode = false,
			onCancel,
			isStreaming = false,
			isTaskActive = false,
			isStopping = false,
			onStop,
			onEnqueueMessage,
			onResume,
			resumeButtonText,
			resumeButtonTooltip,
			contextTokens = 0,
			webSearchMode = "auto",
			setWebSearchMode,
		},
		ref,
	) => {
		const { t } = useAppTranslation()
		const inputValueRef = useRef(inputValue)
		inputValueRef.current = inputValue
		const {
			filePaths,
			openedTabs,
			currentApiConfigName,
			listApiConfigMeta,
			customModes,
			customModePrompts,
			cwd,
			pinnedApiConfigs,
			togglePinnedApiConfig,
			taskHistory,
			clineMessages,
			commands,
			enterBehavior,
			lockApiConfigAcrossModes,
			apiConfiguration,
			openAiModelInfos,
			currentTaskItem,
		} = useExtensionState()

		const { id: selectedModelId, info: selectedModelInfo } = useSelectedModel(apiConfiguration, openAiModelInfos)
		const activeExecutionModelId = isStreaming ? currentTaskItem?.executionModelId : undefined
		const modelId = activeExecutionModelId || selectedModelId
		const model =
			activeExecutionModelId && activeExecutionModelId !== selectedModelId
				? openAiModelInfos?.[activeExecutionModelId] || selectedModelInfo
				: selectedModelInfo
		const customContextOverride =
			(apiConfiguration as any)?.xkiroCustomContextWindow || (apiConfiguration as any)?.customContextWindow
		const contextWindow = customContextOverride || model?.contextWindow || getModelContextWindow(modelId)
		const maxTokens = useMemo(
			() =>
				model
					? getModelMaxOutputTokens({
							modelId,
							model,
							settings: apiConfiguration,
						})
					: 0,
			[model, modelId, apiConfiguration],
		)

		// Find the ID and display text for the currently selected API configuration.
		const { currentConfigId, displayName } = useMemo(() => {
			const currentConfig = listApiConfigMeta?.find((config) => config.name === currentApiConfigName)
			return {
				currentConfigId: currentConfig?.id || "",
				displayName: currentApiConfigName || "", // Use the name directly for display.
			}
		}, [listApiConfigMeta, currentApiConfigName])

		const effectiveCommands = useMemo<Command[]>(() => {
			const base = commands ? [...commands] : []
			if (!base.some((cmd) => cmd.name === "compact")) {
				base.push({
					name: "compact",
					description: "Compress conversation history and reclaim context tokens",
					source: "built-in",
				} as Command)
			}
			return base
		}, [commands])

		const [gitCommits, setGitCommits] = useState<any[]>([])
		const [showDropdown, setShowDropdown] = useState(false)
		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
		const [searchLoading, setSearchLoading] = useState(false)
		const [searchRequestId, setSearchRequestId] = useState<string>("")

		// Close dropdown when clicking outside.
		useEffect(() => {
			const handleClickOutside = () => {
				if (showDropdown) {
					setShowDropdown(false)
				}
			}

			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}, [showDropdown])

		// Handle enhanced prompt response and search results.
		useEffect(() => {
			const messageHandler = (event: MessageEvent) => {
				const message = event.data

				if (message.type === "enhancedPrompt") {
					if (message.text && textAreaRef.current) {
						try {
							// Use execCommand to replace text while preserving undo history
							if (document.execCommand) {
								// Use native browser methods to preserve undo stack
								const textarea = textAreaRef.current

								// Focus the textarea to ensure it's the active element
								textarea.focus({ preventScroll: true })

								// Select all text first
								textarea.select()
								document.execCommand("insertText", false, message.text)
							} else {
								setInputValue(message.text)
							}
						} catch {
							setInputValue(message.text)
						}
					}

					setIsEnhancingPrompt(false)
				} else if (message.type === "insertTextIntoTextarea") {
					if (message.text && textAreaRef.current) {
						// Insert the command text at the current cursor position
						const textarea = textAreaRef.current
						const currentValue = inputValueRef.current
						const cursorPos = textarea.selectionStart || 0

						// Check if we need to add a space before the command
						const textBefore = currentValue.slice(0, cursorPos)
						const needsSpaceBefore = textBefore.length > 0 && !textBefore.endsWith(" ")
						const prefix = needsSpaceBefore ? " " : ""

						// Insert the text at cursor position
						const newValue =
							currentValue.slice(0, cursorPos) +
							prefix +
							message.text +
							" " +
							currentValue.slice(cursorPos)
						setInputValue(newValue)

						// Set cursor position after the inserted text
						const newCursorPos = cursorPos + prefix.length + message.text.length + 1
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.focus({ preventScroll: true })
								textAreaRef.current.setSelectionRange(newCursorPos, newCursorPos)
							}
						}, 0)
					}
				} else if (message.type === "commitSearchResults") {
					const commits = message.commits.map((commit: any) => ({
						type: ContextMenuOptionType.Git,
						value: commit.hash,
						label: commit.subject,
						description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
						icon: "$(git-commit)",
					}))

					setGitCommits(commits)
				} else if (message.type === "fileSearchResults") {
					setSearchLoading(false)
					if (message.requestId === searchRequestId) {
						setFileSearchResults(message.results || [])
					}
				}
			}

			window.addEventListener("message", messageHandler)
			return () => window.removeEventListener("message", messageHandler)
		}, [setInputValue, searchRequestId])

		const [isDraggingOver, setIsDraggingOver] = useState(false)
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
		const [showContextMenu, setShowContextMenu] = useState(false)
		const [cursorPosition, setCursorPosition] = useState(0)
		const [searchQuery, setSearchQuery] = useState("")
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)
		const [isEnhancingPrompt, setIsEnhancingPrompt] = useState(false)
		const [isFocused, setIsFocused] = useState(false)

		useEffect(() => {
			if (isEditMode && textAreaRef.current) {
				textAreaRef.current.focus({ preventScroll: true })
			}
		}, [isEditMode])

		const isStopMode = (isStreaming || isTaskActive || isStopping) && !isEditMode

		// Use custom hook for prompt history navigation
		const { handleHistoryNavigation, resetHistoryNavigation, resetOnInputChange } = usePromptHistory({
			clineMessages,
			taskHistory,
			cwd,
			inputValue,
			setInputValue,
		})

		// Fetch git commits when Git is selected or when typing a hash.
		useEffect(() => {
			if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
				const message: WebviewMessage = {
					type: "searchCommits",
					query: searchQuery || "",
				} as const
				vscode.postMessage(message)
			}
		}, [selectedType, searchQuery])

		const handleEnhancePrompt = useCallback(() => {
			const trimmedInput = inputValue.trim()

			if (trimmedInput) {
				setIsEnhancingPrompt(true)
				vscode.postMessage({ type: "enhancePrompt" as const, text: trimmedInput })
			} else {
				setInputValue(t("chat:enhancePromptDescription"))
			}
		}, [inputValue, setInputValue, t])

		const allModes = useMemo(() => getAllModes(customModes), [customModes])

		// Memoized check for whether the input has content (text or images)
		const hasInputContent = useMemo(() => {
			return inputValue.trim().length > 0 || selectedImages.length > 0
		}, [inputValue, selectedImages])

		// Compute the key combination text for the send button tooltip based on enterBehavior
		const sendKeyCombination = useMemo(() => {
			if (enterBehavior === "newline") {
				// When Enter = newline, Ctrl/Cmd+Enter sends
				const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0
				return isMac ? "⌘+Enter" : "Ctrl+Enter"
			}
			// Default: Enter sends
			return "Enter"
		}, [enterBehavior])

		const queryItems = useMemo(() => {
			return [
				{ type: ContextMenuOptionType.Problems, value: "problems" },
				{ type: ContextMenuOptionType.Terminal, value: "terminal" },
				...gitCommits,
				...openedTabs
					.filter((tab) => tab.path)
					.map((tab) => ({
						type: ContextMenuOptionType.OpenedFile,
						value: "/" + tab.path,
					})),
				...filePaths
					.map((file) => "/" + file)
					.filter((path) => !openedTabs.some((tab) => tab.path && "/" + tab.path === path)) // Filter out paths that are already in openedTabs
					.map((path) => ({
						type: path.endsWith("/") ? ContextMenuOptionType.Folder : ContextMenuOptionType.File,
						value: path,
					})),
			]
		}, [filePaths, gitCommits, openedTabs])

		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (
					contextMenuContainerRef.current &&
					!contextMenuContainerRef.current.contains(event.target as Node)
				) {
					setShowContextMenu(false)
				}
			}

			if (showContextMenu) {
				document.addEventListener("mousedown", handleClickOutside)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside)
			}
		}, [showContextMenu, setShowContextMenu])

		const handleMentionSelect = useCallback(
			(type: ContextMenuOptionType, value?: string) => {
				if (type === ContextMenuOptionType.NoResults) {
					return
				}

				if (type === ContextMenuOptionType.Mode && value) {
					// Handle mode selection.
					setMode(value)
					vscode.postMessage({ type: "mode", text: value })
				}

				if (
					type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git
				) {
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)
						return
					}
				}

				setShowContextMenu(false)
				setSelectedType(null)
				setSelectedMenuIndex(-1)

				const currentText = textAreaRef.current ? textAreaRef.current.value : inputValue
				let insertValue = value || ""

				if (type === ContextMenuOptionType.URL) {
					insertValue = value || ""
				} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
					insertValue = value || ""
				} else if (type === ContextMenuOptionType.Problems) {
					insertValue = "problems"
				} else if (type === ContextMenuOptionType.Terminal) {
					insertValue = "terminal"
				} else if (type === ContextMenuOptionType.Git) {
					insertValue = value || ""
				} else if (type === ContextMenuOptionType.Command || type === ContextMenuOptionType.Mode) {
					insertValue = value || ""
				}

				// Determine if this is a slash command selection
				const isSlashCommand = type === ContextMenuOptionType.Mode || type === ContextMenuOptionType.Command

				const { newValue, mentionIndex } = insertMention(
					currentText,
					cursorPosition,
					insertValue,
					isSlashCommand,
				)

				setInputValue(newValue)
				const command = (insertValue.startsWith("/") ? insertValue : `/${insertValue}`).trimEnd() + " "
				const newCursorPosition = isSlashCommand
					? mentionIndex + command.length
					: newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
				setCursorPosition(newCursorPosition)
				setIntendedCursorPosition(newCursorPosition)

				// Scroll to cursor.
				setTimeout(() => {
					if (textAreaRef.current) {
						textAreaRef.current.blur()
						textAreaRef.current.focus({ preventScroll: true })
					}
				}, 0)
			},
			[setMode, setInputValue, cursorPosition, inputValue],
		)

		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (showContextMenu) {
					if (event.key === "Escape") {
						setSelectedType(null)
						setSelectedMenuIndex(3) // File by default
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedMenuIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const options = getContextMenuOptions(
								searchQuery,
								selectedType,
								queryItems,
								fileSearchResults,
								allModes,
								effectiveCommands,
							)
							const optionsLength = options.length

							if (optionsLength === 0) return prevIndex

							// Find selectable options (non-URL types)
							const selectableOptions = options.filter(
								(option) =>
									option.type !== ContextMenuOptionType.URL &&
									option.type !== ContextMenuOptionType.NoResults &&
									option.type !== ContextMenuOptionType.SectionHeader,
							)

							if (selectableOptions.length === 0) return -1 // No selectable options

							// Find the index of the next selectable option
							const currentSelectableIndex = selectableOptions.findIndex(
								(option) => option === options[prevIndex],
							)

							const newSelectableIndex =
								(currentSelectableIndex + direction + selectableOptions.length) %
								selectableOptions.length

							// Find the index of the selected option in the original options array
							return options.findIndex((option) => option === selectableOptions[newSelectableIndex])
						})
						return
					}
					if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
						event.preventDefault()
						const selectedOption = getContextMenuOptions(
							searchQuery,
							selectedType,
							queryItems,
							fileSearchResults,
							allModes,
							effectiveCommands,
						)[selectedMenuIndex]
						if (
							selectedOption &&
							selectedOption.type !== ContextMenuOptionType.URL &&
							selectedOption.type !== ContextMenuOptionType.NoResults &&
							selectedOption.type !== ContextMenuOptionType.SectionHeader
						) {
							handleMentionSelect(selectedOption.type, selectedOption.value)
						}
						return
					}
				}

				const isComposing = event.nativeEvent?.isComposing ?? false

				// Handle prompt history navigation using custom hook
				if (handleHistoryNavigation(event, showContextMenu, isComposing)) {
					return
				}

				// Handle Enter key based on enterBehavior setting
				if (event.key === "Enter" && !isComposing) {
					if (enterBehavior === "newline") {
						// New behavior: Enter = newline, Shift+Enter or Ctrl+Enter = send
						if (event.shiftKey || event.ctrlKey || event.metaKey) {
							event.preventDefault()
							resetHistoryNavigation()
							onSend()
						}
						// Otherwise, let Enter create newline (don't preventDefault)
					} else {
						// Default behavior: Enter = send, Shift+Enter = newline
						if (!event.shiftKey) {
							event.preventDefault()
							resetHistoryNavigation()
							onSend()
						}
					}
				}

				if (event.key === "Backspace" && !isComposing) {
					const charBeforeCursor = inputValue[cursorPosition - 1]
					const charAfterCursor = inputValue[cursorPosition + 1]

					const charBeforeIsWhitespace =
						charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"

					const charAfterIsWhitespace =
						charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

					// Checks if char before cursor is whitespace after a mention.
					if (
						charBeforeIsWhitespace &&
						// "$" is added to ensure the match occurs at the end of the string.
						inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
					) {
						const newCursorPosition = cursorPosition - 1
						// If mention is followed by another word, then instead
						// of deleting the space separating them we just move
						// the cursor to the end of the mention.
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}

						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterMention(true)
					} else if (justDeletedSpaceAfterMention) {
						const { newText, newPosition } = removeMention(inputValue, cursorPosition)

						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition) // Store the new cursor position in state
						}

						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					} else {
						setJustDeletedSpaceAfterMention(false)
					}
				}
			},
			[
				onSend,
				showContextMenu,
				searchQuery,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				setInputValue,
				justDeletedSpaceAfterMention,
				queryItems,
				allModes,
				fileSearchResults,
				handleHistoryNavigation,
				resetHistoryNavigation,
				effectiveCommands,
				enterBehavior,
			],
		)

		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // Reset the state.
			}
		}, [inputValue, intendedCursorPosition])

		// Ref to store the search timeout.
		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				setInputValue(newValue)

				// Reset history navigation when user types
				resetOnInputChange()

				const newCursorPosition = e.target.selectionStart
				setCursorPosition(newCursorPosition)

				const showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				setShowContextMenu(showMenu)

				if (showMenu) {
					const beforeCursor = newValue.slice(0, newCursorPosition)
					const slashMatch = beforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9_-]*)$/)

					if (slashMatch) {
						// Handle slash command - request fresh commands
						const query = `/${slashMatch[1]}`
						setSearchQuery(query)
						// Set to first selectable item (skip section headers)
						setSelectedMenuIndex(1) // Section header is at 0, first command is at 1
						// Request commands fresh each time slash menu is shown
						vscode.postMessage({ type: "requestCommands" })
					} else {
						// Existing @ mention handling.
						const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
						const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
						setSearchQuery(query)

						// Send file search request if query is not empty.
						if (query.length > 0) {
							setSelectedMenuIndex(0)

							// Don't clear results until we have new ones. This
							// prevents flickering.

							// Clear any existing timeout.
							if (searchTimeoutRef.current) {
								clearTimeout(searchTimeoutRef.current)
							}

							// Set a timeout to debounce the search requests.
							searchTimeoutRef.current = setTimeout(() => {
								// Generate a request ID for this search.
								const reqId = Math.random().toString(36).substring(2, 9)
								setSearchRequestId(reqId)
								setSearchLoading(true)

								// Send message to extension to search files.
								vscode.postMessage({
									type: "searchFiles",
									query: unescapeSpaces(query),
									requestId: reqId,
								})
							}, 200) // 200ms debounce.
						} else {
							setSelectedMenuIndex(3) // Set to "File" option by default.
						}
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([]) // Clear file search results.
				}
			},
			[setInputValue, setSearchRequestId, setFileSearchResults, setSearchLoading, resetOnInputChange],
		)

		useEffect(() => {
			if (!showContextMenu) {
				setSelectedType(null)
			}
		}, [showContextMenu])

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it.
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
			}

			setIsFocused(false)
		}, [isMouseDownOnMenu])

		const handlePaste = useCallback(
			async (e: React.ClipboardEvent) => {
				const items = e.clipboardData.items

				const pastedText = e.clipboardData.getData("text")
				// Check if the pasted content is a URL, add space after so user
				// can easily delete if they don't want it.
				const urlRegex = /^\S+:\/\/\S+$/
				if (urlRegex.test(pastedText.trim())) {
					e.preventDefault()
					const trimmedUrl = pastedText.trim()
					const newValue =
						inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition)
					setInputValue(newValue)
					const newCursorPosition = cursorPosition + trimmedUrl.length + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)
					setShowContextMenu(false)

					// Scroll to new cursor position.
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus({ preventScroll: true })
						}
					}, 0)

					return
				}

				const acceptedTypes = ["png", "jpeg", "webp"]

				const imageItems = Array.from(items).filter((item) => {
					const [type, subtype] = item.type.split("/")
					return type === "image" && acceptedTypes.includes(subtype)
				})

				if (!shouldDisableImages && imageItems.length > 0) {
					e.preventDefault()

					const imagePromises = imageItems.map((item) => {
						return new Promise<string | null>((resolve) => {
							const blob = item.getAsFile()

							if (!blob) {
								resolve(null)
								return
							}

							const reader = new FileReader()

							reader.onloadend = () => {
								if (reader.error) {
									console.error(t("chat:errorReadingFile"), reader.error)
									resolve(null)
								} else {
									const result = reader.result
									resolve(typeof result === "string" ? result : null)
								}
							}

							reader.readAsDataURL(blob)
						})
					})

					const imageDataArray = await Promise.all(imagePromises)
					const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

					if (dataUrls.length > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE))
					} else {
						console.warn(t("chat:noValidImages"))
					}
				}
			},
			[shouldDisableImages, setSelectedImages, cursorPosition, setInputValue, inputValue, t],
		)

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		const updateHighlights = useCallback(() => {
			if (!textAreaRef.current || !highlightLayerRef.current) return

			const text = textAreaRef.current.value

			// Helper function to check if a command is valid
			const findCommand = (commandName: string): Command | undefined =>
				effectiveCommands?.find((cmd) => cmd.name === commandName)

			// Process the text to highlight mentions and valid commands
			let processedText = text
				.replace(/\n$/, "\n\n")
				.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
				.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

			// Custom replacement for commands - only highlight valid ones
			processedText = processedText.replace(commandRegexGlobal, (match, commandName) => {
				// Only highlight if the command exists in the valid commands list
				const command = findCommand(commandName)
				if (command) {
					const leadingWhitespace = match.match(/^\s/)?.[0] || ""
					const commandPart = `/${commandName}`
					const className =
						command.source === "built-in"
							? "mention-context-textarea-highlight"
							: "mention-context-textarea-highlight skill-command-textarea-highlight"

					return `${leadingWhitespace}<mark class="${className}">${commandPart}</mark>`
				}
				return match // Return unhighlighted if command is not valid
			})

			highlightLayerRef.current.innerHTML = processedText

			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [effectiveCommands])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
			}
		}, [])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (
					["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(
						e.key,
					)
				) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		const handleDrop = useCallback(
			async (e: React.DragEvent<HTMLDivElement>) => {
				e.preventDefault()
				setIsDraggingOver(false)

				const textFieldList = e.dataTransfer.getData("text")
				const textUriList = e.dataTransfer.getData("application/vnd.code.uri-list")
				// When textFieldList is empty, it may attempt to use textUriList obtained from drag-and-drop tabs; if not empty, it will use textFieldList.
				const text = textFieldList || textUriList
				if (text) {
					// Split text on newlines to handle multiple files
					const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "")

					if (lines.length > 0) {
						// Process each line as a separate file path
						let newValue = inputValue.slice(0, cursorPosition)
						let totalLength = 0

						// Using a standard for loop instead of forEach for potential performance gains.
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i]
							// Convert each path to a mention-friendly format
							const mentionText = convertToMentionPath(line, cwd)
							newValue += mentionText
							totalLength += mentionText.length

							// Add space after each mention except the last one
							if (i < lines.length - 1) {
								newValue += " "
								totalLength += 1
							}
						}

						// Add space after the last mention and append the rest of the input
						newValue += " " + inputValue.slice(cursorPosition)
						totalLength += 1

						setInputValue(newValue)
						const newCursorPosition = cursorPosition + totalLength
						setCursorPosition(newCursorPosition)
						setIntendedCursorPosition(newCursorPosition)
					}

					return
				}

				const files = Array.from(e.dataTransfer.files)

				if (files.length > 0) {
					const acceptedTypes = ["png", "jpeg", "webp"]

					const imageFiles = files.filter((file) => {
						const [type, subtype] = file.type.split("/")
						return type === "image" && acceptedTypes.includes(subtype)
					})

					if (!shouldDisableImages && imageFiles.length > 0) {
						const imagePromises = imageFiles.map((file) => {
							return new Promise<string | null>((resolve) => {
								const reader = new FileReader()

								reader.onloadend = () => {
									if (reader.error) {
										console.error(t("chat:errorReadingFile"), reader.error)
										resolve(null)
									} else {
										const result = reader.result
										resolve(typeof result === "string" ? result : null)
									}
								}

								reader.readAsDataURL(file)
							})
						})

						const imageDataArray = await Promise.all(imagePromises)
						const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

						if (dataUrls.length > 0) {
							setSelectedImages((prevImages) =>
								[...prevImages, ...dataUrls].slice(0, MAX_IMAGES_PER_MESSAGE),
							)

							if (typeof vscode !== "undefined") {
								vscode.postMessage({ type: "draggedImages", dataUrls: dataUrls })
							}
						} else {
							console.warn(t("chat:noValidImages"))
						}
					}
				}
			},
			[
				cursorPosition,
				cwd,
				inputValue,
				setInputValue,
				setCursorPosition,
				setIntendedCursorPosition,
				shouldDisableImages,
				setSelectedImages,
				t,
			],
		)

		const [isTtsPlaying, setIsTtsPlaying] = useState(false)

		const handleTtsMessage = useCallback((event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "ttsStart") {
				setIsTtsPlaying(true)
			} else if (message.type === "ttsStop") {
				setIsTtsPlaying(false)
			}
		}, [])

		useEvent("message", handleTtsMessage)

		const handleStopTts = useCallback(() => {
			vscode.postMessage({ type: "stopTts" })
		}, [])

		const placeholderBottomText = t("chat:composerHint", { defaultValue: "Enter — send · Shift+Enter — new line" })

		// Common mode selector handler
		const handleModeChange = useCallback(
			(value: Mode) => {
				setMode(value)
				vscode.postMessage({ type: "mode", text: value })
			},
			[setMode],
		)

		// Helper function to handle API config change
		const handleApiConfigChange = useCallback((value: string) => {
			vscode.postMessage({ type: "loadApiConfigurationById", text: value })
		}, [])

		const handleToggleLockApiConfig = useCallback(() => {
			const newValue = !lockApiConfigAcrossModes
			vscode.postMessage({ type: "lockApiConfigAcrossModes", bool: newValue })
		}, [lockApiConfigAcrossModes])

		return (
			<div
				className={cn(
					"flex flex-col gap-1 bg-editor-background outline-none border border-none box-border",
					isEditMode ? "p-2 w-full" : "agent-composer relative w-full canvas-narrative",
				)}>
				<div className={cn(!isEditMode && "relative")}>
					<div
						className={cn("chat-text-area", !isEditMode && "relative", "flex", "flex-col", "outline-none")}
						onDrop={handleDrop}
						onDragOver={(e) => {
							// Only allowed to drop images/files on shift key pressed.
							if (!e.shiftKey) {
								setIsDraggingOver(false)
								return
							}

							e.preventDefault()
							setIsDraggingOver(true)
							e.dataTransfer.dropEffect = "copy"
						}}
						onDragLeave={(e) => {
							e.preventDefault()
							const rect = e.currentTarget.getBoundingClientRect()

							if (
								e.clientX <= rect.left ||
								e.clientX >= rect.right ||
								e.clientY <= rect.top ||
								e.clientY >= rect.bottom
							) {
								setIsDraggingOver(false)
							}
						}}>
						{showContextMenu && (
							<div
								ref={contextMenuContainerRef}
								className={cn(
									"absolute",
									"bottom-full",
									isEditMode ? "left-6" : "left-0",
									"right-0",
									"z-[1000]",
									isEditMode ? "-mb-3" : "mb-2",
									"filter",
									"drop-shadow-md",
								)}>
								<ContextMenu
									onSelect={handleMentionSelect}
									searchQuery={searchQuery}
									inputValue={inputValue}
									onMouseDown={handleMenuMouseDown}
									selectedIndex={selectedMenuIndex}
									setSelectedIndex={setSelectedMenuIndex}
									selectedType={selectedType}
									queryItems={queryItems}
									modes={allModes}
									loading={searchLoading}
									dynamicSearchResults={fileSearchResults}
									commands={effectiveCommands}
								/>
							</div>
						)}

						<div
							className={cn(
								"relative",
								"flex-1",
								"flex",
								"flex-col-reverse",
								"min-h-0",
								"overflow-hidden",
								"rounded-lg",
							)}>
							<div
								ref={highlightLayerRef}
								data-testid="highlight-layer"
								className={cn(
									"absolute",
									"inset-0",
									"pointer-events-none",
									"whitespace-pre-wrap",
									"break-words",
									"text-transparent",
									"overflow-hidden",
									"font-display",
									"text-base",
									"leading-normal",
									"tracking-normal",
									"border border-transparent",
									"py-2 pl-2",
									isEditMode ? "pr-20" : "pr-24",
									"box-border",
									"m-0",
									"z-10",
									"forced-color-adjust-none",
									"rounded-lg",
									"max-h-[min(200px,38vh)]",
								)}
								style={{
									fontFamily: "var(--vscode-font-family)",
									fontSize: "var(--vscode-font-size)",
									lineHeight: "1.5",
									letterSpacing: "normal",
									border: "1px solid transparent",
									color: "transparent",
									maxHeight: "min(200px, 38vh)",
								}}
							/>
							<DynamicTextArea
								ref={(el) => {
									if (typeof ref === "function") {
										ref(el)
									} else if (ref) {
										ref.current = el
									}
									textAreaRef.current = el
								}}
								value={inputValue}
								onChange={(e) => {
									handleInputChange(e)
									updateHighlights()
								}}
								onFocus={() => setIsFocused(true)}
								onKeyDown={(e) => {
									// Handle ESC to cancel in edit mode
									if (isEditMode && e.key === "Escape" && !e.nativeEvent?.isComposing) {
										e.preventDefault()
										onCancel?.()
										return
									}
									handleKeyDown(e)
								}}
								onKeyUp={handleKeyUp}
								onBlur={handleBlur}
								onPaste={handlePaste}
								onSelect={updateCursorPosition}
								onMouseUp={updateCursorPosition}
								onWheel={(e) => {
									const el = e.currentTarget
									if (el.scrollHeight > el.clientHeight) {
										e.stopPropagation()
									}
								}}
								onHeightChange={(height) => {
									if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
										setTextAreaBaseHeight(height)
									}

									onHeightChange?.(height)
								}}
								placeholder={placeholderText}
								minRows={3}
								maxRows={8}
								autoFocus={!isEditMode}
								className={cn(
									"w-full",
									"text-vscode-input-foreground",
									"font-display",
									"text-base",
									"leading-normal",
									"tracking-normal",
									"cursor-text",
									"py-2 pl-2",
									isFocused
										? "border border-vscode-focusBorder outline outline-vscode-focusBorder"
										: isDraggingOver
											? "border border-dashed border-vscode-focusBorder"
											: "border border-transparent",
									isDraggingOver
										? "bg-[color-mix(in_srgb,var(--vscode-input-background)_95%,var(--vscode-focusBorder))]"
										: "bg-vscode-input-background",
									"transition-background-color duration-150 ease-in-out",
									"will-change-background-color",
									"min-h-[94px]",
									"max-h-[min(200px,38vh)]",
									"box-border",
									"m-0",
									"rounded-lg",
									"resize-none",
									"overflow-x-hidden",
									"overflow-y-auto",
									"overscroll-contain",
									"whitespace-pre-wrap",
									"break-words",
									isEditMode ? "pr-20" : "pr-24",
									"flex-none flex-grow",
									"z-[2]",
								)}
								style={{
									fontFamily: "var(--vscode-font-family)",
									fontSize: "var(--vscode-font-size)",
									lineHeight: "1.5",
									letterSpacing: "normal",
								}}
								onScroll={() => updateHighlights()}
							/>

							<div className="absolute bottom-2 right-2 z-30 flex items-center gap-1.5">
								{isEditMode ? (
									<StandardTooltip content={t("chat:cancel.title")}>
										<button
											aria-label={t("chat:cancel.title")}
											disabled={false}
											onClick={onCancel}
											className={cn(
												"relative inline-flex items-center justify-center",
												"w-7 h-7 p-1.5 rounded-md",
												"bg-transparent border-none cursor-pointer",
												"text-vscode-descriptionForeground hover:text-vscode-foreground",
												"hover:bg-[rgba(255,255,255,0.06)] active:bg-[rgba(255,255,255,0.12)]",
												"transition-colors duration-150",
												"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											)}>
											<X className="w-4 h-4" />
										</button>
									</StandardTooltip>
								) : (
									<StandardTooltip content={t("chat:enhancePrompt")}>
										<button
											aria-label={t("chat:enhancePrompt")}
											disabled={false}
											onClick={handleEnhancePrompt}
											className={cn(
												"relative inline-flex items-center justify-center",
												"w-7 h-7 p-1.5 rounded-md",
												"bg-transparent border-none cursor-pointer",
												"text-vscode-descriptionForeground hover:text-vscode-foreground",
												"transition-all duration-150",
												hasInputContent
													? "opacity-60 hover:opacity-100 pointer-events-auto"
													: "opacity-0 pointer-events-none",
												"hover:bg-[rgba(255,255,255,0.06)] active:bg-[rgba(255,255,255,0.12)]",
												"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											)}>
											<WandSparkles
												className={cn("w-4 h-4", isEnhancingPrompt && "animate-spin")}
											/>
										</button>
									</StandardTooltip>
								)}
								{/* Queue button - shown when streaming and user has typed content */}
								{!isEditMode && isStreaming && hasInputContent && onEnqueueMessage && (
									<StandardTooltip content={t("chat:enqueueMessage")}>
										<button
											aria-label={t("chat:enqueueMessage")}
											disabled={false}
											onClick={onEnqueueMessage}
											className={cn(
												"relative inline-flex items-center justify-center",
												"w-7 h-7 p-1.5 rounded-md",
												"bg-transparent border-none cursor-pointer",
												"text-vscode-descriptionForeground hover:text-vscode-foreground",
												"hover:bg-[rgba(255,255,255,0.06)] active:bg-[rgba(255,255,255,0.12)]",
												"transition-colors duration-150",
												"opacity-100 hover:opacity-100 pointer-events-auto",
												"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
											)}>
											<ListEnd className="w-4 h-4" />
										</button>
									</StandardTooltip>
								)}
								{/* Discrete inline Resume button for paused/resumable tasks */}
								{onResume &&
									!hasInputContent &&
									!isStreaming &&
									!isStopMode &&
									!isTaskActive &&
									!isStopping && (
										<StandardTooltip content={resumeButtonTooltip || t("chat:resumeTask.tooltip")}>
											<button
												aria-label={resumeButtonText || t("chat:resumeTask.title")}
												type="button"
												disabled={false}
												onClick={onResume}
												className={cn(
													"relative inline-flex items-center justify-center gap-1",
													"h-7 px-2 rounded-md",
													"bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground",
													"border-none cursor-pointer text-xs font-medium",
													"transition-all duration-150",
													"opacity-100 hover:opacity-100 pointer-events-auto",
													"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
												)}>
												<span className="codicon codicon-play text-xs" />
												<span>{resumeButtonText || t("chat:resumeTask.title")}</span>
											</button>
										</StandardTooltip>
									)}
								{/* Send/Stop button - morphs based on streaming/active state, always visible in edit mode */}
								{(() => {
									return (
										<StandardTooltip
											content={
												isEditMode
													? t("chat:pressToSend", { keyCombination: sendKeyCombination })
													: isStopping
														? t("chat:stopping.title", "Stopping task...")
														: isStopMode
															? t("chat:stop.title")
															: t("chat:pressToSend", {
																	keyCombination: sendKeyCombination,
																})
											}>
											<button
												aria-label={
													isEditMode
														? t("chat:pressToSend", { keyCombination: sendKeyCombination })
														: isStopping
															? t("chat:stopping.title", "Stopping task...")
															: isStopMode
																? t("chat:stop.title")
																: t("chat:pressToSend", {
																		keyCombination: sendKeyCombination,
																	})
												}
												disabled={isStopping}
												onClick={isStopMode ? onStop : onSend}
												data-composer-stop={isStopMode}
												className={cn(
													"relative inline-flex items-center justify-center",
													"w-7 h-7 p-1.5 rounded-md",
													"border-none cursor-pointer",
													"transition-all duration-150",
													isStopMode
														? "bg-vscode-button-background hover:bg-vscode-button-hoverBackground text-vscode-button-foreground opacity-100 pointer-events-auto"
														: cn(
																"bg-transparent text-vscode-descriptionForeground hover:text-vscode-foreground",
																"hover:bg-[rgba(255,255,255,0.06)] active:bg-[rgba(255,255,255,0.12)]",
																isEditMode || hasInputContent
																	? "opacity-100 hover:opacity-100 pointer-events-auto"
																	: "opacity-0 pointer-events-none",
															),
													"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
												)}>
												{isStopping ? (
													<Loader2 className="w-4 h-4 animate-spin text-vscode-button-foreground" />
												) : isStopMode ? (
													<Square className="w-4 h-4 stroke-none fill-vscode-button-foreground" />
												) : (
													<SendHorizontal className="w-4 h-4" />
												)}
											</button>
										</StandardTooltip>
									)
								})()}
							</div>

							{!inputValue && (
								<div
									className={cn(
										"agent-composer-hint absolute left-2 z-30 flex items-center h-8 font-display text-base leading-normal",
										isEditMode ? "pr-20" : "pr-24",
									)}
									style={{
										bottom: "0.75rem",
										color: "color-mix(in oklab, var(--vscode-input-foreground) 50%, transparent)",
										userSelect: "none",
										pointerEvents: "none",
									}}>
									{placeholderBottomText}
								</div>
							)}
						</div>
					</div>
				</div>

				{!isEditMode && (
					<ProjectContext
						value={inputValue}
						onChange={setInputValue}
						files={filePaths || []}
						cwd={cwd}
						onImages={shouldDisableImages ? undefined : _onSelectImages}
					/>
				)}
				{selectedImages.length > 0 && (
					<Thumbnails
						images={selectedImages}
						setImages={setSelectedImages}
						style={{
							left: "16px",
							zIndex: 2,
							marginBottom: 0,
						}}
					/>
				)}

				<div className="composer-toolbar flex items-center justify-between gap-1.5 w-full min-w-0">
					<div className="composer-controls flex items-center gap-1.5 min-w-0 flex-1">
						<ModeSelector
							value={mode}
							title={t("chat:selectMode")}
							onChange={handleModeChange}
							triggerClassName="text-ellipsis overflow-hidden shrink-0"
							modeShortcutText={modeShortcutText}
							customModes={customModes}
							customModePrompts={customModePrompts}
						/>
						<ModelSelector
							disabled={Boolean(selectApiConfigDisabled)}
							triggerTestId="dropdown-trigger"
							triggerClassName="composer-model min-w-0 max-w-[280px] sm:max-w-[320px] w-auto inline-flex items-center text-ellipsis overflow-hidden px-2.5 py-1"
							currentConfigId={currentConfigId}
							displayName={displayName}
							listApiConfigMeta={listApiConfigMeta || []}
							pinnedApiConfigs={pinnedApiConfigs}
							togglePinnedApiConfig={togglePinnedApiConfig}
							lockApiConfigAcrossModes={!!lockApiConfigAcrossModes}
							onToggleLockApiConfig={handleToggleLockApiConfig}
							onApiConfigChange={handleApiConfigChange}
						/>
						<ReasoningEffortButton
							disabled={Boolean(selectApiConfigDisabled)}
							modelId={modelId}
							modelInfo={model}
						/>
						<AutoApproveDropdown triggerClassName="min-w-[28px] text-ellipsis overflow-hidden shrink-0" />
						<WebSearchButton
							mode={webSearchMode}
							onChange={setWebSearchMode}
							disabled={Boolean(selectApiConfigDisabled)}
						/>
						{!isEditMode && contextWindow > 0 && (
							<ContextWindowProgress
								contextWindow={contextWindow}
								contextTokens={contextTokens || 0}
								maxTokens={maxTokens || undefined}
								className="shrink-0"
							/>
						)}
					</div>
					<div className="flex flex-shrink-0 items-center gap-1 h-8 leading-none pr-1">
						{isTtsPlaying && (
							<StandardTooltip content={t("chat:stopTts")}>
								<button
									aria-label={t("chat:stopTts")}
									onClick={handleStopTts}
									className={cn(
										"h-8 w-8 relative inline-flex items-center justify-center",
										"bg-transparent border border-border/40",
										"rounded-md text-vscode-foreground opacity-85",
										"transition-all duration-150",
										"hover:opacity-100 hover:bg-vscode-toolbar-hoverBackground/60 hover:border-border/70",
										"focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
										"active:bg-[rgba(255,255,255,0.1)]",
										"cursor-pointer",
									)}>
									<VolumeX className="w-4 h-4" />
								</button>
							</StandardTooltip>
						)}
					</div>
				</div>
			</div>
		)
	},
)
