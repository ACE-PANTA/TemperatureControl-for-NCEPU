<script setup>
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import PrimaryChannelPanel from '../components/PrimaryChannelPanel.vue';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';
import { useSimulationRuntimeStore } from '../store/simulationRuntime.js';
import { useSystemConfigStore } from '../store/systemConfig.js';

const deviceStore = useDeviceRuntimeStore();
const simulationStore = useSimulationRuntimeStore();
const configStore = useSystemConfigStore();

const {
  serialConnected,
  ethernetConnected,
  primaryChannel
} = storeToRefs(deviceStore);

const {
  tranDraft,
  fineDraft,
  smithDraft,
  netDraft,
  controllerState,
  currentTemp,
  targetTemp,
  latestParamDispatch,
  lastAppliedTran,
  lastAppliedFine,
  lastAppliedSmith,
  lastAppliedDeadband,
  lastAppliedFineEnabled,
  serialProtocolState,
  tcpProtocolState,
  ethDiag
} = storeToRefs(simulationStore);

const { deadband, fineEnabled, paramRecords } = storeToRefs(configStore);

const ethErrLabels = simulationStore.ETH_ERR_LABELS;

const dispatchChannel = ref('serial');
const activeSection = ref('');
const paramRecordName = ref('');
const selectedParamRecord = ref(null);
const pendingApplyRecord = ref(null);
const applyingParamRecord = ref(false);
const paramRecordApplyStatus = ref('');

const channelOptions = computed(() => {
  const options = [];
  if (serialConnected.value) {
    options.push({ value: 'serial', label: '串口 (USART1)' });
  }
  if (ethernetConnected.value) {
    options.push({ value: 'ethernet', label: '网口 (TCP:8000)' });
  }
  return options;
});

const hasActiveChannel = computed(() => channelOptions.value.length > 0);
const dispatchChannelLabel = computed(() => {
  return dispatchChannel.value === 'ethernet' ? '网口' : '串口';
});
const isChannelBusy = computed(() => {
  if (dispatchChannel.value === 'ethernet') {
    return tcpProtocolState.value.busy;
  }
  return serialProtocolState.value.busy;
});

const currentPhaseLabel = computed(() => {
  if (controllerState.value.phase === 'MAN') {
    return '手动';
  }

  if (controllerState.value.phase === 'TRAN') {
    return '变温';
  }

  if (controllerState.value.phase === 'FINE') {
    return '微调';
  }

  return '--';
});

const modeBadgeLabel = computed(() => {
  if (controllerState.value.mode === 'AUTO') {
    return controllerState.value.phase === 'TRAN'
      ? '自动模式 · 变温工况'
      : controllerState.value.phase === 'FINE'
        ? '自动模式 · 微调工况'
        : '自动模式';
  }

  if (controllerState.value.mode === 'MAN') {
    return '手动模式';
  }

  return '模式未同步';
});

const derivedIndicators = computed(() => [
  { label: '控制模式', value: controllerState.value.mode === 'AUTO' ? '自动' : controllerState.value.mode === 'MAN' ? '手动' : '--' },
  { label: '当前工况', value: currentPhaseLabel.value },
  { label: '当前目标', value: Number.isFinite(targetTemp.value) ? `${targetTemp.value.toFixed(1)} °C` : '--' },
  { label: '反馈温度', value: Number.isFinite(currentTemp.value) ? `${currentTemp.value.toFixed(1)} °C` : '--' },
  { label: '预估反馈', value: Number.isFinite(controllerState.value.predictedFeedback) ? `${controllerState.value.predictedFeedback.toFixed(1)} °C` : '--' },
  { label: '当前 PWM', value: Number.isFinite(controllerState.value.pwm) ? `${controllerState.value.pwm.toFixed(0)}%` : '--' },
  { label: '微调开关', value: fineEnabled.value ? '启用' : '禁用', tone: fineEnabled.value ? 'ok' : 'warn' },
  { label: '下发通道', value: dispatchChannelLabel.value },
  { label: '主数据通道', value: primaryChannel.value ? (primaryChannel.value === 'serial' ? '串口' : '网口') : '未连接' },
  { label: 'ETH LINK', value: ethDiag?.value?.link === 1 ? 'UP' : 'DOWN', tone: ethDiag?.value?.link === 1 ? 'ok' : 'warn' },
  { label: 'ETH 错误码', value: `ERR=${ethDiag?.value?.err ?? '--'}`, tone: ethDiag?.value?.err === 0 ? 'ok' : 'warn' }
]);

