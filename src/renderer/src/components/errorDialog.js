import { createApp } from 'vue';
import ErrorDialog from '../components/ErrorDialog.vue';

let errorDialogInstance = null;

export function showErrorDialog(message) {
    if (!errorDialogInstance) {
        // 创建一个 DOM 容器
        const container = document.createElement('div');
        document.body.appendChild(container);

        // 创建 Vue 应用实例并挂载
        const app = createApp(ErrorDialog);
        errorDialogInstance = app.mount(container);
    }

    // 确保实例存在后调用组件的 `showError` 方法显示错误信息
    if (errorDialogInstance) {
        errorDialogInstance.showError(message);
    }
}