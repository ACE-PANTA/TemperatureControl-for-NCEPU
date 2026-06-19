import { app, shell, BrowserWindow, ipcMain, screen, dialog } from 'electron'
import { appendFile, mkdir, access } from 'fs/promises'
import { constants } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import { spawn, spawnSync } from 'child_process'
import net from 'net'
import http from 'http'
import { WebSocketServer } from 'ws'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SerialPort } from 'serialport'
import icon from '../../resources/logo.png?asset'

let serialConnection = null
let serialConnectionMeta = null
let tcpConnection = null
let tcpConnectionMeta = null
let tcpReceiveBuffer = ''
let serialReceiveBuffer = Buffer.alloc(0)
let serialProtocolFlushTimer = null
let serialCommandChain = Promise.resolve()
let tcpCommandChain = Promise.resolve()
const serialProtocolWaiters = new Set()
const tcpProtocolWaiters = new Set()
const externalControlWaiters = new Map()
let externalControlRequestId = 0
let latestExternalSnapshot = null
let externalHttpServer = null
let externalWsServer = null
let externalWsHttpServer = null
const externalWsClients = new Set()
const externalServiceStatus = {
  http: { port: 8056, running: false, error: '' },
  websocket: { port: 8057, running: false, error: '', clients: 0 },
  mcp: { port: 8056, path: '/mcp', running: false, error: '' },
  renderer: { ready: false, lastSnapshotAt: null }
}

const DATASCOPE_FRAME_HEADER = '$'.charCodeAt(0)
const DATASCOPE_FRAME_LENGTH = 14
const DATASCOPE_FRAME_END_MARKER = 13
const SERIAL_PROTOCOL_HEADER = '!'.charCodeAt(0)
const SERIAL_PROTOCOL_SEPARATOR = '*'.charCodeAt(0)
const SERIAL_PROTOCOL_IDLE_FLUSH_MS = 60
const SERIAL_PROTOCOL_COMMAND_TERMINATOR = '\r\n'
const DATASCOPE_CHANNEL_DEFINITIONS = [
  { key: 'furnaceTemp', label: '炉膛温度', unit: '°C' },
  { key: 'pwm', label: 'PWM', unit: '%' },
  { key: 'boardTemp', label: '板载温度', unit: '°C' }
]

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
    const header = 'sampleIndex,elapsedSeconds,channel,temperature,setpoint,requestedSetpoint,controlOutput,disturbance,overshootPercent,settlingTime,mode,tranKp,tranKi,tranKd,tranInterval,tranSepThreshold,fineKp,fineKi,fineKd,fineInterval,fineRange,fineEntryMin,fineEntryMax,fineEnabled,deadband,xAxisSecondsPerDivision,recordedAt\n'
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
      row.tranKp,
      row.tranKi,
      row.tranKd,
      row.tranInterval,
      row.tranSepThreshold,
      row.fineKp,
      row.fineKi,
      row.fineKd,
      row.fineInterval,
      row.fineRange,
      row.fineEntryMin,
      row.fineEntryMax,
      row.fineEnabled,
      row.deadband,
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
    serialReceiveBuffer = Buffer.alloc(0)
    clearTimeout(serialProtocolFlushTimer)
    serialProtocolFlushTimer = null
    return Promise.resolve()
  }

  const port = serialConnection
  serialConnection = null
  serialConnectionMeta = null
  serialReceiveBuffer = Buffer.alloc(0)
  clearTimeout(serialProtocolFlushTimer)
  serialProtocolFlushTimer = null

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

function computeSerialChecksum(body) {
  let checksum = SERIAL_PROTOCOL_HEADER

  for (const char of body) {
    checksum ^= char.charCodeAt(0)
  }

  return checksum
}

function formatChecksum(value) {
  return value.toString(16).toUpperCase().padStart(2, '0')
}

function buildSerialProtocolPacket(body, { includeChecksum = false } = {}) {
  if (!includeChecksum) {
    return `!${body}`
  }

  return `!${body}*${formatChecksum(computeSerialChecksum(body))}`
}

function isHexByte(value) {
  return /^[0-9A-Fa-f]{2}$/.test(value)
}

function parseKeyValueBody(body) {
  return body.split(',').reduce((result, entry) => {
    const separatorIndex = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('=')
    if (separatorIndex < 0) {
      return result
    }

    const rawKey = entry.slice(0, separatorIndex)
    const rawValue = entry.slice(separatorIndex + 1)
    if (!rawKey) {
      return result
    }

    result[rawKey.trim().toUpperCase()] = rawValue?.trim() ?? ''
    return result
  }, {})
}

function normalizeControllerMode(rawMode) {
  const normalized = String(rawMode ?? '').trim().toUpperCase()

  if (normalized === '0' || normalized === 'AUTO') {
    return 'AUTO'
  }

  if (normalized === '1' || normalized === 'MAN' || normalized === 'MANUAL') {
    return 'MAN'
  }

  return normalized || null
}

function normalizeControllerPhase(rawPhase) {
  const normalized = String(rawPhase ?? '').trim().toUpperCase()

  if (normalized === 'MAN' || normalized === 'TRAN' || normalized === 'FINE') {
    return normalized
  }

  return normalized || null
}

function parseTenthsValue(rawValue) {
  const numericValue = Number.parseFloat(rawValue ?? '')
  if (!Number.isFinite(numericValue)) {
    return Number.NaN
  }

  return numericValue / 10
}

