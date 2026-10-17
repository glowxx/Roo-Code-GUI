import React, { useState, useMemo, useCallback, useRef, useEffect } from "react"
import {
	Check,
	X,
	Sparkles,
	Cpu,
	Search,
	Brain,
	Zap,
	Bot,
	Server,
	Layers,
	ChevronDown,
	Plus,
	RefreshCw,
	Code2,
	Eye,
} from "lucide-react"

import {
	type ProviderSettings,
	type ProviderName,
	type ModelInfo,
	type RecentModel,
	modelSupportsReasoning,
	getModelContextWindow,
	openAiModelInfoSaneDefaults,
	cleanModelDisplayName,
	formatModelDisplayName,
	stripModelTag,
	setModelId,
} from "@roo-code/types"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { MODELS_BY_PROVIDER } from "@/components/settings/constants"
import { IconButton } from "./IconButton"
import {
	modelFamilies,
	modelFamilyOrder,
	ModelFamilyIcon,
	extractModelFamily,
	modelVersionParts,
	type ModelFamily,
} from "./model-families"
export { extractModelFamily, type ModelFamily } from "./model-families"
import "./model-selector.css"

export interface ModelSelectorProps {
	disabled?: boolean
	triggerClassName?: string
	triggerTestId?: string
	currentConfigId?: string
	displayName?: string
	listApiConfigMeta?: Array<{ id: string; name: string; modelId?: string }>
	pinnedApiConfigs?: Record<string, boolean>
	togglePinnedApiConfig?: (id: string) => void
	lockApiConfigAcrossModes?: boolean
	onToggleLockApiConfig?: () => void
	onApiConfigChange?: (configId: string) => void
}

export interface ModelItem {
	id: string
	name: string
	contextWindow?: number
	isReasoning?: boolean
	isFast?: boolean
	isCoder?: boolean
	isVision?: boolean
	isFlagship?: boolean
	badge?: string
	description?: string
	modelInfo?: ModelInfo
}

export type ModelCategory = "all" | "reasoning" | "fast" | "coder" | "vision" | "default"

export const extractModelVersion = (id: string): number => {
	const lower = id.toLowerCase()
	const family = extractModelFamily(id)

	if (family === "claude") {
		const match = lower.match(/claude-?(?:v)?(\d+)(?:[.\-_](\d+))?/)
		if (match) {
			const major = parseInt(match[1], 10)
			const minor = match[2] ? parseInt(match[2], 10) : 0
			return major + minor / 10
		}
	} else if (family === "openai") {
		const oMatch = lower.match(/(?:^|[\/_\-])o(\d+)(?:[.\-_](\d+))?/)
		if (oMatch) {
			const major = parseInt(oMatch[1], 10)
			const minor = oMatch[2] ? parseInt(oMatch[2], 10) : 0
			return major + minor / 10
		}
		const gptMatch = lower.match(/gpt-?(?:v)?(\d+)(?:[.\-_](\d+))?/)
		if (gptMatch) {
			const major = parseInt(gptMatch[1], 10)
			const minor = gptMatch[2] ? parseInt(gptMatch[2], 10) : 0
			return major + minor / 10
		}
	} else if (family === "deepseek") {
		const vMatch = lower.match(/deepseek-?(?:v)(\d+)(?:[.\-_](\d+))?/)
		if (vMatch) {
			const major = parseInt(vMatch[1], 10)
			const minor = vMatch[2] ? parseInt(vMatch[2], 10) : 0
			return major + minor / 10
		}
		const rMatch = lower.match(/deepseek-?(?:r)(\d+)(?:[.\-_](\d+))?/)
		if (rMatch) {
			const major = parseInt(rMatch[1], 10)
			const minor = rMatch[2] ? parseInt(rMatch[2], 10) : 0
			return major + minor / 10
		}
		if (lower.includes("chat")) return 3.0
		if (lower.includes("reasoner")) return 1.0
	} else if (family === "gemini") {
		const geminiMatch = lower.match(/gemini-?(?:v)?(\d+)(?:[.\-_](\d+))?/)
		if (geminiMatch) {
			const major = parseInt(geminiMatch[1], 10)
			const minor = geminiMatch[2] ? parseInt(geminiMatch[2], 10) : 0
			return major + minor / 10
		}
	} else if (family === "qwen") {
		const qwenMatch = lower.match(/qwen-?(?:v)?(\d+)(?:[.\-_](\d+))?/)
		if (qwenMatch) {
			const major = parseInt(qwenMatch[1], 10)
			const minor = qwenMatch[2] ? parseInt(qwenMatch[2], 10) : 0
			return major + minor / 10
		}
	}

	const genericMatch = lower.match(/(?:v)?(\d+)[.\-_](\d+)/)
	if (genericMatch) {
		return parseInt(genericMatch[1], 10) + parseInt(genericMatch[2], 10) / 10
	}
	const singleNum = lower.match(/(?:v|-)(\d+)(?:$|[^0-9])/)
	if (singleNum) {
		return parseInt(singleNum[1], 10)
	}

	return 0
}

export const getModelTierScore = (id: string): number => {
	const lower = id.toLowerCase()
	let score = 0
	if (lower.includes("opus")) score += 30
	else if (lower.includes("sonnet") || lower.includes("pro") || lower.includes("max")) score += 20
	else if (lower.includes("plus") || lower.includes("chat") || lower.includes("reasoner")) score += 15
	else if (
		lower.includes("mini") ||
		lower.includes("flash") ||
		lower.includes("haiku") ||
		lower.includes("turbo") ||
		lower.includes("lite")
	)
		score += 5
	else score += 10

	if (
		lower.includes("reason") ||
		lower.includes("r1") ||
		lower.includes("o1") ||
		lower.includes("o3") ||
		lower.includes("thinking")
	) {
		score += 5
	}
	return score
}

export const compareModels = (a: ModelItem, b: ModelItem): number => {
	const getFamilyPriority = (family: ModelFamily) => modelFamilyOrder.indexOf(family)

	const famA = extractModelFamily(a.id)
	const famB = extractModelFamily(b.id)
	const prioA = getFamilyPriority(famA)
	const prioB = getFamilyPriority(famB)

	if (prioA !== prioB) return prioA - prioB

	if (famA !== "other") {
		const versionA = modelVersionParts(a.id)
		const versionB = modelVersionParts(b.id)
		for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
			const difference = (versionB[i] || 0) - (versionA[i] || 0)
			if (difference) return difference
		}

		// Inside same version: sort descending by tier score
		const tierA = getModelTierScore(a.id)
		const tierB = getModelTierScore(b.id)
		if (tierA !== tierB) return tierB - tierA
	}

	return (
		a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) ||
		a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true })
	)
}

