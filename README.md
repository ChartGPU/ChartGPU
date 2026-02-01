<p align="center">
  <img src="docs/assets/chart-gpu.jpg" alt="ChartGPU" width="400">
</p>

<p align="center">
  High-performance charts powered by WebGPU
</p>


<p align="center">
  <a href="https://github.com/hunterg325/ChartGPU/blob/main/docs/GETTING_STARTED.md">Documentation</a> |
  <a href="https://chartgpu.github.io/ChartGPU/">Live Demo</a> |
  <a href="https://github.com/hunterg325/ChartGPU/tree/main/examples">Examples</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/chartgpu" style="text-decoration: none;">
    <img src="https://img.shields.io/npm/v/chartgpu" alt="npm">
  </a>
  <a href="https://github.com/hunterg325/ChartGPU/blob/main/LICENSE" style="text-decoration: none;">
    <img src="https://img.shields.io/npm/l/chartgpu" alt="license">
  </a>
  <a href="https://chartgpu.github.io/ChartGPU/" style="text-decoration: none;">
    <img src="https://img.shields.io/badge/demo-live-brightgreen" alt="Live Demo">
  </a>
</p>

ChartGPU is a TypeScript charting library built on WebGPU for smooth, interactive rendering—especially when you have lots of data.

## Highlights

