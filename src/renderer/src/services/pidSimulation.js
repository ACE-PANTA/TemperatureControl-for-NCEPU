export const defaultTranDraft = {
  kp: 3.0,
  ki: 0.3,
  kd: 1.0,
  interval: 3,
  sepThreshold: 10.0
};

export const defaultFineDraft = {
  kp: 1.5,
  ki: 0.1,
  kd: 2.0,
  interval: 8,
  range: 5.0,
  entryMin: 1.0,
  entryMax: 3.0,
  stableWindow: 20,
  stableDelta: 1.0
};

export const defaultSmithDraft = {
  enabled: false,
  gain: 40.0,
  tau: 120,
  delay: 30,
  blend: 0.7,
  maxLead: 8.0
};

export const defaultDeadband = 0.3;
export const defaultFineEnabled = true;

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

export function normalizeTranPayload(payload = {}) {
  return {
    kp: Number(payload.kp ?? defaultTranDraft.kp),
    ki: Number(payload.ki ?? defaultTranDraft.ki),
    kd: Number(payload.kd ?? defaultTranDraft.kd),
    interval: Number(payload.interval ?? defaultTranDraft.interval),
    sepThreshold: Number(payload.sepThreshold ?? defaultTranDraft.sepThreshold)
  };
}

export function normalizeFinePayload(payload = {}) {
  return {
    kp: Number(payload.kp ?? defaultFineDraft.kp),
    ki: Number(payload.ki ?? defaultFineDraft.ki),
    kd: Number(payload.kd ?? defaultFineDraft.kd),
    interval: Number(payload.interval ?? defaultFineDraft.interval),
    range: Number(payload.range ?? defaultFineDraft.range),
    entryMin: Number(payload.entryMin ?? defaultFineDraft.entryMin),
    entryMax: Number(payload.entryMax ?? defaultFineDraft.entryMax),
    stableWindow: Number(payload.stableWindow ?? defaultFineDraft.stableWindow),
    stableDelta: Number(payload.stableDelta ?? defaultFineDraft.stableDelta)
  };
}

export function normalizeSmithPayload(payload = {}) {
  return {
    enabled: Boolean(payload.enabled ?? defaultSmithDraft.enabled),
    gain: Number(payload.gain ?? defaultSmithDraft.gain),
    tau: Number(payload.tau ?? defaultSmithDraft.tau),
    delay: Number(payload.delay ?? defaultSmithDraft.delay),
    blend: Number(payload.blend ?? defaultSmithDraft.blend),
    maxLead: Number(payload.maxLead ?? payload.maxlead ?? defaultSmithDraft.maxLead)
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
