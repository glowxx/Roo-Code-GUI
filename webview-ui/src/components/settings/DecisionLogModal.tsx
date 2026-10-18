import React, { useEffect, useState, useMemo } from "react"
import type { DecisionLogEntry } from "@roo-code/types"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Badge, Button, Input } from "@/components/ui"
import { vscode } from "@/utils/vscode"
import { ShieldCheck, CheckCircle2, AlertTriangle, XCircle, Search, RefreshCw, Clock } from "lucide-react"
import { useAppTranslation } from "@/i18n/TranslationContext"

interface DecisionLogModalProps {
	isOpen: boolean
	onClose: () => void
	taskId?: string
}

export const DecisionLogModal: React.FC<DecisionLogModalProps> = ({ isOpen, onClose, taskId }) => {
	const { t } = useAppTranslation()
	const [entries, setEntries] = useState<DecisionLogEntry[]>([])
	const [searchQuery, setSearchQuery] = useState("")
	const [filterDecision, setFilterDecision] = useState<string>("all")
	const [isLoading, setIsLoading] = useState(false)

	const fetchEntries = () => {
		setIsLoading(true)
		vscode.postMessage({
			type: "getDecisionLog",
			taskId,
		})
	}

	useEffect(() => {
		if (isOpen) {
			fetchEntries()
		}
	}, [isOpen, taskId])

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "decisionLog" && Array.isArray(message.decisionLog)) {
				setEntries(message.decisionLog)
				setIsLoading(false)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const filteredEntries = useMemo(() => {
		return entries.filter((entry) => {
			if (filterDecision !== "all" && entry.decision !== filterDecision) {
				return false
			}
			if (!searchQuery) return true
			const query = searchQuery.toLowerCase()
			return (
				entry.actionType.toLowerCase().includes(query) ||
				entry.target.toLowerCase().includes(query) ||
				(entry.reason && entry.reason.toLowerCase().includes(query)) ||
				(entry.evaluatorModel && entry.evaluatorModel.toLowerCase().includes(query))
			)
		})
	}, [entries, filterDecision, searchQuery])

	const renderDecisionBadge = (decision: string) => {
		switch (decision) {
			case "ALLOW_AUTO":
				return (
					<Badge className="bg-[var(--success-subtle)] text-[var(--success)] border border-[var(--border-light)] flex items-center gap-1 font-mono text-[10px]">
						<CheckCircle2 className="size-3" />
						{t("settings:decisionLog.badgeAllowed", "APPROVED")}
					</Badge>
				)
			case "DENIED_AND_REPLAN":
				return (
					<Badge className="bg-[var(--warning-subtle)] text-[var(--warning)] border border-[var(--border-light)] flex items-center gap-1 font-mono text-[10px]">
						<AlertTriangle className="size-3" />
						{t("settings:decisionLog.badgeReplan", "REPLAN")}
					</Badge>
				)
			case "HARD_BLOCK":
				return (
					<Badge className="bg-red-500/20 text-red-400 border border-red-500/30 flex items-center gap-1 font-mono text-[10px]">
						<XCircle className="size-3" />
						{t("settings:decisionLog.badgeBlocked", "BLOCKED")}
					</Badge>
				)
			case "MANUAL_APPROVAL":
				return (
					<Badge className="bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--border-light)] flex items-center gap-1 font-mono text-[10px]">
						<ShieldCheck className="size-3" />
						{t("settings:decisionLog.badgeManual", "USER DECISION")}
					</Badge>
				)
			default:
				return (
					<Badge className="bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--border-light)] flex items-center gap-1 font-mono text-[10px]">
						<ShieldCheck className="size-3" />
						{decision}
					</Badge>
				)
		}
	}

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-4xl max-h-[85vh] flex flex-col p-6 overflow-hidden">
				<DialogHeader className="pb-3 border-b border-white/[0.08]">
					<div className="flex items-center justify-between pr-6">
						<div className="flex items-center gap-2">
							<ShieldCheck className="size-5 text-vscode-textLink-foreground" />
							<DialogTitle className="text-base font-semibold">{t("settings:decisionLog.title", "Agent decision history")}</DialogTitle>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={fetchEntries}
							disabled={isLoading}
							className="h-7 px-2">
							<RefreshCw className={`size-3.5 mr-1 ${isLoading ? "animate-spin" : ""}`} />
							{t("settings:decisionLog.refresh", "Refresh")}
						</Button>
					</div>
					<DialogDescription className="text-xs text-vscode-descriptionForeground">
						{t("settings:decisionLog.description", "Decisions of the independent safety model regarding agent actions.")}
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center gap-3 py-3 border-b border-white/[0.06]">
					<div className="relative flex-1">
						<Search className="absolute left-2.5 top-2.5 size-3.5 text-vscode-descriptionForeground" />
						<Input
							placeholder={t("settings:decisionLog.searchPlaceholder", "Search actions, reasons, or models…")}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-8 h-8 text-xs"
						/>
					</div>
					<div className="flex items-center gap-1">
						{["all", "ALLOW_AUTO", "DENIED_AND_REPLAN", "HARD_BLOCK", "MANUAL_APPROVAL"].map((type) => (
							<Button
								key={type}
								variant={filterDecision === type ? "primary" : "secondary"}
								size="sm"
								className="h-8 text-xs px-2.5"
								onClick={() => setFilterDecision(type)}>
								{type === "all"
									? t("settings:decisionLog.filterAll", "All")
									: type === "ALLOW_AUTO"
										? t("settings:decisionLog.filterApproved", "Approved")
										: type === "DENIED_AND_REPLAN"
											? t("settings:decisionLog.filterReplan", "Replan")
											: type === "HARD_BLOCK"
												? t("settings:decisionLog.filterBlocked", "Blocked")
												: t("settings:decisionLog.filterManual", "Manual")}
							</Button>
						))}
					</div>
				</div>

				<div className="flex-1 overflow-y-auto min-h-[300px] space-y-2 py-3 pr-1">
					{filteredEntries.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-12 text-vscode-descriptionForeground text-sm">
							<Clock className="size-8 mb-2 opacity-50" />
							<p>{t("settings:decisionLog.emptyTitle", "No decisions recorded yet.")}</p>
							<p className="text-xs opacity-75">
								{t("settings:decisionLog.emptyDesc", "Approvals and replan guidance will appear here.")}
							</p>
						</div>
					) : (
						filteredEntries.map((entry) => (
							<div
								key={entry.id}
								className="p-3 rounded-lg border border-white/[0.06] bg-black/20 hover:bg-white/[0.02] transition-colors space-y-1.5 text-xs">
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-2">
										{renderDecisionBadge(entry.decision)}
										<span className="font-semibold text-vscode-foreground font-mono uppercase text-[11px]">
											{entry.actionType}
										</span>
										<span className="text-vscode-descriptionForeground text-[11px]">
											({entry.evaluatorModel || (entry.fastPath ? "fast-path" : "rule-engine")})
										</span>
									</div>
									<div className="flex items-center gap-2 text-[10px] text-vscode-descriptionForeground">
										{entry.latencyMs !== undefined && <span>{entry.latencyMs}ms •</span>}
										<span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
									</div>
								</div>

								<div className="font-mono text-[11px] text-vscode-editor-foreground bg-black/30 p-1.5 rounded break-all border border-white/[0.04]">
									{entry.target}
								</div>

								{entry.reason && (
									<div className="text-[11px] text-[var(--warning)] bg-[var(--warning-subtle)] p-1.5 rounded border border-[var(--border-light)]">
										<span className="font-semibold">{t("settings:decisionLog.reasonLabel", "Reason: ")}</span>
										{entry.reason}
									</div>
								)}

								{entry.replanGuidance && (
									<div className="text-[11px] text-vscode-descriptionForeground italic">
										<span className="font-semibold not-italic">{t("settings:decisionLog.guidanceLabel", "Guidance for agent: ")}</span>
										{entry.replanGuidance}
									</div>
								)}
							</div>
						))
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}
