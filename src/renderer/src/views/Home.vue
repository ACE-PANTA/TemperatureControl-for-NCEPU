<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import PrimaryChannelPanel from '../components/PrimaryChannelPanel.vue';
import { useDeviceRuntimeStore } from '../store/deviceRuntime.js';
import { useSimulationRuntimeStore } from '../store/simulationRuntime.js';
import { useSystemConfigStore } from '../store/systemConfig.js';

const deviceStore = useDeviceRuntimeStore();
const simulationStore = useSimulationRuntimeStore();
const configStore = useSystemConfigStore();

const {
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
  serialConfig,
  ethernetConfig,
  eventTimeline,
  selectedAdapter,
  primaryChannel
} = storeToRefs(deviceStore);

const {
  chartPanOffset,
  curvePoints,
  visibleCurveSamples,
  currentTemp,
  targetTemp,
  furnaceState,
  primarySample,
  controllerState,
  logDirectory,
  visiblePointCount,
  xAxisLabels,
  xAxisStepLabel,
  recordingStatusText,
  recordingState,
  canPauseRecording,
  canStopRecording
} = storeToRefs(simulationStore);

const { settings } = storeToRefs(configStore);

const CHART_WIDTH = 880;
const CHART_HEIGHT = 320;
const CHART_PADDING = 22;
const Y_AXIS_DIVISION_COUNT = 6;
const DEFAULT_TARGET_TEMPERATURE = 40;
const SERIES_ORDER = {
  furnaceTemp: 0,
  boardTemp: 1,
  pwm: 2
};
const DEFAULT_Y_AXIS_PROFILES = {
  furnaceTemp: {
    label: '炉膛温度',
    unit: '°C',
    unitsPerDivision: 50,
    offset: 0,
    defaultCenter: 150
  },
  boardTemp: {
    label: '板载温度',
    unit: '°C',
    unitsPerDivision: 20,
    offset: 0,
    defaultCenter: 50
  },
  pwm: {
    label: 'PWM',
    unit: '%',
    unitsPerDivision: 20,
    offset: 0,
    defaultCenter: 0
  }
};

const serialDetailsOpen = ref(false);
const ethernetDetailsOpen = ref(false);
const targetTempDraft = ref(String(DEFAULT_TARGET_TEMPERATURE));
const targetInputFocused = ref(false);
const chartDragActive = ref(false);
const chartDragMode = ref('pan');
const chartDragStartX = ref(0);
const chartDragStartY = ref(0);
const chartDragStartOffset = ref(0);
const chartSurfaceRef = ref(null);
const chartSvgRef = ref(null);
const hoveredPointIndex = ref(-1);
const draggedSeriesKey = ref('');
const manualPwmDraft = ref('');

const canResumeRecording = computed(() => recordingState.value.active && recordingState.value.paused);
const canStartRecording = computed(() => !recordingState.value.active);
const hasCurrentTemp = computed(() => Number.isFinite(currentTemp.value));
const hasTargetTemp = computed(() => Number.isFinite(targetTemp.value));
const hasChartData = computed(() => chartSeriesData.value.length > 0);
const currentTempText = computed(() => (hasCurrentTemp.value ? `${currentTemp.value.toFixed(1)} °C` : '--'));
const targetTempText = computed(() => (hasTargetTemp.value ? `${targetTemp.value.toFixed(1)} °C` : '--'));
const controllerModeLabel = computed(() => {
  if (controllerState.value.mode === 'AUTO') {
    return '自动模式';
  }

  if (controllerState.value.mode === 'MAN') {
    return '手动模式';
  }

  return '模式未同步';
});
const isAutoMode = computed(() => controllerState.value.mode === 'AUTO');
const isManualMode = computed(() => controllerState.value.mode === 'MAN');
const currentPwmText = computed(() => Number.isFinite(controllerState.value.pwm) ? `${controllerState.value.pwm.toFixed(0)} %` : '--');
const controlModeToggleLabel = computed(() => {
  if (isAutoMode.value) {
    return '当前自动，点击切到手动';
  }

  if (isManualMode.value) {
    return '当前手动，点击切到自动';
  }

  return '模式未同步，点击切到自动';
});
const controlCommitLabel = computed(() => (isAutoMode.value ? '设定目标温度' : '设定 PWM'));
const controlModeButtonClass = computed(() => {
  if (isAutoMode.value) {
    return 'mode-button-auto';
  }

  if (isManualMode.value) {
    return 'mode-button-manual';
  }

  return 'mode-button-unsynced';
});
const controlCommitButtonClass = computed(() => (isAutoMode.value ? 'mode-button-auto' : 'mode-button-manual'));

function createDefaultAxisProfile(key) {
  const base = DEFAULT_Y_AXIS_PROFILES[key] || {
    label: key,
    unit: '',
    unitsPerDivision: 20,
    offset: 0,
    defaultCenter: 0
  };

  return {
    unitsPerDivision: base.unitsPerDivision,
    offset: base.offset
  };
}

function ensureYAxisSettings(seriesList = []) {
  if (!settings.value.yAxisProfiles || typeof settings.value.yAxisProfiles !== 'object') {
    settings.value.yAxisProfiles = {};
  }

  for (const key of Object.keys(DEFAULT_Y_AXIS_PROFILES)) {
    if (!settings.value.yAxisProfiles[key]) {
      settings.value.yAxisProfiles[key] = createDefaultAxisProfile(key);
    }
  }

  for (const series of seriesList) {
    if (!settings.value.yAxisProfiles[series.key]) {
      settings.value.yAxisProfiles[series.key] = createDefaultAxisProfile(series.key);
    }
  }

  if (!settings.value.yAxisDisplaySeriesKey || !settings.value.yAxisProfiles[settings.value.yAxisDisplaySeriesKey]) {
    settings.value.yAxisDisplaySeriesKey = seriesList[0]?.key || 'furnaceTemp';
  }
}

function getAxisProfile(key) {
  ensureYAxisSettings();
  return settings.value.yAxisProfiles[key] || createDefaultAxisProfile(key);
}

function getAxisDefaultCenter(key) {
  return DEFAULT_Y_AXIS_PROFILES[key]?.defaultCenter ?? 0;
}

function getAxisDefaultUnit(key) {
  return DEFAULT_Y_AXIS_PROFILES[key]?.unit ?? '';
}

