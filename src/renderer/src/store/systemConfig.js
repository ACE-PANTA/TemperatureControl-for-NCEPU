import { reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { defaultPidDraft, defaultPlantDrafts } from '../services/pidSimulation.js';

const STORAGE_KEY = 'temperature-control:system-config';
const deviceApi = window.deviceApi;

const defaultSystemSettings = {
  csvEnabled: true,
  logDirectory: '',
  autoRecordingEnabled: true,
  autoPauseOnDisconnect: true,
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

export const useSystemConfigStore = defineStore('systemConfig', () => {
  const settings = reactive(clone(defaultSystemSettings));
  const pidDraft = reactive(clone(defaultPidDraft));
  const plantDraft = reactive(clone(defaultPlantDrafts.serial));
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
      Object.assign(pidDraft, defaultPidDraft, parsed.pidDraft || {});
      Object.assign(plantDraft, defaultPlantDrafts.serial, parsed.plantDraft || parsed.plantDrafts?.serial || {});
    } catch {
      Object.assign(settings, defaultSystemSettings);
      Object.assign(pidDraft, defaultPidDraft);
      Object.assign(plantDraft, defaultPlantDrafts.serial);
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
        pidDraft: clone(pidDraft),
        plantDraft: clone(plantDraft)
      })
    );
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

  loadPersistedState();

  watch(
    () => JSON.stringify({ settings, pidDraft, plantDraft }),
    () => persistState()
  );

  return {
    settings,
    pidDraft,
    plantDraft,
    loadPersistedState,
    ensureDefaultLogDirectory,
    chooseLogDirectory
  };
});