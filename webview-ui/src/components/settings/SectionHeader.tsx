import { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

type SectionHeaderProps = HTMLAttributes<HTMLDivElement> & {
	children: React.ReactNode
	description?: string
}

export const SectionHeader = ({ description, children, className, ...props }: SectionHeaderProps) => {
	return (
		<div
			className={cn(
				"settings-section-heading mb-4 pb-2 border-b border-border",
				className,
			)}
			{...props}>
			<h3 className="text-sm font-semibold text-vscode-foreground m-0 tracking-tight">{children}</h3>
			{description && <p className="text-xs text-vscode-descriptionForeground mt-1 mb-0 leading-relaxed">{description}</p>}
		</div>
	)
}