export const promoteDynamicFlagships = (models: ModelItem[]): Set<string> => {
	const flagshipIds = new Set<string>()
	const families: ModelFamily[] = ["claude", "openai", "deepseek", "gemini", "qwen"]

	const familyModels = new Map<ModelFamily, ModelItem[]>()
	for (const f of families) familyModels.set(f, [])

	for (const m of models) {
		const fam = extractModelFamily(m.id)
		if (familyModels.has(fam)) {
			familyModels.get(fam)!.push(m)
		}
	}

	for (const list of familyModels.values()) {
		list.sort(compareModels)
	}

	const candidates: string[] = []

	// 1. Claude: top 1
	const claudeList = familyModels.get("claude") || []
	if (claudeList.length > 0) candidates.push(claudeList[0].id)

	// 2. OpenAI: top general
	const openaiList = familyModels.get("openai") || []
	const openaiGeneral = openaiList.find((m) => !m.isReasoning)
	const openaiReasoning = openaiList.find((m) => m.isReasoning)
	if (openaiGeneral) candidates.push(openaiGeneral.id)

	// 3. DeepSeek: top reasoning + top chat
	const dsList = familyModels.get("deepseek") || []
	const dsReasoning = dsList.find((m) => m.isReasoning)
	const dsChat = dsList.find((m) => !m.isReasoning)
	if (dsReasoning) candidates.push(dsReasoning.id)
	if (dsChat && dsChat.id !== dsReasoning?.id) candidates.push(dsChat.id)

	// 4. Gemini: top model
	const geminiList = familyModels.get("gemini") || []
	if (geminiList.length > 0) candidates.push(geminiList[0].id)

	// 5. Qwen: top model (prefer coder)
	const qwenList = familyModels.get("qwen") || []
	const qwenCoder = qwenList.find((m) => m.isCoder) || qwenList[0]
	if (qwenCoder) candidates.push(qwenCoder.id)

	// 6. Secondary OpenAI reasoning if available
	if (openaiReasoning && openaiReasoning.id !== openaiGeneral?.id) candidates.push(openaiReasoning.id)

	// Deduplicate and cap at 8 models so all 5 major families have their flagships represented
	const finalCandidates = Array.from(new Set(candidates)).slice(0, 8)
	finalCandidates.forEach((id) => flagshipIds.add(id))

	return flagshipIds
}

export const isReasoningModel = (id: string, info?: ModelInfo): boolean => {
	const lower = (id || "").toLowerCase()
	return !!(
		info?.supportsReasoningEffort ||
		(Array.isArray(info?.reasoningEffortLevels) && info.reasoningEffortLevels.length > 0) ||
		info?.supportsReasoningBudget ||
		info?.maxThinkingTokens ||
		info?.reasoningEffort ||
		modelSupportsReasoning(id, info) ||
		lower.includes("reasoner") ||
		lower.includes("reasoning") ||
		lower.includes("thinking") ||
		lower.includes("thought") ||
		lower.includes("gpt-5") ||
		/(?:^|[\/_\-])r[1-9](?:[\/_\-]|$)/i.test(lower) ||
		/(?:^|[\/_\-])o[1-9](?:[\/_\-]|$)/i.test(lower) ||
		lower.includes("claude-3-7") ||
		lower.includes("claude-3.7")
	)
}

// Re-export centralized display name formatters
export { cleanModelDisplayName, formatModelDisplayName }

export function getCanonicalModelKey(provider: string | undefined, modelId: string | undefined): string {
	if (!modelId) return ""
	const prov = (provider || "").toLowerCase().trim()
	const trimmed = modelId.trim()
	const colonIdx = trimmed.indexOf(":")
	const tag = colonIdx !== -1 ? trimmed.slice(colonIdx).toLowerCase() : ""
	const beforeTag = colonIdx !== -1 ? trimmed.slice(0, colonIdx) : trimmed

	if (prov === "xkiro" || prov === "openai") {
		const slashIdx = beforeTag.indexOf("/")
		const bareName = slashIdx !== -1 ? beforeTag.slice(slashIdx + 1) : bareNameBeforeTag(beforeTag)
		return `${prov}:${bareName.toLowerCase()}${tag}`
	}
	return `${prov}:${trimmed.toLowerCase()}`
}

function bareNameBeforeTag(beforeTag: string): string {
	const slashIdx = beforeTag.indexOf("/")
	return slashIdx !== -1 ? beforeTag.slice(slashIdx + 1) : beforeTag
}

export const isFastModel = (id: string, isReasoning = false): boolean => {
	if (isReasoning) return false
	const lower = id.toLowerCase()
	return (
		lower.includes("flash") ||
		lower.includes("mini") ||
		lower.includes("haiku") ||
		lower.includes("turbo") ||
		lower.includes("lite") ||
		lower.includes("fast") ||
		lower.includes("8b") ||
		lower.includes("7b")
	)
}

export const isCoderModel = (id: string): boolean => {
	const lower = id.toLowerCase()
	return lower.includes("coder") || lower.includes("code") || lower.includes("dev")
}

export const isVisionModel = (id: string, info?: ModelInfo): boolean => {
	if (info?.supportsImages !== undefined) return Boolean(info.supportsImages)
	const lower = id.toLowerCase()
	return lower.includes("vision") || lower.includes("vl") || lower.includes("omni") || lower.includes("multimodal")
}

