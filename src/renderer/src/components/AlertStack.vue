<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';

const deviceStore = useDeviceRuntimeStore();
const { transientAlerts, warningAlerts } = storeToRefs(deviceStore);

const alerts = computed(() => [...warningAlerts.value, ...transientAlerts.value]);
</script>

<template>
  <div class="alert-stack">
    <transition-group name="stack-slide" tag="div" class="alert-stack-inner">
      <article v-for="alert in alerts" :key="alert.id" class="alert-card" :data-tone="alert.tone">
        <div>
          <strong>{{ alert.title }}</strong>
          <p>{{ alert.message }}</p>
        </div>
        <button
          type="button"
          class="alert-close"
          aria-label="关闭提示"
          @click="deviceStore.dismissAlert(alert.id)"
        >
          ×
        </button>
      </article>
    </transition-group>
  </div>
</template>

<style scoped>
.alert-stack {
  position: fixed;
  top: clamp(6.8rem, 14vh, 9.2rem);
  right: 1.15rem;
  z-index: 1400;
  width: min(26rem, calc(100vw - 2rem));
  pointer-events: none;
}

.alert-stack-inner {
  display: grid;
  gap: 0.7rem;
}

.alert-card {
  pointer-events: auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.85rem;
  align-items: start;
  padding: 0.95rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 1rem 2.4rem rgba(11, 19, 29, 0.28);
}

.alert-card[data-tone='danger'] {
  background: linear-gradient(135deg, rgba(108, 15, 26, 0.96), rgba(70, 9, 16, 0.96));
  border-color: rgba(255, 128, 128, 0.32);
}

.alert-card[data-tone='warning'] {
  background: linear-gradient(135deg, rgba(113, 81, 14, 0.95), rgba(76, 56, 11, 0.95));
  border-color: rgba(255, 214, 102, 0.35);
}

.alert-card[data-tone='success'] {
  background: linear-gradient(135deg, rgba(18, 104, 61, 0.95), rgba(11, 72, 42, 0.95));
  border-color: rgba(105, 241, 171, 0.3);
}

.alert-card strong,
.alert-card p,
.alert-close {
  color: #fff7df;
}

.alert-card p {
  margin: 0.32rem 0 0;
  line-height: 1.48;
  font-size: 0.84rem;
}

.alert-close {
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  opacity: 0.78;
}

.alert-close:hover {
  opacity: 1;
}

.stack-slide-enter-active,
.stack-slide-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}

.stack-slide-enter-from,
.stack-slide-leave-to {
  opacity: 0;
  transform: translate3d(0, -0.5rem, 0);
}

@media (max-width: 1080px) {
  .alert-stack {
    top: clamp(9.4rem, 20vh, 11.8rem);
  }
}

@media (max-width: 720px) {
  .alert-stack {
    top: clamp(11.6rem, 24vh, 14.2rem);
    right: 1rem;
    width: min(24rem, calc(100vw - 1.5rem));
  }
}
</style>