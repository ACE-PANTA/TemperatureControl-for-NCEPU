import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  defaultTranDraft,
  defaultFineDraft,
  defaultSmithDraft,
  defaultDeadband,
  defaultFineEnabled,
  defaultNetDraft,
  defaultPlantDrafts
} from '../services/pidSimulation.js';

const STORAGE_KEY = 'temperature-control:system-config';
const deviceApi = window.deviceApi;

const defaultSystemSettings = {
  csvEnabled: true,
  logDirectory: '',
  autoRecordingEnabled: true,
  autoPauseOnDisconnect: true,
  allowRemoteControl: false,
  xAxisSecondsPerDivision: 5,
  xAxisDivisionCount: 6,
  yAxisDisplaySeriesKey: 'furnaceTemp',
  yAxisProfiles: {
    furnaceTemp: {
      unitsPerDivision: 50,
      offset: 0
    },
    boardTemp: {
      unitsPerDivision: 20,
      offset: 0
    },
    pwm: {
      unitsPerDivision: 20,
      offset: 0
    }
  }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createParamRecordSnapshot({ tranDraft, fineDraft, smithDraft, deadband, fineEnabled }) {
  return {
    tran: clone(tranDraft),
    fine: clone(fineDraft),
    smith: clone(smithDraft),
    deadband,
    fineEnabled
  };
}

function normalizeParamRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .filter((record) => record && record.name && record.snapshot)
    .map((record) => ({
      id: record.id || `record-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: String(record.name),
      createdAt: Number(record.createdAt) || Date.now(),
      snapshot: {
        tran: { ...clone(defaultTranDraft), ...(record.snapshot.tran || {}) },
        fine: { ...clone(defaultFineDraft), ...(record.snapshot.fine || {}) },
        smith: { ...clone(defaultSmithDraft), ...(record.snapshot.smith || {}) },
        deadband: Number.isFinite(Number(record.snapshot.deadband)) ? Number(record.snapshot.deadband) : defaultDeadband,
        fineEnabled: typeof record.snapshot.fineEnabled === 'boolean' ? record.snapshot.fineEnabled : defaultFineEnabled
      }
    }));
}

export const useSystemConfigStore = defineStore('systemConfig', () => {
  const settings = reactive(clone(defaultSystemSettings));
  const tranDraft = reactive(clone(defaultTranDraft));
  const fineDraft = reactive(clone(defaultFineDraft));
  const smithDraft = reactive(clone(defaultSmithDraft));
  const deadband = ref(defaultDeadband);
  const fineEnabled = ref(defaultFineEnabled);
  const netDraft = reactive(clone(defaultNetDraft));
  const plantDraft = reactive(clone(defaultPlantDrafts.serial));
  const paramRecords = ref([]);
  const initialized = ref(false);

  function loadPersistedState() {
    if (initialized.value || typeof window === 'undefined') {
      return;
    }

    initialized.value = true;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw);
      const mergedSettings = {
        ...clone(defaultSystemSettings),
        ...(parsed.settings || {}),
        yAxisProfiles: {
          ...clone(defaultSystemSettings.yAxisProfiles),
          ...(parsed.settings?.yAxisProfiles || {})
        }
      };

      Object.assign(settings, mergedSettings);
      Object.assign(tranDraft, defaultTranDraft, parsed.tranDraft || {});
      Object.assign(fineDraft, defaultFineDraft, parsed.fineDraft || {});
      Object.assign(smithDraft, defaultSmithDraft, parsed.smithDraft || {});
      deadband.value = Number.isFinite(parsed.deadband) ? parsed.deadband : defaultDeadband;
      fineEnabled.value = typeof parsed.fineEnabled === 'boolean' ? parsed.fineEnabled : defaultFineEnabled;
      Object.assign(netDraft, defaultNetDraft, parsed.netDraft || {});
      Object.assign(plantDraft, defaultPlantDrafts.serial, parsed.plantDraft || parsed.plantDrafts?.serial || {});
      paramRecords.value = normalizeParamRecords(parsed.paramRecords);
    } catch {
      Object.assign(settings, defaultSystemSettings);
      Object.assign(tranDraft, defaultTranDraft);
      Object.assign(fineDraft, defaultFineDraft);
      Object.assign(smithDraft, defaultSmithDraft);
      deadband.value = defaultDeadband;
      fineEnabled.value = defaultFineEnabled;
      Object.assign(plantDraft, defaultPlantDrafts.serial);
      paramRecords.value = [];
    }
  }

  function persistState() {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        settings: clone(settings),
        tranDraft: clone(tranDraft),
        fineDraft: clone(fineDraft),
        smithDraft: clone(smithDraft),
        deadband: deadband.value,
        fineEnabled: fineEnabled.value,
        netDraft: clone(netDraft),
        plantDraft: clone(plantDraft),
        paramRecords: clone(paramRecords.value)
      })
    );
  }

  function addParamRecord(name) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) {
      return null;
    }

    const record = {
      id: `record-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: trimmedName,
      createdAt: Date.now(),
      snapshot: createParamRecordSnapshot({
        tranDraft,
        fineDraft,
        smithDraft,
        deadband: deadband.value,
        fineEnabled: fineEnabled.value
      })
    };

    paramRecords.value = [record, ...paramRecords.value];
    return record;
  }

  function removeParamRecord(id) {
    paramRecords.value = paramRecords.value.filter((record) => record.id !== id);
  }

  async function ensureDefaultLogDirectory() {
    if (settings.logDirectory) {
      return settings.logDirectory;
    }

    if (!deviceApi?.getDefaultLogDirectory) {
      return '';
    }

    const directory = await deviceApi.getDefaultLogDirectory();
    if (directory) {
      settings.logDirectory = directory;
    }

    return settings.logDirectory;
  }

  async function chooseLogDirectory() {
    if (!deviceApi?.chooseLogDirectory) {
      return settings.logDirectory;
    }

    const directory = await deviceApi.chooseLogDirectory(settings.logDirectory || undefined);
    if (directory) {
      settings.logDirectory = directory;
    }

    return settings.logDirectory;
  }

  async function syncExternalAccessConfig() {
    if (!deviceApi?.configureExternalAccess) {
      return null;
    }

    return deviceApi.configureExternalAccess({
      allowRemoteControl: settings.allowRemoteControl === true
    });
  }

  loadPersistedState();

  syncExternalAccessConfig().catch(() => {});

  watch(
    () => JSON.stringify({ settings, tranDraft, fineDraft, smithDraft, deadband: deadband.value, fineEnabled: fineEnabled.value, netDraft, plantDraft, paramRecords: paramRecords.value }),
    () => persistState()
  );

  watch(
    () => settings.allowRemoteControl,
    () => {
      syncExternalAccessConfig().catch(() => {});
    }
  );

  return {
    settings,
    tranDraft,
    fineDraft,
    smithDraft,
    deadband,
    fineEnabled,
    netDraft,
    plantDraft,
    paramRecords,
    addParamRecord,
    removeParamRecord,
    loadPersistedState,
    ensureDefaultLogDirectory,
    chooseLogDirectory,
    syncExternalAccessConfig
  };
});
