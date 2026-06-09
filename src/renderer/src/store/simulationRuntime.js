import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  defaultPidDraft,
  normalizePidPayload,
  normalizeCascadePayload,
  normalizeHybridPayload,
  normalizeNetPayload
} from '../services/pidSimulation.js';
import { useDeviceRuntimeStore } from './deviceRuntime.js';
import { useSystemConfigStore } from './systemConfig.js';

const deviceApi = window.deviceApi;

const SERIES_STYLE_MAP = {
  furnaceTemp: { label: '炉膛温度', shortLabel: '炉膛', unit: '°C', color: '#31ddff' },
  pwm: { label: 'PWM', shortLabel: 'PWM', unit: '%', color: '#ffb347' },
  boardTemp: { label: '板载温度', shortLabel: '板载', unit: '°C', color: '#7ef7c9' }
};

const FALLBACK_SERIES_COLORS = ['#ff8a65', '#c3f73a', '#ffd166', '#b388ff', '#6ee7ff', '#f78fb3', '#95f9e3'];
const MAX_CURVE_HISTORY_POINTS = 18000;

function toNumeric(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizeControllerModeValue(mode) {
  const normalizedMode = String(mode ?? '').trim().toUpperCase();

  if (normalizedMode === '0' || normalizedMode === 'AUTO') {
    return 'AUTO';
  }

  if (normalizedMode === '1' || normalizedMode === 'MAN' || normalizedMode === 'MANUAL') {
    return 'MAN';
  }

  return normalizedMode || null;
}

function parseStateBodyFields(body) {
  if (typeof body !== 'string' || !body.startsWith('STATE=')) {
    return null;
  }

  return body.slice(6).split(',').reduce((result, entry) => {
    const separatorIndex = entry.includes(':') ? entry.indexOf(':') : entry.indexOf('=');
    if (separatorIndex < 0) {
      return result;
    }

    const key = entry.slice(0, separatorIndex).trim().toUpperCase();
    const value = entry.slice(separatorIndex + 1).trim();
    if (key) {
      result[key] = value;
    }
    return result;
  }, {});
}

function parseTenthsValue(value, fallback = Number.NaN) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue / 10 : fallback;
}

function normalizeControllerSnapshot(snapshot) {
  if (!snapshot || snapshot.kind !== 'state') {
    return snapshot;
  }

  const rawFields = parseStateBodyFields(snapshot.body);
  if (!rawFields) {
    return {
      ...snapshot,
      mode: normalizeControllerModeValue(snapshot.mode)
    };
  }

  return {
    ...snapshot,
    mode: normalizeControllerModeValue(rawFields.MODE ?? snapshot.mode),
    pwm: Number.isFinite(Number(rawFields.PWM)) ? Number(rawFields.PWM) : snapshot.pwm,
    goal: parseTenthsValue(rawFields.GOAL, snapshot.goal),
    feedback: parseTenthsValue(rawFields.FB, snapshot.feedback)
  };
}

function getSeriesStyle(key, index = 0) {
  if (key && SERIES_STYLE_MAP[key]) {
    return SERIES_STYLE_MAP[key];
  }

  const fallbackLabel = `通道${index + 1}`;
  return {
    label: fallbackLabel,
    shortLabel: fallbackLabel,
    unit: '',
    color: FALLBACK_SERIES_COLORS[index % FALLBACK_SERIES_COLORS.length]
  };
}

function createSeriesEntry({ key, index = 0, value, label, shortLabel, unit, color }) {
  const style = getSeriesStyle(key, index);
  return {
    key: key || `channel${index + 1}`,
    label: label || style.label,
    shortLabel: shortLabel || style.shortLabel,
    unit: unit ?? style.unit,
    color: color || style.color,
    value: Number(toNumeric(value).toFixed(2))
  };
}

function createCurveSample({ elapsedSeconds, timestamp, channel, temperature, requestedSetpoint, series }) {
  return {
    elapsedSeconds: Number(elapsedSeconds),
    timestamp: Number(timestamp || Date.now()),
    channel,
    temperature: Number(toNumeric(temperature).toFixed(2)),
    requestedSetpoint: Number(toNumeric(requestedSetpoint).toFixed(2)),
    series
  };
}

function createCurveSampleFromSerial(payload, elapsedSeconds, requestedSetpoint) {
  const telemetry = Array.isArray(payload.telemetry) ? payload.telemetry : [];
  const series = telemetry.length
    ? telemetry.map((entry, index) => createSeriesEntry({
      key: entry.key || `channel${entry.channel || index + 1}`,
      index,
      value: entry.value,
      label: entry.label,
      shortLabel: entry.label,
      unit: entry.unit
    }))
    : [
      createSeriesEntry({ key: 'furnaceTemp', value: payload.furnaceTemp }),
      createSeriesEntry({ key: 'pwm', value: payload.pwm }),
      createSeriesEntry({ key: 'boardTemp', value: payload.boardTemp })
    ].filter((entry) => Number.isFinite(entry.value));

  const furnaceSeries = series.find((entry) => entry.key === 'furnaceTemp') || series[0] || createSeriesEntry({ key: 'furnaceTemp', value: 0 });

  return createCurveSample({
    elapsedSeconds,
    timestamp: payload.timestamp,
    channel: 'serial',
    temperature: furnaceSeries.value,
    requestedSetpoint,
    series
  });
}

