/**
 * Acceptance test for areaStyle.color precedence.
 * 
 * Tests that color resolution follows the correct precedence for both:
 * 1. Area series (type: 'area')
 *    - areaStyle.color → series.color → theme.colorPalette[i % palette.length]
 * 2. Line series with areaStyle (type: 'line' with areaStyle)
 *    - Stroke color: lineStyle.color → series.color → palette
 *    - Fill color: areaStyle.color → resolved stroke color
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

function testAreaSeriesColorPrecedence() {
  console.log('\n=== Area Series Color Precedence Tests ===\n');

  // Test 1: areaStyle.color takes precedence over series.color
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'area',
          data: [[0, 0], [1, 1]],
          color: '#ff0000',
          areaStyle: { color: '#00ff00' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'area') {
      assertEquals(
        series.areaStyle.color,
        '#00ff00',
        'Area series: areaStyle.color overrides series.color'
      );
      assertEquals(
        series.color,
        '#00ff00',
        'Area series: resolved series.color matches areaStyle.color'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected area series`);
      failed++;
    }
  }

  // Test 2: series.color takes precedence over palette
  {
    const options: ChartGPUOptions = {
      palette: ['#ff0000', '#00ff00'],
      series: [
        {
          type: 'area',
          data: [[0, 0], [1, 1]],
          color: '#0000ff',
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'area') {
      assertEquals(
        series.color,
        '#0000ff',
        'Area series: series.color overrides palette'
      );
      assertEquals(
        series.areaStyle.color,
        '#0000ff',
        'Area series: areaStyle.color reflects series.color'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected area series`);
      failed++;
    }
  }

  // Test 3: Palette fallback when no colors specified
  {
    const options: ChartGPUOptions = {
      palette: ['#123456'],
      series: [
        {
          type: 'area',
          data: [[0, 0], [1, 1]],
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'area') {
      assertEquals(
        series.color,
        '#123456',
        'Area series: palette fallback works for series.color'
      );
      assertEquals(
        series.areaStyle.color,
        '#123456',
        'Area series: palette fallback works for areaStyle.color'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected area series`);
      failed++;
    }
  }

  // Test 4: Full precedence chain (areaStyle.color → series.color → palette)
  {
    const options: ChartGPUOptions = {
      palette: ['#111111', '#222222', '#333333'],
      series: [
        // Series 0: areaStyle.color only
        {
          type: 'area',
          data: [[0, 0]],
          areaStyle: { color: '#aaaaaa' },
        },
        // Series 1: series.color only
        {
          type: 'area',
          data: [[0, 0]],
          color: '#bbbbbb',
        },
        // Series 2: palette fallback
        {
          type: 'area',
          data: [[0, 0]],
        },
        // Series 3: both areaStyle.color and series.color (areaStyle wins)
        {
          type: 'area',
          data: [[0, 0]],
          color: '#cccccc',
          areaStyle: { color: '#dddddd' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    
    const s0 = resolved.series[0];
    if (s0?.type === 'area') {
      assertEquals(s0.color, '#aaaaaa', 'Area S0: areaStyle.color used for series.color');
      assertEquals(s0.areaStyle.color, '#aaaaaa', 'Area S0: areaStyle.color matches');
    }
    
    const s1 = resolved.series[1];
    if (s1?.type === 'area') {
      assertEquals(s1.color, '#bbbbbb', 'Area S1: series.color used');
      assertEquals(s1.areaStyle.color, '#bbbbbb', 'Area S1: areaStyle.color matches series.color');
    }
    
    const s2 = resolved.series[2];
    if (s2?.type === 'area') {
      assertEquals(s2.color, '#333333', 'Area S2: palette[2 % 3] used');
      assertEquals(s2.areaStyle.color, '#333333', 'Area S2: areaStyle.color matches palette');
    }
    
    const s3 = resolved.series[3];
    if (s3?.type === 'area') {
      assertEquals(s3.color, '#dddddd', 'Area S3: areaStyle.color overrides series.color');
      assertEquals(s3.areaStyle.color, '#dddddd', 'Area S3: areaStyle.color matches');
    }
  }

  // Test 5: Whitespace trimming behavior (empty string treated as undefined)
  {
    const options: ChartGPUOptions = {
      palette: ['#999999'],
      series: [
        {
          type: 'area',
          data: [[0, 0]],
          color: '  ',
          areaStyle: { color: '   ' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'area') {
      assertEquals(
        series.color,
        '#999999',
        'Area series: whitespace-only colors fallback to palette'
      );
      assertEquals(
        series.areaStyle.color,
        '#999999',
        'Area series: whitespace-only areaStyle.color fallback to palette'
      );
    } else {
      console.error(`${RED}✗${RESET} Expected area series`);
      failed++;
    }
  }
}

function testLineSeriesWithAreaStyleColorPrecedence() {
  console.log('\n=== Line Series with AreaStyle Color Precedence Tests ===\n');

  // Test 1: Line with areaStyle - stroke and fill both use series.color when no overrides
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          color: '#ff0000',
          areaStyle: {},
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#ff0000',
        'Line+area: series.color used for stroke'
      );
      assertEquals(
        series.lineStyle.color,
        '#ff0000',
        'Line+area: lineStyle.color matches series.color'
      );
      if (series.areaStyle) {
        assertEquals(
          series.areaStyle.color,
          '#ff0000',
          'Line+area: areaStyle.color inherits from stroke color'
        );
      } else {
        console.error(`${RED}✗${RESET} Expected areaStyle to be defined`);
        failed++;
      }
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 2: lineStyle.color overrides series.color for stroke, areaStyle.color overrides for fill
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          color: '#ff0000',
          lineStyle: { color: '#00ff00' },
          areaStyle: { color: '#0000ff' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#00ff00',
        'Line+area: lineStyle.color used for series.color'
      );
      assertEquals(
        series.lineStyle.color,
        '#00ff00',
        'Line+area: lineStyle.color overrides series.color'
      );
      if (series.areaStyle) {
        assertEquals(
          series.areaStyle.color,
          '#0000ff',
          'Line+area: areaStyle.color independently set'
        );
      } else {
        console.error(`${RED}✗${RESET} Expected areaStyle to be defined`);
        failed++;
      }
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 3: areaStyle.color falls back to resolved stroke color when not specified
  {
    const options: ChartGPUOptions = {
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          lineStyle: { color: '#00ff00' },
          areaStyle: {},
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.lineStyle.color,
        '#00ff00',
        'Line+area: lineStyle.color used for stroke'
      );
      if (series.areaStyle) {
        assertEquals(
          series.areaStyle.color,
          '#00ff00',
          'Line+area: areaStyle.color inherits from resolved stroke color'
        );
      } else {
        console.error(`${RED}✗${RESET} Expected areaStyle to be defined`);
        failed++;
      }
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 4: Palette fallback for both stroke and fill when no colors specified
  {
    const options: ChartGPUOptions = {
      palette: ['#abcdef'],
      series: [
        {
          type: 'line',
          data: [[0, 0], [1, 1]],
          areaStyle: {},
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#abcdef',
        'Line+area: palette fallback for series.color'
      );
      assertEquals(
        series.lineStyle.color,
        '#abcdef',
        'Line+area: palette fallback for lineStyle.color'
      );
      if (series.areaStyle) {
        assertEquals(
          series.areaStyle.color,
          '#abcdef',
          'Line+area: palette fallback for areaStyle.color'
        );
      } else {
        console.error(`${RED}✗${RESET} Expected areaStyle to be defined`);
        failed++;
      }
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }

  // Test 5: Full precedence chain with multiple series
  {
    const options: ChartGPUOptions = {
      palette: ['#111111', '#222222'],
      series: [
        // Series 0: Only areaStyle.color
        {
          type: 'line',
          data: [[0, 0]],
          areaStyle: { color: '#aaaaaa' },
        },
        // Series 1: Only lineStyle.color
        {
          type: 'line',
          data: [[0, 0]],
          lineStyle: { color: '#bbbbbb' },
          areaStyle: {},
        },
        // Series 2: Only series.color
        {
          type: 'line',
          data: [[0, 0]],
          color: '#cccccc',
          areaStyle: {},
        },
        // Series 3: All three specified (lineStyle.color wins stroke, areaStyle.color wins fill)
        {
          type: 'line',
          data: [[0, 0]],
          color: '#dddddd',
          lineStyle: { color: '#eeeeee' },
          areaStyle: { color: '#ffffff' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    
    const s0 = resolved.series[0];
    if (s0?.type === 'line') {
      assertEquals(s0.color, '#111111', 'Line+area S0: palette used for stroke');
      assertEquals(s0.lineStyle.color, '#111111', 'Line+area S0: lineStyle.color from palette');
      if (s0.areaStyle) {
        assertEquals(s0.areaStyle.color, '#aaaaaa', 'Line+area S0: areaStyle.color explicitly set');
      }
    }
    
    const s1 = resolved.series[1];
    if (s1?.type === 'line') {
      assertEquals(s1.color, '#bbbbbb', 'Line+area S1: lineStyle.color used for stroke');
      assertEquals(s1.lineStyle.color, '#bbbbbb', 'Line+area S1: lineStyle.color matches');
      if (s1.areaStyle) {
        assertEquals(s1.areaStyle.color, '#bbbbbb', 'Line+area S1: fill inherits from stroke');
      }
    }
    
    const s2 = resolved.series[2];
    if (s2?.type === 'line') {
      assertEquals(s2.color, '#cccccc', 'Line+area S2: series.color used for stroke');
      assertEquals(s2.lineStyle.color, '#cccccc', 'Line+area S2: lineStyle.color matches');
      if (s2.areaStyle) {
        assertEquals(s2.areaStyle.color, '#cccccc', 'Line+area S2: fill inherits from stroke');
      }
    }
    
    const s3 = resolved.series[3];
    if (s3?.type === 'line') {
      assertEquals(s3.color, '#eeeeee', 'Line+area S3: lineStyle.color wins for stroke');
      assertEquals(s3.lineStyle.color, '#eeeeee', 'Line+area S3: lineStyle.color matches');
      if (s3.areaStyle) {
        assertEquals(s3.areaStyle.color, '#ffffff', 'Line+area S3: areaStyle.color independent');
      }
    }
  }

  // Test 6: Whitespace trimming behavior
  {
    const options: ChartGPUOptions = {
      palette: ['#fedcba'],
      series: [
        {
          type: 'line',
          data: [[0, 0]],
          color: '  ',
          lineStyle: { color: '   ' },
          areaStyle: { color: '    ' },
        },
      ],
    };

    const resolved = resolveOptions(options);
    const series = resolved.series[0];
    
    if (series?.type === 'line') {
      assertEquals(
        series.color,
        '#fedcba',
        'Line+area: whitespace-only colors fallback to palette for stroke'
      );
      assertEquals(
        series.lineStyle.color,
        '#fedcba',
        'Line+area: whitespace-only lineStyle.color fallback to palette'
      );
      if (series.areaStyle) {
        assertEquals(
          series.areaStyle.color,
          '#fedcba',
          'Line+area: whitespace-only areaStyle.color fallback to stroke color'
        );
      } else {
        console.error(`${RED}✗${RESET} Expected areaStyle to be defined`);
        failed++;
      }
    } else {
      console.error(`${RED}✗${RESET} Expected line series`);
      failed++;
    }
  }
}

function testMixedSeriesTypes() {
  console.log('\n=== Mixed Series Types Tests ===\n');

  // Test: Multiple series of different types with various color configurations
  {
    const options: ChartGPUOptions = {
      palette: ['#111111', '#222222', '#333333'],
      series: [
        // Area series with explicit areaStyle.color
        {
          type: 'area',
          data: [[0, 0]],
          areaStyle: { color: '#ff0000' },
        },
        // Line series with areaStyle, using series.color
        {
          type: 'line',
          data: [[0, 0]],
          color: '#00ff00',
          areaStyle: {},
        },
        // Area series with palette fallback
        {
          type: 'area',
          data: [[0, 0]],
        },
      ],
    };

    const resolved = resolveOptions(options);
    
    const s0 = resolved.series[0];
    if (s0?.type === 'area') {
      assertEquals(s0.color, '#ff0000', 'Mixed S0 (area): areaStyle.color used');
      assertEquals(s0.areaStyle.color, '#ff0000', 'Mixed S0 (area): areaStyle.color matches');
    }
    
    const s1 = resolved.series[1];
    if (s1?.type === 'line') {
      assertEquals(s1.color, '#00ff00', 'Mixed S1 (line+area): series.color used for stroke');
      if (s1.areaStyle) {
        assertEquals(s1.areaStyle.color, '#00ff00', 'Mixed S1 (line+area): fill inherits stroke');
      }
    }
    
    const s2 = resolved.series[2];
    if (s2?.type === 'area') {
      assertEquals(s2.color, '#333333', 'Mixed S2 (area): palette[2] used');
      assertEquals(s2.areaStyle.color, '#333333', 'Mixed S2 (area): areaStyle.color from palette');
    }
  }
}

function main() {
  testAreaSeriesColorPrecedence();
  testLineSeriesWithAreaStyleColorPrecedence();
  testMixedSeriesTypes();

  console.log('\n=== Summary ===');
  console.log(`${GREEN}Passed: ${passed}${RESET}`);
  console.log(`${RED}Failed: ${failed}${RESET}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