const lastDispatchInfo = computed(() => {
  if (!latestParamDispatch.value) return '尚未执行参数下发';
  const ch = latestParamDispatch.value.channel === 'ethernet' ? '网口' : '串口';
  const time = new Date(latestParamDispatch.value.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const kindMap = {
    tran: '变温',
    fine: '微调',
    smith: 'Smith 预估',
    fineEnable: '微调开关',
    deadband: '死区'
  };
  const kind = kindMap[latestParamDispatch.value.kind] || latestParamDispatch.value.kind;
  return `最近下发：${kind} · ${ch} · ${time}`;
});

const selectedRecordGroups = computed(() => {
  const snapshot = selectedParamRecord.value?.snapshot;
  if (!snapshot) return [];

  return [
    {
      title: '变温参数 TRAN',
      rows: [
        ['Kp', fmt(snapshot.tran.kp, 2)],
        ['Ki', fmt(snapshot.tran.ki, 3)],
        ['Kd', fmt(snapshot.tran.kd, 2)],
        ['调节间隔', `${fmt(snapshot.tran.interval, 0)} s`],
        ['积分分离阈值', `${fmt(snapshot.tran.sepThreshold, 1)} °C`]
      ]
    },
    {
      title: '微调参数 FINE',
      rows: [
        ['Kp', fmt(snapshot.fine.kp, 2)],
        ['Ki', fmt(snapshot.fine.ki, 3)],
        ['Kd', fmt(snapshot.fine.kd, 2)],
        ['调节间隔', `${fmt(snapshot.fine.interval, 0)} s`],
        ['单次最大变化', `${fmt(snapshot.fine.range, 1)} %`],
        ['进入误差下限', `${fmt(snapshot.fine.entryMin, 1)} °C`],
        ['进入误差上限', `${fmt(snapshot.fine.entryMax, 1)} °C`],
        ['稳定窗口', `${fmt(snapshot.fine.stableWindow, 0)} s`],
        ['判稳最大波动', `${fmt(snapshot.fine.stableDelta, 1)} °C`],
        ['微调开关', snapshot.fineEnabled ? '启用' : '禁用']
      ]
    },
    {
      title: 'Smith 预估 SMITH',
      rows: [
        ['启用', snapshot.smith.enabled ? '启用' : '关闭'],
        ['模型增益', fmt(snapshot.smith.gain, 1)],
        ['时间常数', `${fmt(snapshot.smith.tau, 0)} s`],
        ['纯滞后', `${fmt(snapshot.smith.delay, 0)} s`],
        ['混合比例', fmt(snapshot.smith.blend, 2)],
        ['最大超前', `${fmt(snapshot.smith.maxLead, 1)} °C`]
      ]
    },
    {
      title: '共享参数',
      rows: [
        ['死区 DEADBAND', `${fmt(snapshot.deadband, 2)} °C`]
      ]
    }
  ];
});

function fmt(value, digits = 3) {
  return Number(value || 0).toFixed(digits);
}

function formatRecordTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function saveParamRecord() {
  const record = configStore.addParamRecord(paramRecordName.value);
  if (!record) {
    deviceStore.pushAlert({ tone: 'warning', title: '参数方案未保存', message: '请先填写这一组参数的名称。' });
    return;
  }

  paramRecordName.value = '';
  selectedParamRecord.value = record;
  deviceStore.pushAlert({ tone: 'success', title: '参数方案已记录', message: `已保存「${record.name}」。` });
}

function openParamRecord(record) {
  selectedParamRecord.value = record;
}

function closeParamRecordDialog() {
  if (applyingParamRecord.value) {
    return;
  }
  selectedParamRecord.value = null;
  pendingApplyRecord.value = null;
  paramRecordApplyStatus.value = '';
}

function deleteParamRecord(record) {
  if (applyingParamRecord.value) {
    return;
  }
  configStore.removeParamRecord(record.id);
  if (selectedParamRecord.value?.id === record.id) {
    selectedParamRecord.value = null;
  }
}

function requestApplyParamRecord(record) {
  pendingApplyRecord.value = record;
  paramRecordApplyStatus.value = '';
}

function cancelApplyParamRecord() {
  if (applyingParamRecord.value) {
    return;
  }
  pendingApplyRecord.value = null;
  paramRecordApplyStatus.value = '';
}

async function runSequentialParamStep(label, assignDraft, dispatchStep) {
  paramRecordApplyStatus.value = `正在下发 ${label}...`;
  assignDraft();
  const result = await dispatchStep();
  if (!result?.applied) {
    throw new Error(`${label} 下发失败`);
  }
}

async function confirmApplyParamRecord() {
  const record = pendingApplyRecord.value;
  const snapshot = record?.snapshot;
  if (!record || !snapshot) {
    return;
  }

  if (!hasActiveChannel.value) {
    deviceStore.pushAlert({ tone: 'warning', title: '参数方案未应用', message: '当前没有可用下发通道。' });
    return;
  }

  if (isChannelBusy.value) {
    deviceStore.pushAlert({ tone: 'warning', title: '参数方案未应用', message: '当前通道正在通信，请稍后再试。' });
    return;
  }

  applyingParamRecord.value = true;
  const channel = dispatchChannel.value;

  try {
    await runSequentialParamStep(
      '变温参数',
      () => Object.assign(configStore.tranDraft, snapshot.tran),
      () => simulationStore.dispatchTranParams(channel)
    );
    await runSequentialParamStep(
      '微调参数',
      () => Object.assign(configStore.fineDraft, snapshot.fine),
      () => simulationStore.dispatchFineParams(channel)
    );
    await runSequentialParamStep(
      '微调开关',
      () => { configStore.fineEnabled = Boolean(snapshot.fineEnabled); },
      () => simulationStore.dispatchFineEnable(channel)
    );
    await runSequentialParamStep(
      'Smith 参数',
      () => Object.assign(configStore.smithDraft, snapshot.smith),
      () => simulationStore.dispatchSmithParams(channel)
    );
    await runSequentialParamStep(
      '死区',
      () => { configStore.deadband = Number(snapshot.deadband); },
      () => simulationStore.dispatchDeadband(channel)
    );

    paramRecordApplyStatus.value = '参数方案已按顺序应用完成。';
    pendingApplyRecord.value = null;
    deviceStore.pushAlert({
      tone: 'success',
      title: '参数方案已应用',
      message: `「${record.name}」已按顺序下发到${dispatchChannelLabel.value}。`
    });
  } catch (error) {
    paramRecordApplyStatus.value = error.message || '参数方案应用失败';
    deviceStore.pushAlert({
      tone: 'danger',
      title: '参数方案应用中断',
      message: error.message || '某一步下发失败，后续参数未继续发送。'
    });
  } finally {
    applyingParamRecord.value = false;
  }
}

async function queryTran() {
  await simulationStore.refreshTranParams({ channel: dispatchChannel.value });
}
async function dispatchTran() {
  await simulationStore.dispatchTranParams(dispatchChannel.value);
}

async function queryFine() {
  await simulationStore.refreshFineParams({ channel: dispatchChannel.value });
}
async function dispatchFine() {
  await simulationStore.dispatchFineParams(dispatchChannel.value);
}
async function querySmith() {
  await simulationStore.refreshSmithParams({ channel: dispatchChannel.value });
}
async function dispatchSmith() {
  await simulationStore.dispatchSmithParams(dispatchChannel.value);
}
async function queryFineEnable() {
  await simulationStore.refreshFineEnable({ channel: dispatchChannel.value });
}
async function dispatchFineEnable() {
  await simulationStore.dispatchFineEnable(dispatchChannel.value);
}

async function queryDeadband() {
  await simulationStore.refreshDeadband({ channel: dispatchChannel.value });
}
async function dispatchDb() {
  await simulationStore.dispatchDeadband(dispatchChannel.value);
}

async function queryNet() {
  await simulationStore.refreshNetConfig({ channel: dispatchChannel.value });
}
async function dispatchNet() {
  await simulationStore.dispatchNetConfig(dispatchChannel.value);
}
async function queryEth() {
  await simulationStore.refreshEthDiag({ channel: dispatchChannel.value });
}

const ethErrLabel = computed(() => {
  const code = ethDiag?.value?.err ?? 0;
  return ethErrLabels[code] || `未知错误码: ${code}`;
});

async function queryState() {
  await simulationStore.refreshControllerState({ channel: dispatchChannel.value });
}

async function saveConfig() {
  await simulationStore.dispatchSaveConfig(dispatchChannel.value);
}
async function resetConfig() {
  await simulationStore.dispatchResetConfig(dispatchChannel.value);
}

function setChannel(ch) {
  dispatchChannel.value = ch;
}

onMounted(async () => {
  configStore.loadPersistedState();
  await deviceStore.initializeCommunication();
  await simulationStore.ensureRunning();
  await simulationStore.refreshControllerSnapshot({ silent: true });
  if (serialConnected.value) {
    dispatchChannel.value = 'serial';
  } else if (ethernetConnected.value) {
    dispatchChannel.value = 'ethernet';
  }
});
</script>

<template>
  <section class="tuning-layout">
    <div class="main-column">
      <div class="panel hero-panel">
        <div class="panel-heading">
          <div>
            <h2>控制参数整定</h2>
          </div>
          <span class="mode-badge">{{ modeBadgeLabel }}</span>
        </div>

        <PrimaryChannelPanel />

        <!-- Channel Selector for Command Sending -->
        <div class="channel-selector">
          <div class="channel-selector-head">
            <h3>指令下发通道选择</h3>
            <span class="channel-hint">串口和网口独立收发，选择向哪个通道发送参数指令</span>
          </div>
          <div class="channel-buttons">
            <button
              v-for="opt in channelOptions"
              :key="opt.value"
              type="button"
              class="channel-btn"
              :class="{ active: dispatchChannel === opt.value }"
              :disabled="isChannelBusy"
              @click="setChannel(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>
          <p v-if="!hasActiveChannel" class="channel-warning">&#9888; 当前无可用通道，请先在首页建立串口或网口连接</p>
        </div>

        <!-- System Control Status -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#9881; 系统控制状态</h3>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryState">查询状态</button>
            </div>
          </div>
          <div class="card-body sys-ctrl-body">
            <div class="sys-item">
              <span class="sys-label">控制模式</span>
              <span class="sys-value" :class="{ auto: controllerState.mode === 'AUTO', man: controllerState.mode === 'MAN' }">
                {{ controllerState.mode === 'AUTO' ? '自动温控' : controllerState.mode === 'MAN' ? '手动 PWM' : '未同步' }}
              </span>
            </div>
            <div class="sys-item">
              <span class="sys-label">当前工况</span>
              <span class="sys-value">{{ currentPhaseLabel }}</span>
            </div>
            <div class="sys-item">
              <span class="sys-label">目标温度</span>
              <span class="sys-value">{{ Number.isFinite(controllerState.goal) ? `${controllerState.goal.toFixed(1)} °C` : '--' }}</span>
            </div>
            <div class="sys-item">
              <span class="sys-label">当前 PWM</span>
              <span class="sys-value">{{ Number.isFinite(controllerState.pwm) ? `${controllerState.pwm.toFixed(0)} %` : '--' }}</span>
            </div>
            <div class="sys-item">
              <span class="sys-label">反馈温度</span>
              <span class="sys-value">{{ Number.isFinite(controllerState.feedback) ? `${controllerState.feedback.toFixed(1)} °C` : '--' }}</span>
            </div>
            <div class="sys-item">
              <span class="sys-label">预估反馈 PFB</span>
              <span class="sys-value">{{ Number.isFinite(controllerState.predictedFeedback) ? `${controllerState.predictedFeedback.toFixed(1)} °C` : '--' }}</span>
            </div>
          </div>
        </div>

        <!-- TRAN — 变温工况 -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#128293; 变温工况 TRAN</h3>
            <span class="card-desc">位置式 PID，主力升温/降温控制，靠积分抗饱和保护</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryTran">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchTran">下发</button>
            </div>
          </div>
          <div class="card-body param-grid">
            <div class="param-item">
              <label>比例 Kp</label>
              <input v-model.number="tranDraft.kp" type="number" min="0.1" max="50" step="0.1" />
              <span class="param-range">0.1 ~ 50</span>
            </div>
            <div class="param-item">
              <label>积分 Ki</label>
              <input v-model.number="tranDraft.ki" type="number" min="0" max="5" step="0.001" />
              <span class="param-range">0 ~ 5</span>
            </div>
            <div class="param-item">
              <label>微分 Kd</label>
              <input v-model.number="tranDraft.kd" type="number" min="0" max="10" step="0.1" />
              <span class="param-range">0 ~ 10</span>
            </div>
            <div class="param-item">
              <label>调节间隔 (秒)</label>
              <input v-model.number="tranDraft.interval" type="number" min="1" max="60" step="1" />
              <span class="param-range">1 ~ 60</span>
            </div>
            <div class="param-item">
              <label>积分分离阈值 (°C)</label>
              <input v-model.number="tranDraft.sepThreshold" type="number" min="1" max="50" step="0.5" />
              <span class="param-range">1 ~ 50 (|error|>阈值时关积分)</span>
            </div>
          </div>
          <div class="card-values">
            <span>
              Kp={{ fmt(lastAppliedTran?.kp || tranDraft.kp, 2) }} | Ki={{ fmt(lastAppliedTran?.ki || tranDraft.ki, 3) }} | Kd={{ fmt(lastAppliedTran?.kd || tranDraft.kd, 2) }} | 间隔={{ lastAppliedTran?.interval || tranDraft.interval }}s | 分离阈值={{ fmt(lastAppliedTran?.sepThreshold || tranDraft.sepThreshold, 1) }}°C
            </span>
          </div>
        </div>

        <!-- FINEEN — 微调开关 -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#127919; 微调开关 FINEEN</h3>
            <span class="card-desc">启用后满足条件可进入微调工况；禁用后自动模式保持变温工况</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryFineEnable">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchFineEnable">下发</button>
            </div>
          </div>
          <div class="card-body sys-ctrl-body">
            <div class="sys-item">
              <span class="sys-label">允许进入微调</span>
              <label class="switch-control">
                <input v-model="fineEnabled" type="checkbox" />
                <span class="switch-track">
                  <span class="switch-thumb"></span>
                </span>
                <span class="switch-text">{{ fineEnabled ? '启用' : '禁用' }}</span>
              </label>
            </div>
            <div class="sys-item">
              <span class="sys-label">设备生效状态</span>
              <span class="sys-value" :class="{ auto: lastAppliedFineEnabled, man: !lastAppliedFineEnabled }">
                {{ lastAppliedFineEnabled ? '允许微调' : '固定变温' }}
              </span>
            </div>
          </div>
          <div class="card-values">
            <span>FINEEN={{ fineEnabled ? 1 : 0 }} | 已生效={{ lastAppliedFineEnabled ? 1 : 0 }}</span>
          </div>
        </div>

        <!-- FINE — 微调工况 -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#127919; 微调工况 FINE</h3>
            <span class="card-desc">增量式 PID，近目标区精细调节</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryFine">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchFine">下发</button>
            </div>
          </div>
          <div class="card-body param-grid">
            <div class="param-item">
              <label>比例 Kp</label>
              <input v-model.number="fineDraft.kp" type="number" min="0.1" max="20" step="0.1" />
              <span class="param-range">0.1 ~ 20</span>
            </div>
            <div class="param-item">
              <label>积分 Ki</label>
              <input v-model.number="fineDraft.ki" type="number" min="0" max="3" step="0.001" />
              <span class="param-range">0 ~ 3</span>
            </div>
            <div class="param-item">
              <label>微分 Kd</label>
              <input v-model.number="fineDraft.kd" type="number" min="0" max="10" step="0.1" />
              <span class="param-range">0 ~ 10</span>
            </div>
            <div class="param-item">
              <label>调节间隔 (秒)</label>
              <input v-model.number="fineDraft.interval" type="number" min="1" max="60" step="1" />
              <span class="param-range">1 ~ 60</span>
            </div>
            <div class="param-item param-item-wide">
              <label>单次最大变化 (%)</label>
              <input v-model.number="fineDraft.range" type="number" min="1" max="20" step="0.5" />
              <span class="param-range">1 ~ 20 (比变温更紧)</span>
            </div>
            <div class="param-item">
              <label>进入微调最小误差 (°C)</label>
              <input v-model.number="fineDraft.entryMin" type="number" min="0.1" max="10" step="0.1" />
              <span class="param-range">0.1 ~ 10</span>
            </div>
            <div class="param-item">
              <label>进入微调最大误差 (°C)</label>
              <input v-model.number="fineDraft.entryMax" type="number" min="1" max="10" step="0.1" />
              <span class="param-range">1 ~ 10</span>
            </div>
            <div class="param-item">
              <label>稳定窗口长度 (秒)</label>
              <input v-model.number="fineDraft.stableWindow" type="number" min="10" max="120" step="1" />
              <span class="param-range">10 ~ 120</span>
            </div>
            <div class="param-item">
              <label>判稳最大波动 (°C)</label>
              <input v-model.number="fineDraft.stableDelta" type="number" min="0.2" max="5" step="0.1" />
              <span class="param-range">0.2 ~ 5.0</span>
            </div>
          </div>
          <div class="card-values">
            <span>
              Kp={{ fmt(lastAppliedFine?.kp || fineDraft.kp, 2) }} | Ki={{ fmt(lastAppliedFine?.ki || fineDraft.ki, 3) }} | Kd={{ fmt(lastAppliedFine?.kd || fineDraft.kd, 2) }} | 间隔={{ lastAppliedFine?.interval || fineDraft.interval }}s | 限幅={{ fmt(lastAppliedFine?.range || fineDraft.range, 1) }}% | 进入={{ fmt(lastAppliedFine?.entryMin || fineDraft.entryMin, 1) }}~{{ fmt(lastAppliedFine?.entryMax || fineDraft.entryMax, 1) }}°C | 稳定窗口={{ lastAppliedFine?.stableWindow || fineDraft.stableWindow }}s | 判稳波动={{ fmt(lastAppliedFine?.stableDelta || fineDraft.stableDelta, 1) }}°C
            </span>
          </div>
        </div>

        <!-- DEADBAND — 共享死区 -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#128300; Smith 预估控制 SMITH</h3>
            <span class="card-desc">用一阶模型预估热惯性与纯滞后，让 PID 使用更接近当前过程状态的反馈</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="querySmith">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchSmith">下发</button>
            </div>
          </div>
          <div class="card-body param-grid">
            <div class="param-item param-item-wide">
              <label>Smith 预估启用</label>
              <label class="switch-control switch-control-inline">
                <input v-model="smithDraft.enabled" type="checkbox" />
                <span class="switch-track">
                  <span class="switch-thumb"></span>
                </span>
                <span class="switch-text">{{ smithDraft.enabled ? '启用' : '关闭' }}</span>
              </label>
              <span class="param-range">建议先调好 TRAN/FINE，再从小 blend 和小 maxlead 开始启用</span>
            </div>
            <div class="param-item">
              <label>模型增益 Gain</label>
              <input v-model.number="smithDraft.gain" type="number" min="1" max="200" step="1" />
              <span class="param-range">1 ~ 200 (100% 输出对应温升)</span>
            </div>
            <div class="param-item">
              <label>时间常数 Tau (秒)</label>
              <input v-model.number="smithDraft.tau" type="number" min="5" max="600" step="1" />
              <span class="param-range">5 ~ 600</span>
            </div>
            <div class="param-item">
              <label>纯滞后 Delay (秒)</label>
              <input v-model.number="smithDraft.delay" type="number" min="0" max="180" step="1" />
              <span class="param-range">0 ~ 180</span>
            </div>
            <div class="param-item">
              <label>混合比例 Blend</label>
              <input v-model.number="smithDraft.blend" type="number" min="0" max="1" step="0.05" />
              <span class="param-range">0 ~ 1，越大预估越强</span>
            </div>
            <div class="param-item param-item-wide">
              <label>最大超前修正 MaxLead (°C)</label>
              <input v-model.number="smithDraft.maxLead" type="number" min="0.5" max="30" step="0.5" />
              <span class="param-range">0.5 ~ 30，PFB 超前过多时优先降低</span>
            </div>
          </div>
          <div class="card-values">
            <span>
              EN={{ (lastAppliedSmith?.enabled ?? smithDraft.enabled) ? 1 : 0 }} | Gain={{ fmt(lastAppliedSmith?.gain || smithDraft.gain, 1) }} | Tau={{ fmt(lastAppliedSmith?.tau || smithDraft.tau, 0) }}s | Delay={{ fmt(lastAppliedSmith?.delay || smithDraft.delay, 0) }}s | Blend={{ fmt(lastAppliedSmith?.blend || smithDraft.blend, 2) }} | MaxLead={{ fmt(lastAppliedSmith?.maxLead || smithDraft.maxLead, 1) }}°C
            </span>
          </div>
        </div>

        <!-- DEADBAND — 共享死区 -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#127919; 死区 DEADBAND</h3>
            <span class="card-desc">变温/微调共用，|error| ≤ 死区时输出冻结</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryDeadband">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchDb">下发</button>
            </div>
          </div>
          <div class="card-body sys-ctrl-body">
            <div class="sys-item">
              <span class="sys-label">死区宽度</span>
              <span class="sys-value" style="display:flex;align-items:center;gap:0.5rem;">
                <input v-model.number="deadband" type="number" min="0.1" max="2.0" step="0.05" style="width:6rem;padding:0.35rem 0.5rem;border-radius:0.5rem;border:1px solid rgba(132,154,181,0.2);background:rgba(5,17,28,0.8);color:var(--tc-text-primary);font-size:0.85rem;" />
                <span class="param-range">°C (已生效: {{ fmt(lastAppliedDeadband, 2) }}°C)</span>
              </span>
            </div>
          </div>
        </div>

        <!-- Network Config -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#127758; 网络配置</h3>
            <span class="card-desc">修改 IP/网关/掩码/端口后需重启 STM32 设备生效</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryNet">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchNet">下发</button>
            </div>
          </div>
          <div class="card-body param-grid">
            <div class="param-item">
              <label>本机 IP</label>
              <input v-model="netDraft.ip" type="text" placeholder="192.168.1.100" />
              <span class="param-range">IPv4 地址</span>
            </div>
            <div class="param-item">
              <label>网关</label>
              <input v-model="netDraft.gateway" type="text" placeholder="192.168.1.1" />
              <span class="param-range">网关地址</span>
            </div>
            <div class="param-item">
              <label>子网掩码</label>
              <input v-model="netDraft.netmask" type="text" placeholder="255.255.255.0" />
              <span class="param-range">子网掩码</span>
            </div>
            <div class="param-item">
              <label>TCP 端口</label>
              <input v-model.number="netDraft.port" type="number" min="1" max="65535" />
              <span class="param-range">1 ~ 65535</span>
            </div>
          </div>
          <div class="card-values">
            <span>IP={{ netDraft.ip || '--' }} | GW={{ netDraft.gateway || '--' }} | NM={{ netDraft.netmask || '--' }} | Port={{ netDraft.port || '--' }}</span>
          </div>
        </div>

        <!-- ETH Diagnostics -->
        <div class="param-card eth-diag-card">
          <div class="card-head">
            <h3>&#128225; 网络诊断 (ETH)</h3>
            <span class="card-desc">实时检测 PHY / 网线 / 自协商 / TCP 客户端状态</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryEth">查询诊断</button>
            </div>
          </div>
          <div class="card-body eth-diag-grid">
            <div class="eth-item" :class="{ ok: ethDiag.link === 1, fail: ethDiag.link === 0 }">
              <span class="eth-label">LINK 链路</span>
              <span class="eth-value">{{ ethDiag.link === 1 ? 'UP ↑' : 'DOWN ↓' }}</span>
            </div>
            <div class="eth-item" :class="{ ok: ethDiag.phy !== 255, fail: ethDiag.phy === 255 }">
              <span class="eth-label">PHY 芯片</span>
              <span class="eth-value">{{ ethDiag.phy !== 255 ? `地址 ${ethDiag.phy}` : '未找到' }}</span>
            </div>
            <div class="eth-item" :class="{ ok: ethDiag.err === 0, fail: ethDiag.err !== 0 }">
              <span class="eth-label">错误码 ERR</span>
              <span class="eth-value">{{ ethDiag.err }} — {{ ethErrLabel }}</span>
            </div>
            <div class="eth-item">
              <span class="eth-label">PHY ID</span>
              <span class="eth-value mono">{{ ethDiag.phyId || '--' }}</span>
            </div>
            <div class="eth-item">
              <span class="eth-label">收包 RX</span>
              <span class="eth-value mono">{{ ethDiag.rx ?? '--' }}</span>
            </div>
            <div class="eth-item">
              <span class="eth-label">发包 TX</span>
              <span class="eth-value mono">{{ ethDiag.tx ?? '--' }}</span>
            </div>
            <div class="eth-item">
              <span class="eth-label">ARP 回复</span>
              <span class="eth-value mono">{{ ethDiag.arp ?? '--' }}</span>
            </div>
            <div class="eth-item">
              <span class="eth-label">Ping 回复 ICMP</span>
              <span class="eth-value mono">{{ ethDiag.icmp ?? '--' }}</span>
            </div>
            <div class="eth-item" :class="{ ok: ethDiag.aneg === 1, fail: ethDiag.aneg === 0 }">
              <span class="eth-label">自协商</span>
              <span class="eth-value">{{ ethDiag.aneg === 1 ? '完成' : '未完成' }}</span>
            </div>
            <div class="eth-item" :class="{ ok: ethDiag.tcp === 1, fail: ethDiag.tcp === 0 }">
              <span class="eth-label">TCP 客户端</span>
              <span class="eth-value">{{ ethDiag.tcp === 1 ? '已连接' : '无连接' }}</span>
            </div>
          </div>
          <div class="card-values">
            <span v-if="ethDiag.updatedAt">最后更新：{{ new Date(ethDiag.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</span>
            <span v-else>尚未查询 ETH 诊断信息</span>
          </div>
        </div>

        <!-- Save / Reset -->
        <div class="action-row">
          <button class="btn-save" :disabled="!hasActiveChannel || isChannelBusy" @click="saveConfig">
            &#128190; 保存到 Flash
          </button>
          <button class="btn-reset" :disabled="!hasActiveChannel || isChannelBusy" @click="resetConfig">
            &#128260; 恢复出厂设置
          </button>
          <span class="action-hint">下发通道：{{ dispatchChannelLabel }} · {{ isChannelBusy ? '通信中...' : '就绪' }}</span>
        </div>

        <!-- Tuning Guide -->
        <div class="tuning-note">
          <h3>调参指南</h3>
          <p>1. 变温工况 TRAN：升温太慢 → 增大 Kp (3→5)；温度过冲 → 增大 Kd (1→3)；稳态偏差 → 增大 Ki (0.3→0.6)</p>
          <p>2. 积分分离：大偏差(|error|>sepThreshold)时关闭积分防饱和；进入范围内再开启。积分饱和 → 增大 sepThreshold (10→15)</p>
          <p>3. 微调工况 FINE：近目标小幅振荡 → 减小 Kp (1.5→0.8)、增大 Kd (2→4)</p>
          <p>4. 微调进入条件：稳定 + entryMin ≤ |error| ≤ entryMax。过早进入微调 → 减小 entryMax；迟迟不进 → 增大 entryMin</p>
          <p>5. 微调收敛慢 → 增大 Ki (0.1→0.3)；PWM 跳太快 → 增大间隔 (8→15) 或减小 range (5→3)</p>
          <p>6. Smith 预估：先关闭 Smith 调 PID；滞后明显再启用，从 blend=0.3、maxlead=4°C 起步；PFB 比 FB 超前过多时先降 blend，再降 maxlead 或增大 tau</p>
          <p>7. 死区 DEADBAND：目标附近小幅振荡 → 增大 (0.3→0.5)；偏差稳定在 0.5°C → 减小 (0.3→0.1)</p>
          <p>8. 修改网络配置后需重启设备；调参完成后务必执行「保存到 Flash」以免断电丢失</p>
        </div>
      </div>
    </div>

    <div class="side-column">
      <div class="panel side-panel">
        <div class="param-records">
          <div class="records-head">
            <div>
              <span class="records-kicker">参数档案</span>
              <h2>调参记录</h2>
            </div>
            <strong>{{ paramRecords.length }}</strong>
          </div>

          <div class="record-save-row">
            <input
              v-model.trim="paramRecordName"
              type="text"
              maxlength="32"
              placeholder="给当前参数取个名字"
              @keyup.enter="saveParamRecord"
            />
            <button type="button" class="btn-record-save" @click="saveParamRecord">保存</button>
          </div>

          <div v-if="paramRecords.length" class="record-list">
            <article v-for="record in paramRecords" :key="record.id" class="record-item">
              <button type="button" class="record-main" @click="openParamRecord(record)">
                <strong>{{ record.name }}</strong>
                <span>{{ formatRecordTime(record.createdAt) }}</span>
                <small>
                  TRAN Kp={{ fmt(record.snapshot.tran.kp, 2) }} ·
                  FINE Kp={{ fmt(record.snapshot.fine.kp, 2) }} ·
                  DB={{ fmt(record.snapshot.deadband, 2) }}
                </small>
              </button>
              <button type="button" class="record-delete" title="删除记录" :disabled="applyingParamRecord" @click="deleteParamRecord(record)">×</button>
            </article>
          </div>

          <p v-else class="record-empty">还没有保存过参数方案。</p>
        </div>

        <div class="panel-heading compact">
          <div>
            <h2>快捷查询</h2>
          </div>
        </div>
        <div class="action-row compact-actions">
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryState">查询状态</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryTran">查询变温</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryFine">查询微调</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="querySmith">查询 Smith</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryFineEnable">查询微调开关</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryDeadband">查询死区</button>
          <button class="btn-side btn-side-full" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryNet">查询网络</button>
          <button class="btn-side btn-side-full btn-eth" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryEth">诊断 ETH</button>
        </div>

        <div class="indicators">
          <article v-for="item in derivedIndicators" :key="item.label" class="indicator-card" :class="{ 'indicator-ok': item.tone === 'ok', 'indicator-warn': item.tone === 'warn' }">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div class="note-box">
          <h3>&#128274; 通道隔离说明</h3>
          <p>串口和网口各自维护独立的收发缓冲区和协议状态机</p>
          <p>指令下发通道与曲线数据主通道可独立选择</p>
          <p class="note-warn">网络配置修改后需重启 STM32 设备才能生效</p>
        </div>
      </div>
    </div>

    <div v-if="selectedParamRecord" class="record-dialog-overlay" @click.self="closeParamRecordDialog">
      <section class="record-dialog" role="dialog" aria-modal="true" aria-labelledby="record-dialog-title">
        <div class="record-dialog-head">
          <div>
            <span>参数方案详情</span>
            <h2 id="record-dialog-title">{{ selectedParamRecord.name }}</h2>
            <p>{{ formatRecordTime(selectedParamRecord.createdAt) }}</p>
          </div>
          <button type="button" class="record-dialog-close" title="关闭" :disabled="applyingParamRecord" @click="closeParamRecordDialog">×</button>
        </div>

        <div class="record-detail-groups">
          <article v-for="group in selectedRecordGroups" :key="group.title" class="record-detail-group">
            <h3>{{ group.title }}</h3>
            <dl>
              <template v-for="row in group.rows" :key="`${group.title}-${row[0]}`">
                <dt>{{ row[0] }}</dt>
                <dd>{{ row[1] }}</dd>
              </template>
            </dl>
          </article>
        </div>

        <div class="record-dialog-actions">
          <div>
            <strong>应用到设备</strong>
            <span>{{ paramRecordApplyStatus || `将按顺序下发到${dispatchChannelLabel}，每一步成功后才继续。` }}</span>
          </div>
          <button
            v-if="pendingApplyRecord?.id !== selectedParamRecord.id"
            type="button"
            class="btn-record-apply"
            :disabled="!hasActiveChannel || isChannelBusy || applyingParamRecord"
            @click="requestApplyParamRecord(selectedParamRecord)"
          >
            应用
          </button>
          <div v-else class="record-confirm-actions">
            <button type="button" class="btn-record-cancel" :disabled="applyingParamRecord" @click="cancelApplyParamRecord">取消</button>
            <button
              type="button"
              class="btn-record-confirm"
              :disabled="!hasActiveChannel || isChannelBusy || applyingParamRecord"
              @click="confirmApplyParamRecord"
            >
              {{ applyingParamRecord ? '应用中...' : '确定应用' }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.tuning-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(min(26rem, 100%), 0.95fr);
  gap: clamp(0.8rem, 1.4vw, 1.15rem);
  align-items: start;
}

.main-column,
.side-column {
  display: grid;
  gap: 1rem;
}

.panel {
  background: var(--tc-panel-bg);
  border: 1px solid var(--tc-panel-border);
  border-radius: 1.5rem;
  box-shadow: var(--tc-panel-shadow);
  padding: clamp(1rem, 1.8vw, 1.35rem);
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
}
.panel-heading.compact { margin-bottom: 0.85rem; }

.panel-heading h2,
.card-head h3,
.tuning-note h3,
.note-box h3,
.indicator-card strong { color: var(--tc-text-primary); }

.card-desc, .channel-hint, .action-hint, .param-range,
.indicator-card span, .note-box p, .tuning-note p, .card-values,
.sys-label, .sys-value { color: var(--tc-text-secondary); }

.mode-badge {
  border-radius: 999px;
  padding: 0.55rem 0.85rem;
  color: #d6f5ff;
  background: rgba(15, 113, 148, 0.26);
  border: 1px solid rgba(49, 221, 255, 0.22);
  font-size: 0.82rem;
}

/* Channel Selector */
.channel-selector {
  padding: 1rem 1.1rem;
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
  margin: 0.85rem 0;
}
.channel-selector-head {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-bottom: 0.65rem;
  flex-wrap: wrap;
}
.channel-selector-head h3 { color: var(--tc-text-primary); font-size: 0.95rem; }
.channel-hint { font-size: 0.76rem; color: var(--tc-text-dim); }
.channel-buttons { display: flex; gap: 0.65rem; flex-wrap: wrap; }
.channel-btn {
  padding: 0.6rem 1.05rem;
  border-radius: 999px;
  font-weight: 600;
  font-size: 0.84rem;
  border: 1px solid rgba(120, 149, 187, 0.2);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.85), rgba(33, 49, 71, 0.85));
  color: var(--tc-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}
.channel-btn:hover { border-color: rgba(49, 221, 255, 0.2); }
.channel-btn.active {
  color: var(--tc-text-primary);
  border-color: rgba(49, 221, 255, 0.35);
  background: rgba(0, 137, 176, 0.28);
  box-shadow: 0 0 14px rgba(0, 180, 255, 0.16);
}
.channel-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.channel-warning { color: #ffb347; margin-top: 0.5rem; font-size: 0.8rem; }

/* Param Cards */
.param-card {
  border-radius: 1.15rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(122, 148, 177, 0.12);
  padding: 1.1rem;
  margin-bottom: 1rem;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem;
  margin-bottom: 0.9rem;
}
.card-head h3 { font-size: 1.02rem; }
.card-desc { font-size: 0.76rem; color: var(--tc-text-dim); flex: 1 1 10rem; }
.card-actions { display: flex; gap: 0.45rem; flex-wrap: wrap; }

.btn-query, .btn-dispatch, .btn-side, .btn-save, .btn-reset {
  border: 1px solid transparent;
  border-radius: 0.8rem;
  cursor: pointer;
  padding: 0.52rem 0.82rem;
  font-weight: 600;
  font-size: 0.8rem;
  transition: all 0.18s ease;
  white-space: nowrap;
}
.btn-query {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.85), rgba(33, 49, 71, 0.85));
  border-color: rgba(120, 149, 187, 0.18);
}
.btn-query:hover { border-color: rgba(120, 149, 187, 0.3); }
.btn-dispatch {
  color: #031521;
  background: linear-gradient(135deg, #41e3ff, #7ee8ff);
}
.btn-dispatch:hover { box-shadow: 0 0 12px rgba(49, 221, 255, 0.25); }
.btn-query:disabled, .btn-dispatch:disabled, .btn-side:disabled,
.btn-save:disabled, .btn-reset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.param-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.param-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.param-item {
  display: grid;
  gap: 0.35rem;
}
.param-item label {
  color: var(--tc-text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
}
.param-item input {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border-radius: 0.8rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
  font-size: 0.88rem;
  font-weight: 500;
}
.param-item input:focus {
  border-color: rgba(49, 221, 255, 0.38);
  outline: none;
  box-shadow: 0 0 6px rgba(49, 221, 255, 0.08);
}
.param-item-wide {
  grid-column: 1 / -1;
}
.param-range {
  font-size: 0.7rem;
  color: var(--tc-text-dim);
}
.card-values {
  margin-top: 0.7rem;
  padding: 0.55rem 0.75rem;
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.18);
  font-size: 0.78rem;
  font-family: 'Courier New', 'Consolas', monospace;
  color: var(--tc-text-dim);
  word-break: break-all;
}

/* System Control Status */
.sys-ctrl-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}
.sys-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.55rem 0.75rem;
  border-radius: 0.7rem;
  background: rgba(0, 0, 0, 0.15);
}
.sys-label { font-size: 0.8rem; }
.sys-value { font-weight: 600; font-size: 0.88rem; color: var(--tc-text-primary); }
.sys-value.auto { color: #31ddff; }
.sys-value.man { color: #ffb347; }
.switch-control {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  color: var(--tc-text-primary);
  font-weight: 600;
  font-size: 0.86rem;
}
.switch-control input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.switch-track {
  width: 2.8rem;
  height: 1.45rem;
  border-radius: 999px;
  background: rgba(255, 180, 71, 0.24);
  border: 1px solid rgba(255, 180, 71, 0.25);
  position: relative;
  transition: background 0.18s ease, border-color 0.18s ease;
}
.switch-thumb {
  position: absolute;
  width: 1.05rem;
  height: 1.05rem;
  top: 0.14rem;
  left: 0.16rem;
  border-radius: 50%;
  background: #fff1d8;
  transition: transform 0.18s ease, background 0.18s ease;
}
.switch-control input:checked + .switch-track {
  background: rgba(49, 221, 255, 0.24);
  border-color: rgba(49, 221, 255, 0.35);
}
.switch-control input:checked + .switch-track .switch-thumb {
  transform: translateX(1.34rem);
  background: #d6f5ff;
}
.switch-text {
  min-width: 2rem;
  text-align: left;
}

/* Actions */
.action-row {
  display: flex;
  gap: 0.7rem;
  align-items: center;
  flex-wrap: wrap;
  margin: 0.4rem 0 0.9rem;
}
.btn-save {
  color: #d7ffed;
  background: linear-gradient(135deg, rgba(20, 128, 80, 0.68), rgba(14, 92, 56, 0.68));
  border-color: rgba(78, 208, 143, 0.22);
}
.btn-save:hover { border-color: rgba(78, 208, 143, 0.35); }
.btn-reset {
  color: #fff1f1;
  background: linear-gradient(135deg, rgba(176, 52, 52, 0.65), rgba(118, 28, 28, 0.65));
  border-color: rgba(255, 138, 138, 0.2);
}
.btn-reset:hover { border-color: rgba(255, 138, 138, 0.32); }
.action-hint { font-size: 0.76rem; color: var(--tc-text-dim); margin-left: auto; }

/* Side Panel */
.side-panel {
  padding: clamp(1rem, 1.8vw, 1.35rem);
}
.compact-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
  margin: 0.85rem 0;
}
.btn-side {
  width: 100%;
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.85), rgba(33, 49, 71, 0.85));
  border-color: rgba(120, 149, 187, 0.18);
}
.btn-side:hover { border-color: rgba(120, 149, 187, 0.3); }
.btn-side-full { grid-column: 1 / -1; }
.btn-eth {
  color: #d6f5ff;
  border-color: rgba(49, 221, 255, 0.2);
  background: rgba(0, 137, 176, 0.15);
}