function createRecordingSessionId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export const useSimulationRuntimeStore = defineStore('simulationRuntime', () => {
  const deviceStore = useDeviceRuntimeStore();
  const configStore = useSystemConfigStore();
  let controllerRefreshTimer = null;

  const currentSamples = reactive({
    serial: null,
    ethernet: null
  });
  const curveHistory = ref([]);
  const chartPanOffset = ref(0);
  const latestPidDispatch = ref(null);
  const lastAppliedPid = ref({ ...defaultPidDraft });
  const previousAppliedPid = ref(null);
  const requestedSetpoint = ref(null);
  const runtimeStarted = ref(false);
  const serialStreamState = reactive({
    active: false,
    baselineTimestamp: 0,
    sampleIndex: 0,
    unsubscribe: null
  });
  const serialProtocolState = reactive({
    unsubscribe: null,
    lastAck: null,
    lastError: '',
    lastMessageAt: null,
    busy: false
  });
  const tcpProtocolState = reactive({
    unsubscribe: null,
    lastAck: null,
    lastError: '',
    lastMessageAt: null,
    busy: false
  });
  const ethDiag = reactive({
    link: 0,
    phy: 0,
    err: 0,
    phyId: '',
    rx: 0,
    tx: 0,
    arp: 0,
    icmp: 0,
    aneg: 0,
    tcp: 0,
    updatedAt: null
  });
  const ETH_ERR_LABELS = {
    0: '正常',
    1: 'PHY芯片无响应（检查焊接/供电/晶振）',
    2: '网线未连接',
    3: '自协商超时（RMII 50MHz时钟异常）',
    4: 'ETH未初始化'
  };
  let ethernetPollTimer = null;
  const ETHERNET_POLL_INTERVAL_MS = 1500;
  const controllerState = reactive({
    mode: null,
    pwm: null,
    goal: null,
    feedback: null,
    updatedAt: null
  });
  const batchBuffers = reactive({
    serial: [],
    ethernet: []
  });
  const sampleCounters = reactive({
    serial: 0,
    ethernet: 0
  });
  const recordingState = reactive({
    active: false,
    paused: false,
    pauseReason: '',
    lastAction: '等待录制',
    sessionId: '',
    sessionStartedAt: null
  });

  const pidDraft = computed(() => configStore.pidDraft);
  const cascadeDraft = computed(() => configStore.cascadeDraft);
  const hybridDraft = computed(() => configStore.hybridDraft);
  const netDraft = computed(() => configStore.netDraft);
  const plantDraft = computed(() => configStore.plantDraft);
  const logDirectory = computed(() => configStore.settings.logDirectory);
  const visiblePointCount = computed(() => {
    return Math.max(12, Number(configStore.settings.xAxisSecondsPerDivision) * Number(configStore.settings.xAxisDivisionCount));
  });
  const visibleCurveSamples = computed(() => {
    const history = curveHistory.value;
    if (!history.length) {
      return [];
    }

    const windowSize = visiblePointCount.value;
    const maxOffset = Math.max(0, history.length - windowSize);
    const boundedOffset = Math.min(Math.max(chartPanOffset.value, 0), maxOffset);
    const end = history.length - boundedOffset;
    const start = Math.max(0, end - windowSize);

    return history.slice(start, end);
  });
  const curvePoints = computed(() => visibleCurveSamples.value.map((item) => item.temperature));
  const visibleTimeRange = computed(() => {
    const points = visibleCurveSamples.value;
    return {
      start: points[0]?.elapsedSeconds ?? 0,
      end: points.at(-1)?.elapsedSeconds ?? 0
    };
  });
  const xAxisLabels = computed(() => {
    const divisionCount = Number(configStore.settings.xAxisDivisionCount);
    const step = Number(configStore.settings.xAxisSecondsPerDivision);
    const start = visibleTimeRange.value.start;

    return Array.from({ length: divisionCount + 1 }, (_, index) => `${Math.max(0, start + index * step)}s`);
  });
  const xAxisStepLabel = computed(() => {
    const range = visibleTimeRange.value;
    const suffix = chartPanOffset.value > 0 ? ' · 拖动回看中' : ' · 实时跟随';
    return `显示 ${range.start}s - ${range.end}s，每格 ${configStore.settings.xAxisSecondsPerDivision} s${suffix}`;
  });

  const primarySample = computed(() => {
    const primary = deviceStore.primaryChannel;
    return primary ? currentSamples[primary] || null : null;
  });

  const currentTemp = computed(() => primarySample.value?.temperature ?? controllerState.feedback);
  const targetTemp = computed(() => primarySample.value?.requestedSetpoint ?? requestedSetpoint.value ?? controllerState.goal);
  const furnaceState = computed(() => {
    if (!deviceStore.primaryChannel) {
      return '待连接';
    }

    if (!primarySample.value) {
      if (controllerState.mode === 'MAN') {
        return '手动输出';
      }

      return controllerState.mode === 'AUTO' ? '自动待采样' : '无数据';
    }

    if (controllerState.mode === 'MAN') {
      return '手动输出';
    }

    if ((primarySample.value?.controlOutput || 0) > 52) {
      return '升温运行';
    }

    if (Math.abs((primarySample.value?.requestedSetpoint || 0) - (primarySample.value?.temperature || 0)) < 3) {
      return '恒温保温';
    }

    return '调节追踪';
  });

  const currentMetrics = computed(() => {
    if (!primarySample.value) {
      return {
        overshootPercent: 0,
        settlingTime: '--',
        controlOutput: Number(toNumeric(controllerState.pwm, 0).toFixed(1)),
        disturbance: 0
      };
    }

    return {
      overshootPercent: primarySample.value.overshootPercent,
      settlingTime: primarySample.value.settlingTime ?? '--',
      controlOutput: primarySample.value.controlOutput,
      disturbance: primarySample.value.disturbance
    };
  });

  const recordingStatusText = computed(() => {
    if (recordingState.active && !recordingState.paused) {
      return '录制中';
    }

    if (recordingState.active && recordingState.paused) {
      return `已暂停${recordingState.pauseReason ? ` · ${recordingState.pauseReason}` : ''}`;
    }

    return '未录制';
  });

  const canStartRecording = computed(() => !recordingState.active || (recordingState.active && recordingState.paused));
  const canPauseRecording = computed(() => recordingState.active && !recordingState.paused);
  const canStopRecording = computed(() => recordingState.active || recordingState.paused);

  function resizeCurve() {
    const history = curveHistory.value;
    if (!history.length) {
      chartPanOffset.value = 0;
      return;
    }

    const maxOffset = Math.max(0, history.length - visiblePointCount.value);
    chartPanOffset.value = Math.min(chartPanOffset.value, maxOffset);
  }

  function appendCurveSample(sample) {
    curveHistory.value.push(sample);

    if (curveHistory.value.length > MAX_CURVE_HISTORY_POINTS) {
      curveHistory.value.splice(0, curveHistory.value.length - MAX_CURVE_HISTORY_POINTS);
    }
  }

  function panChartWindow(deltaPoints) {
    const maxOffset = Math.max(0, curveHistory.value.length - visiblePointCount.value);
    chartPanOffset.value = Math.min(maxOffset, Math.max(0, chartPanOffset.value + Number(deltaPoints || 0)));
  }

  function jumpChartToLatest() {
    chartPanOffset.value = 0;
  }

  function applyControllerState(snapshot) {
    const normalizedSnapshot = normalizeControllerSnapshot(snapshot);

    controllerState.mode = normalizedSnapshot.mode || controllerState.mode;
    controllerState.pwm = Number.isFinite(normalizedSnapshot.pwm) ? normalizedSnapshot.pwm : controllerState.pwm;
    controllerState.goal = Number.isFinite(normalizedSnapshot.goal) ? normalizedSnapshot.goal : controllerState.goal;
    controllerState.feedback = Number.isFinite(normalizedSnapshot.feedback) ? normalizedSnapshot.feedback : controllerState.feedback;
    controllerState.updatedAt = Date.now();

    if (Number.isFinite(normalizedSnapshot.goal)) {
      requestedSetpoint.value = normalizedSnapshot.goal;
    }

    if (currentSamples.serial) {
      currentSamples.serial = {
        ...currentSamples.serial,
        requestedSetpoint: Number.isFinite(normalizedSnapshot.goal) ? normalizedSnapshot.goal : currentSamples.serial.requestedSetpoint,
        controlOutput: Number.isFinite(normalizedSnapshot.pwm) ? normalizedSnapshot.pwm : currentSamples.serial.controlOutput,
        temperature: Number.isFinite(normalizedSnapshot.feedback) ? normalizedSnapshot.feedback : currentSamples.serial.temperature,
        mode: normalizedSnapshot.mode || currentSamples.serial.mode
      };
    }
  }

  function applyQueriedPid(snapshot) {
    if (!Number.isFinite(snapshot.kp) || !Number.isFinite(snapshot.ki) || !Number.isFinite(snapshot.kd)) {
      return;
    }

    const normalizedPid = normalizePidPayload({
      ...configStore.pidDraft,
      kp: snapshot.kp,
      ki: snapshot.ki,
      kd: snapshot.kd
    });

    Object.assign(configStore.pidDraft, normalizedPid);
    lastAppliedPid.value = { ...normalizedPid };
  }

  function handleSerialProtocolMessage(payload) {
    if (!payload) {
      return;
    }

    console.log('[serial-protocol]', payload);

    serialProtocolState.lastMessageAt = payload.timestamp || Date.now();

    if (payload.kind === 'ack') {
      serialProtocolState.lastAck = payload.status;
      if (payload.status === 'ERR') {
        serialProtocolState.lastError = '设备返回 ACK=ERR';
      }
      return;
    }

    if (payload.kind === 'state') {
      const normalizedPayload = normalizeControllerSnapshot(payload);
      console.log('[serial-protocol:normalized-state]', normalizedPayload);
      applyControllerState(normalizedPayload);
      return;
    }

    if (payload.kind === 'pid') {
      applyQueriedPid(payload);
    }

    if (payload.kind === 'cascade') {
      Object.assign(configStore.cascadeDraft, normalizeCascadePayload({
        kOuter: payload.kOuter,
        maxRate: payload.maxRate,
        kpInner: payload.kpInner,
        kiInner: payload.kiInner
      }));
    }

    if (payload.kind === 'hybrid') {
      Object.assign(configStore.hybridDraft, normalizeHybridPayload({
        threshold: payload.threshold,
        kp: payload.kp,
        ki: payload.ki,
        kd: payload.kd,
        slowInterval: payload.slowInterval
      }));
    }

    if (payload.kind === 'net') {
      Object.assign(configStore.netDraft, normalizeNetPayload({
        ip: payload.ip,
        gateway: payload.gateway,
        netmask: payload.netmask,
        port: payload.port
      }));
    }

    if (payload.kind === 'eth') {
      applyEthDiag(payload);
    }
  }

  function applyEthDiag(payload) {
    ethDiag.link = Number.isFinite(payload.link) ? payload.link : 0;
    ethDiag.phy = Number.isFinite(payload.phy) ? payload.phy : 0;
    ethDiag.err = Number.isFinite(payload.err) ? payload.err : 0;
    ethDiag.phyId = payload.phyId ?? '';
    ethDiag.rx = Number.isFinite(payload.rx) ? payload.rx : 0;
    ethDiag.tx = Number.isFinite(payload.tx) ? payload.tx : 0;
    ethDiag.arp = Number.isFinite(payload.arp) ? payload.arp : 0;
    ethDiag.icmp = Number.isFinite(payload.icmp) ? payload.icmp : 0;
    ethDiag.aneg = Number.isFinite(payload.aneg) ? payload.aneg : 0;
    ethDiag.tcp = Number.isFinite(payload.tcp) ? payload.tcp : 0;
    ethDiag.updatedAt = Date.now();
  }

  function handleTcpProtocolMessage(payload) {
    if (!payload) {
      return;
    }

    console.log('[tcp-protocol]', payload);

    tcpProtocolState.lastMessageAt = payload.timestamp || Date.now();

    if (payload.kind === 'ack') {
      tcpProtocolState.lastAck = payload.status;
      if (payload.status === 'ERR') {
        tcpProtocolState.lastError = '设备返回 ACK=ERR';
      }
      return;
    }

    if (payload.kind === 'state') {
      const normalizedPayload = normalizeControllerSnapshot(payload);
      applyControllerState(normalizedPayload);

      // Feed ethernet STATE response into chart when ethernet is primary
      if (deviceStore.primaryChannel === 'ethernet') {
        ingestEthernetStateSample(normalizedPayload);
      }
      return;
    }

    if (payload.kind === 'pid') {
      applyQueriedPid(payload);
    }

    if (payload.kind === 'cascade') {
      Object.assign(configStore.cascadeDraft, normalizeCascadePayload({
        kOuter: payload.kOuter,
        maxRate: payload.maxRate,
        kpInner: payload.kpInner,
        kiInner: payload.kiInner
      }));
    }

    if (payload.kind === 'hybrid') {
      Object.assign(configStore.hybridDraft, normalizeHybridPayload({
        threshold: payload.threshold,
        kp: payload.kp,
        ki: payload.ki,
        kd: payload.kd,
        slowInterval: payload.slowInterval
      }));
    }

    if (payload.kind === 'net') {
      Object.assign(configStore.netDraft, normalizeNetPayload({
        ip: payload.ip,
        gateway: payload.gateway,
        netmask: payload.netmask,
        port: payload.port
      }));
    }

    if (payload.kind === 'eth') {
      applyEthDiag(payload);
    }
  }

  function ingestEthernetStateSample(payload) {
    if (!deviceStore.ethernetConnected) {
      return;
    }

    const timestamp = Date.now();
    const normalizedSetpoint = controllerState.goal ?? requestedSetpoint.value ?? 0;
    const sample = {
      channel: 'ethernet',
      timestamp,
      elapsedSeconds: Math.round((timestamp - (currentSamples.ethernet?.baselineTimestamp || timestamp)) / 1000),
      sampleIndex: (currentSamples.ethernet?.sampleIndex || 0) + 1,
      temperature: Number.isFinite(payload.feedback) ? payload.feedback : (currentSamples.ethernet?.temperature ?? 0),
      setpoint: normalizedSetpoint,
      requestedSetpoint: normalizedSetpoint,
      controlOutput: Number.isFinite(payload.pwm) ? payload.pwm : (currentSamples.ethernet?.controlOutput ?? 0),
      disturbance: Number(currentSamples.ethernet?.disturbance || 0),
      overshootPercent: Number(currentSamples.ethernet?.overshootPercent || 0),
      settlingTime: currentSamples.ethernet?.settlingTime ?? null,
      mode: payload.mode || controllerState.mode || 'ethernet-live',
      kp: Number(lastAppliedPid.value.kp),
      ki: Number(lastAppliedPid.value.ki),
      kd: Number(lastAppliedPid.value.kd),
      sampleTime: 1,
      outputLimit: 100,
      deadband: 0,
      setpointRamp: 0,
      xAxisSecondsPerDivision: Number(configStore.settings.xAxisSecondsPerDivision),
      boardTemperature: 0,
      telemetry: [],
      baselineTimestamp: currentSamples.ethernet?.baselineTimestamp || timestamp
    };

    currentSamples.ethernet = sample;
    controllerState.feedback = sample.temperature;
    controllerState.pwm = sample.controlOutput;
    queueRecordedSample('ethernet', sample);

    if (deviceStore.primaryChannel === 'ethernet') {
      const series = [
        createSeriesEntry({ key: 'furnaceTemp', value: sample.temperature }),
        createSeriesEntry({ key: 'pwm', value: sample.controlOutput })
      ];
      appendCurveSample(createCurveSample({
        elapsedSeconds: sample.elapsedSeconds,
        timestamp,
        channel: 'ethernet',
        temperature: sample.temperature,
        requestedSetpoint: normalizedSetpoint,
        series
      }));
    }
  }

  function startEthernetPolling() {
    stopEthernetPolling();
    ethernetPollTimer = window.setInterval(async () => {
      if (!deviceStore.ethernetConnected || deviceStore.primaryChannel !== 'ethernet') {
        return;
      }
      try {
        await refreshControllerState({ silent: true, channel: 'ethernet' });
      } catch {
        // silently ignore polling failures
      }
    }, ETHERNET_POLL_INTERVAL_MS);
  }

  function stopEthernetPolling() {
    if (ethernetPollTimer) {
      window.clearInterval(ethernetPollTimer);
      ethernetPollTimer = null;
    }
  }

  function attachTcpProtocolListener() {
    if (!deviceApi?.onTcpProtocol || tcpProtocolState.unsubscribe) {
      return;
    }

    tcpProtocolState.unsubscribe = deviceApi.onTcpProtocol((payload) => {
      handleTcpProtocolMessage(payload);
    });
  }

  function detachTcpProtocolListener() {
    tcpProtocolState.unsubscribe?.();
    tcpProtocolState.unsubscribe = null;
  }

  function attachSerialProtocolListener() {
    if (!deviceApi?.onSerialProtocol || serialProtocolState.unsubscribe) {
      return;
    }

    serialProtocolState.unsubscribe = deviceApi.onSerialProtocol((payload) => {
      handleSerialProtocolMessage(payload);
    });
  }

  function detachSerialProtocolListener() {
    serialProtocolState.unsubscribe?.();
    serialProtocolState.unsubscribe = null;
  }

  function resolveChannel(channel) {
    return channel || deviceStore.primaryChannel || 'serial';
  }

  function ensureChannelAvailable(channel, actionText) {
    if (channel === 'ethernet') {
      if (!deviceApi?.sendTcpCommand) {
        throw new Error('当前环境未提供TCP控制能力');
      }
      if (!deviceStore.ethernetConnected) {
        throw new Error(`请先连接网口，再执行${actionText}`);
      }
      return;
    }

    if (!deviceApi?.sendSerialCommand) {
      throw new Error('当前环境未提供真实串口控制能力');
    }
    if (!deviceStore.serialConnected) {
      throw new Error(`请先连接串口，再执行${actionText}`);
    }
  }

  async function sendChannelCommand(body, expectKind = 'ack', actionText = '指令下发', channel = null) {
    const targetChannel = resolveChannel(channel);
    ensureChannelAvailable(targetChannel, actionText);

    const isEthernet = targetChannel === 'ethernet';
    const protocolState = isEthernet ? tcpProtocolState : serialProtocolState;
    const sendApi = isEthernet ? deviceApi.sendTcpCommand : deviceApi.sendSerialCommand;

    protocolState.busy = true;
    protocolState.lastError = '';

    try {
      const result = await sendApi({
        body,
        expectKind,
        timeoutMs: expectKind === 'ack' ? 1600 : 1800
      });

      if (result?.response) {
        if (isEthernet) {
          handleTcpProtocolMessage(result.response);
        } else {
          handleSerialProtocolMessage(result.response);
        }
      }

      const channelLabel = isEthernet ? '网口' : '串口';
      deviceStore.appendEvent(`已发送${channelLabel}指令：${body}`);
      return result?.response || null;
    } catch (error) {
      protocolState.lastError = error.message || '未知错误';
      throw error;
    } finally {
      protocolState.busy = false;
    }
  }

  async function refreshControllerState({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=STATE', 'state', '状态查询', channel);
      console.log('[refresh-controller-state:response]', response);
      console.log('[refresh-controller-state:normalized]', normalizeControllerSnapshot(response));
      if (!silent) {
        deviceStore.pushAlert({
          tone: 'success',
          title: '状态已同步',
          message: '已读取控制器当前模式、PWM、目标温度和反馈温度。'
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: '状态查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`状态查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshPidParameters({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=PID', 'pid', 'PID 查询', channel);
      if (!silent) {
        deviceStore.pushAlert({
          tone: 'success',
          title: 'PID 已同步',
          message: '已读取设备内当前 PID 参数。'
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: 'PID 查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`PID 查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshCascadeParams({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=CASCADE', 'cascade', '级联参数查询', channel);
      if (response?.kind === 'cascade') {
        Object.assign(configStore.cascadeDraft, normalizeCascadePayload({
          kOuter: response.kOuter,
          maxRate: response.maxRate,
          kpInner: response.kpInner,
          kiInner: response.kiInner
        }));
      }
      if (!silent) {
        deviceStore.pushAlert({
          tone: 'success',
          title: '级联参数已同步',
          message: '已读取设备内当前级联控制器参数。'
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: '级联参数查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`级联参数查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshHybridParams({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=HYBRID', 'hybrid', '混合参数查询', channel);
      if (response?.kind === 'hybrid') {
        Object.assign(configStore.hybridDraft, normalizeHybridPayload({
          threshold: response.threshold,
          kp: response.kp,
          ki: response.ki,
          kd: response.kd,
          slowInterval: response.slowInterval
        }));
      }
      if (!silent) {
        deviceStore.pushAlert({
          tone: 'success',
          title: '混合参数已同步',
          message: '已读取设备内当前混合控制器参数。'
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: '混合参数查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`混合参数查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshNetConfig({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=NET', 'net', '网络配置查询', channel);
      if (response?.kind === 'net') {
        Object.assign(configStore.netDraft, normalizeNetPayload({
          ip: response.ip,
          gateway: response.gateway,
          netmask: response.netmask,
          port: response.port
        }));
      }
      if (!silent) {
        deviceStore.pushAlert({
          tone: 'success',
          title: '网络配置已同步',
          message: '已读取设备内当前网络配置参数。'
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: '网络配置查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`网络配置查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshEthDiag({ silent = false, channel = null } = {}) {
    try {
      const response = await sendChannelCommand('GET=ETH', 'eth', 'ETH诊断查询', channel);
      if (response?.kind === 'eth') {
        applyEthDiag(response);
      }
      if (!silent) {
        const errLabel = ETH_ERR_LABELS[ethDiag.err] || '未知';
        deviceStore.pushAlert({
          tone: ethDiag.err === 0 ? 'success' : 'warning',
          title: 'ETH诊断已更新',
          message: `LINK=${ethDiag.link} TCP=${ethDiag.tcp} ERR=${ethDiag.err} (${errLabel})`
        });
      }
      return response;
    } catch (error) {
      if (!silent) {
        deviceStore.pushAlert({ tone: 'danger', title: 'ETH诊断查询失败', message: error.message || '未知错误' });
      }
      deviceStore.appendEvent(`ETH诊断查询失败：${error.message}`);
      return null;
    }
  }

  async function refreshControllerSnapshot({ silent = false } = {}) {
    await refreshControllerState({ silent });
    await refreshPidParameters({ silent });
  }

  function scheduleControllerStateRefresh(delayMs = 450) {
    if (controllerRefreshTimer) {
      window.clearTimeout(controllerRefreshTimer);
    }

    controllerRefreshTimer = window.setTimeout(() => {
      controllerRefreshTimer = null;
      refreshControllerState({ silent: true });
    }, delayMs);
  }

  async function setControllerMode(mode, channel = null) {
    const normalizedMode = String(mode || '').toUpperCase();
    if (!['AUTO', 'MAN'].includes(normalizedMode)) {
      return false;
    }

    try {
      await sendChannelCommand(`MODE=${normalizedMode}`, 'ack', '模式切换', channel);
      applyControllerState({ mode: normalizedMode });
      scheduleControllerStateRefresh();
      deviceStore.pushAlert({
        tone: 'success',
        title: '模式切换成功',
        message: `控制器已切换到${normalizedMode === 'AUTO' ? '自动' : '手动'}模式。`
      });
      return true;
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '模式切换失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`模式切换失败：${error.message}`);
      return false;
    }
  }

  async function applyManualPwm(value, channel = null) {
    const normalizedPwm = Math.max(-100, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(normalizedPwm)) {
      deviceStore.pushAlert({ tone: 'warning', title: 'PWM 未下发', message: '请输入有效的 PWM 数值。' });
      return false;
    }

    try {
      await sendChannelCommand(`PWM=${normalizedPwm}`, 'ack', 'PWM 下发', channel);
      applyControllerState({ pwm: normalizedPwm });
      scheduleControllerStateRefresh();
      deviceStore.pushAlert({
        tone: 'success',
        title: 'PWM 已下发',
        message: `手动输出已更新为 ${normalizedPwm}%。`
      });
      return true;
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: 'PWM 下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`PWM 下发失败：${error.message}`);
      return false;
    }
  }

  async function openRecordingDirectory() {
    const directory = await ensureLogDirectory();
    if (!directory) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: '无法打开目录',
        message: '当前没有可用的录制目录。'
      });
      return false;
    }

    if (!deviceApi?.openPathInShell) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: '无法打开目录',
        message: '当前环境未提供打开文件夹能力。'
      });
      return false;
    }

    try {
      await deviceApi.openPathInShell(directory);
      return true;
    } catch (error) {
      deviceStore.pushAlert({
        tone: 'danger',
        title: '打开目录失败',
        message: error.message || '未能打开录制目录。'
      });
      return false;
    }
  }

  function queueRecordedSample(channel, sample) {
    if (configStore.settings.csvEnabled && recordingState.active && !recordingState.paused) {
      batchBuffers[channel].push(sample);
    }

    if (batchBuffers[channel].length >= 5) {
      flushChannelBatch(channel);
    }
  }

  function ingestSerialFrame(payload) {
    if (!deviceStore.serialConnected || !payload) {
      return;
    }

    const timestamp = toNumeric(payload.timestamp, Date.now());

    if (!serialStreamState.active) {
      serialStreamState.active = true;
      serialStreamState.baselineTimestamp = timestamp;
      serialStreamState.sampleIndex = 0;

      if (deviceStore.primaryChannel === 'serial') {
        curveHistory.value = [];
        chartPanOffset.value = 0;
      }

      deviceStore.appendEvent('已接收 STM32 串口实时遥测');
    }

    serialStreamState.sampleIndex += 1;
    const elapsedSeconds = Math.max(
      serialStreamState.sampleIndex,
      Math.round((timestamp - serialStreamState.baselineTimestamp) / 1000)
    );
    const normalizedSetpoint = currentSamples.serial?.requestedSetpoint ?? controllerState.goal ?? requestedSetpoint.value ?? 0;
    const sample = {
      channel: 'serial',
      timestamp,
      elapsedSeconds,
      sampleIndex: serialStreamState.sampleIndex,
      temperature: Number(toNumeric(payload.furnaceTemp, currentSamples.serial?.temperature ?? 0).toFixed(2)),
      setpoint: normalizedSetpoint,
      requestedSetpoint: normalizedSetpoint,
      controlOutput: Number(toNumeric(payload.pwm, currentSamples.serial?.controlOutput ?? 0).toFixed(2)),
      disturbance: Number(toNumeric(currentSamples.serial?.disturbance, 0).toFixed(3)),
      overshootPercent: Number(toNumeric(currentSamples.serial?.overshootPercent, 0).toFixed(2)),
      settlingTime: currentSamples.serial?.settlingTime ?? null,
      mode: controllerState.mode || 'serial-live',
      kp: Number(lastAppliedPid.value.kp),
      ki: Number(lastAppliedPid.value.ki),
      kd: Number(lastAppliedPid.value.kd),
      sampleTime: 1,
      outputLimit: 100,
      deadband: 0,
      setpointRamp: 0,
      xAxisSecondsPerDivision: Number(configStore.settings.xAxisSecondsPerDivision),
      boardTemperature: Number(toNumeric(payload.boardTemp, 0).toFixed(2)),
      telemetry: Array.isArray(payload.telemetry) ? payload.telemetry : []
    };

    currentSamples.serial = sample;
    requestedSetpoint.value = sample.requestedSetpoint;
    controllerState.feedback = sample.temperature;
    controllerState.pwm = sample.controlOutput;
    queueRecordedSample('serial', sample);

    if (deviceStore.primaryChannel === 'serial') {
      appendCurveSample(createCurveSampleFromSerial(payload, elapsedSeconds, normalizedSetpoint));
    }
  }

  function attachSerialFrameListener() {
    if (!deviceApi || serialStreamState.unsubscribe) {
      return;
    }

    serialStreamState.unsubscribe = deviceApi.onSerialFrame((payload) => {
      ingestSerialFrame(payload);
    });
  }

  function detachSerialFrameListener() {
    serialStreamState.unsubscribe?.();
    serialStreamState.unsubscribe = null;
  }

  function hasActiveConnection() {
    return deviceStore.serialConnected || deviceStore.ethernetConnected;
  }

  async function ensureLogDirectory() {
    if (!configStore.settings.csvEnabled) {
      return '';
    }

    if (configStore.settings.logDirectory) {
      return configStore.settings.logDirectory;
    }

    try {
      return await configStore.ensureDefaultLogDirectory();
    } catch (error) {
      deviceStore.appendEvent(`日志目录读取失败：${error.message}`);
      return '';
    }
  }

  async function flushChannelBatch(channel) {
    if (!deviceApi || batchBuffers[channel].length === 0 || !configStore.settings.csvEnabled || !recordingState.sessionId) {
      return;
    }

    const rows = batchBuffers[channel].map((row) => ({
      channel: row.channel,
      timestamp: Number(row.timestamp),
      elapsedSeconds: Number(row.elapsedSeconds),
      temperature: Number(row.temperature),
      setpoint: Number(row.setpoint),
      requestedSetpoint: Number(row.requestedSetpoint),
      controlOutput: Number(row.controlOutput),
      disturbance: Number(row.disturbance),
      overshootPercent: Number(row.overshootPercent),
      settlingTime: row.settlingTime ?? null,
      mode: row.mode,
      kp: Number(row.kp),
      ki: Number(row.ki),
      kd: Number(row.kd),
      sampleTime: Number(row.sampleTime),
      outputLimit: Number(row.outputLimit),
      deadband: Number(row.deadband),
      setpointRamp: Number(row.setpointRamp),
      sampleIndex: Number(row.sampleIndex),
      xAxisSecondsPerDivision: Number(row.xAxisSecondsPerDivision)
    }));
    batchBuffers[channel] = [];
    const directory = await ensureLogDirectory();
    if (!directory) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: 'CSV 未写入',
        message: '当前未设置有效的 CSV 存储目录，系统已保留内存数据但未落盘。'
      });
      return;
    }

    try {
      await deviceApi.appendChannelSamples({
        channel,
        rows,
        directory,
        sessionId: recordingState.sessionId
      });
    } catch (error) {
      deviceStore.appendEvent(`${channel === 'serial' ? '串口' : '网口'} CSV 记录失败：${error.message}`);
      deviceStore.pushAlert({
        tone: 'danger',
        title: 'CSV 写入失败',
        message: `${channel === 'serial' ? '串口' : '网口'}记录未能写入：${error.message}`
      });
    }
  }

  async function startRecordingSession(reason = 'manual') {
    if (!configStore.settings.csvEnabled) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: '录制未开始',
        message: '请先启用 CSV 录制开关，再开始记录。'
      });
      return false;
    }

    const directory = await ensureLogDirectory();
    if (!directory) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: '录制未开始',
        message: '当前没有可用的 CSV 保存路径。'
      });
      return false;
    }

    await Promise.all([flushChannelBatch('serial'), flushChannelBatch('ethernet')]);
    batchBuffers.serial = [];
    batchBuffers.ethernet = [];
    sampleCounters.serial = 0;
    sampleCounters.ethernet = 0;
    recordingState.active = true;
    recordingState.paused = false;
    recordingState.pauseReason = '';
    recordingState.sessionId = createRecordingSessionId();
    recordingState.sessionStartedAt = Date.now();
    recordingState.lastAction = reason === 'auto' ? '自动开始录制' : '手动开始录制';
    deviceStore.appendEvent(`${recordingState.lastAction}：${recordingState.sessionId}`);
    return true;
  }

  function pauseRecording(reason = 'manual') {
    if (!recordingState.active || recordingState.paused) {
      return;
    }

    recordingState.paused = true;
    recordingState.pauseReason = reason === 'disconnect' ? '通道断连' : '手动暂停';
    recordingState.lastAction = recordingState.pauseReason;
    deviceStore.appendEvent(`录制已暂停：${recordingState.pauseReason}`);
  }

  async function resumeRecording(reason = 'manual') {
    if (!recordingState.active || !recordingState.paused) {
      return;
    }

    recordingState.paused = false;
    recordingState.pauseReason = '';
    recordingState.lastAction = reason === 'reconnect' ? '通道恢复后自动继续录制' : '手动恢复录制';
    deviceStore.appendEvent(recordingState.lastAction);
  }

  async function stopRecordingSession(reason = 'manual') {
    if (!recordingState.active && !recordingState.paused) {
      return;
    }

    const finishedSessionId = recordingState.sessionId;
    const directory = await ensureLogDirectory();
    await Promise.all([flushChannelBatch('serial'), flushChannelBatch('ethernet')]);
    recordingState.active = false;
    recordingState.paused = false;
    recordingState.pauseReason = '';
    recordingState.lastAction = reason === 'disconnect' ? '断连后结束录制' : '录制已结束';
    recordingState.sessionId = '';
    recordingState.sessionStartedAt = null;
    deviceStore.appendEvent(recordingState.lastAction);

    if (reason !== 'disconnect') {
      deviceStore.pushAlert({
        tone: 'success',
        title: '录制完成',
        message: finishedSessionId
          ? `会话 ${finishedSessionId} 已结束，录制文件已写入保存目录。`
          : '录制已结束，录制文件已写入保存目录。',
        ttl: 0,
        actionLabel: directory ? '打开文件夹' : '',
        action: directory ? () => openRecordingDirectory() : null
      });
    }
  }

  async function reconcileRecordingLifecycle() {
    const connected = hasActiveConnection();

    if (connected) {
      if (configStore.settings.autoRecordingEnabled && !recordingState.active && !recordingState.paused) {
        await startRecordingSession('auto');
      }

      if (recordingState.active && recordingState.paused && recordingState.pauseReason === '通道断连') {
        await resumeRecording('reconnect');
      }

      return;
    }

    if (recordingState.active && configStore.settings.autoPauseOnDisconnect) {
      pauseRecording('disconnect');
    }
  }

  async function ensureRunning() {
    if (runtimeStarted.value) {
      return;
    }

    runtimeStarted.value = true;
    resizeCurve();
    attachSerialFrameListener();
    attachSerialProtocolListener();
    attachTcpProtocolListener();
    await ensureLogDirectory();
    await reconcileRecordingLifecycle();
    if (deviceStore.serialConnected) {
      await refreshControllerSnapshot({ silent: true });
    }
    if (deviceStore.ethernetConnected && deviceStore.primaryChannel === 'ethernet') {
      startEthernetPolling();
    }
  }

  async function stopRuntime() {
    runtimeStarted.value = false;
    stopEthernetPolling();
    if (controllerRefreshTimer) {
      window.clearTimeout(controllerRefreshTimer);
      controllerRefreshTimer = null;
    }
    detachSerialFrameListener();
    detachSerialProtocolListener();
    detachTcpProtocolListener();
    await Promise.all([flushChannelBatch('serial'), flushChannelBatch('ethernet')]);
  }

  function applyProfile(profile) {
    configStore.pidDraft.kp = Number(profile.kp);
    configStore.pidDraft.ki = Number(profile.ki);
    configStore.pidDraft.kd = Number(profile.kd);
  }

  function resetPidDraft() {
    Object.assign(configStore.pidDraft, defaultPidDraft);
  }

  function syncDraftToChannels() {
    lastAppliedPid.value = normalizePidPayload(configStore.pidDraft);
  }

  function applyPlantDraft() {
    deviceStore.pushAlert({
      tone: 'success',
      title: '工艺参数已保存',
      message: '被控对象参数已更新，后续联调时将按这组参数使用。'
    });
    deviceStore.appendEvent('被控对象参数已更新');
  }

  function setTargetTemperature(value) {
    if (value === '' || value === null || value === undefined) {
      return;
    }

    const normalizedTarget = Number(value);
    if (!Number.isFinite(normalizedTarget)) {
      return;
    }

    const clampedTarget = Math.min(1200, Math.max(0, normalizedTarget));
    requestedSetpoint.value = clampedTarget;

    if (currentSamples.serial) {
      currentSamples.serial = {
        ...currentSamples.serial,
        requestedSetpoint: clampedTarget
      };
    }

    if (currentSamples.ethernet) {
      currentSamples.ethernet = {
        ...currentSamples.ethernet,
        requestedSetpoint: clampedTarget
      };
    }
  }

  async function commitTargetTemperature(value = requestedSetpoint.value, channel = null) {
    if (value === '' || value === null || value === undefined) {
      deviceStore.pushAlert({ tone: 'warning', title: '目标温度未下发', message: '请输入有效的目标温度。' });
      return false;
    }

    const normalizedTarget = Number(value);
    if (!Number.isFinite(normalizedTarget)) {
      deviceStore.pushAlert({ tone: 'warning', title: '目标温度未下发', message: '请输入有效的目标温度。' });
      return false;
    }

    const clampedTarget = Math.min(1200, Math.max(0, normalizedTarget));
    try {
      await sendChannelCommand(`TEMP=${clampedTarget.toFixed(1)}`, 'ack', '目标温度下发', channel);
      applyControllerState({ goal: clampedTarget });
      scheduleControllerStateRefresh();
      deviceStore.pushAlert({
        tone: 'success',
        title: '目标温度已下发',
        message: `自动模式目标温度已更新为 ${clampedTarget.toFixed(1)} °C。`
      });
      return true;
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '目标温度下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`目标温度下发失败：${error.message}`);
      return false;
    }
  }

  async function dispatchPidParameters(channel = null) {
    const targetChannel = resolveChannel(channel);
    const normalizedPid = normalizePidPayload(configStore.pidDraft);
    Object.assign(configStore.pidDraft, normalizedPid);

    try {
      await sendChannelCommand(
        `PID=${normalizedPid.kp.toFixed(4)},${normalizedPid.ki.toFixed(4)},${normalizedPid.kd.toFixed(4)}`,
        'ack',
        'PID 参数下发',
        targetChannel
      );

      previousAppliedPid.value = { ...lastAppliedPid.value };
      lastAppliedPid.value = { ...normalizedPid };
      latestPidDispatch.value = {
        channel: targetChannel,
        timestamp: Date.now(),
        payload: { ...normalizedPid }
      };
      await refreshPidParameters({ silent: true, channel: targetChannel });
      const channelLabel = targetChannel === 'ethernet' ? '网口' : '串口';
      deviceStore.appendEvent(
        `PID 参数已下发到${channelLabel}控制器：Kp ${normalizedPid.kp.toFixed(4)} / Ki ${normalizedPid.ki.toFixed(4)} / Kd ${normalizedPid.kd.toFixed(4)}`
      );
      deviceStore.pushAlert({
        tone: 'success',
        title: 'PID 参数更新成功',
        message: `已更新${channelLabel}控制器 PID 参数。`
      });
      return { applied: true, channel: targetChannel };
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: 'PID 参数下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`PID 参数下发失败：${error.message}`);
      return { applied: false };
    }
  }

  async function dispatchCascadeParams(channel = null) {
    const targetChannel = resolveChannel(channel);
    const normalized = normalizeCascadePayload(configStore.cascadeDraft);
    Object.assign(configStore.cascadeDraft, normalized);

    try {
      await sendChannelCommand(
        `CASCADE=${normalized.kOuter.toFixed(2)},${normalized.maxRate.toFixed(2)},${normalized.kpInner.toFixed(2)},${normalized.kiInner.toFixed(2)}`,
        'ack',
        '级联参数下发',
        targetChannel
      );

      const channelLabel = targetChannel === 'ethernet' ? '网口' : '串口';
      deviceStore.appendEvent(
        `级联参数已下发到${channelLabel}控制器：K_outer ${normalized.kOuter} / MaxRate ${normalized.maxRate} / Kp_inner ${normalized.kpInner} / Ki_inner ${normalized.kiInner}`
      );
      deviceStore.pushAlert({
        tone: 'success',
        title: '级联参数已下发',
        message: `已更新${channelLabel}控制器级联参数。`
      });
      return { applied: true, channel: targetChannel };
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '级联参数下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`级联参数下发失败：${error.message}`);
      return { applied: false };
    }
  }

  async function dispatchHybridParams(channel = null) {
    const targetChannel = resolveChannel(channel);
    const normalized = normalizeHybridPayload(configStore.hybridDraft);
    Object.assign(configStore.hybridDraft, normalized);

    try {
      await sendChannelCommand(
        `HYBRID=${normalized.threshold.toFixed(2)},${normalized.kp.toFixed(2)},${normalized.ki.toFixed(3)},${normalized.kd.toFixed(2)},${normalized.slowInterval}`,
        'ack',
        '混合参数下发',
        targetChannel
      );

      const channelLabel = targetChannel === 'ethernet' ? '网口' : '串口';
      deviceStore.appendEvent(
        `混合参数已下发到${channelLabel}控制器：TH ${normalized.threshold} / Kp ${normalized.kp} / Ki ${normalized.ki} / Kd ${normalized.kd} / 慢速间隔 ${normalized.slowInterval}s`
      );
      deviceStore.pushAlert({
        tone: 'success',
        title: '混合参数已下发',
        message: `已更新${channelLabel}控制器混合参数。`
      });
      return { applied: true, channel: targetChannel };
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '混合参数下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`混合参数下发失败：${error.message}`);
      return { applied: false };
    }
  }

  async function dispatchNetConfig(channel = null) {
    const targetChannel = resolveChannel(channel);
    const normalized = normalizeNetPayload(configStore.netDraft);
    Object.assign(configStore.netDraft, normalized);

    try {
      await sendChannelCommand(
        `NET=${normalized.ip},${normalized.gateway},${normalized.netmask},${normalized.port}`,
        'ack',
        '网络配置下发',
        targetChannel
      );

      const channelLabel = targetChannel === 'ethernet' ? '网口' : '串口';
      deviceStore.appendEvent(
        `网络配置已下发到${channelLabel}：IP ${normalized.ip} / GW ${normalized.gateway} / NM ${normalized.netmask} / Port ${normalized.port}`
      );
      deviceStore.pushAlert({
        tone: 'success',
        title: '网络配置已下发',
        message: `已更新设备网络配置（重启后生效）。`
      });
      return { applied: true, channel: targetChannel };
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '网络配置下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`网络配置下发失败：${error.message}`);
      return { applied: false };
    }
  }

  async function dispatchSaveConfig(channel = null) {
    try {
      await sendChannelCommand('SAVE', 'ack', '保存配置', channel);
      const channelLabel = (channel || deviceStore.primaryChannel) === 'ethernet' ? '网口' : '串口';
      deviceStore.pushAlert({
        tone: 'success',
        title: '配置已保存',
        message: `已通过${channelLabel}保存当前配置到设备 Flash。`
      });
      deviceStore.appendEvent('配置已保存到设备 Flash');
      return true;
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '保存配置失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`保存配置失败：${error.message}`);
      return false;
    }
  }

  async function dispatchResetConfig(channel = null) {
    try {
      await sendChannelCommand('RESET', 'ack', '恢复出厂设置', channel);
      const channelLabel = (channel || deviceStore.primaryChannel) === 'ethernet' ? '网口' : '串口';
      deviceStore.pushAlert({
        tone: 'success',
        title: '已恢复出厂设置',
        message: `已通过${channelLabel}恢复设备出厂默认配置（MAC地址保留）。`
      });
      deviceStore.appendEvent('设备配置已恢复出厂默认值');
      return true;
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: '恢复出厂设置失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`恢复出厂设置失败：${error.message}`);
      return false;
    }
  }

  watch(
    () => [configStore.settings.xAxisSecondsPerDivision, configStore.settings.xAxisDivisionCount],
    () => resizeCurve(),
    { immediate: true }
  );

  watch(
    () => deviceStore.serialConnected,
    async (connected) => {
      if (connected) {
        attachSerialProtocolListener();
        await refreshControllerSnapshot({ silent: true });
        return;
      }

      serialStreamState.active = false;
      serialStreamState.baselineTimestamp = 0;
      serialStreamState.sampleIndex = 0;
      currentSamples.serial = null;
      controllerState.mode = null;
      controllerState.pwm = null;
      controllerState.goal = null;
      controllerState.feedback = null;
      controllerState.updatedAt = null;

      if (deviceStore.primaryChannel !== 'ethernet') {
        curveHistory.value = [];
        chartPanOffset.value = 0;
      }
    }
  );

  watch(
    () => deviceStore.ethernetConnected,
    (connected, wasConnected) => {
      if (connected) {
        attachTcpProtocolListener();
        if (deviceStore.primaryChannel === 'ethernet') {
          startEthernetPolling();
        }
        return;
      }

      stopEthernetPolling();
      currentSamples.ethernet = null;
      if (deviceStore.primaryChannel !== 'serial') {
        curveHistory.value = [];
        chartPanOffset.value = 0;
      }
    }
  );

  watch(
    () => deviceStore.primaryChannel,
    (channel, previousChannel) => {
      // Handle ethernet polling for chart data
      if (channel === 'ethernet' && deviceStore.ethernetConnected) {
        startEthernetPolling();
      } else {
        stopEthernetPolling();
      }

      // Clear chart on channel switch
      if (channel && channel !== previousChannel) {
        chartPanOffset.value = 0;
        curveHistory.value = [];
      }
    }
  );

  watch(
    () => [deviceStore.serialConnected, deviceStore.ethernetConnected],
    async () => {
      await reconcileRecordingLifecycle();

      if (!hasActiveConnection()) {
        curveHistory.value = [];
        chartPanOffset.value = 0;
        stopEthernetPolling();
      }
    },
    { immediate: true }
  );

  return {
    pidDraft,
    plantDraft,
    curveHistory,
    curvePoints,
    visibleCurveSamples,
    visiblePointCount,
    visibleTimeRange,
    chartPanOffset,
    currentSamples,
    primarySample,
    currentTemp,
    targetTemp,
    furnaceState,
    currentMetrics,
    controllerState,
    latestPidDispatch,
    lastAppliedPid,
    previousAppliedPid,
    logDirectory,
    recordingState,
    recordingStatusText,
    xAxisLabels,
    xAxisStepLabel,
    canStartRecording,
    canPauseRecording,
    canStopRecording,
    openRecordingDirectory,
    panChartWindow,
    jumpChartToLatest,
    ensureRunning,
    stopRuntime,
    startRecordingSession,
    pauseRecording,
    resumeRecording,
    stopRecordingSession,
    applyProfile,
    resetPidDraft,
    syncDraftToChannels,
    cascadeDraft,
    hybridDraft,
    netDraft,
    serialProtocolState,
    tcpProtocolState,
    refreshControllerState,
    refreshPidParameters,
    refreshCascadeParams,
    refreshHybridParams,
    refreshNetConfig,
    refreshControllerSnapshot,
    setControllerMode,
    applyManualPwm,
    dispatchPidParameters,
    dispatchCascadeParams,
    dispatchHybridParams,
    dispatchNetConfig,
    dispatchSaveConfig,
    dispatchResetConfig,
    ethDiag,
    ETH_ERR_LABELS,
    refreshEthDiag,
    applyPlantDraft,
    setTargetTemperature,
    commitTargetTemperature
  };
});