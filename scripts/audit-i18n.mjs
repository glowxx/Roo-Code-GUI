import fs from "node:fs"
import path from "node:path"

/**
 * Universal I18n Audit Tool for Roo Code
 *
 * Verifies:
 *  1. 0 missing keys against English canonical base across all 18 locales
 *  2. 0 broken interpolation parameters ({{...}})
 *  3. 0 empty values (except allowed *.plan.default)
 *
 * Scans both webview-ui/src/i18n/locales and src/i18n/locales.
 */

function flattenObject(obj, prefix = "", result = {}) {
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key
		if (typeof value === "string") {
			result[fullKey] = value
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			flattenObject(value, fullKey, result)
		}
	}
	return result
}

function extractInterpolationParams(text) {
	if (!text || typeof text !== "string") return []
	const matches = [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)]
	return matches.map((m) => m[1].trim()).sort()
}

const args = process.argv.slice(2)
const targetLocaleArg = args.find((a) => a.startsWith("--locale="))?.split("=")[1]
const outputJson = args.includes("--json")

const localeBases = [
	{ name: "webview", path: "webview-ui/src/i18n/locales/" },
	{ name: "core", path: "src/i18n/locales/" },
]

const ALL_LOCALES = [
	"ca", "de", "en", "es", "fr", "hi", "id", "it",
	"ja", "ko", "nl", "pl", "pt-BR", "ru", "tr", "vi",
	"zh-CN", "zh-TW"
]

const localesToCheck = targetLocaleArg
	? [targetLocaleArg]
	: ALL_LOCALES.filter((l) => l !== "en")

let totalChecked = 0
let totalMissing = 0
let totalBadInterpolation = 0
let totalEmptyValues = 0

const report = {}

for (const base of localeBases) {
	if (!fs.existsSync(base.path)) continue
	const enDir = path.join(base.path, "en")
	if (!fs.existsSync(enDir)) continue

	const jsonFiles = fs.readdirSync(enDir).filter((f) => f.endsWith(".json"))

	for (const file of jsonFiles) {
		const enFilePath = path.join(enDir, file)
		let enData = {}
		try {
			enData = flattenObject(JSON.parse(fs.readFileSync(enFilePath, "utf8")))
		} catch (err) {
			console.error(`[ERROR] Failed to parse canonical EN file: ${enFilePath}`, err.message)
			continue
		}

		for (const locale of localesToCheck) {
			const localeFilePath = path.join(base.path, locale, file)
			if (!report[locale]) {
				report[locale] = {
					missingKeys: [],
					badInterpolations: [],
					emptyValues: [],
					checkedKeys: 0,
				}
			}

			if (!fs.existsSync(localeFilePath)) {
				report[locale].missingKeys.push({
					file: `${base.name}/${file}`,
					key: "*",
					en: `File missing entirely: ${localeFilePath}`,
				})
				totalMissing += Object.keys(enData).length
				continue
			}

			let locData = {}
			try {
				locData = flattenObject(JSON.parse(fs.readFileSync(localeFilePath, "utf8")))
			} catch (err) {
				report[locale].missingKeys.push({
					file: `${base.name}/${file}`,
					key: "*",
					en: `JSON syntax error: ${err.message}`,
				})
				totalMissing++
				continue
			}

			for (const [key, enValue] of Object.entries(enData)) {
				totalChecked++
				report[locale].checkedKeys++

				if (!(key in locData)) {
					report[locale].missingKeys.push({
						file: `${base.name}/${file}`,
						key,
						en: enValue,
					})
					totalMissing++
					continue
				}

				const locValue = locData[key]

				// Empty value check (allow keys ending with plan.default)
				if (typeof locValue === "string" && locValue.trim() === "" && !key.endsWith("plan.default")) {
					report[locale].emptyValues.push({
						file: `${base.name}/${file}`,
						key,
						en: enValue,
					})
					totalEmptyValues++
				}

				// Interpolation check
				const enParams = extractInterpolationParams(enValue)
				const locParams = extractInterpolationParams(locValue)
				if (enParams.join(",") !== locParams.join(",")) {
					report[locale].badInterpolations.push({
						file: `${base.name}/${file}`,
						key,
						expected: enParams,
						actual: locParams,
						enText: enValue,
						locText: locValue,
					})
					totalBadInterpolation++
				}
			}
		}
	}
}

if (outputJson) {
	console.log(JSON.stringify({
		totalChecked,
		totalMissing,
		totalBadInterpolation,
		totalEmptyValues,
		report,
	}, null, 2))
} else {
	console.log("=======================================================")
	console.log("ROO CODE — I18N AUDIT REPORT (ALL 18 LOCALES)")
	console.log("=======================================================\n")
	console.log(`Locales audited: ${localesToCheck.join(", ")}`)
	console.log(`Total translation key comparisons: ${totalChecked}`)
	console.log(`Missing keys: ${totalMissing}`)
	console.log(`Broken interpolation parameters: ${totalBadInterpolation}`)
	console.log(`Disallowed empty values: ${totalEmptyValues}\n`)

	for (const locale of localesToCheck) {
		const locReport = report[locale]
		if (!locReport) continue
		const hasErrors =
			locReport.missingKeys.length > 0 ||
			locReport.badInterpolations.length > 0 ||
			locReport.emptyValues.length > 0

		if (hasErrors) {
			console.log(`[FAIL] Locale '${locale}':`)
			if (locReport.missingKeys.length > 0) {
				console.log(`  - Missing keys (${locReport.missingKeys.length}):`)
				for (const item of locReport.missingKeys.slice(0, 10)) {
					console.log(`      ${item.file} -> ${item.key}`)
				}
				if (locReport.missingKeys.length > 10) {
					console.log(`      ... and ${locReport.missingKeys.length - 10} more`)
				}
			}
			if (locReport.badInterpolations.length > 0) {
				console.log(`  - Broken interpolation (${locReport.badInterpolations.length}):`)
				for (const item of locReport.badInterpolations.slice(0, 10)) {
					console.log(`      ${item.file} -> ${item.key}: expected [${item.expected.join(", ")}], got [${item.actual.join(", ")}]`)
				}
				if (locReport.badInterpolations.length > 10) {
					console.log(`      ... and ${locReport.badInterpolations.length - 10} more`)
				}
			}
			if (locReport.emptyValues.length > 0) {
				console.log(`  - Disallowed empty values (${locReport.emptyValues.length}):`)
				for (const item of locReport.emptyValues.slice(0, 10)) {
					console.log(`      ${item.file} -> ${item.key}`)
				}
				if (locReport.emptyValues.length > 10) {
					console.log(`      ... and ${locReport.emptyValues.length - 10} more`)
				}
			}
			console.log()
		} else {
			console.log(`[PASS] Locale '${locale}': ${locReport.checkedKeys} keys checked, 0 errors`)
		}
	}
}

const totalFailures = totalMissing + totalBadInterpolation + totalEmptyValues
process.exitCode = totalFailures === 0 ? 0 : 1
