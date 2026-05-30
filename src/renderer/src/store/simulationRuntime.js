import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  advanceSimulation,
  applyPidSettings,
  applyPlantSettings,
  createSimulationChannel,
  defaultPidDraft,
  normalizePidPayload
} from '../services/pidSimulation.js';
import { useDeviceRuntimeStore } from './deviceRuntime.js';
import { useSystemConfigStore } from './systemConfig.js';

const deviceApi = window.deviceApi;
const SAMPLE_PERIOD_MS = 1000;

function buildSeedCurve(size = 24) {
  const base = [432, 438, 446, 459, 472, 488, 507, 524, 541, 559, 576, 590, 603, 617, 632, 645, 658, 669, 676, 682, 688, 694, 699, 704];

  if (size <= base.length) {
    return base.slice(-size);
  }

  const curve = [...base];
  while (curve.length < size) {
    curve.unshift(curve[0]);
  }

  return curve;
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
  const curveHistory = ref(buildSeedCurve().map((temperature, index) => ({
    elapsedSeconds: index + 1,
    temperature
  })));
  const chartPanOffset = ref(0);
  const latestPidDispatch = ref(null);
  const lastAppliedPid = ref({ ...defaultPidDraft });
  const previousAppliedPid = ref(null);
  const runtimeStarted = ref(false);
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

  const channels = {
    serial: createSimulationChannel('serial', {
      pidOverrides: configStore.pidDraft,
      plantOverrides: configStore.plantDraft
    }),
    ethernet: createSimulationChannel('ethernet', {
      pidOverrides: configStore.pidDraft,
      plantOverrides: configStore.plantDraft
    })
  };

  let timer = null;

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

  const currentTemp = computed(() => primarySample.value?.temperature ?? curvePoints.value.at(-1) ?? 0);
  const targetTemp = computed(() => primarySample.value?.requestedSetpoint ?? channels.serial.state.requestedSetpoint);
  const furnaceState = computed(() => {
    if (!deviceStore.primaryChannel) {
      return '待连接';
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
        controlOutput: 0,
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
      curveHistory.value = buildSeedCurve(visiblePointCount.value).map((temperature, index) => ({
        elapsedSeconds: index + 1,
        temperature
      }));
      return;
    }

    const maxOffset = Math.max(0, history.length - visiblePointCount.value);
    chartPanOffset.value = Math.min(chartPanOffset.value, maxOffset);
  }

  function appendCurvePoint(elapsedSeconds, value) {
    curveHistory.value = [...curveHistory.value, {
      elapsedSeconds: Number(elapsedSeconds),
      temperature: Number(value.toFixed(1))
    }];
  }

  function panChartWindow(deltaPoints) {
    const maxOffset = Math.max(0, curveHistory.value.length - visiblePointCount.value);
    chartPanOffset.value = Math.min(maxOffset, Math.max(0, chartPanOffset.value + Number(deltaPoints || 0)));
  }

  function jumpChartToLatest() {
    chartPanOffset.value = 0;
  }

  function syncPlantDraft() {
    applyPlantSettings(channels.serial, configStore.plantDraft);
    applyPlantSettings(channels.ethernet, configStore.plantDraft);
  }

  function syncCommittedPidToChannels() {
    applyPidSettings(channels.serial, lastAppliedPid.value);
    applyPidSettings(channels.ethernet, lastAppliedPid.value);
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

    await Promise.all([flushChannelBatch('serial'), flushChannelBatch('ethernet')]);
    recordingState.active = false;
    recordingState.paused = false;
    recordingState.pauseReason = '';
    recordingState.lastAction = reason === 'disconnect' ? '断连后结束录制' : '录制已结束';
    recordingState.sessionId = '';
    recordingState.sessionStartedAt = null;
    deviceStore.appendEvent(recordingState.lastAction);
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

  function tickChannel(channel) {
    const connected = channel === 'serial' ? deviceStore.serialConnected : deviceStore.ethernetConnected;
    if (!connected) {
      return null;
    }

    const sample = advanceSimulation(channels[channel], 1);
    sampleCounters[channel] += 1;
    sample.sampleIndex = sampleCounters[channel];
    sample.xAxisSecondsPerDivision = Number(configStore.settings.xAxisSecondsPerDivision);
    currentSamples[channel] = sample;

    if (configStore.settings.csvEnabled && recordingState.active && !recordingState.paused) {
      batchBuffers[channel].push(sample);
    }

    if (batchBuffers[channel].length >= 5) {
      flushChannelBatch(channel);
    }

    return sample;
  }

  async function tick() {
    await reconcileRecordingLifecycle();
    if (!hasActiveConnection()) {
      return;
    }

    tickChannel('serial');
    tickChannel('ethernet');

    const displaySample = deviceStore.primaryChannel
      ? currentSamples[deviceStore.primaryChannel]
      : deviceStore.serialConnected
        ? currentSamples.serial
        : currentSamples.ethernet;

    if (displaySample) {
      appendCurvePoint(displaySample.elapsedSeconds, displaySample.temperature);
    }
  }

  async function ensureRunning() {
    if (runtimeStarted.value) {
      return;
    }

    runtimeStarted.value = true;
    resizeCurve();
    syncPlantDraft();
    syncCommittedPidToChannels();
    await ensureLogDirectory();
    timer = window.setInterval(() => {
      tick();
    }, SAMPLE_PERIOD_MS);
  }

  async function stopRuntime() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }

    runtimeStarted.value = false;
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
    syncCommittedPidToChannels();
  }

  function applyPlantDraft() {
    syncPlantDraft();
    deviceStore.pushAlert({
      tone: 'success',
      title: '仿真对象已更新',
      message: '新的被控对象参数已经作用到当前仿真模型。'
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

    channels.serial.state.requestedSetpoint = clampedTarget;
    channels.ethernet.state.requestedSetpoint = clampedTarget;

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

  async function dispatchPidParameters() {
    const primary = deviceStore.primaryChannel;
    if (!primary) {
      deviceStore.pushAlert({
        tone: 'warning',
        title: '参数未下发',
        message: '请先建立串口或网口主通道，再执行 PID 参数下发。',
        ttl: 4200
      });
      deviceStore.appendEvent('PID 参数下发失败：当前没有活动主通道');
      return { applied: false };
    }

    const normalizedPid = normalizePidPayload(configStore.pidDraft);
    Object.assign(configStore.pidDraft, normalizedPid);
    previousAppliedPid.value = { ...lastAppliedPid.value };
    lastAppliedPid.value = { ...normalizedPid };

    applyPidSettings(channels.serial, normalizedPid);
    applyPidSettings(channels.ethernet, normalizedPid);

    latestPidDispatch.value = {
      channel: primary,
      timestamp: Date.now(),
      payload: { ...normalizedPid }
    };
    deviceStore.appendEvent(
      `PID 参数已下发至${primary === 'serial' ? '串口' : '网口'}主通道：Kp ${normalizedPid.kp.toFixed(2)} / Ki ${normalizedPid.ki.toFixed(2)} / Kd ${normalizedPid.kd.toFixed(2)}`
    );
    deviceStore.pushAlert({
      tone: 'success',
      title: 'PID 参数更新成功',
      message: `已更新${primary === 'serial' ? '串口' : '网口'}主通道参数。`
    });
    return { applied: true, channel: primary };
  }

  watch(
    () => [configStore.settings.xAxisSecondsPerDivision, configStore.settings.xAxisDivisionCount],
    () => resizeCurve(),
    { immediate: true }
  );

  watch(
    () => JSON.stringify(configStore.plantDraft),
    () => syncPlantDraft()
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
    dispatchPidParameters,
    applyPlantDraft,
    setTargetTemperature
  };
});