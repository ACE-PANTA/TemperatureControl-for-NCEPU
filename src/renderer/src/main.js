import './assets/main.css'
import router from './router/index.js'

import { createApp } from 'vue'
import App from './App.vue'
import { createPinia } from 'pinia'
const pinia=createPinia()
import { useStore } from './store/index.js'
import { showErrorDialog } from './components/errorDialog.js'

import axios from 'axios'


const app=createApp(App)
app.use(router)
app.use(pinia)

app.config.globalProperties.$showErrorDialog = showErrorDialog;

axios.interceptors.request.use(
    config => {
      // 在请求发送前处理，例如添加 token
      const token = useStore().$state.token;
      if (token) {
        config.headers.Authorization = 'Bearer '+token;
      }
      return config;
    },
    error => {
      // 处理请求错误
      return Promise.reject(error);
    }
  );

axios.interceptors.response.use(
    response => {
      if(response.status==401)
      {
        router.push('/login')
        showErrorDialog('登录信息过期，请重新登录')
      }
      else
      {
        return response;
      }
      
    },
    error => {
        if(error.response.status==401)
        {
          router.push('/login')
          showErrorDialog('登录信息过期，请重新登录')
        }
        else
        {
          return Promise.reject(error);
        }
        
    }
);

app.config.globalProperties.$axios = axios;

app.mount('#app')



