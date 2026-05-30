<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AlertStack from './components/AlertStack.vue';

const route = useRoute();

const currentMeta = computed(() => {
  if (route.name === 'config') {
    return {
      title: '系统配置中心',
      subtitle: '录制策略 / 存储路径 / 横轴设置'
    };
  }

  if (route.name === 'pid') {
    return {
      title: 'PID整定工作站',
      subtitle: '参数整定 / 输出限制 / 控制策略'
    };
  }

  return {
    title: '温控炉测温监控台',
    subtitle: '串口 / 网口接入与实时温度曲线监视'
  };
});

function exitApp() {
  window.close();
}
</script>

<template>
  <div class="app-shell">
    <AlertStack />
    <header class="shell-header">
      <div>
        <p class="shell-kicker">Author:郭佳恺，侯子航</p>
        <h1>{{ currentMeta.title }}</h1>
        <p class="shell-subtitle">{{ currentMeta.subtitle }}</p>
      </div>
      <div class="shell-actions">
        <nav class="shell-nav">
          <router-link to="/" class="shell-link">监控主页</router-link>
          <router-link to="/pid" class="shell-link">PID整定</router-link>
          <router-link to="/config" class="shell-link">系统配置</router-link>
        </nav>
        <button class="exit-button" @click="exitApp">退出系统</button>
      </div>
    </header>
    <main class="shell-content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: calc(100vh - clamp(1.7rem, 3.2vw, 2.5rem));
  display: grid;
  grid-template-rows: auto 1fr;
  gap: clamp(0.8rem, 1.5vw, 1.15rem);
}

.shell-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: clamp(1rem, 2vw, 1.5rem);
  padding: clamp(1rem, 2vw, 1.4rem) clamp(1.1rem, 2.2vw, 1.6rem);
  border: 1px solid rgba(126, 151, 180, 0.2);
  border-radius: 1.5rem;
  background:
    linear-gradient(135deg, rgba(13, 22, 35, 0.94), rgba(14, 44, 71, 0.9)),
    radial-gradient(circle at top right, rgba(76, 190, 255, 0.16), transparent 35%);
  box-shadow: 0 28px 60px rgba(4, 14, 24, 0.35);
}

.shell-kicker {
  font-size: clamp(0.68rem, 0.85vw, 0.78rem);
  letter-spacing: 0.28em;
  color: var(--tc-text-dim);
  text-transform: uppercase;
  margin-bottom: 0.45rem;
}

.shell-header h1 {
  font-size: clamp(1.6rem, 2.6vw, 2.1rem);
  font-weight: 700;
  color: var(--tc-text-primary);
  line-height: 1.15;
}

.shell-subtitle {
  margin-top: 0.45rem;
  color: var(--tc-text-secondary);
  font-size: clamp(0.8rem, 1vw, 0.92rem);
}

.shell-actions {
  display: flex;
  align-items: center;
  gap: 0.85rem;
}

.shell-nav {
  display: flex;
  padding: 0.35rem;
  gap: 0.5rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(148, 173, 200, 0.16);
}

.shell-link {
  padding: 0.65rem 1rem;
  border-radius: 999px;
  color: var(--tc-text-secondary);
  text-decoration: none;
  font-size: clamp(0.8rem, 0.95vw, 0.9rem);
  transition: all 0.2s ease;
}

.shell-link.router-link-exact-active {
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.18), rgba(0, 120, 255, 0.24));
  color: var(--tc-text-primary);
  box-shadow: inset 0 0 0 1px rgba(120, 209, 255, 0.2);
}

.exit-button {
  border: 1px solid rgba(253, 108, 108, 0.35);
  background: linear-gradient(135deg, rgba(163, 42, 42, 0.32), rgba(109, 22, 22, 0.5));
  color: #ffdede;
  padding: 0.65rem 1rem;
  border-radius: 0.9rem;
  cursor: pointer;
  font-size: clamp(0.8rem, 0.95vw, 0.9rem);
}

.shell-content {
  min-height: 0;
  overflow: auto;
}

@media (max-width: 1080px) {
  .shell-header {
    flex-direction: column;
    align-items: stretch;
  }

  .shell-actions {
    justify-content: space-between;
  }
}

@media (max-width: 720px) {
  .shell-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .shell-nav {
    width: 100%;
    justify-content: space-between;
  }

  .shell-link,
  .exit-button {
    text-align: center;
  }
}
</style>
