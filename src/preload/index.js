import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const deviceApi = {
  listSerialPorts: () => ipcRenderer.invoke('device:list-serial-ports'),
  openSerialPort: (options) => ipcRenderer.invoke('device:open-serial-port', options),
  closeSerialPort: () => ipcRenderer.invoke('device:close-serial-port'),
  getNetworkInterfaces: () => ipcRenderer.invoke('device:get-network-interfaces'),
  scanNetworkDevices: (options) => ipcRenderer.invoke('device:scan-network-devices', options),
  connectNetworkDevice: (options) => ipcRenderer.invoke('device:connect-network-device', options),
  disconnectNetworkDevice: () => ipcRenderer.invoke('device:disconnect-network-device'),
  appendChannelSamples: (payload) => ipcRenderer.invoke('device:append-channel-samples', payload),
  getDefaultLogDirectory: () => ipcRenderer.invoke('device:get-default-log-directory'),
  chooseLogDirectory: (defaultPath) => ipcRenderer.invoke('device:choose-log-directory', defaultPath)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('deviceApi', deviceApi)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.deviceApi = deviceApi
}