function parseSerialProtocolPacket(packet) {
  if (!packet.startsWith('!') || packet.length < 2) {
    return null
  }

  const starIndex = packet.lastIndexOf('*')
  let body = packet.slice(1)
  let hasChecksum = false

  if (starIndex >= 0) {
    if (starIndex + 3 !== packet.length) {
      return null
    }

    body = packet.slice(1, starIndex)
    const checksumText = packet.slice(starIndex + 1)
    if (!isHexByte(checksumText)) {
      return null
    }

    const checksum = Number.parseInt(checksumText, 16)
    if (computeSerialChecksum(body) !== checksum) {
      return {
        kind: 'invalid',
        packet,
        body,
        checksum,
        expectedChecksum: computeSerialChecksum(body)
      }
    }

    hasChecksum = true
  }

  if (body.startsWith('ACK=')) {
    return {
      kind: 'ack',
      packet,
      body,
      hasChecksum,
      status: body.slice(4).trim().toUpperCase()
    }
  }

  if (body.startsWith('STATE=')) {
    const fields = parseKeyValueBody(body.slice(6))
    const parsed = {
      kind: 'state',
      packet,
      body,
      hasChecksum,
      mode: normalizeControllerMode(fields.MODE),
      phase: normalizeControllerPhase(fields.PHASE),
      pwm: Number.parseFloat(fields.PWM ?? ''),
      goal: parseTenthsValue(fields.GOAL),
      feedback: parseTenthsValue(fields.FB),
      predictedFeedback: parseTenthsValue(fields.PFB)
    }

    console.log('[serial:state:parsed]', {
      packet,
      fields,
      parsed
    })

    return parsed
  }

  if (body.startsWith('TRAN=')) {
    const fields = parseKeyValueBody(body.slice(5))
    return {
      kind: 'tran',
      packet,
      body,
      hasChecksum,
      kp: Number.parseFloat(fields.KP ?? ''),
      ki: Number.parseFloat(fields.KI ?? ''),
      kd: Number.parseFloat(fields.KD ?? ''),
      interval: Number.parseInt(fields.INT ?? '0', 10) || 0,
      sepThreshold: Number.parseFloat(fields.SEP ?? fields.ST ?? '')
    }
  }

  if (body.startsWith('PHASE=')) {
    return {
      kind: 'phase',
      packet,
      body,
      hasChecksum,
      phase: normalizeControllerPhase(body.slice(6))
    }
  }

  if (body.startsWith('FINE=')) {
    const fields = parseKeyValueBody(body.slice(5))
    return {
      kind: 'fine',
      packet,
      body,
      hasChecksum,
      kp: Number.parseFloat(fields.KP ?? ''),
      ki: Number.parseFloat(fields.KI ?? ''),
      kd: Number.parseFloat(fields.KD ?? ''),
      interval: Number.parseInt(fields.INT ?? '0', 10) || 0,
      range: Number.parseFloat(fields.FR ?? fields.RNG ?? ''),
      entryMin: Number.parseFloat(fields.EMIN ?? fields.EMN ?? ''),
      entryMax: Number.parseFloat(fields.EMAX ?? fields.EMX ?? ''),
      stableWindow: Number.parseInt(fields.SW ?? '0', 10) || 0,
      stableDelta: Number.parseFloat(fields.SD ?? '')
    }
  }

  if (body.startsWith('DEADBAND=')) {
    const rawValue = body.slice(9).trim()
    return {
      kind: 'deadband',
      packet,
      body,
      hasChecksum,
      deadband: Number.parseFloat(rawValue)
    }
  }

  if (body.startsWith('FINEEN=')) {
    const rawValue = body.slice(7).trim()
    return {
      kind: 'fineEnable',
      packet,
      body,
      hasChecksum,
      enabled: rawValue === '1' || rawValue.toUpperCase() === 'ON' || rawValue.toUpperCase() === 'TRUE'
    }
  }

  if (body.startsWith('SMITH=')) {
    const fields = parseKeyValueBody(body.slice(6))
    const parts = body.slice(6).split(',').map((part) => part.trim())
    const rawEnabled = fields.EN ?? fields.ENABLE ?? fields.E ?? ''
    return {
      kind: 'smith',
      packet,
      body,
      hasChecksum,
      enabled: (rawEnabled || parts[0]) === '1' || (rawEnabled || parts[0]).toUpperCase() === 'ON' || (rawEnabled || parts[0]).toUpperCase() === 'TRUE',
      gain: Number.parseFloat(fields.GAIN ?? fields.G ?? parts[1] ?? ''),
      tau: Number.parseFloat(fields.TAU ?? fields.T ?? parts[2] ?? ''),
      delay: Number.parseFloat(fields.DELAY ?? fields.DLY ?? fields.D ?? parts[3] ?? ''),
      blend: Number.parseFloat(fields.BLEND ?? fields.B ?? parts[4] ?? ''),
      maxLead: Number.parseFloat(fields.MAXLEAD ?? fields.ML ?? fields.MAX_LEAD ?? parts[5] ?? '')
    }
  }

  if (body.startsWith('SMITHEN=')) {
    const rawValue = body.slice(8).trim()
    return {
      kind: 'smithEnable',
      packet,
      body,
      hasChecksum,
      enabled: rawValue === '1' || rawValue.toUpperCase() === 'ON' || rawValue.toUpperCase() === 'TRUE'
    }
  }

  if (body.startsWith('PID=')) {
    const fields = parseKeyValueBody(body.slice(4))
    return {
      kind: 'pid',
      packet,
      body,
      hasChecksum,
      kp: Number.parseFloat(fields.KP ?? ''),
      ki: Number.parseFloat(fields.KI ?? ''),
      kd: Number.parseFloat(fields.KD ?? ''),
      interval: Number.parseInt(fields.INT ?? '0', 10) || 0,
      deadband: Number.parseFloat(fields.DB ?? ''),
      maxDelta: Number.parseFloat(fields.MD ?? ''),
      fineTune: Number.parseFloat(fields.FT ?? '')
    }
  }

  if (body.startsWith('CASCADE=')) {
    const fields = parseKeyValueBody(body.slice(8))
    return {
      kind: 'cascade',
      packet,
      body,
      hasChecksum,
      kOuter: Number.parseFloat(fields.KO ?? ''),
      maxRate: Number.parseFloat(fields.MR ?? ''),
      kpInner: Number.parseFloat(fields.KPI ?? ''),
      kiInner: Number.parseFloat(fields.KII ?? '')
    }
  }

  if (body.startsWith('HYBRID=')) {
    const fields = parseKeyValueBody(body.slice(7))
    return {
      kind: 'hybrid',
      packet,
      body,
      hasChecksum,
      threshold: Number.parseFloat(fields.TH ?? ''),
      kp: Number.parseFloat(fields.KP ?? ''),
      ki: Number.parseFloat(fields.KI ?? ''),
      kd: Number.parseFloat(fields.KD ?? ''),
      slowInterval: Number.parseInt(fields.INT ?? '0', 10) || 0
    }
  }

  if (body.startsWith('NET=')) {
    const fields = parseKeyValueBody(body.slice(4))
    return {
      kind: 'net',
      packet,
      body,
      hasChecksum,
      ip: fields.IP ?? '',
      gateway: fields.GW ?? '',
      netmask: fields.NM ?? '',
      port: Number.parseInt(fields.PORT ?? '0', 10) || 0
    }
  }

  if (body.startsWith('ETH=')) {
    const fields = parseKeyValueBody(body.slice(4))
    return {
      kind: 'eth',
      packet,
      body,
      hasChecksum,
      link: Number.parseInt(fields.LINK ?? '0', 10) || 0,
      phy: Number.parseInt(fields.PHY ?? '0', 10) || 0,
      err: Number.parseInt(fields.ERR ?? '0', 10) || 0,
      phyId: fields.PHYID ?? '',
      rx: Number.parseInt(fields.RX ?? '0', 10) || 0,
      tx: Number.parseInt(fields.TX ?? '0', 10) || 0,
      arp: Number.parseInt(fields.ARP ?? '0', 10) || 0,
      icmp: Number.parseInt(fields.ICMP ?? '0', 10) || 0,
      aneg: Number.parseInt(fields.ANEG ?? '0', 10) || 0,
      tcp: Number.parseInt(fields.TCP ?? '0', 10) || 0
    }
  }

  if (body.startsWith('CONFIG=')) {
    return {
      kind: 'config',
      packet,
      body,
      hasChecksum,
      raw: body.slice(7)
    }
  }

  return {
    kind: 'unknown',
    packet,
    body,
    hasChecksum
  }
}

