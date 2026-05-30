<template>
    <div class="history-item" :class="{ selected: session.id === selectedId }" @click="$emit('click')">
        <h3 class="history-title">{{ session.question }}</h3>
        <p class="history-summary">{{ session.answer }}</p>
    </div>
</template>

<script>
export default {
    props: {
        session: {
            type: Object,
            required: true
        },
        selectedId: {
            type: String,
            required: false
        }
    }
}
</script>

<style scoped>
.history-item {
    width: 100%;
    padding: 8px; /* 调整为更窄的间距 */
    border: 1px solid #e0e3e7;
    border-radius: 8px;
    margin-bottom: 8px; /* 减少间距 */
    cursor: pointer;
    transition: all 0.3s;
    display: flex;
    align-items: center;
    justify-content: space-between;
    overflow: hidden; /* 隐藏超出部分 */
    text-overflow: ellipsis; /* 添加省略号 */
    white-space: nowrap; /* 禁止换行 */
}

.history-item:hover {
    background-color: #f8f9fa;
}

.history-item.selected {
    border-color: var(--color-blue-soft);
    background-color: #e6f7ff;
}

.history-title {
    margin: 0;
    font-size: 14px; /* 调整字体大小 */
    color: #2c3e50;
    flex: 1; /* 占满剩余空间 */
    overflow: hidden; /* 隐藏超出部分 */
    text-overflow: ellipsis; /* 添加省略号 */
    white-space: nowrap; /* 禁止换行 */
}

.history-summary {
    display: none; /* 隐藏摘要，仅显示问题 */
}
</style>
