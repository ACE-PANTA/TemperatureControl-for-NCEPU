import { createRouter, createWebHashHistory } from 'vue-router';
import Home from '../views/Home.vue';
import ParamTuning from '../views/ParamTuning.vue';
import SystemConfig from '../views/SystemConfig.vue';

const routes = [
  {
    path: '/',
    name: 'home',
    component: Home,
  },
  {
    path: '/tuning',
    name: 'tuning',
    component: ParamTuning,
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