function findSerialProtocolBoundary(buffer) {
  let boundary = -1

  for (let index = 1; index < buffer.length; index += 1) {
    if ([0x0d, 0x0a, 0x00].includes(buffer[index])) {
      boundary = index
      break
    }

    if (buffer[index] === SERIAL_PROTOCOL_HEADER || buffer[index] === DATASCOPE_FRAME_HEADER) {
      boundary = index
      break
    }
  }

  return boundary
}

function settleSerialProtocolWaiters(message) {
  for (const waiter of [...serialProtocolWaiters]) {
    if (waiter.kind && waiter.kind !== message.kind) {
      continue
    }

    if (typeof waiter.match === 'function' && !waiter.match(message)) {
      continue
    }

    clearTimeout(waiter.timer)
    serialProtocolWaiters.delete(waiter)
    waiter.resolve(message)
    return true
  }

  return false
}

function broadcastSerialDebug(direction, summary, extra = {}) {
  const payload = {
    direction,
    summary,
    ...extra,
    timestamp: Date.now()
  }

  console.log(`[serial:${direction}] ${summary}`, extra)
  broadcastToRenderers('device:serial-debug', payload)
}

function summarizeSerialAscii(buffer, maxLength = 120) {
  return buffer
    .subarray(0, Math.min(buffer.length, maxLength))
    .toString('ascii')
    .replace(/[^\x20-\x7E]/g, '.') || '<non-printable>'
}

function broadcastSerialProtocol(message) {
  if (!message) {
    return
  }

  broadcastSerialDebug('rx', message.packet || message.body || '收到协议消息', {
    kind: message.kind,
    packet: message.packet,
    body: message.body,
    status: message.status ?? null
  })

  broadcastToRenderers('device:serial-protocol', {
    ...message,
    timestamp: Date.now()
  })
  settleSerialProtocolWaiters(message)
}