const chartSeriesData = computed(() => {
  const registry = new Map();

  visibleCurveSamples.value.forEach((sample, index) => {
    (sample.series || []).forEach((seriesEntry, seriesIndex) => {
      if (!registry.has(seriesEntry.key)) {
        registry.set(seriesEntry.key, {
          key: seriesEntry.key,
          label: seriesEntry.label,
          shortLabel: seriesEntry.shortLabel,
          unit: seriesEntry.unit,
          color: seriesEntry.color,
          points: []
        });
      }

      registry.get(seriesEntry.key).points.push({
        index,
        value: Number(seriesEntry.value),
        color: seriesEntry.color,
        label: seriesEntry.label,
        unit: seriesEntry.unit,
        order: seriesIndex
      });
    });
  });

  return Array.from(registry.values())
    .sort((left, right) => {
      const leftOrder = SERIES_ORDER[left.key] ?? left.points[0]?.order ?? 99;
      const rightOrder = SERIES_ORDER[right.key] ?? right.points[0]?.order ?? 99;
      return leftOrder - rightOrder;
    });
});

watch(
  chartSeriesData,
  (seriesList) => {
    ensureYAxisSettings(seriesList);
  },
  { immediate: true }
);

const axisSeriesOptions = computed(() => {
  const options = new Map();

  chartSeriesData.value.forEach((series) => {
    options.set(series.key, {
      key: series.key,
      label: series.label,
      unit: series.unit || getAxisDefaultUnit(series.key)
    });
  });

  Object.entries(DEFAULT_Y_AXIS_PROFILES).forEach(([key, config]) => {
    if (!options.has(key)) {
      options.set(key, {
        key,
        label: config.label,
        unit: config.unit
      });
    }
  });

  return Array.from(options.values()).sort((left, right) => {
    return (SERIES_ORDER[left.key] ?? 99) - (SERIES_ORDER[right.key] ?? 99);
  });
});

const selectedAxisKey = computed({
  get: () => settings.value.yAxisDisplaySeriesKey || 'furnaceTemp',
  set: (value) => {
    settings.value.yAxisDisplaySeriesKey = value;
  }
});

const selectedAxisSeries = computed(() => {
  return axisSeriesOptions.value.find((series) => series.key === selectedAxisKey.value) || axisSeriesOptions.value[0] || null;
});

function getSeriesValues(seriesKey) {
  const series = chartSeriesData.value.find((entry) => entry.key === seriesKey);
  const values = series ? series.points.map((point) => point.value).filter((value) => Number.isFinite(value)) : [];

  if (seriesKey === 'furnaceTemp' && hasTargetTemp.value) {
    values.push(Number(targetTemp.value));
  }

  return values;
}

function getAxisBounds(seriesKey) {
  const profile = getAxisProfile(seriesKey);
  const values = getSeriesValues(seriesKey);
  const unitsPerDivision = Math.max(0.1, Number(profile.unitsPerDivision) || createDefaultAxisProfile(seriesKey).unitsPerDivision);
  const span = unitsPerDivision * Y_AXIS_DIVISION_COUNT;
  const baseCenter = values.length
    ? (Math.min(...values) + Math.max(...values)) / 2
    : getAxisDefaultCenter(seriesKey);
  const center = baseCenter + (Number(profile.offset) || 0);

  return {
    min: center - span / 2,
    max: center + span / 2,
    span,
    unitsPerDivision
  };
}

const chartSeries = computed(() => {
  return chartSeriesData.value.map((series) => ({
    ...series,
    path: buildSeriesPath(series.key, series.points)
  }));
});

const temperatureSeries = computed(() => chartSeries.value.find((series) => series.key === 'furnaceTemp') || null);

function mapValueToY(value, axisKey = selectedAxisKey.value) {
  const bounds = getAxisBounds(axisKey);
  const width = bounds.max - bounds.min || 1;
  const ratio = (Number(value) - bounds.min) / width;
  return CHART_HEIGHT - CHART_PADDING - ratio * (CHART_HEIGHT - CHART_PADDING * 2);
}

function mapIndexToX(index, pointCount) {
  if (pointCount <= 1) {
    return CHART_PADDING;
  }

  return CHART_PADDING + (index * (CHART_WIDTH - CHART_PADDING * 2)) / (pointCount - 1);
}

