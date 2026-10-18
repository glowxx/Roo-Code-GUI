import React, { createContext, useContext, ReactNode, useEffect, useCallback } from "react"
import { useTranslation } from "react-i18next"
import i18next, { loadTranslations } from "./setup"
import { useExtensionState } from "@/context/ExtensionStateContext"

// Helper to resolve translation with fallback to settings namespace
const resolveTranslation = (
	i18nInstance: typeof i18next,
	key: string,
	options?: Record<string, any> | string,
): string => {
	const opt = typeof options === "string" ? { defaultValue: options } : options
	if (i18nInstance.exists(key, opt)) {
		return i18nInstance.t(key, opt)
	}

	// Smart fallback: if key starts with "footer." or lacks a namespace prefix,
	// and exists in the "settings:" namespace, translate from settings
	if (key.startsWith("footer.") || !key.includes(":")) {
		const settingsKey = key.startsWith("settings:") ? key : `settings:${key}`
		if (i18nInstance.exists(settingsKey, opt)) {
			return i18nInstance.t(settingsKey, opt)
		}
	}

	// Fallback from settings:footer.* to common footer.* if needed
	if (key.startsWith("settings:footer.")) {
		const commonKey = key.replace(/^settings:/, "")
		if (i18nInstance.exists(commonKey, opt)) {
			return i18nInstance.t(commonKey, opt)
		}
	}

	return i18nInstance.t(key, opt)
}

// Create context for translations
export const TranslationContext = createContext<{
	t: (key: string, options?: Record<string, any> | string) => string
	i18n: typeof i18next
}>({
	t: (key: string, options?: Record<string, any> | string) => (typeof options === "string" ? options : key),
	i18n: i18next,
})

// Translation provider component
export const TranslationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
	// Initialize with default configuration
	const { i18n } = useTranslation()
	// Get the extension state directly - it already contains all state properties
	const extensionState = useExtensionState()

	// Load translations once when the component mounts
	useEffect(() => {
		try {
			loadTranslations()
		} catch (error) {
			console.error("Failed to load translations:", error)
		}
	}, [])

	useEffect(() => {
		i18n.changeLanguage(extensionState.language || "en")
		document.documentElement.lang = extensionState.language || "en"
	}, [i18n, extensionState.language])

	// Memoize the translation function to prevent unnecessary re-renders
	const translate = useCallback(
		(key: string, options?: Record<string, any> | string) => {
			return resolveTranslation(i18n, key, options)
		},
		[i18n],
	)

	return (
		<TranslationContext.Provider
			value={{
				t: translate,
				i18n,
			}}>
			{children}
		</TranslationContext.Provider>
	)
}

// Custom hook for easy translations
export const useAppTranslation = () => useContext(TranslationContext)

export default TranslationProvider
