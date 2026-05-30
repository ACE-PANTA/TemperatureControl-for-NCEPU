<script setup>
import { computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import PrimaryChannelPanel from '../components/PrimaryChannelPanel.vue';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';
import { useSimulationRuntimeStore } from '../store/simulationRuntime.js';
import { useSystemConfigStore } from '../store/systemConfig.js';

const deviceStore = useDeviceRuntimeStore();
const simulationStore = useSimulationRuntimeStore();
const configStore = useSystemConfigStore();

const { pidDraft, plantDraft, currentMetrics, latestPidDispatch, lastAppliedPid, previousAppliedPid, logDirectory } = storeToRefs(simulationStore);
const { primaryChannel } = storeToRefs(deviceStore);

const tuningProfiles = [
  { name: '保守升温', desc: '适合高热惯性炉体，抑制超调', kp: 2.1, ki: 0.34, kd: 0.26 },
  { name: '均衡工艺', desc: '综合响应速度与稳定性', kp: 2.8, ki: 0.42, kd: 0.18 },
  { name: '快速跟踪', desc: '目标段切换快，适合验证阶段', kp: 3.5, ki: 0.56, kd: 0.12 }
];

const derivedIndicators = computed(() => [
  { label: '当前超调', value: `${currentMetrics.value.overshootPercent.toFixed(2)}%` },
  { label: '稳定时间', value: currentMetrics.value.settlingTime === '--' ? '--' : `${currentMetrics.value.settlingTime} s` },
  { label: '采样周期', value: `${pidDraft.value.sampleTime} ms` },
  { label: '输出上限', value: `${pidDraft.value.outputLimit}%` },
  { label: '控制输出', value: `${currentMetrics.value.controlOutput.toFixed(1)}%` },
  { label: '扰动量', value: `${currentMetrics.value.disturbance.toFixed(3)}` }
]);

const plantSummary = computed(() => {
  return `K ${formatPlantValue(plantDraft.value.gain)} / ζ ${formatPlantValue(plantDraft.value.dampingRatio)} / ωn ${formatPlantValue(plantDraft.value.naturalFrequency)} / L ${formatPlantValue(plantDraft.value.transportDelay, 1)} s`;
});

function formatPidValue(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function formatPlantValue(value, digits = 2) {
  return Number(value || 0).toFixed(digits);
}

function applyProfile(profile) {
  simulationStore.applyProfile(profile);
}

function resetPid() {
  simulationStore.resetPidDraft();
}

async function dispatchPid() {
  await simulationStore.dispatchPidParameters();
}

function applyPlantDraft() {
  simulationStore.applyPlantDraft();
}

onMounted(async () => {
  configStore.loadPersistedState();
  await deviceStore.initializeCommunication();
  await simulationStore.ensureRunning();
});
</script>

<template>
  <section class="pid-layout">
    <div class="main-column">
      <div class="panel pid-panel">
        <div class="panel-heading">
          <div>
            <p class="panel-kicker">PID PARAMETER TUNING</p>
            <h2>控制参数整定</h2>
            <p class="intro">PID 参数优先下发到当前主通道；被控对象只有一套共享模型，串口和网口只是数据链路不同。</p>
          </div>
          <span class="mode-badge">{{ pidDraft.mode }}控制</span>
        </div>

        <PrimaryChannelPanel />

        <div class="workspace-grid">
          <section class="workspace-card tuning-card">
            <div class="section-head">
              <h3>整定工作区</h3>
              <p>滑块和数值框联动，确认后再下发。</p>
            </div>

            <div class="pid-grid">
              <div class="knob-card">
                <label>P 比例增益 Kp</label>
                <input v-model.number="pidDraft.kp" type="range" min="0.5" max="6" step="0.1" />
                <input v-model.number="pidDraft.kp" class="knob-number" type="number" min="0.5" max="6" step="0.1" />
                <strong>{{ formatPidValue(pidDraft.kp) }}</strong>
              </div>
              <div class="knob-card">
                <label>I 积分增益 Ki</label>
                <input v-model.number="pidDraft.ki" type="range" min="0.05" max="1.2" step="0.01" />
                <input v-model.number="pidDraft.ki" class="knob-number" type="number" min="0.05" max="1.2" step="0.01" />
                <strong>{{ formatPidValue(pidDraft.ki) }}</strong>
              </div>
              <div class="knob-card">
                <label>D 微分增益 Kd</label>
                <input v-model.number="pidDraft.kd" type="range" min="0.01" max="1.2" step="0.01" />
                <input v-model.number="pidDraft.kd" class="knob-number" type="number" min="0.01" max="1.2" step="0.01" />
                <strong>{{ formatPidValue(pidDraft.kd) }}</strong>
              </div>
            </div>

            <div class="form-grid">
              <label>
                <span>输出限幅</span>
                <input v-model.number="pidDraft.outputLimit" type="number" min="10" max="100" />
              </label>
              <label>
                <span>采样周期(ms)</span>
                <input v-model.number="pidDraft.sampleTime" type="number" min="100" max="2000" step="100" />
              </label>
              <label>
                <span>死区(°C)</span>
                <input v-model.number="pidDraft.deadband" type="number" min="0.1" max="10" step="0.1" />
              </label>
              <label>
                <span>设定斜率(°C/min)</span>
                <input v-model.number="pidDraft.setpointRamp" type="number" min="1" max="50" />
              </label>
              <label>
                <span>控制模式</span>
                <select v-model="pidDraft.mode">
                  <option>自动</option>
                  <option>手动</option>
                  <option>串级</option>
                </select>
              </label>
            </div>

            <div class="action-row">
              <button class="action-button primary" @click="dispatchPid">确认并下发</button>
              <button class="action-button secondary" @click="resetPid">恢复推荐值</button>
            </div>

            <p class="dispatch-note">
              {{ latestPidDispatch ? `最近一次下发：${latestPidDispatch.channel === 'serial' ? '串口' : '网口'}主通道` : '尚未执行 PID 参数下发' }}
            </p>
          </section>

          <section class="workspace-card history-card-wrap">
            <div class="section-head">
              <h3>参数对照</h3>
              <p>下发前后都保留记录，便于回退。</p>
            </div>

            <div class="history-grid">
              <article class="history-card">
                <span>当前待下发参数</span>
                <strong>Kp {{ formatPidValue(pidDraft.kp) }} / Ki {{ formatPidValue(pidDraft.ki) }} / Kd {{ formatPidValue(pidDraft.kd) }}</strong>
              </article>
              <article class="history-card">
                <span>当前已生效参数</span>
                <strong>Kp {{ formatPidValue(lastAppliedPid.kp) }} / Ki {{ formatPidValue(lastAppliedPid.ki) }} / Kd {{ formatPidValue(lastAppliedPid.kd) }}</strong>
              </article>
              <article class="history-card">
                <span>上一组参数</span>
                <strong>
                  {{ previousAppliedPid ? `Kp ${formatPidValue(previousAppliedPid.kp)} / Ki ${formatPidValue(previousAppliedPid.ki)} / Kd ${formatPidValue(previousAppliedPid.kd)}` : '暂无历史记录' }}
                </strong>
              </article>
            </div>
          </section>
        </div>
      </div>
    </div>

    <div class="side-column">
      <div class="panel profile-panel">
        <div class="panel-heading compact">
          <div>
            <p class="panel-kicker">SHARED PROCESS MODEL</p>
            <h2>被控对象参数</h2>
          </div>
        </div>

        <div class="formula-panel">
          <div class="formula-head">
            <h3>参考公式</h3>
            <span>共享于串口与网口</span>
          </div>
          <div class="equation-line">
            <span>y¨ + 2ζω<sub>n</sub>y˙ + ω<sub>n</sub><sup>2</sup>y = Kω<sub>n</sub><sup>2</sup>u(t - L)</span>
          </div>
          <div class="formula-tags">
            <span>K: 系统增益</span>
            <span>ζ: 阻尼比</span>
            <span>ωn: 固有频率</span>
            <span>L: 传输延迟</span>
          </div>
        </div>

        <div class="form-grid plant-grid">
          <label>
            <span>系统增益 K</span>
            <input v-model.number="plantDraft.gain" type="number" min="0.1" max="3" step="0.01" />
          </label>
          <label>
            <span>阻尼比 ζ</span>
            <input v-model.number="plantDraft.dampingRatio" type="number" min="0.05" max="1.2" step="0.01" />
          </label>
          <label>
            <span>固有频率 ωn</span>
            <input v-model.number="plantDraft.naturalFrequency" type="number" min="0.05" max="1" step="0.01" />
          </label>
          <label>
            <span>传输延迟 L(s)</span>
            <input v-model.number="plantDraft.transportDelay" type="number" min="1" max="10" step="0.1" />
          </label>
          <label>
            <span>加热上限(°C)</span>
            <input v-model.number="plantDraft.heaterCeiling" type="number" min="400" max="900" step="1" />
          </label>
          <label>
            <span>初始温度(°C)</span>
            <input v-model.number="plantDraft.initialTemp" type="number" min="20" max="500" step="1" />
          </label>
        </div>

        <div class="action-row compact-actions">
          <button class="action-button primary" type="button" @click="applyPlantDraft">应用对象参数</button>
        </div>

        <p class="dispatch-note">当前对象：{{ plantSummary }}</p>

        <div class="panel-heading compact section-heading">
          <div>
            <p class="panel-kicker">TUNING PROFILES</p>
            <h2>推荐策略与指标</h2>
          </div>
        </div>

        <div class="profile-list">
          <article v-for="profile in tuningProfiles" :key="profile.name" class="profile-card">
            <div>
              <strong>{{ profile.name }}</strong>
              <p>{{ profile.desc }}</p>
            </div>
            <button class="action-button tertiary" @click="applyProfile(profile)">应用</button>
          </article>
        </div>

        <div class="indicators">
          <article v-for="item in derivedIndicators" :key="item.label" class="indicator-card">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
        </div>

        <div class="note-box">
          <h3>运行说明</h3>
          <p>当前整定结果会驱动共享对象仿真，串口和网口只是不同的采集与下发链路。</p>
          <p v-if="logDirectory">日志目录：{{ logDirectory }}</p>
          <p>当前主通道：{{ primaryChannel ? (primaryChannel === 'serial' ? '串口' : '网口') : '未连接' }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pid-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(min(28rem, 100%), 1fr);
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

.panel-heading,
.section-head,
.formula-head,
.action-row,
.profile-card {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}

.panel-heading.compact,
.section-heading {
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
.section-head h3,
.formula-head h3,
.note-box h3,
.profile-card strong,
.indicator-card strong,
.history-card strong {
  color: var(--tc-text-primary);
}

.intro,
.dispatch-note,
.section-head p,
.formula-head span,
.profile-card p,
.indicator-card span,
.history-card span,
.note-box p,
.form-grid span,
.knob-card label,
.formula-tags span {
  color: var(--tc-text-secondary);
}

.mode-badge {
  border-radius: 999px;
  padding: 0.6rem 0.9rem;
  color: #d6f5ff;
  background: rgba(15, 113, 148, 0.26);
  border: 1px solid rgba(49, 221, 255, 0.22);
}

.workspace-grid {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}

.workspace-card,
.knob-card,
.history-card,
.formula-panel,
.indicator-card,
.note-box,
.profile-card {
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.workspace-card,
.formula-panel,
.note-box {
  padding: 1rem;
}

.pid-grid,
.form-grid,
.history-grid,
.profile-list,
.indicators {
  display: grid;
  gap: 0.85rem;
}

.pid-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 1rem 0;
}

.form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.knob-card {
  padding: 1rem;
}

.knob-card input,
.form-grid input,
.form-grid select,
.knob-number {
  width: 100%;
  border-radius: 0.95rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
}

.knob-card input[type='range'] {
  margin: 0.8rem 0;
}

.knob-number,
.form-grid input,
.form-grid select {
  padding: 0.75rem 0.9rem;
}

.knob-card strong {
  display: block;
  margin-top: 0.75rem;
  color: #8be7ff;
  font-size: 1.15rem;
}

.history-grid,
.profile-list,
.indicators {
  margin-top: 1rem;
}

.history-card,
.indicator-card {
  padding: 1rem;
}

.equation-line {
  font-size: clamp(1.1rem, 1.6vw, 1.35rem);
  line-height: 1.6;
  color: #f5fbff;
  letter-spacing: 0.03em;
  margin: 1rem 0 0.85rem;
}

.formula-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
}

.formula-tags span {
  padding: 0.45rem 0.7rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
}

.plant-grid {
  margin-top: 1rem;
}

.action-row {
  margin-top: 1rem;
  flex-wrap: wrap;
}

.compact-actions {
  margin-top: 0.9rem;
}

.action-button {
  border: 1px solid transparent;
  border-radius: 1rem;
  cursor: pointer;
  padding: 0.75rem 1rem;
  font-weight: 600;
}

.action-button.primary {
  color: #031521;
  background: linear-gradient(135deg, #41e3ff, #7ee8ff);
}

.action-button.secondary,
.action-button.tertiary {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  border-color: rgba(120, 149, 187, 0.2);
}

.profile-card {
  padding: 1rem;
}

.indicators {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 1100px) {
  .pid-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 820px) {
  .pid-grid,
  .form-grid,
  .indicators {
    grid-template-columns: 1fr;
  }

  .panel-heading,
  .section-head,
  .formula-head,
  .action-row,
  .profile-card {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>