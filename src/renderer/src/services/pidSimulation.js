export const defaultPidDraft = {
  kp: 2.8,
  ki: 0.42,
  kd: 0.18,
  outputLimit: 85,
  sampleTime: 1000,
  deadband: 1.2,
  setpointRamp: 18,
  mode: '自动'
};

export const defaultPlantDrafts = {
  serial: {
    gain: 1.03,
    dampingRatio: 0.22,
    naturalFrequency: 0.16,
    heaterCeiling: 760,
    initialTemp: 432,
    transportDelay: 1.4
  },
  ethernet: {
    gain: 0.98,
    dampingRatio: 0.27,
    naturalFrequency: 0.14,
    heaterCeiling: 748,
    initialTemp: 428,
    transportDelay: 1.9
  }
};

export function normalizePidPayload(payload = {}) {
  return {
    kp: Number(payload.kp ?? defaultPidDraft.kp),
    ki: Number(payload.ki ?? defaultPidDraft.ki),
    kd: Number(payload.kd ?? defaultPidDraft.kd),
    outputLimit: Number(payload.outputLimit ?? defaultPidDraft.outputLimit),
    sampleTime: Number(payload.sampleTime ?? defaultPidDraft.sampleTime),
    deadband: Number(payload.deadband ?? defaultPidDraft.deadband),
    setpointRamp: Number(payload.setpointRamp ?? defaultPidDraft.setpointRamp),
    mode: payload.mode ?? defaultPidDraft.mode
  };
}

export function normalizePlantPayload(payload = {}, channel = 'serial') {
  const defaults = defaultPlantDrafts[channel] || defaultPlantDrafts.serial;

  return {
    gain: Number(payload.gain ?? defaults.gain),
    dampingRatio: Number(payload.dampingRatio ?? defaults.dampingRatio),
    naturalFrequency: Number(payload.naturalFrequency ?? defaults.naturalFrequency),
    heaterCeiling: Number(payload.heaterCeiling ?? defaults.heaterCeiling),
    initialTemp: Number(payload.initialTemp ?? defaults.initialTemp),
    transportDelay: Number(payload.transportDelay ?? defaults.transportDelay)
  };
}
