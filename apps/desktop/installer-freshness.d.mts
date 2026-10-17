export const APPLICATION_SOURCE_PATHS: string[]

export interface VerifyFreshnessParams {
	packageJson: Record<string, any>
	desktopDir: string
	buildStartTimeMs: number
	preBuildSnapshot?: { exists: boolean; mtimeMs: number; size: number; sha256?: string } | null
	releaseDir?: string
	gitSha?: string | null
	verifyOnly?: boolean
	writeManifest?: boolean
	manifestFilename?: string
}

export interface VerifyFreshnessResult {
	success: boolean
	code?: string
	error?: string
	sourceGitSha?: string
	sourceGitShaAtBuild?: string
	currentGitHead?: string
	hasAppCodeChanges?: boolean
	changedFiles?: string[]
	installerFilename?: string
	installerPath?: string
	installerSize?: number
	installerSha256?: string
	installerLastWriteTime?: Date
	manifestPath?: string
	freshArtifactVerified?: boolean
}

export function getExpectedInstallerFilename(pkgJson: Record<string, any>, arch?: string, ext?: string): string
export function getReleaseOutputDir(pkgJson: Record<string, any>, baseDir: string): string
export function computeFileSha256(filePath: string): string
export function getGitHeadSha(cwd?: string): string
export function checkApplicationCodeChanges(
	baseSha: string,
	rootDir?: string,
	sourcePaths?: string[]
): { hasAppCodeChanges: boolean; changedFiles: string[] }
export function verifyInstallerFreshness(params: VerifyFreshnessParams): VerifyFreshnessResult
