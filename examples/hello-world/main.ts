import { GPUContext } from '../../src/index';
import lineWgsl from '../../src/shaders/line.wgsl?raw';

/**
 * Hello World example - Animated clear color
 * 
 * This example demonstrates continuous rendering by animating the clear color
 * through the full color spectrum, cycling through all hues over time.
 */

/**
 * Converts HSL color space to RGB.
 * 
 * @param h - Hue in degrees (0-360)
 * @param s - Saturation as percentage (0-100)
 * @param l - Lightness as percentage (0-100)
 * @returns RGB values normalized to 0.0-1.0 range
 */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // Normalize hue to 0-360 range
  h = ((h % 360) + 360) % 360;
  
  // Convert saturation and lightness from 0-100 to 0-1
  s = s / 100;
  l = l / 100;
  
  // HSL to RGB conversion
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  
  let r = 0, g = 0, b = 0;
  
  if (h >= 0 && h < 60) {
    r = c; g = x; b = 0;
  } else if (h >= 60 && h < 120) {
    r = x; g = c; b = 0;
  } else if (h >= 120 && h < 180) {
    r = 0; g = c; b = x;
  } else if (h >= 180 && h < 240) {
    r = 0; g = x; b = c;
  } else if (h >= 240 && h < 300) {
    r = x; g = 0; b = c;
  } else if (h >= 300 && h < 360) {
    r = c; g = 0; b = x;
  }
  
  return [r + m, g + m, b + m];
}

async function main() {
  // Get canvas element
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  if (!canvas) {
    throw new Error('Canvas element not found');
  }

  let context: GPUContext | null = null;
  let animationFrameId: number | null = null;

  try {
    // Create and initialize GPU context
    context = await GPUContext.create(canvas);
    const device = context.device;
    if (!device) {
      throw new Error('WebGPU device not available after GPUContext initialization');
    }

    // Example-only smoke check: compile the line shader at runtime.
    const shaderModule = device.createShaderModule({ code: lineWgsl, label: 'line.wgsl' });
    const getCompilationInfo = shaderModule.getCompilationInfo?.bind(shaderModule);
    if (getCompilationInfo) {
      const info = await getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length > 0) {
        const formatted = errors
          .map((m) => `${m.lineNum ?? 0}:${m.linePos ?? 0} ${m.message}`)
          .join('\n');
        throw new Error(`line.wgsl compilation failed:\n${formatted}`);
      }
    }

    // Track start time for animation
    const startTime = performance.now();
    
    // Animation parameters: complete color cycle every 4 seconds
    const cycleDuration = 4000; // milliseconds
    
    // Color parameters: full saturation, medium lightness for vibrant colors
    const saturation = 100;
    const lightness = 50;
    const alpha = 1.0;

    // Render loop
    function render() {
      if (!context) return;
      
      // Calculate elapsed time and animated hue
      const elapsedTime = performance.now() - startTime;
      const hue = (elapsedTime / cycleDuration) * 360 % 360;
      
      // Convert HSL to RGB
      const [r, g, b] = hslToRgb(hue, saturation, lightness);
      
      // Clear screen with animated color
      context.clearScreen(r, g, b, alpha);
      
      // Continue rendering
      animationFrameId = requestAnimationFrame(render);
    }

    // Start render loop
    render();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      if (context) {
        context.destroy();
      }
    });
  } catch (error) {
    console.error('Failed to initialize WebGPU:', error);
    if (error instanceof Error) {
      alert(`WebGPU Error: ${error.message}`);
    } else {
      alert('Failed to initialize WebGPU. Please check browser compatibility.');
    }
    // Clean up on error
    if (context) {
      context.destroy();
    }
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
