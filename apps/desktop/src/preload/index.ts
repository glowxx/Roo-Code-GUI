import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("__desktopAPI", {
	isElectron: true,
	platform: process.platform,
	selectFolder: () => ipcRenderer.invoke("desktop:select-folder"),
	pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
	createQuickProject: () => ipcRenderer.invoke("desktop:create-quick-project"),
	showItemInFolder: (filePath: string) => ipcRenderer.invoke("desktop:show-item", filePath),
	openPath: (filePath: string) => ipcRenderer.invoke("desktop:open-path", filePath),
	sendToExtension: (message: unknown) => ipcRenderer.send("desktop:message-to-extension", message),
	minimize: () => ipcRenderer.send("desktop:window-minimize"),
	maximize: () => ipcRenderer.send("desktop:window-maximize"),
	close: () => ipcRenderer.send("desktop:window-close"),
	onExtensionMessage: (callback: (message: unknown) => void) => {
		const listener = (_event: unknown, message: unknown) => callback(message)
		ipcRenderer.on("desktop:message-from-extension", listener)
		return () => ipcRenderer.removeListener("desktop:message-from-extension", listener)
	},
})