function buildSeriesPath(seriesKey, points) {
  if (!points.length) {
    return '';
  }

  return points
    .map((point, index) => {
      const x = mapIndexToX(point.index, visiblePointCount.value);
      const y = mapValueToY(point.value, seriesKey);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function formatSeriesValue(entry) {
  const suffix = entry.unit ? ` ${entry.unit}` : '';
  return `${Number(entry.value).toFixed(1)}${suffix}`;
}

function formatAxisLabel(value, unitsPerDivision) {
  if (unitsPerDivision >= 10) {
    return Number(value).toFixed(0);
  }

  if (unitsPerDivision >= 1) {
    return Number(value).toFixed(1);
  }

  return Number(value).toFixed(2);
}

const selectedAxisBounds = computed(() => getAxisBounds(selectedAxisKey.value));
const selectedAxisUnit = computed(() => selectedAxisSeries.value?.unit || getAxisDefaultUnit(selectedAxisKey.value));
const chartGridLines = computed(() => {
  return Array.from({ length: Y_AXIS_DIVISION_COUNT + 1 }, (_, index) => {
    const value = selectedAxisBounds.value.max - selectedAxisBounds.value.unitsPerDivision * index;
    const y = mapValueToY(value, selectedAxisKey.value);

    return {
      key: `${selectedAxisKey.value}-${index}`,
      label: formatAxisLabel(value, selectedAxisBounds.value.unitsPerDivision),
      y,
      topPercent: (y / CHART_HEIGHT) * 100
    };
  });
});

const chartPath = computed(() => temperatureSeries.value?.path || '');

const areaPath = computed(() => {
  const series = temperatureSeries.value;
  if (!series?.points.length) {
    return '';
  }

  const firstX = mapIndexToX(series.points[0].index, visiblePointCount.value);
  const lastX = mapIndexToX(series.points.at(-1).index, visiblePointCount.value);
  const baseline = CHART_HEIGHT - CHART_PADDING;
  return `${series.path} L ${lastX.toFixed(2)} ${baseline.toFixed(2)} L ${firstX.toFixed(2)} ${baseline.toFixed(2)} Z`;
});

const hoveredSample = computed(() => visibleCurveSamples.value[hoveredPointIndex.value] || null);

const hoveredSeriesEntries = computed(() => {
  if (!hoveredSample.value?.series?.length) {
    return [];
  }

  return [...hoveredSample.value.series].sort((left, right) => {
    return (SERIES_ORDER[left.key] ?? 99) - (SERIES_ORDER[right.key] ?? 99);
  });
});

const hoveredX = computed(() => {
  if (hoveredPointIndex.value < 0 || !visibleCurveSamples.value.length) {
    return null;
  }

  return mapIndexToX(hoveredPointIndex.value, visiblePointCount.value);
});

const hoveredMarkers = computed(() => {
  if (hoveredX.value === null) {
    return [];
  }

  return hoveredSeriesEntries.value.map((entry) => ({
    key: entry.key,
    x: hoveredX.value,
    y: mapValueToY(entry.value, entry.key),
    color: entry.color,
    label: entry.label,
    value: entry.value,
    unit: entry.unit
  }));
});

const hoverTooltip = computed(() => {
  if (!hoveredSample.value || hoveredX.value === null) {
    return null;
  }

  const topPx = hoveredMarkers.value.length
    ? Math.max(18, Math.min(...hoveredMarkers.value.map((marker) => marker.y)) - 18)
    : 32;

  return {
    leftPercent: Math.max(10, Math.min(90, (hoveredX.value / CHART_WIDTH) * 100)),
    topPx,
    elapsedSeconds: hoveredSample.value.elapsedSeconds,
    timestamp: new Date(hoveredSample.value.timestamp).toLocaleTimeString('zh-CN', { hour12: false }),
    requestedSetpoint: Number(hoveredSample.value.requestedSetpoint || 0),
    entries: hoveredSeriesEntries.value
  };
});

watch(
  () => controllerState.value.pwm,
  (value) => {
    manualPwmDraft.value = Number.isFinite(value) ? String(Math.round(value)) : '';
  },
  { immediate: true }
);

function handleTargetInput(event) {
  targetTempDraft.value = event.target.value;
}

async function handleTargetCommit() {
  const committed = await simulationStore.commitTargetTemperature(targetTempDraft.value);
  if (committed) {
    targetTempDraft.value = Number(targetTempDraft.value).toFixed(1);
  }
}

async function handleTargetKeydown(event) {
  if (event.key === 'Enter') {
    await handleTargetCommit();
  }
}

function handleTargetFocus() {
  targetInputFocused.value = true;
}

function handleTargetBlur() {
  targetInputFocused.value = false;
}

async function handleManualPwmCommit() {
  await simulationStore.applyManualPwm(manualPwmDraft.value);
}

async function handleManualPwmKeydown(event) {
  if (event.key === 'Enter') {
    await handleManualPwmCommit();
  }
}

async function switchToAutoMode() {
  await simulationStore.setControllerMode('AUTO');
}

async function switchToManualMode() {
  await simulationStore.setControllerMode('MAN');
}

async function toggleControllerMode() {
  if (isAutoMode.value) {
    await switchToManualMode();
    return;
  }

  await switchToAutoMode();
}

function getChartBounds() {
  return chartSvgRef.value?.getBoundingClientRect() || chartSurfaceRef.value?.getBoundingClientRect() || null;
}

function pickDraggedSeries(clientY) {
  const bounds = getChartBounds();
  if (!bounds || hoveredPointIndex.value < 0) {
    return null;
  }

  const normalizedY = ((clientY - bounds.top) / Math.max(bounds.height, 1)) * CHART_HEIGHT;
  const nearestMarker = hoveredSeriesEntries.value
    .map((entry) => ({
      key: entry.key,
      distance: Math.abs(mapValueToY(entry.value, entry.key) - normalizedY)
    }))
    .sort((left, right) => left.distance - right.distance)[0];

  return nearestMarker && nearestMarker.distance <= 16 ? nearestMarker.key : null;
}

function handleAxisUnitsInput(seriesKey, event) {
  const nextValue = Number(event.target.value);
  const profile = getAxisProfile(seriesKey);
  profile.unitsPerDivision = Number.isFinite(nextValue) && nextValue > 0
    ? nextValue
    : createDefaultAxisProfile(seriesKey).unitsPerDivision;
}

function resetSeriesAxisOffset(seriesKey) {
  getAxisProfile(seriesKey).offset = 0;
}

function handleChartPointerDown(event) {
  chartDragActive.value = true;
  chartDragMode.value = 'pan';
  draggedSeriesKey.value = '';
  chartDragStartX.value = event.clientX;
  chartDragStartY.value = event.clientY;
  updateHoveredPoint(event.clientX);

  const pickedSeriesKey = pickDraggedSeries(event.clientY);
  if (pickedSeriesKey) {
    chartDragMode.value = 'shift-series';
    draggedSeriesKey.value = pickedSeriesKey;
    chartDragStartOffset.value = Number(getAxisProfile(pickedSeriesKey).offset) || 0;
  } else {
    chartDragStartOffset.value = chartPanOffset.value;
  }

  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function handleChartPointerMove(event) {
  updateHoveredPoint(event.clientX);

  if (!chartDragActive.value) {
    return;
  }

  if (chartDragMode.value === 'shift-series' && draggedSeriesKey.value) {
    const bounds = getChartBounds();
    const chartHeight = bounds?.height || event.currentTarget.clientHeight || 1;
    const deltaY = event.clientY - chartDragStartY.value;
    const axisBounds = getAxisBounds(draggedSeriesKey.value);
    getAxisProfile(draggedSeriesKey.value).offset = chartDragStartOffset.value + (deltaY / chartHeight) * axisBounds.span;
    return;
  }

  const width = event.currentTarget.clientWidth || 1;
  const deltaX = event.clientX - chartDragStartX.value;
  const desiredOffset = Math.max(0, Math.round(chartDragStartOffset.value + (deltaX / width) * visiblePointCount.value));
  simulationStore.panChartWindow(desiredOffset - chartPanOffset.value);
}

function stopChartDrag(event) {
  if (!chartDragActive.value) {
    return;
  }

  chartDragActive.value = false;
  chartDragMode.value = 'pan';
  draggedSeriesKey.value = '';
  event?.currentTarget?.releasePointerCapture?.(event.pointerId);
}

function handleChartPointerLeave(event) {
  stopChartDrag(event);
  hoveredPointIndex.value = -1;
}

function updateHoveredPoint(clientX) {
  const bounds = getChartBounds();
  if (!bounds || !visibleCurveSamples.value.length) {
    hoveredPointIndex.value = -1;
    return;
  }

  const normalizedX = ((clientX - bounds.left) / Math.max(bounds.width, 1)) * CHART_WIDTH;
  const plotStartX = CHART_PADDING;
  const plotEndX = CHART_WIDTH - CHART_PADDING;

  if (normalizedX < plotStartX || normalizedX > plotEndX) {
    hoveredPointIndex.value = -1;
    return;
  }

  const slotCount = Math.max(visiblePointCount.value - 1, 1);
  const slotWidth = (plotEndX - plotStartX) / slotCount;
  const nearestIndex = Math.round((normalizedX - plotStartX) / slotWidth);

  if (nearestIndex < 0 || nearestIndex >= visibleCurveSamples.value.length) {
    hoveredPointIndex.value = -1;
    return;
  }

  const nearestX = mapIndexToX(nearestIndex, visiblePointCount.value);
  hoveredPointIndex.value = Math.abs(normalizedX - nearestX) <= slotWidth / 2
    ? nearestIndex
    : -1;
}

onMounted(async () => {
  await deviceStore.initializeCommunication();
  await simulationStore.ensureRunning();
  simulationStore.syncDraftToChannels();
});
</script>

<template>
  <section class="dashboard-grid">
    <div class="main-column">
      <div class="panel hero-panel">
        <div class="panel-heading hero-heading">
          <div>
            <h2>实时测温曲线</h2>
            <p class="panel-intro">曲线区域保持最高优先级，目标温度可在下方直接修改，参考数据改为更紧凑的辅助信息。</p>
          </div>
          <div class="status-cluster">
            <span class="status-pill status-pill-live">实时采集中</span>
            <span class="status-pill">主通道 {{ primaryChannel ? (primaryChannel === 'serial' ? '串口' : '网口') : '未选择' }}</span>
            <span class="status-pill">控制模式 {{ controllerModeLabel }}</span>
            <span class="status-pill">记录状态 {{ recordingStatusText }}</span>
          </div>
        </div>

        <PrimaryChannelPanel />

        <div class="chart-card chart-priority-card">
          <div class="chart-header">
            <div>
              <h3>炉膛温度轨迹</h3>
              <p>当前温度 {{ currentTempText }}，目标温度 {{ targetTempText }}，当前状态 {{ furnaceState }}</p>
            </div>
            <div class="chart-legend compact-legend">
              <span v-for="series in chartSeries" :key="series.key" class="chart-series-item">
                <i class="legend-dot" :style="{ background: series.color }"></i>
                {{ series.label }}
              </span>
              <button v-if="chartPanOffset > 0" type="button" class="latest-button" @click="simulationStore.jumpChartToLatest()">回到最新</button>
            </div>
          </div>

          <div class="y-axis-toolbar">
            <label class="axis-source-control">
              <span>左侧 Y 轴显示</span>
              <select v-model="selectedAxisKey">
                <option v-for="series in axisSeriesOptions" :key="series.key" :value="series.key">
                  {{ series.label }}
                </option>
              </select>
            </label>
            <div class="axis-series-controls">
              <div v-for="series in axisSeriesOptions" :key="series.key" class="axis-series-card">
                <div class="axis-series-card-head">
                  <span class="axis-series-name">
                    <i class="legend-dot" :style="{ background: chartSeries.find((item) => item.key === series.key)?.color || '#7f96ae' }"></i>
                    {{ series.label }}
                  </span>
                  <button type="button" class="axis-reset-button" @click="resetSeriesAxisOffset(series.key)">归位</button>
                </div>
                <label>
                  <span>每格</span>
                  <input
                    :value="settings.yAxisProfiles?.[series.key]?.unitsPerDivision"
                    type="number"
                    min="0.1"
                    step="0.1"
                    @input="handleAxisUnitsInput(series.key, $event)"
                  />
                </label>
              </div>
            </div>
          </div>

          <div class="chart-wrapper">
            <div class="chart-axis-labels">
              <span class="axis-caption">{{ selectedAxisSeries?.label || 'Y 轴' }}</span>
              <div class="chart-axis-scale">
                <span
                  v-for="line in chartGridLines"
                  :key="line.key"
                  class="chart-axis-tick"
                  :style="{ top: `${line.topPercent}%` }"
                >
                  {{ line.label }}{{ selectedAxisUnit }}
                </span>
              </div>
            </div>
            <div
              ref="chartSurfaceRef"
              class="chart-surface"
              @pointerdown="handleChartPointerDown"
              @pointermove="handleChartPointerMove"
              @pointerup="stopChartDrag"
              @pointercancel="stopChartDrag"
              @pointerleave="handleChartPointerLeave"
            >
              <svg ref="chartSvgRef" viewBox="0 0 880 320" class="chart-svg" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="curveFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="rgba(48, 221, 255, 0.38)" />
                    <stop offset="100%" stop-color="rgba(48, 221, 255, 0.02)" />
                  </linearGradient>
                </defs>
                <g>
                  <line
                    v-for="line in chartGridLines"
                    :key="line.label"
                    x1="22"
                    x2="858"
                    :y1="line.y"
                    :y2="line.y"
                    class="chart-grid"
                  />
                  <path v-if="areaPath" :d="areaPath" fill="url(#curveFill)" />
                  <path
                    v-for="series in chartSeries"
                    :key="series.key"
                    :d="series.path"
                    :class="['curve-line', { 'curve-line-secondary': series.key !== 'furnaceTemp' }]"
                    :style="{ stroke: series.color }"
                  />
                  <line
                    v-if="hoveredX !== null"
                    :x1="hoveredX"
                    :x2="hoveredX"
                    y1="22"
                    y2="298"
                    class="chart-hover-line"
                  />
                  <circle
                    v-for="marker in hoveredMarkers"
                    :key="marker.key"
                    :cx="marker.x"
                    :cy="marker.y"
                    r="5.2"
                    class="chart-hover-point"
                    :style="{ fill: marker.color }"
                  />
                </g>
              </svg>

              <div v-if="!hasChartData" class="chart-empty-state">
                <strong>暂无实时数据</strong>
                <span>设备未上报测温数据时，曲线区域保持空白，不再显示任何预设样本。</span>
              </div>

              <div v-if="hoverTooltip" class="chart-tooltip" :style="{ left: `${hoverTooltip.leftPercent}%`, top: `${hoverTooltip.topPx}px` }">
                <strong>{{ hoverTooltip.elapsedSeconds }} s</strong>
                <span class="chart-tooltip-meta">采集时间 {{ hoverTooltip.timestamp }}</span>
                <span class="chart-tooltip-meta">设定值 {{ hoverTooltip.requestedSetpoint.toFixed(1) }} °C</span>
                <span v-for="entry in hoverTooltip.entries" :key="entry.key" class="chart-tooltip-row">
                  <i class="legend-dot" :style="{ background: entry.color }"></i>
                  {{ entry.label }} {{ formatSeriesValue(entry) }}
                </span>
              </div>

              <div class="timeline-labels">
                <span v-for="label in xAxisLabels" :key="label">{{ label }}</span>
              </div>
            </div>
          </div>

          <div class="axis-note">{{ xAxisStepLabel }} · 左轴刻度跟随 {{ selectedAxisSeries?.label || '当前曲线' }} · 按住某条曲线上下拖动可单独平移</div>
        </div>

        <div class="panel temperature-panel">
          <div class="temperature-layout">
            <div class="target-panel">
              <p class="panel-kicker">TARGET CONTROL</p>
              <h3>控制下发</h3>
              <div class="control-mode-row">
                <button type="button" :class="['action-button', 'mode-toggle-button', controlModeButtonClass]" @click="toggleControllerMode">{{ controlModeToggleLabel }}</button>
              </div>

              <div v-if="isAutoMode" class="target-input-row">
                <input
                  :value="targetTempDraft"
                  type="number"
                  min="0"
                  max="1200"
                  step="0.1"
                  @input="handleTargetInput"
                  @focus="handleTargetFocus"
                  @blur="handleTargetBlur"
                  @keydown="handleTargetKeydown"
                  placeholder="输入目标温度"
                />
                <span>°C</span>
                <button type="button" :class="['action-button', controlCommitButtonClass]" @click="handleTargetCommit">{{ controlCommitLabel }}</button>
              </div>

              <div v-else-if="isManualMode" class="target-input-row">
                <input
                  v-model="manualPwmDraft"
                  type="number"
                  min="-100"
                  max="100"
                  step="1"
                  placeholder="输入 PWM"
                  @keydown="handleManualPwmKeydown"
                />
                <span>%</span>
                <button type="button" :class="['action-button', controlCommitButtonClass]" @click="handleManualPwmCommit">{{ controlCommitLabel }}</button>
              </div>

              <div v-else class="target-input-row">
                <input
                  :value="targetTempDraft"
                  type="number"
                  min="0"
                  max="1200"
                  step="0.1"
                  @input="handleTargetInput"
                  @focus="handleTargetFocus"
                  @blur="handleTargetBlur"
                  @keydown="handleTargetKeydown"
                  placeholder="输入目标温度"
                  disabled
                />
                <span>°C</span>
                <button type="button" :class="['action-button', controlCommitButtonClass]" disabled>{{ controlCommitLabel }}</button>
              </div>

              <p class="target-note">
                {{ isAutoMode
                  ? '自动模式下可设置目标温度，默认草稿为 40 °C，修改后需明确点击下发。'
                  : isManualMode
                    ? '手动模式下直接下发 PWM 输出，范围为 -100% 到 100%。'
                    : '当前模式尚未同步，先点击上方按钮切换并等待状态刷新。' }}
              </p>
              <div class="support-note-row control-meta-row">
                <span>当前模式：{{ controllerModeLabel }}</span>
                <span>当前 PWM：{{ currentPwmText }}</span>
                <span>目标温度：{{ targetTempText }}</span>
              </div>
            </div>

            <div class="live-panel simplified-live-panel">
              <article class="primary-metric-card live-hero-card">
                <span>当前温度</span>
                <strong>{{ currentTempText }}</strong>
              </article>
              <article class="primary-metric-card secondary-card live-hero-card">
                <span>当前状态</span>
                <strong>{{ furnaceState }}</strong>
              </article>
            </div>
          </div>

          <div class="support-note-row">
            <span v-if="logDirectory">CSV 目录：{{ logDirectory }}</span>
            <span>横轴每格 {{ settings.xAxisSecondsPerDivision }} s</span>
            <span>会话号：{{ recordingState.sessionId || '暂无' }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="sidebar-stack">
      <div class="panel recording-panel">
        <div class="recording-head">
          <div>
            <p class="panel-kicker">RECORDING CONTROL</p>
            <h2>录制控制</h2>
            <p>录制控制固定放在连接面板上方，便于先操作会话，再处理链路。</p>
          </div>
          <span class="recording-badge">{{ recordingStatusText }}</span>
        </div>

        <div class="recording-meta">
          <span>自动录制：{{ settings.autoRecordingEnabled ? '开启' : '关闭' }}</span>
          <span>断连自动暂停：{{ settings.autoPauseOnDisconnect ? '开启' : '关闭' }}</span>
          <span>当前会话：{{ recordingState.sessionId || '暂无' }}</span>
        </div>

        <div class="recording-actions">
          <button v-if="canStartRecording" class="action-button primary" type="button" @click="simulationStore.startRecordingSession('manual')">开始录制</button>
          <button v-if="canPauseRecording" class="action-button secondary" type="button" @click="simulationStore.pauseRecording('manual')">暂停录制</button>
          <button v-if="canResumeRecording" class="action-button primary" type="button" @click="simulationStore.resumeRecording('manual')">恢复录制</button>
          <button v-if="canStopRecording" class="action-button danger" type="button" @click="simulationStore.stopRecordingSession('manual')">结束录制</button>
        </div>
      </div>

      <div class="panel connect-panel">
        <div class="panel-heading compact">
          <div>
            <p class="panel-kicker">COMMUNICATION BUS</p>
            <h2>设备连接</h2>
          </div>
        </div>

        <div class="protocol-switch">
          <button :class="['protocol-button', { active: protocol === 'serial' }]" @click="protocol = 'serial'">COM串口</button>
          <button :class="['protocol-button', { active: protocol === 'ethernet' }]" @click="protocol = 'ethernet'">网口连接</button>
        </div>

        <div v-if="protocol === 'serial'" class="config-stack">
          <div class="scan-actions single-line">
            <button class="action-button primary" @click="deviceStore.searchSerialPorts" :disabled="serialLoading">
              {{ serialLoading ? '扫描中...' : '扫描串口' }}
            </button>
            <button class="action-button" :class="serialConnected ? 'danger' : 'secondary'" @click="serialConnected ? deviceStore.disconnectSerialPort() : deviceStore.connectSerialPort()">
              {{ serialConnected ? '断开串口' : '连接串口' }}
            </button>
          </div>

          <button type="button" class="detail-toggle" @click="serialDetailsOpen = !serialDetailsOpen">
            <span>串口详情</span>
            <strong>{{ serialDetailsOpen ? '收起' : '展开' }}</strong>
          </button>

          <div v-if="serialDetailsOpen" class="detail-stack">
            <div class="form-grid serial-form">
              <label>
                <span>端口</span>
                <select v-model="selectedSerialPath">
                  <option disabled value="">请选择串口</option>
                  <option v-for="device in discoveredSerial" :key="device.path" :value="device.path">
                    {{ device.path }} · {{ device.friendlyName }}
                  </option>
                </select>
              </label>
              <label>
                <span>波特率</span>
                <input v-model.number="serialConfig.baudRate" type="number" min="1200" step="1200" />
              </label>
              <label>
                <span>数据位</span>
                <select v-model.number="serialConfig.dataBits">
                  <option :value="8">8</option>
                  <option :value="7">7</option>
                </select>
              </label>
              <label>
                <span>停止位</span>
                <select v-model.number="serialConfig.stopBits">
                  <option :value="1">1</option>
                  <option :value="2">2</option>
                </select>
              </label>
              <label>
                <span>校验位</span>
                <select v-model="serialConfig.parity">
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </label>
            </div>

            <div class="device-list compact-list">
              <article v-for="device in discoveredSerial" :key="device.path" class="device-card serial-device-card">
                <div>
                  <strong>{{ device.path }}</strong>
                  <span>{{ device.manufacturer }}</span>
                  <span v-if="device.vendorId || device.productId">VID:{{ device.vendorId || '--' }} / PID:{{ device.productId || '--' }}</span>
                </div>
              </article>
              <div v-if="!discoveredSerial.length" class="empty-state">当前系统未发现可用 COM 设备</div>
            </div>
          </div>
        </div>

        <div v-else class="config-stack">
          <div class="scan-actions single-line">
            <button class="action-button primary" @click="deviceStore.searchEthernetDevices" :disabled="ethernetLoading">
              {{ ethernetLoading ? '扫描中...' : '扫描当前网段' }}
            </button>
            <button class="action-button" :class="ethernetConnected ? 'danger' : 'secondary'" @click="ethernetConnected ? deviceStore.disconnectEthernetDevice() : deviceStore.connectEthernetDevice()">
              {{ ethernetConnected ? '断开网口' : '测试并连接' }}
            </button>
          </div>

          <button type="button" class="detail-toggle" @click="ethernetDetailsOpen = !ethernetDetailsOpen">
            <span>网口详情</span>
            <strong>{{ ethernetDetailsOpen ? '收起' : '展开' }}</strong>
          </button>

          <div v-if="ethernetDetailsOpen" class="detail-stack">
            <div class="form-grid ethernet-form">
              <label>
                <span>本机网卡</span>
                <select :value="selectedAdapterName" @change="deviceStore.applyAdapter($event.target.value)">
                  <option disabled value="">请选择网卡</option>
                  <option v-for="adapter in networkAdapters" :key="adapter.name + adapter.address" :value="adapter.name">
                    {{ adapter.name }} · {{ adapter.address }}
                  </option>
                </select>
              </label>
              <label>
                <span>扫描子网</span>
                <input v-model="ethernetConfig.subnetPrefix" type="text" placeholder="192.168.10." />
              </label>
              <label>
                <span>扫描端口</span>
                <input v-model.number="ethernetConfig.scanPort" type="number" min="1" max="65535" />
              </label>
              <label>
                <span>超时(ms)</span>
                <input v-model.number="ethernetConfig.timeoutMs" type="number" min="50" max="3000" />
              </label>
              <label>
                <span>目标IP</span>
                <input v-model="ethernetConfig.host" type="text" placeholder="192.168.10.42" />
              </label>
              <label>
                <span>目标端口</span>
                <input v-model.number="ethernetConfig.port" type="number" min="1" max="65535" />
              </label>
            </div>

            <div class="adapter-summary" v-if="selectedAdapter">
              <span>当前网卡：{{ selectedAdapter.name }}</span>
              <span>IPv4：{{ selectedAdapter.address }}</span>
              <span>子网掩码：{{ selectedAdapter.netmask }}</span>
            </div>

            <div class="device-list compact-list">
              <label v-for="device in discoveredEthernet" :key="device.id" class="device-card selectable-card">
                <input v-model="selectedEthernetHost" :value="device.address" type="radio" @change="ethernetConfig.host = device.address" />
                <div>
                  <strong>{{ device.address }}:{{ device.port }}</strong>
                  <span>{{ device.status }}</span>
                  <span>延迟 {{ device.latencyMs }} ms</span>
                </div>
              </label>
              <div v-if="!discoveredEthernet.length" class="empty-state">尚未在当前子网发现开放端口设备</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel event-panel">
        <div class="panel-heading compact">
          <div>
            <p class="panel-kicker">SYSTEM EVENTS</p>
            <h2>系统状态</h2>
          </div>
        </div>

        <div class="event-list">
          <article v-for="event in eventTimeline" :key="`${event.time}-${event.text}`" class="event-item">
            <span class="event-time">{{ event.time }}</span>
            <p>{{ event.text }}</p>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(min(28rem, 100%), 0.95fr);
  gap: clamp(0.8rem, 1.5vw, 1.15rem);
  align-items: start;
}

.main-column,
.sidebar-stack {
  display: grid;
  gap: clamp(0.8rem, 1.4vw, 1rem);
}

.panel {
  background: var(--tc-panel-bg);
  border: 1px solid var(--tc-panel-border);
  border-radius: 1.5rem;
  box-shadow: var(--tc-panel-shadow);
  backdrop-filter: blur(1rem);
}

.hero-panel,
.connect-panel,
.event-panel,
.recording-panel,
.temperature-panel {
  padding: clamp(1rem, 1.8vw, 1.35rem);
}

.temperature-panel {
  margin-top: 1rem;
}

.panel-heading,
.hero-heading,
.chart-header,
.recording-head,
.recording-actions,
.recording-meta,
.temperature-layout,
.control-mode-row,
.target-input-row,
.support-note-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.compact {
  margin-bottom: 1rem;
}

.hero-heading {
  margin-bottom: 1rem;
}

.panel-kicker {
  font-size: clamp(0.68rem, 0.84vw, 0.76rem);
  letter-spacing: 0.24em;
  color: var(--tc-text-dim);
  text-transform: uppercase;
  margin-bottom: 0.45rem;
}

.panel-heading h2,
.hero-heading h2,
.recording-head h2,
.chart-header h3,
.target-panel h3,
.primary-metric-card strong,
.device-card strong,
.detail-toggle,
.event-time {
  color: var(--tc-text-primary);
}

.panel-intro,
.chart-header p,
.event-item p,
.device-card span,
.empty-state,
.adapter-summary span,
.form-grid span,
.recording-head p,
.recording-meta span,
.target-note,
.primary-metric-card span,
.support-note-row span {
  color: var(--tc-text-secondary);
}

.hero-heading h2 {
  font-size: clamp(1.3rem, 2vw, 1.7rem);
  font-weight: 650;
}

.status-cluster,
.chart-legend,
.protocol-switch,
.scan-actions,
.form-grid,
.device-list,
.event-list,
.detail-stack,
.live-panel {
  display: grid;
  gap: 0.75rem;
}

.status-cluster {
  display: flex;
}

.status-pill {
  border-radius: 999px;
  padding: 0.55rem 0.8rem;
  font-size: clamp(0.72rem, 0.9vw, 0.8rem);
  color: var(--tc-text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(154, 178, 203, 0.15);
}

.status-pill-live {
  color: #baf9ff;
  border-color: rgba(48, 221, 255, 0.24);
  background: rgba(3, 88, 109, 0.32);
}

.chart-priority-card {
  margin-top: 1rem;
}

.chart-card {
  padding: 1rem;
  border-radius: 1.35rem;
  background: linear-gradient(180deg, rgba(4, 17, 28, 0.84), rgba(7, 24, 38, 0.92));
  border: 1px solid rgba(67, 95, 124, 0.36);
}

.compact-legend {
  display: flex;
  font-size: clamp(0.72rem, 0.86vw, 0.8rem);
}

.control-mode-row {
  margin-top: 0.85rem;
}

.chart-series-item {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  color: var(--tc-text-primary);
}

.legend-dot {
  display: inline-block;
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  margin-right: 0.38rem;
}

.legend-dot-cyan { background: #31ddff; }
.legend-dot-amber { background: #ffb347; }

.chart-wrapper {
  margin-top: 1rem;
  display: grid;
  grid-template-columns: minmax(3.2rem, 4.2rem) minmax(0, 1fr);
  gap: 0.75rem;
  align-items: stretch;
}

.y-axis-toolbar {
  display: grid;
  gap: 0.85rem;
  margin-top: 1rem;
}

.axis-source-control {
  display: inline-grid;
  gap: 0.4rem;
  max-width: 18rem;
}

.axis-source-control span,
.axis-series-card label span,
.axis-caption {
  color: var(--tc-text-dim);
  font-size: 0.74rem;
}

.axis-source-control select,
.axis-series-card input {
  width: 100%;
  border-radius: 0.9rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
}

.axis-source-control select {
  padding: 0.65rem 0.8rem;
}

.axis-series-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65rem;
}

.axis-series-card {
  display: grid;
  gap: 0.55rem;
  padding: 0.85rem 0.9rem;
  border-radius: 1rem;
  border: 1px solid rgba(122, 148, 177, 0.14);
  background: rgba(255, 255, 255, 0.04);
}

.axis-series-card-head,
.axis-series-name,
.axis-series-card label {
  display: flex;
  align-items: center;
}

.axis-series-card-head,
.axis-series-card label {
  justify-content: space-between;
  gap: 0.6rem;
}

.axis-series-name {
  color: var(--tc-text-primary);
}

.axis-series-card input {
  max-width: 6.5rem;
  padding: 0.55rem 0.7rem;
  text-align: right;
}

.axis-series-card em {
  color: var(--tc-text-secondary);
  font-style: normal;
  min-width: 2.5rem;
  text-align: right;
}

.axis-reset-button {
  border: 1px solid rgba(120, 149, 187, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--tc-text-secondary);
  padding: 0.3rem 0.65rem;
  cursor: pointer;
}

.chart-surface {
  position: relative;
  display: grid;
  gap: 0.35rem;
  touch-action: none;
}

.chart-empty-state {
  position: absolute;
  inset: 1.5rem 0 2.1rem;
  display: grid;
  place-content: center;
  gap: 0.45rem;
  text-align: center;
  padding: 1.25rem;
  color: var(--tc-text-secondary);
  pointer-events: none;
}

.chart-empty-state strong {
  color: var(--tc-text-primary);
}

.chart-axis-labels {
  display: grid;
  grid-template-rows: auto minmax(18rem, min(42vw, 20rem));
  color: var(--tc-text-dim);
  font-size: clamp(0.68rem, 0.82vw, 0.76rem);
  padding-top: 0.3rem;
}

.axis-caption {
  color: #8be7ff;
  margin-bottom: 0.35rem;
}

.chart-axis-scale {
  position: relative;
  min-height: 18rem;
  height: min(42vw, 20rem);
}

.chart-axis-tick {
  position: absolute;
  right: 0;
  transform: translateY(-50%);
  white-space: nowrap;
}

.chart-svg {
  width: 100%;
  min-height: 18rem;
  height: min(42vw, 20rem);
  cursor: grab;
}

.chart-wrapper:active .chart-svg {
  cursor: grabbing;
}

.chart-grid {
  stroke: rgba(145, 165, 188, 0.14);
  stroke-width: 1;
}

.curve-line {
  fill: none;
  stroke: #31ddff;
  stroke-width: 4;
  stroke-linejoin: round;
  stroke-linecap: round;
  filter: drop-shadow(0 0 8px rgba(49, 221, 255, 0.25));
}

.curve-line-secondary {
  stroke-width: 3;
  filter: none;
  opacity: 0.94;
}

.chart-hover-line {
  stroke: rgba(255, 255, 255, 0.26);
  stroke-width: 1.4;
  stroke-dasharray: 6 5;
}

.chart-hover-point {
  stroke: rgba(4, 17, 28, 0.96);
  stroke-width: 2.2;
}

.chart-tooltip {
  position: absolute;
  z-index: 2;
  transform: translate(-50%, -100%);
  min-width: 10rem;
  max-width: min(18rem, 72vw);
  padding: 0.75rem 0.85rem;
  border-radius: 0.95rem;
  border: 1px solid rgba(120, 149, 187, 0.22);
  background: rgba(4, 17, 28, 0.94);
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);
  display: grid;
  gap: 0.32rem;
  pointer-events: none;
}

.chart-tooltip strong,
.chart-tooltip-row {
  color: var(--tc-text-primary);
}

.chart-tooltip-meta {
  color: var(--tc-text-secondary);
  font-size: 0.76rem;
}

.chart-tooltip-row {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
}

.timeline-labels {
  display: flex;
  justify-content: space-between;
  color: var(--tc-text-dim);
  font-size: clamp(0.68rem, 0.82vw, 0.76rem);
  margin-top: -0.2rem;
}

.axis-note {
  margin-top: 0.45rem;
  color: var(--tc-text-dim);
  font-size: 0.76rem;
  text-align: right;
}

.latest-button {
  border: 1px solid rgba(120, 149, 187, 0.2);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--tc-text-primary);
  padding: 0.35rem 0.7rem;
  cursor: pointer;
}

.temperature-layout {
  align-items: stretch;
}

.target-panel,
.live-panel {
  flex: 1 1 16rem;
}

.target-panel {
  padding: 1rem;
  border-radius: 1.2rem;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.03));
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.target-input-row {
  align-items: center;
  margin: 0.9rem 0 0.55rem;
}

.target-input-row input {
  flex: 1;
  min-width: 10rem;
  padding: 0.85rem 1rem;
  border-radius: 1rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
  font-size: clamp(1.05rem, 1.5vw, 1.2rem);
  font-weight: 600;
}

.target-input-row span {
  color: #8be7ff;
  font-weight: 700;
  align-self: center;
}

.live-panel {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.primary-metric-card,
.recording-panel,
.device-card,
.adapter-summary,
.event-item {
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(122, 148, 177, 0.14);
}

.primary-metric-card {
  padding: 1rem;
  display: grid;
  gap: 0.45rem;
}

.primary-metric-card strong {
  font-size: clamp(1.2rem, 1.9vw, 1.55rem);
}

.secondary-card strong {
  font-size: clamp(1rem, 1.45vw, 1.2rem);
}

.simplified-live-panel {
  align-content: start;
}

.live-hero-card {
  min-height: 7.2rem;
}

.support-note-row {
  margin-top: 0.9rem;
}

.recording-panel {
  padding: 1rem;
}

.recording-badge {
  border-radius: 999px;
  padding: 0.55rem 0.85rem;
  color: #d7ffed;
  background: rgba(24, 112, 72, 0.28);
  border: 1px solid rgba(78, 208, 143, 0.24);
}

.recording-meta {
  margin: 0.95rem 0;
}

.protocol-switch,
.scan-actions {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.single-line {
  margin: 0.9rem 0 0;
}

.form-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.serial-form,
.ethernet-form {
  margin-bottom: 0.2rem;
}

.form-grid label {
  display: grid;
  gap: 0.45rem;
}

.form-grid input,
.form-grid select,
.protocol-button,
.action-button {
  width: 100%;
  border-radius: 1rem;
}

.form-grid input,
.form-grid select {
  padding: 0.75rem 0.9rem;
  border: 1px solid rgba(132, 154, 181, 0.16);
  background: rgba(5, 17, 28, 0.82);
  color: var(--tc-text-primary);
}

.protocol-button,
.action-button,
.detail-toggle {
  border: 1px solid transparent;
  cursor: pointer;
  transition: 0.2s ease;
  padding: 0.75rem 0.9rem;
  font-weight: 600;
}

.protocol-button {
  color: var(--tc-text-secondary);
  background: rgba(255, 255, 255, 0.04);
}

.protocol-button.active {
  color: var(--tc-text-primary);
  border-color: rgba(49, 221, 255, 0.22);
  background: rgba(0, 137, 176, 0.22);
}

.action-button.primary,
.action-button.mode-button-auto {
  color: #021826;
  background: linear-gradient(135deg, #41e3ff, #7ee8ff);
}

.action-button.mode-button-manual {
  color: #fff6ea;
  background: linear-gradient(135deg, #ff8b3d, #ffb347);
}

.action-button.mode-button-unsynced {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  border-color: rgba(120, 149, 187, 0.2);
}

.action-button.secondary {
  color: var(--tc-text-primary);
  background: linear-gradient(135deg, rgba(58, 82, 114, 0.9), rgba(33, 49, 71, 0.9));
  border-color: rgba(120, 149, 187, 0.2);
}

.action-button.danger {
  color: #fff1f1;
  background: linear-gradient(135deg, rgba(176, 52, 52, 0.95), rgba(118, 28, 28, 0.95));
  border-color: rgba(255, 138, 138, 0.24);
}

.detail-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  border-color: rgba(122, 148, 177, 0.14);
  background: rgba(255, 255, 255, 0.04);
}

.detail-toggle strong {
  color: var(--tc-text-dim);
}

.compact-list {
  max-height: min(28vh, 16rem);
  overflow: auto;
  padding-right: 0.15rem;
}

.device-card {
  display: grid;
  gap: 0.3rem;
  padding: 0.9rem;
}

.serial-device-card {
  grid-template-columns: 1fr;
}

.selectable-card {
  grid-template-columns: 1rem 1fr;
  align-items: start;
  gap: 0.7rem;
}

.adapter-summary,
.event-item {
  padding: 0.9rem 1rem;
}

.event-list {
  max-height: min(34vh, 18rem);
  overflow: auto;
  padding-right: 0.15rem;
}

.event-time {
  display: inline-flex;
  font-size: clamp(0.7rem, 0.84vw, 0.78rem);
  color: #8be7ff;
  margin-bottom: 0.45rem;
}

.empty-state {
  padding: 1rem 0;
  text-align: center;
}

@media (max-width: 82rem) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 62rem) {
  .form-grid,
  .protocol-switch,
  .scan-actions,
  .live-panel,
  .axis-series-controls {
    grid-template-columns: 1fr;
  }

  .chart-wrapper {
    grid-template-columns: 1fr;
  }

  .chart-axis-labels {
    display: none;
  }

  .timeline-labels {
    grid-column: 1;
  }
}

@media (max-width: 48rem) {
  .panel-heading,
  .hero-heading,
  .chart-header,
  .recording-head,
  .recording-actions,
  .recording-meta,
  .temperature-layout,
  .support-note-row {
    flex-direction: column;
    align-items: stretch;
  }

}
</style>