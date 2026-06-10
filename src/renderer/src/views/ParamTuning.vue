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
  pidDraft,
  netDraft,
  controllerState,
  currentTemp,
  targetTemp,
  latestPidDispatch,
  lastAppliedPid,
  serialProtocolState,
  tcpProtocolState,
  ethDiag
} = storeToRefs(simulationStore);

const ethErrLabels = simulationStore.ETH_ERR_LABELS;

const dispatchChannel = ref('serial');
const activeSection = ref('');

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

const derivedIndicators = computed(() => [
  { label: '控制模式', value: controllerState.value.mode === 'AUTO' ? '自动' : controllerState.value.mode === 'MAN' ? '手动' : '--' },
  { label: '当前目标', value: Number.isFinite(targetTemp.value) ? `${targetTemp.value.toFixed(1)} °C` : '--' },
  { label: '反馈温度', value: Number.isFinite(currentTemp.value) ? `${currentTemp.value.toFixed(1)} °C` : '--' },
  { label: '当前 PWM', value: Number.isFinite(controllerState.value.pwm) ? `${controllerState.value.pwm.toFixed(0)}%` : '--' },
  { label: '下发通道', value: dispatchChannelLabel.value },
  { label: '主数据通道', value: primaryChannel.value ? (primaryChannel.value === 'serial' ? '串口' : '网口') : '未连接' },
  { label: 'ETH LINK', value: ethDiag?.value?.link === 1 ? 'UP' : 'DOWN', tone: ethDiag?.value?.link === 1 ? 'ok' : 'warn' },
  { label: 'ETH 错误码', value: `ERR=${ethDiag?.value?.err ?? '--'}`, tone: ethDiag?.value?.err === 0 ? 'ok' : 'warn' }
]);

const lastDispatchInfo = computed(() => {
  if (!latestPidDispatch.value) return '尚未执行参数下发';
  const ch = latestPidDispatch.value.channel === 'ethernet' ? '网口' : '串口';
  const time = new Date(latestPidDispatch.value.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  return `最近下发：${ch} · ${time}`;
});

function fmt(value, digits = 3) {
  return Number(value || 0).toFixed(digits);
}

async function queryPid() {
  await simulationStore.refreshPidParameters({ channel: dispatchChannel.value });
}
async function dispatchPid() {
  await simulationStore.dispatchPidParameters(dispatchChannel.value);
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
          <span class="mode-badge">{{ controllerState.mode === 'AUTO' ? '自动模式' : controllerState.mode === 'MAN' ? '手动模式' : '模式未同步' }}</span>
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
          </div>
        </div>

        <!-- PID Parameters -->
        <div class="param-card">
          <div class="card-head">
            <h3>&#128202; 增量式 PID 参数</h3>
            <span class="card-desc">增量式 PID + 死区补偿，适配大滞后热力系统</span>
            <div class="card-actions">
              <button class="btn-query" :disabled="!hasActiveChannel || isChannelBusy" @click="queryPid">查询</button>
              <button class="btn-dispatch" :disabled="!hasActiveChannel || isChannelBusy" @click="dispatchPid">下发</button>
            </div>
          </div>
          <div class="card-body param-grid param-grid-3">
            <div class="param-item">
              <label>比例 Kp</label>
              <input v-model.number="pidDraft.kp" type="number" min="-1000" max="1000" step="0.0001" />
              <span class="param-range">-1000 ~ 1000</span>
            </div>
            <div class="param-item">
              <label>积分 Ki</label>
              <input v-model.number="pidDraft.ki" type="number" min="-1000" max="1000" step="0.0001" />
              <span class="param-range">-1000 ~ 1000</span>
            </div>
            <div class="param-item">
              <label>微分 Kd</label>
              <input v-model.number="pidDraft.kd" type="number" min="-1000" max="1000" step="0.0001" />
              <span class="param-range">-1000 ~ 1000</span>
            </div>
          </div>
          <div class="card-values">
            <span>
              Kp={{ fmt(lastAppliedPid?.kp || pidDraft.kp, 4) }} | Ki={{ fmt(lastAppliedPid?.ki || pidDraft.ki, 4) }} | Kd={{ fmt(lastAppliedPid?.kd || pidDraft.kd, 4) }}
              <template v-if="latestPidDispatch"> · {{ lastDispatchInfo }}</template>
            </span>
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
          <p>1. 设定死区时间：PID 整定间隔需 ≥ 系统纯滞后时间。升温慢的大热容系统先用 PID=3.0,0.3,1.0,10</p>
          <p>2. 升温太慢 → 增大 Kp (3→5)；温度过冲 → 增大 Kd (1→3)；稳态偏差不消 → 增大 Ki (0.3→0.6)</p>
          <p>3. PWM 大幅振荡(0↔100) → 减小 pid_max_delta (8→4) 或增大整定间隔 (5→10)</p>
          <p>4. 目标附近小幅振荡 → 增大 pid_deadband (0.3→0.5)；偏差稳定在 0.5°C 附近 → 减小死区 (0.3→0.1)</p>
          <p>5. 修改网络配置后需重启设备；调参完成后务必执行「保存到 Flash」以免断电丢失</p>
        </div>
      </div>
    </div>

    <div class="side-column">
      <div class="panel side-panel">
        <div class="panel-heading compact">
          <div>
            <h2>快捷查询</h2>
          </div>
        </div>
        <div class="action-row compact-actions">
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryState">查询状态</button>
          <button class="btn-side" type="button" :disabled="!hasActiveChannel || isChannelBusy" @click="queryPid">查询 PID</button>
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
  .param-grid, .param-grid-3, .sys-ctrl-body, .indicators, .compact-actions, .eth-diag-grid {
    grid-template-columns: 1fr;
  }
  .card-head { flex-direction: column; align-items: stretch; }
  .card-actions { justify-content: flex-start; }
}
</style>
