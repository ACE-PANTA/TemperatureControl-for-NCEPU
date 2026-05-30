<script setup>
import { storeToRefs } from 'pinia';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';

const deviceStore = useDeviceRuntimeStore();
const { serialConnected, ethernetConnected, primaryChannel } = storeToRefs(deviceStore);
</script>

<template>
  <section class="channel-panel">
    <div class="channel-summary">
      <span class="channel-pill" :data-active="serialConnected">串口 {{ serialConnected ? '已连接' : '未连接' }}</span>
      <span class="channel-pill" :data-active="ethernetConnected">网口 {{ ethernetConnected ? '已连接' : '未连接' }}</span>
    </div>

    <div v-if="serialConnected && ethernetConnected" class="primary-switcher">
      <strong>当前主通道</strong>
      <div class="switch-options">
        <button
          type="button"
          class="switch-button"
          :class="{ active: primaryChannel === 'serial' }"
          @click="deviceStore.setPrimaryChannel('serial')"
        >
          串口主通道
        </button>
        <button
          type="button"
          class="switch-button"
          :class="{ active: primaryChannel === 'ethernet' }"
          @click="deviceStore.setPrimaryChannel('ethernet')"
        >
          网口主通道
        </button>
      </div>
      <p>实时曲线显示和 PID 参数下发将跟随当前主通道。</p>
    </div>

    <p v-else class="channel-note">
      {{ primaryChannel ? `当前主通道：${primaryChannel === 'serial' ? '串口' : '网口'}` : '当前无活动主通道，请先建立连接。' }}
    </p>
  </section>
</template>

<style scoped>
.channel-panel {
  display: grid;
  gap: 0.8rem;
  padding: 0.95rem 1rem;
  border-radius: 1.1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.channel-summary,
.switch-options {
  display: flex;
  gap: 0.65rem;
  flex-wrap: wrap;
}

.channel-pill,
.switch-button {
  border-radius: 999px;
  padding: 0.55rem 0.85rem;
  font-size: 0.8rem;
}

.channel-pill {
  color: var(--tc-text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(154, 178, 203, 0.15);
}

.channel-pill[data-active='true'] {
  color: #d9fbff;
  border-color: rgba(49, 221, 255, 0.22);
  background: rgba(0, 137, 176, 0.22);
}

.primary-switcher strong,
.primary-switcher p,
.channel-note {
  color: var(--tc-text-secondary);
}

.switch-button {
  border: 1px solid rgba(120, 149, 187, 0.2);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  color: var(--tc-text-primary);
  cursor: pointer;
}

.switch-button.active {
  border-color: rgba(49, 221, 255, 0.22);
  background: rgba(0, 137, 176, 0.22);
}

.primary-switcher p,
.channel-note {
  margin: 0;
  line-height: 1.45;
}
</style>