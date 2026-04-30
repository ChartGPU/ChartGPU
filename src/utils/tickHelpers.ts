import type { AxisType } from "../config/types";

export const DEFAULT_TICK_COUNT = 5;

/**
 * Generates an array of tick values for a given axis type and domain.
 */
export function generateTicks(
  type: AxisType,
  domainMin: number,
  domainMax: number,
  tickCount: number = DEFAULT_TICK_COUNT
): number[] {
  if (tickCount <= 1) return [(domainMin + domainMax) / 2];

  if (type === "log") {
    return generateLogTicks(domainMin, domainMax, tickCount);
  }

  // Default linear interpolation
  const ticks: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    const t = i / (tickCount - 1);
    ticks.push(domainMin + t * (domainMax - domainMin));
  }
  return ticks;
}

/**
 * Generates powers of 10 between domainMin and domainMax.
 */
function generateLogTicks(
  domainMin: number,
  domainMax: number,
  tickCount: number
): number[] {
  const minLog = Math.floor(Math.log10(domainMin));
  const maxLog = Math.ceil(Math.log10(domainMax));

  const ticks: number[] = [];
  for (let power = minLog; power <= maxLog; power++) {
    const value = Math.pow(10, power);
    if (value >= domainMin && value <= domainMax) {
      ticks.push(value);
    }
  }

  // Fallback: if range is too narrow for powers of 10, generate linear ticks in log space
  if (ticks.length < 2) {
    ticks.length = 0;
    const logMin = Math.log10(domainMin);
    const logMax = Math.log10(domainMax);
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const logVal = logMin + t * (logMax - logMin);
      ticks.push(Math.pow(10, logVal));
    }
  }

  return ticks;
}

/**
 * Formats a value for a logarithmic scale, returning string representations
 * like "10³" for powers of 10, or a standard number string for intermediate values.
 */
export function formatLogTick(value: number): string {
  const logVal = Math.log10(value);
  const isPowerOf10 = Math.abs(logVal - Math.round(logVal)) < 1e-10;

  if (isPowerOf10) {
    const exponent = Math.round(logVal);
    const superScriptMap: { [key: string]: string } = {
      '-': '⁻',
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };
    const exponentStr = exponent.toString().split('').map(char => superScriptMap[char] || char).join('');
    return `10${exponentStr}`;
  }

  // Fallback for non-powers of 10 (e.g. if the range is narrow)
  const str = value.toPrecision(3);
  if (str.includes('.')) {
    return str.replace(/\.?0+$/, '');
  }
  return str;
}
