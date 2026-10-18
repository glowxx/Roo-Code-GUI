// Roo Code Desktop Client Application
(() => {
	// State
	let socket = null
	let currentWorkspace = null
	let terminalLogs = []
	let terminalSessions = []
	let navigationCounts = { workspace: "", diffCount: 0, terminalCount: 0, terminalTotal: 0, terminalRunning: 0 }
	let selectedTerminalSessionId = null
	let diffFiles = []
	let selectedDiffFile = null
	let selectedPreviewFile = null
	let isConnected = false
	let currentAgentStatus = null
	let currentApiConfig = null
	let currentApiProfileName = "default"
	let currentPreviewMsg = null
	let isCodeWrapped = false
	let isSvgSourceView = false
	let currentDesktopTab = "chat"
	let latestExtensionState = null
	// A saved UI preference wins over older state broadcasts still in flight.
	let preferredTheme = null

	// Platform-neutral DesktopBridge (Tauri 2 / Electron / Web)
	const desktopBridge = (typeof window !== "undefined" && window.DesktopBridgeModule?.getDesktopBridge)
		? window.DesktopBridgeModule.getDesktopBridge((msg) => {
				if (socket && socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(msg))
				}
		  })
		: null

	try {
		const saved = localStorage.getItem("roo-quick-api-config")
		if (saved) currentApiConfig = JSON.parse(saved)
	} catch (e) {}

	// Folder expansions state
	const expandedFolders = new Set()
	let hasUserToggledFolders = false
	try {
		const savedExpansions = sessionStorage.getItem("roo-expanded-folders")
		if (savedExpansions) {
			const parsed = JSON.parse(savedExpansions)
			if (Array.isArray(parsed)) {
				parsed.forEach((p) => expandedFolders.add(p))
				if (expandedFolders.size > 0) hasUserToggledFolders = true
			}
		}
	} catch (e) {}

	function saveFolderExpansions() {
		try {
			sessionStorage.setItem("roo-expanded-folders", JSON.stringify(Array.from(expandedFolders)))
		} catch (e) {}
	}

	// DOM Elements
	const workspaceNameEl = document.getElementById("workspace-name")
	const openFolderBtn = document.getElementById("open-folder-btn")
	const gitPill = document.getElementById("git-pill")
	const gitBranchEl = document.getElementById("git-branch")
	const diffsCountEl = document.getElementById("diffs-count")
	const terminalCountEl = document.getElementById("terminal-count")
	const footerWorkspaceEl = document.getElementById("footer-workspace-path")
	const connectionStatusEl = document.getElementById("connection-status")
	const webviewFrame = document.getElementById("webview-frame")
	const webviewLoadingState = document.getElementById("webview-loading-state")
	const webviewLoadingTitle = document.getElementById("webview-loading-title")
	const webviewLoadingDesc = document.getElementById("webview-loading-desc")
	const webviewErrorState = document.getElementById("webview-error-state")
	const webviewErrorTitle = document.getElementById("webview-error-title")
	const webviewErrorDesc = document.getElementById("webview-error-desc")
	const webviewRetryBtn = document.getElementById("webview-retry-btn")
	const webviewRetryText = document.getElementById("webview-retry-text")
	// Header & Window controls
	const windowMinimizeBtn = document.getElementById("window-minimize-btn")
	const windowMaximizeBtn = document.getElementById("window-maximize-btn")
	const windowCloseBtn = document.getElementById("window-close-btn")
	const engineConnectionBadge = document.getElementById("engine-connection-badge")
	const engineConnectionText = document.getElementById("engine-connection-text")
	const tabLabelChat = document.getElementById("tab-label-chat")
	const tabLabelDiffs = document.getElementById("tab-label-diffs")
	const tabLabelTerminal = document.getElementById("tab-label-terminal")
	const tabLabelFiles = document.getElementById("tab-label-files")
	const tabLabelSettings = document.getElementById("tab-label-settings")

	// Settings Modal elements
	const openSettingsBtn = document.getElementById("open-settings-btn")
	const settingsModalBackdrop = document.getElementById("settings-modal-backdrop")
	const closeSettingsModalBtn = document.getElementById("close-settings-modal-btn")
	const settingsWebviewFrame = document.getElementById("settings-webview-frame")
	const settingsModalTitleText = document.getElementById("settings-modal-title-text")

	// API Modal elements
	const apiModalBackdrop = document.getElementById("api-modal-backdrop")
	const closeApiModalBtn = document.getElementById("close-api-modal-btn")
	const cancelApiModalBtn = document.getElementById("cancel-api-modal-btn")
	const apiProviderSelect = document.getElementById("api-provider-select")
	const apiBaseUrlInput = document.getElementById("api-base-url-input")
	const groupBaseUrl = document.getElementById("group-base-url")
	const baseUrlHint = document.getElementById("base-url-hint")
	const apiKeyInput = document.getElementById("api-key-input")
	const groupApiKey = document.getElementById("group-api-key")
	const apiKeyHint = document.getElementById("api-key-hint")
	const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility-btn")
	const apiModelInput = document.getElementById("api-model-input")
	const modelSuggestions = document.getElementById("model-suggestions")
	const saveApiConfigBtn = document.getElementById("save-api-config-btn")
	const openFullSettingsFromModalBtn = document.getElementById("open-full-settings-from-modal-btn")
	const settingsOpenBtn = document.getElementById("nav-settings-btn")
	const quickApiBtn = document.getElementById("quick-api-btn")
	const apiPillLabel = document.getElementById("api-pill-label")

	// Diffs elements
	const diffsSidebarTitle = document.getElementById("diffs-sidebar-title")
	const diffsFileListEl = document.getElementById("diffs-file-list")
	const diffFileCounterEl = document.getElementById("diff-file-counter")
	const diffViewerHeaderEl = document.getElementById("diff-viewer-header")
	const diffContentEl = document.getElementById("diff-content")
	const diffsPlaceholderText = document.getElementById("diffs-placeholder-text")

	// Terminal elements
	const terminalTitleText = document.getElementById("terminal-title-text")
	const terminalOutputEl = document.getElementById("terminal-output")
	const clearTerminalBtn = document.getElementById("clear-terminal-btn")
	const terminalClearText = document.getElementById("terminal-clear-text")
	const terminalEmptyText = document.getElementById("terminal-empty-text")
	const copyTerminalBtn = document.getElementById("copy-terminal-btn")
	const terminalCopyText = document.getElementById("terminal-copy-text")
	const terminalSidebarTitle = document.getElementById("terminal-sidebar-title")
	const terminalSessionCounter = document.getElementById("terminal-session-counter")
	const terminalSessionsList = document.getElementById("terminal-sessions-list")
	const terminalSessionsEmpty = document.getElementById("terminal-sessions-empty")
	const terminalSessionStatusBadge = document.getElementById("terminal-session-status-badge")

	// Files elements
	const filesSidebarTitle = document.getElementById("files-sidebar-title")
	const filesTreeEl = document.getElementById("files-tree")
	const filesTreeEmpty = document.getElementById("files-tree-empty")
	const filesSearchInput = document.getElementById("files-search")
	const previewFileIconEl = document.getElementById("preview-file-icon")
	const previewFilenameEl = document.getElementById("preview-filename")
	const previewFileBadgeEl = document.getElementById("preview-file-badge")
	const previewFileSizeEl = document.getElementById("preview-file-size")
	const previewHeaderActionsEl = document.getElementById("preview-header-actions")
	const previewCopyBtn = document.getElementById("preview-copy-btn")
	const previewCopyText = document.getElementById("preview-copy-text")
	const previewToggleWrapBtn = document.getElementById("preview-toggle-wrap-btn")
	const previewWrapText = document.getElementById("preview-wrap-text")
	const previewToggleViewBtn = document.getElementById("preview-toggle-view-btn")
	const previewSourceText = document.getElementById("preview-source-text")
	const previewOpenExternalBtn = document.getElementById("preview-open-external-btn")
	const previewInExplorerText = document.getElementById("preview-in-explorer-text")
	const previewContentAreaEl = document.getElementById("preview-content-area")
	const previewPlaceholderText = document.getElementById("preview-placeholder-text")

	// Sidebar Elements & State
	const sidebarEl = document.getElementById("app-sidebar")
	const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn")
	const sidebarProjectsListEl = document.getElementById("sidebar-projects-list")
	const sidebarProjectsCountEl = document.getElementById("sidebar-projects-count")
	const sidebarAddProjectBtn = document.getElementById("sidebar-add-project-btn")
	const sidebarHeaderTitleEl = document.getElementById("sidebar-header-title")
	const sidebarProjectsLabelEl = document.getElementById("sidebar-projects-label")
	const sidebarHintTextEl = document.getElementById("sidebar-hint-text")

	// Sidebar Context Menu & Confirmation Dialog Elements
	const sidebarContextMenuEl = document.getElementById("sidebar-context-menu")
	const confirmationModalBackdrop = document.getElementById("confirmation-modal-backdrop")
	const confirmationModalTitle = document.getElementById("confirmation-modal-title")
	const confirmationModalSubtitle = document.getElementById("confirmation-modal-subtitle")
	const confirmationModalIcon = document.getElementById("confirmation-modal-icon")
	const confirmationModalBody = document.getElementById("confirmation-modal-body")
	const confirmationModalConfirmBtn = document.getElementById("confirmation-modal-confirm-btn")
	const confirmationModalCancelBtn = document.getElementById("confirmation-modal-cancel-btn")
	const confirmationModalCloseBtn = document.getElementById("confirmation-modal-close-btn")
	let activeContextMenuTrigger = null
	let confirmationAction = null
	let lastFocusedElement = null

	let sidebarData = {
		recentWorkspaces: [],
		projectNames: {},
		currentWorkspace: "",
		chats: {},
	}
	let isSidebarCollapsed = localStorage.getItem("roo-sidebar-collapsed") === "true"
	let activeTaskId = null
	let currentSelectionEpoch = 0
	let isDesktopAppInitialized = false
	const projectExpansions = new Set()
	const projectChatExpansions = new Set()
	const MAX_VISIBLE_CHATS = 6

	// ==========================================
	// Desktop Internationalization (i18n)
	// ==========================================
	const desktopTranslations = {
		en: {
			cancel: "Cancel",
			diffEmpty: "No changes to display.",
			// Loading & Error States
			loadingTitle: "Initializing Roo Code engine...",
			loadingDesc: "Connecting to server and preparing agent view...",
			loadingServerHealth: (attempt, max) => `Waiting for server readiness... (attempt ${attempt}/${max})`,
			loadingConnectingServer: "Connecting to server...",
			loadingServerUnavailable: "Application server is not responding to healthcheck requests. Make sure the Roo Code engine is running.",
			loadingAgentView: "Loading agent view...",
			loadingTimeout: "Loading agent view timed out.",
			loadingFrameError: (reason, delay, attempt, max) => `Frame load error (${reason || "connection aborted"}). Retrying in ${delay}ms... (attempt ${attempt}/${max})`,
			loadingFrameFailed: "Failed to load agent view after 3 attempts. Check connection and retry.",
			loadingNetworkError: "Network error while loading iframe.",
			errorTitle: "Failed to load agent view",
			errorDesc: "Server is not responding or connection to core application failed.",
			retryBtn: "Retry",

			// Navigation tabs
			tabAgent: "Agent",
			tabNativeChat: "Chat",
			tabDiffs: "Diffs",
			tabTerminal: "Terminal",
			tabFiles: "Files",
			tabSettings: "Settings",

			// Connection statuses & agent status
			statusConnected: "Connected",
			statusConnecting: "Connecting...",
			statusDisconnected: "Disconnected (Reconnecting...)",
			statusThinking: "Thinking...",
			statusExecuting: "Running Command...",
			statusWaitingApproval: "Waiting for Approval",
			statusError: "Error",
			coreEngineConnected: "Core Engine: Connected",
			coreEngineConnecting: "Core Engine: Reconnecting...",
			connectedToEngine: "Connected to Engine",

			// Explorer & File Preview
			projectFiles: "Project Files",
			searchFilesPlaceholder: "Search project files...",
			loadingFileTree: "Loading file tree...",
			noFilesFound: "No files found",
			noWorkspaceOpen: "No workspace folder open",
			selectFileToPreview: "Select a file from the tree to preview",
			previewPlaceholder: "Select any file from the project tree to view its code, image, or details.",
			failedToLoadFilePreview: "Failed to load file preview",
			fileCouldNotBeOpened: "File could not be opened",
			copy: "Copy",
			wrap: "Wrap",
			sourceCode: "Source Code",
			inExplorer: "In Explorer",

			// Diffs
			modifiedFiles: "Modified Files",
			filesCount: (count) => `${count} file${count === 1 ? "" : "s"}`,
			noChangesRecorded: "No file changes recorded.",
			noChangesAgent: "No changes made by the agent yet.",
			diffsPlaceholder: "When Roo Code modifies files in this workspace, you can inspect the diffs here.",
			selectFileToReview: "Select a file from the list to review changes",
			fileContentNotAvailable: "File content not available",

			// Terminal
			terminalTitle: "Terminal & Agent Command Logs",
			terminalClear: "Clear",
			terminalCopy: "Copy",
			terminalCopied: "Copied!",
			terminalEmpty: "Roo Code terminal command executions and logs will appear here.",
			terminalSessionsTitle: "Command Sessions",
			terminalSessionsCount: (count) => `${count} session${count === 1 ? "" : "s"}`,
			terminalSessionsEmpty: "No terminal sessions recorded.",
			sessionRunning: "Running",
			sessionCompleted: "Completed",
			sessionError: "Failed",

			// Sidebar
			workspaces: "Workspaces",
			projectsSection: "PROJECTS",
			addProject: "Add project",
			newProject: "New Project",
			newProjectDesc: "Open an existing folder on your disk",
			quickProject: "Quick Project",
			quickProjectDesc: "Create instantly in your Roo Code projects folder",
			quickProjectCreating: "Creating Quick Project...",
			quickProjectError: "Failed to create Quick Project",
			viewMoreChats: (count) => `View more (${count})`,
			viewLessChats: "View less",
			selectProjectAria: "Select or change project",
			selectProject: "Select project",
			openProjectFolderSmall: "Open project folder",
			newConversation: "New chat",
			goTo: "Go to…",
			searchProjectsAndChats: "Search projects and chats…",
			manageProjects: "Manage projects",
			sidebarProjectsEmpty: "Loading projects…",
			noChatsYet: "No chats yet",
			relocateProject: "Change location…",
			renameConversation: "Conversation title",
			renameConversationDesc: "A short name makes it easier to find in history.",
			conversationTitleLabel: "Title",
			saveTitle: "Save title",
			close: "Close",
			projects: "Projects",
			relocateProjectTitle: "Relocate project",
			relocateProjectDesc: "Specify the folder where the project has been moved. Chats will retain their assignment. Files will not be moved.",
			projectsDesc: "Open a folder from disk or switch back to one of your projects.",
			projectFolderLabel: "Project folder",
			chooseFolder: "Browse…",
			createEmptyProject: "Create empty project",
			saveLocation: "Save location",
			openProject: "Open project",
			unsavedChanges: "Unsaved changes",
			unsavedChangesDesc: "You have unsaved changes in the editor. What would you like to do?",
			returnToEditing: "Return to editing",
			discardChanges: "Discard changes",
			saveChanges: "Save changes",
			saved: "Saved",
			saveShortcut: "Save",
			closeEditor: "Close editor",
			editFile: "Edit file",
			noResults: "No results. Try another name.",
			addToConversation: "Add to chat",
			edit: "Edit",
			imagePreview: "Image preview",
			showInExplorer: "Show in Explorer",
			projectFooterPrefix: "Project: ",
			connectionPreparing: "Connecting to engine...",
			apiModalTitle: "AI Provider Connection",
			apiModalSubtitle: "Configure AI model connection, API key, and permissions.",
			noConversations: "No conversations",
			newChat: "New Chat",
			toggleSidebar: "Toggle Sidebar (Ctrl+B)",
			activeProject: "Active",
			removeRecent: "Remove from recent",
			newChatInProject: "New chat in this project",
			openWorkspaceFolder: "Open Folder",
			toggleSidebarHint: "toggle sidebar",
			chatStatusRunning: "Task running in background",
			chatStatusNeedsAttention: "Action required from user",
			chatStatusCompletedUnread: "Completed with unread response",
			chatStatusCompleted: "Completed",

			// Chat & Project Management
			deleteChat: "Delete chat",
			deleteChatTitle: "Delete Chat",
			deleteChatConfirmIdle: "Are you sure you want to delete this chat history from Roo Code?\n\nYour project and workspace files will not be affected.",
			deleteChatConfirmRunning: "This chat currently has an active task running in the background.\n\nDeleting it requires stopping the task first. Your workspace files will not be affected.",
			stopTaskAndDelete: "Stop task and delete",
			confirmDelete: "Delete chat",
			chatMenu: "Chat options",
			projectMenu: "Project options",
			renameProject: "Rename project",
			resetProjectName: "Use folder name",
			saveProjectName: "Save name",
			cancelProjectName: "Cancel",
			projectNamePrompt: "Project display name (1–80 characters):",
			projectNameInvalid: "Enter a project name of 1–80 characters.",
			projectNameConnectionError: "Connection lost. Reconnect and try again.",
			openProjectFolder: "Open project folder",
			copyProjectPath: "Copy project path",
			pathCopied: "Project path copied to clipboard",
			removeProject: "Remove project from Roo",
			removeProjectTitle: "Remove Project from Roo Code",
			removeProjectConfirmIdle: (name) => `Are you sure you want to remove "${name}" from Roo Code?\n\nThis project will be removed from your sidebar and its conversation history in Roo Code will be deleted.\n\nYour physical project folder and source files on disk will remain untouched.`,
			removeProjectConfirmRunning: (name, count) => `This project "${name}" has ${count} active task(s) running in the background.\n\nRemoving it from Roo Code requires stopping those tasks first.\n\nYour physical project folder and source files on disk will remain untouched.`,
			stopTasksAndRemove: "Stop tasks and remove",
			confirmRemoveProject: "Remove from Roo",
			renameConversationEmpty: "Enter a conversation title.",
			renameConversationError: "Failed to save conversation title.",
			pickFolderError: "Could not open folder picker. Enter path manually.",
			projectPathRequired: "Enter a path or select a folder.",
			openProjectError: "Failed to open project. Check if folder exists and is accessible.",
			relocateSuccess: "Saved new project location",
			projectOpened: "Project opened",
			manageProjectNamed: (name) => `Manage project ${name}`,
			closeCurrentProject: "Close current project",
			fileAddedToChat: "Added file to message",
			editorSaveFailed: "Failed to save full version. Check editor details.",
			editorProjectChanged: "Project has changed. Reopen file.",
			editorConflict: "File was changed on disk. Copy your changes, close the editor, and reopen the file.",
			fileSaved: "File saved",
			paletteDesc: "Search for an action, project, or file.",
			paletteSearchPlaceholder: "Search actions, projects, and files…",
			conversationsCategory: "Chats",
			projectsCategory: "Projects",
			viewsCategory: "Views",
			configCategory: "Settings",
			filesCategory: "Files",
			reviewDiffs: "Review changes",
			terminal: "Terminal",
			settings: "Settings",
			openFolderToStart: "Open a folder to start working",
		},
		pl: {
			cancel: "Anuluj",
			diffEmpty: "Brak zmian do wyświetlenia.",
			// Loading & Error States
			loadingTitle: "Przygotowuję środowisko pracy…",
			loadingDesc: "Nawiązywanie połączenia z serwerem i przygotowywanie widoku agenta...",
			loadingServerHealth: (attempt, max) => `Oczekiwanie na gotowość serwera... (próba ${attempt}/${max})`,
			loadingConnectingServer: "Nawiązywanie połączenia z serwerem...",
			loadingServerUnavailable: "Serwer aplikacji nie odpowiada na żądania healthcheck. Upewnij się, że silnik Roo Code został uruchomiony.",
			loadingAgentView: "Ładowanie widoku agenta...",
			loadingTimeout: "Przekroczono limit czasu ładowania widoku agenta.",
			loadingFrameError: (reason, delay, attempt, max) => `Błąd ładowania ramki (${reason || "połączenie przerwane"}). Ponawianie za ${delay}ms... (próba ${attempt}/${max})`,
			loadingFrameFailed: "Nie udało się załadować widoku agenta po 3 próbach. Sprawdź połączenie i ponów próbę.",
			loadingNetworkError: "Błąd sieciowy podczas ładowania ramki iframe.",
			errorTitle: "Nie udało się załadować widoku agenta",
			errorDesc: "Serwer nie odpowiada lub wystąpił błąd połączenia z rdzeniem aplikacji.",
			retryBtn: "Ponów próbę",

			// Navigation tabs
			tabAgent: "Agent",
			tabDiffs: "Zmiany",
			tabTerminal: "Terminal",
			tabFiles: "Pliki",
			tabSettings: "Ustawienia",

			// Connection statuses & agent status
			statusConnected: "Połączono",
			statusConnecting: "Łączenie...",
			statusDisconnected: "Rozłączono (Ponowne łączenie...)",
			statusThinking: "Analizuję…",
			statusExecuting: "Wykonywanie polecenia...",
			statusWaitingApproval: "Oczekiwanie na zatwierdzenie",
			statusError: "Błąd",
			coreEngineConnected: "Agent jest gotowy do pracy",
			coreEngineConnecting: "Rdzeń silnika: Ponowne łączenie...",
			connectedToEngine: "Agent gotowy",

			// Explorer & File Preview
			projectFiles: "Pliki projektu",
			searchFilesPlaceholder: "Szukaj plików projektu...",
			loadingFileTree: "Ładowanie drzewa plików...",
			noFilesFound: "Nie znaleziono plików",
			noWorkspaceOpen: "Brak otwartego folderu roboczego",
			selectFileToPreview: "Wybierz plik z drzewa, aby wyświetlić podgląd",
			previewPlaceholder: "Wybierz dowolny plik z drzewa projektu, aby zobaczyć jego kod, obraz lub szczegóły.",
			failedToLoadFilePreview: "Nie udało się załadować podglądu pliku",
			fileCouldNotBeOpened: "Nie można otworzyć pliku",
			copy: "Kopiuj",
			wrap: "Zawijaj",
			sourceCode: "Kod źródłowy",
			inExplorer: "W eksploratorze",

			// Diffs
			modifiedFiles: "Zmodyfikowane pliki",
			filesCount: (count) => `${count} ${new Intl.PluralRules("pl").select(count) === "one" ? "plik" : new Intl.PluralRules("pl").select(count) === "few" ? "pliki" : "plików"}`,
			noChangesRecorded: "Brak zarejestrowanych zmian w plikach.",
			noChangesAgent: "Brak zmian wprowadzonych dotąd przez agenta.",
			diffsPlaceholder: "Gdy Roo Code zmodyfikuje pliki w tym obszarze, zobaczysz tutaj podgląd zmian (diff).",
			selectFileToReview: "Wybierz plik z listy, aby przejrzeć zmiany",
			fileContentNotAvailable: "Zawartość pliku niedostępna",

			// Terminal
			terminalTitle: "Dziennik poleceń terminala i agenta",
			terminalClear: "Wyczyść",
			terminalCopy: "Kopiuj",
			terminalCopied: "Skopiowano!",
			terminalEmpty: "Wyniki poleceń terminala i dzienniki wykonania Roo Code pojawią się tutaj.",
			terminalSessionsTitle: "Sesje poleceń",
			terminalSessionsCount: (count) => `${count} ${new Intl.PluralRules("pl").select(count) === "one" ? "sesja" : new Intl.PluralRules("pl").select(count) === "few" ? "sesje" : "sesji"}`,
			terminalSessionsEmpty: "Brak zarejestrowanych sesji terminala.",
			sessionRunning: "W toku",
			sessionCompleted: "Zakończono",
			sessionError: "Błąd",

			// Sidebar
			workspaces: "Przestrzeń robocza",
			projectsSection: "Projekty",
			addProject: "Dodaj projekt",
			newProject: "Nowy projekt",
			newProjectDesc: "Otwórz istniejący folder na dysku",
			quickProject: "Szybki projekt",
			quickProjectDesc: "Utwórz natychmiast w folderze projektów Roo Code",
			quickProjectCreating: "Tworzenie szybkiego projektu...",
			quickProjectError: "Nie udało się utworzyć szybkiego projektu",
			viewMoreChats: (count) => `Pokaż więcej (${count})`,
			viewLessChats: "Pokaż mniej",
			selectProjectAria: "Wybierz lub zmień projekt",
			selectProject: "Wybierz projekt",
			openProjectFolderSmall: "Otwórz folder projektu",
			newConversation: "Nowa rozmowa",
			goTo: "Przejdź do…",
			searchProjectsAndChats: "Szukaj projektów i rozmów…",
			manageProjects: "Zarządzaj projektami",
			sidebarProjectsEmpty: "Wczytuję projekty…",
			noChatsYet: "Nie masz jeszcze żadnych rozmów",
			relocateProject: "Zmień lokalizację…",
			renameConversation: "Nazwa rozmowy",
			renameConversationDesc: "Krótka nazwa ułatwi jej odnalezienie w historii.",
			conversationTitleLabel: "Tytuł",
			saveTitle: "Zapisz nazwę",
			close: "Zamknij",
			projects: "Projekty",
			relocateProjectTitle: "Zmień lokalizację projektu",
			relocateProjectDesc: "Wskaż folder, do którego projekt został przeniesiony. Rozmowy zachowają przypisanie. Pliki nie będą przenoszone.",
			projectsDesc: "Otwórz folder z dysku albo wróć do jednego ze swoich projektów.",
			projectFolderLabel: "Folder projektu",
			chooseFolder: "Wybierz…",
			createEmptyProject: "Utwórz pusty projekt",
			saveLocation: "Zapisz lokalizację",
			openProject: "Otwórz projekt",
			unsavedChanges: "Niezapisane zmiany",
			unsavedChangesDesc: "W edytorze znajdują się niezapisane zmiany. Co chcesz zrobić?",
			returnToEditing: "Wróć do edycji",
			discardChanges: "Odrzuć zmiany",
			saveChanges: "Zapisz zmiany",
			saved: "Zapisano",
			saveShortcut: "Zapisz",
			closeEditor: "Zamknij edytor",
			editFile: "Edytuj plik",
			noResults: "Brak wyników. Spróbuj innej nazwy.",
			addToConversation: "Dodaj do rozmowy",
			edit: "Edytuj",
			imagePreview: "Podgląd obrazu",
			showInExplorer: "Pokaż w Eksploratorze",
			projectFooterPrefix: "Projekt: ",
			connectionPreparing: "Łączę się z agentem…",
			apiModalTitle: "Połączenie z dostawcą AI",
			apiModalSubtitle: "Wybierz dostawcę, podaj klucz API i model.",
			searchChatsPlaceholder: "Szukaj rozmów…",
			refreshFiles: "Odśwież pliki",
			projectPathTitle: "Ścieżka projektu",
			windowMinimize: "Minimalizuj",
			windowMaximize: "Maksymalizuj",
			windowClose: "Zamknij",
			noConversations: "Brak rozmów",
			newChat: "Nowa rozmowa",
			toggleSidebar: "Zwiń/Rozwiń panel (Ctrl+B)",
			activeProject: "Aktywny",
			removeRecent: "Usuń z listy",
			newChatInProject: "Nowa rozmowa w tym projekcie",
			openWorkspaceFolder: "Otwórz folder",
			toggleSidebarHint: "panel boczny",
			chatStatusRunning: "Zadanie działa w tle",
			chatStatusNeedsAttention: "Wymagana reakcja użytkownika",
			chatStatusCompletedUnread: "Zakończono z nieprzeczytaną odpowiedzią",
			chatStatusCompleted: "Zakończono",

			// Chat & Project Management
			deleteChat: "Usuń rozmowę",
			deleteChatTitle: "Usuń rozmowę",
			deleteChatConfirmIdle: "Czy na pewno chcesz usunąć tę historię rozmowy z Roo Code?\n\nPliki projektu i folderu roboczego pozostaną nietknięte.",
			deleteChatConfirmRunning: "W tej rozmowie jest zadanie działające w tle.\n\nUsunięcie go wymaga wcześniejszego zatrzymania zadania. Pliki folderu roboczego pozostaną nietknięte.",
			stopTaskAndDelete: "Zatrzymaj zadanie i usuń",
			confirmDelete: "Usuń rozmowę",
			chatMenu: "Opcje rozmowy",
			projectMenu: "Opcje projektu",
			renameProject: "Zmień nazwę projektu",
			resetProjectName: "Przywróć nazwę folderu",
			saveProjectName: "Zapisz nazwę",
			cancelProjectName: "Anuluj",
			projectNamePrompt: "Nazwa wyświetlana projektu (1–80 znaków):",
			projectNameInvalid: "Podaj nazwę projektu o długości 1–80 znaków.",
			projectNameConnectionError: "Utracono połączenie. Połącz się ponownie i spróbuj jeszcze raz.",
			openProjectFolder: "Otwórz folder projektu",
			copyProjectPath: "Kopiuj ścieżkę projektu",
			pathCopied: "Ścieżka projektu skopiowana do schowka",
			removeProject: "Usuń projekt z Roo",
			removeProjectTitle: "Usuń projekt z Roo Code",
			removeProjectConfirmIdle: (name) => `Czy na pewno chcesz usunąć projekt "${name}" z Roo Code?\n\nProjekt zostanie usunięty z paska bocznego, a jego historia rozmów w Roo Code zostanie usunięta.\n\nFizyczny folder projektu i pliki źródłowe na dysku pozostaną nietknięte.`,
			removeProjectConfirmRunning: (name, count) => `Projekt "${name}" posiada ${count} aktywnych zadań działających w tle.\n\nUsunięcie go z Roo Code wymaga zatrzymania tych zadań.\n\nFizyczny folder projektu i pliki źródłowe na dysku pozostaną nietknięte.`,
			stopTasksAndRemove: "Zatrzymaj zadania i usuń projekt",
			confirmRemoveProject: "Usuń z Roo",
			renameConversationEmpty: "Wpisz tytuł rozmowy.",
			renameConversationError: "Nie udało się zapisać nazwy.",
			pickFolderError: "Nie udało się otworzyć wyboru folderu. Wpisz ścieżkę ręcznie.",
			projectPathRequired: "Wpisz ścieżkę lub wybierz folder.",
			openProjectError: "Nie udało się otworzyć projektu. Sprawdź, czy folder istnieje i jest dostępny.",
			relocateSuccess: "Zapisano nową lokalizację projektu",
			projectOpened: "Projekt otwarty",
			manageProjectNamed: (name) => `Zarządzaj projektem ${name}`,
			closeCurrentProject: "Zamknij bieżący projekt",
			fileAddedToChat: "Dodano plik do wiadomości",
			editorSaveFailed: "Nie udało się zapisać całej wersji. Sprawdź informację przy edytorze.",
			editorProjectChanged: "Projekt został zmieniony. Otwórz plik ponownie.",
			editorConflict: "Plik został zmieniony na dysku. Skopiuj swoje zmiany, zamknij edytor i otwórz plik ponownie. Twoja wersja pozostaje w edytorze.",
			fileSaved: "Zapisano plik",
			paletteDesc: "Wyszukaj działanie, projekt lub plik.",
			paletteSearchPlaceholder: "Szukaj działań, projektów i plików…",
			conversationsCategory: "Rozmowy",
			projectsCategory: "Projekty",
			viewsCategory: "Widoki",
			configCategory: "Konfiguracja",
			filesCategory: "Pliki",
			reviewDiffs: "Przejrzyj zmiany",
			terminal: "Terminal",
			settings: "Ustawienia",
			openFolderToStart: "Otwórz folder, aby rozpocząć pracę",
		},
	}

	let currentLanguage = localStorage.getItem("roo-language") || "en"

	function tDesktop(key, ...args) {
		const lang = currentLanguage === "pl" ? "pl" : "en"
		const entry = desktopTranslations[lang]?.[key] ?? desktopTranslations.en[key]
		if (typeof entry === "function") {
			return entry(...args)
		}
		return entry ?? key
	}

	function applyDesktopTranslations(lang) {
		if (lang) {
			currentLanguage = (lang === "pl" || (typeof lang === "string" && lang.startsWith("pl"))) ? "pl" : "en"
		}

		// 1. Loading & Error elements
		if (webviewLoadingTitle) webviewLoadingTitle.textContent = tDesktop("loadingTitle")
		if (webviewLoadingDesc && (!webviewLoadingDesc.dataset?.custom || webviewLoadingDesc.textContent === desktopTranslations.en.loadingDesc || webviewLoadingDesc.textContent === desktopTranslations.pl.loadingDesc)) {
			webviewLoadingDesc.textContent = tDesktop("loadingDesc")
		}
		if (webviewErrorTitle) webviewErrorTitle.textContent = tDesktop("errorTitle")
		if (webviewErrorDesc && (!webviewErrorDesc.dataset?.custom || webviewErrorDesc.textContent === desktopTranslations.en.errorDesc || webviewErrorDesc.textContent === desktopTranslations.pl.errorDesc)) {
			webviewErrorDesc.textContent = tDesktop("errorDesc")
		}
		if (webviewRetryText) webviewRetryText.textContent = tDesktop("retryBtn")

		// 2. Tab labels
		if (tabLabelChat) tabLabelChat.textContent = tDesktop("tabAgent")
		const tabLabelNativeChat = document.getElementById("tab-label-native-chat")
		if (tabLabelNativeChat) tabLabelNativeChat.textContent = tDesktop("tabNativeChat")
		if (tabLabelDiffs) tabLabelDiffs.textContent = tDesktop("tabDiffs")
		if (tabLabelTerminal) tabLabelTerminal.textContent = tDesktop("tabTerminal")
		if (tabLabelFiles) tabLabelFiles.textContent = tDesktop("tabFiles")
		if (tabLabelSettings) tabLabelSettings.textContent = tDesktop("tabSettings")
		if (settingsModalTitleText) settingsModalTitleText.textContent = tDesktop("tabSettings")
		if (openSettingsBtn) openSettingsBtn.title = tDesktop("tabSettings")
		if (closeSettingsModalBtn) closeSettingsModalBtn.title = currentLanguage === "pl" ? "Zamknij (Esc)" : "Close (Esc)"

		// 3. Connection badge & status texts
		if (isConnected) {
			if (connectionStatusEl) connectionStatusEl.textContent = tDesktop("connectedToEngine")
			if (engineConnectionText && !currentAgentStatus) engineConnectionText.textContent = tDesktop("statusConnected")
			if (engineConnectionBadge && !currentAgentStatus) engineConnectionBadge.title = tDesktop("coreEngineConnected")
		} else {
			if (connectionStatusEl) connectionStatusEl.textContent = tDesktop("statusDisconnected")
			if (engineConnectionText) engineConnectionText.textContent = tDesktop("statusConnecting")
			if (engineConnectionBadge) engineConnectionBadge.title = tDesktop("coreEngineConnecting")
		}
		if (currentAgentStatus) {
			updateAgentStatus(currentAgentStatus)
		}

		// 4. Explorer titles & placeholders
		if (filesSidebarTitle) filesSidebarTitle.textContent = tDesktop("projectFiles")
		if (filesSearchInput) filesSearchInput.placeholder = tDesktop("searchFilesPlaceholder")
		if (filesTreeEmpty) filesTreeEmpty.textContent = tDesktop("loadingFileTree")
		if (previewFilenameEl && !selectedPreviewFile) {
			previewFilenameEl.textContent = tDesktop("selectFileToPreview")
		}
		if (previewCopyText) previewCopyText.textContent = tDesktop("copy")
		if (previewWrapText) previewWrapText.textContent = tDesktop("wrap")
		if (previewSourceText) previewSourceText.textContent = isSvgSourceView ? tDesktop("imagePreview") : tDesktop("sourceCode")
		if (previewInExplorerText) previewInExplorerText.textContent = tDesktop("inExplorer")
		if (previewPlaceholderText) previewPlaceholderText.textContent = tDesktop("previewPlaceholder")

		// 5. Diffs titles & placeholders
		if (diffsSidebarTitle) diffsSidebarTitle.textContent = tDesktop("modifiedFiles")
		if (diffFileCounterEl) diffFileCounterEl.textContent = tDesktop("filesCount", diffFiles.length)
		if (diffsPlaceholderText) diffsPlaceholderText.textContent = tDesktop("diffsPlaceholder")
		const diffViewerFilename = diffViewerHeaderEl?.querySelector(".diff-filename")
		if (diffViewerFilename && !selectedDiffFile) {
			diffViewerFilename.textContent = tDesktop("selectFileToReview")
		}

		// 6. Terminal titles & placeholders
		if (terminalTitleText && !selectedTerminalSessionId) terminalTitleText.textContent = tDesktop("terminalTitle")
		if (terminalClearText) terminalClearText.textContent = tDesktop("terminalClear")
		if (terminalCopyText) terminalCopyText.textContent = tDesktop("terminalCopy")
		if (terminalEmptyText) terminalEmptyText.textContent = tDesktop("terminalEmpty")
		if (terminalSidebarTitle) terminalSidebarTitle.textContent = tDesktop("terminalSessionsTitle")
		if (terminalSessionCounter) terminalSessionCounter.textContent = tDesktop("terminalSessionsCount", terminalSessions.length)
		if (terminalSessionsEmpty) terminalSessionsEmpty.textContent = tDesktop("terminalSessionsEmpty")

		// 7. Sidebar elements
		if (sidebarHeaderTitleEl) sidebarHeaderTitleEl.textContent = tDesktop("workspaces")
		if (sidebarProjectsLabelEl) sidebarProjectsLabelEl.textContent = tDesktop("projectsSection")
		if (sidebarAddProjectBtn) {
			sidebarAddProjectBtn.title = tDesktop("addProject")
			sidebarAddProjectBtn.setAttribute("aria-label", tDesktop("addProject"))
		}
		if (sidebarHintTextEl) sidebarHintTextEl.textContent = tDesktop("toggleSidebarHint")
		if (sidebarToggleBtn) sidebarToggleBtn.title = tDesktop("toggleSidebar")

		// 8. Product Workspace shell elements
		const projectSwitcherEl = document.getElementById("project-switcher")
		if (projectSwitcherEl) {
			projectSwitcherEl.setAttribute("aria-label", tDesktop("selectProjectAria"))
			const strong = projectSwitcherEl.querySelector("strong")
			const small = projectSwitcherEl.querySelector("small")
			if (strong && (strong.textContent === "Wybierz projekt" || strong.textContent === "Select project")) {
				strong.textContent = tDesktop("selectProject")
			}
			if (small && (small.textContent === "Otwórz folder projektu" || small.textContent === "Open project folder")) {
				small.textContent = tDesktop("openProjectFolderSmall")
			}
		}

		const workspaceNewChatBtn = document.getElementById("workspace-new-chat")
		if (workspaceNewChatBtn) {
			workspaceNewChatBtn.innerHTML = `<span>＋</span> ${escapeHtml(tDesktop("newConversation"))} <kbd>Ctrl+N</kbd>`
		}

		const workspaceCommandBtn = document.getElementById("workspace-command-button")
		if (workspaceCommandBtn) {
			workspaceCommandBtn.innerHTML = `<span>⌕</span> ${escapeHtml(tDesktop("goTo"))} <kbd>Ctrl+K</kbd>`
		}

		const workspaceSearchInput = document.getElementById("workspace-project-search")
		if (workspaceSearchInput) {
			workspaceSearchInput.placeholder = tDesktop("searchProjectsAndChats")
			workspaceSearchInput.setAttribute("aria-label", tDesktop("searchProjectsAndChats"))
		}

		const projectManagerBtn = document.getElementById("project-manager-button")
		if (projectManagerBtn) projectManagerBtn.textContent = tDesktop("manageProjects")

		const workspaceSettingsBtn = document.getElementById("workspace-settings-button")
		if (workspaceSettingsBtn) {
			workspaceSettingsBtn.innerHTML = `${escapeHtml(tDesktop("tabSettings"))} <kbd>Ctrl+,</kbd>`
		}

		const labelNewChat = document.getElementById("label-new-chat")
		if (labelNewChat) labelNewChat.textContent = tDesktop("newConversation")

		const chatSearchInput = document.getElementById("chat-search-input")
		if (chatSearchInput) chatSearchInput.placeholder = tDesktop("searchChatsPlaceholder")

		const chatSidebarEmpty = document.querySelector(".chat-sidebar-empty")
		if (chatSidebarEmpty) chatSidebarEmpty.textContent = tDesktop("noChatsYet")

		const previewAddContextBtn = document.getElementById("preview-add-context-btn")
		if (previewAddContextBtn) previewAddContextBtn.textContent = tDesktop("addToConversation")

		const previewEditBtn = document.getElementById("preview-edit-btn")
		if (previewEditBtn) previewEditBtn.textContent = tDesktop("edit")

		const filesRefreshBtn = document.getElementById("files-refresh-btn")
		if (filesRefreshBtn) filesRefreshBtn.setAttribute("aria-label", tDesktop("refreshFiles"))

		const footerWorkspacePath = document.getElementById("footer-workspace-path")
		if (footerWorkspacePath && !currentWorkspace?.path) {
			footerWorkspacePath.textContent = `${tDesktop("projectFooterPrefix")}…`
			footerWorkspacePath.title = tDesktop("projectPathTitle")
		}

		const minimizeBtn = document.getElementById("window-minimize-btn")
		if (minimizeBtn) minimizeBtn.title = tDesktop("windowMinimize")

		const maximizeBtn = document.getElementById("window-maximize-btn")
		if (maximizeBtn) maximizeBtn.title = tDesktop("windowMaximize")

		const closeBtn = document.getElementById("window-close-btn")
		if (closeBtn) closeBtn.title = tDesktop("windowClose")

		if (isDesktopAppInitialized && typeof renderSidebar === "function") renderSidebar()
		if (isDesktopAppInitialized && window.ProductWorkspace?.update) window.ProductWorkspace.update()
	}

	// Apply initial desktop translations immediately
	applyDesktopTranslations(currentLanguage)

	// Tab state & performance flags (instant keep-alive)
	let diffsDirty = true
	let diffsRenderedOnce = false
	let terminalDirty = true
	let terminalRenderedOnce = false
	let lastRenderedTerminalSessionId = null
	let filesDirty = true

	function switchDesktopTab(targetTab, origin = "user", values = null) {
		if (!targetTab) return
		if (targetTab === "settings") {
			openSettingsModal()
			return
		}
		// Loop guard / idempotency check
		if (currentDesktopTab === targetTab) return

		const t0 = performance.now()
		const prevTab = currentDesktopTab
		currentDesktopTab = targetTab

		// Update nav tabs active styling (main tabs: chat, native-chat, diffs, terminal, files)
		tabs.forEach((t) => t.classList.toggle("active", t.getAttribute("data-tab") === targetTab))

		// Update panels active styling (chat and native-chat share tab-chat container)
		panels.forEach((p) => {
			const isPanelActive =
				(p.id === "tab-chat" && (targetTab === "chat" || targetTab === "native-chat")) ||
				p.id === `tab-${targetTab}`
			p.classList.toggle("active", isPanelActive)
		})

		const agentSidebarEl = document.getElementById("agent-sidebar-view")
		const chatSidebarEl = document.getElementById("chat-sidebar-view")
		const sidebarHeaderTitleEl = document.getElementById("sidebar-header-title")

		if (targetTab === "native-chat") {
			if (agentSidebarEl) agentSidebarEl.style.display = "none"
			if (chatSidebarEl) chatSidebarEl.style.display = "flex"
			if (sidebarHeaderTitleEl) sidebarHeaderTitleEl.textContent = "Rozmowy"
			renderChatSidebar()
			if (origin === "user") {
				forwardToWebview({
					type: "switchTab",
					tab: "nativeChat",
					origin: "sync",
				})
			}
		} else {
			if (chatSidebarEl) chatSidebarEl.style.display = "none"
			if (agentSidebarEl) agentSidebarEl.style.display = "flex"
			if (sidebarHeaderTitleEl) sidebarHeaderTitleEl.textContent = tDesktop("workspaces") || "Workspaces"
			if (targetTab === "chat") {
				renderSidebar()
				if (origin === "user") {
					forwardToWebview({
						type: "switchTab",
						tab: "chat",
						origin: "sync",
					})
				}
			}
		}

		// If switching to files tab and files tree is empty or requires refresh, load files
		if (targetTab === "files") {
			const isTreeEmpty = !filesTreeEl || filesTreeEl.children.length === 0 || filesTreeEl.querySelector(".empty-state")
			if (filesDirty || !currentWorkspace?.files || currentWorkspace.files.length === 0 || isTreeEmpty) {
				loadWorkspaceFiles()
				filesDirty = false
			}
		}

		if (targetTab === "diffs") {
			if (diffsDirty || !diffsRenderedOnce) {
				renderDiffs()
				diffsDirty = false
				diffsRenderedOnce = true
				sendToServer({ type: "getDiffs" })
			}
		}

		if (targetTab === "terminal") {
			if (!terminalRenderedOnce) sendToServer({ type: "getTerminalLogs" })
			const activeSession = terminalSessions.find((s) => s.id === selectedTerminalSessionId) || terminalSessions[0]
			if (terminalDirty || !terminalRenderedOnce || lastRenderedTerminalSessionId !== selectedTerminalSessionId || activeSession?._dirty) {
				renderTerminalLogs()
				terminalDirty = false
				terminalRenderedOnce = true
				if (activeSession) activeSession._dirty = false
				lastRenderedTerminalSessionId = selectedTerminalSessionId
			}
		}

		const switchDur = performance.now() - t0
		queueMicrotask(()=>productWorkspace?.update())
		console.debug(`[TabPerf] Switched from ${prevTab || "none"} to ${targetTab} in ${switchDur.toFixed(2)}ms`)
	}

	// Setup Tabs Navigation
	const tabs = document.querySelectorAll(".nav-tab")
	const panels = document.querySelectorAll(".tab-panel")

	tabs.forEach((tab) => {
		tab.addEventListener("click", () => {
			const targetTab = tab.getAttribute("data-tab")
			switchDesktopTab(targetTab, "user")
		})
	})

	// Theme Synchronization (5 themes)
	function applyDesktopTheme(theme, persist = false) {
		if (!theme) return
		const isLight = theme === "clean-light" || theme === "light"
		document.body.classList.toggle("light-theme", isLight)
		document.body.classList.toggle("dark-theme", !isLight)
		document.body.setAttribute("data-theme", theme)
		if (persist) {
			localStorage.setItem("roo-theme", theme)
		}
		webviewFrame?.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
		settingsWebviewFrame?.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
	}

	const savedTheme = localStorage.getItem("roo-theme") || "linear-dark"
	applyDesktopTheme(savedTheme)

	// Window Controls (Minimize, Maximize, Close)
	windowMinimizeBtn?.addEventListener("click", () => {
		if (desktopBridge?.window?.minimize) {
			desktopBridge.window.minimize()
		} else {
			window.__desktopAPI?.minimize?.()
		}
	})
	windowMaximizeBtn?.addEventListener("click", () => {
		if (desktopBridge?.window?.maximize) {
			desktopBridge.window.maximize()
		} else {
			window.__desktopAPI?.maximize?.()
		}
	})
	windowCloseBtn?.addEventListener("click", () => {
		if (desktopBridge?.window?.close) {
			desktopBridge.window.close()
		} else {
			window.__desktopAPI?.close?.()
		}
	})

	// ==========================================
	// AntiGravity Sidebar (Projects & Chats)
	// ==========================================
	// Restore initial collapsed state
	if (sidebarEl && isSidebarCollapsed) {
		sidebarEl.classList.add("collapsed")
	}

	function toggleSidebar(forceState) {
		if (!sidebarEl) return
		if (typeof forceState === "boolean") {
			isSidebarCollapsed = forceState
		} else {
			isSidebarCollapsed = !sidebarEl.classList.contains("collapsed")
		}
		sidebarEl.classList.toggle("collapsed", isSidebarCollapsed)
		try {
			localStorage.setItem("roo-sidebar-collapsed", isSidebarCollapsed ? "true" : "false")
		} catch (e) {}
	}

	sidebarToggleBtn?.addEventListener("click", () => toggleSidebar())

	// Global shortcuts: Ctrl+B / Cmd+B (toggle sidebar), Ctrl+N / Cmd+N (new chat), Ctrl+O / Cmd+O (add / open project)
	window.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B") && !e.shiftKey && !e.altKey) {
			e.preventDefault()
			toggleSidebar()
		}
		if ((e.ctrlKey || e.metaKey) && (e.key === "n" || e.key === "N") && !e.shiftKey && !e.altKey) {
			e.preventDefault()
			startNewChat()
		}
		if ((e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "O") && !e.shiftKey && !e.altKey) {
			e.preventDefault()
			openFolderDialog()
		}
	})

	sidebarAddProjectBtn?.addEventListener("click", (e) => {
		e.stopPropagation()
		if (activeContextMenuTrigger === sidebarAddProjectBtn && sidebarContextMenuEl && !sidebarContextMenuEl.classList.contains("hidden")) {
			closeSidebarContextMenu()
			return
		}
		openAddProjectMenu()
	})

	function openAddProjectMenu() {
		if (!sidebarAddProjectBtn) return
		const rect = sidebarAddProjectBtn.getBoundingClientRect()
		const items = [
			{
				label: tDesktop("newProject") || "New Project",
				description: tDesktop("newProjectDesc") || "Open an existing folder on your disk",
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
				action: () => {
					openFolderDialog()
				},
			},
			{
				label: tDesktop("quickProject") || "Quick Project",
				description: tDesktop("quickProjectDesc") || "Create instantly in your Roo Code projects folder",
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
				action: () => {
					handleCreateQuickProject()
				},
			},
		]
		openSidebarContextMenu({
			x: rect.left,
			y: rect.bottom + 4,
			items,
			triggerEl: sidebarAddProjectBtn,
		})
	}

	async function handleCreateQuickProject() {
		closeSidebarContextMenu()
		try {
			let result = null
			if (desktopBridge?.shell?.createQuickProject) {
				result = await desktopBridge.shell.createQuickProject()
			} else if (window.__desktopAPI?.createQuickProject) {
				result = await window.__desktopAPI.createQuickProject()
			} else {
				const resp = await fetch("/api/quick-project", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
				})
				if (!resp.ok) {
					const errData = await resp.json().catch(() => ({}))
					throw new Error(errData.error || `HTTP ${resp.status}`)
				}
				result = await resp.json()
			}

			const projectPath = result?.path || result?.workspace?.path
			if (projectPath) {
				projectExpansions.add(projectPath)
				await selectWorkspaceFolder(projectPath)
				await fetchSidebarData()
			}
		} catch (err) {
			console.error("Failed to create Quick Project:", err)
			productWorkspace.notify(tDesktop("quickProjectError") + ": " + (err.message || err))
		}
	}

	async function openFolderDialog() { return productWorkspace?.projects() }

	async function startNewChat(workspacePath) {
		if (!workspacePath && !currentWorkspace?.path) { await productWorkspace.projects(); return }
		if (!await productWorkspace.guardEditor()) return
		if (workspacePath && (!currentWorkspace?.path || pathNormalize(workspacePath) !== pathNormalize(currentWorkspace.path))) {
			if (!await selectWorkspaceFolder(workspacePath)) return
		}
		activeTaskId = null
		if (latestExtensionState) {
			latestExtensionState.currentTaskId = undefined
			latestExtensionState.currentTaskItem = undefined
			latestExtensionState.clineMessages = []
		}
		renderSidebar()

		// Reset active terminal logs and diffs for completed task
		terminalLogs = []
		diffFiles = []
		selectedDiffFile = null
		renderTerminalLogs()
		renderDiffs()

		sendToServer({ type: "newChat", workspacePath })
		sendToServer({ type: "webviewMessage", message: { type: "clearTask" } })

		forwardToWebview({ type: "action", action: "chatButtonClicked" })
		forwardToWebview({ type: "action", action: "clearTask" })
		forwardToWebview({ type: "action", action: "focusInput" })

		switchDesktopTab("chat", "user")
	}

	function pathNormalize(p) {
		if (!p) return ""
		return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
	}

	function formatTimeAgo(ts) {
		if (!ts || typeof ts !== "number") return ""
		const diff = Date.now() - ts
		if (diff < 60000) return "Just now"
		const mins = Math.floor(diff / 60000)
		if (mins < 60) return `${mins}m ago`
		const hours = Math.floor(mins / 60)
		if (hours < 24) return `${hours}h ago`
		const days = Math.floor(hours / 24)
		if (days === 1) return "Yesterday"
		if (days < 7) return `${days}d ago`
		const d = new Date(ts)
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
	}

	async function fetchSidebarData() {
		try {
			const res = await fetch("/api/sidebar-data")
			if (res.ok) {
				const data = await res.json()
				updateSidebarData(data)
			}
		} catch (e) {
			console.warn("[Sidebar] Failed to fetch sidebar data:", e)
		}
	}

	function updateSidebarData(data) {
		if (!data) return
		if (data.activeTaskId && !activeTaskId) {
			activeTaskId = data.activeTaskId
		}
		sidebarData = {
			recentWorkspaces: Array.isArray(data.recentWorkspaces) ? data.recentWorkspaces : [],
			projectNames: data.projectNames || {},
			currentWorkspace: data.currentWorkspace || currentWorkspace?.path || "",
			activeTaskId: data.activeTaskId ?? activeTaskId,
			chats: data.chats || {},
		}

		if (Array.isArray(data.recentWorkspaces)) {
			try {
				localStorage.setItem("roo-desktop-workspaces-order", JSON.stringify(data.recentWorkspaces))
			} catch {}
		}

		// Auto-expand current workspace if nothing is expanded
		if (sidebarData.currentWorkspace && projectExpansions.size === 0) {
			projectExpansions.add(sidebarData.currentWorkspace)
		}

		renderSidebar()
	}

	function handleConversationTitleUpdated(msg) {
		const { taskId, title, titleSource } = msg
		if (!taskId || !title) return

		// Update in-memory sidebarData
		for (const ws of Object.keys(sidebarData.chats || {})) {
			const chat = (sidebarData.chats[ws] || []).find((c) => c.id === taskId)
			if (chat) {
				chat.title = title
				if (titleSource) chat.titleSource = titleSource
			}
		}

		// Surgical in-place DOM update (flicker-free, jump-free)
		const chatEl = document.querySelector(`.sidebar-chat-item[data-task-id="${taskId}"]`)
		if (chatEl) {
			const titleEl = chatEl.querySelector(".chat-title")
			if (titleEl) {
				const formatted = formatChatTitle(title)
				titleEl.textContent = formatted
				titleEl.title = formatted
				titleEl.classList.add("title-updated")
			}
		}
	}

	async function switchChat(taskId, wsPath) {
		if (!taskId) return
		if (!await productWorkspace.guardEditor()) return
		const webviewTaskId = latestExtensionState?.currentTaskId
		if (taskId === activeTaskId && webviewTaskId === taskId) return
		const thisEpoch = ++currentSelectionEpoch
		activeTaskId = taskId

		// Optimistically clear unread badge for the opened chat
		for (const chatList of Object.values(sidebarData.chats)) {
			const found = chatList.find((c) => c.id === taskId)
			if (found && found.hasUnread) {
				found.hasUnread = false
				break
			}
		}

		if (wsPath) {
			projectExpansions.add(wsPath)
			const chatList = sidebarData.chats[wsPath] || []
			const idx = chatList.findIndex((c) => c.id === taskId)
			if (idx >= MAX_VISIBLE_CHATS) {
				projectChatExpansions.add(wsPath)
			}
		}

		renderSidebar()

		switchDesktopTab("chat", "user")

		forwardToWebview({ type: "showTaskWithId", text: taskId, selectionEpoch: thisEpoch })
		sendToServer({ type: "markChatRead", taskId })


		try {
			const resp = await fetch("/api/chat/switch", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ taskId, workspacePath: wsPath }),
			})
			if (!resp.ok) {
				sendToServer({ type: "switchChat", taskId, workspacePath: wsPath })
			}
		} catch (err) {
			console.warn("[Sidebar] Error calling switch chat endpoint, using WS:", err)
			sendToServer({ type: "switchChat", taskId, workspacePath: wsPath })
		}
	}

	let selectingProject = false
	async function selectWorkspaceFolder(wsPath) {
		if (typeof wsPath !== "string" || selectingProject) return false
		if (!await productWorkspace.guardEditor()) return false
		selectingProject = true
		try {
			const resp = await fetch("/api/workspace", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:wsPath})})
			if (!resp.ok) return false
			const data = await resp.json()
			activeTaskId = null
			currentWorkspace = data
			if (wsPath) projectExpansions.add(data.path)
			forwardToWebview({type:"action",action:"switchWorkspace",workspacePath:data.path})
			forwardToWebview({type:"action",action:"clearTask"})
			renderWorkspaceInfo(data)
			await fetchSidebarData()
			return true
		} catch (error) { console.error("Nie udało się otworzyć projektu",error);return false }
		finally { selectingProject = false }
	}

	function formatChatTitle(task, title, maxLength = 80) {
		const raw =
			typeof title === "string" && title.trim()
				? title.trim()
				: typeof task === "string" && task.trim()
					? task.trim()
					: ""

		if (!raw) return "Untitled Task"

		const lines = raw.split(/\r?\n/)
		let candidate = ""

		for (const line of lines) {
			let cleaned = line.trim()
			if (!cleaned) continue

			if (/^```[a-zA-Z0-9_-]*$/.test(cleaned)) continue

			cleaned = cleaned.replace(/^#+\s*/, "")
			cleaned = cleaned.replace(/^>\s*/, "")
			cleaned = cleaned.replace(/^([-*+]|\d+\.)\s*(\[[ xX]\]\s*)?/, "")
			cleaned = cleaned.replace(/(\*\*|__|\*|_|~~)(.*?)\1/g, "$2")
			cleaned = cleaned.replace(/`([^`]+)`/g, "$1")
			cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
			cleaned = cleaned.replace(/<[^>]+>/g, "")
			cleaned = cleaned.replace(/\s+/g, " ").trim()

			if (cleaned) {
				candidate = cleaned
				break
			}
		}

		if (!candidate) return "Untitled Task"

		const chars = Array.from(candidate)
		if (chars.length > maxLength) {
			return chars.slice(0, maxLength - 3).join("").trimEnd() + "..."
		}
		return candidate
	}

	function showConfirmationModal({ title, subtitle, icon, message, confirmText, confirmClass, onConfirm }) {
		if (!confirmationModalBackdrop) return
		lastFocusedElement = document.activeElement

		const cleanSubtitle = formatChatTitle(subtitle, undefined, 80)

		if (confirmationModalTitle) confirmationModalTitle.textContent = title || "Confirm"
		if (confirmationModalSubtitle) {
			confirmationModalSubtitle.textContent = cleanSubtitle || ""
			confirmationModalSubtitle.title =
				(typeof subtitle === "string" ? subtitle.replace(/\s+/g, " ").trim() : "") || cleanSubtitle
		}
		if (confirmationModalIcon) confirmationModalIcon.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></svg>'
		if (confirmationModalBody) confirmationModalBody.textContent = message || ""
		if (confirmationModalConfirmBtn) {
			confirmationModalConfirmBtn.textContent = confirmText || tDesktop("confirm") || "Confirm"
			confirmationModalConfirmBtn.className = `btn ${confirmClass || "btn-danger"}`
		}
		if (confirmationModalCancelBtn) {
			confirmationModalCancelBtn.textContent = tDesktop("cancel") || "Cancel"
		}

		confirmationAction = onConfirm
		confirmationModalBackdrop.classList.remove("hidden")
		confirmationModalBackdrop.style.display = "flex"
		confirmationModalCancelBtn?.focus()
	}

	function closeConfirmationModal() {
		if (!confirmationModalBackdrop) return
		confirmationModalBackdrop.classList.add("hidden")
		confirmationModalBackdrop.style.display = "none"
		confirmationAction = null

		if (lastFocusedElement && typeof lastFocusedElement.focus === "function" && document.contains(lastFocusedElement)) {
			try {
				lastFocusedElement.focus()
			} catch (e) {}
		} else {
			const projectList = document.getElementById("sidebar-projects-list")
			projectList?.focus?.()
		}
		lastFocusedElement = null
	}

	// =========================================================================
	// Native AI Chat Mode - Sidebar Controller
	// =========================================================================
	let chatSessionsList = []
	let activeChatSessionId = null
	let chatSearchFilter = ""

	async function fetchChatSessions() {
		try {
			const res = await fetch("/api/chat-sessions")
			if (res.ok) {
				const data = await res.json()
				chatSessionsList = Array.isArray(data.sessions) ? data.sessions : []
				renderChatSidebar()
			}
		} catch (err) {
			console.warn("[ChatSidebar] Failed to fetch chat sessions:", err)
		}
	}

	function renderChatSidebar() {
		const listEl = document.getElementById("chat-sessions-list")
		if (!listEl) return

		let filtered = chatSessionsList
		if (chatSearchFilter.trim()) {
			const q = chatSearchFilter.trim().toLowerCase()
			filtered = chatSessionsList.filter((s) => {
				const titleMatch = s.title && s.title.toLowerCase().includes(q)
				const previewMatch = s.lastMessagePreview && s.lastMessagePreview.toLowerCase().includes(q)
				return titleMatch || previewMatch
			})
		}

		if (filtered.length === 0) {
			listEl.innerHTML = `<div class="chat-sidebar-empty">${
				chatSearchFilter.trim() ? "Nie znaleziono pasujących rozmów" : "Nie masz jeszcze żadnych rozmów"
			}</div>`
			return
		}

		// Grouping: Today, Yesterday, Previous
		const now = new Date()
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
		const startOfYesterday = startOfToday - 86400000

		const todayList = []
		const yesterdayList = []
		const previousList = []

		for (const session of filtered) {
			const ts = session.updatedAt || session.createdAt || 0
			if (ts >= startOfToday) {
				todayList.push(session)
			} else if (ts >= startOfYesterday) {
				yesterdayList.push(session)
			} else {
				previousList.push(session)
			}
		}

		function renderSessionGroup(heading, sessions) {
			if (sessions.length === 0) return ""
			let groupHtml = `<div class="chat-group-heading">${escapeHtml(heading)}</div>`
			for (const s of sessions) {
				const isActive = s.id === activeChatSessionId
				const preview = s.lastMessagePreview ? escapeHtml(s.lastMessagePreview) : "Brak wiadomości"
				const title = escapeHtml(s.title || "Rozmowa bez tytułu")
				groupHtml += `
					<div class="chat-session-item ${isActive ? "active" : ""}" data-session-id="${s.id}">
						<div class="chat-session-info">
							<span class="chat-session-title">${title}</span>
							<span class="chat-session-preview">${preview}</span>
						</div>
						<div class="chat-session-actions">
							<button class="chat-session-action-btn btn-rename" title="Zmień nazwę" data-session-id="${s.id}">
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
								</svg>
							</button>
							<button class="chat-session-action-btn btn-delete" title="Usuń" data-session-id="${s.id}">
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="3 6 5 6 21 6"></polyline>
									<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
								</svg>
							</button>
						</div>
					</div>
				`
			}
			return groupHtml
		}

		let html = ""
		html += renderSessionGroup("Dzisiaj", todayList)
		html += renderSessionGroup("Wczoraj", yesterdayList)
		html += renderSessionGroup("Wcześniej", previousList)
		listEl.innerHTML = html

		// Bind item click
		listEl.querySelectorAll(".chat-session-item").forEach((item) => {
			item.addEventListener("click", (e) => {
				if (e.target.closest(".chat-session-actions")) return
				const sessionId = item.getAttribute("data-session-id")
				selectChatSession(sessionId)
			})
		})

		// Bind rename
		listEl.querySelectorAll(".btn-rename").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation()
				const sessionId = btn.getAttribute("data-session-id")
				renameChatSession(sessionId)
			})
		})

		// Bind delete
		listEl.querySelectorAll(".btn-delete").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation()
				const sessionId = btn.getAttribute("data-session-id")
				deleteChatSession(sessionId)
			})
		})
	}

	async function selectChatSession(sessionId) {
		if (!await productWorkspace.guardEditor()) return
		activeChatSessionId = sessionId
		renderChatSidebar()
		forwardToWebview({
			type: "chatGetSession",
			chatSessionId: sessionId,
		})
	}

	async function createNewChatSession() {
		if (!await productWorkspace.guardEditor()) return
		try {
			const res = await fetch("/api/chat-sessions/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: "Nowa rozmowa" }),
			})
			if (res.ok) {
				const data = await res.json()
				if (data.session) {
					activeChatSessionId = data.session.id
					await fetchChatSessions()
					selectChatSession(data.session.id)
				}
			}
		} catch (err) {
			console.error("[ChatSidebar] Failed to create chat session:", err)
		}
	}

	function renameChatSession(sessionId) {
		const session = chatSessionsList.find((s) => s.id === sessionId)
		const currentTitle = session ? session.title : ""
		productWorkspace.renameConversation(currentTitle, async newTitle => {
			const response = await fetch("/api/chat-sessions/rename", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: sessionId, title: newTitle }),
			})
			if (!response.ok) throw new Error("Nie udało się zmienić nazwy rozmowy.")
			await fetchChatSessions()
		})
	}

	function deleteChatSession(sessionId) {
		const session = chatSessionsList.find((s) => s.id === sessionId)
		const title = session ? session.title : "tę rozmowę"
		showConfirmationModal({
			title: "Usuń rozmowę",
			subtitle: "Tej operacji nie można cofnąć.",
			message: `Czy na pewno chcesz trwale usunąć rozmowę „${title}”?`,
			icon: "🗑️",
			confirmText: "Usuń",
			confirmClass: "btn-danger",
			onConfirm: async () => {
				try {
					await fetch("/api/chat-sessions/delete", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: sessionId }),
					})
					if (activeChatSessionId === sessionId) {
						activeChatSessionId = null
					}
					await fetchChatSessions()
				} catch (err) {
					console.error("[ChatSidebar] Failed to delete session:", err)
				}
			},
		})
	}

	// Setup New Chat button & search bar events
	const newChatBtn = document.getElementById("btn-new-chat")
	if (newChatBtn) {
		newChatBtn.addEventListener("click", () => {
			createNewChatSession()
		})
	}

	const chatSearchInput = document.getElementById("chat-search-input")
	const chatSearchClearBtn = document.getElementById("chat-search-clear-btn")
	if (chatSearchInput) {
		chatSearchInput.addEventListener("input", (e) => {
			chatSearchFilter = e.target.value || ""
			if (chatSearchClearBtn) {
				chatSearchClearBtn.classList.toggle("hidden", !chatSearchFilter)
			}
			renderChatSidebar()
		})
	}
	if (chatSearchClearBtn) {
		chatSearchClearBtn.addEventListener("click", () => {
			if (chatSearchInput) chatSearchInput.value = ""
			chatSearchFilter = ""
			chatSearchClearBtn.classList.add("hidden")
			renderChatSidebar()
		})
	}

	function closeSidebarContextMenu() {
		if (!sidebarContextMenuEl) return
		sidebarContextMenuEl.classList.add("hidden")
		sidebarContextMenuEl.setAttribute("aria-hidden", "true")
		sidebarContextMenuEl.innerHTML = ""
		if (activeContextMenuTrigger) {
			activeContextMenuTrigger.closest(".sidebar-chat-item, .sidebar-project-item")?.classList.remove("menu-open")
			activeContextMenuTrigger = null
		}
	}

	function openSidebarContextMenu({ x, y, items, triggerEl }) {
		if (!sidebarContextMenuEl) return
		closeSidebarContextMenu()
		activeContextMenuTrigger = triggerEl || null
		if (triggerEl) {
			triggerEl.closest(".sidebar-chat-item, .sidebar-project-item")?.classList.add("menu-open")
		}

		let itemsHtml = ""
		items.forEach((item, idx) => {
			if (item.type === "divider") {
				itemsHtml += `<div class="context-menu-divider" role="separator"></div>`
			} else {
				const titleAttr = item.description ? `title="${escapeHtml(item.description)}"` : ""
				const contentHtml = item.description
					? `<div class="menu-item-text"><span class="menu-item-title">${escapeHtml(item.label)}</span><span class="menu-item-desc">${escapeHtml(item.description)}</span></div>`
					: `<span>${escapeHtml(item.label)}</span>`
				itemsHtml += `
					<button class="context-menu-item ${item.danger ? "danger" : ""}" 
					        type="button" 
					        role="menuitem" 
					        tabindex="${idx === 0 ? "0" : "-1"}" 
					        data-index="${idx}"
					        ${titleAttr}
					        aria-label="${escapeHtml(item.label)}">
						${item.icon ? `<span class="menu-icon">${item.icon}</span>` : ""}
						${contentHtml}
					</button>
				`
			}
		})

		sidebarContextMenuEl.innerHTML = itemsHtml
		sidebarContextMenuEl.classList.remove("hidden")
		sidebarContextMenuEl.setAttribute("aria-hidden", "false")

		// Viewport bounds detection
		const menuWidth = Math.max(200, sidebarContextMenuEl.offsetWidth || 200)
		const menuHeight = sidebarContextMenuEl.offsetHeight || 130
		const winW = window.innerWidth
		const winH = window.innerHeight

		let left = x
		let top = y
		if (left + menuWidth > winW - 10) {
			left = Math.max(10, winW - menuWidth - 10)
		}
		if (top + menuHeight > winH - 10) {
			top = Math.max(10, winH - menuHeight - 10)
		}

		sidebarContextMenuEl.style.left = `${left}px`
		sidebarContextMenuEl.style.top = `${top}px`

		const menuButtons = sidebarContextMenuEl.querySelectorAll(".context-menu-item")
		menuButtons.forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation()
				const idx = parseInt(btn.getAttribute("data-index") || "0", 10)
				const item = items[idx]
				closeSidebarContextMenu()
				if (item && typeof item.action === "function") {
					item.action()
				}
			})
		})

		const focusItem = (index) => {
			const btns = Array.from(menuButtons)
			if (btns.length === 0) return
			const validIndex = (index + btns.length) % btns.length
			btns.forEach((b, i) => b.setAttribute("tabindex", i === validIndex ? "0" : "-1"))
			btns[validIndex]?.focus()
		}

		sidebarContextMenuEl.onkeydown = (e) => {
			const btns = Array.from(menuButtons)
			const activeIdx = btns.indexOf(document.activeElement)
			if (e.key === "ArrowDown") {
				e.preventDefault()
				focusItem(activeIdx >= 0 ? activeIdx + 1 : 0)
			} else if (e.key === "ArrowUp") {
				e.preventDefault()
				focusItem(activeIdx >= 0 ? activeIdx - 1 : btns.length - 1)
			} else if (e.key === "Escape") {
				e.preventDefault()
				closeSidebarContextMenu()
				activeContextMenuTrigger?.focus()
			}
		}

		setTimeout(() => {
			menuButtons[0]?.focus()
		}, 20)
	}

	function openChatContextMenu(eventOrX, yOrTaskId, taskIdOrWs, wsOrTrigger, triggerEl) {
		let x, y, taskId, ws, trigger
		if (eventOrX && typeof eventOrX === "object" && ("clientX" in eventOrX || "target" in eventOrX)) {
			const e = eventOrX
			taskId = yOrTaskId
			ws = taskIdOrWs
			trigger = wsOrTrigger || e.currentTarget || e.target
			if (e.clientX !== undefined && e.clientY !== undefined && e.clientX > 0 && e.clientY > 0) {
				x = e.clientX
				y = e.clientY
			} else if (trigger?.getBoundingClientRect) {
				const rect = trigger.getBoundingClientRect()
				x = rect.left
				y = rect.bottom + 4
			} else {
				x = 100
				y = 100
			}
		} else {
			x = eventOrX
			y = yOrTaskId
			taskId = taskIdOrWs
			ws = wsOrTrigger
			trigger = triggerEl
		}

		const items = [
			{
				label: tDesktop("deleteChat"),
				danger: true,
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
				action: () => handleDeleteChat(taskId, ws),
			},
		]
		openSidebarContextMenu({ x, y, items, triggerEl: trigger })
	}

	function getProjectCustomName(ws) {
		const match = Object.entries(sidebarData.projectNames || {}).find(([p]) => pathNormalize(p) === pathNormalize(ws))
		return match?.[1] || ""
	}

	function getProjectDisplayName(ws) {
		return getProjectCustomName(ws) || ws.split(/[/\\]/).filter(Boolean).pop() || ws
	}

	let projectRenameDialog = null
	let pendingProjectRename = null
	function closeProjectRenameDialog() {
		projectRenameDialog?.remove()
		projectRenameDialog = null
		pendingProjectRename = null
	}

	function handleRenameProject(ws) {
		closeProjectRenameDialog()
		const previousFocus = document.activeElement
		const backdrop = document.createElement("div")
		backdrop.className = "modal-backdrop"
		backdrop.innerHTML = `<form class="modal-card project-rename-card" role="dialog" aria-modal="true" aria-labelledby="project-rename-title">
			<div class="modal-header"><h3 class="modal-title" id="project-rename-title"></h3></div>
			<div class="modal-body"><label for="project-rename-input"></label><input id="project-rename-input" type="text" maxlength="80" autocomplete="off" />
				<p class="project-rename-error" role="alert" hidden></p></div>
			<div class="modal-footer"><span></span><div class="modal-footer-right"><button type="button" class="btn btn-secondary" data-action="cancel"></button>
				<button type="submit" class="btn btn-primary" data-action="save"></button></div></div></form>`
		const form = backdrop.querySelector("form")
		const input = backdrop.querySelector("input")
		const error = backdrop.querySelector(".project-rename-error")
		const save = backdrop.querySelector('[data-action="save"]')
		backdrop.querySelector("#project-rename-title").textContent = tDesktop("renameProject")
		backdrop.querySelector("label").textContent = tDesktop("projectNamePrompt")
		backdrop.querySelector('[data-action="cancel"]').textContent = tDesktop("cancelProjectName")
		save.textContent = tDesktop("saveProjectName")
		input.value = getProjectDisplayName(ws)
		const close = () => { closeProjectRenameDialog(); previousFocus?.focus?.() }
		backdrop.querySelector('[data-action="cancel"]').addEventListener("click", close)
		backdrop.addEventListener("click", (event) => { if (event.target === backdrop && !pendingProjectRename) close() })
		backdrop.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !pendingProjectRename) { event.preventDefault(); close() }
			if (event.key === "Tab") {
				const focusable = [input, backdrop.querySelector('[data-action="cancel"]'), save]
				const index = focusable.indexOf(document.activeElement)
				if (event.shiftKey && index === 0) { event.preventDefault(); save.focus() }
				else if (!event.shiftKey && index === 2) { event.preventDefault(); input.focus() }
			}
		})
		form.addEventListener("submit", (event) => {
			event.preventDefault()
			if (pendingProjectRename) return
			const name = input.value.trim()
			if (!name || name.length > 80 || /[\r\n]/.test(name)) {
				error.textContent = tDesktop("projectNameInvalid")
				error.hidden = false
				return
			}
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				error.textContent = tDesktop("projectNameConnectionError")
				error.hidden = false
				return
			}
			error.hidden = true
			save.disabled = true
			pendingProjectRename = ws
			sendToServer({ type: "renameProject", path: ws, name })
		})
		projectRenameDialog = backdrop
		document.body.appendChild(backdrop)
		input.focus()
		input.select()
	}

	function openProjectContextMenu(eventOrX, yOrWs, wsOrTrigger, triggerEl) {
		let x, y, ws, trigger
		if (eventOrX && typeof eventOrX === "object" && ("clientX" in eventOrX || "target" in eventOrX)) {
			const e = eventOrX
			ws = yOrWs
			trigger = wsOrTrigger || e.currentTarget || e.target
			if (e.clientX !== undefined && e.clientY !== undefined && e.clientX > 0 && e.clientY > 0) {
				x = e.clientX
				y = e.clientY
			} else if (trigger?.getBoundingClientRect) {
				const rect = trigger.getBoundingClientRect()
				x = rect.left
				y = rect.bottom + 4
			} else {
				x = 100
				y = 100
			}
		} else {
			x = eventOrX
			y = yOrWs
			ws = wsOrTrigger
			trigger = triggerEl
		}

		const items = [
			{ label: tDesktop("relocateProject"), action: () => productWorkspace.projects(ws, true) },
			{
				label: tDesktop("renameProject"),
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16 4a2 2 0 0 1 3 3L8 18l-4 1 1-4z"/></svg>`,
				action: () => handleRenameProject(ws),
			},
			...(getProjectCustomName(ws) ? [{ label: tDesktop("resetProjectName"), action: () => sendToServer({ type: "renameProject", path: ws, name: null }) }] : []),
			{
				label: tDesktop("newChatInProject"),
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
				action: () => startNewChat(ws),
			},
			{
				label: tDesktop("openProjectFolder"),
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
				action: () => handleOpenProjectFolder(ws),
			},
			{
				label: tDesktop("copyProjectPath"),
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
				action: () => handleCopyProjectPath(ws),
			},
			{ type: "divider" },
			{
				label: tDesktop("removeProject"),
				danger: true,
				icon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
				action: () => handleRemoveProject(ws),
			},
		]
		openSidebarContextMenu({ x, y, items, triggerEl: trigger })
	}

	function handleDeleteChat(taskId, ws) {
		const chatList = sidebarData.chats[ws] || []
		const chat = chatList.find((c) => c.id === taskId)
		const isRunning = chat?.status === "running"
		const displayTitle = formatChatTitle(chat?.title || taskId)

		if (isRunning) {
			showConfirmationModal({
				title: tDesktop("deleteChatTitle"),
				subtitle: displayTitle,
				icon: "⚠️",
				message: tDesktop("deleteChatConfirmRunning"),
				confirmText: tDesktop("stopTaskAndDelete"),
				confirmClass: "btn-danger",
				onConfirm: () => {
					executeDeleteChat(taskId, ws, true)
				},
			})
		} else {
			showConfirmationModal({
				title: tDesktop("deleteChatTitle"),
				subtitle: displayTitle,
				icon: "🗑️",
				message: tDesktop("deleteChatConfirmIdle"),
				confirmText: tDesktop("confirmDelete"),
				confirmClass: "btn-danger",
				onConfirm: () => {
					executeDeleteChat(taskId, ws, false)
				},
			})
		}
	}

	function executeDeleteChat(taskId, ws, forceStop) {
		if (sidebarData.chats[ws]) {
			sidebarData.chats[ws] = sidebarData.chats[ws].filter((c) => c.id !== taskId)
		}

		if (activeTaskId === taskId) {
			const remaining = sidebarData.chats[ws] || []
			if (remaining.length > 0) {
				switchChat(remaining[0].id, ws)
			} else {
				startNewChat(ws)
			}
		}

		renderSidebar()

		sendToServer({
			type: "deleteChat",
			taskId,
			forceStop,
		})
	}

	async function handleRemoveProject(ws) {
		const wsNorm = pathNormalize(ws)
		const isCurrentActive =
			pathNormalize(sidebarData.currentWorkspace || "") === wsNorm ||
			pathNormalize(currentWorkspace?.path || "") === wsNorm
		if (isCurrentActive && productWorkspace?.guardEditor && !(await productWorkspace.guardEditor())) return

		let chats = []
		for (const [chatWs, chatList] of Object.entries(sidebarData.chats)) {
			if (pathNormalize(chatWs) === wsNorm) {
				chats = chatList
				break
			}
		}
		const runningCount = chats.filter((c) => c.status === "running").length
		const wsName = getProjectDisplayName(ws)

		if (runningCount > 0) {
			showConfirmationModal({
				title: tDesktop("removeProjectTitle"),
				subtitle: wsName,
				icon: "⚠️",
				message: tDesktop("removeProjectConfirmRunning", wsName, runningCount),
				confirmText: tDesktop("stopTasksAndRemove"),
				confirmClass: "btn-danger",
				onConfirm: () => {
					executeRemoveProject(ws, true)
				},
			})
		} else {
			showConfirmationModal({
				title: tDesktop("removeProjectTitle"),
				subtitle: wsName,
				icon: "📁",
				message: tDesktop("removeProjectConfirmIdle", wsName),
				confirmText: tDesktop("confirmRemoveProject"),
				confirmClass: "btn-danger",
				onConfirm: () => {
					executeRemoveProject(ws, false)
				},
			})
		}
	}

	function executeRemoveProject(ws, forceStop) {
		const wsNorm = pathNormalize(ws)
		sidebarData.recentWorkspaces = sidebarData.recentWorkspaces.filter(
			(p) => pathNormalize(p) !== wsNorm
		)
		for (const chatWs of Object.keys(sidebarData.chats)) {
			if (pathNormalize(chatWs) === wsNorm) {
				delete sidebarData.chats[chatWs]
			}
		}

		try {
			const saved = JSON.parse(localStorage.getItem("roo-desktop-workspaces-order") || "[]")
			if (Array.isArray(saved)) {
				const filtered = saved.filter((p) => pathNormalize(p) !== wsNorm)
				localStorage.setItem("roo-desktop-workspaces-order", JSON.stringify(filtered))
			}
		} catch {}

		const isCurrentActive =
			pathNormalize(sidebarData.currentWorkspace || "") === wsNorm ||
			pathNormalize(currentWorkspace?.path || "") === wsNorm

		if (isCurrentActive) {
			if (sidebarData.recentWorkspaces.length > 0) {
				selectWorkspaceFolder(sidebarData.recentWorkspaces[0])
			} else {
				sidebarData.currentWorkspace = ""
				currentWorkspace = null
				renderWorkspaceInfo({ path: "", name: "", files: [], directories: [] })
			}
		}

		renderSidebar()

		sendToServer({
			type: "removeProject",
			path: ws,
			forceStop,
		})
	}

	function handleOpenProjectFolder(ws) {
		if (desktopBridge?.shell?.openPath) {
			desktopBridge.shell.openPath(ws)
		} else if (window.__desktopAPI?.openPath) {
			window.__desktopAPI.openPath(ws)
		}
		sendToServer({ type: "openProjectFolder", path: ws })
	}

	function handleCopyProjectPath(ws) {
		if (desktopBridge?.clipboard?.writeText) {
			desktopBridge.clipboard.writeText(ws).catch(() => {})
		} else if (navigator.clipboard?.writeText) {
			navigator.clipboard.writeText(ws).catch(() => {})
		}
	}

	function removeRecentWorkspace(wsPath) {
		handleRemoveProject(wsPath)
	}

	function renderChatsList(ws, chats, isExpanded, activeTaskId) {
		if (!isExpanded) {
			return ""
		}

		if (!chats || chats.length === 0) {
			return `
				<div class="sidebar-no-chats">
					<span>${escapeHtml(tDesktop("noConversations"))}</span>
					<button class="btn-start-chat" data-action="new-chat-in-ws" data-workspace="${escapeHtml(ws)}">+ ${escapeHtml(tDesktop("newChat"))}</button>
				</div>
			`
		}

		const isChatExpanded = projectChatExpansions.has(ws)

		let visibleChats = chats
		let isTruncated = false
		let hiddenChats = []

		if (chats.length > MAX_VISIBLE_CHATS) {
			if (!isChatExpanded) {
				isTruncated = true
				visibleChats = chats.slice(0, MAX_VISIBLE_CHATS)
				// Ensure active chat outside top 6 is not occluded
				if (activeTaskId) {
					const activeIdx = chats.findIndex((c) => c.id === activeTaskId)
					if (activeIdx >= MAX_VISIBLE_CHATS && !visibleChats.some((c) => c.id === activeTaskId)) {
						visibleChats = [...visibleChats, chats[activeIdx]]
					}
				}
				hiddenChats = chats.filter((c) => !visibleChats.some((v) => v.id === c.id))
			}
		}

		let html = ""
		visibleChats.forEach((chat) => {
			const isChatActive = activeTaskId === chat.id
			let statusSlotHtml = ""
			let statusAria = tDesktop("chatStatusCompleted")

			if (chat.status === "running") {
				statusSlotHtml = `<span class="chat-spinner" role="status" aria-label="${escapeHtml(tDesktop("chatStatusRunning"))}"></span>`
				statusAria = tDesktop("chatStatusRunning")
			} else if (chat.status === "needs_attention") {
				statusSlotHtml = `<span class="chat-status-badge needs-attention" role="status" aria-label="${escapeHtml(tDesktop("chatStatusNeedsAttention"))}">!</span>`
				statusAria = tDesktop("chatStatusNeedsAttention")
			} else if (chat.hasUnread) {
				statusSlotHtml = `<span class="chat-unread-dot" role="status" aria-label="${escapeHtml(tDesktop("chatStatusCompletedUnread"))}"></span>`
				statusAria = tDesktop("chatStatusCompletedUnread")
			}

			const chatDisplayTitle = formatChatTitle(chat.title || chat.id)
			const itemAriaLabel = `${chatDisplayTitle} - ${statusAria}`
			html += `
				<div class="sidebar-chat-item ${isChatActive ? "active" : ""}" 
				     data-task-id="${escapeHtml(chat.id)}" 
				     data-workspace="${escapeHtml(ws)}"
				     role="button"
				     tabindex="0"
				     aria-label="${escapeHtml(itemAriaLabel)}">
					<svg class="chat-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
					</svg>
					<div class="chat-meta">
						<div class="chat-title-row">
							<span class="chat-title" title="${escapeHtml(chatDisplayTitle)}">${escapeHtml(chatDisplayTitle)}</span>
							<span class="chat-status-slot" title="${escapeHtml(statusAria)}">${statusSlotHtml}</span>
						</div>
						<span class="chat-time">${escapeHtml(formatTimeAgo(chat.ts))}</span>
					</div>
					<div class="chat-actions">
						<button class="chat-action-btn chat-menu-btn" 
						        type="button" 
						        data-action="chat-menu" 
						        data-task-id="${escapeHtml(chat.id)}" 
						        data-workspace="${escapeHtml(ws)}" 
						        title="${escapeHtml(tDesktop("chatMenu"))}" 
						        aria-label="${escapeHtml(tDesktop("chatMenu"))}">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="5" cy="12" r="2"/>
								<circle cx="12" cy="12" r="2"/>
								<circle cx="19" cy="12" r="2"/>
							</svg>
						</button>
					</div>
				</div>
			`
		})

		if (isTruncated && hiddenChats.length > 0) {
			const hiddenRunning = hiddenChats.filter((c) => c.status === "running").length
			const hiddenAttention = hiddenChats.filter((c) => c.status === "needs_attention").length
			const hiddenUnread = hiddenChats.filter((c) => c.hasUnread).length

			let indicatorsHtml = ""
			if (hiddenRunning > 0) {
				indicatorsHtml += `<span class="chat-spinner" role="status" title="${hiddenRunning} active"></span>`
			}
			if (hiddenAttention > 0) {
				indicatorsHtml += `<span class="chat-status-badge needs-attention" role="status" title="${hiddenAttention} needs attention">!</span>`
			}
			if (hiddenUnread > 0) {
				indicatorsHtml += `<span class="chat-unread-dot" role="status" title="${hiddenUnread} unread"></span>`
			}

			html += `
				<button class="sidebar-chat-toggle-btn" 
				        data-action="toggle-chat-list" 
				        data-workspace="${escapeHtml(ws)}" 
				        role="button" 
				        tabindex="0" 
				        aria-expanded="false" 
				        title="${escapeHtml(tDesktop("viewMoreChats", hiddenChats.length))}">
					<svg class="chat-toggle-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<polyline points="6 9 12 15 18 9"></polyline>
					</svg>
					<span>${escapeHtml(tDesktop("viewMoreChats", hiddenChats.length))}</span>
					${indicatorsHtml ? `<div class="chat-toggle-indicators">${indicatorsHtml}</div>` : ""}
				</button>
			`
		} else if (chats.length > MAX_VISIBLE_CHATS && isChatExpanded) {
			html += `
				<button class="sidebar-chat-toggle-btn" 
				        data-action="toggle-chat-list" 
				        data-workspace="${escapeHtml(ws)}" 
				        role="button" 
				        tabindex="0" 
				        aria-expanded="true" 
				        title="${escapeHtml(tDesktop("viewLessChats"))}">
					<svg class="chat-toggle-chevron expanded" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<polyline points="18 15 12 9 6 15"></polyline>
					</svg>
					<span>${escapeHtml(tDesktop("viewLessChats"))}</span>
				</button>
			`
		}

		return html
	}

	function tryPatchSidebarInPlace(workspaces, curWsNorm) {
		if (!sidebarProjectsListEl) return false
		const projectEls = Array.from(sidebarProjectsListEl.children).filter((el) => el.classList.contains("sidebar-project-item"))
		if (projectEls.length !== workspaces.length) return false

		// Phase 1: Verify exact structural match (workspaces, expanded states, visible chats order)
		const patchPlan = []
		for (let i = 0; i < workspaces.length; i++) {
			const ws = workspaces[i]
			const pEl = projectEls[i]
			if (pathNormalize(pEl.getAttribute("data-workspace") || "") !== pathNormalize(ws)) return false

			const isExpanded = projectExpansions.has(ws)
			const chatsListEl = pEl.querySelector(".project-chats-list")
			if (!chatsListEl) return false
			const hasExpandedClass = chatsListEl.classList.contains("expanded")
			if (isExpanded !== hasExpandedClass) return false

			let chats = []
			const wsNorm = pathNormalize(ws)
			for (const [chatWs, chatList] of Object.entries(sidebarData.chats)) {
				if (pathNormalize(chatWs) === wsNorm) {
					chats = chatList
					break
				}
			}

			if (!isExpanded) {
				if (chatsListEl.children.length > 0) return false
				patchPlan.push({ ws, pEl, isExpanded, wsNorm, visibleChats: [] })
				continue
			}

			if (chats.length === 0) {
				if (!chatsListEl.querySelector(".sidebar-no-chats")) return false
				patchPlan.push({ ws, pEl, isExpanded, wsNorm, visibleChats: [] })
				continue
			}

			const isChatExpanded = projectChatExpansions.has(ws)
			let visibleChats = chats
			let isTruncated = false
			let hiddenChats = []

			if (chats.length > MAX_VISIBLE_CHATS) {
				if (!isChatExpanded) {
					isTruncated = true
					visibleChats = chats.slice(0, MAX_VISIBLE_CHATS)
					if (activeTaskId) {
						const activeIdx = chats.findIndex((c) => c.id === activeTaskId)
						if (activeIdx >= MAX_VISIBLE_CHATS && !visibleChats.some((c) => c.id === activeTaskId)) {
							visibleChats = [...visibleChats, chats[activeIdx]]
						}
					}
					hiddenChats = chats.filter((c) => !visibleChats.some((v) => v.id === c.id))
				}
			}

			const chatEls = Array.from(chatsListEl.children).filter((el) => el.classList.contains("sidebar-chat-item"))
			if (chatEls.length !== visibleChats.length) return false

			for (let j = 0; j < visibleChats.length; j++) {
				if (chatEls[j].getAttribute("data-task-id") !== visibleChats[j].id) {
					return false
				}
			}

			const toggleBtn = chatsListEl.querySelector(".sidebar-chat-toggle-btn")
			const needsToggle = chats.length > MAX_VISIBLE_CHATS
			if (needsToggle && !toggleBtn) return false
			if (!needsToggle && toggleBtn) return false
			if (toggleBtn) {
				const isBtnExpanded = toggleBtn.getAttribute("aria-expanded") === "true"
				if (isBtnExpanded !== isChatExpanded) return false
			}

			patchPlan.push({ ws, pEl, isExpanded, wsNorm, visibleChats, chatEls, isTruncated, hiddenChats, toggleBtn })
		}

		// Phase 2: Structural match verified! Apply surgical in-place DOM updates
		for (const item of patchPlan) {
			const { ws, pEl, isExpanded, wsNorm, visibleChats, chatEls, isTruncated, hiddenChats, toggleBtn } = item
			const isActive = wsNorm === curWsNorm
			pEl.classList.toggle("active", isActive)
			const projectNameEl = pEl.querySelector(".project-name")
			const projectName = getProjectDisplayName(ws)
			if (projectNameEl && projectNameEl.textContent !== projectName) {
				projectNameEl.textContent = projectName
				projectNameEl.title = projectName
			}

			// Update header active status dot
			const headerEl = pEl.querySelector(".project-header")
			if (headerEl) {
				let dot = headerEl.querySelector(".project-status-dot")
				if (isActive && !dot) {
					const iconBox = headerEl.querySelector(".project-icon-box")
					dot = document.createElement("span")
					dot.className = "project-status-dot"
					dot.title = tDesktop("activeProject")
					if (iconBox && iconBox.nextSibling) {
						headerEl.insertBefore(dot, iconBox.nextSibling)
					} else {
						headerEl.appendChild(dot)
					}
				} else if (!isActive && dot) {
					dot.remove()
				}
			}

			if (!isExpanded || !chatEls) continue

			for (let j = 0; j < visibleChats.length; j++) {
				const chat = visibleChats[j]
				const chatEl = chatEls[j]
				const isChatActive = activeTaskId === chat.id

				chatEl.classList.toggle("active", isChatActive)

				let statusSlotHtml = ""
				let statusAria = tDesktop("chatStatusCompleted")

				if (chat.status === "running") {
					statusSlotHtml = `<span class="chat-spinner" role="status" aria-label="${escapeHtml(tDesktop("chatStatusRunning"))}"></span>`
					statusAria = tDesktop("chatStatusRunning")
				} else if (chat.status === "needs_attention") {
					statusSlotHtml = `<span class="chat-status-badge needs-attention" role="status" aria-label="${escapeHtml(tDesktop("chatStatusNeedsAttention"))}">!</span>`
					statusAria = tDesktop("chatStatusNeedsAttention")
				} else if (chat.hasUnread) {
					statusSlotHtml = `<span class="chat-unread-dot" role="status" aria-label="${escapeHtml(tDesktop("chatStatusCompletedUnread"))}"></span>`
					statusAria = tDesktop("chatStatusCompletedUnread")
				}

				const chatDisplayTitle = formatChatTitle(chat.title || chat.id)
				const itemAriaLabel = `${chatDisplayTitle} - ${statusAria}`
				if (chatEl.getAttribute("aria-label") !== itemAriaLabel) {
					chatEl.setAttribute("aria-label", itemAriaLabel)
				}

				const titleEl = chatEl.querySelector(".chat-title")
				if (titleEl && titleEl.textContent !== chatDisplayTitle) {
					titleEl.textContent = chatDisplayTitle
					titleEl.title = chatDisplayTitle
				}

				const statusSlot = chatEl.querySelector(".chat-status-slot")
				if (statusSlot) {
					if (statusSlot.innerHTML !== statusSlotHtml) {
						statusSlot.innerHTML = statusSlotHtml
					}
					if (statusSlot.title !== statusAria) {
						statusSlot.title = statusAria
					}
				}

				const timeEl = chatEl.querySelector(".chat-time")
				const timeText = formatTimeAgo(chat.ts)
				if (timeEl && timeEl.textContent !== timeText) {
					timeEl.textContent = timeText
				}
			}

			// Update toggle button indicators if truncated
			if (toggleBtn && isTruncated && hiddenChats.length > 0) {
				const hiddenRunning = hiddenChats.filter((c) => c.status === "running").length
				const hiddenAttention = hiddenChats.filter((c) => c.status === "needs_attention").length
				const hiddenUnread = hiddenChats.filter((c) => c.hasUnread).length

				let indicatorsHtml = ""
				if (hiddenRunning > 0) {
					indicatorsHtml += `<span class="chat-spinner" role="status" title="${hiddenRunning} active"></span>`
				}
				if (hiddenAttention > 0) {
					indicatorsHtml += `<span class="chat-status-badge needs-attention" role="status" title="${hiddenAttention} needs attention">!</span>`
				}
				if (hiddenUnread > 0) {
					indicatorsHtml += `<span class="chat-unread-dot" role="status" title="${hiddenUnread} unread"></span>`
				}

				let indContainer = toggleBtn.querySelector(".chat-toggle-indicators")
				if (indicatorsHtml) {
					if (!indContainer) {
						indContainer = document.createElement("div")
						indContainer.className = "chat-toggle-indicators"
						toggleBtn.appendChild(indContainer)
					}
					if (indContainer.innerHTML !== indicatorsHtml) {
						indContainer.innerHTML = indicatorsHtml
					}
				} else if (indContainer) {
					indContainer.remove()
				}
			}
		}

		return true
	}

	let isDraggingProject = false
	let draggedProjectWs = null
	let dragOverProjectWs = null
	let dragDropPosition = null

	function cleanupDragState() {
		isDraggingProject = false
		draggedProjectWs = null
		dragOverProjectWs = null
		dragDropPosition = null
		if (sidebarProjectsListEl) {
			sidebarProjectsListEl.classList.remove("reorder-mode")
			sidebarProjectsListEl.querySelectorAll(".sidebar-project-item").forEach((el) => {
				el.classList.remove("is-dragging", "drop-before", "drop-after")
			})
		}
	}

	function getAuthoritativeWorkspacesList() {
		const curWsNorm = pathNormalize(sidebarData.currentWorkspace || currentWorkspace?.path || "")
		let workspaces = [...(sidebarData.recentWorkspaces || [])]

		// Ensure current workspace is present (append to end if new)
		if (sidebarData.currentWorkspace && !workspaces.some((w) => pathNormalize(w) === curWsNorm)) {
			workspaces.push(sidebarData.currentWorkspace)
		}

		// Also check if there are chats for workspaces not currently in recentWorkspaces
		for (const wsKey of Object.keys(sidebarData.chats || {})) {
			if (wsKey !== "__unassigned__" && !workspaces.some((w) => pathNormalize(w) === pathNormalize(wsKey))) {
				workspaces.push(wsKey)
			}
		}

		// Reconcile with manual order if saved in localStorage
		try {
			const savedOrderJson = localStorage.getItem("roo-desktop-workspaces-order")
			if (savedOrderJson) {
				const savedOrder = JSON.parse(savedOrderJson)
				if (Array.isArray(savedOrder) && savedOrder.length > 0) {
					const ordered = []
					for (const savedWs of savedOrder) {
						const found = workspaces.find((w) => pathNormalize(w) === pathNormalize(savedWs))
						if (found && !ordered.some((o) => pathNormalize(o) === pathNormalize(found))) {
							ordered.push(found)
						}
					}
					for (const ws of workspaces) {
						if (!ordered.some((o) => pathNormalize(o) === pathNormalize(ws))) {
							ordered.push(ws)
						}
					}
					workspaces = ordered
				}
			}
		} catch {}

		// Deduplicate
		const deduped = []
		for (const w of workspaces) {
			if (!deduped.some((existing) => pathNormalize(existing) === pathNormalize(w))) {
				deduped.push(w)
			}
		}
		return deduped
	}

	function applyWorkspaceReorder(fromWs, targetWs, pos) {
		if (!fromWs) return false
		const currentList = getAuthoritativeWorkspacesList()
		const fromIndex = currentList.findIndex((w) => pathNormalize(w) === pathNormalize(fromWs))
		if (fromIndex === -1) return false

		let targetSlot
		if (!targetWs) {
			// Dropped into bottom empty area -> move to end
			targetSlot = currentList.length
		} else {
			const targetIndex = currentList.findIndex((w) => pathNormalize(w) === pathNormalize(targetWs))
			if (targetIndex === -1) return false
			targetSlot = pos === "after" ? targetIndex + 1 : targetIndex
		}

		// Guard: No-op if targetSlot is the same position
		if (targetSlot === fromIndex || targetSlot === fromIndex + 1) {
			return false
		}

		// Perform remove + insert
		const [removed] = currentList.splice(fromIndex, 1)
		const finalIndex = fromIndex < targetSlot ? targetSlot - 1 : targetSlot
		currentList.splice(finalIndex, 0, removed)

		// Deduplicate
		const deduped = []
		for (const w of currentList) {
			if (!deduped.some((existing) => pathNormalize(existing) === pathNormalize(w))) {
				deduped.push(w)
			}
		}

		// Update sidebarData & localStorage
		sidebarData.recentWorkspaces = deduped
		try {
			localStorage.setItem("roo-desktop-workspaces-order", JSON.stringify(deduped))
		} catch {}

		// Send to server to persist to desktop-config.json
		sendToServer({ type: "reorderWorkspaces", workspaces: deduped })

		return true
	}

	function renderSidebar() {
		if (!sidebarProjectsListEl) return
		;(typeof queueMicrotask === "function" ? queueMicrotask : setTimeout)(applySidebarSearch)
		if (isDraggingProject) return

		const curWsNorm = pathNormalize(sidebarData.currentWorkspace || currentWorkspace?.path || "")
		const workspaces = getAuthoritativeWorkspacesList()

		if (sidebarProjectsCountEl) {
			sidebarProjectsCountEl.textContent = String(workspaces.length)
		}

		if (workspaces.length === 0) {
			sidebarProjectsListEl.innerHTML = `
				<div class="sidebar-empty-state">
					<p>${escapeHtml(tDesktop("noWorkspaceOpen"))}</p>
					<button class="btn-start-chat" id="sidebar-open-first-btn" style="margin-top:8px;">+ ${escapeHtml(tDesktop("openWorkspaceFolder"))}</button>
				</div>
			`
			document.getElementById("sidebar-open-first-btn")?.addEventListener("click", () => {
				openFolderDialog()
			})
			return
		}

		// Try surgical in-place DOM patching if workspace & chat structure has not changed
		if (tryPatchSidebarInPlace(workspaces, curWsNorm)) {
			return
		}

		let html = ""

		workspaces.forEach((ws) => {
			const wsNorm = pathNormalize(ws)
			const isActive = wsNorm === curWsNorm
			const wsName = getProjectDisplayName(ws)
			let chats = []

			// Find chats matching this workspace
			for (const [chatWs, chatList] of Object.entries(sidebarData.chats)) {
				if (pathNormalize(chatWs) === wsNorm) {
					chats = chatList
					break
				}
			}

			const isExpanded = projectExpansions.has(ws)

			const chatsHtml = renderChatsList(ws, chats, isExpanded, activeTaskId)

			html += `
				<div class="sidebar-project-item ${isActive ? "active" : ""}" data-workspace="${escapeHtml(ws)}">
					<div class="project-header" data-workspace="${escapeHtml(ws)}">
						<button class="project-drag-handle" data-action="drag-project" data-workspace="${escapeHtml(ws)}" draggable="true" title="Przeciągnij, aby zmienić kolejność" aria-label="Drag project to reorder" tabindex="0">
							<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
								<circle cx="3" cy="2.5" r="1.2"/>
								<circle cx="7" cy="2.5" r="1.2"/>
								<circle cx="3" cy="7" r="1.2"/>
								<circle cx="7" cy="7" r="1.2"/>
								<circle cx="3" cy="11.5" r="1.2"/>
								<circle cx="7" cy="11.5" r="1.2"/>
							</svg>
						</button>
						<button class="project-chevron-btn" data-action="toggle-project" data-workspace="${escapeHtml(ws)}" title="Toggle chats">
							<svg class="chevron-icon ${isExpanded ? "expanded" : ""}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
						<div class="project-icon-box" data-action="switch-workspace" data-workspace="${escapeHtml(ws)}">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
							</svg>
						</div>
						${isActive ? `<span class="project-status-dot" title="${escapeHtml(tDesktop("activeProject"))}"></span>` : ""}
						<div class="project-meta" data-action="switch-workspace" data-workspace="${escapeHtml(ws)}" title="${escapeHtml(ws)}">
							<span class="project-name" title="${escapeHtml(wsName)}">${escapeHtml(wsName)}</span>
							<span class="project-path" title="${escapeHtml(ws)}">${escapeHtml(ws)}</span>
						</div>
						<div class="project-actions">
							<button class="project-action-btn project-new-chat-btn" data-action="new-chat-in-ws" data-workspace="${escapeHtml(ws)}" title="${escapeHtml(tDesktop("newChatInProject"))}" aria-label="${escapeHtml(tDesktop("newChatInProject"))}">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<line x1="12" y1="5" x2="12" y2="19"/>
									<line x1="5" y1="12" x2="19" y2="12"/>
								</svg>
							</button>
							<button class="project-action-btn project-menu-btn" data-action="project-menu" data-workspace="${escapeHtml(ws)}" title="${escapeHtml(tDesktop("projectMenu"))}" aria-label="${escapeHtml(tDesktop("projectMenu"))}">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
									<circle cx="12" cy="5" r="2"/>
									<circle cx="12" cy="12" r="2"/>
									<circle cx="12" cy="19" r="2"/>
								</svg>
							</button>
						</div>
					</div>
					<div class="project-chats-list ${isExpanded ? "expanded" : ""}">
						${chatsHtml}
					</div>
				</div>
			`
		})

		sidebarProjectsListEl.innerHTML = html

		// Attach event delegations for dynamically generated items
		sidebarProjectsListEl.querySelectorAll(".sidebar-chat-item").forEach((el) => {
			const onActivate = async (e) => {
				if (e.target.closest("[data-action='chat-menu']")) return
				const taskId = el.getAttribute("data-task-id")
				const ws = el.getAttribute("data-workspace")
				if (taskId) switchChat(taskId, ws)
			}
			el.addEventListener("click", onActivate)
			el.addEventListener("contextmenu", (e) => {
				e.preventDefault()
				e.stopPropagation()
				const taskId = el.getAttribute("data-task-id")
				const ws = el.getAttribute("data-workspace")
				if (taskId && ws) {
					openChatContextMenu(e, taskId, ws, el)
				}
			})
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					if (e.target.closest("[data-action='chat-menu']")) return
					e.preventDefault()
					const taskId = el.getAttribute("data-task-id")
					const ws = el.getAttribute("data-workspace")
					if (taskId) switchChat(taskId, ws)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='chat-menu']").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.preventDefault()
				e.stopPropagation()
				const taskId = btn.getAttribute("data-task-id")
				const ws = btn.getAttribute("data-workspace")
				if (taskId && ws) {
					openChatContextMenu(e, taskId, ws, btn)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll(".project-header").forEach((headerEl) => {
			headerEl.addEventListener("contextmenu", (e) => {
				e.preventDefault()
				e.stopPropagation()
				const ws = headerEl.getAttribute("data-workspace")
				if (ws) {
					openProjectContextMenu(e, ws, headerEl)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='project-menu']").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.preventDefault()
				e.stopPropagation()
				const ws = btn.getAttribute("data-workspace")
				if (ws) {
					openProjectContextMenu(e, ws, btn)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='toggle-project']").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation()
				const ws = btn.getAttribute("data-workspace")
				if (ws) {
					if (projectExpansions.has(ws)) {
						projectExpansions.delete(ws)
					} else {
						projectExpansions.add(ws)
					}
					renderSidebar()
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='toggle-chat-list']").forEach((btn) => {
			const onToggle = (e) => {
				e.stopPropagation()
				const ws = btn.getAttribute("data-workspace")
				if (ws) {
					if (projectChatExpansions.has(ws)) {
						projectChatExpansions.delete(ws)
					} else {
						projectChatExpansions.add(ws)
					}
					renderSidebar()
				}
			}
			btn.addEventListener("click", onToggle)
			btn.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onToggle(e)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='switch-workspace']").forEach((el) => {
			el.addEventListener("click", async () => {
				const ws = el.getAttribute("data-workspace")
				if (ws && pathNormalize(ws) !== curWsNorm) {
					if (productWorkspace?.guardEditor && !(await productWorkspace.guardEditor())) return
					selectWorkspaceFolder(ws)
				}
			})
		})

		sidebarProjectsListEl.querySelectorAll("[data-action='new-chat-in-ws']").forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.preventDefault()
				e.stopPropagation()
				const ws = btn.getAttribute("data-workspace")
				if (ws) {
					if (productWorkspace?.guardEditor && !(await productWorkspace.guardEditor())) return
					startNewChat(ws)
				}
			})
		})

		// Wire project drag-and-drop reordering
		sidebarProjectsListEl.querySelectorAll(".project-drag-handle").forEach((handle) => {
			handle.addEventListener("mousedown", (e) => {
				e.stopPropagation()
			})
			handle.addEventListener("click", (e) => {
				e.stopPropagation()
				e.preventDefault()
			})
			handle.addEventListener("dragstart", (e) => {
				e.stopPropagation()
				const ws = handle.getAttribute("data-workspace")
				if (!ws) return

				isDraggingProject = true
				draggedProjectWs = ws
				e.dataTransfer.effectAllowed = "move"
				e.dataTransfer.setData("text/plain", ws)

				// Create elevated drag ghost
				const wsName = getProjectDisplayName(ws)
				const ghost = document.createElement("div")
				ghost.className = "project-drag-ghost"
				ghost.style.cssText = "position:absolute; top:-1000px; left:-1000px; padding:6px 12px; background:var(--bg-surface-elevated, #252526); color:var(--text-primary, #ffffff); border:1px solid var(--accent, #3b82f6); border-radius:6px; font-size:12px; font-weight:600; box-shadow:0 4px 12px rgba(0,0,0,0.4); pointer-events:none; z-index:9999; max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"
				ghost.textContent = wsName
				document.body.appendChild(ghost)
				e.dataTransfer.setDragImage(ghost, 20, 15)
				setTimeout(() => ghost.remove(), 0)

				const projectItem = handle.closest(".sidebar-project-item")
				if (projectItem) {
					projectItem.classList.add("is-dragging")
				}

				// Ephemeral visual mode: collapse/hide chats during reorder
				sidebarProjectsListEl.classList.add("reorder-mode")
			})
			handle.addEventListener("dragend", () => {
				cleanupDragState()
				requestAnimationFrame(() => {
					renderSidebar()
				})
			})
		})

		sidebarProjectsListEl.querySelectorAll(".sidebar-project-item").forEach((item) => {
			item.addEventListener("dragover", (e) => {
				if (!isDraggingProject || !draggedProjectWs) return
				const targetWs = item.getAttribute("data-workspace")
				if (!targetWs || pathNormalize(targetWs) === pathNormalize(draggedProjectWs)) {
					item.classList.remove("drop-before", "drop-after")
					return
				}
				e.preventDefault()
				e.stopPropagation()
				e.dataTransfer.dropEffect = "move"

				const headerEl = item.querySelector(".project-header") || item
				const rect = headerEl.getBoundingClientRect()
				const midY = rect.top + rect.height / 2
				const position = e.clientY < midY ? "before" : "after"

				// Check if this position is a no-op relative to the dragged item
				const currentList = getAuthoritativeWorkspacesList()
				const fromIdx = currentList.findIndex((w) => pathNormalize(w) === pathNormalize(draggedProjectWs))
				const targetIdx = currentList.findIndex((w) => pathNormalize(w) === pathNormalize(targetWs))
				const slot = position === "after" ? targetIdx + 1 : targetIdx

				if (slot === fromIdx || slot === fromIdx + 1) {
					// Same position as dragged item - no drop indicator
					item.classList.remove("drop-before", "drop-after")
					dragOverProjectWs = null
					dragDropPosition = null
					return
				}

				dragOverProjectWs = targetWs
				dragDropPosition = position

				// Clear indicators from all other items to ensure strict exclusivity
				sidebarProjectsListEl.querySelectorAll(".sidebar-project-item").forEach((other) => {
					if (other !== item) {
						other.classList.remove("drop-before", "drop-after")
					}
				})

				if (position === "before") {
					item.classList.add("drop-before")
					item.classList.remove("drop-after")
				} else {
					item.classList.add("drop-after")
					item.classList.remove("drop-before")
				}

				// Controlled auto-scroll on sidebar scroll container
				const scrollContainer = sidebarProjectsListEl.closest(".sidebar-scroll-content") || sidebarProjectsListEl
				if (scrollContainer) {
					const scrollRect = scrollContainer.getBoundingClientRect()
					if (e.clientY < scrollRect.top + 40) {
						scrollContainer.scrollTop -= 8
					} else if (e.clientY > scrollRect.bottom - 40) {
						scrollContainer.scrollTop += 8
					}
				}
			})

			item.addEventListener("dragleave", (e) => {
				if (!item.contains(e.relatedTarget)) {
					item.classList.remove("drop-before", "drop-after")
					const targetWs = item.getAttribute("data-workspace")
					if (dragOverProjectWs && targetWs && pathNormalize(dragOverProjectWs) === pathNormalize(targetWs)) {
						dragOverProjectWs = null
						dragDropPosition = null
					}
				}
			})

			item.addEventListener("drop", (e) => {
				if (!isDraggingProject || !draggedProjectWs) return
				e.preventDefault()
				e.stopPropagation()

				const targetWs = item.getAttribute("data-workspace")
				const fromWs = draggedProjectWs

				// Recalculate position dynamically from drop coordinates if available
				const headerEl = item.querySelector(".project-header") || item
				const rect = headerEl.getBoundingClientRect()
				const midY = rect.top + rect.height / 2
				const pos = e.clientY < midY ? "before" : "after"

				cleanupDragState()

				if (!targetWs || !fromWs || pathNormalize(fromWs) === pathNormalize(targetWs)) return

				applyWorkspaceReorder(fromWs, targetWs, pos)

				requestAnimationFrame(() => {
					renderSidebar()
				})
			})
		})

		// Container-level dragover / drop for empty area below projects
		if (!sidebarProjectsListEl._dragContainerBound) {
			sidebarProjectsListEl._dragContainerBound = true

			const onContainerDragOver = (e) => {
				if (!isDraggingProject || !draggedProjectWs) return
				if (e.target.closest(".sidebar-project-item")) {
					return
				}
				e.preventDefault()
				e.dataTransfer.dropEffect = "move"

				const projectItems = Array.from(sidebarProjectsListEl.querySelectorAll(".sidebar-project-item"))
				if (projectItems.length === 0) return

				const lastItem = projectItems[projectItems.length - 1]
				const lastWs = lastItem.getAttribute("data-workspace")
				if (!lastWs) return

				const currentList = getAuthoritativeWorkspacesList()
				const fromIdx = currentList.findIndex((w) => pathNormalize(w) === pathNormalize(draggedProjectWs))

				if (fromIdx === currentList.length - 1) {
					lastItem.classList.remove("drop-before", "drop-after")
					return
				}

				projectItems.forEach((it) => {
					if (it !== lastItem) it.classList.remove("drop-before", "drop-after")
				})
				lastItem.classList.add("drop-after")
				lastItem.classList.remove("drop-before")
				dragOverProjectWs = lastWs
				dragDropPosition = "after"
			}

			const onContainerDrop = (e) => {
				if (!isDraggingProject || !draggedProjectWs) return
				if (e.target.closest(".sidebar-project-item")) {
					return
				}
				e.preventDefault()
				e.stopPropagation()

				const fromWs = draggedProjectWs
				cleanupDragState()

				applyWorkspaceReorder(fromWs, null, "after")

				requestAnimationFrame(() => {
					renderSidebar()
				})
			}

			sidebarProjectsListEl.addEventListener("dragover", onContainerDragOver)
			sidebarProjectsListEl.addEventListener("drop", onContainerDrop)

			const scrollContainer = sidebarProjectsListEl.closest(".sidebar-scroll-content")
			if (scrollContainer && scrollContainer !== sidebarProjectsListEl) {
				scrollContainer.addEventListener("dragover", onContainerDragOver)
				scrollContainer.addEventListener("drop", onContainerDrop)
			}
		}
	}

	// Webview Loading & Cold Start Resilience with Healthcheck and Exponential Backoff Retry
	let webviewRetryCount = 0
	const MAX_WEBVIEW_RETRIES = 3
	const RETRY_DELAYS = [500, 1000, 2000]
	let webviewLoadTimeoutTimer = null

	function showWebviewLoading(statusText) {
		if (webviewLoadingState) {
			webviewLoadingState.style.display = "flex"
			if (webviewLoadingTitle) webviewLoadingTitle.textContent = tDesktop("loadingTitle")
			const desc = webviewLoadingDesc || webviewLoadingState.querySelector(".placeholder-desc")
			if (desc && statusText) {
				desc.textContent = statusText
				if (desc.dataset) desc.dataset.custom = "true"
			}
		}
		if (webviewErrorState) webviewErrorState.style.display = "none"
		if (webviewFrame) webviewFrame.style.display = "none"
	}

	function showWebviewError(message) {
		if (webviewLoadingState) webviewLoadingState.style.display = "none"
		if (webviewFrame) webviewFrame.style.display = "none"
		if (webviewErrorState) {
			webviewErrorState.style.display = "flex"
			if (webviewErrorTitle) webviewErrorTitle.textContent = tDesktop("errorTitle")
			if (webviewErrorDesc && message) {
				webviewErrorDesc.textContent = message
				if (webviewErrorDesc.dataset) webviewErrorDesc.dataset.custom = "true"
			}
			if (webviewRetryText) webviewRetryText.textContent = tDesktop("retryBtn")
		}
	}

	function showWebviewSuccess() {
		clearTimeout(webviewLoadTimeoutTimer)
		if (webviewLoadingState) webviewLoadingState.style.display = "none"
		if (webviewErrorState) webviewErrorState.style.display = "none"
		if (webviewFrame) {
			if (!webviewFrame.getAttribute("src") || webviewFrame.getAttribute("src") === "") {
				webviewFrame.src = "/webview/index.html"
			}
			webviewFrame.style.display = "block"
			const theme = localStorage.getItem("roo-theme") || "linear-dark"
			webviewFrame.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
			webviewFrame.contentWindow?.postMessage({ type: "languageChange", language: currentLanguage }, "*")
		}
	}

	async function checkServerHealth(maxAttempts = 3, delays = RETRY_DELAYS) {
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				const controller = new AbortController()
				const timeoutId = setTimeout(() => controller.abort(), 2000)
				const res = await fetch("/api/health", { signal: controller.signal, cache: "no-store" })
				clearTimeout(timeoutId)
				if (res.ok) {
					return true
				}
			} catch (err) {
				console.warn(`Healthcheck attempt ${attempt + 1}/${maxAttempts} failed:`, err)
			}
			if (attempt < maxAttempts - 1) {
				const delay = delays[attempt] || 1000
				showWebviewLoading(tDesktop("loadingServerHealth", attempt + 2, maxAttempts))
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}
		showWebviewError(tDesktop("loadingServerUnavailable"))
		return false
	}

	async function loadWebviewFrame() {
		if (!webviewFrame) return
		clearTimeout(webviewLoadTimeoutTimer)

		showWebviewLoading(tDesktop("loadingConnectingServer"))

		const isServerReady = await checkServerHealth(MAX_WEBVIEW_RETRIES, RETRY_DELAYS)
		if (!isServerReady) {
			showWebviewError(tDesktop("loadingServerUnavailable"))
			return
		}

		showWebviewLoading(tDesktop("loadingAgentView"))

		// Set up frame load timeout (8 seconds)
		webviewLoadTimeoutTimer = setTimeout(() => {
			console.warn("Webview iframe loading timed out.")
			handleWebviewLoadError(tDesktop("loadingTimeout"))
		}, 8000)

		// Set src to trigger load
		webviewFrame.src = "/webview/index.html"
	}

	function handleWebviewLoadError(reason) {
		clearTimeout(webviewLoadTimeoutTimer)
		if (webviewRetryCount < MAX_WEBVIEW_RETRIES) {
			const delay = RETRY_DELAYS[webviewRetryCount] || 1000
			webviewRetryCount++
			showWebviewLoading(tDesktop("loadingFrameError", reason, delay, webviewRetryCount, MAX_WEBVIEW_RETRIES))
			setTimeout(() => {
				loadWebviewFrame()
			}, delay)
		} else {
			showWebviewError(reason || tDesktop("loadingFrameFailed"))
		}
	}

	if (webviewFrame) {
		webviewFrame.addEventListener("load", () => {
			clearTimeout(webviewLoadTimeoutTimer)
			webviewRetryCount = 0
			showWebviewSuccess()
		})

		webviewFrame.addEventListener("error", () => {
			handleWebviewLoadError(tDesktop("loadingNetworkError"))
		})
	}

	webviewRetryBtn?.addEventListener("click", () => {
		webviewRetryCount = 0
		loadWebviewFrame()
	})

	// Initiate safe webview loading
	loadWebviewFrame()

	// Folder Selection
	openFolderBtn?.addEventListener("click", () => {
		openFolderDialog()
	})

	// Terminal Actions
	clearTerminalBtn?.addEventListener("click", () => {
		terminalSessions = []
		terminalLogs = []
		selectedTerminalSessionId = null
		renderTerminalSessions()
		renderActiveTerminalOutput()
		sendToServer({ type: "clearTerminalLogs" })
	})

	copyTerminalBtn?.addEventListener("click", () => {
		const activeSession = terminalSessions.find((s) => s.id === selectedTerminalSessionId)
		if (!activeSession || !activeSession.output) return
		const cleanText = stripAnsi(activeSession.output)
		navigator.clipboard.writeText(cleanText).then(() => {
			if (terminalCopyText) {
				const orig = terminalCopyText.textContent
				terminalCopyText.textContent = tDesktop("terminalCopied")
				setTimeout(() => {
					terminalCopyText.textContent = orig
				}, 1500)
			}
		})
	})

	// Files Search Filter
	let searchDebounceTimer = null
	filesSearchInput?.addEventListener("input", (e) => {
		clearTimeout(searchDebounceTimer)
		searchDebounceTimer = setTimeout(() => {
			const filter = e.target.value.toLowerCase()
			renderFilesTree(filter)
		}, 150)
	})

	// Setup Bidirectional Bridge with Iframes
	window.addEventListener("message", (event) => {
		if (event.data?.type === "toggleSidebar") {
			toggleSidebar()
			return
		}
		const isFromMainWebview = event.source === webviewFrame?.contentWindow
		const isFromSettingsWebview = Boolean(settingsWebviewFrame?.contentWindow && event.source === settingsWebviewFrame.contentWindow)

		// Listen to messages from both webview iframes
		if (isFromMainWebview || isFromSettingsWebview) {
			const data = event.data
			if (data) {
				if (isFromSettingsWebview && data.type === "updateSettings" && data.updatedSettings?.theme) {
					preferredTheme = data.updatedSettings.theme
					applyDesktopTheme(data.updatedSettings.theme, true)
					if (latestExtensionState) latestExtensionState = {...latestExtensionState, theme:data.updatedSettings.theme}
				}
				if (isFromMainWebview && data.type === "desktopShortcut") {
					if (data.key === "k") productWorkspace.palette()
					if (data.key === "o") productWorkspace.projects()
					if (data.key === "n") createConversation(currentWorkspace?.path)
					if (data.key === ",") openSettingsModal()
					if (data.key === "b") toggleSidebar()
					return
				}
				if (isFromMainWebview && data.type === "openProjectManager") { productWorkspace.projects(); return }
				if (isFromSettingsWebview && data.type === "webviewDidLaunch") {
					const theme = localStorage.getItem("roo-theme") || "linear-dark"
					settingsWebviewFrame.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
					settingsWebviewFrame.contentWindow?.postMessage({ type: "languageChange", language: currentLanguage }, "*")
					if (latestExtensionState) {
						settingsWebviewFrame.contentWindow?.postMessage({ type: "state", state: latestExtensionState }, "*")
					}
					settingsWebviewFrame.contentWindow?.postMessage({
						type: "switchTab",
						tab: "settings",
						origin: "sync",
						values: { section: currentSettingsSection || "providers" },
					}, "*")
				}
				if (isFromMainWebview && data.type === "webviewDidLaunch") {
					fetchChatSessions()
					if (activeTaskId && (!latestExtensionState || !latestExtensionState.currentTaskId)) {
						switchChat(activeTaskId, sidebarData.currentWorkspace)
					}
				}
				if (data.type === "languageChange" && data.language) {
					const newLang = (data.language === "pl" || data.language.startsWith("pl")) ? "pl" : "en"
					if (newLang !== currentLanguage) {
						currentLanguage = newLang
						localStorage.setItem("roo-language", currentLanguage)
						applyDesktopTranslations(currentLanguage)
					}
				}
				if (data.type === "state" && data.state) {
					if (preferredTheme) data.state = {...data.state, theme:preferredTheme}
					latestExtensionState = { ...(latestExtensionState || {}), ...data.state }
					if (data.state.theme) {
						applyDesktopTheme(data.state.theme, true)
					}
					if (data.state.language) {
						const newLang = (data.state.language === "pl" || data.state.language.startsWith("pl")) ? "pl" : "en"
						if (newLang !== currentLanguage) {
							currentLanguage = newLang
							localStorage.setItem("roo-language", currentLanguage)
							applyDesktopTranslations(currentLanguage)
						}
					}
				}
				if (data.type === "themeChange" && data.theme) {
					applyDesktopTheme(data.theme, false)
				}
				if (data.type === "openSettings") {
					const targetSection = data.section || data.values?.section || "providers"
					openSettingsModal(targetSection)
					return
				}
				if (data.type === "switchTab" && data.tab) {
					if (isFromSettingsWebview && (data.tab === "chat" || data.tab === "nativeChat")) {
						closeSettingsModal(true)
						return
					}
					if (data.tab === "settings") {
						const targetSection = data.values?.section || data.section || "providers"
						openSettingsModal(targetSection)
						return
					}
					if (data.tab === "nativeChat") {
						switchDesktopTab("native-chat", "sync")
						return
					}
					switchDesktopTab(data.tab, "sync")
					return
				}
				if (data.type === "chatSessionsList" && Array.isArray(data.chatSessions)) {
					chatSessionsList = data.chatSessions
					renderChatSidebar()
				}
				if (data.type === "chatSessionData" && data.chatSession) {
					activeChatSessionId = data.chatSession.id
					renderChatSidebar()
				}
				if (data.type === "action" && data.action) {
					if (data.action === "chatButtonClicked" || (data.action === "switchTab" && data.tab === "chat")) {
						if (isFromSettingsWebview) {
							closeSettingsModal(true)
							return
						}
						switchDesktopTab("chat", "sync")
						return
					}
					if (data.action === "settingsButtonClicked" || (data.action === "switchTab" && data.tab === "settings")) {
						const targetSection = data.values?.section || data.section || "providers"
						openSettingsModal(targetSection)
						return
					}
				}
				if (data.type === "upsertApiConfiguration" && data.apiConfiguration) {
					currentApiConfig = { ...currentApiConfig, ...data.apiConfiguration }
					updateApiPill(currentApiConfig)
				}
				sendToServer({ type: "webviewMessage", message: data })
			}
		}
	})

	function forwardToWebview(msg) {
		if (webviewFrame?.contentWindow) {
			webviewFrame.contentWindow.postMessage(msg, "*")
		}
		if (settingsWebviewFrame?.contentWindow && settingsWebviewFrame.getAttribute("src")) {
			settingsWebviewFrame.contentWindow.postMessage(msg, "*")
		}
	}

	// Listen to Desktop messages if running inside DesktopBridge / Electron
	if (desktopBridge?.ipc?.onMessage) {
		desktopBridge.ipc.onMessage((msg) => {
			if (msg && typeof msg === "object") {
				handleServerMessage(msg)
			}
		})
	}
	if (window.__desktopAPI?.onExtensionMessage) {
		window.__desktopAPI.onExtensionMessage((msg) => {
			if (msg && typeof msg === "object") {
				handleServerMessage(msg)
			}
		})
	}

	// WebSocket connection to Agent Engine
	function connectWebSocket() {
		const protocol = window.location.protocol === "https:" ? "wss://" : "ws://"
		const host = window.location.host || "127.0.0.1:4500"
		const wsUrl = `${protocol}${host}/ws`
		console.log("[WS] Connecting to:", wsUrl)

		try {
			socket = new WebSocket(wsUrl)
		} catch (err) {
			console.error("[WS ERROR] Failed to create WebSocket:", err)
			setTimeout(connectWebSocket, 2000)
			return
		}

		socket.onopen = () => {
			console.log("[WS] Connected successfully to:", wsUrl)
			isConnected = true
			if (connectionStatusEl) {
				connectionStatusEl.textContent = tDesktop("connectedToEngine")
				const dot = connectionStatusEl.parentElement?.querySelector(".indicator-dot")
				if (dot) dot.style.background = "var(--success)"
			}
			if (engineConnectionText) engineConnectionText.textContent = tDesktop("statusConnected")
			if (engineConnectionBadge) {
				engineConnectionBadge.className = "engine-connection-badge status-connected"
				engineConnectionBadge.title = tDesktop("coreEngineConnected")
			}
			terminalRenderedOnce = false
			if (currentDesktopTab === "terminal") sendToServer({ type: "getTerminalLogs" })
			// WebSocket connected - remove loading overlay immediately
			showWebviewSuccess()
			sendToServer({ type: "getWorkspaceInfo" })
			sendToServer({ type: "getDiffs" })
		}

		socket.onmessage = (event) => {
			try {
				const serverMsg = JSON.parse(event.data)
				handleServerMessage(serverMsg)
			} catch (err) {
				console.error("[WS ERROR] Error parsing server message:", err)
			}
		}

		socket.onclose = (event) => {
			console.warn(`[WS] Connection closed (code: ${event.code}, reason: ${event.reason || "none"}). Reconnecting...`)
			isConnected = false
			if (pendingProjectRename) {
				pendingProjectRename = null
				const error = projectRenameDialog?.querySelector(".project-rename-error")
				if (error) { error.textContent = tDesktop("projectNameConnectionError"); error.hidden = false }
				const save = projectRenameDialog?.querySelector('[data-action="save"]')
				if (save) save.disabled = false
			}
			if (connectionStatusEl) {
				connectionStatusEl.textContent = tDesktop("statusDisconnected")
				const dot = connectionStatusEl.parentElement?.querySelector(".indicator-dot")
				if (dot) dot.style.background = "var(--danger)"
			}
			if (engineConnectionText) engineConnectionText.textContent = tDesktop("statusConnecting")
			if (engineConnectionBadge) {
				engineConnectionBadge.className = "engine-connection-badge status-connecting"
				engineConnectionBadge.title = tDesktop("coreEngineConnecting")
			}
			setTimeout(connectWebSocket, 2000)
		}

		socket.onerror = (err) => {
			console.error("[WS ERROR]", err)
		}
	}

	function sendToServer(msg) {
		if (desktopBridge?.capabilities?.runtime === "electron" && msg.type === "webviewMessage") {
			desktopBridge.ipc.send(msg)
			return
		}
		if (window.__desktopAPI?.isElectron && msg.type === "webviewMessage") {
			window.__desktopAPI.sendToExtension(msg.message)
			return
		}
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(msg))
		}
	}

	function updateNavigationCounters(counts) {
		if (pathNormalize(counts.workspace) !== pathNormalize(currentWorkspace?.path)) return
		navigationCounts = counts
		if (diffsCountEl) diffsCountEl.textContent = String(counts.diffCount)
		if (terminalCountEl) {
			terminalCountEl.textContent = String(counts.terminalCount)
			terminalCountEl.title = counts.terminalRunning > 0
				? `${counts.terminalRunning} active command(s) running (${counts.terminalTotal} total)`
				: `${counts.terminalTotal} command session(s)`
		}
	}

	function handleServerMessage(msg) {
		switch (msg.type) {
			case "navigationCounts":
				updateNavigationCounters(msg)
				break

			case "terminalLogsInvalidated":
				terminalRenderedOnce = false
				terminalDirty = true
				if (currentDesktopTab === "terminal") sendToServer({ type: "getTerminalLogs" })
				break

			case "terminalLogsUpdated":
				terminalSessions = (msg.entries || []).slice().reverse()
				selectedTerminalSessionId = terminalSessions[0]?.id || null
				terminalDirty = true
				if (currentDesktopTab === "terminal") {
					renderTerminalLogs()
					terminalRenderedOnce = true
				}
				break

			case "sidebarData":
				updateSidebarData(msg.data)
				break

			case "projectRenameResult":
				if (pendingProjectRename && pathNormalize(pendingProjectRename) === pathNormalize(msg.path)) {
					if (msg.success) {
						closeProjectRenameDialog()
					} else {
						pendingProjectRename = null
						const error = projectRenameDialog?.querySelector(".project-rename-error")
						if (error) { error.textContent = msg.error || tDesktop("projectNameInvalid"); error.hidden = false }
						const save = projectRenameDialog?.querySelector('[data-action="save"]')
						if (save) save.disabled = false
					}
				} else if (!msg.success) {
					productWorkspace.notify(msg.error || tDesktop("projectNameInvalid"))
				}
				break

			case "conversationTitleUpdated":
				handleConversationTitleUpdated(msg)
				break

			case "extensionMessage":
				forwardToWebview(msg.message)
				if (msg.message?.type === "clearTask") {
					terminalLogs = []
					terminalSessions = []
					terminalRenderedOnce = false
					diffFiles = []
					selectedDiffFile = null
					renderTerminalLogs()
					renderDiffs()
				}
				if (msg.message?.type === "state" && msg.message.state) {
					if (preferredTheme) msg.message = {...msg.message, state:{...msg.message.state, theme:preferredTheme}}
					latestExtensionState = { ...(latestExtensionState || {}), ...msg.message.state }
					if (msg.message.state.theme) localStorage.setItem("roo-theme", msg.message.state.theme)
					if (settingsWebviewFrame?.contentWindow && settingsWebviewFrame.getAttribute("src")) {
						settingsWebviewFrame.contentWindow.postMessage({ type: "state", state: latestExtensionState }, "*")
					}
					if (msg.message.state.language) {
						const newLang = (msg.message.state.language === "pl" || msg.message.state.language.startsWith("pl")) ? "pl" : "en"
						if (newLang !== currentLanguage) {
							currentLanguage = newLang
							localStorage.setItem("roo-language", currentLanguage)
							applyDesktopTranslations(currentLanguage)
						}
					}
					if (msg.message.state.apiConfiguration) {
						currentApiConfig = { ...currentApiConfig, ...msg.message.state.apiConfiguration }
						updateApiPill(currentApiConfig)
					}
					if (msg.message.state.currentApiConfigName) {
						currentApiProfileName = msg.message.state.currentApiConfigName
					}
					const webviewTaskId = msg.message.state.currentTaskId ?? null
					if (webviewTaskId !== undefined && webviewTaskId !== activeTaskId) {
						activeTaskId = webviewTaskId
						renderSidebar()
					}
				}
				if (msg.message?.type === "taskHistoryUpdated") {
					fetchSidebarData()
				}
				if (msg.message?.type === "chatSessionsList" && Array.isArray(msg.message.chatSessions)) {
					chatSessionsList = msg.message.chatSessions
					renderChatSidebar()
				}
				if (msg.message?.type === "chatSessionData" && msg.message.chatSession) {
					activeChatSessionId = msg.message.chatSession.id
					renderChatSidebar()
				}
				if (msg.message?.type === "showTaskWithId" && msg.message.text) {
					const epoch = msg.message.selectionEpoch
					if (epoch === undefined || epoch >= currentSelectionEpoch) {
						activeTaskId = msg.message.text
						renderSidebar()
					}
				}
				break

			case "chatSessionsUpdated":
				fetchChatSessions()
				break

			case "workspaceInfo":
				if (pathNormalize(msg.workspace?.path) !== pathNormalize(currentWorkspace?.path)) {
					terminalLogs = []
					terminalSessions = []
					selectedTerminalSessionId = null
					diffFiles = []
					selectedDiffFile = null
					renderTerminalLogs()
					terminalRenderedOnce = false
					renderDiffs()
				}
				currentWorkspace = msg.workspace
				if (pathNormalize(navigationCounts.workspace) !== pathNormalize(currentWorkspace?.path)) {
					updateNavigationCounters({ workspace: currentWorkspace?.path || "", diffCount: 0, terminalCount: 0, terminalTotal: 0, terminalRunning: 0 })
				}
				if (currentDesktopTab === "terminal" && !terminalRenderedOnce) sendToServer({ type: "getTerminalLogs" })
				renderWorkspaceInfo(msg.workspace)
				if (msg.workspace?.path) {
					sidebarData.currentWorkspace = msg.workspace.path
					if (!sidebarData.recentWorkspaces.some((w) => pathNormalize(w) === pathNormalize(msg.workspace.path))) {
						sidebarData.recentWorkspaces.push(msg.workspace.path)
					}
					projectExpansions.add(msg.workspace.path)
					renderSidebar()
				}
				break

			case "agentStatus":
				updateAgentStatus(msg.status)
				break

			case "terminalSessionStarted": {
				const id = String(msg.id || `cmd-${Date.now()}`)
				let session = terminalSessions.find((s) => s.id === id)
				if (!session) {
					session = {
						id,
						command: msg.command || "",
						cwd: msg.cwd || currentWorkspace?.path || "",
						timestamp: typeof msg.timestamp === "number" ? msg.timestamp : Date.now(),
						output: "",
						status: "running",
					}
					terminalSessions.unshift(session)
					if (terminalSessions.length > 200) terminalSessions.pop()
				} else {
					if (msg.command) session.command = msg.command
					if (msg.cwd) session.cwd = msg.cwd
					session.timestamp = typeof msg.timestamp === "number" ? msg.timestamp : session.timestamp
					session.status = "running"
				}
				if (!selectedTerminalSessionId || terminalSessions.length === 1) {
					selectedTerminalSessionId = id
				}
				terminalDirty = true
				if (currentDesktopTab === "terminal") {
					renderTerminalSessions()
					if (selectedTerminalSessionId === id) renderActiveTerminalOutput()
				}
				break
			}

			case "terminalOutput": {
				const id = String(msg.id || "")
				let session = id ? terminalSessions.find((s) => s.id === id) : undefined
				if (!id && !session && terminalSessions.length > 0) {
					session = terminalSessions[0]
				}
				if (session) {
					const chunk = msg.data || ""
					const combined = (session.output || "") + chunk
					session.output = combined.length > 1024 * 1024 ? combined.slice(-1024 * 1024) : combined

					// Tab isolation: ONLY perform DOM work if terminal tab is currently active!
					if (currentDesktopTab === "terminal" && selectedTerminalSessionId === session.id) {
						appendActiveTerminalChunk(chunk)
					} else {
						session._dirty = true
					}
				}
				break
			}

			case "terminalSessionEnded": {
				const id = String(msg.id || "")
				const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 0
				let session = id ? terminalSessions.find((s) => s.id === id) : undefined
				if (!id && !session && terminalSessions.length > 0) {
					session = terminalSessions[0]
				}
				if (session) {
					session.exitCode = exitCode
					session.status = exitCode === 0 ? "completed" : "error"
					if (currentDesktopTab === "terminal") {
						renderTerminalSessions()
						if (selectedTerminalSessionId === session.id) {
							renderActiveTerminalOutput()
						}
					} else {
						session._dirty = true
					}
				}
				break
			}

			case "terminalLogsCleared":
				terminalSessions = []
				terminalLogs = []
				selectedTerminalSessionId = null
				renderTerminalSessions()
				renderActiveTerminalOutput()
				break

			case "terminalLog": {
				if (msg.entry && msg.entry.id) {
					const id = String(msg.entry.id)
					let session = terminalSessions.find((s) => s.id === id)
					if (!session) {
						session = {
							id,
							command: msg.entry.command || "",
							cwd: msg.entry.cwd || currentWorkspace?.path || "",
							timestamp: typeof msg.entry.timestamp === "number" ? msg.entry.timestamp : Date.now(),
							output: msg.entry.output || "",
							exitCode: msg.entry.exitCode,
							status: msg.entry.status || "running",
						}
						terminalSessions.unshift(session)
						if (terminalSessions.length > 200) terminalSessions.pop()
					} else {
						if (msg.entry.command) session.command = msg.entry.command
						if (msg.entry.cwd) session.cwd = msg.entry.cwd
						if (msg.entry.output) session.output = msg.entry.output
						if (msg.entry.exitCode !== undefined) session.exitCode = msg.entry.exitCode
						if (msg.entry.status) session.status = msg.entry.status
					}
					if (!selectedTerminalSessionId) {
						selectedTerminalSessionId = session.id
					}
					terminalDirty = true
					if (currentDesktopTab === "terminal") {
						renderTerminalSessions()
						if (selectedTerminalSessionId === session.id) {
							renderActiveTerminalOutput()
						}
						terminalDirty = false
						terminalRenderedOnce = true
						lastRenderedTerminalSessionId = selectedTerminalSessionId
					}
				}
				break
			}

			case "diffsUpdated":
				diffFiles = msg.diffs || []
				diffsDirty = true
				if (currentDesktopTab === "diffs") {
					renderDiffs()
					diffsDirty = false
					diffsRenderedOnce = true
				}
				break

			case "workspaceFilesChanged":
				diffsDirty = true
				filesDirty = true
				break

			case "fileContent":
				if (
					msg.filePath === selectedPreviewFile ||
					(msg.filePath && selectedPreviewFile && msg.filePath.replace(/\\/g, "/") === selectedPreviewFile.replace(/\\/g, "/"))
				) {
					renderFilePreview(msg)
				}
				break

			case "error":
				console.error("Server error:", msg.message)
				if (selectedPreviewFile && previewContentAreaEl && previewContentAreaEl.querySelector(".preview-placeholder")) {
					previewContentAreaEl.innerHTML = `
						<div class="empty-state" style="color: var(--danger, #f04438);">
							<div class="empty-title">${escapeHtml(tDesktop("failedToLoadFilePreview"))}</div>
							<div class="empty-subtitle">${escapeHtml(msg.message || tDesktop("fileCouldNotBeOpened"))}</div>
						</div>
					`
				}
				break
		}
	}

	function updateAgentStatus(status) {
		currentAgentStatus = status
		const labels = {
			idle: tDesktop("statusConnected"),
			thinking: tDesktop("statusThinking"),
			executing: tDesktop("statusExecuting"),
			waiting_approval: tDesktop("statusWaitingApproval"),
			error: tDesktop("statusError"),
		}
		if (engineConnectionText) {
			engineConnectionText.textContent = labels[status] || status
		}
		if (engineConnectionBadge) {
			engineConnectionBadge.className = `engine-connection-badge status-${status === "idle" ? "connected" : status}`
			engineConnectionBadge.title = status === "idle" ? tDesktop("coreEngineConnected") : (labels[status] || status)
		}
	}

	let lastRenderedWorkspacePath = null

	function renderWorkspaceInfo(ws) {
		if (!ws) return
		productWorkspace?.update()
		if (ws.path !== lastRenderedWorkspacePath) {
			lastRenderedWorkspacePath = ws.path
			expandedFolders.clear()
			hasUserToggledFolders = false
			selectedPreviewFile = null
			currentPreviewMsg = null
			if (previewFilenameEl) previewFilenameEl.textContent = "Wybierz plik"
			if (previewHeaderActionsEl) previewHeaderActionsEl.style.display = "none"
			if (previewFileBadgeEl) previewFileBadgeEl.style.display = "none"
			if (previewFileSizeEl) previewFileSizeEl.textContent = ""
			if (previewContentAreaEl) previewContentAreaEl.innerHTML = '<div class="preview-placeholder"><div class="empty-title">Pliki projektu</div><p class="empty-subtitle">Wybierz plik, aby zobaczyć jego zawartość, edytować go lub dodać do rozmowy.</p></div>'
			try {
				sessionStorage.removeItem("roo-expanded-folders")
			} catch (e) {}
		}
		if (workspaceNameEl) {
			workspaceNameEl.textContent = ws.name || ws.path
			workspaceNameEl.title = ws.path
		}
		if (footerWorkspaceEl) {
			footerWorkspaceEl.textContent = ws.path ? "Projekt: " + ws.path : "Nie wybrano projektu"
		}

		if (ws.branch) {
			if (gitPill) gitPill.style.display = "flex"
			if (gitBranchEl) gitBranchEl.textContent = ws.branch
		} else {
			if (gitPill) gitPill.style.display = "none"
		}

		renderFilesTree(ws.files || [], filesSearchInput?.value?.toLowerCase() || "", ws.directories || [])
	}

	const DIFF_ITEM_HEIGHT = 40
	const diffContentCache = new Map()
	let activeDiffAbortController = null

	function computeLineDiff(oldLines, newLines) {
		const N = oldLines.length
		const M = newLines.length
		let start = 0
		while (start < N && start < M && oldLines[start] === newLines[start]) {
			start++
		}
		let oldEnd = N - 1
		let newEnd = M - 1
		while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
			oldEnd--
			newEnd--
		}

		const items = []
		for (let i = 0; i < start; i++) {
			items.push({ type: "same", line: oldLines[i], oldNum: i + 1, newNum: i + 1 })
		}

		const midOld = oldLines.slice(start, oldEnd + 1)
		const midNew = newLines.slice(start, newEnd + 1)

		if (midOld.length * midNew.length <= 4000000) {
			const dp = Array.from({ length: midOld.length + 1 }, () => new Int32Array(midNew.length + 1))
			for (let i = 0; i < midOld.length; i++) {
				for (let j = 0; j < midNew.length; j++) {
					if (midOld[i] === midNew[j]) {
						dp[i + 1][j + 1] = dp[i][j] + 1
					} else {
						dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
					}
				}
			}
			let i = midOld.length
			let j = midNew.length
			const midItems = []
			while (i > 0 || j > 0) {
				if (i > 0 && j > 0 && midOld[i - 1] === midNew[j - 1]) {
					midItems.push({ type: "same", line: midOld[i - 1], oldNum: start + i, newNum: start + j })
					i--
					j--
				} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
					midItems.push({ type: "add", line: midNew[j - 1], newNum: start + j })
					j--
				} else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
					midItems.push({ type: "del", line: midOld[i - 1], oldNum: start + i })
					i--
				}
			}
			midItems.reverse()
			items.push(...midItems)
		} else {
			for (let i = 0; i < midOld.length; i++) {
				items.push({ type: "del", line: midOld[i], oldNum: start + i + 1 })
			}
			for (let j = 0; j < midNew.length; j++) {
				items.push({ type: "add", line: midNew[j], newNum: start + j + 1 })
			}
		}

		for (let k = 0; k < (N - 1 - oldEnd); k++) {
			const oIdx = oldEnd + 1 + k
			const nIdx = newEnd + 1 + k
			items.push({ type: "same", line: oldLines[oIdx], oldNum: oIdx + 1, newNum: nIdx + 1 })
		}

		return items
	}

	function selectDiffFile(filePath) {
		if (selectedDiffFile === filePath) return
		selectedDiffFile = filePath
		if (diffsFileListEl) {
			diffsFileListEl.querySelectorAll(".diff-item").forEach((el) => {
				if (el.getAttribute("data-file-path") === filePath) {
					el.classList.add("selected")
				} else {
					el.classList.remove("selected")
				}
			})
		}
		const file = diffFiles.find((f) => f.filePath === filePath)
		if (file) {
			loadAndRenderSelectedDiff(file)
		}
	}

	function renderDiffs() {
		const count = diffFiles.length
		if (diffFileCounterEl) diffFileCounterEl.textContent = tDesktop("filesCount", count)

		const listPane = document.getElementById("diffs-list-pane")
		const targetList = diffsFileListEl || listPane?.querySelector(".diffs-list") || listPane

		if (!targetList) return

		if (count === 0) {
			targetList.innerHTML = `<div class="empty-state">${escapeHtml(tDesktop("noChangesAgent"))}</div>`
			if (diffViewerHeaderEl) {
				diffViewerHeaderEl.innerHTML = `<span class="diff-filename">${escapeHtml(tDesktop("selectFileToReview"))}</span>`
			}
			if (diffContentEl) {
				diffContentEl.innerHTML = `
					<div class="diff-placeholder">
						<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<circle cx="18" cy="18" r="3"></circle>
							<circle cx="6" cy="6" r="3"></circle>
							<path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
							<line x1="6" y1="9" x2="6" y2="21"></line>
						</svg>
						<p id="diffs-placeholder-text">${escapeHtml(tDesktop("diffsPlaceholder"))}</p>
					</div>
				`
			}
			return
		}

		// If no file is selected or selected file is no longer in diffFiles, select the first one
		if (!selectedDiffFile || !diffFiles.some((f) => f.filePath === selectedDiffFile)) {
			selectedDiffFile = diffFiles[0].filePath
		}

		// Virtualized rendering
		const totalHeight = count * DIFF_ITEM_HEIGHT
		targetList.innerHTML = `<div class="diff-virtual-container" style="height: ${totalHeight}px; position: relative;"></div>`
		const virtualContainer = targetList.querySelector(".diff-virtual-container")

		function updateVirtualItems() {
			if (!virtualContainer) return
			const scrollTop = targetList.scrollTop
			const clientHeight = targetList.clientHeight || 500
			const startIdx = Math.max(0, Math.floor(scrollTop / DIFF_ITEM_HEIGHT) - 5)
			const endIdx = Math.min(count, Math.ceil((scrollTop + clientHeight) / DIFF_ITEM_HEIGHT) + 5)

			let itemsHtml = ""
			for (let i = startIdx; i < endIdx; i++) {
				const file = diffFiles[i]
				if (!file) continue
				const status = (file.status || "modified").toLowerCase()
				const isCreated = status === "created" || status === "added"
				const isDeleted = status === "deleted"
				const statusClass = isCreated ? "created" : isDeleted ? "deleted" : "modified"
				const statusChar = isCreated ? "A" : isDeleted ? "D" : "M"
				const statusTitle = isCreated ? "Utworzony" : isDeleted ? "Usunięty" : "Zmieniony"
				const isSelected = selectedDiffFile === file.filePath

				itemsHtml += `
					<div class="diff-item ${isSelected ? "selected" : ""}" data-file-path="${escapeHtml(file.filePath)}" style="position: absolute; top: ${i * DIFF_ITEM_HEIGHT}px; left: 0; right: 0; height: 38px;">
						<div class="diff-item-left">
							<span class="diff-type-badge ${statusClass}" title="${statusTitle}">${statusChar}</span>
							<span class="diff-file-path" title="${escapeHtml(file.filePath)}">${escapeHtml(file.filePath)}</span>
						</div>
						<div class="diff-stats">
							<span class="add">+${file.additions || 0}</span>
							<span class="del">-${file.deletions || 0}</span>
						</div>
					</div>
				`
			}
			virtualContainer.innerHTML = itemsHtml

			virtualContainer.querySelectorAll(".diff-item").forEach((itemEl) => {
				itemEl.addEventListener("click", () => {
					const fp = itemEl.getAttribute("data-file-path")
					if (fp) selectDiffFile(fp)
				})
			})
		}

		targetList.onscroll = () => {
			window.requestAnimationFrame(updateVirtualItems)
		}

		updateVirtualItems()

		const activeFile = diffFiles.find((f) => f.filePath === selectedDiffFile) || diffFiles[0]
		if (activeFile) {
			loadAndRenderSelectedDiff(activeFile)
		}
	}

	async function loadAndRenderSelectedDiff(file) {
		if (!file) return

		const status = (file.status || "modified").toLowerCase()
		const isCreated = status === "created" || status === "added"
		const isDeleted = status === "deleted"
		const statusClass = isCreated ? "created" : isDeleted ? "deleted" : "modified"
		const statusChar = isCreated ? "A" : isDeleted ? "D" : "M"
		const statusTitle = isCreated ? "Utworzony" : isDeleted ? "Usunięty" : "Zmieniony"

		if (diffViewerHeaderEl) {
			diffViewerHeaderEl.innerHTML = `
				<div class="diff-viewer-title-row">
					<span class="diff-type-badge ${statusClass}" title="${statusTitle}">${statusChar}</span>
					<span class="diff-filename" style="font-weight:600; color:var(--text-primary);">${escapeHtml(file.filePath)}</span>
					<span style="font-size:11px; color:var(--text-muted); text-transform:capitalize;">(${escapeHtml(statusTitle)})</span>
				</div>
				<div class="diff-viewer-actions">
					<div class="diff-stats">
						<span class="add">+${file.additions || 0}</span>
						<span class="del">-${file.deletions || 0}</span>
					</div>
				</div>
			`
		}

		// Check in-memory cache first
		if (diffContentCache.has(file.filePath)) {
			renderDiffContent(diffContentCache.get(file.filePath))
			return
		}

		let diffData = file

		// If diff text or content not already present, fetch from /api/diff
		if (!diffData.diff && (diffData.newContent === undefined || diffData.oldContent === undefined)) {
			if (activeDiffAbortController) {
				activeDiffAbortController.abort()
			}
			activeDiffAbortController = new AbortController()

			try {
				const wsPath = sidebarData.currentWorkspace || currentWorkspace?.path || ""
				const qParams = new URLSearchParams()
				qParams.set("path", file.filePath)
				if (wsPath) qParams.set("workspace", wsPath)
				if (activeTaskId) qParams.set("taskId", activeTaskId)
				const res = await fetch(`/api/diff?${qParams.toString()}`, {
					signal: activeDiffAbortController.signal,
				})
				if (res.ok) {
					const data = await res.json()
					diffData = { ...file, ...data }
					diffContentCache.set(file.filePath, diffData)
					if (diffContentCache.size > 50) {
						const oldestKey = diffContentCache.keys().next().value
						diffContentCache.delete(oldestKey)
					}
				}
			} catch (e) {
				if (e.name === "AbortError") return
				console.warn("Error fetching /api/diff:", e)
			}
		}

		renderDiffContent(diffData)

		// Prefetch adjacent 1-2 files in idle time
		const curIdx = diffFiles.findIndex((f) => f.filePath === file.filePath)
		if (curIdx >= 0) {
			const toPrefetch = [diffFiles[curIdx + 1], diffFiles[curIdx + 2]].filter(Boolean)
			for (const pf of toPrefetch) {
				if (!diffContentCache.has(pf.filePath) && !pf.diff && pf.newContent === undefined) {
					const wsPath = sidebarData.currentWorkspace || currentWorkspace?.path || ""
					const qParams = new URLSearchParams()
					qParams.set("path", pf.filePath)
					if (wsPath) qParams.set("workspace", wsPath)
					if (activeTaskId) qParams.set("taskId", activeTaskId)
					fetch(`/api/diff?${qParams.toString()}`)
						.then((r) => (r.ok ? r.json() : null))
						.then((data) => {
							if (data) diffContentCache.set(pf.filePath, { ...pf, ...data })
						})
						.catch(() => {})
				}
			}
		}
	}

	function renderDiffContent(file) {
		if (!diffContentEl) return

		// 0. Handle content unavailable / error state
		if (file.contentUnavailable) {
			diffContentEl.innerHTML = `
				<div class="diff-content-unavailable">
					<h4>Nie można wyświetlić pliku</h4>
					<p>${escapeHtml(file.reason || "Zawartość pliku jest niedostępna.")}</p>
				</div>
			`
			return
		}

		// 0.5. Handle genuine 0-byte file
		if (file.isActuallyEmpty) {
			diffContentEl.innerHTML = `<div class="empty-state">Pusty plik (0 bajtów)</div>`
			return
		}

		// 1. If we have unified diff output or SEARCH/REPLACE block
		if (file.diff && typeof file.diff === "string" && file.diff.trim().length > 0) {
			if (file.diff.includes("<<<<<<< SEARCH")) {
				const lines = file.diff.split("\n")
				let html = ""
				let mode = "outside" // "search", "replace"
				let lineNum = 1
				for (const line of lines) {
					if (line.startsWith("<<<<<<< SEARCH")) {
						mode = "search"
						html += `<div class="diff-line hunk-header"><span class="diff-gutter"></span><span class="diff-prefix"></span><span class="diff-text">Przed zmianą</span></div>`
						continue
					} else if (line.startsWith("=======")) {
						mode = "replace"
						html += `<div class="diff-line hunk-header"><span class="diff-gutter"></span><span class="diff-prefix"></span><span class="diff-text">Po zmianie</span></div>`
						continue
					} else if (line.startsWith(">>>>>>>")) {
						mode = "outside"
						continue
					} else if (mode === "search" && (line.startsWith(":start_line:") || line === "-------")) {
						continue
					}
					if (mode === "search") {
						html += `<div class="diff-line deletion"><span class="diff-gutter">${lineNum}</span><span class="diff-prefix">-</span><span class="diff-text">${escapeHtml(line)}</span></div>`
						lineNum++
					} else if (mode === "replace") {
						html += `<div class="diff-line addition"><span class="diff-gutter">${lineNum}</span><span class="diff-prefix">+</span><span class="diff-text">${escapeHtml(line)}</span></div>`
						lineNum++
					}
				}
				if (html) {
					diffContentEl.innerHTML = html
					return
				}
			}

			const lines = file.diff.split("\n")
			let html = ""
			let oldLineNum = 0
			let newLineNum = 0
			let inHunk = false

			for (const line of lines) {
				if (
					line.startsWith("diff --git") ||
					line.startsWith("index ") ||
					line.startsWith("--- ") ||
					line.startsWith("+++ ")
				) {
					continue
				}
				if (line.startsWith("@@")) {
					const match = line.match(/@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
					if (match) {
						oldLineNum = parseInt(match[1], 10)
						newLineNum = parseInt(match[2], 10)
					}
					html += `<div class="diff-line hunk-header"><span class="diff-gutter"></span><span class="diff-prefix"></span><span class="diff-text">${escapeHtml(line)}</span></div>`
					inHunk = true
					continue
				}
				if (!inHunk) continue

				if (line.startsWith("+")) {
					html += `<div class="diff-line addition"><span class="diff-gutter">${newLineNum}</span><span class="diff-prefix">+</span><span class="diff-text">${escapeHtml(line.slice(1))}</span></div>`
					newLineNum++
				} else if (line.startsWith("-")) {
					html += `<div class="diff-line deletion"><span class="diff-gutter">${oldLineNum}</span><span class="diff-prefix">-</span><span class="diff-text">${escapeHtml(line.slice(1))}</span></div>`
					oldLineNum++
				} else {
					const text = line.startsWith(" ") ? line.slice(1) : line
					html += `<div class="diff-line same"><span class="diff-gutter">${newLineNum}</span><span class="diff-prefix"> </span><span class="diff-text">${escapeHtml(text)}</span></div>`
					oldLineNum++
					newLineNum++
				}
			}

			if (html) {
				diffContentEl.innerHTML = html
				return
			}
		}

		// 2. If we have oldContent and newContent
		if (file.oldContent !== undefined && file.newContent !== undefined && file.oldContent !== file.newContent) {
			const oldLines = (file.oldContent || "").split("\n")
			const newLines = (file.newContent || "").split("\n")
			const diffItems = computeLineDiff(oldLines, newLines)
			let html = ""
			diffItems.forEach((item) => {
				if (item.type === "same") {
					html += `<div class="diff-line same"><span class="diff-gutter">${item.newNum || item.oldNum}</span><span class="diff-prefix"> </span><span class="diff-text">${escapeHtml(item.line)}</span></div>`
				} else if (item.type === "del") {
					html += `<div class="diff-line deletion"><span class="diff-gutter">${item.oldNum}</span><span class="diff-prefix">-</span><span class="diff-text">${escapeHtml(item.line)}</span></div>`
				} else if (item.type === "add") {
					html += `<div class="diff-line addition"><span class="diff-gutter">${item.newNum}</span><span class="diff-prefix">+</span><span class="diff-text">${escapeHtml(item.line)}</span></div>`
				}
			})
			diffContentEl.innerHTML = html
			return
		}

		// 3. Brand new file (all additions)
		if (file.status === "added" || file.status === "created" || (!file.oldContent && file.newContent !== undefined)) {
			if (!file.newContent) {
				diffContentEl.innerHTML = `<div class="empty-state">Pusty plik (0 bajtów)</div>`
				return
			}
			const lines = (file.newContent || "").split("\n")
			let html = ""
			lines.forEach((line, idx) => {
				html += `<div class="diff-line addition"><span class="diff-gutter">${idx + 1}</span><span class="diff-prefix">+</span><span class="diff-text">${escapeHtml(line)}</span></div>`
			})
			diffContentEl.innerHTML = html || `<div class="empty-state">Nowy, pusty plik</div>`
			return
		}

		// 4. Usunięty plik (all deletions)
		if (file.status === "deleted" || (file.oldContent && !file.newContent)) {
			const lines = (file.oldContent || "").split("\n")
			let html = ""
			lines.forEach((line, idx) => {
				html += `<div class="diff-line deletion"><span class="diff-gutter">${idx + 1}</span><span class="diff-prefix">-</span><span class="diff-text">${escapeHtml(line)}</span></div>`
			})
			diffContentEl.innerHTML = html || `<div class="empty-state">Usunięty plik</div>`
			return
		}

		// 5. Fallback or no changes
		if (file.newContent !== undefined || file.oldContent !== undefined) {
			const content = file.newContent !== undefined ? file.newContent : file.oldContent
			if (content === "") {
				diffContentEl.innerHTML = `<div class="empty-state">Pusty plik (0 bajtów)</div>`
				return
			}
			const lines = (content || "").split("\n")
			let html = ""
			lines.forEach((line, idx) => {
				html += `<div class="diff-line same"><span class="diff-gutter">${idx + 1}</span><span class="diff-prefix"> </span><span class="diff-text">${escapeHtml(line)}</span></div>`
			})
			diffContentEl.innerHTML = html
			return
		}

		diffContentEl.innerHTML = `<div class="empty-state">${escapeHtml(tDesktop("diffEmpty"))}</div>`
	}

	// ANSI escape sequence parser & converter
	const ANSI_FG_COLORS = {
		30: "#4b5563", // Black / Dark gray
		31: "#ef4444", // Red
		32: "#10b981", // Green
		33: "#f59e0b", // Yellow
		34: "#3b82f6", // Blue
		35: "#ec4899", // Magenta
		36: "#06b6d4", // Cyan
		37: "#f1f5f9", // White
		90: "#64748b", // Bright Black (Gray)
		91: "#f87171", // Bright Red
		92: "#34d399", // Bright Green
		93: "#fbbf24", // Bright Yellow
		94: "#60a5fa", // Bright Blue
		95: "#f472b6", // Bright Magenta
		96: "#22d3ee", // Bright Cyan
		97: "#ffffff", // Bright White
	}

	const ANSI_BG_COLORS = {
		40: "#1f2937",
		41: "rgba(239, 68, 68, 0.25)",
		42: "rgba(16, 185, 129, 0.25)",
		43: "rgba(245, 158, 11, 0.25)",
		44: "rgba(59, 130, 246, 0.25)",
		45: "rgba(236, 72, 153, 0.25)",
		46: "rgba(6, 182, 212, 0.25)",
		47: "#f8fafc",
		100: "#374151",
		101: "rgba(248, 113, 113, 0.35)",
		102: "rgba(52, 211, 153, 0.35)",
		103: "rgba(251, 191, 36, 0.35)",
		104: "rgba(96, 165, 250, 0.35)",
		105: "rgba(244, 114, 182, 0.35)",
		106: "rgba(34, 211, 238, 0.35)",
		107: "#ffffff",
	}

	function stripAnsi(text) {
		if (!text || typeof text !== "string") return ""
		return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "")
	}

	function get256Color(n) {
		if (n < 8) return ANSI_FG_COLORS[30 + n] || "#f1f5f9"
		if (n < 16) return ANSI_FG_COLORS[90 + (n - 8)] || "#f1f5f9"
		if (n < 232) {
			const index = n - 16
			const r = Math.floor(index / 36) * 51
			const g = Math.floor((index % 36) / 6) * 51
			const b = (index % 6) * 51
			return `rgb(${r}, ${g}, ${b})`
		}
		const gray = 8 + (n - 232) * 10
		return `rgb(${gray}, ${gray}, ${gray})`
	}

	function ansiToHtml(text) {
		if (!text || typeof text !== "string") return ""
		const cleaned = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
		const regex = /\x1b\[([0-9;?]*)m/g
		let html = ""
		let lastIndex = 0
		let currentStyles = {
			fg: null,
			bg: null,
			bold: false,
			dim: false,
			italic: false,
			underline: false,
		}

		function getSpanStyle() {
			const styles = []
			if (currentStyles.fg) styles.push(`color: ${currentStyles.fg}`)
			if (currentStyles.bg) styles.push(`background-color: ${currentStyles.bg}`)
			return styles.join("; ")
		}

		function getSpanClasses() {
			const classes = []
			if (currentStyles.bold) classes.push("ansi-bold")
			if (currentStyles.dim) classes.push("ansi-dim")
			if (currentStyles.italic) classes.push("ansi-italic")
			if (currentStyles.underline) classes.push("ansi-underline")
			return classes.join(" ")
		}

		function appendChunk(raw) {
			if (!raw) return
			const escaped = escapeHtml(raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""))
			const style = getSpanStyle()
			const classes = getSpanClasses()
			if (style || classes) {
				const styleAttr = style ? ` style="${style}"` : ""
				const classAttr = classes ? ` class="${classes}"` : ""
				html += `<span${classAttr}${styleAttr}>${escaped}</span>`
			} else {
				html += escaped
			}
		}

		let match
		while ((match = regex.exec(cleaned)) !== null) {
			const textChunk = cleaned.slice(lastIndex, match.index)
			appendChunk(textChunk)
			lastIndex = regex.lastIndex

			const codes = (match[1] || "0").split(";").map((c) => parseInt(c, 10))
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i]
				if (isNaN(code) || code === 0) {
					currentStyles = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false }
				} else if (code === 1) {
					currentStyles.bold = true
				} else if (code === 2) {
					currentStyles.dim = true
				} else if (code === 3) {
					currentStyles.italic = true
				} else if (code === 4) {
					currentStyles.underline = true
				} else if (code === 22) {
					currentStyles.bold = false
					currentStyles.dim = false
				} else if (code === 23) {
					currentStyles.italic = false
				} else if (code === 24) {
					currentStyles.underline = false
				} else if (code === 39) {
					currentStyles.fg = null
				} else if (code === 49) {
					currentStyles.bg = null
				} else if (ANSI_FG_COLORS[code]) {
					currentStyles.fg = ANSI_FG_COLORS[code]
				} else if (ANSI_BG_COLORS[code]) {
					currentStyles.bg = ANSI_BG_COLORS[code]
				} else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
					const n = codes[i + 2]
					currentStyles.fg = get256Color(n)
					i += 2
				} else if (code === 48 && codes[i + 1] === 5 && codes[i + 2] !== undefined) {
					const n = codes[i + 2]
					currentStyles.bg = get256Color(n)
					i += 2
				} else if (code === 38 && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
					currentStyles.fg = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
					i += 4
				} else if (code === 48 && codes[i + 1] === 2 && codes[i + 4] !== undefined) {
					currentStyles.bg = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
					i += 4
				}
			}
		}

		appendChunk(cleaned.slice(lastIndex))
		return html
	}

	function renderTerminalSessions() {
		if (terminalSessionCounter) {
			terminalSessionCounter.textContent = tDesktop("terminalSessionsCount", terminalSessions.length)
		}


		if (!terminalSessionsList) return

		if (terminalSessions.length === 0) {
			terminalSessionsList.innerHTML = `<div class="empty-state" id="terminal-sessions-empty">${escapeHtml(tDesktop("terminalSessionsEmpty"))}</div>`
			return
		}

		let html = ""
		terminalSessions.forEach((session) => {
			const isSelected = session.id === selectedTerminalSessionId
			const timeStr = session.timestamp ? new Date(session.timestamp).toLocaleTimeString() : ""
			const cwdDisplay = session.cwd ? session.cwd.split(/[/\\]/).filter(Boolean).pop() || session.cwd : ""

			let badgeHtml = ""
			if (session.status === "running") {
				badgeHtml = `<span class="session-badge badge-running"><span class="badge-dot"></span>${escapeHtml(tDesktop("sessionRunning"))}</span>`
			} else if (session.status === "error" || (typeof session.exitCode === "number" && session.exitCode !== 0)) {
				badgeHtml = `<span class="session-badge badge-error">exit ${session.exitCode ?? 1}</span>`
			} else {
				badgeHtml = `<span class="session-badge badge-completed">0</span>`
			}

			html += `
				<div class="terminal-session-item ${isSelected ? "selected" : ""}" data-session-id="${escapeHtml(session.id)}">
					<div class="terminal-session-header">
						<span class="terminal-session-cmd" title="${escapeHtml(session.command)}">$ ${escapeHtml(session.command || "command")}</span>
						${badgeHtml}
					</div>
					<div class="terminal-session-footer">
						<span class="terminal-session-cwd" title="${escapeHtml(session.cwd || "")}">${escapeHtml(cwdDisplay)}</span>
						<span class="terminal-session-time">${escapeHtml(timeStr)}</span>
					</div>
				</div>
			`
		})

		terminalSessionsList.innerHTML = html

		terminalSessionsList.querySelectorAll(".terminal-session-item").forEach((el) => {
			el.addEventListener("click", () => {
				const sessionId = el.getAttribute("data-session-id")
				if (sessionId && sessionId !== selectedTerminalSessionId) {
					selectedTerminalSessionId = sessionId
					renderTerminalSessions()
					renderActiveTerminalOutput()
				}
			})
		})
	}

	function renderActiveTerminalOutput() {
		if (!terminalOutputEl) return

		if (terminalSessions.length === 0) {
			terminalOutputEl.innerHTML = `<div class="terminal-empty" id="terminal-empty-text">${escapeHtml(tDesktop("terminalEmpty"))}</div>`
			if (terminalTitleText) terminalTitleText.textContent = tDesktop("terminalTitle")
			if (terminalSessionStatusBadge) terminalSessionStatusBadge.style.display = "none"
			return
		}

		let activeSession = terminalSessions.find((s) => s.id === selectedTerminalSessionId)
		if (!activeSession) {
			activeSession = terminalSessions[0]
			selectedTerminalSessionId = activeSession.id
			renderTerminalSessions()
		}

		if (terminalTitleText) {
			terminalTitleText.textContent = activeSession.command ? `$ ${activeSession.command}` : tDesktop("terminalTitle")
			terminalTitleText.title = activeSession.cwd ? `${activeSession.command} (in ${activeSession.cwd})` : activeSession.command
		}

		if (terminalSessionStatusBadge) {
			terminalSessionStatusBadge.style.display = "inline-flex"
			if (activeSession.status === "running") {
				terminalSessionStatusBadge.className = "terminal-session-status-badge session-badge badge-running"
				terminalSessionStatusBadge.innerHTML = `<span class="badge-dot"></span>${escapeHtml(tDesktop("sessionRunning"))}`
			} else if (activeSession.status === "error" || (typeof activeSession.exitCode === "number" && activeSession.exitCode !== 0)) {
				terminalSessionStatusBadge.className = "terminal-session-status-badge session-badge badge-error"
				terminalSessionStatusBadge.textContent = `exit ${activeSession.exitCode ?? 1}`
			} else {
				terminalSessionStatusBadge.className = "terminal-session-status-badge session-badge badge-completed"
				terminalSessionStatusBadge.textContent = "exit 0"
			}
		}

		const isNearBottom = terminalOutputEl.scrollHeight - terminalOutputEl.scrollTop - terminalOutputEl.clientHeight < 80

		if (!activeSession.output || !activeSession.output.trim()) {
			const emptyHtml = activeSession.status === "running"
				? `<div class="terminal-ansi-pre"><span style="color: var(--text-muted);">$ ${escapeHtml(activeSession.command)}\n[Running command in workspace...]</span></div>`
				: `<div class="terminal-ansi-pre"><span style="color: var(--text-muted);">$ ${escapeHtml(activeSession.command)}\n(Command completed with no output)</span></div>`
			if (terminalOutputEl._lastSessionId !== activeSession.id || terminalOutputEl._lastHtml !== emptyHtml) {
				terminalOutputEl.innerHTML = emptyHtml
				terminalOutputEl._lastSessionId = activeSession.id
				terminalOutputEl._lastHtml = emptyHtml
			}
		} else {
			if (activeSession._cachedOutput !== activeSession.output) {
				activeSession._cachedHtml = ansiToHtml(activeSession.output)
				activeSession._cachedOutput = activeSession.output
			}
			const parsedHtml = activeSession._cachedHtml
			if (terminalOutputEl._lastSessionId !== activeSession.id || terminalOutputEl._lastHtml !== parsedHtml) {
				terminalOutputEl.innerHTML = `<pre class="terminal-ansi-pre"><code>${parsedHtml}</code></pre>`
				terminalOutputEl._lastSessionId = activeSession.id
				terminalOutputEl._lastHtml = parsedHtml
			}
		}

		if (isNearBottom) {
			terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight
		}
	}

	function appendActiveTerminalChunk(chunk) {
		if (!terminalOutputEl || !chunk) return
		let activeSession = terminalSessions.find((s) => s.id === selectedTerminalSessionId) || terminalSessions[0]
		if (!activeSession) return

		const codeEl = terminalOutputEl.querySelector(".terminal-ansi-pre code")
		if (!codeEl || terminalOutputEl._lastSessionId !== activeSession.id) {
			renderActiveTerminalOutput()
			return
		}

		const isNearBottom = terminalOutputEl.scrollHeight - terminalOutputEl.scrollTop - terminalOutputEl.clientHeight < 120
		const chunkHtml = ansiToHtml(chunk)

		codeEl.insertAdjacentHTML("beforeend", chunkHtml)

		if (isNearBottom) {
			terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight
		}
	}

	function renderTerminalLogs() {
		renderTerminalSessions()
		renderActiveTerminalOutput()
	}

	function formatBytes(bytes, decimals = 1) {
		if (!bytes || bytes === 0) return "0 B"
		const k = 1024
		const dm = decimals < 0 ? 0 : decimals
		const sizes = ["B", "KB", "MB", "GB", "TB"]
		const i = Math.floor(Math.log(bytes) / Math.log(k))
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i]
	}

	function getFileIconInfo(filePath) {
		const ext = filePath.split(".").pop()?.toLowerCase() || ""
		switch (ext) {
			case "png":
			case "jpg":
			case "jpeg":
			case "gif":
			case "webp":
			case "ico":
			case "bmp":
				return {
					icon: `<svg class="file-icon icon-image" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
					type: "image",
					badge: ext.toUpperCase(),
				}
			case "svg":
				return {
					icon: `<svg class="file-icon icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
					type: "svg",
					badge: "SVG",
				}
			case "ts":
			case "tsx":
				return {
					icon: `<svg class="file-icon icon-ts" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
					type: "ts",
					badge: ext.toUpperCase(),
				}
			case "js":
			case "jsx":
			case "mjs":
			case "cjs":
				return {
					icon: `<svg class="file-icon icon-js" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
					type: "js",
					badge: ext.toUpperCase(),
				}
			case "json":
				return {
					icon: `<svg class="file-icon icon-json" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6c0-1.1.9-2 2-2h2v4H6a2 2 0 0 1-2-2z"></path><path d="M20 6c0-1.1-.9-2-2-2h-2v4h2a2 2 0 0 1 2-2z"></path><path d="M4 18c0 1.1.9 2 2 2h2v-4H6a2 2 0 0 0-2 2z"></path><path d="M20 18c0 1.1-.9 2-2 2h-2v-4h2a2 2 0 0 0 2 2z"></path></svg>`,
					type: "json",
					badge: "JSON",
				}
			case "md":
			case "markdown":
				return {
					icon: `<svg class="file-icon icon-md" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
					type: "md",
					badge: "MD",
				}
			case "html":
				return {
					icon: `<svg class="file-icon icon-html" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
					type: "html",
					badge: "HTML",
				}
			case "css":
			case "scss":
			case "less":
				return {
					icon: `<svg class="file-icon icon-css" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"></line><line x1="4" y1="15" x2="20" y2="15"></line><line x1="10" y1="3" x2="8" y2="21"></line><line x1="16" y1="3" x2="14" y2="21"></line></svg>`,
					type: "css",
					badge: "CSS",
				}
			case "bat":
			case "cmd":
			case "sh":
			case "ps1":
				return {
					icon: `<svg class="file-icon icon-script" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
					type: "script",
					badge: ext.toUpperCase(),
				}
			case "pdf":
				return {
					icon: `<svg class="file-icon icon-pdf" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
					type: "pdf",
					badge: "PDF",
				}
			case "zip":
			case "tar":
			case "gz":
			case "7z":
			case "rar":
				return {
					icon: `<svg class="file-icon icon-zip" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>`,
					type: "archive",
					badge: ext.toUpperCase(),
				}
			case "exe":
			case "dll":
			case "bin":
			case "msi":
			case "pak":
				return {
					icon: `<svg class="file-icon icon-exe" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect><circle cx="12" cy="12" r="3"></circle></svg>`,
					type: "binary",
					badge: ext.toUpperCase(),
				}
			case "py":
			case "pyw":
				return {
					icon: `<svg class="file-icon icon-code" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
					type: "code",
					badge: "PY",
				}
			case "yaml":
			case "yml":
				return {
					icon: `<svg class="file-icon icon-yaml" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>`,
					type: "yaml",
					badge: "YAML",
				}
			default:
				return {
					icon: `<svg class="file-icon icon-doc" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,
					type: "text",
					badge: ext ? ext.toUpperCase() : "FILE",
				}
		}
	}

	let loadFilesAbortController = null

	async function loadWorkspaceFiles() {
		if (loadFilesAbortController) {
			loadFilesAbortController.abort()
		}
		loadFilesAbortController = new AbortController()
		const signal = loadFilesAbortController.signal

		try {
			const res = await fetch("/api/files", { signal })
			if (res.ok) {
				const data = await res.json()
				if (signal.aborted) return
				if (data && (Array.isArray(data.files) || Array.isArray(data.directories))) {
					if (!currentWorkspace) {
						currentWorkspace = { files: [], directories: [] }
					}
					currentWorkspace.files = Array.isArray(data.files) ? data.files : []
					currentWorkspace.directories = Array.isArray(data.directories) ? data.directories : []
					renderFilesTree(currentWorkspace.files, filesSearchInput?.value?.trim().toLowerCase() || "", currentWorkspace.directories)
					if (currentWorkspace.name) {
						return data.files
					}
				}
			}
		} catch (err) {
			if (err.name === "AbortError" || signal.aborted) {
				return
			}
			console.warn("Failed to load files from /api/files:", err)
		}

		try {
			if (signal.aborted) return
			const wsRes = await fetch("/api/workspace", { signal })
			if (wsRes.ok) {
				const wsData = await wsRes.json()
				if (signal.aborted) return
				if (wsData) {
					currentWorkspace = wsData
					renderWorkspaceInfo(wsData)
					return wsData.files
				}
			}
		} catch (e) {
			if (e.name === "AbortError" || signal.aborted) {
				return
			}
			console.error("Failed to load workspace from /api/workspace:", e)
		}
	}

	function ensureParentFoldersExpanded(filePath) {
		if (!filePath) return
		const parts = filePath.split(/[\\/]/).filter(Boolean)
		let cur = ""
		for (let i = 0; i < parts.length - 1; i++) {
			cur = cur ? `${cur}/${parts[i]}` : parts[i]
			expandedFolders.add(cur)
		}
	}

	function buildTree(files = [], directories = []) {
		const root = {
			name: "",
			path: "",
			type: "folder",
			children: new Map(),
		}

		// 1. Create nodes for all directories first
		if (Array.isArray(directories)) {
			for (const rawDir of directories) {
				if (typeof rawDir !== "string") continue
				const parts = rawDir.split(/[\\/]/).filter(Boolean)
				if (parts.length === 0) continue

				let current = root
				let currentPath = ""

				for (let i = 0; i < parts.length; i++) {
					const segment = parts[i]
					currentPath = currentPath ? `${currentPath}/${segment}` : segment

					let folder = current.children.get(segment)
					if (!folder || folder.type !== "folder") {
						folder = {
							type: "folder",
							name: segment,
							path: currentPath,
							children: new Map(),
						}
						current.children.set(segment, folder)
					}
					current = folder
				}
			}
		}

		// 2. Insert nodes for all files
		if (Array.isArray(files)) {
			for (const rawPath of files) {
				if (typeof rawPath !== "string") continue
				const parts = rawPath.split(/[\\/]/).filter(Boolean)
				if (parts.length === 0) continue

				let current = root
				let currentPath = ""

				for (let i = 0; i < parts.length; i++) {
					const segment = parts[i]
					const isFile = i === parts.length - 1
					currentPath = currentPath ? `${currentPath}/${segment}` : segment

					if (isFile) {
						current.children.set(segment, {
							type: "file",
							name: segment,
							path: currentPath,
						})
					} else {
						let folder = current.children.get(segment)
						if (!folder || folder.type !== "folder") {
							folder = {
								type: "folder",
								name: segment,
								path: currentPath,
								children: new Map(),
							}
							current.children.set(segment, folder)
						}
						current = folder
					}
				}
			}
		}

		return root
	}

	function renderTreeNodes(childrenMap, depth = 0, isSearchActive = false) {
		const nodes = Array.from(childrenMap.values())
		nodes.sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === "folder" ? -1 : 1
			}
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
		})

		let html = ""
		for (const node of nodes) {
			if (node.type === "folder") {
				const isExpanded = isSearchActive || expandedFolders.has(node.path)
				const paddingLeft = 8 + depth * 14
				html += `
					<div class="folder-node ${isExpanded ? "expanded" : ""}" data-folder-path="${escapeHtml(node.path)}">
						<div class="folder-header" data-folder-path="${escapeHtml(node.path)}" style="padding-left: ${paddingLeft}px;" title="${escapeHtml(node.path)}">
							<span class="folder-chevron">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
							</span>
							<span class="folder-icon">
								<svg class="icon-folder-closed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
								<svg class="icon-folder-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path></svg>
							</span>
							<span class="folder-name">${escapeHtml(node.name)}</span>
						</div>
						<div class="folder-children">
							${renderTreeNodes(node.children, depth + 1, isSearchActive)}
						</div>
					</div>
				`
			} else {
				const isSelected = selectedPreviewFile === node.path ? "selected" : ""
				const iconInfo = getFileIconInfo(node.path)
				const paddingLeft = 8 + depth * 14 + 19
				html += `
					<div class="file-node ${isSelected}" tabindex="0" role="button" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.path)}" style="padding-left: ${paddingLeft}px;">
						${iconInfo.icon}
						<span class="file-name">${escapeHtml(node.name)}</span>
					</div>
				`
			}
		}
		return html
	}

	function renderFilesTree(arg1, arg2, arg3) {
		let files = null
		let filter = null
		let directories = null

		const args = [arg1, arg2, arg3]
		for (const a of args) {
			if (typeof a === "string" && filter === null) {
				filter = a
			} else if (Array.isArray(a)) {
				if (files === null) {
					files = a
				} else if (directories === null) {
					directories = a
				}
			}
		}

		if (!files) {
			files = currentWorkspace?.files || []
		}
		if (!directories) {
			directories = currentWorkspace?.directories || []
		}
		if (typeof filter !== "string") {
			filter = filesSearchInput?.value || ""
		}

		// Guard against TypeError: ensure files and directories are arrays and filter out non-strings
		if (!Array.isArray(files)) {
			files = []
		}
		if (!Array.isArray(directories)) {
			directories = []
		}
		const validFiles = files.filter((f) => typeof f === "string" && f.trim().length > 0)
		const validDirs = directories.filter((d) => typeof d === "string" && d.trim().length > 0)

		if (currentWorkspace) {
			if (Array.isArray(files)) currentWorkspace.files = validFiles
			if (Array.isArray(directories)) currentWorkspace.directories = validDirs
		}

		if (!filesTreeEl) return

		const searchFilter = (filter || "").trim().toLowerCase()
		const isSearchActive = searchFilter.length > 0

		// Filter files and directories if search is active
		const filteredFiles = isSearchActive
			? validFiles.filter((f) => {
				const normalized = f.replace(/\\/g, "/")
				return normalized.toLowerCase().includes(searchFilter)
			})
			: validFiles

		const filteredDirs = isSearchActive
			? validDirs.filter((d) => {
				const normalized = d.replace(/\\/g, "/")
				return normalized.toLowerCase().includes(searchFilter)
			})
			: validDirs

		if (filteredFiles.length === 0 && filteredDirs.length === 0) {
			if (isSearchActive) {
				filesTreeEl.innerHTML = `
					<div class="empty-state">
						<svg class="empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
						</svg>
						<div class="empty-title">${escapeHtml(tDesktop("noFilesFound"))}</div>
						<div class="empty-subtitle">Spróbuj innej nazwy pliku</div>
					</div>
				`
			} else {
				filesTreeEl.innerHTML = `
					<div class="empty-state">
						<svg class="empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
							<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
						</svg>
						<div class="empty-title">${escapeHtml(currentWorkspace?.path ? tDesktop("noFilesFound") : tDesktop("noWorkspaceOpen"))}</div>
						<div class="empty-subtitle">Folder jest pusty lub jego pliki są pomijane</div>
					</div>
				`
			}
			return
		}

		const treeRoot = buildTree(filteredFiles, filteredDirs)

		// Folders remain collapsed by default on workspace load

		// If there is an active selected preview file, make sure its enclosing folders are expanded
		if (selectedPreviewFile && !isSearchActive) {
			ensureParentFoldersExpanded(selectedPreviewFile)
		}

		filesTreeEl.innerHTML = renderTreeNodes(treeRoot.children, 0, isSearchActive)
	}

	filesTreeEl?.addEventListener("click", async (e) => {
		if (e.target.closest(".file-node") && !await productWorkspace.guardEditor(false)) return
		// 1. Check folder header click
		const folderHeader = e.target.closest(".folder-header")
		if (folderHeader) {
			const folderNode = folderHeader.closest(".folder-node")
			const folderPath = folderHeader.getAttribute("data-folder-path")
			if (folderNode && folderPath) {
				hasUserToggledFolders = true
				const isNowExpanded = folderNode.classList.toggle("expanded")
				if (isNowExpanded) {
					expandedFolders.add(folderPath)
				} else {
					expandedFolders.delete(folderPath)
				}
				saveFolderExpansions()
			}
			return
		}

		// 2. Check file node click
		const fileNode = e.target.closest(".file-node")
		if (fileNode) {
			const rawPath = fileNode.getAttribute("data-path")
			if (!rawPath) return
			const filePath = rawPath.replace(/\\/g, "/")
			selectedPreviewFile = filePath
			filesTreeEl.querySelectorAll(".file-node.selected").forEach((n) => n.classList.remove("selected"))
			fileNode.classList.add("selected")
			if (previewFilenameEl) previewFilenameEl.textContent = filePath
			if (previewContentAreaEl) {
				previewContentAreaEl.innerHTML = `<div class="preview-placeholder"><p>${escapeHtml(tDesktop("loadingFileTree"))}</p></div>`
			}
			sendToServer({ type: "readFile", filePath })
		}
	})

	function renderFilePreview(msg) {
		currentPreviewMsg = msg
		const iconInfo = getFileIconInfo(msg.filePath)

		previewFileIconEl.innerHTML = iconInfo.icon
		previewFilenameEl.textContent = msg.fileName || msg.filePath
		previewFileBadgeEl.textContent = iconInfo.badge
		previewFileBadgeEl.style.display = "inline-block"
		previewFileSizeEl.textContent = msg.size !== undefined ? `• ${formatBytes(msg.size)}` : ""
		previewHeaderActionsEl.style.display = "flex"
		document.getElementById("preview-edit-btn").hidden = !["text","markdown","json","svg"].includes(msg.fileType)

		// Reset view toggles
		previewToggleViewBtn.style.display = msg.fileType === "svg" ? "inline-flex" : "none"
		previewToggleWrapBtn.style.display = (msg.fileType === "text" || msg.fileType === "markdown" || msg.fileType === "json" || msg.fileType === "svg") ? "inline-flex" : "none"

		if (msg.fileType === "image") {
			previewContentAreaEl.innerHTML = `
				<div class="image-preview-stage">
					<div class="image-viewport">
						<div class="image-checkerboard">
							<img src="${msg.content}" class="preview-img" id="preview-img-target" alt="${escapeHtml(msg.fileName || '')}" />
						</div>
					</div>
					<div class="image-meta-bar">
						<span id="img-dim-text">Odczytuję wymiary…</span>
						<span class="meta-sep">•</span>
						<span>${formatBytes(msg.size)}</span>
						<span class="meta-sep">•</span>
						<span>${msg.mimeType || 'image'}</span>
					</div>
				</div>
			`
			const imgEl = document.getElementById("preview-img-target")
			if (imgEl) {
				imgEl.onload = () => {
					const dimEl = document.getElementById("img-dim-text")
					if (dimEl) dimEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight} px`
				}
			}
		} else if (msg.fileType === "svg") {
			isSvgSourceView = false
			renderSvgPreview()
		} else if (msg.fileType === "media") {
			const isVideo = [".mp4", ".webm"].some((ext) => (msg.filePath || "").toLowerCase().endsWith(ext))
			if (isVideo) {
				previewContentAreaEl.innerHTML = `
					<div class="media-preview-container">
						<video controls src="${msg.content}" class="preview-media-video"></video>
					</div>
				`
			} else {
				previewContentAreaEl.innerHTML = `
					<div class="media-preview-container">
						<audio controls src="${msg.content}" class="preview-media-audio"></audio>
					</div>
				`
			}
		} else if (msg.fileType === "pdf") {
			previewContentAreaEl.innerHTML = `
				<embed src="${msg.content}" type="application/pdf" class="preview-pdf-frame" />
			`
		} else if (msg.fileType === "binary") {
			previewContentAreaEl.innerHTML = `
				<div class="binary-preview-card">
					<div class="binary-icon-wrap">${iconInfo.icon}</div>
					<h3 class="binary-title">${escapeHtml(msg.fileName || msg.filePath)}</h3>
					<p class="binary-desc">Plik binarny (${formatBytes(msg.size)}). Jego zawartości nie można wyświetlić jako tekst.</p>
					<div class="binary-actions">
						<button class="binary-open-btn" id="binary-reveal-btn">Pokaż w Eksploratorze</button>
					</div>
				</div>
			`
			document.getElementById("binary-reveal-btn")?.addEventListener("click", () => {
				revealCurrentFile()
			})
		} else {
			// Text / JSON / Markdown
			let textContent = msg.content || ""
			if (msg.fileType === "json") {
				try {
					textContent = JSON.stringify(JSON.parse(textContent), null, 2)
				} catch {}
			}
			renderCodeText(textContent, msg.filePath)
		}
	}

	function renderSvgPreview() {
		if (!currentPreviewMsg) return
		if (isSvgSourceView) {
			renderCodeText(currentPreviewMsg.rawText || "", currentPreviewMsg.filePath)
			previewToggleViewBtn.querySelector("span").textContent = "Podgląd obrazu"
		} else {
			previewToggleViewBtn.querySelector("span").textContent = "Pokaż kod"
			previewContentAreaEl.innerHTML = `
				<div class="image-preview-stage">
					<div class="image-viewport">
						<div class="image-checkerboard">
							<img src="${currentPreviewMsg.content}" class="preview-img" alt="SVG Preview" />
						</div>
					</div>
					<div class="image-meta-bar">
						<span>Vector Graphic</span>
						<span class="meta-sep">•</span>
						<span>${formatBytes(currentPreviewMsg.size)}</span>
						<span class="meta-sep">•</span>
						<span>image/svg+xml</span>
					</div>
				</div>
			`
		}
	}

	const codeHighlightCache = new Map()

	const EXTENSION_MAP = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		json: "json",
		py: "python",
		html: "xml",
		htm: "xml",
		xml: "xml",
		svg: "xml",
		css: "css",
		scss: "scss",
		less: "less",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		ps1: "powershell",
		yaml: "yaml",
		yml: "yaml",
		md: "markdown",
		markdown: "markdown",
		sql: "sql",
		rs: "rust",
		go: "go",
		java: "java",
		c: "c",
		h: "c",
		cpp: "cpp",
		hpp: "cpp",
		cs: "csharp",
		txt: "plaintext",
	}

	function detectLanguage(filePath) {
		if (!filePath) return "plaintext"
		const ext = filePath.split(".").pop()?.toLowerCase() || ""
		return EXTENSION_MAP[ext] || "plaintext"
	}

	function splitHtmlLinesSafely(html) {
		const lines = html.split("\n")
		const result = []
		const openTags = []

		for (const line of lines) {
			let reconstructed = openTags.join("") + line
			const tagRegex = /<\/?([a-zA-Z0-9-]+)(?:\s+[^>]*?)?>/g
			let match
			while ((match = tagRegex.exec(line)) !== null) {
				const fullTag = match[0]
				if (fullTag.startsWith("</")) {
					openTags.pop()
				} else if (!fullTag.endsWith("/>")) {
					openTags.push(fullTag)
				}
			}
			for (let i = openTags.length - 1; i >= 0; i--) {
				const tagMatch = /<([a-zA-Z0-9-]+)/.exec(openTags[i])
				if (tagMatch) {
					reconstructed += `</${tagMatch[1]}>`
				}
			}
			result.push(reconstructed)
		}
		return result
	}

	function renderCodeText(text, filePath) {
		const targetPath = filePath || currentPreviewMsg?.filePath || ""
		const lang = detectLanguage(targetPath)
		const wrapClass = isCodeWrapped ? "wrapped" : ""
		const isLarge = text.length > 500 * 1024 || text.split("\n").length > 10000

		// Check memory LRU cache
		const cacheKey = `${targetPath}:${text.length}:${text.slice(0, 100)}`
		let highlightedLines = codeHighlightCache.get(cacheKey)

		if (!highlightedLines) {
			if (window.hljs && lang !== "plaintext" && !isLarge) {
				try {
					const highlighted = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
					highlightedLines = splitHtmlLinesSafely(highlighted)
				} catch (err) {
					console.warn("[CodeViewer] Highlighting fallback to plain text:", err)
					highlightedLines = text.split("\n").map((l) => escapeHtml(l) || "&nbsp;")
				}
			} else {
				highlightedLines = text.split("\n").map((l) => escapeHtml(l) || "&nbsp;")
			}
			codeHighlightCache.set(cacheKey, highlightedLines)
			if (codeHighlightCache.size > 50) {
				const oldestKey = codeHighlightCache.keys().next().value
				codeHighlightCache.delete(oldestKey)
			}
		}

		let linesHtml = ""
		for (let i = 0; i < highlightedLines.length; i++) {
			const lineNum = i + 1
			const lineContent = highlightedLines[i] || "&nbsp;"
			linesHtml += `<div class="code-line"><span class="code-line-num">${lineNum}</span><span class="code-line-text">${lineContent}</span></div>`
		}

		const largeWarningHtml = isLarge
			? `<div style="padding: 6px 14px; background: rgba(245, 158, 11, 0.1); border-bottom: 1px solid rgba(245, 158, 11, 0.2); font-size: 11px; color: #f59e0b;">Large file (>500KB or >10k lines): syntax highlighting disabled for performance</div>`
			: ""

		previewContentAreaEl.innerHTML = `
			${largeWarningHtml}
			<div class="code-editor-view ${wrapClass}" id="code-editor-view">
				${linesHtml}
			</div>
		`
	}

	function revealCurrentFile() {
		if (!selectedPreviewFile) return
		if (desktopBridge?.shell?.showItemInFolder) {
			desktopBridge.shell.showItemInFolder(selectedPreviewFile)
		} else if (window.__desktopAPI?.showItemInFolder) {
			window.__desktopAPI.showItemInFolder(selectedPreviewFile)
		} else {
			sendToServer({ type: "showItem", filePath: selectedPreviewFile })
		}
	}

	// Preview Header Actions
	previewCopyBtn?.addEventListener("click", () => {
		if (!currentPreviewMsg) return
		let textToCopy = ""
		if (currentPreviewMsg.fileType === "image" || currentPreviewMsg.fileType === "media" || currentPreviewMsg.fileType === "pdf") {
			textToCopy = currentPreviewMsg.filePath
		} else if (currentPreviewMsg.fileType === "svg" && currentPreviewMsg.rawText) {
			textToCopy = currentPreviewMsg.rawText
		} else {
			textToCopy = currentPreviewMsg.content || currentPreviewMsg.filePath
		}
		navigator.clipboard.writeText(textToCopy).then(() => {
			const label = previewCopyBtn.querySelector("span")
			if (label) {
				const orig = label.textContent
				label.textContent = "Skopiowano"
				setTimeout(() => { label.textContent = orig }, 1500)
			}
		})
	})

	previewToggleWrapBtn?.addEventListener("click", () => {
		isCodeWrapped = !isCodeWrapped
		previewToggleWrapBtn.classList.toggle("active", isCodeWrapped)
		const view = document.getElementById("code-editor-view")
		if (view) {
			view.classList.toggle("wrapped", isCodeWrapped)
		}
	})

	previewToggleViewBtn?.addEventListener("click", () => {
		isSvgSourceView = !isSvgSourceView
		renderSvgPreview()
	})

	previewOpenExternalBtn?.addEventListener("click", () => {
		revealCurrentFile()
	})

	function escapeHtml(text) {
		return String(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;")
	}

	// ==========================================
	// Provider Presets & Quick API Configuration
	// ==========================================
	const PROVIDER_PRESETS = {
		xkiro: {
			name: "xKiro",
			defaultBaseUrl: "https://api.xkiro.com/v1",
			defaultModel: "deepseek/deepseek-chat",
			showBaseUrl: true,
			baseUrlHint: "Domyślny adres xKiro: https://api.xkiro.com/v1",
			keyHint: 'Klucz xKiro uzyskasz na <a href="https://xkiro.com" target="_blank" class="link-accent">xkiro.com</a>.',
			keyPlaceholder: "Wpisz klucz API xKiro…",
			models: [
				{ id: "deepseek/deepseek-chat", label: "xKiro DeepSeek-V3" },
				{ id: "deepseek/deepseek-reasoner", label: "xKiro DeepSeek-R1" },
				{ id: "anthropic/claude-3.7-sonnet", label: "xKiro Claude 3.7 Sonnet" },
				{ id: "anthropic/claude-3.5-sonnet", label: "xKiro Claude 3.5 Sonnet" },
				{ id: "openai/gpt-4o", label: "xKiro GPT-4o" },
				{ id: "openai/o1", label: "xKiro o1" },
				{ id: "openai/o3-mini", label: "xKiro o3-mini" },
				{ id: "google/gemini-2.5-pro", label: "xKiro Gemini 2.5 Pro" },
				{ id: "google/gemini-2.5-flash", label: "xKiro Gemini 2.5 Flash" },
				{ id: "qwen/qwen-2.5-coder-32b", label: "xKiro Qwen 2.5 Coder 32B" },
			],
		},
		openrouter: {
			name: "OpenRouter",
			defaultBaseUrl: "https://openrouter.ai/api/v1",
			defaultModel: "anthropic/claude-3.7-sonnet",
			showBaseUrl: false,
			baseUrlHint: "Domyślny adres OpenRouter: https://openrouter.ai/api/v1",
			keyHint: 'Klucz uzyskasz w <a href="https://openrouter.ai/keys" target="_blank" class="link-accent">openrouter.ai/keys</a>',
			keyPlaceholder: "sk-or-v1-...",
			models: [
				{ id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet" },
				{ id: "deepseek/deepseek-chat", label: "DeepSeek V3" },
				{ id: "deepseek/deepseek-r1", label: "DeepSeek R1" },
				{ id: "openai/gpt-4o", label: "GPT-4o" },
				{ id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
			],
		},
		anthropic: {
			name: "Anthropic",
			defaultBaseUrl: "",
			defaultModel: "claude-3-7-sonnet-20250219",
			showBaseUrl: false,
			baseUrlHint: "Oficjalny adres API Anthropic",
			keyHint: "Klucz uzyskasz w Anthropic Console (sk-ant-...)",
			keyPlaceholder: "sk-ant-api03-...",
			models: [
				{ id: "claude-3-7-sonnet-20250219", label: "Claude 3.7 Sonnet" },
				{ id: "claude-3-5-sonnet-20241022", label: "Claude 3.5 Sonnet v2" },
				{ id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
			],
		},
		openai: {
			name: "OpenAI",
			defaultBaseUrl: "",
			defaultModel: "gpt-4o",
			showBaseUrl: false,
			baseUrlHint: "Oficjalny adres API OpenAI",
			keyHint: "Klucz uzyskasz w OpenAI Platform (sk-...)",
			keyPlaceholder: "sk-...",
			models: [
				{ id: "gpt-4o", label: "GPT-4o" },
				{ id: "gpt-4o-mini", label: "GPT-4o Mini" },
				{ id: "o3-mini", label: "o3-mini" },
			],
		},
		gemini: {
			name: "Google Gemini",
			defaultBaseUrl: "",
			defaultModel: "gemini-2.5-pro",
			showBaseUrl: false,
			baseUrlHint: "Adres Google Generative AI",
			keyHint: "Klucz uzyskasz w Google AI Studio (AIza...)",
			keyPlaceholder: "AIzaSy...",
			models: [
				{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
				{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
				{ id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
			],
		},
		ollama: {
			name: "Ollama",
			defaultBaseUrl: "http://localhost:11434",
			defaultModel: "llama3.1",
			showBaseUrl: true,
			baseUrlHint: "Domyślny adres Ollama: http://localhost:11434",
			keyHint: "Ollama działa lokalnie na Twoim komputerze. Klucz API nie jest wymagany.",
			keyPlaceholder: "(Opcjonalnie)",
			models: [
				{ id: "llama3.1", label: "Llama 3.1" },
				{ id: "qwen2.5-coder:7b", label: "Qwen 2.5 Coder 7B" },
				{ id: "deepseek-r1:8b", label: "DeepSeek R1 8B" },
			],
		},
		"openai-compatible": {
			name: "OpenAI Compatible",
			defaultBaseUrl: "http://localhost:8000/v1",
			defaultModel: "default",
			showBaseUrl: true,
			baseUrlHint: "Wpisz pełny adres API zgodnego z OpenAI (z końcówką /v1)",
			keyHint: "Wpisz klucz API wymagany przez serwer.",
			keyPlaceholder: "Klucz API…",
			models: [],
		},
	}

	function updateApiPill(config) {
		if (!apiPillLabel) return
		if (!config) {
			apiPillLabel.textContent = "Skonfiguruj API"
			return
		}
		const provider = config.apiProvider || "xkiro"
		const model =
			config.xkiroModelId ||
			config.apiModelId ||
			config.openAiModelId ||
			config.openRouterModelId ||
			config.ollamaModelId ||
			""
		const hasKey = !!(
			config.apiKey ||
			config.xkiroApiKey ||
			config.openAiApiKey ||
			config.openRouterApiKey ||
			config.geminiApiKey ||
			provider === "ollama"
		)

		const providerNames = {
			xkiro: "xKiro",
			openrouter: "OpenRouter",
			anthropic: "Anthropic",
			openai: "OpenAI",
			gemini: "Gemini",
			ollama: "Ollama",
		}
		const pName = providerNames[provider] || provider

		let shortModel = ""
		if (model) {
			if (model.includes("deepseek-reasoner") || model.includes("deepseek-r1")) shortModel = "DeepSeek-R1"
			else if (model.includes("deepseek")) shortModel = "DeepSeek"
			else if (model.includes("claude-3-7") || model.includes("claude-3.7")) shortModel = "Claude 3.7"
			else if (model.includes("claude-3-5") || model.includes("claude-3.5")) shortModel = "Claude 3.5"
			else if (model.includes("gpt-4o-mini")) shortModel = "GPT-4o mini"
			else if (model.includes("gpt-4o")) shortModel = "GPT-4o"
			else if (model.includes("gemini-2.5")) shortModel = "Gemini 2.5"
			else if (model.includes("qwen")) shortModel = "Qwen"
			else shortModel = model.split("/").pop().split(":")[0]
		}

		if (!hasKey) {
			apiPillLabel.textContent = `API: ${pName} (brak klucza)`
		} else if (shortModel) {
			apiPillLabel.textContent = `API: ${pName} (${shortModel})`
		} else {
			apiPillLabel.textContent = `API: ${pName}`
		}
	}

	let currentSettingsSection = "providers"

	function prewarmSettingsFrame() {
		if (settingsWebviewFrame && (!settingsWebviewFrame.getAttribute("src") || settingsWebviewFrame.getAttribute("src") === "")) {
			const theme = localStorage.getItem("roo-theme") || "linear-dark"
			settingsWebviewFrame.addEventListener("load", () => {
				try {
					settingsWebviewFrame.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
					settingsWebviewFrame.contentWindow?.postMessage({ type: "languageChange", language: currentLanguage }, "*")
					if (latestExtensionState) {
						settingsWebviewFrame.contentWindow?.postMessage({ type: "state", state: latestExtensionState }, "*")
					}
					settingsWebviewFrame.contentWindow?.postMessage({
						type: "switchTab",
						tab: "settings",
						origin: "sync",
						values: { section: "providers" },
					}, "*")
				} catch {}
			}, { once: true })
			settingsWebviewFrame.src = "/webview/index.html?view=settings"
		}
	}

	function openSettingsModal(section = "providers") {
		if (section) {
			currentSettingsSection = section
		}
		if (!settingsModalBackdrop) return
		settingsModalBackdrop.classList.remove("hidden")

		if (settingsWebviewFrame) {
			const theme = localStorage.getItem("roo-theme") || "linear-dark"
			const sendInitSettings = () => {
				try {
					settingsWebviewFrame.contentWindow?.postMessage({ type: "themeChange", theme }, "*")
					settingsWebviewFrame.contentWindow?.postMessage({ type: "languageChange", language: currentLanguage }, "*")
					if (latestExtensionState) {
						settingsWebviewFrame.contentWindow?.postMessage({ type: "state", state: latestExtensionState }, "*")
					}
					settingsWebviewFrame.contentWindow?.postMessage({
						type: "switchTab",
						tab: "settings",
						origin: "sync",
						values: { section: currentSettingsSection || "providers" },
					}, "*")
				} catch (err) {
					console.warn("[SettingsModal] Failed to post init message to settings frame:", err)
				}
			}

			if (!settingsWebviewFrame.getAttribute("src") || settingsWebviewFrame.getAttribute("src") === "") {
				settingsWebviewFrame.addEventListener("load", () => {
					sendInitSettings()
				}, { once: true })
				settingsWebviewFrame.src = "/webview/index.html?view=settings"
			} else {
				sendInitSettings()
			}
		}
	}

	function closeSettingsModal(confirmed = false) {
		if (confirmed !== true && settingsWebviewFrame?.contentWindow && !settingsModalBackdrop?.classList.contains("hidden")) { settingsWebviewFrame.contentWindow.postMessage({type:"productCloseSettings"},"*"); return }
		if (!settingsModalBackdrop) return
		settingsModalBackdrop.classList.add("hidden")
		const savedTheme = localStorage.getItem("roo-theme") || "linear-dark"
		applyDesktopTheme(savedTheme, false)
	}

	function openSettingsTab() {
		openSettingsModal()
	}

	function openApiModal() {
		if (!apiModalBackdrop) return
		apiModalBackdrop.style.display = "flex"
		populateApiModalFromConfig(currentApiConfig)
	}

	function closeApiModal() {
		if (!apiModalBackdrop) return
		apiModalBackdrop.style.display = "none"
	}

	function populateApiModalFromConfig(config) {
		let provider = config?.apiProvider || "xkiro"
		if (provider === "openai" && config?.openAiBaseUrl && !config.openAiBaseUrl.includes("openai.com")) {
			provider = "openai-compatible"
		}
		if (!PROVIDER_PRESETS[provider]) {
			provider = "xkiro"
		}

		if (apiProviderSelect) {
			apiProviderSelect.value = provider
		}
		updateModalFieldsForProvider(provider)

		if (config) {
			const key =
				config.xkiroApiKey ||
				config.apiKey ||
				config.openAiApiKey ||
				config.openRouterApiKey ||
				config.geminiApiKey ||
				""
			if (key && apiKeyInput) apiKeyInput.value = key

			const baseUrl =
				config.xkiroBaseUrl ||
				config.openAiBaseUrl ||
				config.ollamaBaseUrl ||
				config.openRouterBaseUrl ||
				""
			if (baseUrl && apiBaseUrlInput) apiBaseUrlInput.value = baseUrl

			const model =
				config.xkiroModelId ||
				config.apiModelId ||
				config.openAiModelId ||
				config.openRouterModelId ||
				config.ollamaModelId ||
				""
			if (model && apiModelInput) apiModelInput.value = model
		}
	}

	function updateModalFieldsForProvider(providerKey) {
		const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.xkiro
		if (groupBaseUrl) {
			groupBaseUrl.style.display = preset.showBaseUrl ? "block" : "none"
		}
		if (baseUrlHint) {
			baseUrlHint.innerHTML = preset.baseUrlHint
		}
		if (apiKeyHint) {
			apiKeyHint.innerHTML = preset.keyHint
		}
		if (apiKeyInput) {
			apiKeyInput.placeholder = preset.keyPlaceholder
			let key = ""
			if (providerKey === "xkiro") key = currentApiConfig?.xkiroApiKey || (currentApiConfig?.apiProvider === "xkiro" ? currentApiConfig?.apiKey : "") || ""
			else if (providerKey === "openrouter") key = currentApiConfig?.openRouterApiKey || (currentApiConfig?.apiProvider === "openrouter" ? currentApiConfig?.apiKey : "") || ""
			else if (providerKey === "anthropic") key = (currentApiConfig?.apiProvider === "anthropic" ? currentApiConfig?.apiKey : "") || ""
			else if (providerKey === "openai" || providerKey === "openai-compatible") key = currentApiConfig?.openAiApiKey || (currentApiConfig?.apiProvider === "openai" ? currentApiConfig?.apiKey : "") || ""
			else if (providerKey === "gemini") key = currentApiConfig?.geminiApiKey || (currentApiConfig?.apiProvider === "gemini" ? currentApiConfig?.apiKey : "") || ""
			else if (providerKey === "ollama") key = currentApiConfig?.ollamaApiKey || ""
			apiKeyInput.value = key
		}
		if (apiBaseUrlInput && (!apiBaseUrlInput.value || (groupBaseUrl && groupBaseUrl.style.display !== "none"))) {
			apiBaseUrlInput.value = preset.defaultBaseUrl
		}
		if (apiModelInput && (!apiModelInput.value || !preset.models.some((m) => m.id === apiModelInput.value))) {
			apiModelInput.value = preset.defaultModel
		}

		// Populate datalist options
		if (modelSuggestions) {
			modelSuggestions.innerHTML = preset.models
				.map((m) => `<option value="${m.id}">${m.label}</option>`)
				.join("")
		}
	}

	function saveApiConfig() {
		const provider = apiProviderSelect ? apiProviderSelect.value : "xkiro"
		const baseUrl = apiBaseUrlInput ? apiBaseUrlInput.value.trim() : ""
		const apiKey = apiKeyInput ? apiKeyInput.value.trim() : ""
		const model = apiModelInput ? apiModelInput.value.trim() : ""

		let newConfig = {
			apiProvider: provider === "openai-compatible" ? "openai" : provider,
		}

		if (provider === "xkiro") {
			newConfig.apiKey = apiKey
			newConfig.xkiroApiKey = apiKey
			newConfig.xkiroBaseUrl = baseUrl || "https://api.xkiro.com/v1"
			newConfig.xkiroModelId = model || "deepseek/deepseek-chat"
			newConfig.openAiBaseUrl = baseUrl || "https://api.xkiro.com/v1"
			newConfig.openAiApiKey = apiKey
			newConfig.openAiModelId = model || "deepseek/deepseek-chat"
			newConfig.apiModelId = model || "deepseek/deepseek-chat"
		} else if (provider === "openrouter") {
			newConfig.apiKey = apiKey
			newConfig.openRouterApiKey = apiKey
			newConfig.openRouterModelId = model || "anthropic/claude-3.7-sonnet"
			newConfig.apiModelId = model || "anthropic/claude-3.7-sonnet"
			if (baseUrl) newConfig.openRouterBaseUrl = baseUrl
		} else if (provider === "anthropic") {
			newConfig.apiKey = apiKey
			newConfig.apiModelId = model || "claude-3-7-sonnet-20250219"
			if (baseUrl) newConfig.anthropicBaseUrl = baseUrl
		} else if (provider === "openai" || provider === "openai-compatible") {
			newConfig.apiKey = apiKey
			newConfig.openAiApiKey = apiKey
			newConfig.openAiModelId = model || "gpt-4o"
			newConfig.apiModelId = model || "gpt-4o"
			if (baseUrl) newConfig.openAiBaseUrl = baseUrl
		} else if (provider === "gemini") {
			newConfig.apiKey = apiKey
			newConfig.geminiApiKey = apiKey
			newConfig.apiModelId = model || "gemini-2.5-pro"
		} else if (provider === "ollama") {
			newConfig.ollamaBaseUrl = baseUrl || "http://localhost:11434"
			newConfig.ollamaModelId = model || "llama3.1"
			newConfig.apiModelId = model || "llama3.1"
			if (apiKey) newConfig.ollamaApiKey = apiKey
		}

		currentApiConfig = { ...currentApiConfig, ...newConfig }
		localStorage.setItem("roo-quick-api-config", JSON.stringify(currentApiConfig))

		// Send to server / extension
		sendToServer({
			type: "webviewMessage",
			message: {
				type: "upsertApiConfiguration",
				text: currentApiProfileName || "default",
				apiConfiguration: currentApiConfig,
			},
		})

		// Also forward to webview iframe so it updates state immediately
		forwardToWebview({
			type: "state",
			state: {
				apiConfiguration: currentApiConfig,
			},
		})

		updateApiPill(currentApiConfig)
		closeApiModal()
	}

	// Attach Settings & API Listeners
	openSettingsBtn?.addEventListener("click", () => openSettingsModal("providers"))
	settingsOpenBtn?.addEventListener("click", () => openSettingsModal("providers"))
	closeSettingsModalBtn?.addEventListener("click", closeSettingsModal)
	settingsModalBackdrop?.addEventListener("click", (e) => {
		if (e.target === settingsModalBackdrop) {
			closeSettingsModal()
		}
	})
	openFullSettingsFromModalBtn?.addEventListener("click", () => {
		closeApiModal()
		openSettingsModal("providers")
	})

	quickApiBtn?.addEventListener("click", openApiModal)
	closeApiModalBtn?.addEventListener("click", closeApiModal)
	cancelApiModalBtn?.addEventListener("click", closeApiModal)
	saveApiConfigBtn?.addEventListener("click", saveApiConfig)


	apiProviderSelect?.addEventListener("change", (e) => {
		updateModalFieldsForProvider(e.target.value)
	})

	toggleKeyVisibilityBtn?.addEventListener("click", () => {
		if (!apiKeyInput) return
		if (apiKeyInput.type === "password") {
			apiKeyInput.type = "text"
			toggleKeyVisibilityBtn.textContent = "🙈"
		} else {
			apiKeyInput.type = "password"
			toggleKeyVisibilityBtn.textContent = "👁️"
		}
	})

	apiModalBackdrop?.addEventListener("click", (e) => {
		if (e.target === apiModalBackdrop) {
			closeApiModal()
		}
	})

	// Confirmation Modal Listeners
	confirmationModalConfirmBtn?.addEventListener("click", () => {
		const action = confirmationAction
		closeConfirmationModal()
		if (typeof action === "function") {
			action()
		}
	})
	confirmationModalCancelBtn?.addEventListener("click", closeConfirmationModal)
	confirmationModalCloseBtn?.addEventListener("click", closeConfirmationModal)
	confirmationModalBackdrop?.addEventListener("click", (e) => {
		if (e.target === confirmationModalBackdrop) {
			closeConfirmationModal()
		}
	})
	confirmationModalBackdrop?.addEventListener("keydown", (e) => {
		if (e.key === "Tab") {
			const focusableEls = [
				confirmationModalCloseBtn,
				confirmationModalCancelBtn,
				confirmationModalConfirmBtn,
			].filter((el) => el && !el.disabled && el.offsetParent !== null)

			if (focusableEls.length === 0) return

			const firstEl = focusableEls[0]
			const lastEl = focusableEls[focusableEls.length - 1]

			if (e.shiftKey) {
				if (document.activeElement === firstEl) {
					e.preventDefault()
					lastEl.focus()
				}
			} else {
				if (document.activeElement === lastEl) {
					e.preventDefault()
					firstEl.focus()
				}
			}
		}
	})

	// Context Menu Dismissals
	document.addEventListener("click", (e) => {
		if (sidebarContextMenuEl && !sidebarContextMenuEl.classList.contains("hidden")) {
			if (!sidebarContextMenuEl.contains(e.target) && !e.target.closest("[data-action='chat-menu'], [data-action='project-menu'], #sidebar-add-project-btn")) {
				closeSidebarContextMenu()
			}
		}
	})
	window.addEventListener("resize", () => {
		closeSidebarContextMenu()
	})
	window.addEventListener("scroll", () => {
		closeSidebarContextMenu()
	}, true)

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			if (sidebarContextMenuEl && !sidebarContextMenuEl.classList.contains("hidden")) {
				closeSidebarContextMenu()
				return
			}
			if (confirmationModalBackdrop && !confirmationModalBackdrop.classList.contains("hidden")) {
				closeConfirmationModal()
				return
			}
			if (settingsModalBackdrop && !settingsModalBackdrop.classList.contains("hidden")) {
				closeSettingsModal()
				return
			}
			if (apiModalBackdrop && apiModalBackdrop.style.display === "flex") {
				closeApiModal()
			}
		}
	})

	// Initial pill sync
	updateApiPill(currentApiConfig)


	function applySidebarSearch() {
		const query = (document.getElementById("workspace-project-search")?.value || "").trim().toLocaleLowerCase()
		chatSearchFilter = query
		renderChatSidebar()
		sidebarProjectsListEl?.classList.toggle("is-searching", !!query)
		for (const project of sidebarProjectsListEl?.querySelectorAll(".sidebar-project-item") || []) {
			const heading = (project.querySelector(".project-header")?.textContent || "") + " " + (project.dataset.workspace || "")
			const projectMatches = heading.toLocaleLowerCase().includes(query)
			let matchingChats = 0
			for (const chat of project.querySelectorAll(".sidebar-chat-item")) { const match = !query || projectMatches || chat.textContent.toLocaleLowerCase().includes(query); chat.hidden = !match; if(match) matchingChats++ }
			project.hidden = !!query && !projectMatches && !matchingChats
		}
	}
	function createConversation(workspace) { return currentDesktopTab === "native-chat" ? createNewChatSession() : startNewChat(workspace) }
	const productWorkspace = window.ProductWorkspace.install({
		workspace:()=>currentWorkspace, sidebar:()=>sidebarData, projectPaths:getAuthoritativeWorkspacesList, projectName:getProjectDisplayName,
		projectMenu:openProjectContextMenu, selectProject:selectWorkspaceFolder, refresh:fetchSidebarData,
		quickProject:handleCreateQuickProject, newChat:createConversation, isNativeChat:()=>currentDesktopTab === "native-chat", tab:switchDesktopTab,
		settings:()=>openSettingsModal("providers"), forward:forwardToWebview,
		selectedFile:()=>selectedPreviewFile, searchSidebar:applySidebarSearch,
		preview:file=>{selectedPreviewFile=file;sendToServer({type:"readFile",filePath:file})},
		refreshFiles:loadWorkspaceFiles,
		t: tDesktop,
		lang: () => currentLanguage,
	})
	productWorkspace.update()
	filesTreeEl?.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){const row=event.target.closest(".file-node");if(row){event.preventDefault();row.click()}}})
	document.addEventListener("keydown",async event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="n"){event.preventDefault();if(await productWorkspace.guardEditor()) await createConversation(currentWorkspace?.path)}})
	// Protect project switches and window tools while editing.
	for (const tab of document.querySelectorAll(".nav-tab")) tab.addEventListener("click", async event=>{
		if(!productWorkspace.isEditing())return
		event.stopImmediatePropagation();event.preventDefault()
		if(await productWorkspace.guardEditor())switchDesktopTab(tab.dataset.tab)
	},true)

	// Initialize
	isDesktopAppInitialized = true
	renderSidebar()
	connectWebSocket()
	loadWorkspaceFiles()
	fetchSidebarData()
	// Memory optimization: do not prewarm settings frame on startup to prevent running two heavy React apps concurrently.
	// The settings iframe is lazily loaded when the user opens settings or hovers over the settings button.
	openSettingsBtn?.addEventListener("pointerenter", prewarmSettingsFrame, { once: true })
})()
