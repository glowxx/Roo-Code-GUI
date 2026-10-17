import React from "react"
import { ListChecks, LayoutList, Settings, Check, CheckCheck, X, Lock, Zap, Sliders, ShieldCheck } from "lucide-react"

import { isSafetyModelConfigured } from "@roo-code/types"

import { vscode } from "@/utils/vscode"
import { openSettings } from "@/utils/settingsNavigation"

import { cn } from "@/lib/utils"

import { useExtensionState } from "@/context/ExtensionStateContext"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { useAutoApprovalToggles } from "@/hooks/useAutoApprovalToggles"
import { useAutoApprovalState } from "@/hooks/useAutoApprovalState"

import { useRooPortal } from "@/components/ui/hooks/useRooPortal"

import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, ToggleSwitch, Button } from "@/components/ui"

import { AutoApproveSetting, autoApproveSettingsConfig } from "../settings/AutoApproveToggle"

interface AutoApproveDropdownProps {
	disabled?: boolean
	triggerClassName?: string
}

export const AutoApproveDropdown = ({ disabled = false, triggerClassName = "" }: AutoApproveDropdownProps) => {
	const [open, setOpen] = React.useState(false)
	const portalContainer = useRooPortal("roo-portal")
	const { t } = useAppTranslation()

	const state = useExtensionState()
	const {
		autoApprovalEnabled,
		setAutoApprovalEnabled,
		setAlwaysAllowReadOnly,
		setAlwaysAllowWrite,
		setAlwaysAllowExecute,
		setAlwaysAllowMcp,
		setAlwaysAllowModeSwitch,
		setAlwaysAllowSubtasks,
		setAlwaysAllowFollowupQuestions,
		approvalMode,
		setApprovalMode,
		commandSafetyConfig,
	} = state

	const isAutoMode = approvalMode === "auto"
	const isSafetyConfigured = isSafetyModelConfigured(state)
	const approvalModel = commandSafetyConfig?.modelId || t("chat:autoApprove.noModelFallback", "Brak modelu — wymagane potwierdzenie")

	const toggles = useAutoApprovalToggles()

	const onAutoApproveToggle = React.useCallback(
		(key: AutoApproveSetting, value: boolean) => {
			if (key === "alwaysAllowExecute" && value && !isSafetyConfigured) {
				return
			}
			vscode.postMessage({ type: "updateSettings", updatedSettings: { [key]: value } })

			switch (key) {
				case "alwaysAllowReadOnly":
					setAlwaysAllowReadOnly(value)
					break
				case "alwaysAllowWrite":
					setAlwaysAllowWrite(value)
					break
				case "alwaysAllowExecute":
					setAlwaysAllowExecute(value)
					break
				case "alwaysAllowMcp":
					setAlwaysAllowMcp(value)
					break
				case "alwaysAllowModeSwitch":
					setAlwaysAllowModeSwitch(value)
					break
				case "alwaysAllowSubtasks":
					setAlwaysAllowSubtasks(value)
					break
				case "alwaysAllowFollowupQuestions":
					setAlwaysAllowFollowupQuestions(value)
					break
			}

			// If enabling any option, ensure autoApprovalEnabled is true.
			if (value && !autoApprovalEnabled) {
				setAutoApprovalEnabled(true)
				vscode.postMessage({ type: "autoApprovalEnabled", bool: true })
			}
		},
		[
			autoApprovalEnabled,
			isSafetyConfigured,
			setAlwaysAllowReadOnly,
			setAlwaysAllowWrite,
			setAlwaysAllowExecute,
			setAlwaysAllowMcp,
			setAlwaysAllowModeSwitch,
			setAlwaysAllowSubtasks,
			setAlwaysAllowFollowupQuestions,
			setAutoApprovalEnabled,
		],
	)

	const handleSelectAll = React.useCallback(() => {
		// Enable all options
		Object.keys(autoApproveSettingsConfig).forEach((key) => {
			if (key === "alwaysAllowExecute" && !isSafetyConfigured) {
				return
			}
			onAutoApproveToggle(key as AutoApproveSetting, true)
		})
		// Enable master auto-approval
		if (!autoApprovalEnabled) {
			setAutoApprovalEnabled(true)
			vscode.postMessage({ type: "autoApprovalEnabled", bool: true })
		}
	}, [onAutoApproveToggle, autoApprovalEnabled, setAutoApprovalEnabled, isSafetyConfigured])

	const handleSelectNone = React.useCallback(() => {
		// Disable all options
		Object.keys(autoApproveSettingsConfig).forEach((key) => {
			onAutoApproveToggle(key as AutoApproveSetting, false)
		})
	}, [onAutoApproveToggle])

	const handleOpenSettings = React.useCallback(
		() => openSettings({ section: "autoApprove", source: "auto_approve_dropdown" }),
		[],
	)

	// Handle the main auto-approval toggle
	const handleAutoApprovalToggle = React.useCallback(() => {
		const newValue = !(autoApprovalEnabled ?? false)
		setAutoApprovalEnabled(newValue)
		vscode.postMessage({ type: "autoApprovalEnabled", bool: newValue })
	}, [autoApprovalEnabled, setAutoApprovalEnabled])

	// Calculate enabled and total counts as separate properties
	const settingsArray = Object.values(autoApproveSettingsConfig)

	const enabledCount = React.useMemo(() => {
		return Object.values(toggles).filter((value) => !!value).length
	}, [toggles])

	const totalCount = React.useMemo(() => {
		return Object.keys(toggles).length
	}, [toggles])

	const { effectiveAutoApprovalEnabled } = useAutoApprovalState(toggles, autoApprovalEnabled)

	const tooltipText = isAutoMode
		? `${t("chat:autoApprove.autonomousWork", "Samodzielna praca agenta")}. ${t("chat:autoApprove.evaluatorModel", "Model oceniający:")} ${approvalModel}. ${t("chat:autoApprove.noEvaluationRequiresConfirmation", "Brak oceny wymaga potwierdzenia.")}`
		: !effectiveAutoApprovalEnabled || enabledCount === 0
			? t("chat:autoApprove.tooltipManage")
			: t("chat:autoApprove.tooltipStatus", {
					toggles: settingsArray
						.filter((setting) => toggles[setting.key])
						.map((setting) => t(setting.labelKey))
						.join(", "),
				})

	return (
		<Popover open={open} onOpenChange={setOpen} data-testid="auto-approve-dropdown-root">
			<StandardTooltip content={tooltipText}>
				<PopoverTrigger
					disabled={disabled}
					data-active={isAutoMode}
					data-testid="auto-approve-dropdown-trigger"
					className={cn("agent-toolbar-control shrink-0", triggerClassName)}>
					{isAutoMode ? (
						<>
							<Zap className="size-3 text-current shrink-0" />
							<span className="font-medium">Auto</span>
						</>
					) : (
						<>
							{!effectiveAutoApprovalEnabled ? (
								<X className="size-3 flex-shrink-0" />
							) : (
								<CheckCheck className="size-3 flex-shrink-0" />
							)}

							<span className="hidden min-[300px]:inline truncate min-w-0">
								{!effectiveAutoApprovalEnabled
									? t("chat:autoApprove.triggerLabelOff")
									: enabledCount === totalCount
										? t("chat:autoApprove.triggerLabelAll")
										: t("chat:autoApprove.triggerLabel", { count: enabledCount })}
							</span>
							<span className="inline min-[300px]:hidden min-w-0">
								{!effectiveAutoApprovalEnabled
									? t("chat:autoApprove.triggerLabelOffShort")
									: enabledCount === totalCount
										? t("chat:autoApprove.triggerLabelAll")
										: enabledCount}
							</span>
						</>
					)}
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="agent-approval-menu p-0 overflow-hidden w-[min(400px,calc(100vw-2rem))]"
				onOpenAutoFocus={(e) => e.preventDefault()}>
				<div className="flex flex-col w-full">
					{/* Mode Switcher */}
					<div className="p-3 border-b border-vscode-dropdown-border">
						<div className="approval-segment">
							<button
								type="button"
								data-testid="dropdown-mode-manual-btn"
								aria-pressed={!isAutoMode}
								className={`flex-1 py-1 px-2 rounded text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
									!isAutoMode
										? "bg-vscode-button-background text-vscode-button-foreground shadow-xs"
										: "text-vscode-descriptionForeground hover:text-vscode-foreground"
								}`}
								onClick={() => {
									setApprovalMode?.("manual")
									vscode.postMessage({ type: "approvalMode", approvalMode: "manual" })
								}}>
								<Sliders className="size-3" />
								<span>{t("chat:autoApprove.manual", "Ręcznie")}</span>
							</button>
							<button
								type="button"
								data-testid="dropdown-mode-auto-btn"
								aria-pressed={isAutoMode}
								className={`flex-1 py-1 px-2 rounded text-xs font-semibold transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
									isAutoMode
										? "bg-vscode-button-background text-vscode-button-foreground shadow-xs"
										: "text-vscode-descriptionForeground hover:text-vscode-foreground"
								}`}
								onClick={() => {
									setApprovalMode?.("auto")
									vscode.postMessage({ type: "approvalMode", approvalMode: "auto" })
								}}>
								<Zap className="size-3 text-vscode-descriptionForeground" />
								<span>{t("chat:autoApprove.automatic", "Automatycznie")}</span>
							</button>
						</div>
					</div>

					{isAutoMode ? (
						/* AUTO MODE DROPDOWN PANEL */
						<div className="p-3.5 space-y-3">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<div className="p-1 rounded bg-[var(--bg-hover)] border border-[var(--border-subtle)] text-vscode-descriptionForeground">
										<Zap className="size-3.5" />
									</div>
									<h4 className="m-0 font-semibold text-sm text-vscode-foreground">
										{t("chat:autoApprove.autonomousWork", "Samodzielna praca agenta")}
									</h4>
								</div>
								<Settings
									className="size-4 cursor-pointer text-vscode-descriptionForeground hover:text-vscode-foreground"
									onClick={handleOpenSettings}
								/>
							</div>
							<p className="m-0 text-xs text-vscode-descriptionForeground leading-relaxed">
								{t(
									"chat:autoApprove.autoModeDescription",
									"Tryb samodzielny jest aktywny. Bezpieczne operacje są wykonywane od razu. Działania mogące usunąć dane lub wpłynąć na komputer ocenia niezależny model.",
								)}
							</p>
							<div className="approval-facts space-y-2">
								<div className="flex justify-between items-center">
									<span className="text-vscode-descriptionForeground">
										{t("chat:autoApprove.evaluatorModelLabel", "Model oceniający:")}
									</span>
									<span
										className="font-mono text-vscode-foreground font-medium text-[11px] truncate max-w-[180px]"
										title={approvalModel}>
										{approvalModel}
									</span>
								</div>
								<div className="flex justify-between items-center">
									<span className="text-vscode-descriptionForeground">
										{t("chat:autoApprove.safetyRulesLabel", "Zasady bezpieczeństwa:")}
									</span>
									<span className="text-[var(--success)] font-medium">
										{t("chat:autoApprove.safetyRulesAlwaysApply", "Zawsze obowiązują")}
									</span>
								</div>
								<div className="flex justify-between items-center">
									<span className="text-vscode-descriptionForeground">
										{t("chat:autoApprove.inCaseOfNoEvaluationLabel", "W razie braku oceny:")}
									</span>
									<span className="text-vscode-foreground font-medium">
										{t("chat:autoApprove.requiresConfirmation", "Wymagane potwierdzenie")}
									</span>
								</div>
							</div>
							<Button
								variant="secondary"
								size="sm"
								className="w-full h-7 text-xs"
								onClick={handleOpenSettings}>
								{t("chat:autoApprove.openSafetySettings", "Otwórz ustawienia bezpieczeństwa")}
							</Button>
						</div>
					) : (
						/* MANUAL MODE DROPDOWN PANEL */
						<>
							{/* Header with description */}
							<div className="p-3 border-b border-vscode-dropdown-border">
								<div className="flex items-center justify-between gap-1 pr-1 pb-2">
									<h4 className="m-0 font-semibold text-sm text-vscode-foreground">
										{t("chat:autoApprove.title")}
									</h4>
									<Settings
										className="inline mb-0.5 mr-1 size-4 cursor-pointer"
										onClick={handleOpenSettings}
									/>
								</div>
								<p className="m-0 text-xs text-vscode-descriptionForeground">
									{t("chat:autoApprove.description")}
								</p>
							</div>
							<div className="approval-permissions">
								{settingsArray.map(({ key, labelKey, descriptionKey, icon }) => {
									const isEnabled = toggles[key]
									const isExecute = key === "alwaysAllowExecute"
									const isExecuteLocked = isExecute && !isSafetyConfigured
									const isDisabled = !effectiveAutoApprovalEnabled || isExecuteLocked

									const tooltipContent = isExecuteLocked ? (
										<div
											className="flex flex-col gap-1.5 p-1 max-w-[240px]"
											data-testid="execute-safety-tooltip">
											<span>{t("settings:autoApprove.requiresSafetyModel")}</span>
											<button
												type="button"
												className="text-xs text-vscode-textLink-foreground hover:underline text-left cursor-pointer p-0 bg-transparent border-0 flex items-center gap-1"
												onClick={(e) => {
													e.stopPropagation()
													handleOpenSettings()
												}}>
												{t("chat:openSettings")}
											</button>
										</div>
									) : (
										t(descriptionKey)
									)

									return (
										<StandardTooltip key={key} content={tooltipContent}>
											<span className="inline-flex w-full">
												<Button
													variant="ghost"
													aria-pressed={isEnabled && !isExecuteLocked}
													onClick={() => onAutoApproveToggle(key, !isEnabled)}
													className={cn(
														"approval-permission flex items-center gap-2 text-left justify-start h-auto w-full",
														"transition-all duration-150",
														isDisabled && "opacity-50 cursor-not-allowed hover:opacity-50",
														(!isEnabled || isExecuteLocked) &&
															"bg-vscode-button-background/15",
													)}
													disabled={isDisabled}
													data-testid={`auto-approve-${key}`}>
													<span className={`codicon codicon-${icon} text-sm flex-shrink-0`} />
													<span className="flex-1 truncate">{t(labelKey)}</span>
													{isEnabled && !isExecuteLocked && (
														<Check className="size-3.5 shrink-0" aria-hidden="true" />
													)}
													{isExecuteLocked && (
														<span
															className="approval-lock-label flex items-center gap-1 flex-shrink-0"
															data-testid="requires-safety-model-badge">
															<Lock className="size-2.5" />
															<span>{t("chat:autoApprove.requiresEvaluator", "Wymaga modelu oceniającego")}</span>
														</span>
													)}
												</Button>
											</span>
										</StandardTooltip>
									)
								})}
							</div>

							{/* Actions: All, None, Toggle */}
							<div className="approval-footer flex items-center justify-between">
								<div className="flex flex-row gap-1">
									<Button
										variant="ghost"
										size="sm"
										aria-label={t("chat:autoApprove.selectAll")}
										onClick={handleSelectAll}
										disabled={!effectiveAutoApprovalEnabled}
										className={cn(
											"gap-1 px-2 py-1 text-base font-bold h-auto",
											!effectiveAutoApprovalEnabled &&
												"opacity-50 hover:opacity-50 cursor-not-allowed",
										)}>
										<ListChecks className="w-3.5 h-3.5" />
										<span>{t("chat:autoApprove.all")}</span>
									</Button>
									<Button
										variant="ghost"
										size="sm"
										aria-label={t("chat:autoApprove.selectNone")}
										onClick={handleSelectNone}
										disabled={!effectiveAutoApprovalEnabled}
										className={cn(
											"gap-1 px-2 py-1 text-base font-bold h-auto",
											!effectiveAutoApprovalEnabled &&
												"opacity-50 hover:opacity-50 cursor-not-allowed",
										)}>
										<LayoutList className="w-3.5 h-3.5" />
										<span>{t("chat:autoApprove.none")}</span>
									</Button>
								</div>

								<label
									className="flex items-center gap-2 pr-2 cursor-pointer"
									onClick={(e) => {
										if ((e.target as HTMLElement).closest('[role="switch"]')) {
											e.preventDefault()
											return
										}
										handleAutoApprovalToggle()
									}}>
									<ToggleSwitch
										checked={effectiveAutoApprovalEnabled}
										aria-label={t("chat:autoApprove.toggleApprovalMode", "Zmień tryb zatwierdzania")}
										onChange={handleAutoApprovalToggle}
									/>
									<span className={cn("text-sm font-bold select-none")}>
										{effectiveAutoApprovalEnabled
											? t("chat:autoApprove.enabled", "Włączone")
											: t("chat:autoApprove.disabled", "Wyłączone")}
									</span>
								</label>
							</div>
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
