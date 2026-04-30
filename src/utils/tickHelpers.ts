import type { AxisType } from "../config/types";

export const DEFAULT_TICK_COUNT = 5;

/**
 * Generates an array of tick values for a given axis type and domain.
 */
export function generateTicks(
  type: AxisType,
  domainMin: number,
  domainMax: number,
  tickCount: number = DEFAULT_TICK_COUNT,
  logBase: number = 10
): number[] {
  if (tickCount <= 1) return [(domainMin + domainMax) / 2];

  if (type === "log") {
    return generateLogTicks(domainMin, domainMax, tickCount, logBase);
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
  tickCount: number,
  base: number
): number[] {
  const logBaseVal = Math.log(base);
  const minLog = Math.floor(Math.log(domainMin) / logBaseVal);
  const maxLog = Math.ceil(Math.log(domainMax) / logBaseVal);

  const ticks: number[] = [];
  for (let power = minLog; power <= maxLog; power++) {
    const value = Math.pow(base, power);
    if (value >= domainMin && value <= domainMax) {
      ticks.push(value);
    }
  }

  // Fallback: if range is too narrow for powers of base, generate linear ticks in log space
  if (ticks.length < 2) {
    ticks.length = 0;
    const logMin = Math.log(domainMin) / logBaseVal;
    const logMax = Math.log(domainMax) / logBaseVal;
    for (let i = 0; i < tickCount; i++) {
      const t = i / (tickCount - 1);
      const logVal = logMin + t * (logMax - logMin);
      ticks.push(Math.pow(base, logVal));
    }
  }

  return ticks;
}

/**
 * Formats a value for a logarithmic scale, returning string representations
 * like "10³" for powers of 10, or a standard number string for intermediate values.
 */
export function formatLogTick(value: number, base: number = 10): string {
  const logVal = Math.log(value) / Math.log(base);
  const isPowerOfBase = Math.abs(logVal - Math.round(logVal)) < 1e-10;

  if (isPowerOfBase) {
    const exponent = Math.round(logVal);
    const superScriptMap: { [key: string]: string } = {
      '-': '⁻',
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };
    const exponentStr = exponent.toString().split('').map(char => superScriptMap[char] || char).join('');
    
    let baseStr = base.toString();
    if (base === Math.E) {
      baseStr = "e";
    }
    
    return `${baseStr}${exponentStr}`;
  }

  // Fallback for non-powers of base (e.g. if the range is narrow)
  const str = value.toPrecision(3);
  if (str.includes('.')) {
    return str.replace(/\.?0+$/, '');
  }
  return str;
}
