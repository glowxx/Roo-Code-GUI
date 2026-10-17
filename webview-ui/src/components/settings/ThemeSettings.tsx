import React from "react"
import { Check } from "lucide-react"
import { type ThemeType } from "@roo-code/types"
import { cn } from "@/lib/utils"
import { useAppTranslation } from "@/i18n"

interface ThemeOption {
	id: ThemeType
	name: string
	description: string
	bgCanvas: string
	bgSurface: string
	accent: string
	textColor: string
	isLight?: boolean
}

const THEMES: ThemeOption[] = [
	{
		id: "linear-dark",
		name: "Grafitowy",
		description: "Neutralny grafit i łagodny kontrast",
		bgCanvas: "#202123",
		bgSurface: "#28292c",
		accent: "#a8c7fa",
		textColor: "#edeef0",
	},
	{
		id: "oled-black",
		name: "Czerń OLED",
		description: "Głęboka czerń i wyraźny kontrast",
		bgCanvas: "#000000",
		bgSurface: "#0a0a0a",
		accent: "#a8c7fa",
		textColor: "#ffffff",
	},
	{
		id: "midnight-navy",
		name: "Granatowy",
		description: "Ciemne powierzchnie z odcieniami granatu",
		bgCanvas: "#161c25",
		bgSurface: "#1d2531",
		accent: "#a8c7fa",
		textColor: "#e6edf3",
	},
	{
		id: "cyberpunk",
		name: "Cyberpunk",
		description: "Ciemne tło z akcentami w kolorze cyjanu",
		bgCanvas: "#101b22",
		bgSurface: "#152630",
		accent: "#83c9d5",
		textColor: "#e1f0f2",
	},
	{
		id: "clean-light",
		name: "Jasny",
		description: "Jasne powierzchnie i delikatne szarości",
		bgCanvas: "#ffffff",
		bgSurface: "#fafafa",
		accent: "#355f9e",
		textColor: "#242528",
		isLight: true,
	},
]

interface ThemeSettingsProps {
	selectedTheme?: ThemeType
	onThemeChange: (theme: ThemeType) => void
}

export const ThemeSettings: React.FC<ThemeSettingsProps> = ({ selectedTheme = "linear-dark", onThemeChange }) => {
	const { t } = useAppTranslation()
	const handleSelect = (themeId: ThemeType) => {
		onThemeChange(themeId)
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="text-sm font-medium text-vscode-foreground">
				{t("settings:theme.title", { defaultValue: "Motyw i kolory" })}
			</div>
			<div className="text-xs text-vscode-descriptionForeground">
				{t("settings:theme.description", {
					defaultValue:
						"Wybierz wygląd całej aplikacji. Podgląd zobaczysz od razu; zatwierdź wybór przyciskiem „Zapisz”.",
				})}
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-1">
				{THEMES.map((theme) => {
					const isSelected = selectedTheme === theme.id

					return (
						<button
							key={theme.id}
							type="button"
							aria-pressed={isSelected}
							onClick={() => handleSelect(theme.id)}
							data-testid={`theme-card-${theme.id}`}
							className={cn(
								"theme-choice group relative flex flex-col p-3.5 rounded-xl border text-left transition-all duration-150 cursor-pointer select-none",
								isSelected
									? "border-blue-500 bg-blue-500/10 shadow-sm ring-1 ring-blue-500/40"
									: "border-white/[0.08] hover:border-white/[0.18] bg-white/[0.02] hover:bg-white/[0.04]",
							)}>
							{/* Theme Preview Swatch Bar */}
							<div
								className="w-full h-12 rounded-lg mb-3 p-2 flex items-center justify-between border"
								style={{
									backgroundColor: theme.bgCanvas,
									borderColor: theme.isLight ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.08)",
								}}>
								{/* Mini surface box inside swatch */}
								<div
									className="flex items-center gap-1.5 px-2 py-1 rounded-md border"
									style={{
										backgroundColor: theme.bgSurface,
										borderColor: theme.isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)",
									}}>
									<div
										className="w-2.5 h-2.5 rounded-full"
										style={{ backgroundColor: theme.accent }}
									/>
									<span className="text-[10px] font-medium" style={{ color: theme.textColor }}>
										Aa
									</span>
								</div>

								{/* Palette Color Dots */}
								<div className="flex items-center gap-1">
									<div
										className="w-3.5 h-3.5 rounded-full border"
										style={{
											backgroundColor: theme.bgCanvas,
											borderColor: theme.isLight ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.2)",
										}}
										title={t("settings:theme.backgroundTooltip", { defaultValue: "Tło" })}
									/>
									<div
										className="w-3.5 h-3.5 rounded-full border"
										style={{
											backgroundColor: theme.bgSurface,
											borderColor: theme.isLight ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.2)",
										}}
										title={t("settings:theme.surfaceTooltip", { defaultValue: "Powierzchnia" })}
									/>
									<div
										className="w-3.5 h-3.5 rounded-full shadow-xs"
										style={{ backgroundColor: theme.accent }}
										title={t("settings:theme.accentTooltip", { defaultValue: "Akcent" })}
									/>
								</div>
							</div>

							{/* Theme Info */}
							<div className="flex items-start justify-between gap-2">
								<div>
									<div className="flex items-center gap-1.5">
										<span className="text-sm font-semibold text-vscode-foreground">
											{t(`settings:theme.names.${theme.id}`, { defaultValue: theme.name })}
										</span>
										{theme.id === "linear-dark" && (
											<span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/10 text-vscode-descriptionForeground font-medium">
												{t("settings:theme.defaultBadge", { defaultValue: "Domyślny" })}
											</span>
										)}
									</div>
									<p className="text-xs text-vscode-descriptionForeground mt-0.5 leading-relaxed">
										{t(`settings:theme.descriptions.${theme.id}`, { defaultValue: theme.description })}
									</p>
								</div>

								{isSelected && (
									<div className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--text-primary)] text-[var(--bg-canvas)] flex items-center justify-center shadow-xs">
										<Check className="w-3 h-3 stroke-[3]" />
									</div>
								)}
							</div>
						</button>
					)
				})}
			</div>
		</div>
	)
}
