import { app, shell, BrowserWindow, ipcMain, screen, dialog } from 'electron'
import { appendFile, mkdir, access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { spawn, spawnSync } from 'child_process'
import net from 'net'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SerialPort } from 'serialport'
import icon from '../../resources/icon.png?asset'

let serialConnection = null
let serialConnectionMeta = null
let tcpConnection = null
let tcpConnectionMeta = null

const ELEVATION_FLAG = '--elevation-attempted'

function toPowerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function isWindowsElevated() {
  if (process.platform !== 'win32') {
    return true
  }

  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { exit 0 } exit 1"
    ],
    {
      windowsHide: true
    }
  )

  return result.status === 0
}

function requestWindowsElevation() {
  const executable = process.execPath
  const relaunchArgs = [...process.argv.slice(1).filter((arg) => arg !== ELEVATION_FLAG), ELEVATION_FLAG]
  const command = [
    '$argumentList = @(',
    relaunchArgs.map((arg) => toPowerShellSingleQuoted(arg)).join(', '),
    ')',
    `Start-Process -FilePath ${toPowerShellSingleQuoted(executable)} -Verb RunAs -ArgumentList $argumentList`
  ].join('; ')

  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })

  child.unref()
}

function ensureAdminRights() {
  if (process.platform !== 'win32') {
    return true
  }

  if (isWindowsElevated()) {
    return true
  }

  if (process.argv.includes(ELEVATION_FLAG)) {
    dialog.showErrorBox('管理员权限申请失败', '温控系统需要管理员权限才能执行文件读写、串口和网口相关操作。请以管理员身份启动应用。')
    return false
  }

  try {
    requestWindowsElevation()
  } catch {
    dialog.showErrorBox('管理员权限申请失败', '未能自动拉起管理员权限，请手动以管理员身份启动应用。')
  }

  return false
}

if (!ensureAdminRights()) {
  app.quit()
}

function getDefaultLogDirectory() {
  return join(app.getPath('documents'), 'TemperatureControlLogs')
}

function resolveLogDirectory(directory) {
  return directory || getDefaultLogDirectory()
}

function getChannelLogFile(channel, directory, sessionId = 'adhoc') {
  return join(resolveLogDirectory(directory), `${channel}-samples-${sessionId}.csv`)
}

function escapeCsvValue(value) {
  const stringValue = String(value ?? '')
  if (!/[",\n]/.test(stringValue)) {
    return stringValue
  }

  return `"${stringValue.replace(/"/g, '""')}"`
}

async function ensureCsvHeader(filePath) {
  try {
    await access(filePath, constants.F_OK)
  } catch {
    const header = 'sampleIndex,elapsedSeconds,channel,temperature,setpoint,requestedSetpoint,controlOutput,disturbance,overshootPercent,settlingTime,mode,kp,ki,kd,sampleTime,outputLimit,deadband,setpointRamp,xAxisSecondsPerDivision,recordedAt\n'
    await appendFile(filePath, header, 'utf8')
  }
}

async function appendChannelSamples(channel, rows, directory, sessionId) {
  const targetDirectory = resolveLogDirectory(directory)
  const filePath = getChannelLogFile(channel, targetDirectory, sessionId)
  await mkdir(targetDirectory, { recursive: true })
  await ensureCsvHeader(filePath)

  const csvLines = rows
    .map((row) => [
      row.sampleIndex,
      row.elapsedSeconds,
      channel,
      row.temperature,
      row.setpoint,
      row.requestedSetpoint,
      row.controlOutput,
      row.disturbance,
      row.overshootPercent,
      row.settlingTime ?? '',
      row.mode,
      row.kp,
      row.ki,
      row.kd,
      row.sampleTime,
      row.outputLimit,
      row.deadband,
      row.setpointRamp,
      row.xAxisSecondsPerDivision,
      new Date(row.timestamp).toISOString()
    ].map(escapeCsvValue).join(','))
    .join('\n')

  await appendFile(filePath, `${csvLines}\n`, 'utf8')
  return filePath
}

function closeSerialConnection() {
  if (!serialConnection) {
    serialConnectionMeta = null
    return Promise.resolve()
  }

  const port = serialConnection
  serialConnection = null
  serialConnectionMeta = null

  return new Promise((resolve, reject) => {
    if (!port.isOpen) {
      resolve()
      return
    }

    port.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function closeTcpConnection() {
  if (!tcpConnection) {
    tcpConnectionMeta = null
    return
  }

  tcpConnection.destroy()
  tcpConnection = null
  tcpConnectionMeta = null
}

function getIpv4Interfaces() {
  const entries = networkInterfaces()

  return Object.entries(entries)
    .flatMap(([name, infos]) => (infos || []).map((info) => ({ name, ...info })))
    .filter((info) => info.family === 'IPv4' && !info.internal)
    .map((info) => ({
      name: info.name,
      address: info.address,
      netmask: info.netmask,
      cidr: info.cidr,
      mac: info.mac
    }))
}

function tcpProbe(host, port, timeoutMs) {
  const startedAt = Date.now()

  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    const finish = (result) => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish({
        reachable: true,
        latencyMs: Date.now() - startedAt
      })
    })
    socket.once('timeout', () => finish({ reachable: false, reason: 'timeout' }))
    socket.once('error', (error) => finish({ reachable: false, reason: error.code || error.message }))
    socket.connect(port, host)
  })
}

