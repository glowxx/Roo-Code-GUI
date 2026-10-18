import React, { useState, useMemo, useCallback } from "react"
import { Brain, ChevronDown, Check } from "lucide-react"

import { type ProviderSettings, type ModelInfo, modelSupportsReasoning } from "@roo-code/types"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { useSelectedModel } from "@/components/ui/hooks/useSelectedModel"
import { useRooPortal } from "@/components/ui/hooks/useRooPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { vscode } from "@/utils/vscode"
import { isReasoningModel } from "./ModelSelector"

export type ReasoningEffortLevel = "Off" | "Low" | "Medium" | "High" | "Minimal" | "XHigh" | string

export interface ReasoningEffortButtonProps {
	disabled?: boolean
	className?: string
	modelId?: string
	modelInfo?: ModelInfo
}

export const formatEffortLabel = (level: string): string => {
	const lower = level.toLowerCase()
	if (lower === "off") return "Off"
	if (lower === "none") return "None"
	if (lower === "minimal") return "Minimal"
	if (lower === "low") return "Low"
	if (lower === "medium") return "Medium"
	if (lower === "high") return "High"
	if (lower === "xhigh") return "XHigh"
	return level.charAt(0).toUpperCase() + level.slice(1)
}

const DEFAULT_EFFORT_OPTIONS: readonly string[] = ["Off", "Low", "Medium", "High"]

