export const defaultPidDraft = {
  kp: 3.0,
  ki: 0.3,
  kd: 1.0
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
    kd: Number(payload.kd ?? defaultPidDraft.kd)
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
