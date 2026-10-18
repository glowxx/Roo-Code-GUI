import { HTMLAttributes, useContext, useMemo, useState } from "react"
import { Lock, X, ShieldCheck, Zap, Sliders, FileText, AlertTriangle, Check } from "lucide-react"
import { Trans } from "react-i18next"
import { Package } from "@roo/package"
import {
	type ExtensionState,
	type ApprovalMode,
	type CommandSafetyConfig,
	isSafetyModelConfigured,
	resolveProviderApiKey,
} from "@roo-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { vscode } from "@/utils/vscode"
import {
	Badge,
	Button,
	Input,
	Slider,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { AutoApproveToggle } from "./AutoApproveToggle"
import { MaxLimitInputs } from "./MaxLimitInputs"
import { CommandSafetyModelCombobox } from "./CommandSafetyModelCombobox"
import { DecisionLogModal } from "./DecisionLogModal"
import { useAutoApprovalState } from "@/hooks/useAutoApprovalState"

type AutoApproveSettingsProps = HTMLAttributes<HTMLDivElement> & {
	alwaysAllowReadOnly?: boolean
	alwaysAllowReadOnlyOutsideWorkspace?: boolean
	alwaysAllowWrite?: boolean
	alwaysAllowWriteOutsideWorkspace?: boolean
	alwaysAllowWriteProtected?: boolean
	alwaysAllowMcp?: boolean
	alwaysAllowModeSwitch?: boolean
	alwaysAllowSubtasks?: boolean
	alwaysAllowExecute?: boolean
	alwaysAllowFollowupQuestions?: boolean
	followupAutoApproveTimeoutMs?: number
	allowedCommands?: string[]
	allowedMaxRequests?: number | undefined
	allowedMaxCost?: number | undefined
	deniedCommands?: string[]
	autoApprovalEnabled?: boolean
	approvalMode?: ApprovalMode
	state?: Partial<ExtensionState> | null
	setCachedStateField: SetCachedStateField<
		| "alwaysAllowReadOnly"
		| "alwaysAllowReadOnlyOutsideWorkspace"
		| "alwaysAllowWrite"
		| "alwaysAllowWriteOutsideWorkspace"
		| "alwaysAllowWriteProtected"
		| "alwaysAllowMcp"
		| "alwaysAllowModeSwitch"
		| "alwaysAllowSubtasks"
		| "alwaysAllowExecute"
		| "alwaysAllowFollowupQuestions"
		| "followupAutoApproveTimeoutMs"
		| "allowedCommands"
		| "allowedMaxRequests"
		| "allowedMaxCost"
		| "deniedCommands"
		| "autoApprovalEnabled"
		| "approvalMode"
		| "commandSafetyConfig"
	>
}

export const AutoApproveSettings = ({
	alwaysAllowReadOnly,
	alwaysAllowReadOnlyOutsideWorkspace,
	alwaysAllowWrite,
	alwaysAllowWriteOutsideWorkspace,
	alwaysAllowWriteProtected,
	alwaysAllowMcp,
	alwaysAllowModeSwitch,
	alwaysAllowSubtasks,
	alwaysAllowExecute,
	alwaysAllowFollowupQuestions,
	followupAutoApproveTimeoutMs = 60000,
	allowedCommands,
	allowedMaxRequests,
	allowedMaxCost,
	deniedCommands,
	autoApprovalEnabled,
	approvalMode: propApprovalMode,
	state,
	setCachedStateField,
	...props
}: AutoApproveSettingsProps) => {
	const { t } = useAppTranslation()
	const extensionState = useContext(ExtensionStateContext)
	const resolvedState = state !== undefined ? state : extensionState
	const isSafetyConfigured = isSafetyModelConfigured(resolvedState)
	const [commandInput, setCommandInput] = useState("")
	const [deniedCommandInput, setDeniedCommandInput] = useState("")
	const [isLogModalOpen, setIsLogModalOpen] = useState(false)

	const currentApprovalMode: ApprovalMode =
		propApprovalMode ?? (resolvedState?.approvalMode as ApprovalMode) ?? "manual"

	const safetyConfig: CommandSafetyConfig = useMemo(
		() =>
			resolvedState?.commandSafetyConfig ?? {
				enabled: true,
				provider: "openai",
				modelId: "",
			},
		[resolvedState?.commandSafetyConfig],
	)

	const updateSafetyConfig = (partial: Partial<CommandSafetyConfig>) => {
		setCachedStateField("commandSafetyConfig", {
			...safetyConfig,
			enabled: true,
			...partial,
		})
	}

	const toggles = useMemo(
		() => ({
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowFollowupQuestions,
		}),
		[
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowFollowupQuestions,
		],
	)

	const { effectiveAutoApprovalEnabled } = useAutoApprovalState(toggles, autoApprovalEnabled)

	const handleAddCommand = () => {
		const currentCommands = allowedCommands ?? []

		if (commandInput && !currentCommands.includes(commandInput)) {
			const newCommands = [...currentCommands, commandInput]
			setCachedStateField("allowedCommands", newCommands)
			setCommandInput("")
			vscode.postMessage({ type: "updateSettings", updatedSettings: { allowedCommands: newCommands } })
		}
	}

	const handleAddDeniedCommand = () => {
		const currentCommands = deniedCommands ?? []

		if (deniedCommandInput && !currentCommands.includes(deniedCommandInput)) {
			const newCommands = [...currentCommands, deniedCommandInput]
			setCachedStateField("deniedCommands", newCommands)
			setDeniedCommandInput("")
			vscode.postMessage({ type: "updateSettings", updatedSettings: { deniedCommands: newCommands } })
		}
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.autoApprove")}</SectionHeader>

			<Section>
				{/* Top Segmented Switcher: [ Manual ] [ Auto ] */}
				<div className="approval-segment max-w-xs mb-4" data-testid="approval-mode-switcher">
					<button
						type="button"
						data-testid="approval-mode-manual-btn"
						aria-pressed={currentApprovalMode === "manual"}
						className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition-all cursor-pointer ${
							currentApprovalMode === "manual"
								? "bg-vscode-button-background text-vscode-button-foreground shadow-xs"
								: "text-vscode-descriptionForeground hover:text-vscode-foreground"
						}`}
						onClick={() => setCachedStateField("approvalMode", "manual")}>
						<div className="flex items-center justify-center gap-1.5">
							<Sliders className="size-3.5" />
							<span>{t("settings:autoApprove.modes.manual", "Manual")}</span>
						</div>
					</button>
					<button
						type="button"
						data-testid="approval-mode-auto-btn"
						aria-pressed={currentApprovalMode === "auto"}
						className={`flex-1 py-1.5 px-3 rounded text-xs font-semibold transition-all cursor-pointer ${
							currentApprovalMode === "auto"
								? "bg-vscode-button-background text-vscode-button-foreground shadow-xs"
								: "text-vscode-descriptionForeground hover:text-vscode-foreground"
						}`}
						onClick={() => setCachedStateField("approvalMode", "auto")}>
						<div className="flex items-center justify-center gap-1.5">
							<Zap className="size-3.5 text-[var(--warning)]" />
							<span>{t("settings:autoApprove.modes.auto", "Automatic")}</span>
						</div>
					</button>
				</div>

				{/* AUTO MODE PANEL */}
				{currentApprovalMode === "auto" ? (
					<div className="space-y-4" data-testid="autonomous-approval-panel">
						<div className="p-4 rounded-xl border border-white/[0.08] bg-white/[0.02] space-y-4">
							<div className="flex items-start gap-3">
								<div className="p-2 rounded-lg bg-[var(--warning-subtle)] border border-[var(--border-light)] text-[var(--warning)] shrink-0 mt-0.5">
									<Zap className="size-5" />
								</div>
								<div className="space-y-1">
									<h4 className="text-sm font-semibold text-vscode-foreground">
										{t("settings:autoApprove.autonomousWorkTitle", "Autonomous Agent Work")}
									</h4>
									<p className="text-xs text-vscode-descriptionForeground leading-relaxed">
										{t("settings:autoApprove.autonomousWorkDesc", "In autonomous mode, the agent performs safe operations without asking. Actions that could delete data or affect the system are evaluated by an independent safety evaluation model.")}
									</p>
								</div>
							</div>

							<div className="p-3 rounded-lg border border-white/[0.06] bg-black/20 space-y-2">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<ShieldCheck className="size-4 text-[var(--success)]" />
										<span className="text-xs font-semibold text-vscode-foreground">
											{t("settings:autoApprove.safetyRulesTitle", "Constant safety rules")}
										</span>
									</div>
									<Badge
										variant="outline"
										className="text-[10px] text-[var(--success)] border-[var(--border-light)] bg-[var(--success-subtle)]">
										{t("settings:autoApprove.alwaysActive", "Always active")}
									</Badge>
								</div>
								<p className="text-[11px] text-vscode-descriptionForeground leading-relaxed">
									{t("settings:autoApprove.safetyRulesDesc", "System files and sensitive data remain protected. Commands that could harm the system and untrusted code are subject to additional checks. Separate evaluation model: The agent cannot approve its own actions. When the independent model is unavailable, times out, or is the same model as the agent, your manual confirmation is required.")}
								</p>
							</div>

							<div className="pt-2 border-t border-white/[0.06] space-y-3">
								<div className="flex items-center justify-between">
									<div>
										<label className="text-xs font-semibold text-vscode-foreground block">
											{t("settings:autoApprove.safetyModelTitle", "Safety evaluation model")}
										</label>
										<span className="text-[11px] text-vscode-descriptionForeground">
											{t("settings:autoApprove.safetyModelDesc", "Independent AI model verifying action safety")}
										</span>
									</div>
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs flex items-center gap-1.5 cursor-pointer"
										onClick={() => setIsLogModalOpen(true)}
										data-testid="view-decision-log-btn">
										<FileText className="size-3.5" />
										<span>{t("settings:autoApprove.viewDecisionLog", "View decision log")}</span>
									</Button>
								</div>

								<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
									<div>
										<label className="block text-[11px] font-medium text-vscode-descriptionForeground mb-1">
											{t("settings:autoApprove.provider", "Provider")}
										</label>
										<Select
											value={safetyConfig.provider || "openai"}
											onValueChange={(provider) =>
												updateSafetyConfig({ provider: provider as any })
											}>
											<SelectTrigger className="w-full h-8 text-xs">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													<SelectItem value="openai">OpenAI</SelectItem>
													<SelectItem value="anthropic">Anthropic</SelectItem>
													<SelectItem value="openrouter">OpenRouter</SelectItem>
													<SelectItem value="gemini">Google Gemini</SelectItem>
													<SelectItem value="xkiro">xKiro</SelectItem>
												</SelectGroup>
											</SelectContent>
										</Select>
									</div>

									<div>
										<label className="block text-[11px] font-medium text-vscode-descriptionForeground mb-1">
											{t("settings:autoApprove.modelId", "Model ID")}
										</label>
										<CommandSafetyModelCombobox
											provider={safetyConfig.provider || "openai"}
											value={safetyConfig.modelId || ""}
											onChange={(modelId) => updateSafetyConfig({ modelId })}
											placeholder={t("settings:autoApprove.modelPlaceholder", "Select or enter evaluation model…")}
										/>
									</div>
								</div>

								<div>
									<label className="block text-[11px] font-medium text-vscode-descriptionForeground mb-1">
										{t("settings:autoApprove.separateApiKey", "Separate API key (optional)")}
									</label>
									<Input
										type="password"
										value={safetyConfig.apiKey || ""}
										onChange={(e) => updateSafetyConfig({ apiKey: e.target.value })}
										placeholder={t("settings:autoApprove.apiKeyPlaceholder", "Leave empty to use primary provider key")}
										className="h-8 text-xs"
									/>
								</div>

								{!isSafetyConfigured && (
									<div className="p-2.5 rounded-lg bg-[var(--warning-subtle)] border border-[var(--border-light)] text-[var(--warning)] text-xs flex items-center gap-2">
										<AlertTriangle className="size-4 shrink-0 text-[var(--warning)]" />
										<span>
											{t("settings:autoApprove.modelNotConfiguredWarning", "No safety evaluation model configured. Actions requiring AI evaluation will await your manual confirmation.")}
										</span>
									</div>
								)}
							</div>

							<MaxLimitInputs
								allowedMaxRequests={allowedMaxRequests}
								allowedMaxCost={allowedMaxCost}
								onMaxRequestsChange={(value) => setCachedStateField("allowedMaxRequests", value)}
								onMaxCostChange={(value) => setCachedStateField("allowedMaxCost", value)}
							/>
						</div>
					</div>
				) : (
					/* MANUAL MODE PANEL (Original Granular UI) */
					<div className="space-y-4" data-testid="manual-approval-panel">
						<SearchableSetting
							settingId="auto-approve-enabled"
							section="autoApprove"
							label={t("settings:autoApprove.enabled")}>
							<VSCodeCheckbox
								checked={effectiveAutoApprovalEnabled}
								aria-label={t("settings:autoApprove.toggleAriaLabel")}
								onChange={() => {
									setCachedStateField("autoApprovalEnabled", !(autoApprovalEnabled ?? false))
								}}>
								<span className="font-medium">{t("settings:autoApprove.enabled")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								<p>{t("settings:autoApprove.description")}</p>
								<p className="extension-only-setting">
									<Trans
										i18nKey="settings:autoApprove.toggleShortcut"
										components={{
											SettingsLink: (
												<a
													href="#"
													className="text-vscode-textLink-foreground hover:underline cursor-pointer"
													onClick={(e) => {
														e.preventDefault()
														// Send message to open keyboard shortcuts with search for toggle command
														vscode.postMessage({
															type: "openKeyboardShortcuts",
															text: `${Package.name}.toggleAutoApprove`,
														})
													}}
												/>
											),
										}}
									/>
								</p>
							</div>
						</SearchableSetting>

						<AutoApproveToggle
							alwaysAllowReadOnly={alwaysAllowReadOnly}
							alwaysAllowWrite={alwaysAllowWrite}
							alwaysAllowMcp={alwaysAllowMcp}
							alwaysAllowModeSwitch={alwaysAllowModeSwitch}
							alwaysAllowSubtasks={alwaysAllowSubtasks}
							alwaysAllowExecute={alwaysAllowExecute}
							alwaysAllowFollowupQuestions={alwaysAllowFollowupQuestions}
							state={resolvedState}
							onToggle={(key, value) => {
								if (key === "alwaysAllowExecute" && value && !isSafetyConfigured) {
									return
								}
								setCachedStateField(key, value)
							}}
						/>

						<MaxLimitInputs
							allowedMaxRequests={allowedMaxRequests}
							allowedMaxCost={allowedMaxCost}
							onMaxRequestsChange={(value) => setCachedStateField("allowedMaxRequests", value)}
							onMaxCostChange={(value) => setCachedStateField("allowedMaxCost", value)}
						/>
					</div>
				)}

				{/* ADDITIONAL SETTINGS FOR MANUAL MODE */}
				{currentApprovalMode === "manual" && (
					<>
						{alwaysAllowReadOnly && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background mt-4">
								<div className="flex items-center gap-4 font-bold">
									<span className="codicon codicon-eye" />
									<div>{t("settings:autoApprove.readOnly.label")}</div>
								</div>
								<SearchableSetting
									settingId="auto-approve-readonly-outside-workspace"
									section="autoApprove"
									label={t("settings:autoApprove.readOnly.outsideWorkspace.label")}>
									<VSCodeCheckbox
										checked={alwaysAllowReadOnlyOutsideWorkspace}
										onChange={(e: any) =>
											setCachedStateField("alwaysAllowReadOnlyOutsideWorkspace", e.target.checked)
										}
										data-testid="always-allow-readonly-outside-workspace-checkbox">
										<span className="font-medium">
											{t("settings:autoApprove.readOnly.outsideWorkspace.label")}
										</span>
									</VSCodeCheckbox>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:autoApprove.readOnly.outsideWorkspace.description")}
									</div>
								</SearchableSetting>
							</div>
						)}

						{alwaysAllowWrite && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background mt-4">
								<div className="flex items-center gap-4 font-bold">
									<span className="codicon codicon-edit" />
									<div>{t("settings:autoApprove.write.label")}</div>
								</div>
								<SearchableSetting
									settingId="auto-approve-write-outside-workspace"
									section="autoApprove"
									label={t("settings:autoApprove.write.outsideWorkspace.label")}>
									<VSCodeCheckbox
										checked={alwaysAllowWriteOutsideWorkspace}
										onChange={(e: any) =>
											setCachedStateField("alwaysAllowWriteOutsideWorkspace", e.target.checked)
										}
										data-testid="always-allow-write-outside-workspace-checkbox">
										<span className="font-medium">
											{t("settings:autoApprove.write.outsideWorkspace.label")}
										</span>
									</VSCodeCheckbox>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:autoApprove.write.outsideWorkspace.description")}
									</div>
								</SearchableSetting>
								<SearchableSetting
									settingId="auto-approve-write-protected"
									section="autoApprove"
									label={t("settings:autoApprove.write.protected.label")}>
									<VSCodeCheckbox
										checked={alwaysAllowWriteProtected}
										onChange={(e: any) =>
											setCachedStateField("alwaysAllowWriteProtected", e.target.checked)
										}
										data-testid="always-allow-write-protected-checkbox">
										<span className="font-medium">
											{t("settings:autoApprove.write.protected.label")}
										</span>
									</VSCodeCheckbox>
									<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
										{t("settings:autoApprove.write.protected.description")}
									</div>
								</SearchableSetting>
							</div>
						)}

						{alwaysAllowFollowupQuestions && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background mt-4">
								<div className="flex items-center gap-4 font-bold">
									<span className="codicon codicon-question" />
									<div>{t("settings:autoApprove.followupQuestions.label")}</div>
								</div>
								<SearchableSetting
									settingId="auto-approve-followup-timeout"
									section="autoApprove"
									label={t("settings:autoApprove.followupQuestions.timeoutLabel")}>
									<div className="flex items-center gap-2">
										<Slider
											min={1000}
											max={300000}
											step={1000}
											value={[followupAutoApproveTimeoutMs]}
											onValueChange={([value]) =>
												setCachedStateField("followupAutoApproveTimeoutMs", value)
											}
											data-testid="followup-timeout-slider"
										/>
										<span className="w-20">{followupAutoApproveTimeoutMs / 1000}s</span>
									</div>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:autoApprove.followupQuestions.timeoutLabel")}
									</div>
								</SearchableSetting>
							</div>
						)}

						{alwaysAllowExecute && (
							<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background mt-4">
								<div className="flex items-center gap-4 font-bold">
									<span className="codicon codicon-terminal" />
									<div>{t("settings:autoApprove.execute.label")}</div>
									{!isSafetyConfigured && (
										<span className="flex items-center gap-1 text-xs text-vscode-errorForeground font-normal">
											<Lock className="size-3.5" />
											<span>({t("settings:autoApprove.requiresSafetyModel")})</span>
										</span>
									)}
								</div>

								{!isSafetyConfigured && (
									<div
										className="flex items-center gap-2 p-2.5 rounded-lg bg-vscode-inputValidation-warningBackground text-vscode-inputValidation-warningForeground border border-vscode-inputValidation-warningBorder text-xs"
										data-testid="execute-safety-warning">
										<Lock className="size-4 shrink-0" />
										<span>{t("settings:autoApprove.requiresSafetyModel")}</span>
									</div>
								)}

								<SearchableSetting
									settingId="auto-approve-allowed-commands"
									section="autoApprove"
									label={t("settings:autoApprove.execute.allowedCommands")}>
									<label className="block font-medium mb-1" data-testid="allowed-commands-heading">
										{t("settings:autoApprove.execute.allowedCommands")}
									</label>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:autoApprove.execute.allowedCommandsDescription")}
									</div>
								</SearchableSetting>

								<div className="flex gap-2">
									<Input
										value={commandInput}
										onChange={(e: any) => setCommandInput(e.target.value)}
										onKeyDown={(e: any) => {
											if (e.key === "Enter") {
												e.preventDefault()
												handleAddCommand()
											}
										}}
										placeholder={t("settings:autoApprove.execute.commandPlaceholder")}
										className="grow"
										data-testid="command-input"
									/>
									<Button className="h-8" onClick={handleAddCommand} data-testid="add-command-button">
										{t("settings:autoApprove.execute.addButton")}
									</Button>
								</div>

								<div className="flex flex-wrap gap-2">
									{(allowedCommands ?? []).map((cmd, index) => (
										<Button
											key={index}
											variant="secondary"
											data-testid={`remove-command-${index}`}
											onClick={() => {
												const newCommands = (allowedCommands ?? []).filter(
													(_, i) => i !== index,
												)
												setCachedStateField("allowedCommands", newCommands)

												vscode.postMessage({
													type: "updateSettings",
													updatedSettings: { allowedCommands: newCommands },
												})
											}}>
											<div className="flex flex-row items-center gap-1">
												<div>{cmd}</div>
												<X className="text-foreground scale-75" />
											</div>
										</Button>
									))}
								</div>

								{/* Denied Commands Section */}
								<SearchableSetting
									settingId="auto-approve-denied-commands"
									section="autoApprove"
									label={t("settings:autoApprove.execute.deniedCommands")}
									className="mt-6">
									<label className="block font-medium mb-1" data-testid="denied-commands-heading">
										{t("settings:autoApprove.execute.deniedCommands")}
									</label>
									<div className="text-vscode-descriptionForeground text-sm mt-1">
										{t("settings:autoApprove.execute.deniedCommandsDescription")}
									</div>
								</SearchableSetting>

								<div className="flex gap-2">
									<Input
										value={deniedCommandInput}
										onChange={(e: any) => setDeniedCommandInput(e.target.value)}
										onKeyDown={(e: any) => {
											if (e.key === "Enter") {
												e.preventDefault()
												handleAddDeniedCommand()
											}
										}}
										placeholder={t("settings:autoApprove.execute.deniedCommandPlaceholder")}
										className="grow"
										data-testid="denied-command-input"
									/>
									<Button
										className="h-8"
										onClick={handleAddDeniedCommand}
										data-testid="add-denied-command-button">
										{t("settings:autoApprove.execute.addButton")}
									</Button>
								</div>

								<div className="flex flex-wrap gap-2">
									{(deniedCommands ?? []).map((cmd, index) => (
										<Button
											key={index}
											variant="secondary"
											data-testid={`remove-denied-command-${index}`}
											onClick={() => {
												const newCommands = (deniedCommands ?? []).filter((_, i) => i !== index)
												setCachedStateField("deniedCommands", newCommands)

												vscode.postMessage({
													type: "updateSettings",
													updatedSettings: { deniedCommands: newCommands },
												})
											}}>
											<div className="flex flex-row items-center gap-1">
												<div>{cmd}</div>
												<X className="text-foreground scale-75" />
											</div>
										</Button>
									))}
								</div>
							</div>
						)}
					</>
				)}
			</Section>

			<DecisionLogModal isOpen={isLogModalOpen} onClose={() => setIsLogModalOpen(false)} />
		</div>
	)
}
