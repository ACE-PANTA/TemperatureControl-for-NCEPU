<script setup>
import { onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSystemConfigStore } from '../store/systemConfig.js';
import { useSimulationRuntimeStore } from '../store/simulationRuntime.js';

const configStore = useSystemConfigStore();
const simulationStore = useSimulationRuntimeStore();

const { settings } = storeToRefs(configStore);
const { recordingState, recordingStatusText, logDirectory } = storeToRefs(simulationStore);

async function pickDirectory() {
  await configStore.chooseLogDirectory();
}

onMounted(async () => {
  await configStore.ensureDefaultLogDirectory();
});
</script>

<template>
  <section class="config-layout">
    <div class="panel config-panel">
      <div class="panel-heading">
        <div>
          <h2>录制策略配置</h2>
          <p class="intro">这个页面只负责录制策略和日志目录。录制启停已经回到首页执行。</p>
        </div>
        <span class="status-badge">{{ recordingStatusText }}</span>
      </div>

      <div class="config-grid">
        <label class="switch-card">
          <span>启用 CSV 录制</span>
          <input v-model="settings.csvEnabled" type="checkbox" />
        </label>
        <label class="switch-card">
          <span>自动开始录制</span>
          <input v-model="settings.autoRecordingEnabled" type="checkbox" />
        </label>
        <label class="switch-card">
          <span>全部断连时自动暂停</span>
          <input v-model="settings.autoPauseOnDisconnect" type="checkbox" />
        </label>
        <label class="switch-card wide-card">
          <span>允许外部计算机控制</span>
          <input v-model="settings.allowRemoteControl" type="checkbox" />
          <small>
            {{ settings.allowRemoteControl ? '已开放局域网访问，HTTP 8056 / WebSocket 8057 监听 0.0.0.0' : '仅本机可访问，服务监听 127.0.0.1' }}
          </small>
        </label>
        <label>
          <span>横轴每格秒数</span>
          <input v-model.number="settings.xAxisSecondsPerDivision" type="number" min="1" max="60" step="1" />
        </label>
        <label>
          <span>横轴显示格数</span>
          <input v-model.number="settings.xAxisDivisionCount" type="number" min="4" max="12" step="1" />
        </label>
      </div>

      <div class="path-card">
        <div>
          <strong>CSV 存储路径</strong>
          <p>{{ logDirectory || '尚未设置保存目录' }}</p>
        </div>
        <button class="action-button secondary" type="button" @click="pickDirectory">选择目录</button>
      </div>

      <div class="note-box">
        <h3>当前策略说明</h3>
        <p>启用“自动开始录制”后，只要串口或网口任一接通，系统就会自动创建一组新的 CSV 会话文件。</p>
        <p>启用“全部断连时自动暂停”后，当前录制会暂停而不会直接结束。是否结束录制由首页手动决定。</p>
      </div>
    </div>

    <div class="panel side-panel">
      <div class="panel-heading compact">
        <div>
          <h2>会话状态</h2>
        </div>
      </div>

      <div class="state-list">
        <article class="state-card">
          <span>状态</span>
          <strong>{{ recordingStatusText }}</strong>
        </article>
        <article class="state-card">
          <span>当前会话号</span>
          <strong>{{ recordingState.sessionId || '暂无会话' }}</strong>
        </article>
        <article class="state-card">
          <span>是否激活</span>
          <strong>{{ recordingState.active ? '是' : '否' }}</strong>
        </article>
        <article class="state-card">
          <span>暂停原因</span>
          <strong>{{ recordingState.pauseReason || '无' }}</strong>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.config-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(min(22rem, 100%), 0.85fr);
  gap: clamp(0.8rem, 1.4vw, 1.15rem);
  align-items: start;
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
  gap: 1rem;
  align-items: flex-start;
}

.panel-heading.compact {
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
.note-box h3,
.path-card strong,
.state-card strong {
  color: var(--tc-text-primary);
}

.intro,
.note-box p,
.path-card p,
.state-card span,
.config-grid span {
  color: var(--tc-text-secondary);
}

.status-badge {
  border-radius: 999px;
  padding: 0.6rem 0.9rem;
  color: #d7ffed;
  background: rgba(24, 112, 72, 0.28);
  border: 1px solid rgba(78, 208, 143, 0.24);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.85rem;
  margin: 1.1rem 0;
}

.config-grid label,
.switch-card,
.path-card,
.state-card,
.note-box {
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.config-grid label,
.switch-card {
  display: grid;
  gap: 0.55rem;
  padding: 0.95rem;
}

.config-grid input {
  width: 100%;
  padding: 0.75rem 0.9rem;
  border-radius: 0.9rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
}

.switch-card input {
  width: auto;
  justify-self: start;
  padding: 0;
}

.wide-card {
  grid-column: 1 / -1;
}

.wide-card small {
  color: var(--tc-text-dim);
  line-height: 1.5;
}

.path-card {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: center;
  padding: 1rem;
}

.action-button {
  border: 1px solid transparent;
  border-radius: 1rem;
  cursor: pointer;
  padding: 0.75rem 1rem;
  font-weight: 600;
}

.action-button.secondary {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  border-color: rgba(120, 149, 187, 0.2);
}

.note-box {
  margin-top: 1rem;
  padding: 1rem;
}

.state-list {
  display: grid;
  gap: 0.75rem;
}

.state-card {
  padding: 1rem;
  display: grid;
  gap: 0.4rem;
}

@media (max-width: 960px) {
  .config-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .config-grid {
    grid-template-columns: 1fr;
  }

  .panel-heading,
  .path-card {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
