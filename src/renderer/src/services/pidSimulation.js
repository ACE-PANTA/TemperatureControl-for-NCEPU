export const defaultPidDraft = {
  kp: 1.1546,
  ki: 0.0054,
  kd: 0.0,
  outputLimit: 85,
  sampleTime: 1000,
  deadband: 1.2,
  setpointRamp: 18,
  mode: '自动'
};

export const defaultCascadeDraft = {
  kOuter: 0.5,
  maxRate: 3.0,
  kpInner: 40.0,
  kiInner: 12.0
};

export const defaultHybridDraft = {
  threshold: 5.0,
  kp: 3.0,
  ki: 0.3,
  kd: 1.0,
  slowInterval: 15
};

export const defaultNetDraft = {
  ip: '192.168.1.100',
  gateway: '192.168.1.1',
  netmask: '255.255.255.0',
  port: 8000,
  mac: '02:00:00:00:00:01'
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

export function normalizeCascadePayload(payload = {}) {
  return {
    kOuter: Number(payload.kOuter ?? defaultCascadeDraft.kOuter),
    maxRate: Number(payload.maxRate ?? defaultCascadeDraft.maxRate),
    kpInner: Number(payload.kpInner ?? defaultCascadeDraft.kpInner),
    kiInner: Number(payload.kiInner ?? defaultCascadeDraft.kiInner)
  };
}

export function normalizeHybridPayload(payload = {}) {
  return {
    threshold: Number(payload.threshold ?? defaultHybridDraft.threshold),
    kp: Number(payload.kp ?? defaultHybridDraft.kp),
    ki: Number(payload.ki ?? defaultHybridDraft.ki),
    kd: Number(payload.kd ?? defaultHybridDraft.kd),
    slowInterval: Number(payload.slowInterval ?? defaultHybridDraft.slowInterval)
  };
}

export function normalizeNetPayload(payload = {}) {
  return {
    ip: payload.ip ?? defaultNetDraft.ip,
    gateway: payload.gateway ?? defaultNetDraft.gateway,
    netmask: payload.netmask ?? defaultNetDraft.netmask,
    port: Number(payload.port ?? defaultNetDraft.port),
    mac: payload.mac ?? defaultNetDraft.mac
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
