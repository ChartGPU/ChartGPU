# ChartGPU Benchmark Results

Source: [JavaScript Chart Performance Test Suite](https://github.com/ABTSoftware/javascript-chart-performance-test-suite)

## Test Environment

| Component | Details |
|---|---|
| Browser | Chrome 144 (Windows NT 10.0) |
| GPU | NVIDIA GeForce RTX 4090 Laptop GPU (16 GB VRAM) |
| CPU | Intel Core i9-14900HX (2.2GHz, 32 cores) |
| Renderer | ANGLE (D3D11) |

## Libraries Tested

SciChart.js, HighCharts (Boost), Chart.js, Plotly.js (GL), Apache eCharts (GL), uPlot, **ChartGPU**, LightningChart (LCJS v8)

---

## Overall Rankings (102 test configurations, FPS-based)

| Rank | Library | Wins | Avg FPS | Notes |
|---|---|---|---|---|
| 1 | SciChart.js | 73/102 (72%) | 153.4 | Dominated 10 of 13 categories |
| 2 | LCJS v8 | 15/102 | 127.9 | Best in Series Compression & FIFO streaming at scale |
| 3 | **ChartGPU** | 6/102 | 94.0 | Best at small data sizes; 3rd overall |

---

## Randomised Scatter Series (Brownian Motion)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 236.99 | 71.75 | 80.78 | 147.05 | 210.21 | 196.68 | **237.84** | 224.58 |
| 10K | 239.32 | 48.94 | 9.91 | 132.32 | 44.41 | 10.73 | 239.11 | 234.69 |
| 50K | 239.21 | 20.00 | 2.08 | 87.58 | Hang | Hang | 199.55 | 196.33 |
| 100K | 239.37 | 13.31 | 1.06 | 23.92 | Skip | Skip | 106.22 | 131.13 |
| 200K | 237.52 | 10.54 | 0.50 | 10.54 | Skip | Skip | 41.09 | 97.84 |
| 500K | 98.71 | 6.25 | Skip | 4.54 | Skip | Skip | 15.94 | 67.14 |
| 1M | 59.33 | 3.46 | Skip | 2.31 | Skip | Skip | 6.80 | 38.40 |
| 5M | 10.54 | 0.89 | Skip | 0.37 | Skip | Skip | 1.57 | 7.32 |
| 10M | 5.39 | Skip | Skip | Skip | Skip | Skip | 0.76 | 3.81 |

## Randomised XY Line Series (Unsorted)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 236.96 | 55.40 | 73.57 | 133.62 | 62.36 | 52.64 | 235.87 | 224.06 |
| 10K | 237.37 | 50.26 | 3.37 | 113.66 | 3.77 | 3.77 | 231.68 | 220.41 |
| 50K | 236.85 | 26.39 | 0.26 | 58.66 | 0.21 | 0.11 | 93.34 | 162.51 |
| 100K | 236.76 | 16.89 | Skip | 17.46 | Skip | Skip | 45.53 | 87.89 |
| 200K | 194.96 | 12.19 | Skip | 8.18 | Skip | Skip | 21.97 | 46.91 |
| 500K | 89.43 | 5.86 | Skip | 2.92 | Skip | Skip | 9.27 | 19.33 |
| 1M | 50.31 | 3.18 | Skip | 1.30 | Skip | Skip | 4.99 | 9.99 |
| 5M | 9.39 | 0.81 | Skip | Hang | Skip | Skip | 1.20 | 1.80 |
| 10M | 2.86 | Skip | Skip | Skip | Skip | Skip | 0.53 | 0.66 |

## Sorted Point Series (Updating Y-Values)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 232.98 | 74.86 | 53.40 | 151.60 | 47.02 | 57.99 | **237.76** | 227.58 |
| 10K | 235.00 | 58.80 | 9.72 | 114.92 | 5.80 | 12.79 | **238.45** | 213.43 |
| 50K | 235.87 | 27.16 | 1.79 | 60.23 | 0.63 | Hang | 179.31 | 231.88 |
| 100K | 234.77 | 17.59 | 0.93 | 23.65 | Skip | Skip | 111.27 | 150.75 |
| 200K | 205.01 | 12.64 | Skip | 11.19 | Skip | Skip | 48.18 | 79.47 |
| 500K | 94.45 | 6.67 | Skip | 4.24 | Skip | Skip | 17.26 | 27.99 |
| 1M | 62.94 | 3.48 | Skip | 1.95 | Skip | Skip | 8.22 | 13.11 |
| 5M | 11.69 | 0.90 | Skip | 0.37 | Skip | Skip | 1.81 | 2.25 |
| 10M | 4.82 | Skip | Skip | Skip | Skip | Skip | 0.95 | 0.91 |

## Column Series (Static Data)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 235.55 | 57.52 | 127.22 | 83.97 | 20.79 | 231.03 | 235.13 | 224.11 |
| 10K | 238.56 | 60.97 | 19.80 | 9.15 | 95.29 | 166.52 | 218.53 | 234.57 |
| 50K | 239.09 | 21.56 | 3.80 | 1.09 | 91.42 | 32.96 | 184.87 | 206.34 |
| 100K | 239.14 | 13.77 | 1.75 | 0.31 | 34.12 | 15.52 | 115.12 | 131.22 |
| 200K | 239.36 | 9.97 | Skip | Skip | Error | 6.57 | 70.48 | 215.90 |
| 500K | 239.44 | 6.10 | - | Skip | Skip | 2.17 | 35.19 | Hang |
| 1M | 238.79 | 3.00 | - | Skip | Skip | 0.82 | 17.26 | Skip |
| 5M | 238.23 | 0.80 | - | Skip | Skip | Skip | 2.12 | Skip |
| 10M | 237.03 | Skip | - | Skip | Skip | Skip | 0.99 | Skip |

## Candlestick Chart (Static Data)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 236.08 | Hang | 49.78 | 26.15 | 230.10 | 230.22 | **236.27** | 224.30 |
| 10K | 236.18 | Skip | 7.89 | 2.17 | 139.48 | 59.85 | **238.14** | 217.39 |
| 50K | 234.73 | Skip | 0.91 | Hang | 46.46 | 13.90 | 232.73 | 193.82 |
| 100K | 234.84 | Skip | Skip | Skip | 28.32 | 6.63 | 189.85 | 146.85 |
| 200K | 233.60 | Skip | Skip | Skip | 15.97 | 2.86 | 139.19 | 141.16 |
| 500K | 234.46 | Skip | Skip | Skip | 7.65 | 0.89 | 77.61 | 37.64 |
| 1M | 234.66 | Skip | Skip | Skip | 3.75 | Skip | 47.02 | 10.94 |
| 5M | 232.69 | Skip | Skip | Skip | Hang | Skip | 10.89 | Hang |
| 10M | 228.04 | Skip | Skip | Skip | Skip | Skip | 5.49 | Skip |

## Mountain / Area Chart

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 238.31 | 206.32 | 44.02 | 226.12 | 197.73 | 231.06 | 237.57 | 219.77 |
| 10K | 239.28 | 63.32 | 5.30 | 222.98 | 94.54 | 239.18 | 239.25 | 226.17 |
| 50K | 238.79 | 19.17 | 1.04 | 217.65 | 30.40 | 239.22 | 178.22 | 236.25 |
| 100K | 237.53 | 12.20 | 0.51 | 199.57 | 15.65 | 235.97 | 105.11 | 232.25 |
| 200K | 236.18 | 8.37 | Skip | 172.56 | 6.97 | 236.41 | 52.00 | 232.68 |
| 500K | 239.53 | 4.34 | Skip | 175.57 | 2.26 | 189.43 | 23.29 | 234.72 |
| 1M | 239.39 | 2.56 | Skip | 126.19 | 0.86 | 119.94 | 12.52 | 233.35 |
| 5M | 237.01 | 0.50 | Skip | Hang | Skip | 30.50 | 2.13 | 228.01 |
| 10M | 236.00 | Skip | Skip | Skip | Skip | 16.21 | 0.62 | 220.89 |

## FIFO / ECG Streaming (5 series)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 100 | 235.13 | 67.17 | 102.14 | 106.29 | 212.86 | 230.72 | **237.66** | 222.02 |
| 10K | 235.69 | 18.82 | 17.35 | 62.77 | 17.08 | 184.10 | 230.87 | 234.71 |
| 100K | 236.14 | 3.92 | Hang | 5.75 | 1.62 | 97.92 | 58.92 | 235.78 |
| 1M | 79.21 | Hang | Skip | 0.61 | Hang | 12.15 | 6.64 | 81.35 |
| 5M | 29.09 | Skip | Skip | Skip | Skip | 2.56 | Error | 31.53 |
| 10M | 19.40 | Skip | Skip | Skip | Skip | 1.25 | Skip | 31.50 |

## Series Compression (Data Append)

| Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1K | 238.16 | 85.75 | 23.18 | 114.65 | 86.79 | 231.82 | 236.81 | 228.12 |
| 10K | 239.14 | 35.63 | 7.19 | 46.00 | 26.88 | 218.36 | 173.78 | 237.86 |
| 100K | 173.61 | 13.98 | 1.84 | 11.89 | 6.17 | 87.83 | 68.25 | 226.50 |
| 1M | 69.38 | 3.13 | 0.35 | 2.34 | 0.63 | 27.32 | 20.61 | 155.83 |
| 10M | 21.84 | 0.38 | Skip | Hang | Skip | 6.18 | Error | 20.91 |

## Multi Chart (100K points each)

| Charts | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 1 | 155.75 | 13.53 | 1.84 | 11.04 | 4.85 | 79.31 | 65.65 | 220.39 |
| 2 | 124.67 | 7.57 | 0.77 | 8.41 | Hang | Hang | 51.15 | 166.78 |
| 4 | 103.76 | 3.30 | Skip | 0.54 | Skip | Skip | 33.16 | 71.55 |
| 8 | 71.09 | 1.74 | Skip | Skip | Skip | Skip | 18.31 | 31.45 |
| 16 | 42.75 | 1.08 | Skip | Skip | Skip | Skip | 7.95 | 10.60 |
| 32 | 26.78 | 0.48 | Skip | Skip | Skip | Skip | 4.70 | Hang |
| 64 | 12.46 | Skip | Skip | Skip | Skip | Skip | Skip | Skip |
| 128 | 7.90 | Skip | Skip | Skip | Skip | Skip | - | Skip |

## N Line Series x M Points

| Series x Points | SciChart.js | HighCharts | Chart.js | Plotly.js | eCharts | uPlot | **ChartGPU** | LCJS v8 |
|---|---|---|---|---|---|---|---|---|
| 100x100 | 235.30 | 41.76 | 10.48 | 225.46 | 82.97 | 183.49 | 212.93 | 224.70 |
| 200x200 | 235.92 | Hang | 2.77 | 238.77 | 36.69 | 43.16 | 120.22 | 231.64 |
| 500x500 | 129.03 | Skip | 0.47 | 148.25 | 7.86 | 6.10 | 43.36 | 134.99 |
| 1Kx1K | 63.71 | Skip | Skip | 94.28 | 1.88 | 1.52 | 18.17 | 78.70 |
| 2Kx2K | 27.43 | Skip | Skip | 49.14 | Hang | 0.29 | 5.77 | 39.65 |
| 4Kx4K | 9.67 | Skip | Skip | Hang | Skip | Skip | Hang | 15.49 |
| 8Kx8K | 2.19 | Skip | Skip | Skip | Skip | Skip | Skip | Hang |

## Uniform Heatmap

| Grid Size | SciChart.js | HighCharts | Plotly.js | eCharts | LCJS v8 |
|---|---|---|---|---|---|
| 100 | 235.67 | 16.39 | 122.39 | 19.24 | 228.79 |
| 200 | 235.76 | 4.85 | 72.34 | 5.18 | 231.02 |
| 500 | 143.55 | 0.82 | 17.40 | 0.67 | 93.16 |
| 1K | 39.97 | Skip | 4.75 | Skip | 27.75 |
| 2K | 9.48 | Skip | 1.16 | Skip | 6.87 |
| 4K | 2.32 | Skip | Hang | Skip | 2.94 |
| 8K | 0.48 | Skip | Skip | Skip | 0.64 |
| 16K | Skip | Skip | Skip | Skip | Skip |

> ChartGPU, Chart.js, and uPlot do not support heatmaps.

## 3D Point Cloud

| Points | SciChart.js | Plotly.js | eCharts | LCJS v8 |
|---|---|---|---|---|
| 100 | 228.32 | 83.98 | 229.36 | 225.67 |
| 1K | 230.18 | 51.24 | 239.69 | 236.47 |
| 10K | 229.52 | 12.59 | 82.37 | 236.65 |
| 100K | 121.34 | 1.41 | 8.60 | 81.76 |
| 1M | 15.09 | Error | 1.25 | 7.28 |
| 2M | 7.52 | Skip | 0.67 | 3.84 |
| 4M | 3.51 | Skip | Skip | 1.76 |

> HighCharts, Chart.js, ChartGPU, and uPlot do not support 3D charts.

## 3D Surface Mesh

| Grid Size | SciChart.js | Plotly.js | eCharts | LCJS v8 |
|---|---|---|---|---|
| 100 | 229.21 | 26.71 | 40.95 | 224.76 |
| 200 | 231.35 | 24.41 | 15.02 | 193.44 |
| 500 | 95.62 | 5.07 | 2.40 | 66.45 |
| 1K | 27.69 | 1.34 | 0.48 | 19.06 |
| 2K | 5.96 | Hang | Skip | 4.49 |
| 4K | 1.28 | Skip | Skip | 1.76 |
| 8K | Hang | Skip | Skip | Hang |

> HighCharts, Chart.js, ChartGPU, and uPlot do not support 3D charts.

---

## Key Takeaways

- **ChartGPU ranks 3rd overall** across 102 configurations, behind SciChart.js and LCJS v8
- **ChartGPU excels at small data sizes** (1K-10K points), winning 6 configurations -- particularly in sorted point series, candlestick, and FIFO streaming
- **ChartGPU degrades faster at scale** than SciChart.js and LCJS v8 in scatter/line tests; at 1M+ points it falls to single-digit FPS
- **ChartGPU is one of few libraries that completes** candlestick and column tests at 10M points, though at low FPS
- **GPU-first architectures** (SciChart.js, LCJS v8, ChartGPU) are the only libraries that remain usable at extreme scale
- CPU/Canvas/SVG libraries (Chart.js, eCharts, uPlot, HighCharts without Boost) degrade rapidly beyond 50K points