export const sanitizeCustomModelId = (rawModelId: string): string => {
	if (!rawModelId) return ""

	// Sanitize: strip control characters, whitespace, newlines, and special characters (#, ?, &)
	let sanitized = rawModelId
		.replace(/[\u0000-\u001f\u007f-\u009f\s#?&]+/g, "")
		.replace(/\.\.+[/\\]/g, "")
	if (!sanitized) return ""

	// Apply encodeURIComponent for URL fragments/segments (preserving path delimiters /, :, and @)
	try {
		sanitized = sanitized
			.split("/")
			.map((segment) =>
				segment
					.split(":")
					.map((part) => encodeURIComponent(decodeURIComponent(part)).replace(/%40/g, "@"))
					.join(":"),
			)
			.join("/")
	} catch {
		sanitized = sanitized
			.split("/")
			.map((segment) =>
				segment
					.split(":")
					.map((part) => encodeURIComponent(part).replace(/%40/g, "@"))
					.join(":"),
			)
			.join("/")
	}

	return sanitized
}

export const formatContextWindow = (tokens?: number): string | null => {
	if (!tokens) return null
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
	return `${tokens}`
}

const ProviderIcon = ({ provider, className }: { provider: string; className?: string }) => {
	switch (provider) {
		case "xkiro":
			return <Sparkles className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "anthropic":
			return <Brain className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "gemini":
			return <Sparkles className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "deepseek":
			return <Cpu className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "openrouter":
			return <Layers className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "openai":
		case "openai-native":
			return <Bot className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		case "ollama":
		case "lmstudio":
			return <Server className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
		default:
			return <Sparkles className={cn("size-3.5 text-vscode-descriptionForeground flex-shrink-0", className)} />
	}
}

export const ModelSelector = ({
	disabled = false,
	triggerClassName = "",
	triggerTestId,
	currentConfigId: propCurrentConfigId,
	displayName: propDisplayName,
	listApiConfigMeta: propListApiConfigMeta,
	pinnedApiConfigs: propPinnedApiConfigs,
	togglePinnedApiConfig: propTogglePinnedApiConfig,
	lockApiConfigAcrossModes: propLockApiConfigAcrossModes,
	onToggleLockApiConfig,
	onApiConfigChange,
}: ModelSelectorProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [searchQuery, setSearchQuery] = useState("")
	const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set(modelFamilyOrder))
	const [customModelInput, setCustomModelInput] = useState("")
	const [selectedCategory, setSelectedCategory] = useState<ModelCategory>("all")
	const searchInputRef = useRef<HTMLInputElement>(null)
	const portalContainer = useRooPortal("roo-portal")

	const [isRefreshingModels, setIsRefreshingModels] = useState(false)

	const {
		apiConfiguration,
		currentApiConfigName: extCurrentApiConfigName,
		setApiConfiguration,
		routerModels,
		openAiModels,
		openAiModelInfos,
		listApiConfigMeta: extListApiConfigMeta,
		pinnedApiConfigs: extPinnedApiConfigs,
		togglePinnedApiConfig: extTogglePinnedApiConfig,
		lockApiConfigAcrossModes: extLockApiConfigAcrossModes,
		recentModels: extRecentModels,
		setRecentModels,
		currentTaskItem,
	} = useExtensionState()

	useEffect(() => {
		const handleIncoming = (event: MessageEvent) => {
			if (event.data?.type === "openAiModels" || event.data?.type === "testConnectionResult") {
				setIsRefreshingModels(false)
			}
		}
		window.addEventListener("message", handleIncoming)
		return () => window.removeEventListener("message", handleIncoming)
	}, [])

	const effectiveListApiConfigMeta = propListApiConfigMeta ?? extListApiConfigMeta ?? []
	const effectivePinnedApiConfigs = propPinnedApiConfigs ?? extPinnedApiConfigs ?? {}
	const effectiveTogglePinnedApiConfig = propTogglePinnedApiConfig ?? extTogglePinnedApiConfig
	const effectiveLockApiConfigAcrossModes = propLockApiConfigAcrossModes ?? extLockApiConfigAcrossModes ?? false
	const effectiveProfileName = propDisplayName || extCurrentApiConfigName || "default"
	const activeConfigId =
		propCurrentConfigId || effectiveListApiConfigMeta.find((c) => c.name === effectiveProfileName)?.id || ""

	const { id: activeModelId, info: activeModelInfo, isUnavailable } = useSelectedModel(apiConfiguration)
	const activeProvider = (apiConfiguration?.apiProvider || "xkiro") as ProviderName

	// When actively streaming, the selector is locked and reflects the in-flight execution model.
	// When interactive (idle, paused, interrupted, awaiting continue), it reflects the user's selected model for the next continuation.
	const isTaskStreaming = Boolean(disabled && currentTaskItem?.executionModelId)
	const effectiveModelId =
		(isTaskStreaming ? currentTaskItem?.executionModelId : activeModelId || currentTaskItem?.executionModelId) || ""
	const effectiveProvider = (
		isTaskStreaming && currentTaskItem?.executionProvider
			? currentTaskItem.executionProvider
			: activeProvider || currentTaskItem?.executionProvider || "xkiro"
	) as ProviderName

	const effectiveModelInfo = useMemo(() => {
		if (effectiveModelId === activeModelId) {
			return activeModelInfo
		}
		if (effectiveModelId && openAiModelInfos?.[effectiveModelId]) {
			return openAiModelInfos[effectiveModelId]
		}
		if (effectiveModelId && effectiveProvider && MODELS_BY_PROVIDER[effectiveProvider]?.[effectiveModelId]) {
			return MODELS_BY_PROVIDER[effectiveProvider][effectiveModelId]
		}
		return undefined
	}, [effectiveModelId, activeModelId, activeModelInfo, openAiModelInfos, effectiveProvider])

	const handleRefreshModels = useCallback(() => {
		setIsRefreshingModels(true)
		const isXkiro = activeProvider === "xkiro"
		vscode.postMessage({
			type: "requestOpenAiModels",
			values: {
				provider: activeProvider,
				baseUrl: isXkiro
					? apiConfiguration?.xkiroBaseUrl || "https://api.xkiro.com/v1"
					: apiConfiguration?.openAiBaseUrl,
				apiKey: isXkiro
					? apiConfiguration?.xkiroApiKey || apiConfiguration?.apiKey
					: apiConfiguration?.openAiApiKey || apiConfiguration?.apiKey,
			},
		})
		setTimeout(() => setIsRefreshingModels(false), 10000)
	}, [activeProvider, apiConfiguration])

	// Silent background auto-fetch on mount / provider change when models list is uninitialized
	const autoFetchedProvidersRef = useRef<Set<string>>(new Set())
	useEffect(() => {
		const isTargetProvider = activeProvider === "xkiro" || activeProvider === "openai"
		if (!isTargetProvider) return

		const hasNoModels = !openAiModels || openAiModels.length === 0
		const apiKey =
			activeProvider === "xkiro"
				? apiConfiguration?.xkiroApiKey || apiConfiguration?.apiKey
				: apiConfiguration?.openAiApiKey || apiConfiguration?.apiKey

		if (hasNoModels && apiKey && !autoFetchedProvidersRef.current.has(activeProvider)) {
			autoFetchedProvidersRef.current.add(activeProvider)
			const baseUrl =
				activeProvider === "xkiro"
					? apiConfiguration?.xkiroBaseUrl || "https://api.xkiro.com/v1"
					: apiConfiguration?.openAiBaseUrl

			vscode.postMessage({
				type: "requestOpenAiModels",
				values: {
					provider: activeProvider,
					baseUrl,
					apiKey,
				},
			})
		}
	}, [activeProvider, openAiModels, apiConfiguration])

	// Friendly name for the model displayed in the selector (prioritizes active task execution snapshot)
	const effectiveDisplayName = useMemo(() => {
		if (!effectiveModelId) {
			return t("chat:modelSelector.selectModel") || "Select model"
		}
		return cleanModelDisplayName(effectiveModelId, effectiveModelInfo)
	}, [effectiveModelId, effectiveModelInfo, t])
	const activeDisplayName = effectiveDisplayName

	// Available models for the current provider
	const availableModels = useMemo<ModelItem[]>(() => {
		const canonicalMap = new Map<string, ModelItem>()

		const addOrMergeModel = (item: ModelItem) => {
			const key = getCanonicalModelKey(activeProvider, item.id)
			const existing = canonicalMap.get(key)
			if (!existing) {
				canonicalMap.set(key, { ...item })
				return
			}
			// Prefer vendor-namespaced ID (e.g. "openai/gpt-6.1-sol" over "gpt-6.1-sol")
			if (!existing.id.includes("/") && item.id.includes("/")) {
				existing.id = item.id
				existing.name = item.name
			}
			// Merge metadata: keep existing or incoming richest info
			if (!existing.contextWindow && item.contextWindow) existing.contextWindow = item.contextWindow
			if (!existing.description && item.description) existing.description = item.description
			if (!existing.modelInfo && item.modelInfo) existing.modelInfo = item.modelInfo
			if (!existing.badge && item.badge) existing.badge = item.badge
			if (item.isReasoning) existing.isReasoning = true
			if (item.isFast) existing.isFast = true
			if (item.isCoder) existing.isCoder = true
			if (item.isVision) existing.isVision = true
			if (item.isFlagship) existing.isFlagship = true
		}

		// 1. Static models from MODELS_BY_PROVIDER
		const staticMap = MODELS_BY_PROVIDER[activeProvider]
		if (staticMap) {
			Object.entries(staticMap).forEach(([id, info]) => {
				const isReasoning = isReasoningModel(id, info)
				const isFast = isFastModel(id, isReasoning)
				const isCoder = isCoderModel(id)
				const isVision = isVisionModel(id, info)
				addOrMergeModel({
					id,
					name: cleanModelDisplayName(id, info),
					contextWindow: info.contextWindow,
					isReasoning,
					isFast,
					isCoder,
					isVision,
					badge: isReasoning
						? "Rozumowanie"
						: isFast
							? "Szybkość"
							: isCoder
								? "Programowanie"
								: isVision
									? "Obrazy"
									: undefined,
					description: info.description,
					modelInfo: info,
				})
			})
		}

		// 1.5. Dynamic models for xKiro & OpenAI-compatible
		if (activeProvider === "xkiro" || activeProvider === "openai") {
			if (openAiModels && openAiModels.length > 0) {
				openAiModels.forEach((id) => {
					const strippedId = stripModelTag(id)
					const dynamicInfo = openAiModelInfos?.[id] || openAiModelInfos?.[strippedId]
					const dynamicContext = dynamicInfo?.contextWindow
					const isReasoning = isReasoningModel(id, dynamicInfo)
					const isFast = isFastModel(id, isReasoning)
					const isCoder = isCoderModel(id)
					const isVision = isVisionModel(id, dynamicInfo)

					const badge = isReasoning
						? "Rozumowanie"
						: isFast
							? "Szybkość"
							: isCoder
								? "Programowanie"
								: isVision
									? "Obrazy"
									: undefined

					addOrMergeModel({
						id,
						name: cleanModelDisplayName(id, dynamicInfo),
						contextWindow: getModelContextWindow(id, dynamicContext),
						isReasoning,
						isFast,
						isCoder,
						isVision,
						badge,
						modelInfo: dynamicInfo,
					})
				})
			}
		}

		// 1.6. Explicit xKiro presets
		if (activeProvider === "xkiro") {
			const xkiroPresets = [
				{
					id: "deepseek/deepseek-chat",
					name: "DeepSeek V3",
					isReasoning: false,
					isFast: false,
					isFlagship: true,
					contextWindow: 128000,
					description: "xKiro DeepSeek-V3: Szybki model do zadań ogólnych.",
				},
				{
					id: "deepseek/deepseek-reasoner",
					name: "DeepSeek R1",
					isReasoning: true,
					isFast: false,
					isFlagship: true,
					badge: "Rozumowanie",
					contextWindow: 128000,
					description: "xKiro DeepSeek-R1: Zaawansowane rozumowanie i analiza.",
				},
				{
					id: "anthropic/claude-3.7-sonnet",
					name: "Claude 3.7 Sonnet",
					isReasoning: true,
					isFast: false,
					isFlagship: true,
					badge: "Rozumowanie",
					contextWindow: 200000,
					description: "xKiro Claude 3.7 Sonnet: Rozumowanie i programowanie w jednym modelu.",
				},
				{
					id: "anthropic/claude-3.5-sonnet",
					name: "Claude 3.5 Sonnet",
					isReasoning: false,
					isFast: false,
					contextWindow: 200000,
					description: "xKiro Claude 3.5 Sonnet: Model do programowania i analizy kodu.",
				},
				{
					id: "openai/gpt-6-astra",
					name: "GPT-6 Astra",
					isReasoning: true,
					isFast: false,
					isFlagship: true,
					badge: "Rozumowanie",
					contextWindow: 1000000,
					description: "xKiro GPT-6 Astra: Zaawansowany model z kontekstem 1 mln tokenów.",
				},
				{
					id: "openai/gpt-5",
					name: "GPT-5",
					isReasoning: true,
					isFast: false,
					isFlagship: true,
					badge: "Rozumowanie",
					contextWindow: 400000,
					description: "xKiro GPT-5: Model OpenAI z rozumowaniem i kontekstem 400 tys. tokenów.",
				},
				{
					id: "openai/gpt-5-mini",
					name: "GPT-5 Mini",
					isReasoning: true,
					isFast: false,
					isFlagship: false,
					badge: "Rozumowanie",
					contextWindow: 400000,
					description: "xKiro GPT-5 Mini: Szybki model z rozumowaniem i kontekstem 400 tys. tokenów.",
				},
				{
					id: "openai/gpt-4o",
					name: "GPT-4o",
					isReasoning: false,
					isFast: false,
					isFlagship: true,
					contextWindow: 128000,
					description: "xKiro GPT-4o: Wszechstronny model multimodalny OpenAI.",
				},
				{
					id: "openai/o3-mini",
					name: "o3-mini",
					isReasoning: true,
					isFast: false,
					badge: "Rozumowanie",
					contextWindow: 200000,
					description: "xKiro o3-mini: Szybki model z rozumowaniem.",
				},
				{
					id: "google/gemini-2.5-pro",
					name: "Gemini 2.5 Pro",
					isReasoning: false,
					isFast: false,
					isFlagship: true,
					contextWindow: 1000000,
					description: "xKiro Gemini 2.5 Pro: Zaawansowana analiza z kontekstem 1 mln tokenów.",
				},
				{
					id: "google/gemini-2.5-flash",
					name: "Gemini 2.5 Flash",
					isReasoning: false,
					isFast: true,
					badge: "Szybkość",
					contextWindow: 1000000,
					description: "xKiro Gemini 2.5 Flash: Lekki, szybki model z kontekstem 1 mln tokenów.",
				},
				{
					id: "qwen/qwen-2.5-coder-32b",
					name: "Qwen 2.5 Coder 32B",
					isReasoning: false,
					isFast: true,
					isCoder: true,
					isFlagship: true,
					badge: "Programowanie",
					contextWindow: 128000,
					description: "xKiro Qwen 2.5 Coder: Otwarty model do programowania.",
				},
			]
			xkiroPresets.forEach((p) => {
				addOrMergeModel({
					...p,
					contextWindow: getModelContextWindow(p.id, p.contextWindow),
				})
			})
		}

		// 2. OpenRouter dynamic models
		if (activeProvider === "openrouter") {
			const orModels = routerModels?.openrouter
			if (orModels && Object.keys(orModels).length > 0) {
				Object.entries(orModels).forEach(([id, info]) => {
					const isReasoning = isReasoningModel(id, info)
					const isFast = isFastModel(id, isReasoning)
					const isCoder = isCoderModel(id)
					const isVision = isVisionModel(id, info)
					addOrMergeModel({
						id,
						name: cleanModelDisplayName(id, info),
						contextWindow: info.contextWindow,
						isReasoning,
						isFast,
						isCoder,
						isVision,
						badge: isReasoning
							? "Rozumowanie"
							: isFast
								? "Szybkość"
								: isCoder
									? "Programowanie"
									: isVision
										? "Obrazy"
										: undefined,
						description: info.description,
						modelInfo: info,
					})
				})
			} else {
				const orPresets = [
					{ id: "deepseek/deepseek-chat", name: "DeepSeek V3", isReasoning: false, isFast: false },
					{
						id: "deepseek/deepseek-r1",
						name: "DeepSeek R1",
						isReasoning: true,
						isFast: false,
						badge: "Rozumowanie",
					},
					{ id: "anthropic/claude-3.7-sonnet", name: "Claude 3.7 Sonnet", isReasoning: false, isFast: false, isVision: true },
					{ id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", isReasoning: false, isFast: false, isVision: true },
					{ id: "openai/gpt-4o", name: "GPT-4o", isReasoning: false, isFast: false, isVision: true },
					{ id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", isReasoning: false, isFast: false, isVision: true },
				]
				orPresets.forEach((p) => {
					addOrMergeModel(p)
				})
			}
		}

		// 3. OpenAI Compatible presets
		if (activeProvider === "openai") {
			const openaiPresets = [
				{ id: "gpt-4o", name: "GPT-4o", isReasoning: false, isFast: false, isVision: true },
				{ id: "gpt-4o-mini", name: "GPT-4o Mini", isReasoning: false, isFast: true, isVision: true, badge: "Szybkość" },
				{ id: "o3-mini", name: "o3-mini", isReasoning: true, isFast: false, badge: "Rozumowanie" },
				{ id: "deepseek-chat", name: "DeepSeek V3", isReasoning: false, isFast: false },
				{
					id: "deepseek-reasoner",
					name: "DeepSeek R1",
					isReasoning: true,
					isFast: false,
					badge: "Rozumowanie",
				},
			]
			openaiPresets.forEach((p) => {
				addOrMergeModel(p)
			})
		}

		// 4. Ollama presets
		if (activeProvider === "ollama") {
			const ollamaPresets = [
				{ id: "llama3.1", name: "Llama 3.1", isReasoning: false, isFast: false },
				{
					id: "qwen2.5-coder:7b",
					name: "Qwen 2.5 Coder 7B",
					isReasoning: false,
					isFast: true,
					isCoder: true,
					badge: "Szybkość",
				},
				{
					id: "deepseek-r1:8b",
					name: "DeepSeek R1 8B",
					isReasoning: true,
					isFast: false,
					badge: "Rozumowanie",
				},
			]
			ollamaPresets.forEach((p) => {
				addOrMergeModel(p)
			})
		}

		// 5. Ensure current active model is present if not already in list
		if (activeModelId) {
			const canonKey = getCanonicalModelKey(activeProvider, activeModelId)
			if (!canonicalMap.has(canonKey)) {
				const isReasoning = isReasoningModel(activeModelId, activeModelInfo)
				const isFast = isFastModel(activeModelId, isReasoning)
				const isCoder = isCoderModel(activeModelId)
				const isVision = isVisionModel(activeModelId, activeModelInfo)
				addOrMergeModel({
					id: activeModelId,
					name: cleanModelDisplayName(activeModelId, activeModelInfo),
					contextWindow: activeModelInfo?.contextWindow,
					isReasoning,
					isFast,
					isCoder,
					isVision,
					badge: isReasoning
						? "Rozumowanie"
						: isFast
							? "Szybkość"
							: isCoder
								? "Programowanie"
								: isVision
									? "Obrazy"
									: undefined,
					modelInfo: activeModelInfo,
				})
			}
		}

		// Preserve custom models from history in their own families, without a separate recent section.
		for (const recent of extRecentModels || []) {
			if (!recent.isCustom || (recent.provider && recent.provider.toLowerCase() !== activeProvider.toLowerCase()))
				continue
			if (canonicalMap.has(getCanonicalModelKey(activeProvider, recent.id))) continue
			const isReasoning = isReasoningModel(recent.id)
			addOrMergeModel({
				id: recent.id,
				name: recent.name || cleanModelDisplayName(recent.id),
				contextWindow: getModelContextWindow(recent.id),
				isReasoning,
				isFast: isFastModel(recent.id, isReasoning),
				isCoder: isCoderModel(recent.id),
				isVision: isVisionModel(recent.id),
			})
		}
		const result = Array.from(canonicalMap.values())

		// 7. Hierarchical sort: family priority + generation descending
		result.sort(compareModels)

		return result
	}, [activeProvider, routerModels, openAiModels, openAiModelInfos, activeModelId, activeModelInfo, extRecentModels])

	// Filter models by category and search query
	const filteredModels = useMemo(() => {
		let list = availableModels

		if (selectedCategory === "reasoning") {
			list = list.filter((m) => m.isReasoning)
		} else if (selectedCategory === "fast") {
			list = list.filter((m) => m.isFast)
		} else if (selectedCategory === "coder") {
			list = list.filter((m) => m.isCoder)
		} else if (selectedCategory === "vision") {
			list = list.filter((m) => m.isVision)
		} else if (selectedCategory === "default") {
			list = list.filter((m) => !m.isReasoning && !m.isFast && !m.isCoder && !m.isVision)
		}

		if (!searchQuery.trim()) return list
		const q = searchQuery.toLowerCase().trim()
		return list.filter(
			(m) =>
				m.name.toLowerCase().includes(q) ||
				m.id.toLowerCase().includes(q) ||
				(m.description && m.description.toLowerCase().includes(q)),
		)
	}, [availableModels, selectedCategory, searchQuery])

	// Category counts for tags
	const categoryCounts = useMemo(() => {
		let reasoning = 0
		let fast = 0
		let coder = 0
		let vision = 0
		let general = 0

		availableModels.forEach((m) => {
			if (m.isReasoning) reasoning++
			if (m.isFast) fast++
			if (m.isCoder) coder++
			if (m.isVision) vision++
			if (!m.isReasoning && !m.isFast && !m.isCoder && !m.isVision) general++
		})

		return {
			all: availableModels.length,
			reasoning,
			fast,
			coder,
			vision,
			default: general,
		}
	}, [availableModels])

	const familyGroups = useMemo(
		() =>
			modelFamilyOrder
				.map((family) => ({
					family,
					models: filteredModels.filter((m) => extractModelFamily(m.id) === family).sort(compareModels),
				}))
				.filter((group) => group.models.length > 0),
		[filteredModels],
	)

	useEffect(() => {
		setCollapsedSections(new Set(searchQuery.trim() || selectedCategory !== "all" ? [] : modelFamilyOrder))
	}, [searchQuery, selectedCategory])

	const toggleSection = (key: string) =>
		setCollapsedSections((previous) => {
			const next = new Set(previous)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})

	// Switch model
	const handleSelectModel = useCallback(
		(modelId: string, isCustom = false) => {
			const provider = (apiConfiguration?.apiProvider || "xkiro") as ProviderName
			const updatedConfig: ProviderSettings = {
				...apiConfiguration,
			}
			setModelId(updatedConfig, provider, modelId)

			// Check if target model supports reasoning
			const targetModelItem = availableModels.find((m) => m.id === modelId)
			const targetModelInfo =
				targetModelItem?.modelInfo ||
				MODELS_BY_PROVIDER[provider]?.[modelId] ||
				(provider === "openrouter" ? routerModels?.openrouter?.[modelId] : undefined) ||
				openAiModelInfos?.[modelId] ||
				openAiModelInfos?.[stripModelTag(modelId)]
			const targetSupportsReasoning =
				!!targetModelInfo?.supportsReasoningEffort ||
				(Array.isArray(targetModelInfo?.reasoningEffortLevels) &&
					targetModelInfo.reasoningEffortLevels.length > 0) ||
				!!targetModelInfo?.supportsReasoningBudget ||
				!!targetModelInfo?.maxThinkingTokens ||
				!!targetModelItem?.isReasoning ||
				isReasoningModel(modelId, targetModelInfo)

			if (!targetSupportsReasoning) {
				delete updatedConfig.reasoningEffort
				updatedConfig.enableReasoningEffort = false
			} else {
				// Target model supports reasoning - handle clamping or preserving effort
				const rawAllowed =
					targetModelInfo?.reasoningEffortLevels ||
					(Array.isArray(targetModelInfo?.supportsReasoningEffort)
						? targetModelInfo.supportsReasoningEffort
						: undefined)

				const allowedLevels =
					rawAllowed && Array.isArray(rawAllowed) && rawAllowed.length > 0
						? rawAllowed.filter((l) => l !== "none" && l !== "disable")
						: undefined

				const currentEffort = updatedConfig.reasoningEffort?.toLowerCase()
				if (currentEffort && currentEffort !== "disable") {
					if (allowedLevels && allowedLevels.length > 0) {
						const isAllowed = allowedLevels.some((l) => l.toLowerCase() === currentEffort)
						if (!isAllowed) {
							// Clamp to "medium" if allowed, or first available
							const hasMedium = allowedLevels.some((l) => l.toLowerCase() === "medium")
							const clamped = hasMedium ? "medium" : allowedLevels[0].toLowerCase()
							updatedConfig.reasoningEffort = clamped as any
							updatedConfig.enableReasoningEffort = true
						}
					} else if (targetModelInfo?.supportsReasoningEffort === true) {
						// Standard levels: low, medium, high
						const standardLevels = ["low", "medium", "high"]
						if (!standardLevels.includes(currentEffort)) {
							updatedConfig.reasoningEffort = "medium"
							updatedConfig.enableReasoningEffort = true
						}
					}
				} else if (currentEffort === "disable") {
					updatedConfig.reasoningEffort = "disable" as any
					updatedConfig.enableReasoningEffort = false
				} else {
					// Coming from non-reasoning model: initialize to default reasoning effort
					const defaultLevel =
						targetModelInfo?.reasoningEffort ||
						(allowedLevels && allowedLevels.length > 0
							? allowedLevels.some((l) => l.toLowerCase() === "medium")
								? "medium"
								: allowedLevels[0].toLowerCase()
							: "medium")
					updatedConfig.reasoningEffort = defaultLevel as any
					updatedConfig.enableReasoningEffort = true
				}
			}
			delete updatedConfig.modelMaxTokens
			delete updatedConfig.modelMaxThinkingTokens

			// Only update openAiCustomModelInfo if it already exists as an explicit custom configuration
			if (updatedConfig.openAiCustomModelInfo) {
				const strippedId = stripModelTag(modelId)
				const liveContext =
					targetModelItem?.contextWindow ||
					openAiModelInfos?.[modelId]?.contextWindow ||
					openAiModelInfos?.[strippedId]?.contextWindow
				const resolvedContextWindow = liveContext || getModelContextWindow(modelId)
				updatedConfig.openAiCustomModelInfo = {
					...updatedConfig.openAiCustomModelInfo,
					contextWindow: resolvedContextWindow,
				}
			}

			// Update state locally immediately
			setApiConfiguration(updatedConfig)

			// Optimistically update recent models in extension state context
			if (setRecentModels) {
				const existing = extRecentModels || []
				const newEntry: RecentModel = {
					id: modelId,
					provider,
					name: cleanModelDisplayName(modelId),
					isCustom,
					reasoningEffort: updatedConfig.reasoningEffort,
					timestamp: Date.now(),
				}
				const filtered = existing.filter(
					(r) =>
						!(
							r.provider === provider &&
							(r.id === modelId || r.id.toLowerCase() === modelId.toLowerCase())
						),
				)
				setRecentModels([newEntry, ...filtered].slice(0, 5))
			}

			// Persist via engine
			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: extCurrentApiConfigName || "default",
				apiConfiguration: updatedConfig,
				...(isCustom ? { isCustomModel: true } : {}),
			})

			setOpen(false)
			setSearchQuery("")
		},
		[
			apiConfiguration,
			extCurrentApiConfigName,
			setApiConfiguration,
			availableModels,
			routerModels,
			openAiModelInfos,
			extRecentModels,
			setRecentModels,
		],
	)

	// Select custom model with sanitization
	const handleSelectCustomModel = useCallback(
		(rawModelId: string) => {
			const sanitized = sanitizeCustomModelId(rawModelId)
			if (!sanitized) return
			handleSelectModel(sanitized, true)
		},
		[handleSelectModel],
	)

	// Toggle lock across modes
	const handleToggleLock = useCallback(() => {
		if (onToggleLockApiConfig) {
			onToggleLockApiConfig()
		} else {
			vscode.postMessage({
				type: "lockApiConfigAcrossModes",
				bool: !effectiveLockApiConfigAcrossModes,
			})
		}
	}, [onToggleLockApiConfig, effectiveLockApiConfigAcrossModes])

	useEffect(() => {
		if (open && availableModels.length > 5 && searchInputRef.current) {
			searchInputRef.current.focus()
		}
	}, [open, availableModels.length])

	const providerDisplayNames: Record<string, string> = {
		xkiro: "xKiro",
		openrouter: "OpenRouter",
		anthropic: "Anthropic",
		gemini: "Gemini",
		deepseek: "DeepSeek",
		"openai-native": "OpenAI",
		openai: "OpenAI Compatible",
		ollama: "Ollama",
		lmstudio: "LM Studio",
		moonshot: "Moonshot",
		mistral: "Mistral",
		"qwen-code": "Qwen Code",
		vertex: "GCP Vertex",
		bedrock: "AWS Bedrock",
	}

	const effectiveProviderLabel = providerDisplayNames[effectiveProvider] || effectiveProvider
	const currentProviderLabel = effectiveProviderLabel

	// One compact row layout for every model family.
	const renderModelRow = useCallback(
		(m: ModelItem, sectionKey: string) => {
			const isSelected =
				getCanonicalModelKey(effectiveProvider, m.id) ===
				getCanonicalModelKey(effectiveProvider, effectiveModelId)
			const context = formatContextWindow(m.contextWindow)
			const variant = m.id.includes(":") ? m.id.slice(m.id.indexOf(":") + 1) : null
			const capability = m.isReasoning
				? { label: t("chat:modelSelector.badges.reasoning", "Rozumowanie"), Icon: Brain }
				: m.isCoder
					? { label: t("chat:modelSelector.badges.coding", "Programowanie"), Icon: Code2 }
					: m.isFast
						? { label: t("chat:modelSelector.badges.speed", "Szybki"), Icon: Zap }
						: m.isVision
							? { label: t("chat:modelSelector.badges.vision", "Obrazy"), Icon: Eye }
							: null
			return (
				<button
					type="button"
					key={`${sectionKey}-${m.id}`}
					data-model-option=""
					data-model-id={m.id}
					aria-pressed={isSelected}
					title={[
						m.id,
						m.description,
						m.contextWindow
							? `${t("chat:modelSelector.context", "Kontekst")}: ${new Intl.NumberFormat().format(m.contextWindow)} ${t("chat:modelSelector.tokens", "tokenów")}`
							: null,
					]
						.filter(Boolean)
						.join("\n")}
					onClick={() => handleSelectModel(m.id)}
					className="model-option">
					<ModelFamilyIcon family={extractModelFamily(m.id)} />
					<div className="model-option-content">
						<div className="model-option-heading">
							<span className="model-option-label">
								<span className="model-option-name">{m.name}</span>
								{variant && <span className="model-option-variant">{variant}</span>}
							</span>
							{isSelected && (
								<span className="model-option-selected">
									<Check aria-hidden="true" />
									{t("chat:modelSelector.selected", "Wybrany")}
								</span>
							)}
						</div>
						<div className="model-option-meta">
							<span className="model-option-provider" title={`${t("chat:modelSelector.apiProvider", "Dostawca API:")} ${currentProviderLabel}`}>
								{currentProviderLabel}
							</span>
							{capability ? (
								<span className="model-capability">
									<capability.Icon aria-hidden="true" />
									{capability.label}
								</span>
							) : (
								<span />
							)}
							<span className="model-option-context">
								<span>{t("chat:modelSelector.context", "Kontekst")}</span>
								<strong>{context || t("chat:modelSelector.noData", "Brak danych")}</strong>
							</span>
						</div>
					</div>
				</button>
			)
		},
		[effectiveModelId, effectiveProvider, currentProviderLabel, handleSelectModel, t],
	)

	// Keep keyboard navigation local to the search field and model rows.
	const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement
		const isSearch = target === searchInputRef.current
		if (!isSearch && !target.hasAttribute("data-model-option")) return
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
		if (isSearch && (event.key === "Home" || event.key === "End")) return
		const options = Array.from(
			event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-option]"),
		).filter((option) => !option.closest("[hidden]"))
		if (!options.length) return
		event.preventDefault()
		const index = options.indexOf(target as HTMLButtonElement)
		if (isSearch && event.key === "ArrowDown") {
			options[0]?.focus({ preventScroll: true })
			options[0]?.scrollIntoView?.({ block: "nearest" })
			return
		}
		if (!isSearch && index === 0 && event.key === "ArrowUp") {
			searchInputRef.current?.focus()
			return
		}
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? options.length - 1
					: event.key === "ArrowDown"
						? (index + 1) % options.length
						: index <= 0
							? options.length - 1
							: index - 1
		options[next].focus({ preventScroll: true })
		options[next].scrollIntoView?.({ block: "nearest" })
	}

	const renderCustomSearchOption = () => (
		<button
			type="button"
			data-model-option=""
			data-model-id={searchQuery.trim()}
			className="model-custom-result"
			onClick={() => handleSelectCustomModel(searchQuery.trim())}>
			<Plus aria-hidden="true" />
			<span>
				{t("chat:modelSelector.useModel", "Użyj modelu")} <strong>„{searchQuery.trim()}”</strong>
			</span>
		</button>
	)

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="model-selector-root">
			<StandardTooltip
				content={
					<div className="flex flex-col gap-0.5 text-xs text-left">
						<div className="font-semibold">{effectiveDisplayName}</div>
						<div className="text-vscode-descriptionForeground">{effectiveModelId}</div>
						<div className="text-vscode-descriptionForeground">
							{t("chat:modelSelector.provider", "Dostawca:")} {effectiveProviderLabel}
						</div>
					</div>
				}>
				<PopoverTrigger
					disabled={disabled}
					data-testid={triggerTestId || "model-selector-trigger"}
					className={cn(
						"agent-toolbar-control model-selector-trigger h-8 min-w-0 inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 text-xs bg-transparent border border-border/40 rounded-md text-vscode-foreground focus-visible:ring-1 focus-visible:ring-vscode-focusBorder",
						disabled
							? "opacity-50 cursor-not-allowed"
							: "hover:bg-vscode-toolbar-hoverBackground cursor-pointer",
						triggerClassName,
					)}>
					<ProviderIcon provider={effectiveProvider} />
					<span className="truncate font-medium">{effectiveDisplayName}</span>
					<span className="opacity-40" aria-hidden="true">
						·
					</span>
					<span className="truncate text-vscode-descriptionForeground">{effectiveProviderLabel}</span>
					<ChevronDown className="size-3 shrink-0 text-vscode-descriptionForeground" />
				</PopoverTrigger>
			</StandardTooltip>

			<PopoverContent
				align="start"
				sideOffset={8}
				collisionPadding={16}
				container={portalContainer}
				className="model-selector-panel"
				aria-label={t("chat:modelSelector.ariaSelectModel", "Wybór modelu AI")}
				onKeyDown={handlePanelKeyDown}
				onOpenAutoFocus={(event) => {
					event.preventDefault()
					searchInputRef.current?.focus()
				}}>
				<div className="model-selector-header">
					<div className="model-selector-titlebar">
						<div>
							<h3>{t("chat:modelSelector.title", "Wybierz model")}</h3>
							<div className="model-selector-source">
								<ProviderIcon provider={effectiveProvider} />
								<span>{t("chat:modelSelector.apiProvider", "Dostawca API:")} {currentProviderLabel}</span>
							</div>
						</div>
						<div className="model-selector-actions">
							<IconButton
								aria-pressed={effectiveLockApiConfigAcrossModes}
								iconClass={effectiveLockApiConfigAcrossModes ? "codicon-lock" : "codicon-unlock"}
								title={
									effectiveLockApiConfigAcrossModes
										? t("chat:unlockApiConfigAcrossModes")
										: t("chat:lockApiConfigAcrossModes")
								}
								className={cn(
									"model-selector-action",
									effectiveLockApiConfigAcrossModes && "is-locked",
								)}
								onClick={handleToggleLock}
							/>
							{(activeProvider === "xkiro" || activeProvider === "openai") && (
								<button
									type="button"
									className="model-selector-action"
									data-testid="refresh-models-button"
									aria-label={t("chat:modelSelector.refreshModels", "Odśwież modele")}
									title={
										isRefreshingModels
											? t("chat:modelSelector.refreshingModels", "Odświeżam modele…")
											: t("chat:modelSelector.refreshModels", "Odśwież modele")
									}
									disabled={isRefreshingModels}
									onClick={handleRefreshModels}>
									<RefreshCw className={cn(isRefreshingModels && "animate-spin")} />
								</button>
							)}
						</div>
					</div>

					<div className="model-selector-search">
						<Search aria-hidden="true" />
						<input
							ref={searchInputRef}
							aria-label={t("chat:modelSelector.searchPlaceholder")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									const options = Array.from(
										e.currentTarget
											.closest(".model-selector-popover")
											?.querySelectorAll<HTMLButtonElement>("[data-model-option]") || [],
									).filter((opt) => !opt.closest("[hidden]"))
									if (options.length > 0) {
										e.preventDefault()
										options[0].click()
									} else if (searchQuery.trim()) {
										e.preventDefault()
										handleSelectCustomModel(searchQuery.trim())
									}
								}
							}}
							placeholder={t("chat:modelSelector.searchPlaceholder")}
						/>
						{searchQuery && (
							<button
								type="button"
								aria-label={t("chat:modelSelector.clearSearch", "Wyczyść wyszukiwanie")}
								onClick={() => {
									setSearchQuery("")
									searchInputRef.current?.focus()
								}}>
								<X />
							</button>
						)}
					</div>

					<div className="model-selector-filters" role="group" aria-label={t("chat:modelSelector.filterModels", "Filtruj modele")}>
						{[
							{ key: "all", label: t("chat:modelSelector.filters.all", "Wszystkie"), count: categoryCounts.all },
							{ key: "reasoning", label: t("chat:modelSelector.filters.reasoning", "Rozumowanie"), count: categoryCounts.reasoning },
							{ key: "fast", label: t("chat:modelSelector.filters.fast", "Szybkie"), count: categoryCounts.fast },
							{ key: "coder", label: t("chat:modelSelector.filters.code", "Kod"), count: categoryCounts.coder },
							{ key: "vision", label: t("chat:modelSelector.filters.images", "Obrazy"), count: categoryCounts.vision },
							{ key: "default", label: t("chat:modelSelector.filters.general", "Ogólne"), count: categoryCounts.default },
						]
							.filter((cat) => cat.key === "all" || cat.count > 0)
							.map((cat) => (
								<button
									type="button"
									key={cat.key}
									aria-pressed={selectedCategory === cat.key}
									onClick={() => setSelectedCategory(cat.key as ModelCategory)}>
									{cat.label}
								</button>
							))}
					</div>
				</div>

				<div className="model-selector-list" aria-label={t("chat:modelSelector.availableModels", "Dostępne modele")}>
					{filteredModels.length === 0 ? (
						<div className="model-selector-empty">
							<p>{t("chat:modelSelector.noResults")}</p>
							{searchQuery.trim() ? (
								renderCustomSearchOption()
							) : (
								<button type="button" onClick={() => setSelectedCategory("all")}>
									{t("chat:modelSelector.showAllModels", "Pokaż wszystkie modele")}
								</button>
							)}
						</div>
					) : (
						<>
							{familyGroups.length > 0 && (
								<section
									className="model-selector-section model-family-section"
									aria-labelledby="models-all-heading">
									<div className="model-section-heading">
										<h4 id="models-all-heading">{t("chat:modelSelector.modelsByFamily", "Modele według rodzin")}</h4>
										<span>{filteredModels.length}</span>
									</div>
									{familyGroups.map(({ family, models }) => (
										<section
											key={family}
											className="model-family-group"
											data-model-family={family}
											aria-labelledby={"models-family-" + family + "-heading"}>
											<h5
												id={"models-family-" + family + "-heading"}
												className="model-family-heading">
												<button
													type="button"
													className="model-section-toggle"
													aria-expanded={!collapsedSections.has(family)}
													aria-controls={"models-family-" + family + "-list"}
													onClick={() => toggleSection(family)}>
													<ModelFamilyIcon family={family} />
													<span className="model-family-name">
														{family === "other"
															? t("chat:modelFamilies.other", { defaultValue: modelFamilies[family].name })
															: modelFamilies[family].name}
													</span>
													{modelFamilies[family].company !== modelFamilies[family].name && (
														<span className="model-family-company">
															{modelFamilies[family].company}
														</span>
													)}
													<span className="model-group-count" aria-hidden="true">
														{models.length}
													</span>
													<ChevronDown aria-hidden="true" />
												</button>
											</h5>
											<div
												id={"models-family-" + family + "-list"}
												hidden={collapsedSections.has(family)}>
												{models.map((m) => renderModelRow(m, family))}
											</div>
										</section>
									))}
								</section>
							)}
							{searchQuery.trim() &&
								!filteredModels.some((m) => m.id.toLowerCase() === searchQuery.trim().toLowerCase()) &&
								renderCustomSearchOption()}
						</>
					)}
				</div>

				<div className="model-selector-footer">
					<form
						onSubmit={(e) => {
							e.preventDefault()
							if (customModelInput.trim()) {
								handleSelectCustomModel(customModelInput.trim())
								setCustomModelInput("")
							}
						}}>
						<input
							type="text"
							aria-label={t("chat:modelSelector.customModelIdAria", "Własny identyfikator modelu")}
							value={customModelInput}
							onChange={(e) => setCustomModelInput(e.target.value)}
							placeholder={t("chat:modelSelector.customModelId", "Własny identyfikator modelu…")}
						/>
						<Button type="submit" disabled={!customModelInput.trim()} size="sm">
							{t("chat:modelSelector.selectButton", "Wybierz")}
						</Button>
					</form>
				</div>
			</PopoverContent>
		</Popover>
	)
}
