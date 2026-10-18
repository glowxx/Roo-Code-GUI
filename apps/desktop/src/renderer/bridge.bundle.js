"use strict";
var DesktopBridgeModule = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // apps/desktop/src/renderer/bridge/index.ts
  var index_exports = {};
  __export(index_exports, {
    ElectronBridge: () => ElectronBridge,
    TauriBridge: () => TauriBridge,
    WebSocketBridge: () => WebSocketBridge,
    getDesktopBridge: () => getDesktopBridge
  });

  // apps/desktop/src/renderer/bridge/electron-bridge.ts
  var ElectronBridge = class {
    constructor(sendSocketFn) {
      __publicField(this, "capabilities");
      __publicField(this, "window", {
        minimize: async () => {
          window.__desktopAPI?.minimize?.();
        },
        maximize: async () => {
          window.__desktopAPI?.maximize?.();
        },
        close: async () => {
          window.__desktopAPI?.close?.();
        },
        isMaximized: async () => {
          return false;
        },
        startDragging: async () => {
        }
      });
      __publicField(this, "shell", {
        selectFolder: async () => {
          if (window.__desktopAPI?.selectFolder) {
            return await window.__desktopAPI.selectFolder();
          }
          return null;
        },
        createQuickProject: async () => {
          if (window.__desktopAPI?.createQuickProject) {
            return await window.__desktopAPI.createQuickProject();
          }
          return null;
        },
        openPath: async (filePath) => {
          if (window.__desktopAPI?.openPath) {
            return await window.__desktopAPI.openPath(filePath);
          }
          return false;
        },
        showItemInFolder: async (filePath) => {
          if (window.__desktopAPI?.showItemInFolder) {
            return await window.__desktopAPI.showItemInFolder(filePath);
          }
          return false;
        },
        openExternal: async (url) => {
          if (window.__desktopAPI?.openPath) {
            await window.__desktopAPI.openPath(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }
      });
      __publicField(this, "clipboard", {
        readText: async () => {
          return await navigator.clipboard.readText();
        },
        writeText: async (text) => {
          await navigator.clipboard.writeText(text);
        }
      });
      __publicField(this, "ipc");
      const api = window.__desktopAPI;
      const platform = api?.platform || "win32";
      this.capabilities = {
        runtime: "electron",
        platform,
        isNative: true
      };
      this.ipc = {
        send: (msg) => {
          if (msg.type === "webviewMessage" && api?.sendToExtension) {
            api.sendToExtension(msg.message);
          } else if (sendSocketFn) {
            sendSocketFn(msg);
          }
        },
        onMessage: (callback) => {
          if (api?.onExtensionMessage) {
            return api.onExtensionMessage((msg) => {
              callback(msg);
            });
          }
          return () => {
          };
        },
        invoke: async (_channel, _payload) => {
          throw new Error("Generic invoke not implemented in legacy Electron bridge");
        }
      };
    }
  };

  // apps/desktop/src/renderer/bridge/tauri-bridge.ts
  function getTauriInvoke() {
    if (typeof window === "undefined") return null;
    const tauri = window.__TAURI__;
    if (typeof tauri?.core?.invoke === "function") {
      return (cmd, args) => tauri.core.invoke(cmd, args);
    }
    if (typeof tauri?.invoke === "function") {
      return (cmd, args) => tauri.invoke(cmd, args);
    }
    const internals = window.__TAURI_INTERNALS__;
    if (typeof internals?.invoke === "function") {
      return (cmd, args) => internals.invoke(cmd, args);
    }
    return null;
  }
  function getTauriEvent() {
    if (typeof window === "undefined") return null;
    const tauri = window.__TAURI__;
    if (tauri?.event?.listen) {
      return tauri.event;
    }
    return null;
  }
  var TauriBridge = class {
    constructor(sendSocketFallback) {
      __publicField(this, "capabilities");
      __publicField(this, "window", {
        minimize: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            await invoke("desktop_window_minimize");
          }
        },
        maximize: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            await invoke("desktop_window_maximize");
          }
        },
        close: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            await invoke("desktop_window_close");
          }
        },
        isMaximized: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            return await invoke("desktop_window_is_maximized");
          }
          return false;
        },
        startDragging: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            await invoke("desktop_window_start_dragging");
          }
        }
      });
      __publicField(this, "shell", {
        selectFolder: async (options) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            return await invoke("desktop_select_folder", {
              defaultPath: options?.defaultPath
            });
          }
          return null;
        },
        createQuickProject: async () => null,
        openPath: async (filePath) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            return await invoke("desktop_open_path", { filePath });
          }
          return false;
        },
        showItemInFolder: async (filePath) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            return await invoke("desktop_show_item_in_folder", { filePath });
          }
          return false;
        },
        openExternal: async (url) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            await invoke("desktop_open_external", { url });
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }
      });
      __publicField(this, "clipboard", {
        readText: async () => {
          const invoke = getTauriInvoke();
          if (invoke) {
            try {
              return await invoke("desktop_clipboard_read");
            } catch (err) {
              console.warn("[TauriBridge] Native clipboard read failed, falling back to navigator:", err);
            }
          }
          return await navigator.clipboard.readText();
        },
        writeText: async (text) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            try {
              await invoke("desktop_clipboard_write", { text });
              return;
            } catch (err) {
              console.warn("[TauriBridge] Native clipboard write failed, falling back to navigator:", err);
            }
          }
          await navigator.clipboard.writeText(text);
        }
      });
      __publicField(this, "ipc");
      this.capabilities = {
        runtime: "tauri",
        platform: "win32",
        isNative: true
      };
      this.ipc = {
        send: (msg) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            invoke("desktop_client_message", { message: msg }).catch((err) => {
              console.error("[TauriBridge] Failed to send client message:", err);
            });
          }
          if (sendSocketFallback) {
            sendSocketFallback(msg);
          }
        },
        onMessage: (callback) => {
          const event = getTauriEvent();
          if (event?.listen) {
            let unlistenFn = null;
            event.listen("desktop-server-message", (ev) => {
              callback(ev.payload);
            }).then((unlisten) => {
              unlistenFn = unlisten;
            }).catch((err) => {
              console.error("[TauriBridge] Failed to listen to desktop-server-message:", err);
            });
            return () => {
              unlistenFn?.();
            };
          }
          return () => {
          };
        },
        invoke: async (channel, payload) => {
          const invoke = getTauriInvoke();
          if (invoke) {
            return await invoke(channel, payload);
          }
          throw new Error(`[TauriBridge] Cannot invoke ${channel} - Tauri invoke not available`);
        }
      };
    }
  };

  // apps/desktop/src/renderer/bridge/websocket-bridge.ts
  var WebSocketBridge = class {
    constructor(sendSocketFn) {
      __publicField(this, "capabilities", {
        runtime: "web",
        platform: "web",
        isNative: false
      });
      __publicField(this, "window", {
        minimize: async () => {
        },
        maximize: async () => {
        },
        close: async () => {
        },
        isMaximized: async () => false,
        startDragging: async () => {
        }
      });
      __publicField(this, "shell", {
        selectFolder: async () => null,
        createQuickProject: async () => null,
        openPath: async () => false,
        showItemInFolder: async () => false,
        openExternal: async (url) => {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      });
      __publicField(this, "clipboard", {
        readText: async () => {
          return await navigator.clipboard.readText();
        },
        writeText: async (text) => {
          await navigator.clipboard.writeText(text);
        }
      });
      __publicField(this, "ipc");
      this.ipc = {
        send: (msg) => {
          sendSocketFn?.(msg);
        },
        onMessage: () => () => {
        },
        invoke: async () => {
          throw new Error("Invoke not supported on pure WebSocket bridge");
        }
      };
    }
  };

  // apps/desktop/src/renderer/bridge/index.ts
  var activeBridge = null;
  function getDesktopBridge(sendSocketFallback) {
    if (activeBridge) return activeBridge;
    if (typeof window !== "undefined" && (window.__TAURI__ || window.__TAURI_INTERNALS__)) {
      activeBridge = new TauriBridge(sendSocketFallback);
      return activeBridge;
    }
    if (typeof window !== "undefined" && window.__desktopAPI?.isElectron) {
      activeBridge = new ElectronBridge(sendSocketFallback);
      return activeBridge;
    }
    activeBridge = new WebSocketBridge(sendSocketFallback);
    return activeBridge;
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=bridge.bundle.js.map
