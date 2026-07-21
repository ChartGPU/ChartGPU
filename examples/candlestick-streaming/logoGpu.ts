/**
 * Header wordmark rendered via pure WebGPU (texture sample + alpha blit).
 *
 * Why texture (not procedural letterforms): the official mark is a custom
 * two-tone wordmark. Reverse-engineering bold italic glyphs in WGSL would be
 * approximate and worse at ~22px. Uploading the brand PNG and drawing it with
 * WebGPU is exact and still GPU-native. Falls back to <img> if WebGPU fails.
 */
import logoUrl from '../../docs/assets/chartgpu.png';

const BLIT_WGSL = /* wgsl */ `
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  // Fullscreen triangle covering clip space
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  let xy = p[vi];
  var o : VsOut;
  o.pos = vec4f(xy, 0.0, 1.0);
  // Map clip → uv (y flipped for image-space)
  o.uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
  return o;
}

@group(0) @binding(0) var logoSamp : sampler;
@group(0) @binding(1) var logoTex : texture_2d<f32>;

@fragment
fn fs(in : VsOut) -> @location(0) vec4f {
  let c = textureSample(logoTex, logoSamp, in.uv);
  // Premultiply for correct alpha over dark header
  return vec4f(c.rgb * c.a, c.a);
}
`;

export type LogoGpuHandle = {
  readonly canvas: HTMLCanvasElement;
  dispose: () => void;
};

/**
 * Mount a crisp DPR-aware WebGPU wordmark into `host`.
 * On failure, inserts a static <img> fallback and returns null.
 */
export async function mountLogoGpu(host: HTMLElement): Promise<LogoGpuHandle | null> {
  const cssH = 22;
  // Intrinsic aspect ~809/247 ≈ 3.275
  const aspect = 809 / 247;
  const cssW = Math.round(cssH * aspect);

  const canvas = document.createElement('canvas');
  canvas.className = 'ticker-logo';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'ChartGPU');
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  host.replaceChildren(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));

  const fallback = (): null => {
    const img = document.createElement('img');
    img.className = 'ticker-logo';
    img.src = logoUrl;
    img.alt = 'ChartGPU';
    img.width = cssW;
    img.height = cssH;
    img.decoding = 'async';
    host.replaceChildren(img);
    return null;
  };

  if (!navigator.gpu) return fallback();

  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch {
    return fallback();
  }
  if (!adapter) return fallback();

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch {
    return fallback();
  }

  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    return fallback();
  }

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  });

  // Decode brand PNG
  let bitmap: ImageBitmap;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) throw new Error(`logo fetch ${res.status}`);
    const blob = await res.blob();
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  } catch {
    device.destroy();
    return fallback();
  }

  const texture = device.createTexture({
    label: 'chartgpu-logo',
    size: [bitmap.width, bitmap.height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap },
    { texture },
    [bitmap.width, bitmap.height]
  );
  bitmap.close();

  const sampler = device.createSampler({
    label: 'chartgpu-logo-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
  });

  const module = device.createShaderModule({ label: 'chartgpu-logo-blit', code: BLIT_WGSL });
  const pipeline = device.createRenderPipeline({
    label: 'chartgpu-logo-pipeline',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: texture.createView() },
    ],
  });

  let disposed = false;

  const draw = (): void => {
    if (disposed) return;
    const encoder = device.createCommandEncoder({ label: 'chartgpu-logo-encode' });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  draw();

  // Redraw on DPR / size changes (rare for header, but keeps it crisp)
  const ro = new ResizeObserver(() => {
    if (disposed) return;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * nextDpr));
    const h = Math.max(1, Math.round(cssH * nextDpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    context.configure({ device, format, alphaMode: 'premultiplied' });
    draw();
  });
  ro.observe(canvas);

  const onLost = (): void => {
    dispose();
    fallback();
  };
  device.addEventListener('uncapturederror', onLost);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    ro.disconnect();
    device.removeEventListener('uncapturederror', onLost);
    texture.destroy();
    device.destroy();
  };

  return { canvas, dispose };
}