/* Parameter Records */
.param-records {
  margin-bottom: 1.05rem;
  padding: 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(126, 247, 201, 0.24);
  background: linear-gradient(135deg, rgba(18, 107, 79, 0.28), rgba(4, 28, 40, 0.54));
  box-shadow: 0 0 22px rgba(78, 208, 143, 0.1);
}
.records-head {
  display: flex;
  justify-content: space-between;
  gap: 0.85rem;
  align-items: flex-start;
  margin-bottom: 0.8rem;
}
.records-kicker {
  display: block;
  color: #7ef7c9;
  font-size: 0.72rem;
  font-weight: 700;
  margin-bottom: 0.2rem;
}
.records-head h2 {
  color: var(--tc-text-primary);
  font-size: 1.1rem;
}
.records-head strong {
  display: grid;
  place-items: center;
  min-width: 2rem;
  height: 2rem;
  border-radius: 0.7rem;
  color: #021a14;
  background: #7ef7c9;
}
.record-save-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.5rem;
}
.record-save-row input {
  width: 100%;
  border-radius: 0.8rem;
  border: 1px solid rgba(126, 247, 201, 0.18);
  background: rgba(3, 18, 25, 0.78);
  color: var(--tc-text-primary);
  padding: 0.58rem 0.72rem;
  font-size: 0.82rem;
}
.record-save-row input:focus {
  outline: none;
  border-color: rgba(126, 247, 201, 0.48);
}
.btn-record-save {
  border: 0;
  border-radius: 0.8rem;
  padding: 0.58rem 0.85rem;
  color: #021a14;
  background: #7ef7c9;
  font-weight: 800;
  cursor: pointer;
}
.record-list {
  display: grid;
  gap: 0.55rem;
  margin-top: 0.75rem;
  max-height: 16rem;
  overflow: auto;
  padding-right: 0.15rem;
}
.record-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.45rem;
  align-items: stretch;
}
.record-main {
  display: grid;
  gap: 0.2rem;
  text-align: left;
  border: 1px solid rgba(126, 247, 201, 0.12);
  border-radius: 0.75rem;
  background: rgba(0, 0, 0, 0.18);
  color: var(--tc-text-primary);
  padding: 0.62rem 0.7rem;
  cursor: pointer;
}
.record-main:hover {
  border-color: rgba(126, 247, 201, 0.34);
}
.record-main strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.9rem;
}
.record-main span,
.record-main small,
.record-empty {
  color: var(--tc-text-dim);
  font-size: 0.72rem;
}
.record-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.record-delete,
.record-dialog-close {
  border: 1px solid rgba(255, 138, 138, 0.18);
  border-radius: 0.75rem;
  background: rgba(176, 52, 52, 0.16);
  color: #ffd0d0;
  cursor: pointer;
  font-size: 1.15rem;
  line-height: 1;
}
.record-delete {
  width: 2.25rem;
}
.record-delete:disabled,
.record-dialog-close:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.record-empty {
  margin-top: 0.7rem;
}