export const ReasoningEffortButton: React.FC<ReasoningEffortButtonProps> = ({
	disabled = false,
	className,
	modelId: propModelId,
	modelInfo: propModelInfo,
}) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const portalContainer = useRooPortal("roo-portal")

	const getEffortLabel = useCallback(
		(level: string) => {
			const lower = level.toLowerCase()
			switch (lower) {
				case "off":
				case "none":
					return t("chat:reasoningEffort.none", { defaultValue: t("chat:effort.off", "None") })
				case "minimal":
					return t("chat:reasoningEffort.minimal", { defaultValue: t("chat:effort.minimal", "Minimal") })
				case "low":
					return t("chat:reasoningEffort.low", { defaultValue: t("chat:effort.low", "Low") })
				case "medium":
					return t("chat:reasoningEffort.medium", { defaultValue: t("chat:effort.medium", "Medium") })
				case "high":
					return t("chat:reasoningEffort.high", { defaultValue: t("chat:effort.high", "High") })
				case "xhigh":
				case "max":
					return t("chat:reasoningEffort.max", { defaultValue: t("chat:effort.xhigh", "Max") })
				default:
					return level
			}
		},
		[t],
	)

	const { apiConfiguration, currentApiConfigName, setApiConfiguration, currentTaskItem, openAiModelInfos } =
		useExtensionState()

	const selectedModel = useSelectedModel(apiConfiguration, openAiModelInfos)
	const isTaskExecuting = Boolean(disabled && currentTaskItem?.executionModelId)
	const activeModelId = propModelId ?? (isTaskExecuting ? currentTaskItem?.executionModelId : selectedModel?.id) ?? ""
	const activeModelInfo =
		propModelInfo ??
		(isTaskExecuting && currentTaskItem?.executionModelId && currentTaskItem.executionModelId !== selectedModel?.id
			? openAiModelInfos?.[currentTaskItem.executionModelId] || selectedModel?.info
			: selectedModel?.info)

	// Check if the selected model supports reasoning
	const activeModelSupportsReasoning = useMemo(() => {
		const supportsEffort =
			activeModelInfo?.supportsReasoningEffort !== undefined && activeModelInfo?.supportsReasoningEffort !== false
		const hasLevels =
			Array.isArray(activeModelInfo?.reasoningEffortLevels) && activeModelInfo.reasoningEffortLevels.length > 0

		return !!(
			supportsEffort ||
			hasLevels ||
			activeModelInfo?.supportsReasoningBudget ||
			activeModelInfo?.maxThinkingTokens ||
			modelSupportsReasoning(activeModelId, activeModelInfo) ||
			isReasoningModel(activeModelId, activeModelInfo)
		)
	}, [activeModelInfo, activeModelId])

	// Dynamically determine available effort options
	const effortOptions = useMemo<string[]>(() => {
		const rawLevels =
			activeModelInfo?.reasoningEffortLevels ||
			(Array.isArray(activeModelInfo?.supportsReasoningEffort)
				? activeModelInfo.supportsReasoningEffort
				: undefined)

		if (rawLevels && Array.isArray(rawLevels) && rawLevels.length > 0) {
			const positiveLevels = rawLevels
				.filter((lvl) => lvl !== "disable" && lvl !== "none")
				.map((lvl) => formatEffortLabel(lvl))
			return ["Off", ...positiveLevels]
		}

		return [...DEFAULT_EFFORT_OPTIONS]
	}, [activeModelInfo?.reasoningEffortLevels, activeModelInfo?.supportsReasoningEffort])

	// Current reasoning effort state
	const currentEffort: string = useMemo(() => {
		if (apiConfiguration?.enableReasoningEffort === false || apiConfiguration?.reasoningEffort === "disable") {
			return "Off"
		}
		const effort = (
			(isTaskExecuting ? currentTaskItem?.executionReasoningEffort : undefined) ||
			apiConfiguration?.reasoningEffort ||
			activeModelInfo?.reasoningEffort
		)?.toLowerCase()
		if (effort === "none") return "Off"

		if (effort) {
			const match = effortOptions.find((opt) => opt.toLowerCase() === effort)
			if (match) return match
			if (effort === "minimal" && effortOptions.includes("Minimal")) return "Minimal"
			if (effort === "low" && effortOptions.includes("Low")) return "Low"
			if (effort === "medium" && effortOptions.includes("Medium")) return "Medium"
			if (effort === "high" && effortOptions.includes("High")) return "High"
			if (effort === "xhigh" && effortOptions.includes("XHigh")) return "XHigh"
		}

		if (
			apiConfiguration?.enableReasoningEffort === true ||
			activeModelInfo?.requiredReasoningEffort ||
			activeModelInfo?.supportsReasoningEffort ||
			modelSupportsReasoning(activeModelId, activeModelInfo)
		) {
			return effortOptions.includes("Medium") ? "Medium" : effortOptions[1] || "Off"
		}

		return "Off"
	}, [
		apiConfiguration?.enableReasoningEffort,
		apiConfiguration?.reasoningEffort,
		activeModelInfo,
		activeModelId,
		effortOptions,
	])

	// Switch reasoning effort
	const handleSelectEffort = useCallback(
		(effort: string) => {
			const isOff = effort.toLowerCase() === "off" || effort.toLowerCase() === "disable"
			const updatedConfig: ProviderSettings = {
				...apiConfiguration,
				...(isOff
					? { reasoningEffort: "disable" as any, enableReasoningEffort: false }
					: { reasoningEffort: effort.toLowerCase() as any, enableReasoningEffort: true }),
			}

			setApiConfiguration(updatedConfig)

			vscode.postMessage({
				type: "upsertApiConfiguration",
				text: currentApiConfigName || "default",
				apiConfiguration: updatedConfig,
			})
		},
		[apiConfiguration, currentApiConfigName, setApiConfiguration],
	)

	// If the model does not support reasoning, hide the button to save toolbar space
	if (!activeModelSupportsReasoning) {
		return null
	}

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="reasoning-effort-root">
			<StandardTooltip content={t("chat:effort.tooltip", { level: getEffortLabel(currentEffort) })}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="reasoning-effort-trigger"
					className={cn("agent-toolbar-control shrink-0 cursor-pointer", className)}>
					<Brain className="size-3.5 text-vscode-descriptionForeground flex-shrink-0" />
					<span className="font-medium">
						{t("chat:effort.label", { level: getEffortLabel(currentEffort) })}
					</span>
					<ChevronDown className="size-3 text-vscode-descriptionForeground opacity-60 flex-shrink-0 -mr-0.5" />
				</PopoverTrigger>
			</StandardTooltip>

			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="agent-effort-menu"
				data-testid="reasoning-effort-popover">
				<div className="flex flex-col gap-0.5" data-testid="reasoning-effort-section">
					<div className="agent-menu-heading">
						<Brain className="size-3.5 text-vscode-descriptionForeground flex-shrink-0" />
						<span>{t("chat:effort.title")}</span>
					</div>
					{effortOptions.map((effort) => {
						const isSelected = currentEffort.toLowerCase() === effort.toLowerCase()
						return (
							<button
								key={effort}
								type="button"
								data-testid={`reasoning-effort-pill-${effort.toLowerCase()}`}
								aria-pressed={isSelected}
								onClick={(e) => {
									e.stopPropagation()
									handleSelectEffort(effort)
									setOpen(false)
								}}
								className="agent-menu-option">
								<span>{getEffortLabel(effort)}</span>
								{isSelected && <Check className="size-3.5 text-current flex-shrink-0" />}
							</button>
						)
					})}
				</div>
			</PopoverContent>
		</Popover>
	)
}
