<template>
    <div v-if="visible" class="error-dialog-overlay">
        <div class="error-dialog">
            <p class="error-message">{{ message }}</p>
            <button class="close-button" @click="closeDialog">关闭</button>
        </div>
    </div>
</template>

<script>
export default {
    name: "ErrorDialog",
    data() {
        return {
            visible: false,
            message: "",
        };
    },
    methods: {
        showError(message) {
            this.message = message;
            this.visible = true;
        },
        closeDialog() {
            this.visible = false;
            this.message = "";
        },
    },
};
</script>

<style scoped>
.error-dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
}

.error-dialog {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    text-align: center;
}

.error-message {
    margin-bottom: 20px;
    font-size: 5vh;
    color: #333;
}

.close-button {
    margin-top: 10px;
    padding: 10px 20px;
    font-size: 3vh;
    color: #fff;
    background-color: #007bff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background-color 0.3s ease;
}

.close-button:hover {
    background-color: #0056b3;
}
.error-dialog-overlay {
    animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}
</style>