import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';

const deviceApi = window.deviceApi;

function toSubnetPrefix(address) {
  if (!address) {
    return '';
  }

  const parts = address.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}.`;
}

export const useDeviceRuntimeStore = defineStore('deviceRuntime', () => {
  const protocol = ref('serial');
  const serialLoading = ref(false);
  const ethernetLoading = ref(false);
  const serialConnected = ref(false);
  const ethernetConnected = ref(false);
  const discoveredSerial = ref([]);
  const discoveredEthernet = ref([]);
  const networkAdapters = ref([]);
  const selectedSerialPath = ref('');
  const selectedEthernetHost = ref('');
  const selectedAdapterName = ref('');
  const activeSerialLabel = ref('未连接');
  const activeEthernetLabel = ref('未连接');
  const primaryPreference = ref('serial');
  const eventTimeline = ref([]);
  const transientAlerts = ref([]);
  const dismissedWarningIds = ref([]);
  const initialized = ref(false);

  const serialConfig = reactive({
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none'
  });

  const ethernetConfig = reactive({
    host: '',
    port: 8000,
    subnetPrefix: '',
    scanPort: 8000,
    timeoutMs: 220
  });

  function appendEvent(text) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    eventTimeline.value = [{ time, text }, ...eventTimeline.value].slice(0, 10);
  }

  function pushAlert({ tone = 'danger', title, message, ttl = 4200, actionLabel = '', action = null }) {
    const id = `${tone}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
    transientAlerts.value = [...transientAlerts.value, { id, tone, title, message, actionLabel, action }];

    if (ttl > 0) {
      window.setTimeout(() => dismissAlert(id), ttl);
    }
  }

  function dismissAlert(id) {
    transientAlerts.value = transientAlerts.value.filter((item) => item.id !== id);

    if (!dismissedWarningIds.value.includes(id)) {
      dismissedWarningIds.value = [...dismissedWarningIds.value, id];
    }
  }

  const selectedAdapter = computed(() => {
    return networkAdapters.value.find((adapter) => adapter.name === selectedAdapterName.value) || null;
  });

  const hasReachableCandidates = computed(() => {
    return discoveredSerial.value.length > 0 || discoveredEthernet.value.length > 0;
  });

  const primaryChannel = computed(() => {
    if (serialConnected.value && ethernetConnected.value) {
      return primaryPreference.value;
    }

    if (serialConnected.value) {
      return 'serial';
    }

    if (ethernetConnected.value) {
      return 'ethernet';
    }

    return null;
  });

  const warningAlerts = computed(() => {
    const alerts = [];

    if (serialConnected.value && ethernetConnected.value) {
      alerts.push({
        id: 'dual-channel-warning',
        tone: 'warning',
        title: '双通道同时在线',
        message: `串口与网口已同时连接，实时曲线和 PID 参数下发当前以${primaryChannel.value === 'ethernet' ? '网口' : '串口'}主通道为准。`
      });
    }

    if (!serialConnected.value && !ethernetConnected.value) {
      alerts.push({
        id: hasReachableCandidates.value ? 'no-channel-warning' : 'no-device-warning',
        tone: 'warning',
        title: hasReachableCandidates.value ? '尚未建立连接' : '未发现设备接入',
        message: hasReachableCandidates.value
          ? '当前没有已连接通道，请从现有可到达设备中选择一个通道接入。'
          : '串口和网口都未连接，且当前没有检测到可用设备接入。'
      });
    }

    return alerts.filter((alert) => !dismissedWarningIds.value.includes(alert.id));
  });

  watch(
    () => [serialConnected.value, ethernetConnected.value, hasReachableCandidates.value],
    () => {
      dismissedWarningIds.value = [];
    }
  );

  function applyAdapter(adapterName) {
    selectedAdapterName.value = adapterName;
    const adapter = networkAdapters.value.find((item) => item.name === adapterName);
    if (adapter) {
      ethernetConfig.subnetPrefix = toSubnetPrefix(adapter.address);
    }
  }

  function setPrimaryChannel(channel) {
    if (channel === 'serial' || channel === 'ethernet') {
      primaryPreference.value = channel;
      appendEvent(`主通道已切换为${channel === 'serial' ? '串口' : '网口'}`);
    }
  }

  async function loadNetworkAdapters() {
    if (!deviceApi) {
      appendEvent('未检测到 Electron 设备 API，无法读取网卡信息');
      return;
    }

    try {
      networkAdapters.value = await deviceApi.getNetworkInterfaces();
      if (networkAdapters.value.length && !selectedAdapterName.value) {
        applyAdapter(networkAdapters.value[0].name);
      }
    } catch (error) {
      appendEvent(`网卡读取失败：${error.message}`);
      pushAlert({ tone: 'danger', title: '网卡读取失败', message: error.message });
    }
  }

  async function searchSerialPorts() {
    if (!deviceApi) {
      appendEvent('未检测到 Electron 设备 API，无法扫描串口');
      return;
    }

    serialLoading.value = true;
    try {
      discoveredSerial.value = await deviceApi.listSerialPorts();
      selectedSerialPath.value = discoveredSerial.value[0]?.path || '';
      appendEvent(`串口扫描完成，共发现 ${discoveredSerial.value.length} 个端口`);
    } catch (error) {
      appendEvent(`串口扫描失败：${error.message}`);
      pushAlert({ tone: 'danger', title: '串口扫描失败', message: error.message });
    } finally {
      serialLoading.value = false;
    }
  }

  async function connectSerialPort() {
    if (!deviceApi) {
      const message = '未检测到 Electron 设备 API';
      appendEvent(`串口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '串口连接失败', message });
      return;
    }

    if (!selectedSerialPath.value) {
      const message = '请先选择有效串口';
      appendEvent(`串口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '串口连接失败', message });
      return;
    }

    try {
      const result = await deviceApi.openSerialPort({
        path: selectedSerialPath.value,
        ...serialConfig
      });

      serialConnected.value = Boolean(result.connected);
      if (!serialConnected.value) {
        throw new Error('设备未返回已连接状态');
      }

      activeSerialLabel.value = `${result.path} @ ${result.baudRate}`;
      primaryPreference.value = 'serial';
      appendEvent(`串口已连接：${activeSerialLabel.value}`);
    } catch (error) {
      serialConnected.value = false;
      activeSerialLabel.value = '未连接';
      const message = error.message || '未知错误';
      appendEvent(`串口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '串口连接失败', message });
    }
  }

  async function disconnectSerialPort() {
    if (!deviceApi) {
      return;
    }

    await deviceApi.closeSerialPort();
    serialConnected.value = false;
    activeSerialLabel.value = '未连接';
    appendEvent('串口连接已断开');
  }

  async function searchEthernetDevices() {
    if (!deviceApi) {
      appendEvent('未检测到 Electron 设备 API，无法扫描网口');
      return;
    }

    if (!ethernetConfig.subnetPrefix) {
      appendEvent('当前缺少可扫描的子网前缀');
      return;
    }

    ethernetLoading.value = true;
    try {
      const result = await deviceApi.scanNetworkDevices({
        subnetPrefix: ethernetConfig.subnetPrefix,
        port: ethernetConfig.scanPort,
        timeoutMs: ethernetConfig.timeoutMs,
        start: 1,
        end: 254
      });
      discoveredEthernet.value = result;

      if (result.length) {
        selectedEthernetHost.value = result[0].address;
        ethernetConfig.host = result[0].address;
      }

      appendEvent(`网段 ${ethernetConfig.subnetPrefix}* 扫描完成，发现 ${result.length} 台可达设备`);
    } catch (error) {
      appendEvent(`网段扫描失败：${error.message}`);
      pushAlert({ tone: 'danger', title: '网口扫描失败', message: error.message });
    } finally {
      ethernetLoading.value = false;
    }
  }

  async function connectEthernetDevice() {
    if (!deviceApi) {
      const message = '未检测到 Electron 设备 API';
      appendEvent(`网口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '网口连接失败', message });
      return;
    }

    if (!ethernetConfig.host) {
      const message = '请先填写目标 IP 地址';
      appendEvent(`网口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '网口连接失败', message });
      return;
    }

    try {
      const result = await deviceApi.connectNetworkDevice({
        host: ethernetConfig.host,
        port: ethernetConfig.port,
        timeoutMs: 800
      });

      ethernetConnected.value = Boolean(result.connected);
      if (!ethernetConnected.value) {
        throw new Error('设备未返回已连接状态');
      }

      activeEthernetLabel.value = `${result.host}:${result.port}`;
      primaryPreference.value = 'ethernet';
      appendEvent(`网口已连接：${activeEthernetLabel.value}，延迟 ${result.latencyMs} ms`);
    } catch (error) {
      ethernetConnected.value = false;
      activeEthernetLabel.value = '未连接';
      const message = error.message || '未知错误';
      appendEvent(`网口连接失败：${message}`);
      pushAlert({ tone: 'danger', title: '网口连接失败', message });
    }
  }

  async function disconnectEthernetDevice() {
    if (!deviceApi) {
      return;
    }

    await deviceApi.disconnectNetworkDevice();
    ethernetConnected.value = false;
    activeEthernetLabel.value = '未连接';
    appendEvent('网口连接已断开');
  }

  function getConnectionControlSnapshot() {
    return JSON.parse(JSON.stringify({
      primaryChannel: primaryChannel.value,
      serial: {
        connected: serialConnected.value,
        label: activeSerialLabel.value,
        selectedPath: selectedSerialPath.value,
        config: { ...serialConfig },
        discovered: discoveredSerial.value
      },
      ethernet: {
        connected: ethernetConnected.value,
        label: activeEthernetLabel.value,
        host: ethernetConfig.host,
        port: ethernetConfig.port,
        discovered: discoveredEthernet.value
      }
    }));
  }

  async function externalConnectSerial(options = {}) {
    if (options.path) selectedSerialPath.value = options.path;
    if (options.baudRate !== undefined) serialConfig.baudRate = Number(options.baudRate);
    if (options.dataBits !== undefined) serialConfig.dataBits = Number(options.dataBits);
    if (options.stopBits !== undefined) serialConfig.stopBits = Number(options.stopBits);
    if (options.parity) serialConfig.parity = options.parity;
    if (!selectedSerialPath.value) await searchSerialPorts();

    await connectSerialPort();
    if (!serialConnected.value) throw new Error('Serial connection failed');
    return getConnectionControlSnapshot();
  }

  async function externalDisconnectSerial() {
    await disconnectSerialPort();
    return getConnectionControlSnapshot();
  }

  async function externalConnectEthernet(options = {}) {
    if (options.host) {
      ethernetConfig.host = options.host;
      selectedEthernetHost.value = options.host;
    }
    if (options.port !== undefined) ethernetConfig.port = Number(options.port);
    if (options.timeoutMs !== undefined) ethernetConfig.timeoutMs = Number(options.timeoutMs);

    await connectEthernetDevice();
    if (!ethernetConnected.value) throw new Error('Ethernet connection failed');
    return getConnectionControlSnapshot();
  }

  async function externalDisconnectEthernet() {
    await disconnectEthernetDevice();
    return getConnectionControlSnapshot();
  }

  function externalSetPrimaryChannel(channel) {
    if (channel !== 'serial' && channel !== 'ethernet') {
      throw new Error('Primary channel must be serial or ethernet');
    }
    if (channel === 'serial' && !serialConnected.value) {
      throw new Error('Cannot set primary channel to serial because serial is not connected');
    }
    if (channel === 'ethernet' && !ethernetConnected.value) {
      throw new Error('Cannot set primary channel to ethernet because ethernet is not connected');
    }

    setPrimaryChannel(channel);
    return getConnectionControlSnapshot();
  }

  const tcpProtocolEnabled = ref(false);

  function enableTcpProtocolListener() {
    if (!deviceApi?.onTcpProtocol || tcpProtocolEnabled.value) {
      return;
    }

    tcpProtocolEnabled.value = true;

    deviceApi.onTcpProtocol((payload) => {
      console.log('[tcp-protocol]', payload);
    });

    if (deviceApi?.onTcpDebug) {
      deviceApi.onTcpDebug((payload) => {
        console.log('[tcp-debug]', payload);
      });
    }
  }

  async function initializeCommunication() {
    if (initialized.value) {
      return;
    }

    initialized.value = true;

    if (deviceApi?.onSerialDebug) {
      deviceApi.onSerialDebug((payload) => {
        console.log('[serial-debug]', payload);
      });
    }

    enableTcpProtocolListener();
    await loadNetworkAdapters();
    await Promise.all([searchSerialPorts(), searchEthernetDevices()]);
  }

  return {
    protocol,
    serialLoading,
    ethernetLoading,
    serialConnected,
    ethernetConnected,
    discoveredSerial,
    discoveredEthernet,
    networkAdapters,
    selectedSerialPath,
    selectedEthernetHost,
    selectedAdapterName,
    activeSerialLabel,
    activeEthernetLabel,
    primaryPreference,
    serialConfig,
    ethernetConfig,
    eventTimeline,
    transientAlerts,
    selectedAdapter,
    hasReachableCandidates,
    primaryChannel,
    warningAlerts,
    appendEvent,
    dismissAlert,
    pushAlert,
    applyAdapter,
    setPrimaryChannel,
    loadNetworkAdapters,
    searchSerialPorts,
    connectSerialPort,
    disconnectSerialPort,
    searchEthernetDevices,
    connectEthernetDevice,
    disconnectEthernetDevice,
    getConnectionControlSnapshot,
    externalConnectSerial,
    externalDisconnectSerial,
    externalConnectEthernet,
    externalDisconnectEthernet,
    externalSetPrimaryChannel,
    initializeCommunication
  };
});