- 🚀 WebGPU-accelerated rendering for high FPS with large datasets
- ⚡ Worker-based rendering with OffscreenCanvas (optional - for maximum performance)
- 📈 Multiple series types: line, area, bar, scatter, pie, candlestick
- 🌡️ Scatter density/heatmap mode (`mode: 'density'`) for large point clouds — see [`docs/api/options.md#scatterseriesconfig`](docs/api/options.md#scatterseriesconfig) and [`examples/scatter-density-1m/`](examples/scatter-density-1m/)
- 🧭 Built-in interaction: hover highlight, tooltip, crosshair
- 🔁 Streaming updates via `appendData(...)` (cartesian series)
- 🔍 X-axis zoom (inside gestures + optional slider UI)
- 🎛️ Theme presets (`'dark' | 'light'`) and custom theme support

## Architecture

At a high level, `ChartGPU.create(...)` owns the canvas + WebGPU lifecycle, and delegates render orchestration (layout/scales/data upload/render passes + internal overlays) to the render coordinator. For deeper internal notes, see [`docs/api/INTERNALS.md`](https://github.com/hunterg325/ChartGPU/blob/main/docs/api/INTERNALS.md) (especially “Render coordinator”).

```mermaid
flowchart TB
  UserApp["Consumer app"] --> PublicAPI["src/index.ts (Public API exports)"]

  PublicAPI --> ChartCreate["ChartGPU.create(container, options)"]
  PublicAPI --> SyncAPI["connectCharts(charts)"]

  subgraph MainThread["🔷 MAIN THREAD RENDERING (Default)"]
    subgraph ChartInstance["Chart instance (src/ChartGPU.ts)"]
      ChartCreate --> SupportCheck["checkWebGPUSupport()"]
      ChartCreate --> Canvas["Create canvas + mount into container"]
      ChartCreate --> Options["resolveOptionsForChart(options)<br/>(adds bottom reserve when slider present)"]
      ChartCreate --> GPUInit["GPUContext.create(canvas)"]
      ChartCreate --> Coordinator["createRenderCoordinator(gpuContext, resolvedOptions)"]

      ChartCreate --> InstanceAPI["ChartGPUInstance APIs"]
      InstanceAPI --> RequestRender["requestAnimationFrame (coalesced)"]
      RequestRender --> Coordinator

      InstanceAPI --> SetOption["setOption(...)"]
      InstanceAPI --> AppendData["appendData(...)"]
      InstanceAPI --> Resize["resize()"]

      subgraph PublicEvents["Public events + hit-testing (ChartGPU.ts)"]
        Canvas --> PointerHandlers["Pointer listeners"]
        PointerHandlers --> PublicHitTest["findNearestPoint() / findPieSlice()"]
        PointerHandlers --> EmitEvents["emit('click'/'mouseover'/'mouseout')"]
      end

      DataZoomSlider["dataZoom slider (absolute-positioned DOM overlay)<br/>chart reserves bottom space for x-axis"] --> Coordinator
    end

    subgraph WebGPUCore["WebGPU core (src/core/GPUContext.ts)"]
      GPUInit --> AdapterDevice["navigator.gpu.requestAdapter/device"]
      GPUInit --> CanvasConfig["canvasContext.configure(format)"]
    end

    subgraph RenderCoordinatorLayer["Render coordinator (src/core/createRenderCoordinator.ts)"]
      Coordinator --> Layout["GridArea layout"]
      Coordinator --> Scales["xScale/yScale (clip space for render)"]
      Coordinator --> DataUpload["createDataStore(device) (GPU buffer upload/caching)"]
      Coordinator --> DensityCompute["Encode + submit compute pass<br/>(scatter density mode)"]
      DensityCompute --> RenderPass["Encode + submit render pass"]

      subgraph InternalOverlays["Internal interaction overlays (coordinator)"]
        Coordinator --> Events["createEventManager(canvas, gridArea)"]
        Events --> OverlayHitTest["hover/tooltip hit-testing"]
        Events --> InteractionX["interaction-x state (crosshair)"]
        Coordinator --> OverlaysDOM["DOM overlays: legend / tooltip / text labels / annotation labels"]
      end
    end
  end

  subgraph WorkerThread["⚡ WORKER THREAD RENDERING (Optional - src/worker/)"]
    subgraph WorkerProxyAPI["Worker Proxy API (src/worker/)"]
      CreateInWorker["createChartInWorker(container, options)<br/>ChartGPU.createInWorker(container, options)"]
      CreateInWorker --> ProxyInit["ChartGPUWorkerProxy initialization"]
      ProxyInit --> CanvasTransfer["canvas.transferControlToOffscreen()"]
      ProxyInit --> WorkerCreate["Create Worker (built-in or custom)"]
    end

    subgraph MainThreadProxy["Main Thread: ChartGPUWorkerProxy (src/worker/ChartGPUWorkerProxy.ts)"]
      ProxyInit --> ProxyInstance["ChartGPUWorkerProxy implements ChartGPUInstance"]
      ProxyInstance --> ProxyState["Local state cache<br/>(options, interactionX, zoomRange)"]
      ProxyInstance --> EventForwarding["Event forwarding to worker<br/>(pointerdown/move/up/leave/wheel)"]
      ProxyInstance --> ProxyOverlays["DOM overlay management<br/>(tooltip, legend, text, annotation, slider)"]
      ProxyInstance --> ResizeMonitoring["ResizeObserver + DPR monitoring<br/>(RAF batched)"]
      
      EventForwarding --> ForwardPointer["computePointerEventData()<br/>(calculates grid coords on main thread)"]
      ResizeMonitoring --> ResizeRAF["RAF-batched resize messages"]
    end

    subgraph WorkerInbound["Main → Worker (src/worker/protocol.ts)"]
      CanvasTransfer -->|"postMessage: init"| WorkerInit["InitMessage + OffscreenCanvas transfer<br/>(includes devicePixelRatio from main thread)"]
      ProxyInstance -->|"postMessage: setOption"| WorkerSetOpt["SetOptionMessage"]
      ProxyInstance -->|"postMessage: appendData"| WorkerAppend["AppendDataMessage + ArrayBuffer transfer"]
      ResizeRAF -->|"postMessage: resize"| WorkerResize["ResizeMessage<br/>(includes devicePixelRatio)"]
      ForwardPointer -->|"postMessage: forwardPointerEvent"| WorkerPointer["ForwardPointerEventMessage<br/>(includes pre-computed grid coordinates)"]
      ProxyInstance -->|"postMessage: setZoomRange"| WorkerZoom["SetZoomRangeMessage"]
      ProxyInstance -->|"postMessage: setInteractionX"| WorkerInteractionX["SetInteractionXMessage"]
      ProxyInstance -->|"postMessage: dispose"| WorkerDispose["DisposeMessage"]
    end

    subgraph WorkerCore["Worker Thread: ChartGPUWorkerController (src/worker/ChartGPUWorkerController.ts)"]
      WorkerInit --> WGPUInit["GPUContext.create(offscreenCanvas)"]
      WGPUInit --> WOptions["resolveOptionsForChart(msg.options)<br/>(adds bottom reserve when slider present)"]
      WOptions --> WCoordinator["createRenderCoordinator(gpuContext, resolvedOptions)<br/>computeInteractionScalesGridCssPx<br/>(supports OffscreenCanvas)"]
      WCoordinator --> WRenderLoop["MessageChannel render loop"]
      WorkerSetOpt --> WOptions
      WorkerAppend --> WDataStore["Worker DataStore (GPU buffer upload)"]
      WorkerResize --> WCoordinator
      WorkerPointer --> WHitTest["Worker hit-testing<br/>(uses interactionScales with grid coords)<br/>findNearestPoint/findPointsAtX"]
      WorkerZoom --> WCoordinator
      WorkerInteractionX --> WCoordinator
      WorkerDispose --> WCleanup["Resource cleanup"]
    end

    subgraph WorkerOutbound["Worker → Main (postMessage)"]
      WGPUInit -->|"ready"| ReadyMsg["ReadyMessage + GPU capabilities + PerformanceCapabilities"]
      WRenderLoop -->|"rendered"| RenderedMsg["RenderedMessage (frame stats)"]
      WRenderLoop -->|"performanceUpdate"| PerfMsg["PerformanceUpdateMessage (FPS, frame time, memory)"]
      WHitTest -->|"tooltipUpdate"| TooltipMsg["TooltipUpdateMessage<br/>(complete tooltip content + position)"]
      WCoordinator -->|"legendUpdate"| LegendMsg["LegendUpdateMessage"]
      WCoordinator -->|"axisLabelsUpdate"| AxisMsg["AxisLabelsUpdateMessage"]
      WCoordinator -->|"annotationsUpdate"| AnnotationsMsg["AnnotationsUpdateMessage<br/>(annotation label positions + styles)"]
      WHitTest -->|"hoverChange"| HoverMsg["HoverChangeMessage"]
      WHitTest -->|"click"| ClickMsg["ClickMessage"]
      WHitTest -->|"crosshairMove"| CrosshairMsg["CrosshairMoveMessage"]
      WCoordinator -->|"zoomChange"| ZoomMsg["ZoomChangeMessage"]
      WGPUInit -->|"deviceLost"| DeviceLostMsg["DeviceLostMessage"]
      WCleanup -->|"disposed"| DisposedMsg["DisposedMessage"]
      WCoordinator -->|"error"| ErrorMsg["ErrorMessage"]
    end

    subgraph MainThreadDOM["Main Thread: DOM Overlay Rendering (ChartGPUWorkerProxy)"]
      ReadyMsg --> ProxyOverlays
      ReadyMsg --> PerfCache["Cache PerformanceCapabilities + set isInitialized"]
      PerfMsg --> PerfUpdate["Cache PerformanceMetrics + notify callbacks"]
      TooltipMsg --> DOMTooltip["RAF-batched tooltip.show(x, y, content)<br/>(receives complete tooltip data from worker)"]
      LegendMsg --> DOMLegend["RAF-batched legend.update(items, theme)"]
      AxisMsg --> DOMAxis["RAF-batched textOverlay.addLabel(...)<br/>(auto-handles container overflow)"]
      AnnotationsMsg --> DOMAnnotations["RAF-batched annotationTextOverlay.addLabel(...)<br/>(dedicated annotation overlay)"]
      HoverMsg --> DOMHover["Re-emit 'mouseover'/'mouseout' events"]
      ClickMsg --> DOMClick["Re-emit 'click' event"]
      CrosshairMsg --> DOMCrosshair["Update cached interactionX + emit"]
      ZoomMsg --> DOMZoom["Update cached zoomRange + zoomState"]
      
      ProxyOverlays --> DOMTooltip
      ProxyOverlays --> DOMLegend
      ProxyOverlays --> DOMAxis
      ProxyOverlays --> DOMAnnotations
    end
  end

  subgraph Renderers["GPU renderers (src/renderers/*)"]
    RenderPass --> GridR["Grid"]
    RenderPass --> AreaR["Area"]
    RenderPass --> BarR["Bar"]
    RenderPass --> ScatterR["Scatter"]
    RenderPass --> ScatterDensityR["Scatter density/heatmap"]
    RenderPass --> LineR["Line"]
    RenderPass --> PieR["Pie"]
    RenderPass --> CandlestickR["Candlestick"]
    RenderPass --> ReferenceLineR["Reference lines"]
    RenderPass --> AnnotationMarkerR["Annotation markers"]
    RenderPass --> CrosshairR["Crosshair overlay"]
    RenderPass --> HighlightR["Hover highlight overlay"]
    RenderPass --> AxisR["Axes/ticks"]

    WRenderLoop --> GridR
  end

  subgraph Shaders["WGSL shaders (src/shaders/*)"]
    GridR --> gridWGSL["grid.wgsl"]
    AreaR --> areaWGSL["area.wgsl"]
    BarR --> barWGSL["bar.wgsl"]
    ScatterR --> scatterWGSL["scatter.wgsl"]
    ScatterDensityR --> scatterDensityBinningWGSL["scatterDensityBinning.wgsl"]
    ScatterDensityR --> scatterDensityColormapWGSL["scatterDensityColormap.wgsl"]
    LineR --> lineWGSL["line.wgsl"]
    PieR --> pieWGSL["pie.wgsl"]
    CandlestickR --> candlestickWGSL["candlestick.wgsl"]
    ReferenceLineR --> referenceLineWGSL["referenceLine.wgsl"]
    AnnotationMarkerR --> annotationMarkerWGSL["annotationMarker.wgsl"]
    CrosshairR --> crosshairWGSL["crosshair.wgsl"]
    HighlightR --> highlightWGSL["highlight.wgsl"]
  end

  subgraph ChartSync["Chart sync (src/interaction/createChartSync.ts)"]
    SyncAPI --> ListenX["listen: 'crosshairMove'"]
    SyncAPI --> DriveX["setCrosshairX(...) on peers"]
  end

  InteractionX --> ListenX
  DriveX --> InstanceAPI
  CrosshairMsg --> ListenX
```

## Demo

![ChartGPU demo](https://raw.githubusercontent.com/hunterg325/ChartGPU/main/docs/assets/chart-gpu-demo.gif)

### Candlestick Charts

Financial OHLC (open-high-low-close) candlestick rendering with classic/hollow style toggle and color customization. The live streaming demo renders **5 million candlesticks at over 100 FPS** with real-time updates.

![Candlestick chart example](docs/assets/candle-stick-example.png)

### Scatter Density (1M points)

GPU-binned density/heatmap mode for scatter plots (`mode: 'density'`) to reveal structure in overplotted point clouds. See [`docs/api/options.md#scatterseriesconfig`](docs/api/options.md#scatterseriesconfig) and the demo in [`examples/scatter-density-1m/`](examples/scatter-density-1m/).

![Scatter density chart example (1M points)](docs/assets/scatter-plot-density-chart-1million-points-example.png)

### 10M points (benchmark)

10,000,000 points rendered at ~120 FPS (benchmark mode).

![10 million point benchmark at 120 FPS](docs/assets/10-million-point-benchmark-120FPS.png)

## Quick start

```ts
import { ChartGPU } from 'chartgpu';
const container = document.getElementById('chart')!;
await ChartGPU.create(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

### Worker-based rendering (optional)

For maximum performance with large datasets, use worker-based rendering to keep the main thread responsive:

```ts
import { ChartGPU } from 'chartgpu';
const container = document.getElementById('chart')!;
// Identical API, but rendering happens in a Web Worker
await ChartGPU.createInWorker(container, {
  series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
});
```

**When to use workers:**
- Large datasets (>10K points) with frequent updates
- Real-time streaming data
- Complex multi-series charts
- Mobile/low-power devices

See [Worker API Documentation](https://github.com/hunterg325/ChartGPU/blob/main/docs/api/worker.md) for details.

## Installation

`npm install chartgpu`

## React Integration

React bindings are available via [`chartgpu-react`](https://github.com/ChartGPU/chartgpu-react):

```bash
npm install chartgpu-react
```

```tsx
import { ChartGPUChart } from 'chartgpu-react';

function MyChart() {
  return (
    <ChartGPUChart
      options={{
        series: [{ type: 'line', data: [[0, 1], [1, 3], [2, 2]] }],
      }}
    />
  );
}
```

See the [chartgpu-react repository](https://github.com/ChartGPU/chartgpu-react) for full documentation and examples.

## Browser support (WebGPU required)

- Chrome 113+ or Edge 113+ (WebGPU enabled by default)
- Safari 18+ (WebGPU enabled by default)
- Firefox: not supported (WebGPU support in development)

## Documentation

- Full documentation: [Getting Started](https://github.com/hunterg325/ChartGPU/blob/main/docs/GETTING_STARTED.md)
- API reference: [`docs/api/README.md`](https://github.com/hunterg325/ChartGPU/blob/main/docs/api/README.md)

## Examples

- Browse examples: [`examples/`](https://github.com/hunterg325/ChartGPU/tree/main/examples)
- Run locally:
  - `npm install`
  - `npm run dev` (opens `http://localhost:5176/examples/`)

## Contributing

See [`CONTRIBUTING.md`](https://github.com/hunterg325/ChartGPU/blob/main/CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](https://github.com/hunterg325/ChartGPU/blob/main/LICENSE).