.record-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgba(2, 8, 14, 0.72);
  backdrop-filter: blur(8px);
}
.record-dialog {
  width: min(44rem, 100%);
  max-height: min(82vh, 48rem);
  overflow: auto;
  border-radius: 1.15rem;
  border: 1px solid rgba(126, 247, 201, 0.22);
  background: rgba(8, 23, 34, 0.98);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
  padding: 1.1rem;
}
.record-dialog-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.record-dialog-head span {
  color: #7ef7c9;
  font-size: 0.75rem;
  font-weight: 700;
}
.record-dialog-head h2 {
  color: var(--tc-text-primary);
  margin-top: 0.15rem;
  font-size: 1.25rem;
  overflow-wrap: anywhere;
}
.record-dialog-head p {
  color: var(--tc-text-dim);
  margin-top: 0.2rem;
  font-size: 0.78rem;
}
.record-dialog-close {
  width: 2.35rem;
  height: 2.35rem;
}
.record-detail-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem;
}
.record-detail-group {
  border: 1px solid rgba(122, 148, 177, 0.12);
  border-radius: 0.85rem;
  background: rgba(255, 255, 255, 0.035);
  padding: 0.85rem;
}
.record-detail-group h3 {
  color: var(--tc-text-primary);
  font-size: 0.92rem;
  margin-bottom: 0.55rem;
}
.record-detail-group dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.45rem 0.7rem;
}
.record-detail-group dt {
  color: var(--tc-text-secondary);
  font-size: 0.78rem;
}
.record-detail-group dd {
  color: var(--tc-text-primary);
  font-size: 0.8rem;
  font-weight: 700;
  text-align: right;
}
.record-dialog-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.85rem;
  margin-top: 1rem;
  padding: 0.85rem;
  border-radius: 0.85rem;
  border: 1px solid rgba(126, 247, 201, 0.18);
  background: rgba(126, 247, 201, 0.06);
}
.record-dialog-actions div:first-child {
  display: grid;
  gap: 0.22rem;
}
.record-dialog-actions strong {
  color: var(--tc-text-primary);
  font-size: 0.88rem;
}
.record-dialog-actions span {
  color: var(--tc-text-dim);
  font-size: 0.76rem;
}
.record-confirm-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.btn-record-apply,
.btn-record-confirm,
.btn-record-cancel {
  border-radius: 0.8rem;
  padding: 0.58rem 0.85rem;
  font-weight: 800;
  cursor: pointer;
  white-space: nowrap;
}
.btn-record-apply,
.btn-record-confirm {
  border: 0;
  color: #021a14;
  background: #7ef7c9;
}
.btn-record-cancel {
  border: 1px solid rgba(122, 148, 177, 0.18);
  color: var(--tc-text-primary);
  background: rgba(255, 255, 255, 0.04);
}
.btn-record-apply:disabled,
.btn-record-confirm:disabled,
.btn-record-cancel:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Indicators */
.indicators {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
  margin-top: 1rem;
}
.indicator-card {
  padding: 0.75rem;
  border-radius: 0.85rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.12);
  display: grid;
  gap: 0.25rem;
}
.indicator-card span { font-size: 0.72rem; }
.indicator-card strong { font-size: 0.9rem; }
.indicator-ok strong { color: #7ef7c9; }
.indicator-warn strong { color: #ffb347; }

.note-box {
  margin-top: 1rem;
  padding: 0.95rem;
  border-radius: 0.95rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.12);
}
.note-box p { font-size: 0.78rem; line-height: 1.5; margin-top: 0.25rem; }
.note-warn { color: #ffb347 !important; }

.tuning-note {
  margin-top: 1rem;
  padding: 0.95rem;
  border-radius: 0.95rem;
  background: rgba(255, 180, 71, 0.05);
  border: 1px solid rgba(255, 180, 71, 0.13);
}
.tuning-note p { font-size: 0.78rem; line-height: 1.5; margin-top: 0.3rem; color: var(--tc-text-secondary); }

/* ETH Diagnostic */
.eth-diag-card {
  border-color: rgba(0, 200, 255, 0.14);
}
.eth-diag-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}
.eth-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-radius: 0.65rem;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(122, 148, 177, 0.08);
}
.eth-item-wide {
  grid-column: 1 / -1;
}
.eth-item.ok {
  border-color: rgba(78, 208, 143, 0.2);
  background: rgba(24, 112, 72, 0.1);
}
.eth-item.fail {
  border-color: rgba(255, 138, 138, 0.18);
  background: rgba(176, 52, 52, 0.08);
}
.eth-label {
  color: var(--tc-text-secondary);
  font-size: 0.78rem;
}
.eth-value {
  color: var(--tc-text-primary);
  font-weight: 600;
  font-size: 0.85rem;
}
.eth-value.mono {
  font-family: 'Courier New', monospace;
  font-size: 0.8rem;
}

@media (max-width: 1100px) {
  .tuning-layout { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .param-grid, .param-grid-3, .sys-ctrl-body, .indicators, .compact-actions, .eth-diag-grid, .record-detail-groups {
    grid-template-columns: 1fr;
  }
  .record-save-row { grid-template-columns: 1fr; }
  .record-dialog-actions { align-items: stretch; flex-direction: column; }
  .record-confirm-actions { justify-content: stretch; }
  .btn-record-apply, .btn-record-confirm, .btn-record-cancel { width: 100%; }
  .card-head { flex-direction: column; align-items: stretch; }
  .card-actions { justify-content: flex-start; }
}
</style>
