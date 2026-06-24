import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const deviceApi = {
  listSerialPorts: () => ipcRenderer.invoke('device:list-serial-ports'),
  openSerialPort: (options) => ipcRenderer.invoke('device:open-serial-port', options),
  closeSerialPort: () => ipcRenderer.invoke('device:close-serial-port'),
  onSerialFrame: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('device:serial-frame', listener)
    return () => ipcRenderer.removeListener('device:serial-frame', listener)
  },
  sendSerialCommand: (options) => ipcRenderer.invoke('device:send-serial-command', options),
  sendTcpCommand: (options) => ipcRenderer.invoke('device:send-tcp-command', options),
  onSerialProtocol: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('device:serial-protocol', listener)
    return () => ipcRenderer.removeListener('device:serial-protocol', listener)
  },
  onSerialDebug: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('device:serial-debug', listener)
    return () => ipcRenderer.removeListener('device:serial-debug', listener)
  },
  onTcpProtocol: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('device:tcp-protocol', listener)
    return () => ipcRenderer.removeListener('device:tcp-protocol', listener)
  },
  onTcpDebug: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('device:tcp-debug', listener)
    return () => ipcRenderer.removeListener('device:tcp-debug', listener)
  },
  getNetworkInterfaces: () => ipcRenderer.invoke('device:get-network-interfaces'),
  scanNetworkDevices: (options) => ipcRenderer.invoke('device:scan-network-devices', options),
  connectNetworkDevice: (options) => ipcRenderer.invoke('device:connect-network-device', options),
  disconnectNetworkDevice: () => ipcRenderer.invoke('device:disconnect-network-device'),
  appendChannelSamples: (payload) => ipcRenderer.invoke('device:append-channel-samples', payload),
  getDefaultLogDirectory: () => ipcRenderer.invoke('device:get-default-log-directory'),
  chooseLogDirectory: (defaultPath) => ipcRenderer.invoke('device:choose-log-directory', defaultPath),
  openPathInShell: (targetPath) => ipcRenderer.invoke('device:open-path-in-shell', targetPath),
  updateExternalSnapshot: (snapshot) => ipcRenderer.invoke('external:update-snapshot', snapshot),
  getExternalServiceStatus: () => ipcRenderer.invoke('external:get-service-status'),
  configureExternalAccess: (config) => ipcRenderer.invoke('external:configure-access', config),
  onExternalServiceStatus: (callback) => {
    const listener = (_, payload) => callback(payload)
    ipcRenderer.on('external:service-status', listener)
    return () => ipcRenderer.removeListener('external:service-status', listener)
  },
  onExternalControlRequest: (callback) => {
    const listener = async (_, request) => {
      try {
        const result = await callback(request)
        ipcRenderer.send('external:control-response', {
          id: request.id,
          ok: true,
          result
        })
      } catch (error) {
        ipcRenderer.send('external:control-response', {
          id: request.id,
          ok: false,
          error: error.message || 'External control request failed'
        })
      }
    }
    ipcRenderer.on('external:control-request', listener)
    return () => ipcRenderer.removeListener('external:control-request', listener)
  }
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
