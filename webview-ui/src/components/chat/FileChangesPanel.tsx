import { memo, useEffect, useMemo, useState, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { createTwoFilesPatch } from "diff"

import type { ClineMessage, ExtensionMessage } from "@roo-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"

import { fileChangesFromMessages, type FileChangeEntry } from "./utils/fileChangesFromMessages"
import CodeAccordion from "../common/CodeAccordion"

interface FileChangesPanelProps {
	clineMessages: ClineMessage[] | undefined
	className?: string
}

const FileChangesPanel = memo(({ clineMessages, className }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const [finalContentByPath, setFinalContentByPath] = useState<Record<string, string | null>>({})
	const pendingPathsRef = useRef<Set<string>>(new Set())

	// Reset expanded file rows and final content cache when switching to a different task
	useEffect(() => {
		setExpandedPaths(new Set())
		setFinalContentByPath({})
		pendingPathsRef.current = new Set()
	}, [clineMessages])

	const fileChanges = useMemo(() => fileChangesFromMessages(clineMessages), [clineMessages])

	// Group by path so we show one row per file (multiple edits to same file combined for display)
	const byPath = useMemo(() => {
		const map = new Map<string, FileChangeEntry[]>()
		for (const entry of fileChanges) {
			const key = entry.path
			const list = map.get(key) ?? []
			list.push(entry)
			map.set(key, list)
		}
		return map
	}, [fileChanges])

	// Aggregate total lines added/removed across all files for the panel header
	const totalStats = useMemo(() => {
		return fileChanges.reduce(
			(acc, e) => ({
				added: acc.added + (e.diffStats?.added ?? 0),
				removed: acc.removed + (e.diffStats?.removed ?? 0),
			}),
			{ added: 0, removed: 0 },
		)
	}, [fileChanges])

	const togglePath = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev)
			if (next.has(path)) next.delete(path)
			else next.add(path)
			return next
		})
	}, [])

	// Request final file content when a row is expanded and we have originalContent
	useEffect(() => {
		for (const path of expandedPaths) {
			const entries = byPath.get(path)
			if (!entries?.length) continue
			const originalContent = entries[0].originalContent
			const lookupPath = path.startsWith("./") ? path.slice(2) : path
			if (
				originalContent !== undefined &&
				!(lookupPath in finalContentByPath) &&
				!pendingPathsRef.current.has(lookupPath)
			) {
				pendingPathsRef.current.add(lookupPath)
				vscode.postMessage({ type: "readFileContent", text: lookupPath })
			}
		}
	}, [expandedPaths, byPath, finalContentByPath])

	// Listen for fileContent responses
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type === "fileContent" && message.fileContent?.path != null) {
				const fc = message.fileContent
				pendingPathsRef.current.delete(fc.path)
				setFinalContentByPath((prev) => ({ ...prev, [fc.path]: fc.content ?? null }))
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	if (fileChanges.length === 0) return null

	const fileCount = byPath.size

	return (
		<div className="w-full canvas-narrative agent-file-changes my-1">
			<Collapsible open={panelExpanded} onOpenChange={setPanelExpanded} className={cn("w-full", className)}>
				<CollapsibleTrigger
					className={cn(
						"flex items-center gap-2.5 w-full px-3 py-1.5 rounded-lg text-left text-vscode-foreground",
						"bg-vscode-input-background/50 hover:bg-vscode-input-background/90 border border-border/30 hover:border-border/60",
						"transition-all duration-150 cursor-pointer shadow-sm group",
					)}>
					<FileDiff className="size-4 shrink-0 text-vscode-foreground/80 group-hover:text-vscode-foreground" aria-hidden />
					<span className="text-xs font-medium text-vscode-foreground">
						{t("chat:fileChangesInConversation.header", { count: fileCount })}
					</span>
					{totalStats.added > 0 || totalStats.removed > 0 ? (
						<div
							className="flex items-center gap-2 ml-auto shrink-0 font-mono text-[11px]"
							aria-label={`${totalStats.added} lines added, ${totalStats.removed} lines removed`}>
							{totalStats.added > 0 && (
								<span className="font-medium text-vscode-charts-green" data-testid="total-added">
									+{totalStats.added}
								</span>
							)}
							{totalStats.removed > 0 && (
								<span className="font-medium text-vscode-charts-red" data-testid="total-removed">
									-{totalStats.removed}
								</span>
							)}
						</div>
					) : (
						<div className="ml-auto" />
					)}
					<ChevronDown
						className={cn(
							"size-3.5 shrink-0 text-vscode-descriptionForeground transition-transform duration-200",
							panelExpanded ? "rotate-0" : "-rotate-90",
						)}
						aria-hidden
					/>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-1.5 pt-2 pb-1">
					{Array.from(byPath.entries()).map(([path, entries]) => {
						const originalContent = entries[0].originalContent
						const lookupPath = path.startsWith("./") ? path.slice(2) : path
						const finalContent = finalContentByPath[lookupPath]
						const hasMergedDiff =
							originalContent !== undefined && finalContent != null && finalContent !== ""
						const displayDiff = hasMergedDiff
							? createTwoFilesPatch(path, path, originalContent, finalContent)
							: entries.map((e) => e.diff).join("\n\n")
						const combinedStats = entries.reduce(
							(acc, e) => ({
								added: acc.added + (e.diffStats?.added ?? 0),
								removed: acc.removed + (e.diffStats?.removed ?? 0),
							}),
							{ added: 0, removed: 0 },
						)
						const isExpanded = expandedPaths.has(path)
						return (
							<div key={path} className="rounded border border-vscode-panel-border overflow-hidden">
								<CodeAccordion
									path={path}
									code={displayDiff}
									language="diff"
									isExpanded={isExpanded}
									onToggleExpand={() => togglePath(path)}
									diffStats={
										combinedStats.added > 0 || combinedStats.removed > 0 ? combinedStats : undefined
									}
									onJumpToFile={
										path
											? () =>
													vscode.postMessage({
														type: "openFile",
														text: path.startsWith("./") ? path : "./" + path,
													})
											: undefined
									}
								/>
							</div>
						)
					})}
				</div>
			</CollapsibleContent>
		</Collapsible>
	</div>
	)
})

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
