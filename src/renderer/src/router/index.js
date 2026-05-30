import { createRouter, createWebHashHistory } from 'vue-router';
import Home from '../views/Home.vue';
import PidTuning from '../views/PidTuning.vue';
import SystemConfig from '../views/SystemConfig.vue';
 
const routes = [
  {
    path: '/',
    name: 'home',
    component: Home,
  },
  {
    path: '/pid',
    name: 'pid',
    component: PidTuning,
  },
  {
    path: '/config',
    name: 'config',
    component: SystemConfig,
  }
];
 
const router = new createRouter({
  history: createWebHashHistory(),
  routes
});
 
export default router;