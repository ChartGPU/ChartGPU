/**
 * Correlated metric generation simulating a microservice memory leak incident
 * with a 5-phase narrative arc lasting ~180 seconds.
 */

export interface DashboardMetrics {
  timestamp: number;     // elapsedS * 1000 (ms for chart x-axis)
  memory: number;        // 0-100 (%)
  cpu: number;           // 0-100 (%)
  p50: number;           // ms
  p95: number;           // ms
  p99: number;           // ms
  throughput: number;    // req/s
  errors5xx: number;     // errors/s
  errors4xx: number;     // errors/s
  activeConnections: number;
  waitingQueue: number;
}

interface PhaseInfo {
  phase: number;
  name: string;
  progress: number; // 0.0 to 1.0
}

/**
 * Returns the current phase based on elapsed time.
 * Phase 1 (0-60s): Steady State
 * Phase 2 (60-120s): Leak Onset
 * Phase 3 (120-155s): Degradation
 * Phase 4 (155-175s): Incident
 * Phase 5 (175s+): Recovery
 */
export function getPhase(elapsedS: number): PhaseInfo {
  if (elapsedS < 60) {
    return { phase: 1, name: "Steady State", progress: elapsedS / 60 };
  } else if (elapsedS < 120) {
    return { phase: 2, name: "Leak Onset", progress: (elapsedS - 60) / 60 };
  } else if (elapsedS < 155) {
    return { phase: 3, name: "Degradation", progress: (elapsedS - 120) / 35 };
  } else if (elapsedS < 175) {
    return { phase: 4, name: "Incident", progress: (elapsedS - 155) / 20 };
  } else {
    return { phase: 5, name: "Recovery", progress: Math.min(1.0, (elapsedS - 175) / 60) };
  }
}

/**
 * Clamp a value between min and max.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generate random noise centered around 0.
 */
function noise(range: number): number {
  return (Math.random() - 0.5) * 2 * range;
}

/**
 * Generate a sinusoidal pattern for subtle oscillation.
 */
function sineWave(elapsedS: number, period: number, amplitude: number): number {
  return amplitude * Math.sin((2 * Math.PI * elapsedS) / period);
}

/**
 * Generate memory percentage based on current phase.
 */
function generateMemory(elapsedS: number, phase: PhaseInfo): number {
  const baseMemory = 45;
  const sinePattern = sineWave(elapsedS, 30, 0.02 * baseMemory); // ~2% oscillation

  if (phase.phase === 1) {
    // Steady state: 45% ± 3% noise
    return baseMemory + noise(3) + sinePattern;
  } else if (phase.phase === 2) {
    // Leak onset: linear climb at ~0.5%/s
    const elapsed = elapsedS - 60;
    return baseMemory + elapsed * 0.5 + noise(3) + sinePattern;
  } else if (phase.phase === 3) {
    // Degradation: accelerates to ~0.8%/s
    const elapsed = elapsedS - 120;
    const phase2Memory = baseMemory + 60 * 0.5; // ~75%
    return phase2Memory + elapsed * 0.8 + noise(3) + sinePattern;
  } else if (phase.phase === 4) {
    // Incident: saturates at 95%
    return 95 + noise(1);
  } else {
    // Recovery: exponential decay to 50%
    const elapsed = elapsedS - 175;
    const decayRate = 0.05;
    return 50 + (95 - 50) * Math.exp(-decayRate * elapsed) + noise(2);
  }
}

/**
 * Generate a complete metrics tick for the given elapsed time.
 */
export function generateTick(elapsedS: number): DashboardMetrics {
  const phase = getPhase(elapsedS);
  const timestamp = elapsedS * 1000;

  // 1. Memory (root cause)
  const memory = clamp(generateMemory(elapsedS, phase), 0, 100);

  // 2. CPU: Base 25% + GC pressure
  const gcPressure = Math.max(0, (memory - 60) * 1.2);
  const cpu = clamp(25 + gcPressure + noise(3), 0, 100);

  // 3. P50 Latency: Base 45ms + GC jitter
  const gcJitter = Math.max(0, (memory - 55) * 2);
  const p50 = Math.max(0, 45 + gcJitter + noise(5));

  // 4. P95 Latency: Fanning out from P50
  const p95Multiplier = 1.8 + Math.max(0, (memory - 70) * 0.06);
  const p95 = p50 * p95Multiplier + noise(10);

  // 5. P99 Latency: Fanning out from P95
  const p99Multiplier = 1.5 + Math.max(0, (memory - 75) * 0.08);
  const p99 = p95 * p99Multiplier + noise(20);

  // 6. Active Connections: Base 80 + hold factor
  const holdFactor = Math.max(0, (p95 - 100) * 0.5);
  const activeConnections = clamp(80 + holdFactor + noise(3), 0, 200);

  // 7. Waiting Queue: Overflow from active connections
  const waitingQueue = Math.max(0, (activeConnections - 180) * 3 + noise(2));

  // 8. Throughput: Base 1200 req/s degraded by connection pressure
  const baseThroughput = 1200;
  const throughputFactor = Math.max(0.05, 1 - (Math.max(0, activeConnections - 100) / 100) * 0.8);
  const sinePattern = sineWave(elapsedS, 30, 0.02 * baseThroughput); // ~2% oscillation
  const throughput = Math.max(0, baseThroughput * throughputFactor + noise(30) + sinePattern);

  // 9. 5xx Errors: Hockey stick based on P99 latency
  const errorBase = Math.max(0, (p99 - 400) * 0.02);
  const errors5xx = Math.max(0, Math.pow(errorBase, 1.5) + noise(0.5));

  // 10. 4xx Errors: Steady baseline independent of incident
  const errors4xx = Math.max(0, 3.5 + noise(1));

  return {
    timestamp,
    memory,
    cpu,
    p50,
    p95,
    p99,
    throughput,
    errors5xx,
    errors4xx,
    activeConnections,
    waitingQueue,
  };
}
