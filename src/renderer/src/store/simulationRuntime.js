import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  defaultPidDraft,
  normalizePidPayload
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
    controllerState.mode = snapshot.mode || controllerState.mode;
    controllerState.pwm = Number.isFinite(snapshot.pwm) ? snapshot.pwm : controllerState.pwm;
    controllerState.goal = Number.isFinite(snapshot.goal) ? snapshot.goal : controllerState.goal;
    controllerState.feedback = Number.isFinite(snapshot.feedback) ? snapshot.feedback : controllerState.feedback;
    controllerState.updatedAt = Date.now();

    if (Number.isFinite(snapshot.goal)) {
      requestedSetpoint.value = snapshot.goal;
    }

    if (currentSamples.serial) {
      currentSamples.serial = {
        ...currentSamples.serial,
        requestedSetpoint: Number.isFinite(snapshot.goal) ? snapshot.goal : currentSamples.serial.requestedSetpoint,
        controlOutput: Number.isFinite(snapshot.pwm) ? snapshot.pwm : currentSamples.serial.controlOutput,
        temperature: Number.isFinite(snapshot.feedback) ? snapshot.feedback : currentSamples.serial.temperature,
        mode: snapshot.mode || currentSamples.serial.mode
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

    serialProtocolState.lastMessageAt = payload.timestamp || Date.now();

    if (payload.kind === 'ack') {
      serialProtocolState.lastAck = payload.status;
      if (payload.status === 'ERR') {
        serialProtocolState.lastError = '设备返回 ACK=ERR';
      }
      return;
    }

    if (payload.kind === 'state') {
      applyControllerState(payload);
      return;
    }

    if (payload.kind === 'pid') {
      applyQueriedPid(payload);
    }
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

  function ensureSerialControlAvailable(actionText) {
    if (!deviceApi?.sendSerialCommand) {
      throw new Error('当前环境未提供真实串口控制能力');
    }

    if (!deviceStore.serialConnected) {
      throw new Error(`请先连接串口，再执行${actionText}`);
    }
  }

  async function sendSerialProtocolCommand(body, expectKind = 'ack', actionText = '串口控制') {
    ensureSerialControlAvailable(actionText);
    serialProtocolState.busy = true;
    serialProtocolState.lastError = '';

    try {
      const result = await deviceApi.sendSerialCommand({
        body,
        expectKind,
        timeoutMs: expectKind === 'ack' ? 1600 : 1800
      });

      if (result?.response) {
        handleSerialProtocolMessage(result.response);
      }

      deviceStore.appendEvent(`已发送串口指令：${body}`);
      return result?.response || null;
    } catch (error) {
      serialProtocolState.lastError = error.message || '未知错误';
      throw error;
    } finally {
      serialProtocolState.busy = false;
    }
  }

  async function refreshControllerState({ silent = false } = {}) {
    try {
      const response = await sendSerialProtocolCommand('GET=STATE', 'state', '状态查询');
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

  async function refreshPidParameters({ silent = false } = {}) {
    try {
      const response = await sendSerialProtocolCommand('GET=PID', 'pid', 'PID 查询');
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

  async function refreshControllerSnapshot({ silent = false } = {}) {
    await refreshControllerState({ silent });
    await refreshPidParameters({ silent });
  }

  async function setControllerMode(mode) {
    const normalizedMode = String(mode || '').toUpperCase();
    if (!['AUTO', 'MAN'].includes(normalizedMode)) {
      return false;
    }

    try {
      await sendSerialProtocolCommand(`MODE=${normalizedMode}`, 'ack', '模式切换');
      await refreshControllerState({ silent: true });
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

  async function applyManualPwm(value) {
    const normalizedPwm = Math.max(-100, Math.min(100, Math.round(Number(value))));
    if (!Number.isFinite(normalizedPwm)) {
      deviceStore.pushAlert({ tone: 'warning', title: 'PWM 未下发', message: '请输入有效的 PWM 数值。' });
      return false;
    }

    try {
      await sendSerialProtocolCommand(`PWM=${normalizedPwm}`, 'ack', 'PWM 下发');
      await refreshControllerState({ silent: true });
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
    await ensureLogDirectory();
    await reconcileRecordingLifecycle();
    if (deviceStore.serialConnected) {
      await refreshControllerSnapshot({ silent: true });
    }
  }

  async function stopRuntime() {
    runtimeStarted.value = false;
    detachSerialFrameListener();
    detachSerialProtocolListener();
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

  async function commitTargetTemperature(value = requestedSetpoint.value) {
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
    requestedSetpoint.value = clampedTarget;

    try {
      await sendSerialProtocolCommand(`TEMP=${clampedTarget.toFixed(1)}`, 'ack', '目标温度下发');
      await refreshControllerState({ silent: true });
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

  async function dispatchPidParameters() {
    const normalizedPid = normalizePidPayload(configStore.pidDraft);
    Object.assign(configStore.pidDraft, normalizedPid);

    try {
      await sendSerialProtocolCommand(
        `PID=${normalizedPid.kp.toFixed(3)},${normalizedPid.ki.toFixed(3)},${normalizedPid.kd.toFixed(3)}`,
        'ack',
        'PID 参数下发'
      );

      previousAppliedPid.value = { ...lastAppliedPid.value };
      lastAppliedPid.value = { ...normalizedPid };
      latestPidDispatch.value = {
        channel: 'serial',
        timestamp: Date.now(),
        payload: { ...normalizedPid }
      };
      await refreshPidParameters({ silent: true });
      deviceStore.appendEvent(
        `PID 参数已下发到串口控制器：Kp ${normalizedPid.kp.toFixed(3)} / Ki ${normalizedPid.ki.toFixed(3)} / Kd ${normalizedPid.kd.toFixed(3)}`
      );
      deviceStore.pushAlert({
        tone: 'success',
        title: 'PID 参数更新成功',
        message: '已更新串口控制器 PID 参数。'
      });
      return { applied: true, channel: 'serial' };
    } catch (error) {
      deviceStore.pushAlert({ tone: 'danger', title: 'PID 参数下发失败', message: error.message || '未知错误' });
      deviceStore.appendEvent(`PID 参数下发失败：${error.message}`);
      return { applied: false };
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
    (connected) => {
      if (connected) {
        return;
      }

      currentSamples.ethernet = null;
      if (deviceStore.primaryChannel !== 'serial') {
        curveHistory.value = [];
        chartPanOffset.value = 0;
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
      }
    },
    { immediate: true }
  );

  watch(
    () => deviceStore.primaryChannel,
    (channel, previousChannel) => {
      if (!channel || channel === previousChannel) {
        return;
      }

      chartPanOffset.value = 0;
      curveHistory.value = [];
    }
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
    refreshControllerState,
    refreshPidParameters,
    refreshControllerSnapshot,
    setControllerMode,
    applyManualPwm,
    dispatchPidParameters,
    applyPlantDraft,
    setTargetTemperature,
    commitTargetTemperature
  };
});