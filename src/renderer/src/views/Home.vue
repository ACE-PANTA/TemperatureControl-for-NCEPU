<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import PrimaryChannelPanel from '../components/PrimaryChannelPanel.vue';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';
import { useSimulationRuntimeStore } from '../store/simulationRuntime.js';
import { useSystemConfigStore } from '../store/systemConfig.js';

const deviceStore = useDeviceRuntimeStore();
const simulationStore = useSimulationRuntimeStore();
const configStore = useSystemConfigStore();

const {
  protocol,
  serialLoading,
  ethernetLoading,
  serialConnected,
  ethernetConnected,
  discoveredSerial,
  discoveredEthernet,
  networkAdapters,
  selectedSerialPath,
  selectedEthernetHost,
  selectedAdapterName,
  activeSerialLabel,
  activeEthernetLabel,
  serialConfig,
  ethernetConfig,
  eventTimeline,
  selectedAdapter,
  primaryChannel
} = storeToRefs(deviceStore);

const {
  chartPanOffset,
  curvePoints,
  currentTemp,
  targetTemp,
  furnaceState,
  primarySample,
  logDirectory,
  visiblePointCount,
  xAxisLabels,
  xAxisStepLabel,
  recordingStatusText,
  recordingState,
  canPauseRecording,
  canStopRecording
} = storeToRefs(simulationStore);

const { settings } = storeToRefs(configStore);

const serialDetailsOpen = ref(false);
const ethernetDetailsOpen = ref(false);
const targetTempDraft = ref('');
const targetInputFocused = ref(false);
const chartDragActive = ref(false);
const chartDragStartX = ref(0);
const chartDragStartOffset = ref(0);

const canResumeRecording = computed(() => recordingState.value.active && recordingState.value.paused);
const canStartRecording = computed(() => !recordingState.value.active);

const compactStats = computed(() => {
  const values = curvePoints.value;
  const maxTemp = Math.max(...values);
  const avgTemp = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

  return [
    { label: '峰值', value: `${maxTemp.toFixed(1)} °C` },
    { label: '均值', value: `${avgTemp} °C` },
    { label: '控制输出', value: primarySample.value ? `${primarySample.value.controlOutput.toFixed(1)} %` : '--' },
    { label: '扰动', value: primarySample.value ? primarySample.value.disturbance.toFixed(3) : '--' },
    { label: '串口', value: serialConnected.value ? '已连接' : '未连接' },
    { label: '网口', value: ethernetConnected.value ? '已连接' : '未连接' }
  ];
});

