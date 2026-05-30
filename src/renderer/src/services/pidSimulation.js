const DEFAULT_AMBIENT_TEMP = 28;

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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createDelayBuffer(size, initialValue) {
  return Array.from({ length: size }, () => initialValue);
}

function getNoise() {
  return (Math.random() - 0.5) * 0.38;
}

export function createSimulationChannel(channel, options = {}) {
  const pidOverrides = options.pidOverrides || options;
  const plantOverrides = options.plantOverrides || {};
  const profile = normalizePlantPayload(plantOverrides, channel);
  const pid = normalizePidPayload({ ...defaultPidDraft, ...pidOverrides });
  const delayedControl = createDelayBuffer(
    Math.max(1, Math.round(profile.transportDelay)),
    0
  );

  return {
    channel,
    plant: profile,
    pid,
    state: {
      timestamp: Date.now(),
      elapsedSeconds: 0,
      temperature: profile.initialTemp,
      velocity: 0,
      controlOutput: 0,
      delayedControl,
      setpoint: 720,
      requestedSetpoint: 720,
      disturbance: 0,
      lastDisturbanceAt: 0,
      error1: 0,
      error2: 0,
      maxTemperature: profile.initialTemp,
      settleStartedAt: null,
      settlingTime: null,
      overshootPercent: 0
    }
  };
}

export function applyPidSettings(channelState, payload) {
  channelState.pid = normalizePidPayload({
    ...channelState.pid,
    ...payload
  });

  if (payload.targetTemp) {
    channelState.state.requestedSetpoint = Number(payload.targetTemp);
  }

  channelState.state.maxTemperature = channelState.state.temperature;
  channelState.state.settleStartedAt = null;
  channelState.state.settlingTime = null;
  channelState.state.overshootPercent = 0;
}

export function applyPlantSettings(channelState, payload) {
  channelState.plant = normalizePlantPayload({
    ...channelState.plant,
    ...payload
  }, channelState.channel);

  const delaySize = Math.max(1, Math.round(channelState.plant.transportDelay));
  if (channelState.state.delayedControl.length !== delaySize) {
    channelState.state.delayedControl = createDelayBuffer(delaySize, channelState.state.controlOutput);
  }
}

function updateSetpoint(channelState, dtSeconds) {
  const rampPerSecond = channelState.pid.setpointRamp / 60;
  const { setpoint, requestedSetpoint } = channelState.state;
  const delta = requestedSetpoint - setpoint;

  if (Math.abs(delta) < 0.001) {
    return;
  }

  const step = clamp(delta, -rampPerSecond * dtSeconds, rampPerSecond * dtSeconds);
  channelState.state.setpoint += step;
}

function maybeInjectDisturbance(channelState) {
  const { elapsedSeconds, lastDisturbanceAt } = channelState.state;
  if (elapsedSeconds - lastDisturbanceAt < 5) {
    return;
  }

  channelState.state.lastDisturbanceAt = elapsedSeconds;
  if (Math.random() >= 0.3) {
    return;
  }

  const magnitude = 0.45 + Math.random() * 0.9;
  const direction = Math.random() > 0.5 ? 1 : -1;
  channelState.state.disturbance += magnitude * direction;
}

function stepController(channelState, dtSeconds) {
  const { pid, state } = channelState;
  const error = state.setpoint - state.temperature;
  const effectiveError = Math.abs(error) <= pid.deadband ? 0 : error;

  if (pid.mode === '手动') {
    state.error2 = state.error1;
    state.error1 = effectiveError;
    return effectiveError;
  }

  const deltaOutput =
    pid.kp * (effectiveError - state.error1) +
    pid.ki * dtSeconds * effectiveError +
    (pid.kd / dtSeconds) * (effectiveError - 2 * state.error1 + state.error2);

  state.controlOutput = clamp(state.controlOutput + deltaOutput, 0, pid.outputLimit);
  state.error2 = state.error1;
  state.error1 = effectiveError;

  return effectiveError;
}

