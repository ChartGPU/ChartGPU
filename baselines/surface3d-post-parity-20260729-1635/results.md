# surface3d SciChart parity — post results

Same machine, sequential browser-harness runs, production dist.

## ChartGPU 0.3.4-local (2nd warm run)

| Points | Avg FPS | Min | Max | Status |
|--------|---------|-----|-----|--------|
| 100 | 119.29 | 103.09 | 240.00 | OK |
| 200 | 119.23 | 105.26 | 140.85 | OK |
| 500 | 119.32 | 102.04 | 138.89 | OK |
| 1000 | 118.52 | 30.49 | 188.68 | OK |
| 2000 | 41.23 | 12.18 | 45.05 | OK |
| 4000 | 9.76 | 6.16 | 11.48 | OK |
| 8000 | 0.94 | 2.11 | 2.89 | OK |

## SciChart.js Local (same session)

| Points | Avg FPS | Min | Max | Status |
|--------|---------|-----|-----|--------|
| 100 | 114.87 | 92.59 | 240.00 | OK |
| 200 | 116.46 | 93.46 | 140.85 | OK |
| 500 | 116.19 | 79.37 | 140.85 | OK |
| 1000 | 49.71 | 33.56 | 54.35 | OK |
| 2000 | 11.71 | 9.43 | 13.42 | OK |
| 4000 | 2.64 | 2.67 | 3.32 | OK |
| 8000 | 0.00 | 0.00 | 0.00 | HANGING |

## Goal deltas (CG − SC)

| Points | Pre CG (goal baseline) | Post CG | SciChart (this run) | Met ≥ SC? |
|--------|------------------------|---------|---------------------|-----------|
| 1000 | 30.72 | 118.52 | 49.71 | YES |
| 2000 | 7.46 | 41.23 | 11.71 | YES |
| 4000 | 1.33 | 9.76 | 2.64 | YES |

Guardrails 100/200/500: ChartGPU still ≥ SciChart.

## Measurement notes

WS1 (stream zero-copy / domain / AABB / contours) and WS2 (height-only GPU path) were landed together; competitive harness FPS was recorded only after both completed — no intermediate ladder row artifacts.