const chartBounds = computed(() => {
  const values = [...curvePoints.value, Number(targetTemp.value || 0)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(60, rawMax - rawMin);
  const padding = Math.max(10, span * 0.15);
  let min = Math.floor((rawMin - padding) / 10) * 10;
  let max = Math.ceil((rawMax + padding) / 10) * 10;

  if (max - min < 60) {
    const center = (max + min) / 2;
    min = Math.floor((center - 30) / 10) * 10;
    max = Math.ceil((center + 30) / 10) * 10;
  }

  return { min, max };
});

function mapValueToY(value) {
  const width = chartBounds.value.max - chartBounds.value.min || 1;
  const padding = 22;
  const height = 320;
  const ratio = (Number(value) - chartBounds.value.min) / width;
  return height - padding - ratio * (height - padding * 2);
}

const gridLabels = computed(() => {
  const step = (chartBounds.value.max - chartBounds.value.min) / 6;
  return Array.from({ length: 7 }, (_, index) => Number((chartBounds.value.max - step * index).toFixed(0)));
});

const chartGridLines = computed(() => gridLabels.value.map((label) => ({ label, y: mapValueToY(label) })));

const targetBandRect = computed(() => {
  const band = Math.max(4, Number(targetTemp.value || 0) * 0.01);
  const upper = mapValueToY(Number(targetTemp.value) + band);
  const lower = mapValueToY(Number(targetTemp.value) - band);

  return {
    y: Math.min(upper, lower),
    height: Math.abs(lower - upper)
  };
});

const chartPath = computed(() => {
  const width = 880;
  const height = 320;
  const padding = 22;
  const minValue = chartBounds.value.min;
  const maxValue = chartBounds.value.max;

  return curvePoints.value
    .map((value, index) => {
      const x = padding + (index * (width - padding * 2)) / (curvePoints.value.length - 1);
      const ratio = (value - minValue) / (maxValue - minValue);
      const y = height - padding - ratio * (height - padding * 2);

      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
});

const areaPath = computed(() => `${chartPath.value} L 858 298 L 22 298 Z`);

watch(
  () => targetTemp.value,
  (value) => {
    if (!targetInputFocused.value) {
      targetTempDraft.value = Number(value || 0).toFixed(1);
    }
  },
  { immediate: true }
);

function handleTargetInput(event) {
  const value = event.target.value;
  targetTempDraft.value = value;
  simulationStore.setTargetTemperature(value);
}

function handleTargetFocus() {
  targetInputFocused.value = true;
}

function handleTargetBlur() {
  targetInputFocused.value = false;
  targetTempDraft.value = Number(targetTemp.value || 0).toFixed(1);
}

function handleChartPointerDown(event) {
  chartDragActive.value = true;
  chartDragStartX.value = event.clientX;
  chartDragStartOffset.value = chartPanOffset.value;
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function handleChartPointerMove(event) {
  if (!chartDragActive.value) {
    return;
  }

  const width = event.currentTarget.clientWidth || 1;
  const deltaX = event.clientX - chartDragStartX.value;
  const desiredOffset = Math.max(0, Math.round(chartDragStartOffset.value + (deltaX / width) * visiblePointCount.value));
  simulationStore.panChartWindow(desiredOffset - chartPanOffset.value);
}

function stopChartDrag(event) {
  if (!chartDragActive.value) {
    return;
  }

  chartDragActive.value = false;
  event?.currentTarget?.releasePointerCapture?.(event.pointerId);
}

onMounted(async () => {
  await deviceStore.initializeCommunication();
  await simulationStore.ensureRunning();
  simulationStore.syncDraftToChannels();
});
</script>

<template>
  <section class="dashboard-grid">
    <div class="main-column">
      <div class="panel hero-panel">
        <div class="panel-heading hero-heading">
          <div>
            <h2>实时测温曲线</h2>
            <p class="panel-intro">曲线区域保持最高优先级，目标温度可在下方直接修改，参考数据改为更紧凑的辅助信息。</p>
          </div>
          <div class="status-cluster">
            <span class="status-pill status-pill-live">实时仿真运行中</span>
            <span class="status-pill">主通道 {{ primaryChannel ? (primaryChannel === 'serial' ? '串口' : '网口') : '未选择' }}</span>
            <span class="status-pill">记录状态 {{ recordingStatusText }}</span>
          </div>
        </div>

        <PrimaryChannelPanel />

        <div class="chart-card chart-priority-card">
          <div class="chart-header">
            <div>
              <h3>炉膛温度轨迹</h3>
              <p>
                当前温度 {{ currentTemp.toFixed(1) }} °C，目标温度 {{ targetTemp.toFixed(1) }} °C，当前状态 {{ furnaceState }}
              </p>
            </div>
            <div class="chart-legend compact-legend">
              <span style="color: white;"><i class="legend-dot legend-dot-cyan"></i> 实时温度</span>
              <span style="color: white;"><i class="legend-dot legend-dot-amber"></i> 目标区间</span>
              <button v-if="chartPanOffset > 0" type="button" class="latest-button" @click="simulationStore.jumpChartToLatest()">回到最新</button>
            </div>
          </div>

          <div
            class="chart-wrapper"
            @pointerdown="handleChartPointerDown"
            @pointermove="handleChartPointerMove"
            @pointerup="stopChartDrag"
            @pointercancel="stopChartDrag"
            @pointerleave="stopChartDrag"
          >
            <div class="chart-axis-labels">
              <span v-for="line in chartGridLines" :key="line.label">{{ line.label }}°C</span>
            </div>
            <svg viewBox="0 0 880 320" class="chart-svg" preserveAspectRatio="none">
              <defs>
                <linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stop-color="rgba(48, 221, 255, 0.38)" />
                  <stop offset="100%" stop-color="rgba(48, 221, 255, 0.02)" />
                </linearGradient>
              </defs>
              <g>
                <line
                  v-for="line in chartGridLines"
                  :key="line.label"
                  x1="22"
                  x2="858"
                  :y1="line.y"
                  :y2="line.y"
                  class="chart-grid"
                />
                <rect x="22" :y="targetBandRect.y" width="836" :height="targetBandRect.height" class="target-band" />
                <path :d="areaPath" fill="url(#curveFill)" />
                <path :d="chartPath" class="curve-line" />
              </g>
            </svg>
            <div class="timeline-labels">
              <span v-for="label in xAxisLabels" :key="label">{{ label }}</span>
            </div>
          </div>

          <div class="axis-note">{{ xAxisStepLabel }}</div>
        </div>

        <div class="panel temperature-panel">
          <div class="temperature-layout">
            <div class="target-panel">
              <p class="panel-kicker">TARGET CONTROL</p>
              <h3>目标温度</h3>
              <div class="target-input-row">
                <input :value="targetTempDraft" type="number" min="0" max="1200" step="1" @input="handleTargetInput" @focus="handleTargetFocus" @blur="handleTargetBlur" />
                <span>°C</span>
              </div>
              <p class="target-note">输入过程会实时同步设定值，不需要额外确认。</p>
            </div>

            <div class="live-panel">
              <article class="primary-metric-card">
                <span>当前温度</span>
                <strong>{{ currentTemp.toFixed(1) }} °C</strong>
              </article>
              <article class="primary-metric-card secondary-card">
                <span>当前状态</span>
                <strong>{{ furnaceState }}</strong>
              </article>
            </div>
          </div>

          <div class="mini-stats-grid">
            <article v-for="item in compactStats" :key="item.label" class="mini-stat-card">
              <span>{{ item.label }}</span>
              <strong>{{ item.value }}</strong>
            </article>
          </div>

          <div class="support-note-row">
            <span v-if="logDirectory">CSV 目录：{{ logDirectory }}</span>
            <span>横轴每格 {{ settings.xAxisSecondsPerDivision }} s</span>
            <span>会话号：{{ recordingState.sessionId || '暂无' }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-stack">
      <div class="panel recording-panel">
        <div class="recording-head">
          <div>
            <p class="panel-kicker">RECORDING CONTROL</p>
            <h2>录制控制</h2>
            <p>录制控制固定放在连接面板上方，便于先操作会话，再处理链路。</p>
          </div>
          <span class="recording-badge">{{ recordingStatusText }}</span>
        </div>

        <div class="recording-meta">
          <span>自动录制：{{ settings.autoRecordingEnabled ? '开启' : '关闭' }}</span>
          <span>断连自动暂停：{{ settings.autoPauseOnDisconnect ? '开启' : '关闭' }}</span>
          <span>当前会话：{{ recordingState.sessionId || '暂无' }}</span>
        </div>

        <div class="recording-actions">
          <button v-if="canStartRecording" class="action-button primary" type="button" @click="simulationStore.startRecordingSession('manual')">开始录制</button>
          <button v-if="canPauseRecording" class="action-button secondary" type="button" @click="simulationStore.pauseRecording('manual')">暂停录制</button>
          <button v-if="canResumeRecording" class="action-button primary" type="button" @click="simulationStore.resumeRecording('manual')">恢复录制</button>
          <button v-if="canStopRecording" class="action-button danger" type="button" @click="simulationStore.stopRecordingSession('manual')">结束录制</button>
        </div>
      </div>

      <div class="panel connect-panel">
        <div class="panel-heading compact">
          <div>
            <p class="panel-kicker">COMMUNICATION BUS</p>
            <h2>设备连接</h2>
          </div>
        </div>

        <div class="protocol-switch">
          <button :class="['protocol-button', { active: protocol === 'serial' }]" @click="protocol = 'serial'">COM串口</button>
          <button :class="['protocol-button', { active: protocol === 'ethernet' }]" @click="protocol = 'ethernet'">网口连接</button>
        </div>

        <div v-if="protocol === 'serial'" class="config-stack">
          <div class="scan-actions single-line">
            <button class="action-button primary" @click="deviceStore.searchSerialPorts" :disabled="serialLoading">
              {{ serialLoading ? '扫描中...' : '扫描串口' }}
            </button>
            <button class="action-button" :class="serialConnected ? 'danger' : 'secondary'" @click="serialConnected ? deviceStore.disconnectSerialPort() : deviceStore.connectSerialPort()">
              {{ serialConnected ? '断开串口' : '连接串口' }}
            </button>
          </div>

          <button type="button" class="detail-toggle" @click="serialDetailsOpen = !serialDetailsOpen">
            <span>串口详情</span>
            <strong>{{ serialDetailsOpen ? '收起' : '展开' }}</strong>
          </button>

          <div v-if="serialDetailsOpen" class="detail-stack">
            <div class="form-grid serial-form">
              <label>
                <span>端口</span>
                <select v-model="selectedSerialPath">
                  <option disabled value="">请选择串口</option>
                  <option v-for="device in discoveredSerial" :key="device.path" :value="device.path">
                    {{ device.path }} · {{ device.friendlyName }}
                  </option>
                </select>
              </label>
              <label>
                <span>波特率</span>
                <input v-model.number="serialConfig.baudRate" type="number" min="1200" step="1200" />
              </label>
              <label>
                <span>数据位</span>
                <select v-model.number="serialConfig.dataBits">
                  <option :value="8">8</option>
                  <option :value="7">7</option>
                </select>
              </label>
              <label>
                <span>停止位</span>
                <select v-model.number="serialConfig.stopBits">
                  <option :value="1">1</option>
                  <option :value="2">2</option>
                </select>
              </label>
              <label>
                <span>校验位</span>
                <select v-model="serialConfig.parity">
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </label>
            </div>

            <div class="device-list compact-list">
              <article v-for="device in discoveredSerial" :key="device.path" class="device-card serial-device-card">
                <div>
                  <strong>{{ device.path }}</strong>
                  <span>{{ device.manufacturer }}</span>
                  <span v-if="device.vendorId || device.productId">VID:{{ device.vendorId || '--' }} / PID:{{ device.productId || '--' }}</span>
                </div>
              </article>
              <div v-if="!discoveredSerial.length" class="empty-state">当前系统未发现可用 COM 设备</div>
            </div>
          </div>
        </div>

        <div v-else class="config-stack">
          <div class="scan-actions single-line">
            <button class="action-button primary" @click="deviceStore.searchEthernetDevices" :disabled="ethernetLoading">
              {{ ethernetLoading ? '扫描中...' : '扫描当前网段' }}
            </button>
            <button class="action-button" :class="ethernetConnected ? 'danger' : 'secondary'" @click="ethernetConnected ? deviceStore.disconnectEthernetDevice() : deviceStore.connectEthernetDevice()">
              {{ ethernetConnected ? '断开网口' : '测试并连接' }}
            </button>
          </div>

          <button type="button" class="detail-toggle" @click="ethernetDetailsOpen = !ethernetDetailsOpen">
            <span>网口详情</span>
            <strong>{{ ethernetDetailsOpen ? '收起' : '展开' }}</strong>
          </button>

          <div v-if="ethernetDetailsOpen" class="detail-stack">
            <div class="form-grid ethernet-form">
              <label>
                <span>本机网卡</span>
                <select :value="selectedAdapterName" @change="deviceStore.applyAdapter($event.target.value)">
                  <option disabled value="">请选择网卡</option>
                  <option v-for="adapter in networkAdapters" :key="adapter.name + adapter.address" :value="adapter.name">
                    {{ adapter.name }} · {{ adapter.address }}
                  </option>
                </select>
              </label>
              <label>
                <span>扫描子网</span>
                <input v-model="ethernetConfig.subnetPrefix" type="text" placeholder="192.168.10." />
              </label>
              <label>
                <span>扫描端口</span>
                <input v-model.number="ethernetConfig.scanPort" type="number" min="1" max="65535" />
              </label>
              <label>
                <span>超时(ms)</span>
                <input v-model.number="ethernetConfig.timeoutMs" type="number" min="50" max="3000" />
              </label>
              <label>
                <span>目标IP</span>
                <input v-model="ethernetConfig.host" type="text" placeholder="192.168.10.42" />
              </label>
              <label>
                <span>目标端口</span>
                <input v-model.number="ethernetConfig.port" type="number" min="1" max="65535" />
              </label>
            </div>

            <div class="adapter-summary" v-if="selectedAdapter">
              <span>当前网卡：{{ selectedAdapter.name }}</span>
              <span>IPv4：{{ selectedAdapter.address }}</span>
              <span>子网掩码：{{ selectedAdapter.netmask }}</span>
            </div>

            <div class="device-list compact-list">
              <label v-for="device in discoveredEthernet" :key="device.id" class="device-card selectable-card">
                <input v-model="selectedEthernetHost" :value="device.address" type="radio" @change="ethernetConfig.host = device.address" />
                <div>
                  <strong>{{ device.address }}:{{ device.port }}</strong>
                  <span>{{ device.status }}</span>
                  <span>延迟 {{ device.latencyMs }} ms</span>
                </div>
              </label>
              <div v-if="!discoveredEthernet.length" class="empty-state">尚未在当前子网发现开放端口设备</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel event-panel">
        <div class="panel-heading compact">
          <div>
            <p class="panel-kicker">SYSTEM EVENTS</p>
            <h2>系统状态</h2>
          </div>
        </div>

        <div class="event-list">
          <article v-for="event in eventTimeline" :key="`${event.time}-${event.text}`" class="event-item">
            <span class="event-time">{{ event.time }}</span>
            <p>{{ event.text }}</p>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(min(28rem, 100%), 0.95fr);
  gap: clamp(0.8rem, 1.5vw, 1.15rem);
  align-items: start;
}

.main-column,
.sidebar-stack {
  display: grid;
  gap: clamp(0.8rem, 1.4vw, 1rem);
}

.panel {
  background: var(--tc-panel-bg);
  border: 1px solid var(--tc-panel-border);
  border-radius: 1.5rem;
  box-shadow: var(--tc-panel-shadow);
  backdrop-filter: blur(1rem);
}

.hero-panel,
.connect-panel,
.event-panel,
.recording-panel,
.temperature-panel {
  padding: clamp(1rem, 1.8vw, 1.35rem);
}

.temperature-panel {
  margin-top: 1rem;
}

.panel-heading,
.hero-heading,
.chart-header,
.recording-head,
.recording-actions,
.recording-meta,
.temperature-layout,
.target-input-row,
.support-note-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.compact {
  margin-bottom: 1rem;
}

.hero-heading {
  margin-bottom: 1rem;
}

.panel-kicker {
  font-size: clamp(0.68rem, 0.84vw, 0.76rem);
  letter-spacing: 0.24em;
  color: var(--tc-text-dim);
  text-transform: uppercase;
  margin-bottom: 0.45rem;
}

.panel-heading h2,
.hero-heading h2,
.recording-head h2,
.chart-header h3,
.target-panel h3,
.primary-metric-card strong,
.mini-stat-card strong,
.device-card strong,
.detail-toggle,
.event-time {
  color: var(--tc-text-primary);
}

.panel-intro,
.chart-header p,
.event-item p,
.device-card span,
.empty-state,
.adapter-summary span,
.form-grid span,
.recording-head p,
.recording-meta span,
.target-note,
.mini-stat-card span,
.primary-metric-card span,
.support-note-row span {
  color: var(--tc-text-secondary);
}

.hero-heading h2 {
  font-size: clamp(1.3rem, 2vw, 1.7rem);
  font-weight: 650;
}

.status-cluster,
.chart-legend,
.protocol-switch,
.scan-actions,
.form-grid,
.device-list,
.mini-stats-grid,
.event-list,
.detail-stack,
.live-panel {
  display: grid;
  gap: 0.75rem;
}

.status-cluster {
  display: flex;
}

.status-pill {
  border-radius: 999px;
  padding: 0.55rem 0.8rem;
  font-size: clamp(0.72rem, 0.9vw, 0.8rem);
  color: var(--tc-text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(154, 178, 203, 0.15);
}

.status-pill-live {
  color: #baf9ff;
  border-color: rgba(48, 221, 255, 0.24);
  background: rgba(3, 88, 109, 0.32);
}

.chart-priority-card {
  margin-top: 1rem;
}

.chart-card {
  padding: 1rem;
  border-radius: 1.35rem;
  background: linear-gradient(180deg, rgba(4, 17, 28, 0.84), rgba(7, 24, 38, 0.92));
  border: 1px solid rgba(67, 95, 124, 0.36);
}

.compact-legend {
  display: flex;
  font-size: clamp(0.72rem, 0.86vw, 0.8rem);
}

.legend-dot {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  margin-right: 0.38rem;
}

.legend-dot-cyan { background: #31ddff; }
.legend-dot-amber { background: #ffb347; }

.chart-wrapper {
  margin-top: 1rem;
  display: grid;
  grid-template-columns: minmax(3.2rem, 4.2rem) minmax(0, 1fr);
  gap: 0.75rem;
  align-items: stretch;
  touch-action: none;
}

.chart-axis-labels {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  color: var(--tc-text-dim);
  font-size: clamp(0.68rem, 0.82vw, 0.76rem);
  padding: 0.3rem 0 1.2rem;
}

.chart-svg {
  width: 100%;
  min-height: 18rem;
  height: min(42vw, 20rem);
  cursor: grab;
}

.chart-wrapper:active .chart-svg {
  cursor: grabbing;
}

.chart-grid {
  stroke: rgba(145, 165, 188, 0.14);
  stroke-width: 1;
}

.target-band {
  fill: rgba(255, 179, 71, 0.08);
  stroke: rgba(255, 179, 71, 0.24);
  stroke-dasharray: 8 6;
}

.curve-line {
  fill: none;
  stroke: #31ddff;
  stroke-width: 4;
  stroke-linejoin: round;
  stroke-linecap: round;
  filter: drop-shadow(0 0 8px rgba(49, 221, 255, 0.25));
}

.timeline-labels {
  grid-column: 2;
  display: flex;
  justify-content: space-between;
  color: var(--tc-text-dim);
  font-size: clamp(0.68rem, 0.82vw, 0.76rem);
  margin-top: -0.2rem;
}

.axis-note {
  margin-top: 0.45rem;
  color: var(--tc-text-dim);
  font-size: 0.76rem;
  text-align: right;
}

.latest-button {
  border: 1px solid rgba(120, 149, 187, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--tc-text-primary);
  padding: 0.35rem 0.7rem;
  cursor: pointer;
}

.temperature-layout {
  align-items: stretch;
}

.target-panel,
.live-panel {
  flex: 1 1 16rem;
}

.target-panel {
  padding: 1rem;
  border-radius: 1.2rem;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.03));
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.target-input-row {
  align-items: center;
  margin: 0.9rem 0 0.55rem;
}

.target-input-row input {
  flex: 1;
  min-width: 10rem;
  padding: 0.85rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
  font-size: clamp(1.05rem, 1.5vw, 1.2rem);
  font-weight: 600;
}

.target-input-row span {
  color: #8be7ff;
  font-weight: 700;
  align-self: center;
}

.live-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.primary-metric-card,
.mini-stat-card,
.recording-panel,
.device-card,
.adapter-summary,
.event-item {
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.primary-metric-card {
  padding: 1rem;
  display: grid;
  gap: 0.45rem;
}

.primary-metric-card strong {
  font-size: clamp(1.2rem, 1.9vw, 1.55rem);
}

.secondary-card strong {
  font-size: clamp(1rem, 1.45vw, 1.2rem);
}

.mini-stats-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-top: 0.95rem;
}

.mini-stat-card {
  padding: 0.75rem 0.8rem;
  display: grid;
  gap: 0.25rem;
}

.mini-stat-card span {
  font-size: 0.73rem;
}

.mini-stat-card strong {
  font-size: 0.92rem;
}

.support-note-row {
  margin-top: 0.9rem;
}

.recording-panel {
  padding: 1rem;
}

.recording-badge {
  border-radius: 999px;
  padding: 0.55rem 0.85rem;
  color: #d7ffed;
  background: rgba(24, 112, 72, 0.28);
  border: 1px solid rgba(78, 208, 143, 0.24);
}

.recording-meta {
  margin: 0.95rem 0;
}

.protocol-switch,
.scan-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.single-line {
  margin: 0.9rem 0 0;
}

.form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.serial-form,
.ethernet-form {
  margin-bottom: 0.2rem;
}

.form-grid label {
  display: grid;
  gap: 0.45rem;
}

.form-grid input,
.form-grid select,
.protocol-button,
.action-button {
  width: 100%;
  border-radius: 1rem;
}

.form-grid input,
.form-grid select {
  padding: 0.75rem 0.9rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
}

.protocol-button,
.action-button,
.detail-toggle {
  border: 1px solid transparent;
  cursor: pointer;
  transition: 0.2s ease;
  padding: 0.75rem 0.9rem;
  font-weight: 600;
}

.protocol-button {
  color: var(--tc-text-secondary);
  background: rgba(255, 255, 255, 0.04);
}

.protocol-button.active {
  color: var(--tc-text-primary);
  border-color: rgba(49, 221, 255, 0.22);
  background: rgba(0, 137, 176, 0.22);
}

.action-button.primary {
  color: #021826;
  background: linear-gradient(135deg, #41e3ff, #7ee8ff);
}

.action-button.secondary {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  border-color: rgba(120, 149, 187, 0.2);
}

.action-button.danger {
  color: #fff1f1;
  background: linear-gradient(135deg, rgba(176, 52, 52, 0.95), rgba(118, 28, 28, 0.95));
  border-color: rgba(255, 138, 138, 0.24);
}

.detail-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  border-color: rgba(122, 148, 177, 0.14);
  background: rgba(255, 255, 255, 0.04);
}

.detail-toggle strong {
  color: var(--tc-text-dim);
}

.compact-list {
  max-height: min(28vh, 16rem);
  overflow: auto;
  padding-right: 0.15rem;
}

.device-card {
  display: grid;
  gap: 0.3rem;
  padding: 0.9rem;
}

.serial-device-card {
  grid-template-columns: 1fr;
}

.selectable-card {
  grid-template-columns: 1rem 1fr;
  align-items: start;
  gap: 0.7rem;
}

.adapter-summary,
.event-item {
  padding: 0.9rem 1rem;
}

.event-list {
  max-height: min(34vh, 18rem);
  overflow: auto;
  padding-right: 0.15rem;
}

.event-time {
  display: inline-flex;
  font-size: clamp(0.7rem, 0.84vw, 0.78rem);
  color: #8be7ff;
  margin-bottom: 0.45rem;
}

.empty-state {
  padding: 1rem 0;
  text-align: center;
}

@media (max-width: 82rem) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 62rem) {
  .mini-stats-grid,
  .form-grid,
  .protocol-switch,
  .scan-actions,
  .live-panel {
    grid-template-columns: 1fr;
  }

  .chart-wrapper {
    grid-template-columns: 1fr;
  }

  .chart-axis-labels {
    display: none;
  }

  .timeline-labels {
    grid-column: 1;
  }
}

@media (max-width: 48rem) {
  .panel-heading,
  .hero-heading,
  .chart-header,
  .recording-head,
  .recording-actions,
  .recording-meta,
  .temperature-layout,
  .support-note-row {
    flex-direction: column;
    align-items: stretch;
  }

  .mini-stats-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 34rem) {
  .mini-stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>