function waitForSerialProtocolMessage({ kind, timeoutMs = 1500, match } = {}) {
  return new Promise((resolve, reject) => {
    const waiter = {
      kind,
      match,
      resolve,
      reject,
      timer: setTimeout(() => {
        serialProtocolWaiters.delete(waiter)
        reject(new Error('等待设备回传超时'))
      }, timeoutMs)
    }

    serialProtocolWaiters.add(waiter)
  })
}

function queueSerialCommand(task) {
  const queued = serialCommandChain.then(task, task)
  serialCommandChain = queued.catch(() => null)
  return queued
}

function writeSerialPacket(packet) {
  if (!serialConnection?.isOpen) {
    return Promise.reject(new Error('串口未连接'))
  }

  const outboundPacket = `${packet.replace(/[\r\n]+$/g, '')}${SERIAL_PROTOCOL_COMMAND_TERMINATOR}`
  const outboundBuffer = Buffer.from(outboundPacket, 'ascii')

  return new Promise((resolve, reject) => {
    serialConnection.write(outboundBuffer, (error) => {
      if (error) {
        reject(error)
        return
      }

      serialConnection.drain((drainError) => {
        if (drainError) {
          reject(drainError)
          return
        }
        resolve()
      })
    })
  })
}

function tryParseSerialProtocolPacket(buffer) {
  const starIndex = buffer.indexOf(SERIAL_PROTOCOL_SEPARATOR, 1)
  if (starIndex >= 0) {
    if (buffer.length < starIndex + 3) {
      return { needsMore: true }
    }

    const checksumText = buffer.subarray(starIndex + 1, starIndex + 3).toString('ascii')
    if (!isHexByte(checksumText)) {
      return { invalid: true, consumeLength: Math.max(1, starIndex + 1) }
    }

    let consumeLength = starIndex + 3
    while (consumeLength < buffer.length && [0x0d, 0x0a, 0x00].includes(buffer[consumeLength])) {
      consumeLength += 1
    }

    return {
      consumeLength,
      parsed: parseSerialProtocolPacket(buffer.subarray(0, starIndex + 3).toString('ascii'))
    }
  }

  const boundary = findSerialProtocolBoundary(buffer)
  if (boundary < 0) {
    return { needsMore: true }
  }

  let consumeLength = boundary
  while (consumeLength < buffer.length && [0x0d, 0x0a, 0x00].includes(buffer[consumeLength])) {
    consumeLength += 1
  }

  return {
    consumeLength,
    parsed: parseSerialProtocolPacket(buffer.subarray(0, boundary).toString('ascii'))
  }
}

function flushPendingSerialProtocolBuffer() {
  clearTimeout(serialProtocolFlushTimer)
  serialProtocolFlushTimer = null

  if (!serialReceiveBuffer.length || serialReceiveBuffer[0] !== SERIAL_PROTOCOL_HEADER) {
    return
  }

  let consumeLength = serialReceiveBuffer.length
  while (consumeLength > 0 && [0x0d, 0x0a, 0x00].includes(serialReceiveBuffer[consumeLength - 1])) {
    consumeLength -= 1
  }

  if (consumeLength <= 1) {
    serialReceiveBuffer = serialReceiveBuffer.subarray(Math.max(consumeLength, 1))
    return
  }

  const packet = serialReceiveBuffer.subarray(0, consumeLength).toString('ascii')
  const parsed = parseSerialProtocolPacket(packet)

  if (parsed) {
    broadcastSerialProtocol(parsed)
  } else {
    broadcastSerialDebug('rx', `空闲收口后仍无法解析: ${summarizeSerialAscii(serialReceiveBuffer)}`, {
      kind: 'malformed',
      packet
    })
  }

  serialReceiveBuffer = serialReceiveBuffer.subarray(consumeLength)
  while (serialReceiveBuffer.length && [0x0d, 0x0a, 0x00].includes(serialReceiveBuffer[0])) {
    serialReceiveBuffer = serialReceiveBuffer.subarray(1)
  }

  if (serialReceiveBuffer.length) {
    handleSerialChunk(Buffer.alloc(0))
  }
}

function scheduleSerialProtocolFlush() {
  clearTimeout(serialProtocolFlushTimer)
  serialProtocolFlushTimer = setTimeout(() => {
    flushPendingSerialProtocolBuffer()
  }, SERIAL_PROTOCOL_IDLE_FLUSH_MS)
}

