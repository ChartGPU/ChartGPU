/**
 * Acceptance test for lineStyle.color precedence.
 * 
 * Tests that color resolution follows the correct precedence:
 * 1. series.lineStyle.color
 * 2. series.color
 * 3. theme.colorPalette[i % palette.length]
 */

import { resolveOptions } from '../../src/config/OptionResolver';
import type { ChartGPUOptions } from '../../src/config/types';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    console.log(`${GREEN}✓${RESET} ${message}`);
    passed++;
  } else {
    console.error(`${RED}✗${RESET} ${message}`);
    console.error(`  Expected: ${expected}`);
    console.error(`  Actual:   ${actual}`);
    failed++;
  }
}

function testLineStyleColorPrecedence() {
  console.log('\n=== Line Style Color Precedence Tests ===\n');

  // Test 1: lineStyle.color takes precedence over series.color
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          color: '#ff0000',
          lineStyle: { color: '#00ff00' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.lineStyle.color,
        '#00ff00',
        'lineStyle.color overrides series.color'
      );
      assertEquals(
        series.color,
        '#00ff00',
        'resolved series.color matches lineStyle.color'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 2: series.color takes precedence over palette
  {
    const options: ChartGPUOptions = {
      palette: ['#ff0000', '#00ff00'],
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          color: '#0000ff',
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#0000ff',
        'series.color overrides palette'
      );
      assertEquals(
        series.lineStyle.color,
        '#0000ff',
        'lineStyle.color reflects series.color'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 3: Palette fallback when no colors specified
  {
    const options: ChartGPUOptions = {
      palette: ['#123456'],
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#123456',
        'palette fallback works'
      );
      assertEquals(
        series.lineStyle.color,
        '#123456',
        'lineStyle.color uses palette fallback'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 4: Full precedence chain (lineStyle.color → series.color → palette)
  {
    const options: ChartGPUOptions = {
      palette: ['#111111', '#222222'],
      series: [
        // Series 0: lineStyle.color only
        {
          type: 'line',
          data: [[0, 0]],
          lineStyle: { color: '#aaaaaa' },
        },
        // Series 1: series.color only
        {
          type: 'line',
          data: [[0, 0]],
          color: '#bbbbbb',
        },
        // Series 2: palette fallback
        {
          type: 'line',
          data: [[0, 0]],
        },
        // Series 3: both lineStyle.color and series.color (lineStyle wins)
        {
          type: 'line',
          data: [[0, 0]],
          color: '#cccccc',
          lineStyle: { color: '#dddddd' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    
    const s0 = resolved.series[0];
    if (s0?.type === 'line') {
      assertEquals(s0.color, '#aaaaaa', 'Series 0: lineStyle.color used');
      assertEquals(s0.lineStyle.color, '#aaaaaa', 'Series 0: lineStyle.color matches');
    }
    
    const s1 = resolved.series[1];
    if (s1?.type === 'line') {
      assertEquals(s1.color, '#bbbbbb', 'Series 1: series.color used');
      assertEquals(s1.lineStyle.color, '#bbbbbb', 'Series 1: lineStyle.color matches');
    }
    
    const s2 = resolved.series[2];
    if (s2?.type === 'line') {
      assertEquals(s2.color, '#111111', 'Series 2: palette[2 % 2] used');
      assertEquals(s2.lineStyle.color, '#111111', 'Series 2: lineStyle.color matches');
    }
    
    const s3 = resolved.series[3];
    if (s3?.type === 'line') {
      assertEquals(s3.color, '#dddddd', 'Series 3: lineStyle.color overrides series.color');
      assertEquals(s3.lineStyle.color, '#dddddd', 'Series 3: lineStyle.color matches');
    }
  }

  // Test 5: Backward compatibility - no color specified still works
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          lineStyle: { width: 3, opacity: 0.8 },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.lineStyle.width,
        3,
        'backward compat: lineStyle.width preserved'
      );
      assertEquals(
        series.lineStyle.opacity,
        0.8,
        'backward compat: lineStyle.opacity preserved'
      );
      // Should get palette fallback
      const paletteColor = resolved.palette[0];
      assertEquals(
        series.color,
        paletteColor,
        'backward compat: palette fallback works'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }
}

function main() {
  testLineStyleColorPrecedence();

  console.log('\n=== Summary ===');
  console.log(`${GREEN}Passed: ${passed}${RESET}`);
  console.log(`${RED}Failed: ${failed}${RESET}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
