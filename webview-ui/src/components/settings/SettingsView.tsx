import React, {
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import {
	Cpu,
	Gauge,
	MessageSquareCode,
	Database,
	ShieldCheck,
	Terminal,
	Sliders,
	Search,
	X,
	RotateCcw,
	Check,
	AlertTriangle,
	ArrowLeft,
	LucideIcon,
} from "lucide-react"

import {
	type ProviderSettings,
	type ExperimentId,
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	ImageGenerationProvider,
} from "@roo-code/types"
import deepEqual from "fast-deep-equal"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { ExtensionStateContextType, useExtensionState } from "@src/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogCancel,
	AlertDialogAction,
	AlertDialogHeader,
	AlertDialogFooter,
	Button,
	Input,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	StandardTooltip,
} from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabList, TabTrigger } from "../common/Tab"
import { SetCachedStateField, SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import ApiConfigManager from "./ApiConfigManager"
import ApiOptions from "./ApiOptions"
import { ProviderLimits } from "./ProviderLimits"
import { AutoApproveSettings } from "./AutoApproveSettings"
import { CommandSafetySettings } from "./CommandSafetySettings"
import { CheckpointSettings } from "./CheckpointSettings"
import { NotificationSettings } from "./NotificationSettings"
import { ContextManagementSettings } from "./ContextManagementSettings"
import { TerminalSettings } from "./TerminalSettings"
import { ExperimentalSettings } from "./ExperimentalSettings"
import { LanguageSettings } from "./LanguageSettings"
import { About } from "./About"
import { Section } from "./Section"
import PromptsSettings from "./PromptsSettings"
import { SlashCommandsSettings } from "./SlashCommandsSettings"
import { SkillsSettings } from "./SkillsSettings"
import { UISettings } from "./UISettings"
import { WebAccessSettings } from "./WebAccessSettings"
import ModesView from "../modes/ModesView"
import McpView from "../mcp/McpView"
import { WorktreesView } from "../worktrees/WorktreesView"
import { useSearchIndexRegistry, SearchIndexProvider, useSettingsSearch, SearchResult } from "./useSettingsSearch"

export const settingsTabsContainer = "flex flex-1 overflow-hidden"
export const settingsTabList =
	"w-60 data-[compact=true]:w-14 flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden border-r border-border bg-[var(--bg-surface)] p-2 gap-1"
export const settingsTabTrigger =
	"w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 text-sm font-medium transition-colors text-vscode-descriptionForeground hover:text-vscode-foreground hover:bg-[var(--bg-hover)] cursor-pointer"
export const settingsTabTriggerActive =
	"bg-[var(--bg-active)] text-vscode-foreground font-semibold shadow-xs border border-border"

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

export const sectionNames = [
	"providers",
	"limits",
	"autoApprove",
	"slashCommands",
	"skills",
	"checkpoints",
	"notifications",
	"contextManagement",
	"terminal",
	"webAccess",
	"modes",
	"mcp",
	"worktrees",
	"prompts",
	"ui",
	"experimental",
	"language",
	"about",
] as const

export type SectionName = (typeof sectionNames)[number]

export const categoryIds = [
	"providers",
	"limits",
	"modes_prompts",
	"context",
	"permissions",
	"tools",
	"appearance",
] as const

export type CategoryId = (typeof categoryIds)[number]

export const SECTION_TO_CATEGORY: Record<string, CategoryId> = {
	providers: "providers",
	limits: "limits",
	provider: "providers",
	model: "providers",
	models: "providers",
	api: "providers",
	modes: "modes_prompts",
	mode: "modes_prompts",
	prompts: "modes_prompts",
	prompt: "modes_prompts",
	slashCommands: "modes_prompts",
	slash_commands: "modes_prompts",
	skills: "modes_prompts",
	skill: "modes_prompts",
	modes_prompts: "modes_prompts",
	contextManagement: "context",
	context_management: "context",
	checkpoints: "context",
	checkpoint: "context",
	context: "context",
	autoApprove: "permissions",
	auto_approve: "permissions",
	commandSafety: "permissions",
	command_safety: "permissions",
	safety: "permissions",
	permissions: "permissions",
	terminal: "tools",
	webAccess: "tools",
	web_access: "tools",
	web: "tools",
	mcp: "tools",
	worktrees: "tools",
	worktree: "tools",
	tools: "tools",
	ui: "appearance",
	notifications: "appearance",
	notification: "appearance",
	language: "appearance",
	experimental: "appearance",
	about: "appearance",
	appearance: "appearance",
}

export const resolveSectionDomId = (sectionOrAlias?: string): string => {
	if (!sectionOrAlias) return "section-providers"
	const normalized = sectionOrAlias.trim()
	switch (normalized) {
		case "safety":
		case "command_safety":
		case "commandSafety":
			return "section-commandSafety"
		case "autoApprove":
		case "auto_approve":
			return "section-autoApprove"
		case "providers":
		case "provider":
		case "api":
			return "section-providers"
		case "limits":
			return "section-limits"
		case "model":
		case "models":
			return "section-model"
		case "modes":
		case "mode":
			return "section-modes"
		case "prompts":
		case "prompt":
			return "section-prompts"
		case "slashCommands":
		case "slash_commands":
			return "section-slashCommands"
		case "skills":
		case "skill":
			return "section-skills"
		case "contextManagement":
		case "context_management":
		case "context":
			return "section-contextManagement"
		case "checkpoints":
		case "checkpoint":
			return "section-checkpoints"
		case "terminal":
			return "section-terminal"
		case "webAccess":
		case "web_access":
		case "web":
			return "section-webAccess"
		case "mcp":
			return "section-mcp"
		case "worktrees":
		case "worktree":
			return "section-worktrees"
		case "ui":
			return "section-ui"
		case "notifications":
		case "notification":
			return "section-notifications"
		case "language":
			return "section-language"
		case "experimental":
			return "section-experimental"
		case "about":
			return "section-about"
		default:
			return `section-${normalized}`
	}
}

export const resolveCategory = (sectionOrCategory?: string): CategoryId => {
	if (!sectionOrCategory) return "providers"
	if (categoryIds.includes(sectionOrCategory as CategoryId)) {
		return sectionOrCategory as CategoryId
	}
	if (sectionOrCategory in SECTION_TO_CATEGORY) {
		return SECTION_TO_CATEGORY[sectionOrCategory]
	}
	return "providers"
}

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

interface CategoryDefinition {
	id: CategoryId
	icon: LucideIcon
	legacySections: SectionName[]
}

const CATEGORIES: CategoryDefinition[] = [
	{
		id: "providers",
		icon: Cpu,
		legacySections: ["providers"],
	},
	{
		id: "limits",
		icon: Gauge,
		legacySections: ["limits"],
	},
	{
		id: "modes_prompts",
		icon: MessageSquareCode,
		legacySections: ["modes", "prompts", "slashCommands", "skills"],
	},
	{
		id: "context",
		icon: Database,
		legacySections: ["contextManagement", "checkpoints"],
	},
	{
		id: "permissions",
		icon: ShieldCheck,
		legacySections: ["autoApprove"],
	},
	{
		id: "tools",
		icon: Terminal,
		legacySections: ["terminal", "webAccess", "mcp", "worktrees"],
	},
	{
		id: "appearance",
		icon: Sliders,
		legacySections: ["ui", "notifications", "language", "experimental", "about"],
	},
]

export const extractComparableSettings = (state?: any) => {
	if (!state) return {}
	return {
		apiConfiguration: state.apiConfiguration ?? {},
		alwaysAllowReadOnly: state.alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace: state.alwaysAllowReadOnlyOutsideWorkspace,
		allowedCommands: state.allowedCommands ?? [],
		deniedCommands: state.deniedCommands ?? [],
		allowedMaxRequests: state.allowedMaxRequests,
		allowedMaxCost: state.allowedMaxCost,
		autoApprovalEnabled: state.autoApprovalEnabled,
		language: state.language,
		alwaysAllowExecute: state.alwaysAllowExecute,
		alwaysAllowMcp: state.alwaysAllowMcp,
		alwaysAllowModeSwitch: state.alwaysAllowModeSwitch,
		alwaysAllowSubtasks: state.alwaysAllowSubtasks,
		alwaysAllowWrite: state.alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace: state.alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected: state.alwaysAllowWriteProtected,
		autoCondenseContext: state.autoCondenseContext,
		autoCondenseContextPercent: state.autoCondenseContextPercent,
		enableCheckpoints: state.enableCheckpoints,
		checkpointTimeout: state.checkpointTimeout,
		experiments: state.experiments ?? {},
		maxOpenTabsContext: state.maxOpenTabsContext,
		maxWorkspaceFiles: state.maxWorkspaceFiles,
		mcpEnabled: state.mcpEnabled,
		soundEnabled: state.soundEnabled,
		soundVolume: state.soundVolume,
		ttsEnabled: state.ttsEnabled,
		ttsSpeed: state.ttsSpeed,
		terminalShellIntegrationTimeout: state.terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled: state.terminalShellIntegrationDisabled,
		terminalCommandDelay: state.terminalCommandDelay,
		terminalPowershellCounter: state.terminalPowershellCounter,
		terminalZshClearEolMark: state.terminalZshClearEolMark,
		terminalZshOhMy: state.terminalZshOhMy,
		terminalZshP10k: state.terminalZshP10k,
		terminalZdotdir: state.terminalZdotdir,
		terminalOutputPreviewSize: state.terminalOutputPreviewSize,
		writeDelayMs: state.writeDelayMs,
		showRooIgnoredFiles: state.showRooIgnoredFiles,
		enableSubfolderRules: state.enableSubfolderRules,
		maxImageFileSize: state.maxImageFileSize,
		maxTotalImageSize: state.maxTotalImageSize,
		customSupportPrompts: state.customSupportPrompts ?? {},
		profileThresholds: state.profileThresholds ?? {},
		alwaysAllowFollowupQuestions: state.alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs: state.followupAutoApproveTimeoutMs,
		includeDiagnosticMessages: state.includeDiagnosticMessages,
		maxDiagnosticMessages: state.maxDiagnosticMessages,
		includeTaskHistoryInEnhance: state.includeTaskHistoryInEnhance,
		imageGenerationProvider: state.imageGenerationProvider,
		openRouterImageApiKey: state.openRouterImageApiKey,
		openRouterImageGenerationSelectedModel: state.openRouterImageGenerationSelectedModel,
		reasoningBlockCollapsed: state.reasoningBlockCollapsed,
		theme: state.theme,
		enterBehavior: state.enterBehavior,
		includeCurrentTime: state.includeCurrentTime,
		includeCurrentCost: state.includeCurrentCost,
		maxGitStatusFiles: state.maxGitStatusFiles,
		debug: state.debug,
		commandSafetyConfig: state.commandSafetyConfig,
		approvalMode: state.approvalMode,
		webSearchEnabled: state.webSearchEnabled,
		webSearchProvider: state.webSearchProvider,
		webSearchApiKey: state.webSearchApiKey,
		webSearchSearxngUrl: state.webSearchSearxngUrl,
		webSearchMaxResults: state.webSearchMaxResults,
	}
}

const SettingsView = forwardRef<SettingsViewRef, SettingsViewProps>(({ onDone, targetSection }, ref) => {
	const { t } = useAppTranslation()

	const extensionState = useExtensionState()
	const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt } = extensionState

	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)

	const [cleanOriginalState, setCleanOriginalState] = useState(() => extensionState)
	const [cachedState, setCachedState] = useState(() => extensionState)

	const isChangeDetected = useMemo(() => {
		return !deepEqual(extractComparableSettings(cleanOriginalState), extractComparableSettings(cachedState))
	}, [cleanOriginalState, cachedState])

	const [activeCategory, setActiveCategory] = useState<CategoryId>(() => resolveCategory(targetSection))

	const scrollPositions = useRef<Record<CategoryId, number>>(
		Object.fromEntries(categoryIds.map((c) => [c, 0])) as Record<CategoryId, number>,
	)
	const contentRef = useRef<HTMLDivElement | null>(null)

	const prevApiConfigName = useRef(currentApiConfigName)
	const confirmDialogHandler = useRef<() => void>()

	const {
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		allowedCommands,
		deniedCommands,
		allowedMaxRequests,
		allowedMaxCost,
		language,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		autoCondenseContext,
		autoCondenseContextPercent,
		enableCheckpoints,
		checkpointTimeout,
		experiments,
		maxOpenTabsContext,
		maxWorkspaceFiles,
		mcpEnabled,
		soundEnabled,
		ttsEnabled,
		ttsSpeed,
		soundVolume,
		terminalOutputPreviewSize,
		terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled,
		terminalCommandDelay,
		terminalPowershellCounter,
		terminalZshClearEolMark,
		terminalZshOhMy,
		terminalZshP10k,
		terminalZdotdir,
		writeDelayMs,
		showRooIgnoredFiles,
		enableSubfolderRules,
		maxImageFileSize,
		maxTotalImageSize,
		customSupportPrompts,
		profileThresholds,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		imageGenerationProvider,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		reasoningBlockCollapsed,
		theme,
		enterBehavior,
		includeCurrentTime,
		includeCurrentCost,
		maxGitStatusFiles,
		commandSafetyConfig,
		webSearchEnabled,
		webSearchProvider,
		webSearchApiKey,
		webSearchSearxngUrl,
		webSearchMaxResults,
	} = cachedState

	const apiConfiguration = useMemo(() => cachedState.apiConfiguration ?? {}, [cachedState.apiConfiguration])

	useEffect(() => {
		if (prevApiConfigName.current === currentApiConfigName) {
			return
		}

		setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
		setCleanOriginalState((prevCleanState) => ({ ...prevCleanState, ...extensionState }))
		prevApiConfigName.current = currentApiConfigName
	}, [currentApiConfigName, extensionState])

	// Bust the cache when settings are imported.
	useEffect(() => {
		if (settingsImportedAt) {
			setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
			setCleanOriginalState((prevCleanState) => ({ ...prevCleanState, ...extensionState }))
		}
	}, [settingsImportedAt, extensionState])

	// Sync cached state when state is first hydrated from extension host
	const prevDidHydrateState = useRef(extensionState.didHydrateState)
	useEffect(() => {
		if (!prevDidHydrateState.current && extensionState.didHydrateState) {
			setCachedState((prevCachedState) => ({ ...prevCachedState, ...extensionState }))
			setCleanOriginalState((prevCleanState) => ({ ...prevCleanState, ...extensionState }))
		}
		prevDidHydrateState.current = extensionState.didHydrateState
	}, [extensionState.didHydrateState, extensionState])

	const setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType> = useCallback((field, value) => {
		setCachedState((prevState) => {
			if (prevState[field] === value) {
				return prevState
			}

			return { ...prevState, [field]: value }
		})
	}, [])

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			setCachedState((prevState) => {
				if (prevState.apiConfiguration?.[field] === value) {
					return prevState
				}

				return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
			})

			if (!isUserAction) {
				setCleanOriginalState((prevState) => {
					if (prevState.apiConfiguration?.[field] === value) {
						return prevState
					}

					return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
				})
			}
		},
		[],
	)

	const setExperimentEnabled: SetExperimentEnabled = useCallback((id: ExperimentId, enabled: boolean) => {
		setCachedState((prevState) => {
			if (prevState.experiments?.[id] === enabled) {
				return prevState
			}

			return { ...prevState, experiments: { ...prevState.experiments, [id]: enabled } }
		})
	}, [])

	const setDebug = useCallback((debug: boolean) => {
		setCachedState((prevState) => {
			if (prevState.debug === debug) {
				return prevState
			}

			return { ...prevState, debug }
		})
	}, [])

	const setImageGenerationProvider = useCallback((provider: ImageGenerationProvider) => {
		setCachedState((prevState) => {
			if (prevState.imageGenerationProvider === provider) {
				return prevState
			}

			return { ...prevState, imageGenerationProvider: provider }
		})
	}, [])

	const setOpenRouterImageApiKey = useCallback((apiKey: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageApiKey === apiKey) {
				return prevState
			}

			return { ...prevState, openRouterImageApiKey: apiKey }
		})
	}, [])

	const setImageGenerationSelectedModel = useCallback((model: string) => {
		setCachedState((prevState) => {
			if (prevState.openRouterImageGenerationSelectedModel === model) {
				return prevState
			}

			return { ...prevState, openRouterImageGenerationSelectedModel: model }
		})
	}, [])

	const setCustomSupportPromptsField = useCallback((prompts: Record<string, string | undefined>) => {
		setCachedState((prevState) => {
			const previousStr = JSON.stringify(prevState.customSupportPrompts)
			const newStr = JSON.stringify(prompts)

			if (previousStr === newStr) {
				return prevState
			}

			return { ...prevState, customSupportPrompts: prompts }
		})
	}, [])

	const isSettingValid = !errorMessage

	const handleSubmit = () => {
		if (isSettingValid) {
			vscode.postMessage({
				type: "updateSettings",
				updatedSettings: {
					language,
					alwaysAllowReadOnly: alwaysAllowReadOnly ?? undefined,
					alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? undefined,
					alwaysAllowWrite: alwaysAllowWrite ?? undefined,
					alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? undefined,
					alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? undefined,
					alwaysAllowExecute: alwaysAllowExecute ?? undefined,
					alwaysAllowMcp,
					alwaysAllowModeSwitch,
					allowedCommands: allowedCommands ?? [],
					deniedCommands: deniedCommands ?? [],
					allowedMaxRequests: allowedMaxRequests ?? null,
					allowedMaxCost: allowedMaxCost ?? null,
					autoCondenseContext,
					autoCondenseContextPercent,
					soundEnabled: soundEnabled ?? true,
					soundVolume: soundVolume ?? 0.5,
					ttsEnabled,
					ttsSpeed,
					enableCheckpoints: enableCheckpoints ?? false,
					checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
					writeDelayMs,
					terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? 30_000,
					terminalShellIntegrationDisabled,
					terminalCommandDelay,
					terminalPowershellCounter,
					terminalZshClearEolMark,
					terminalZshOhMy,
					terminalZshP10k,
					terminalZdotdir,
					terminalOutputPreviewSize: terminalOutputPreviewSize ?? "medium",
					mcpEnabled,
					maxOpenTabsContext: Math.min(Math.max(0, maxOpenTabsContext ?? 20), 500),
					maxWorkspaceFiles: Math.min(Math.max(0, maxWorkspaceFiles ?? 200), 500),
					showRooIgnoredFiles: showRooIgnoredFiles ?? true,
					enableSubfolderRules: enableSubfolderRules ?? false,
					maxImageFileSize: maxImageFileSize ?? 5,
					maxTotalImageSize: maxTotalImageSize ?? 20,
					includeDiagnosticMessages:
						includeDiagnosticMessages !== undefined ? includeDiagnosticMessages : true,
					maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
					alwaysAllowSubtasks,
					alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
					followupAutoApproveTimeoutMs,
					includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
					reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
					theme: theme ?? "linear-dark",
					enterBehavior: enterBehavior ?? "send",
					includeCurrentTime: includeCurrentTime ?? true,
					includeCurrentCost: includeCurrentCost ?? true,
					maxGitStatusFiles: maxGitStatusFiles ?? 0,
					profileThresholds,
					imageGenerationProvider,
					openRouterImageApiKey,
					openRouterImageGenerationSelectedModel,
					experiments,
					customSupportPrompts,
					commandSafetyConfig: cachedState.commandSafetyConfig,
					approvalMode: cachedState.approvalMode ?? "manual",
					webSearchEnabled,
					webSearchProvider,
					webSearchApiKey,
					webSearchSearxngUrl,
					webSearchMaxResults,
				},
			})

			vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
			vscode.postMessage({ type: "debugSetting", bool: cachedState.debug })

			if (cachedState.autoApprovalEnabled !== cleanOriginalState.autoApprovalEnabled) {
				vscode.postMessage({ type: "autoApprovalEnabled", bool: cachedState.autoApprovalEnabled })
			}

			if (cachedState.approvalMode !== cleanOriginalState.approvalMode && cachedState.approvalMode) {
				vscode.postMessage({ type: "approvalMode", approvalMode: cachedState.approvalMode })
			}

			setCleanOriginalState(cachedState)
		}
	}

	const checkUnsaveChanges = useCallback(
		(then: () => void) => {
			if (isChangeDetected) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[isChangeDetected],
	)

	useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				setCachedState(cleanOriginalState)
				confirmDialogHandler.current?.()
			}
		},
		[cleanOriginalState],
	)

	const handleCategoryChange = useCallback(
		(newCategory: CategoryId) => {
			if (contentRef.current) {
				scrollPositions.current[activeCategory] = contentRef.current.scrollTop
			}
			setActiveCategory(newCategory)
		},
		[activeCategory],
	)

	useLayoutEffect(() => {
		if (contentRef.current) {
			contentRef.current.scrollTop = scrollPositions.current[activeCategory] ?? 0
		}
	}, [activeCategory])

	// Store direct DOM element refs for each category
	const tabRefs = useRef<Record<CategoryId, HTMLButtonElement | null>>(
		Object.fromEntries(categoryIds.map((name) => [name, null])) as Record<CategoryId, HTMLButtonElement | null>,
	)

	// Track whether we're in compact mode
	const [isCompactMode, setIsCompactMode] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!containerRef.current) return

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setIsCompactMode(entry.contentRect.width < 540)
			}
		})

		observer.observe(containerRef.current)

		return () => {
			observer?.disconnect()
		}
	}, [])

	// Update active category when targetSection changes
	useEffect(() => {
		if (targetSection) {
			const targetCat = resolveCategory(targetSection)
			setActiveCategory(targetCat)

			// If it's a specific sub-section, scroll to it
			let timeoutId: NodeJS.Timeout | undefined
			const animId = requestAnimationFrame(() => {
				timeoutId = setTimeout(() => {
					if (typeof document !== "undefined") {
						const targetDomId = resolveSectionDomId(targetSection)
						const element = document.getElementById(targetDomId)
						if (element) {
							element.scrollIntoView({ behavior: "smooth", block: "start" })
						}
					}
				}, 150)
			})

			return () => {
				cancelAnimationFrame(animId)
				if (timeoutId) {
					clearTimeout(timeoutId)
				}
			}
		}
	}, [targetSection])

	// Function to scroll active tab into view
	const scrollToActiveTab = useCallback(() => {
		const activeTabElement = tabRefs.current[activeCategory]
		if (activeTabElement) {
			activeTabElement.scrollIntoView({
				behavior: "auto",
				block: "nearest",
			})
		}
	}, [activeCategory])

	useEffect(() => {
		scrollToActiveTab()
	}, [activeCategory, scrollToActiveTab])

	useLayoutEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "action" && message.action === "didBecomeVisible") {
				scrollToActiveTab()
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [scrollToActiveTab])

	// Search index registry
	const getSectionLabel = useCallback((section: SectionName) => t(`settings:sections.${section}`), [t])
	const { contextValue: searchContextValue, index: searchIndex } = useSearchIndexRegistry(getSectionLabel)

	// Indexing cycle through categories on mount
	const [indexingIndex, setIndexingIndex] = useState(0)
	const initialCategory = useRef<CategoryId>(activeCategory)
	const isIndexing = indexingIndex < categoryIds.length
	const tabTitlesRegistered = useRef(false)

	useLayoutEffect(() => {
		if (indexingIndex >= categoryIds.length) {
			if (!tabTitlesRegistered.current && searchContextValue) {
				// Register both categories and sections for search
				CATEGORIES.forEach(({ id, legacySections }) => {
					const categoryTitle = t(`settings:categories.${id}`)
					searchContextValue.registerSetting({
						settingId: `category-${id}`,
						section: legacySections[0] || "providers",
						label: categoryTitle,
					})
					legacySections.forEach((sec) => {
						const secTitle = t(`settings:sections.${sec}`)
						searchContextValue.registerSetting({
							settingId: `tab-${sec}`,
							section: sec,
							label: secTitle,
						})
					})
				})
				tabTitlesRegistered.current = true
				setActiveCategory(initialCategory.current)
			}
			return
		}

		setIndexingIndex((prev) => prev + 1)
	}, [indexingIndex, searchContextValue, t])

	const renderCategory = isIndexing ? categoryIds[indexingIndex] : activeCategory

	// Settings search hook
	const { searchQuery, setSearchQuery, results, clearSearch } = useSettingsSearch({ index: searchIndex })

	const handleSearchNavigate = useCallback(
		(section: SectionName, settingId: string) => {
			const cat = resolveCategory(section)
			handleCategoryChange(cat)
			clearSearch()

			requestAnimationFrame(() => {
				setTimeout(() => {
					const element =
						document.querySelector(`[data-setting-id="${settingId}"]`) ||
						document.getElementById(`section-${section}`)
					if (element) {
						element.scrollIntoView({ behavior: "smooth", block: "center" })
						element.classList.add("settings-highlight")
						setTimeout(() => {
							element.classList.remove("settings-highlight")
						}, 1500)
					}
				}, 100)
			})
		},
		[handleCategoryChange, clearSearch],
	)

	return (
		<Tab className="settings-workspace h-full flex flex-col bg-[var(--bg-canvas)] text-vscode-foreground select-none overflow-hidden">
			{/* Top Header */}
			<TabHeader className="flex justify-between items-center px-4 py-2.5 border-b border-border bg-[var(--bg-surface)] shrink-0">
				<div className="flex items-center gap-2">
					<StandardTooltip content={t("settings:header.doneButtonTooltip")}>
						<Button
							variant="ghost"
							className="px-2 py-1 h-8 text-vscode-descriptionForeground hover:text-vscode-foreground hover:bg-[var(--bg-hover)] rounded-md transition-colors"
							onClick={() => checkUnsaveChanges(onDone)}>
							<ArrowLeft className="w-4 h-4 mr-1.5" />
							<span className="text-xs font-medium">{t("settings:common.done")}</span>
						</Button>
					</StandardTooltip>
					<div className="h-4 w-[1px] bg-border mx-1" />
					<h3 className="text-sm font-semibold text-vscode-foreground m-0 tracking-tight">
						{t("settings:header.title")}
					</h3>
				</div>
			</TabHeader>

			{/* Master-Detail Two-Column Body */}
			<div ref={containerRef} className={cn(settingsTabsContainer, isCompactMode && "narrow")}>
				{/* Left Column: Categorical Sidebar */}
				<div className={cn(settingsTabList)} data-compact={isCompactMode}>
					{/* Search Input at the top of the sidebar */}
					<div className="px-1 py-1 mb-1">
						<div className="relative flex items-center">
							<Search className="absolute left-2.5 w-3.5 h-3.5 text-vscode-descriptionForeground pointer-events-none" />
							<Input
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder={isCompactMode ? "" : t("settings:search.placeholder")}
								className="h-8 pl-8 pr-7 text-xs bg-[var(--bg-surface-elevated)] border-border rounded-md focus:border-vscode-focusBorder placeholder:text-vscode-descriptionForeground/60 w-full"
							/>
							{searchQuery && (
								<button
									onClick={clearSearch}
									className="absolute right-2 text-vscode-descriptionForeground hover:text-vscode-foreground p-0.5 rounded transition-colors">
									<X className="w-3 h-3" />
								</button>
							)}
						</div>
					</div>

					{/* Vertical Category Tabs */}
					<TabList
						value={activeCategory}
						onValueChange={(value) => handleCategoryChange(resolveCategory(value))}
						className="flex flex-col gap-1 w-full"
						data-compact={isCompactMode}
						data-testid="settings-tab-list">
						{CATEGORIES.map(({ id, icon: Icon, legacySections }) => {
							const isSelected = id === activeCategory
							const onSelect = () => handleCategoryChange(id)
							const categoryLabel = t(`settings:categories.${id}`)

							const triggerComponent = (
								<TabTrigger
									ref={(element) => (tabRefs.current[id] = element)}
									value={id}
									isSelected={isSelected}
									className={cn(
										settingsTabTrigger,
										isSelected && settingsTabTriggerActive,
										isCompactMode && "justify-center px-2",
									)}
									data-testid={`tab-${id}`}
									data-legacy-sections={legacySections.join(",")}
									data-compact={isCompactMode}>
									<Icon className="w-4 h-4 shrink-0" />
									{!isCompactMode && <span className="truncate">{categoryLabel}</span>}
								</TabTrigger>
							)

							if (isCompactMode) {
								return (
									<TooltipProvider key={id} delayDuration={200}>
										<Tooltip>
											<TooltipTrigger asChild onClick={onSelect}>
												{React.cloneElement(triggerComponent)}
											</TooltipTrigger>
											<TooltipContent side="right" className="text-xs">
												<p className="m-0 font-medium">{categoryLabel}</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								)
							}

							return React.cloneElement(triggerComponent, { key: id })
						})}
					</TabList>
				</div>

				{/* Right Column: Content Workspace */}
				<div className="flex-1 flex flex-col overflow-hidden bg-vscode-editor-background">
					{/* Category Top Banner */}
					<div className="px-6 py-4 border-b border-[var(--border-subtle)] bg-vscode-editor-background shrink-0">
						{searchQuery ? (
							<div>
								<h2 className="text-base font-bold text-vscode-foreground m-0">
									{t("settings:search.placeholder")}: "{searchQuery}"
								</h2>
								<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0">
									{results.length > 0
										? t("settings:search.resultsFound", {
												count: results.length,
												defaultValue: `${results.length} results found`,
											})
										: t("settings:search.noResults")}
								</p>
							</div>
						) : (
							<div>
								<h2 className="text-base font-bold text-vscode-foreground m-0 tracking-tight">
									{t(`settings:categories.${activeCategory}`)}
								</h2>
								<p className="text-xs text-vscode-descriptionForeground mt-1 mb-0 max-w-2xl">
									{t(`settings:categoryDescriptions.${activeCategory}`)}
								</p>
							</div>
						)}
					</div>

					{/* Content Container */}
					<TabContent
						ref={contentRef}
						className={cn("p-6 flex-1 overflow-y-auto scrollable", isIndexing && "opacity-0")}
						data-testid="settings-content">
						<SearchIndexProvider value={searchContextValue}>
							{searchQuery ? (
								/* Dynamic Search Results View */
								<div className="space-y-3">
									{results.length === 0 ? (
										<div className="text-center py-12 text-vscode-descriptionForeground text-sm">
											{t("settings:search.noResults")}
										</div>
									) : (
										results.map((result: SearchResult) => (
											<button
												key={`${result.section}-${result.settingId}`}
												onClick={() => handleSearchNavigate(result.section, result.settingId)}
												className="w-full text-left p-4 rounded-xl border border-border bg-card hover:bg-muted/40 transition-colors flex items-center justify-between group">
												<div className="flex flex-col gap-1">
													<span className="text-sm font-medium text-vscode-foreground group-hover:text-foreground transition-colors">
														{result.label}
													</span>
													<span className="text-xs text-vscode-descriptionForeground">
														{result.sectionLabel}
													</span>
												</div>
												<span className="text-xs px-2.5 py-1 rounded-md bg-white/[0.04] border border-[var(--border-subtle)] text-vscode-descriptionForeground group-hover:text-vscode-foreground">
													{t(`settings:categories.${resolveCategory(result.section)}`)}
												</span>
											</button>
										))
									)}
								</div>
							) : (
								/* Category Content */
								<div>
									{/* Category 1: Providers & Models */}
									{renderCategory === "providers" && (
										<div className="space-y-6">
											<div
												id="section-providers"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<ApiConfigManager
													currentApiConfigName={currentApiConfigName}
													listApiConfigMeta={listApiConfigMeta}
													onSelectConfig={(configName: string) =>
														checkUnsaveChanges(() =>
															vscode.postMessage({
																type: "loadApiConfiguration",
																text: configName,
															}),
														)
													}
													onDeleteConfig={(configName: string) =>
														vscode.postMessage({
															type: "deleteApiConfiguration",
															text: configName,
														})
													}
													onRenameConfig={(oldName: string, newName: string) => {
														vscode.postMessage({
															type: "renameApiConfiguration",
															values: { oldName, newName },
															apiConfiguration,
														})
														prevApiConfigName.current = newName
													}}
													onUpsertConfig={(configName: string) =>
														vscode.postMessage({
															type: "upsertApiConfiguration",
															text: configName,
															apiConfiguration,
														})
													}
												/>
											</div>
											<div
												id="section-model"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<ApiOptions
													uriScheme={uriScheme}
													apiConfiguration={apiConfiguration}
													setApiConfigurationField={setApiConfigurationField}
													errorMessage={errorMessage}
													setErrorMessage={setErrorMessage}
												/>
											</div>
										</div>
									)}
									{renderCategory === "limits" && !isIndexing && <ProviderLimits />}

									{/* Category 2: Modes & Prompts */}
									{renderCategory === "modes_prompts" && (
										<div className="space-y-6">
											<div
												id="section-modes"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<SectionHeader>{t("settings:sections.modes")}</SectionHeader>
												<ModesView />
											</div>
											<div
												id="section-prompts"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<PromptsSettings
													customSupportPrompts={customSupportPrompts || {}}
													setCustomSupportPrompts={setCustomSupportPromptsField}
													includeTaskHistoryInEnhance={includeTaskHistoryInEnhance}
													setIncludeTaskHistoryInEnhance={(value) =>
														setCachedStateField("includeTaskHistoryInEnhance", value)
													}
												/>
											</div>
											<div
												id="section-slashCommands"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<SlashCommandsSettings />
											</div>
											<div
												id="section-skills"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<SkillsSettings />
											</div>
										</div>
									)}

									{/* Category 3: Context Management */}
									{renderCategory === "context" && (
										<div className="space-y-6">
											<div
												id="section-contextManagement"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<ContextManagementSettings
													autoCondenseContext={autoCondenseContext}
													autoCondenseContextPercent={autoCondenseContextPercent}
													listApiConfigMeta={listApiConfigMeta ?? []}
													maxOpenTabsContext={maxOpenTabsContext}
													maxWorkspaceFiles={maxWorkspaceFiles ?? 200}
													showRooIgnoredFiles={showRooIgnoredFiles}
													enableSubfolderRules={enableSubfolderRules}
													maxImageFileSize={maxImageFileSize}
													maxTotalImageSize={maxTotalImageSize}
													profileThresholds={profileThresholds}
													includeDiagnosticMessages={includeDiagnosticMessages}
													maxDiagnosticMessages={maxDiagnosticMessages}
													writeDelayMs={writeDelayMs}
													includeCurrentTime={includeCurrentTime}
													includeCurrentCost={includeCurrentCost}
													maxGitStatusFiles={maxGitStatusFiles}
													customSupportPrompts={customSupportPrompts || {}}
													setCustomSupportPrompts={setCustomSupportPromptsField}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-checkpoints"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<CheckpointSettings
													enableCheckpoints={enableCheckpoints}
													checkpointTimeout={checkpointTimeout}
													setCachedStateField={setCachedStateField}
												/>
											</div>
										</div>
									)}

									{/* Category 4: Permissions & Auto-Approve */}
									{renderCategory === "permissions" && (
										<div className="space-y-6">
											<div
												id="section-autoApprove"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<AutoApproveSettings
													alwaysAllowReadOnly={alwaysAllowReadOnly}
													alwaysAllowReadOnlyOutsideWorkspace={
														alwaysAllowReadOnlyOutsideWorkspace
													}
													alwaysAllowWrite={alwaysAllowWrite}
													alwaysAllowWriteOutsideWorkspace={alwaysAllowWriteOutsideWorkspace}
													alwaysAllowWriteProtected={alwaysAllowWriteProtected}
													alwaysAllowMcp={alwaysAllowMcp}
													alwaysAllowModeSwitch={alwaysAllowModeSwitch}
													alwaysAllowSubtasks={alwaysAllowSubtasks}
													alwaysAllowExecute={alwaysAllowExecute}
													alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
													followupAutoApproveTimeoutMs={followupAutoApproveTimeoutMs}
													allowedCommands={allowedCommands}
													allowedMaxRequests={allowedMaxRequests ?? undefined}
													allowedMaxCost={allowedMaxCost ?? undefined}
													deniedCommands={deniedCommands}
													autoApprovalEnabled={cachedState.autoApprovalEnabled}
													state={cachedState}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-commandSafety"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<CommandSafetySettings
													apiConfiguration={cachedState.apiConfiguration}
													commandSafetyConfig={commandSafetyConfig}
													onChange={(newConfig) =>
														setCachedStateField("commandSafetyConfig", newConfig)
													}
												/>
											</div>
										</div>
									)}

									{/* Category 5: Tools & Terminal */}
									{renderCategory === "tools" && (
										<div className="space-y-6">
											<div
												id="section-terminal"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<TerminalSettings
													terminalOutputPreviewSize={terminalOutputPreviewSize}
													terminalShellIntegrationTimeout={terminalShellIntegrationTimeout}
													terminalShellIntegrationDisabled={terminalShellIntegrationDisabled}
													terminalCommandDelay={terminalCommandDelay}
													terminalPowershellCounter={terminalPowershellCounter}
													terminalZshClearEolMark={terminalZshClearEolMark}
													terminalZshOhMy={terminalZshOhMy}
													terminalZshP10k={terminalZshP10k}
													terminalZdotdir={terminalZdotdir}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-webAccess"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<WebAccessSettings
													webSearchEnabled={webSearchEnabled}
													webSearchProvider={webSearchProvider}
													webSearchApiKey={webSearchApiKey}
													webSearchSearxngUrl={webSearchSearxngUrl}
													webSearchMaxResults={webSearchMaxResults}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-mcp"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<McpView />
											</div>
											<div
												id="section-worktrees"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<WorktreesView />
											</div>
										</div>
									)}

									{/* Category 6: Appearance & Environment */}
									{renderCategory === "appearance" && (
										<div className="space-y-6">
											<div
												id="section-ui"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<UISettings
													reasoningBlockCollapsed={reasoningBlockCollapsed ?? true}
													enterBehavior={enterBehavior ?? "send"}
													theme={theme ?? "linear-dark"}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-notifications"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<NotificationSettings
													ttsEnabled={ttsEnabled}
													ttsSpeed={ttsSpeed}
													soundEnabled={soundEnabled}
													soundVolume={soundVolume}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-language"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<LanguageSettings
													language={language || "en"}
													setCachedStateField={setCachedStateField}
												/>
											</div>
											<div
												id="section-experimental"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<ExperimentalSettings
													setExperimentEnabled={setExperimentEnabled}
													experiments={experiments}
													apiConfiguration={apiConfiguration}
													setApiConfigurationField={setApiConfigurationField}
													imageGenerationProvider={imageGenerationProvider}
													openRouterImageApiKey={openRouterImageApiKey as string | undefined}
													openRouterImageGenerationSelectedModel={
														openRouterImageGenerationSelectedModel as string | undefined
													}
													setImageGenerationProvider={setImageGenerationProvider}
													setOpenRouterImageApiKey={setOpenRouterImageApiKey}
													setImageGenerationSelectedModel={setImageGenerationSelectedModel}
												/>
											</div>
											<div
												id="section-about"
												className="bg-card border border-border rounded-xl p-5 shadow-xs">
												<About debug={cachedState.debug} setDebug={setDebug} />
											</div>
										</div>
									)}
								</div>
							)}
						</SearchIndexProvider>
					</TabContent>
				</div>
			</div>

			{/* Sticky Footer Action Bar */}
			<div className="h-14 px-6 border-t border-border bg-[var(--bg-surface)] flex items-center justify-between z-20 shrink-0">
				{/* Left: Dirty state indicator */}
				<div className="flex items-center gap-2">
					{isChangeDetected ? (
						<div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--warning-subtle)] border border-[var(--border-light)]">
							<span className="relative flex h-2 w-2">
								<span className="hidden"></span>
								<span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--warning)]"></span>
							</span>
							<span className="text-xs font-medium text-[var(--warning)]">
								{t("settings:footer.unsavedChanges")}
							</span>
						</div>
					) : (
						<div className="flex items-center gap-2 px-2 py-1 text-vscode-descriptionForeground">
							<Check className="w-3.5 h-3.5 text-[var(--success)]" />
							<span className="text-xs">{t("settings:footer.allChangesSaved")}</span>
						</div>
					)}
				</div>

				{/* Right: Actions (Discard & Save) */}
				<div className="flex items-center gap-3">
					<Button
						variant="secondary"
						onClick={() => onConfirmDialogResult(true)}
						disabled={!isChangeDetected}
						className="text-xs h-8 px-3 gap-1.5 border border-[var(--border-subtle)] hover:bg-white/[0.06] disabled:opacity-40">
						<RotateCcw className="w-3 h-3" />
						{t("settings:footer.discard")}
					</Button>

					<StandardTooltip
						content={
							!isSettingValid
								? errorMessage
								: isChangeDetected
									? t("settings:header.saveButtonTooltip")
									: t("settings:header.nothingChangedTooltip")
						}>
						<Button
							variant={isSettingValid ? "primary" : "secondary"}
							className={cn(
								"text-xs h-8 px-4 font-medium shadow-xs",
								!isSettingValid && "!border-vscode-errorForeground",
							)}
							onClick={handleSubmit}
							disabled={!isChangeDetected || !isSettingValid}
							data-testid="save-button">
							{t("settings:footer.save")}
						</Button>
					</StandardTooltip>
				</div>
			</div>

			{/* Discard Confirmation Dialog */}
			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<AlertTriangle className="w-5 h-5 text-yellow-500" />
							{t("settings:unsavedChangesDialog.title")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default memo(SettingsView)