function stepPlant(channelState, dtSeconds) {
  const { plant, state, pid } = channelState;

  state.delayedControl.push(state.controlOutput / Math.max(pid.outputLimit, 1));
  const delayedControl = state.delayedControl.shift() || 0;
  const heaterTarget = DEFAULT_AMBIENT_TEMP + delayedControl * (plant.heaterCeiling - DEFAULT_AMBIENT_TEMP);

  const accel =
    -2 * plant.dampingRatio * plant.naturalFrequency * state.velocity -
    plant.naturalFrequency * plant.naturalFrequency * (state.temperature - DEFAULT_AMBIENT_TEMP) +
    plant.gain * plant.naturalFrequency * plant.naturalFrequency * (heaterTarget - DEFAULT_AMBIENT_TEMP) +
    state.disturbance;

  state.velocity += accel * dtSeconds;
  state.temperature += state.velocity * dtSeconds + getNoise();
  state.temperature = clamp(state.temperature, DEFAULT_AMBIENT_TEMP, plant.heaterCeiling + 18);
  state.disturbance *= 0.72;
}

function updateMetrics(channelState) {
  const { state } = channelState;
  state.maxTemperature = Math.max(state.maxTemperature, state.temperature);
  const overshoot = state.maxTemperature - state.requestedSetpoint;
  state.overshootPercent = Math.max(0, (overshoot / Math.max(state.requestedSetpoint, 1)) * 100);

  const settleBand = Math.max(1.2, state.requestedSetpoint * 0.01);
  if (Math.abs(state.requestedSetpoint - state.temperature) <= settleBand) {
    if (state.settleStartedAt === null) {
      state.settleStartedAt = state.elapsedSeconds;
    }

    if (state.settlingTime === null && state.elapsedSeconds - state.settleStartedAt >= 8) {
      state.settlingTime = state.settleStartedAt;
    }
  } else {
    state.settleStartedAt = null;
  }
}

export function advanceSimulation(channelState, horizonSeconds = 1) {
  const requestedSampleTimeMs = clamp(Number(channelState.pid.sampleTime) || 1000, 100, 2000);
  const steps = Math.max(1, Math.round((horizonSeconds * 1000) / requestedSampleTimeMs));
  const dtSeconds = horizonSeconds / steps;

  for (let index = 0; index < steps; index += 1) {
    updateSetpoint(channelState, dtSeconds);
    maybeInjectDisturbance(channelState);
    stepController(channelState, dtSeconds);
    stepPlant(channelState, dtSeconds);
    channelState.state.elapsedSeconds += dtSeconds;
  }

  updateMetrics(channelState);
  channelState.state.timestamp = Date.now();

  return {
    channel: channelState.channel,
    timestamp: channelState.state.timestamp,
    elapsedSeconds: Number(channelState.state.elapsedSeconds.toFixed(1)),
    temperature: Number(channelState.state.temperature.toFixed(2)),
    setpoint: Number(channelState.state.setpoint.toFixed(2)),
    requestedSetpoint: Number(channelState.state.requestedSetpoint.toFixed(2)),
    controlOutput: Number(channelState.state.controlOutput.toFixed(2)),
    disturbance: Number(channelState.state.disturbance.toFixed(3)),
    overshootPercent: Number(channelState.state.overshootPercent.toFixed(2)),
    settlingTime: channelState.state.settlingTime,
    mode: channelState.pid.mode,
    kp: Number(channelState.pid.kp),
    ki: Number(channelState.pid.ki),
    kd: Number(channelState.pid.kd),
    sampleTime: Number(channelState.pid.sampleTime),
    outputLimit: Number(channelState.pid.outputLimit),
    deadband: Number(channelState.pid.deadband),
    setpointRamp: Number(channelState.pid.setpointRamp)
  };
}