async function scanSubnet({ subnetPrefix, port, timeoutMs = 220, start = 1, end = 254 }) {
  const addresses = []

  for (let index = start; index <= end; index += 1) {
    addresses.push(`${subnetPrefix}${index}`)
  }

  const reachableHosts = []
  const concurrency = 24

  for (let offset = 0; offset < addresses.length; offset += concurrency) {
    const batch = addresses.slice(offset, offset + concurrency)
    const results = await Promise.all(
      batch.map(async (address) => {
        const result = await tcpProbe(address, port, timeoutMs)
        if (!result.reachable) {
          return null
        }

        return {
          id: `${address}:${port}`,
          name: 'TCP设备',
          address,
          port,
          status: '端口开放',
          latencyMs: result.latencyMs
        }
      })
    )

    reachableHosts.push(...results.filter(Boolean))
  }

  return reachableHosts
}

ipcMain.handle('device:list-serial-ports', async () => {
  const ports = await SerialPort.list()

  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer || '未知厂商',
    friendlyName: port.friendlyName || port.path,
    serialNumber: port.serialNumber || '',
    vendorId: port.vendorId || '',
    productId: port.productId || ''
  }))
})

ipcMain.handle('device:open-serial-port', async (_, options) => {
  const { path, baudRate, dataBits, stopBits, parity } = options

  if (!path) {
    throw new Error('未提供串口路径')
  }

  await closeSerialConnection()

  const port = new SerialPort({
    path,
    baudRate: Number(baudRate),
    dataBits: Number(dataBits),
    stopBits: Number(stopBits),
    parity,
    autoOpen: false
  })

  await new Promise((resolve, reject) => {
    port.open((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  serialConnection = port
  serialConnectionMeta = {
    path,
    baudRate: Number(baudRate),
    dataBits: Number(dataBits),
    stopBits: Number(stopBits),
    parity
  }

  port.once('close', () => {
    serialConnection = null
    serialConnectionMeta = null
  })

  return {
    connected: true,
    ...serialConnectionMeta
  }
})

ipcMain.handle('device:close-serial-port', async () => {
  await closeSerialConnection()
  return { connected: false }
})

ipcMain.handle('device:get-network-interfaces', async () => {
  return getIpv4Interfaces()
})

ipcMain.handle('device:scan-network-devices', async (_, options) => {
  const { subnetPrefix, port, timeoutMs, start, end } = options

  if (!subnetPrefix) {
    throw new Error('未提供子网前缀')
  }

  return scanSubnet({
    subnetPrefix,
    port: Number(port),
    timeoutMs: Number(timeoutMs || 220),
    start: Number(start || 1),
    end: Number(end || 254)
  })
})

ipcMain.handle('device:connect-network-device', async (_, options) => {
  const { host, port, timeoutMs = 800 } = options

  if (!host || !port) {
    throw new Error('未提供目标IP或端口')
  }

  closeTcpConnection()

  const startedAt = Date.now()

  await new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let settled = false

    const finishResolve = () => {
      if (settled) {
        return
      }

      settled = true
      tcpConnection = socket
      tcpConnectionMeta = {
        host,
        port: Number(port),
        latencyMs: Date.now() - startedAt
      }
      resolve()
    }

    const finishReject = (error) => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(Number(timeoutMs))
    socket.once('connect', finishResolve)
    socket.once('timeout', () => finishReject(new Error('网络连接超时')))
    socket.once('error', finishReject)
    socket.once('close', () => {
      if (tcpConnection === socket) {
        tcpConnection = null
        tcpConnectionMeta = null
      }
    })
    socket.connect(Number(port), host)
  })

  return {
    connected: true,
    ...tcpConnectionMeta
  }
})

ipcMain.handle('device:disconnect-network-device', async () => {
  closeTcpConnection()
  return { connected: false }
})

ipcMain.handle('device:get-default-log-directory', async () => {
  const directory = getDefaultLogDirectory()
  await mkdir(directory, { recursive: true })
  return directory
})

ipcMain.handle('device:choose-log-directory', async (_, defaultPath) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || undefined, {
    title: '选择 CSV 存储目录',
    defaultPath: defaultPath || getDefaultLogDirectory(),
    properties: ['openDirectory', 'createDirectory']
  })

  if (result.canceled || !result.filePaths.length) {
    return null
  }

  return result.filePaths[0]
})

ipcMain.handle('device:append-channel-samples', async (_, payload) => {
  const { channel, rows = [], directory, sessionId } = payload

  if (!channel) {
    throw new Error('未提供日志通道')
  }

  if (!sessionId) {
    throw new Error('未提供录制会话标识')
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return getChannelLogFile(channel, directory, sessionId)
  }

  return appendChannelSamples(channel, rows, directory, sessionId)
})

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().size
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width,
    height,
    autoHideMenuBar: true,
    // resizable:false,
    // fullscreen:true,
    // movable:false,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      enableRemoteModule: true,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    console.log('[Main Step 4] 加载开发环境 URL');
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    console.log('[Main Step 5] 加载生产环境文件');
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  closeTcpConnection()
  closeSerialConnection().catch(() => {})
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