function broadcastToRenderers(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

function updateExternalServiceStatus(partial = {}) {
  Object.assign(externalServiceStatus, {
    ...externalServiceStatus,
    ...partial
  })
  broadcastToRenderers('external:service-status', externalServiceStatus)
  broadcastExternalWs({
    type: 'service_status',
    payload: externalServiceStatus,
    timestamp: Date.now()
  })
}

function broadcastExternalWs(message) {
  const raw = JSON.stringify(message)
  for (const client of externalWsClients) {
    if (client.readyState === 1) {
      client.send(raw)
    }
  }
}

function setJsonResponse(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  })
  response.end(body)
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        request.destroy()
        reject(new Error('Request body too large'))
      }
    })
    request.on('end', () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

function getExternalTargetWindow() {
  return BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
}

function invokeExternalRendererAction(action, payload = {}, timeoutMs = 5000) {
  const targetWindow = getExternalTargetWindow()
  if (!targetWindow) {
    return Promise.reject(new Error('Renderer is not available'))
  }

  const id = `external-${Date.now()}-${++externalControlRequestId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      externalControlWaiters.delete(id)
      reject(new Error(`External action timed out: ${action}`))
    }, timeoutMs)

    externalControlWaiters.set(id, { resolve, reject, timer })
    targetWindow.webContents.send('external:control-request', {
      id,
      action,
      payload,
      timestamp: Date.now()
    })
  })
}

function ok(data = {}) {
  return { ok: true, ...data }
}

async function handleExternalApiRequest(request, response) {
  if (request.method === 'OPTIONS') {
    setJsonResponse(response, 204, {})
    return
  }

  const url = new URL(request.url, 'http://127.0.0.1:8056')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  try {
    if (request.method === 'GET' && path === '/health') {
      setJsonResponse(response, 200, ok({ services: externalServiceStatus }))
      return
    }

    if (request.method === 'GET' && path === '/api/status') {
      setJsonResponse(response, 200, ok({ services: externalServiceStatus }))
      return
    }

    if (request.method === 'GET' && path === '/api/snapshot') {
      setJsonResponse(response, 200, ok({ snapshot: latestExternalSnapshot }))
      return
    }

    if (request.method === 'POST' && path === '/mcp') {
      const body = await readJsonBody(request)
      setJsonResponse(response, 200, await handleMcpRequest(body))
      return
    }

    if (request.method !== 'POST') {
      setJsonResponse(response, 404, { ok: false, error: 'Not found' })
      return
    }

    const body = await readJsonBody(request)
    const actionByPath = {
      '/api/refresh': 'refresh_snapshot',
      '/api/mode': 'set_mode',
      '/api/manual-pwm': 'set_manual_pwm',
      '/api/target-temperature': 'set_target_temperature',
      '/api/pid/tran': 'set_tran_pid',
      '/api/pid/fine': 'set_fine_pid',
      '/api/pid/smith': 'set_smith',
      '/api/pid/deadband': 'set_deadband',
      '/api/pid/fine-enable': 'set_fine_enable',
      '/api/save': 'save_config'
    }
    const action = actionByPath[path]
    if (!action) {
      setJsonResponse(response, 404, { ok: false, error: 'Not found' })
      return
    }

    const result = await invokeExternalRendererAction(action, body)
    setJsonResponse(response, 200, ok({ result, snapshot: latestExternalSnapshot }))
  } catch (error) {
    setJsonResponse(response, 500, { ok: false, error: error.message || 'External request failed' })
  }
}

const mcpTools = [
  {
    name: 'temperature_get_status',
    description: 'Get latest temperature-control status, mode, condition and PID configuration.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'temperature_refresh_snapshot',
    description: 'Query the controller and refresh mode, condition, TRAN/FINE/Smith PID, fine-enable and deadband.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', enum: ['serial', 'ethernet'] } }
    }
  },
  {
    name: 'temperature_set_mode',
    description: 'Switch controller mode.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['AUTO', 'MAN'] },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['mode']
    }
  },
  {
    name: 'temperature_set_manual_pwm',
    description: 'Set manual PWM output.',
    inputSchema: {
      type: 'object',
      properties: {
        pwm: { type: 'number', minimum: -100, maximum: 100 },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['pwm']
    }
  },
  {
    name: 'temperature_set_target_temperature',
    description: 'Set auto-mode target temperature.',
    inputSchema: {
      type: 'object',
      properties: {
        temperature: { type: 'number' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['temperature']
    }
  },
  {
    name: 'temperature_set_tran_pid',
    description: 'Set TRAN condition PID parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        kp: { type: 'number' },
        ki: { type: 'number' },
        kd: { type: 'number' },
        interval: { type: 'number' },
        sepThreshold: { type: 'number' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['kp', 'ki', 'kd']
    }
  },
  {
    name: 'temperature_set_fine_pid',
    description: 'Set FINE condition PID parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        kp: { type: 'number' },
        ki: { type: 'number' },
        kd: { type: 'number' },
        interval: { type: 'number' },
        range: { type: 'number' },
        entryMin: { type: 'number' },
        entryMax: { type: 'number' },
        stableWindow: { type: 'number' },
        stableDelta: { type: 'number' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['kp', 'ki', 'kd']
    }
  },
  {
    name: 'temperature_set_smith',
    description: 'Set Smith predictor parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        gain: { type: 'number' },
        tau: { type: 'number' },
        delay: { type: 'number' },
        blend: { type: 'number' },
        maxLead: { type: 'number' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['enabled', 'gain', 'tau', 'delay', 'blend', 'maxLead']
    }
  },
  {
    name: 'temperature_set_deadband',
    description: 'Set shared PID deadband.',
    inputSchema: {
      type: 'object',
      properties: {
        deadband: { type: 'number' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['deadband']
    }
  },
  {
    name: 'temperature_set_fine_enable',
    description: 'Enable or disable FINE condition entry.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        channel: { type: 'string', enum: ['serial', 'ethernet'] }
      },
      required: ['enabled']
    }
  }
]

function mcpTextResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  }
}

async function handleMcpRequest(message) {
  const id = message?.id ?? null
  const method = message?.method

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'temperature-control', version: '1.0.0' }
        }
      }
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: mcpTools } }
    }

    if (method === 'tools/call') {
      const toolName = message?.params?.name
      const args = message?.params?.arguments || {}
      const toolActions = {
        temperature_get_status: null,
        temperature_refresh_snapshot: 'refresh_snapshot',
        temperature_set_mode: 'set_mode',
        temperature_set_manual_pwm: 'set_manual_pwm',
        temperature_set_target_temperature: 'set_target_temperature',
        temperature_set_tran_pid: 'set_tran_pid',
        temperature_set_fine_pid: 'set_fine_pid',
        temperature_set_smith: 'set_smith',
        temperature_set_deadband: 'set_deadband',
        temperature_set_fine_enable: 'set_fine_enable'
      }

      if (!(toolName in toolActions)) {
        throw new Error(`Unknown tool: ${toolName}`)
      }

      const result = toolActions[toolName]
        ? await invokeExternalRendererAction(toolActions[toolName], args)
        : { snapshot: latestExternalSnapshot }

      return {
        jsonrpc: '2.0',
        id,
        result: mcpTextResult({ ok: true, result, snapshot: latestExternalSnapshot })
      }
    }

    if (method === 'notifications/initialized') {
      return { jsonrpc: '2.0', id, result: {} }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: error.message || 'MCP request failed' }
    }
  }
}

function startExternalHttpServer() {
  if (externalHttpServer) {
    return
  }

  externalHttpServer = http.createServer((request, response) => {
    handleExternalApiRequest(request, response).catch((error) => {
      setJsonResponse(response, 500, { ok: false, error: error.message || 'HTTP service failed' })
    })
  })

  externalHttpServer.on('error', (error) => {
    externalServiceStatus.http.running = false
    externalServiceStatus.http.error = error.message
    externalServiceStatus.mcp.running = false
    externalServiceStatus.mcp.error = error.message
    updateExternalServiceStatus()
  })

  externalHttpServer.listen(8056, '127.0.0.1', () => {
    externalServiceStatus.http.running = true
    externalServiceStatus.http.error = ''
    externalServiceStatus.mcp.running = true
    externalServiceStatus.mcp.error = ''
    updateExternalServiceStatus()
  })
}

function startExternalWebSocketServer() {
  if (externalWsHttpServer) {
    return
  }

  externalWsHttpServer = http.createServer()
  externalWsServer = new WebSocketServer({ server: externalWsHttpServer })

  externalWsServer.on('connection', (socket) => {
    externalWsClients.add(socket)
    externalServiceStatus.websocket.clients = externalWsClients.size
    updateExternalServiceStatus()
    socket.send(JSON.stringify({ type: 'service_status', payload: externalServiceStatus, timestamp: Date.now() }))
    socket.send(JSON.stringify({ type: 'snapshot', payload: latestExternalSnapshot, timestamp: Date.now() }))

    socket.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString())
        if (!message?.action) {
          return
        }
        const result = await invokeExternalRendererAction(message.action, message.payload || {})
        socket.send(JSON.stringify({ type: 'action_result', id: message.id, ok: true, result, timestamp: Date.now() }))
      } catch (error) {
        socket.send(JSON.stringify({ type: 'action_result', ok: false, error: error.message || 'Action failed', timestamp: Date.now() }))
      }
    })

    socket.on('close', () => {
      externalWsClients.delete(socket)
      externalServiceStatus.websocket.clients = externalWsClients.size
      updateExternalServiceStatus()
    })
  })

  externalWsHttpServer.on('error', (error) => {
    externalServiceStatus.websocket.running = false
    externalServiceStatus.websocket.error = error.message
    updateExternalServiceStatus()
  })

  externalWsHttpServer.listen(8057, '127.0.0.1', () => {
    externalServiceStatus.websocket.running = true
    externalServiceStatus.websocket.error = ''
    updateExternalServiceStatus()
  })
}

function startExternalServices() {
  startExternalHttpServer()
  startExternalWebSocketServer()
}

function stopExternalServices() {
  for (const client of externalWsClients) {
    client.close()
  }
  externalWsClients.clear()
  externalWsServer?.close()
  externalWsHttpServer?.close()
  externalHttpServer?.close()
  externalWsServer = null
  externalWsHttpServer = null
  externalHttpServer = null
}

function decodeDataScopeFrame(frame) {
  if (!frame || frame.length !== DATASCOPE_FRAME_LENGTH) {
    return null
  }

  if (frame[0] !== DATASCOPE_FRAME_HEADER || frame[DATASCOPE_FRAME_LENGTH - 1] !== DATASCOPE_FRAME_END_MARKER) {
    return null
  }

  const timestamp = Date.now()
  const telemetry = DATASCOPE_CHANNEL_DEFINITIONS.map((definition, index) => ({
    ...definition,
    channel: index + 1,
    value: Number(frame.readFloatLE(1 + index * 4).toFixed(2))
  }))

  return {
    source: 'stm32-datascope',
    timestamp,
    frameLength: DATASCOPE_FRAME_LENGTH,
    telemetry,
    furnaceTemp: telemetry[0]?.value ?? null,
    pwm: telemetry[1]?.value ?? null,
    boardTemp: telemetry[2]?.value ?? null
  }
}

function handleSerialChunk(chunk) {
  if (chunk?.length) {
    serialReceiveBuffer = Buffer.concat([serialReceiveBuffer, chunk])

    const commandStart = chunk.indexOf(SERIAL_PROTOCOL_HEADER)
    if (commandStart >= 0) {
      const rawFragment = summarizeSerialAscii(chunk.subarray(commandStart))
      broadcastSerialDebug('rx', `原始串口片段: ${rawFragment}`, {
        kind: 'raw',
        packet: rawFragment
      })
    }
  }

  while (serialReceiveBuffer.length) {
    const commandStart = serialReceiveBuffer.indexOf(SERIAL_PROTOCOL_HEADER)
    const frameStart = serialReceiveBuffer.indexOf(DATASCOPE_FRAME_HEADER)

    if (commandStart < 0 && frameStart < 0) {
      serialReceiveBuffer = Buffer.alloc(0)
      return
    }

    const nextStart = [commandStart, frameStart].filter((index) => index >= 0).sort((left, right) => left - right)[0]

    if (nextStart > 0) {
      serialReceiveBuffer = serialReceiveBuffer.subarray(nextStart)
    }

    if (!serialReceiveBuffer.length) {
      return
    }

    if (serialReceiveBuffer[0] === DATASCOPE_FRAME_HEADER) {
      clearTimeout(serialProtocolFlushTimer)
      serialProtocolFlushTimer = null

      if (serialReceiveBuffer.length < DATASCOPE_FRAME_LENGTH) {
        return
      }

      const frame = serialReceiveBuffer.subarray(0, DATASCOPE_FRAME_LENGTH)
      const decoded = decodeDataScopeFrame(frame)

      if (!decoded) {
        serialReceiveBuffer = serialReceiveBuffer.subarray(1)
        continue
      }

      broadcastToRenderers('device:serial-frame', decoded)
      serialReceiveBuffer = serialReceiveBuffer.subarray(DATASCOPE_FRAME_LENGTH)
      continue
    }

    if (serialReceiveBuffer[0] === SERIAL_PROTOCOL_HEADER) {
      const result = tryParseSerialProtocolPacket(serialReceiveBuffer)
      if (result.needsMore) {
        scheduleSerialProtocolFlush()
        return
      }

      clearTimeout(serialProtocolFlushTimer)
      serialProtocolFlushTimer = null

      if (result.invalid || !result.parsed) {
        const summary = summarizeSerialAscii(serialReceiveBuffer, 40)
        broadcastSerialDebug('rx', `无法解析协议片段: ${summary}`, {
          kind: 'malformed',
          packet: summary
        })
        serialReceiveBuffer = serialReceiveBuffer.subarray(result.consumeLength || 1)
        continue
      }

      broadcastSerialProtocol(result.parsed)
      serialReceiveBuffer = serialReceiveBuffer.subarray(result.consumeLength)
      continue
    }

    serialReceiveBuffer = serialReceiveBuffer.subarray(1)
  }
}

function broadcastTcpDebug(direction, summary, extra = {}) {
  const payload = {
    direction,
    summary,
    ...extra,
    timestamp: Date.now()
  }

  console.log(`[tcp:${direction}] ${summary}`, extra)
  broadcastToRenderers('device:tcp-debug', payload)
}

function broadcastTcpProtocol(message) {
  if (!message) {
    return
  }

  broadcastTcpDebug('rx', message.packet || message.body || '收到TCP协议消息', {
    kind: message.kind,
    packet: message.packet,
    body: message.body,
    status: message.status ?? null
  })

  broadcastToRenderers('device:tcp-protocol', {
    ...message,
    timestamp: Date.now()
  })
  settleTcpProtocolWaiters(message)
}

function settleTcpProtocolWaiters(message) {
  for (const waiter of [...tcpProtocolWaiters]) {
    if (waiter.kind && waiter.kind !== message.kind) {
      continue
    }

    if (typeof waiter.match === 'function' && !waiter.match(message)) {
      continue
    }

    clearTimeout(waiter.timer)
    tcpProtocolWaiters.delete(waiter)
    waiter.resolve(message)
    return true
  }

  return false
}

function waitForTcpProtocolMessage({ kind, timeoutMs = 1500, match } = {}) {
  return new Promise((resolve, reject) => {
    const waiter = {
      kind,
      match,
      resolve,
      reject,
      timer: setTimeout(() => {
        tcpProtocolWaiters.delete(waiter)
        reject(new Error('等待TCP设备回传超时'))
      }, timeoutMs)
    }

    tcpProtocolWaiters.add(waiter)
  })
}

function queueTcpCommand(task) {
  const queued = tcpCommandChain.then(task, task)
  tcpCommandChain = queued.catch(() => null)
  return queued
}

function writeTcpPacket(packet) {
  if (!tcpConnection || tcpConnection.destroyed) {
    return Promise.reject(new Error('TCP未连接'))
  }

  const outboundPacket = `${packet.replace(/[\r\n]+$/g, '')}${SERIAL_PROTOCOL_COMMAND_TERMINATOR}`

  return new Promise((resolve, reject) => {
    tcpConnection.write(outboundPacket, 'ascii', (error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function handleTcpData(chunk) {
  if (!chunk || !chunk.length) {
    return
  }

  tcpReceiveBuffer += chunk.toString('ascii')

  while (true) {
    const crlfIndex = tcpReceiveBuffer.indexOf('\r\n')
    if (crlfIndex < 0) {
      if (tcpReceiveBuffer.length > 2048) {
        broadcastTcpDebug('rx', `TCP缓冲区溢出(${tcpReceiveBuffer.length}字节)，已清空`, { kind: 'overflow' })
        tcpReceiveBuffer = ''
      }
      return
    }

    const line = tcpReceiveBuffer.slice(0, crlfIndex)
    tcpReceiveBuffer = tcpReceiveBuffer.slice(crlfIndex + 2)

    if (!line || !line.startsWith('!')) {
      if (line.length > 1) {
        broadcastTcpDebug('rx', `忽略非协议行: ${line.slice(0, 80)}`, { kind: 'ignored' })
      }
      continue
    }

    broadcastTcpDebug('rx', `原始TCP片段: ${line.slice(0, 120)}`, { kind: 'raw', packet: line })

    const parsed = parseSerialProtocolPacket(line)
    if (parsed) {
      broadcastTcpProtocol(parsed)
    } else {
      broadcastTcpDebug('rx', `无法解析TCP协议: ${line.slice(0, 80)}`, { kind: 'malformed', packet: line })
    }
  }
}

function closeTcpConnection() {
  if (!tcpConnection) {
    tcpConnectionMeta = null
    tcpReceiveBuffer = ''
    return
  }

  tcpConnection.destroy()
  tcpConnection = null
  tcpConnectionMeta = null
  tcpReceiveBuffer = ''

  for (const waiter of [...tcpProtocolWaiters]) {
    clearTimeout(waiter.timer)
    tcpProtocolWaiters.delete(waiter)
    waiter.reject(new Error('TCP连接已断开'))
  }
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
  serialReceiveBuffer = Buffer.alloc(0)
  clearTimeout(serialProtocolFlushTimer)
  serialProtocolFlushTimer = null
  serialConnectionMeta = {
    path,
    baudRate: Number(baudRate),
    dataBits: Number(dataBits),
    stopBits: Number(stopBits),
    parity
  }

  port.on('data', handleSerialChunk)
  port.on('error', (error) => {
    console.error(`[serial:error] ${error.message}`)
  })

  port.once('close', () => {
    serialConnection = null
    serialConnectionMeta = null
    serialReceiveBuffer = Buffer.alloc(0)
    clearTimeout(serialProtocolFlushTimer)
    serialProtocolFlushTimer = null
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

ipcMain.handle('device:send-serial-command', async (_, options) => {
  const { body, expectKind = 'ack', timeoutMs = 1500 } = options || {}
  if (!body) {
    throw new Error('未提供串口指令体')
  }

  return queueSerialCommand(async () => {
    const packet = buildSerialProtocolPacket(body)
    const responsePromise = expectKind
      ? waitForSerialProtocolMessage({ kind: expectKind, timeoutMs })
      : Promise.resolve(null)

    await writeSerialPacket(packet)
    const response = await responsePromise

    if (response?.kind === 'ack' && response.status === 'ERR') {
      throw new Error('设备返回 ACK=ERR')
    }

    return {
      packet,
      response
    }
  })
})

ipcMain.handle('device:send-tcp-command', async (_, options) => {
  const { body, expectKind = 'ack', timeoutMs = 1500 } = options || {}
  if (!body) {
    throw new Error('未提供TCP指令体')
  }

  if (!tcpConnection || tcpConnection.destroyed) {
    throw new Error('TCP未连接')
  }

  return queueTcpCommand(async () => {
    const packet = buildSerialProtocolPacket(body)
    const responsePromise = expectKind
      ? waitForTcpProtocolMessage({ kind: expectKind, timeoutMs })
      : Promise.resolve(null)

    await writeTcpPacket(packet)
    broadcastTcpDebug('tx', `发送TCP指令: ${packet}`, { kind: 'command', packet })
    const response = await responsePromise

    if (response?.kind === 'ack' && response.status === 'ERR') {
      throw new Error('设备返回 ACK=ERR')
    }

    return {
      packet,
      response
    }
  })
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
    socket.on('data', handleTcpData)
    socket.once('timeout', () => finishReject(new Error('网络连接超时')))
    socket.once('error', finishReject)
    socket.once('close', () => {
      if (tcpConnection === socket) {
        tcpConnection = null
        tcpConnectionMeta = null
        tcpReceiveBuffer = ''
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

ipcMain.handle('device:open-path-in-shell', async (_, targetPath) => {
  if (!targetPath) {
    throw new Error('目标路径为空')
  }

  const result = await shell.openPath(targetPath)
  if (result) {
    throw new Error(result)
  }

  return true
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

ipcMain.handle('external:update-snapshot', async (_, snapshot) => {
  latestExternalSnapshot = {
    ...snapshot,
    exportedAt: Date.now()
  }
  externalServiceStatus.renderer.ready = true
  externalServiceStatus.renderer.lastSnapshotAt = latestExternalSnapshot.exportedAt
  updateExternalServiceStatus()
  broadcastExternalWs({
    type: 'snapshot',
    payload: latestExternalSnapshot,
    timestamp: Date.now()
  })
  return { ok: true }
})

ipcMain.handle('external:get-service-status', async () => externalServiceStatus)

ipcMain.on('external:control-response', (_, message) => {
  const waiter = externalControlWaiters.get(message?.id)
  if (!waiter) {
    return
  }

  clearTimeout(waiter.timer)
  externalControlWaiters.delete(message.id)

  if (message.ok) {
    waiter.resolve(message.result)
    return
  }

  waiter.reject(new Error(message.error || 'External control request failed'))
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

  startExternalServices()
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
  stopExternalServices()
  closeTcpConnection()
  closeSerialConnection().catch(() => {})
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
