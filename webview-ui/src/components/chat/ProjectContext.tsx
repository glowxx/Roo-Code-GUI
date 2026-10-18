import { useEffect, useMemo, useState } from "react"
import { Paperclip, File, X, Search } from "lucide-react"
import { mentionRegexGlobal, unescapeSpaces } from "@roo/context-mentions"
import { Popover, PopoverContent, PopoverTrigger } from "@src/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

export function getContextPaths(value: string): string[] {
	return [
		...new Set(
			[...value.matchAll(new RegExp(mentionRegexGlobal.source, "g"))]
				.map((match) => match[1])
				.filter((path) => path.startsWith("/"))
				.map((path) => unescapeSpaces(path.slice(1))),
		),
	]
}

export function toggleContextPath(value: string, file: string): string {
	const paths = getContextPaths(value)
	if (paths.includes(file)) {
		return value.replace(new RegExp(mentionRegexGlobal.source + " ?", "g"), (match, path: string) =>
			path.startsWith("/") && unescapeSpaces(path.slice(1)) === file ? "" : match,
		)
	}
	return `${value}${value && !/\s$/.test(value) ? " " : ""}@/${file.replace(/ /g, "\\ ")} `
}

export function ProjectContext({
	value,
	onChange,
	files,
	cwd,
	disabled,
	onImages,
}: {
	value: string
	onChange: (value: string) => void
	files: string[]
	cwd?: string
	disabled?: boolean
	onImages?: () => void
}) {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [available, setAvailable] = useState(files)
	const [error, setError] = useState("")
	const [loading, setLoading] = useState(false)
	const selected = useMemo(() => getContextPaths(value), [value])
	useEffect(() => {
		setAvailable(files)
		setOpen(false)
		setQuery("")
	}, [cwd])
	useEffect(() => {
		if (files.length) setAvailable(files)
	}, [files])
	useEffect(() => {
		if (!open || !(window as any).__ROO_DESKTOP__) return
		const controller = new AbortController()
		setLoading(true)
		setError("")
		fetch("/api/files", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error()
				return response.json()
			})
			.then((data) => setAvailable(data.files || []))
			.catch((error) => {
				if (error.name !== "AbortError")
					setError(t("chat:projectContext.loadError", "Could not load files. Open project and try again."))
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [open, t])
	const matches = useMemo(
		() =>
			[...new Set(available.map((file) => file.replace(/\\/g, "/")))]
				.filter((file) => file.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
				.sort(
					(a, b) =>
						Number(selected.includes(b)) - Number(selected.includes(a)) ||
						a.localeCompare(b, undefined, { numeric: true }),
				)
				.slice(0, 150),
		[available, query, selected],
	)
	return (
		<div className="project-context-row">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					type="button"
					disabled={disabled}
					className="project-context-add"
					aria-label={t("chat:projectContext.addFilesContextAria", "Add files and context")}>
					<Paperclip size={14} />
					<span>{t("chat:projectContext.addContext", "Add context")}</span>
				</PopoverTrigger>
				<PopoverContent side="top" align="start" className="project-context-picker">
					<div className="context-picker-heading">
						<strong>{t("chat:projectContext.filesInContext", "Files in context")}</strong>
						<span>{selected.length ? t("chat:projectContext.selectedCount", { count: selected.length, defaultValue: `${selected.length} selected` }) : t("chat:projectContext.selectFilesForAgent", "Select files for agent")}</span>
					</div>
					<label className="context-picker-search">
						<Search size={14} />
						<input
							aria-label={t("chat:projectContext.searchContextAria", "Search files for context")}
							placeholder={t("chat:projectContext.searchPlaceholder", "Search by name or path…")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<div className="context-picker-files">
						{!cwd ? (
							<p>{t("chat:projectContext.openProjectFirst", "Open a project folder first.")}</p>
						) : error ? (
							<p role="alert">{error}</p>
						) : loading ? (
							<p>{t("chat:projectContext.loadingFiles", "Loading files…")}</p>
						) : !matches.length ? (
							<p>
								{query
									? t("chat:projectContext.noMatchingFiles", "No files matching your search.")
									: t("chat:projectContext.noFilesYet", "No files in this project yet.")}
							</p>
						) : (
							matches.map((file) => (
								<button
									type="button"
									key={file}
									aria-pressed={selected.includes(file)}
									onClick={() => onChange(toggleContextPath(value, file))}
									title={file}>
									<File size={14} />
									<span>
										{file.split("/").at(-1)}
										<small>
											{file.includes("/")
												? file.slice(0, file.lastIndexOf("/"))
												: t("chat:projectContext.rootFolder", "Root folder")}
										</small>
									</span>
									<span className="context-check" aria-hidden="true">
										{selected.includes(file) ? "✓" : ""}
									</span>
								</button>
							))
						)}
					</div>
					<div className="context-picker-footer">
						{onImages && (
							<button
								type="button"
								onClick={() => {
									setOpen(false)
									onImages()
								}}>
								{t("chat:projectContext.addImage", "Add image…")}
							</button>
						)}
						<button type="button" onClick={() => setOpen(false)}>
							{t("chat:projectContext.done", "Done")}
						</button>
					</div>
				</PopoverContent>
			</Popover>
			{selected.map((file) => (
				<span className="project-context-chip" key={file} title={file}>
					<File size={12} />
					<span>{file.split("/").at(-1)}</span>
					<button
						type="button"
						aria-label={t("chat:projectContext.removeFileAria", { file, defaultValue: `Remove ${file} from context` })}
						onClick={() => onChange(toggleContextPath(value, file))}>
						<X size={12} />
					</button>
				</span>
			))}
		</div>
	)
}
