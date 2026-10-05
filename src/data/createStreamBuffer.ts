import { trackBuffer, untrackBuffer } from '../core/gpu/bufferAllocationTracker';

export interface StreamBuffer {
  /**
   * Writes a new vertex payload into the streaming buffer.
   *
   * Notes:
   * - `data` is interpreted as interleaved `vec2<f32>` vertices: `[x0, y0, x1, y1, ...]`.
   * - Uses double buffering (alternates GPU buffers each write) to avoid writing into the same
   *   buffer the GPU might still be reading from the prior frame.
   * - Uses a per-buffer CPU mirror (Uint32 bit patterns) to compute partial updates.
   */
  write(data: Float32Array): void;
  /** Returns the GPUBuffer that contains the most recently written data. */
  getBuffer(): GPUBuffer;
  /** Returns the vertex count for the most recently written data. */
  getVertexCount(): number;
  /** Destroys GPU resources (best-effort). Safe to call multiple times. */
  dispose(): void;
}

const align4 = (n: number): number => (n + 3) & ~3;

// Small payloads are cheaper to just full-write (avoid diff overhead).
const SMALL_FULL_WRITE_MAX_BYTES = 1024;

// Heuristic guard against pathological alternating-word diffs which would produce many tiny ranges.
// If exceeded, we do a single full-range write for the used bytes.
const MAX_DIFF_RANGES_BEFORE_FULL_WRITE = 128;
const MAX_CHANGED_WORDS_BEFORE_FULL_WRITE = 16_384;

const toU32View = (data: Float32Array): Uint32Array => {
  if ((data.byteOffset & 3) !== 0) {
    // This should never happen for Float32Array, but keep it explicit for correctness.
    throw new Error('createStreamBuffer.write: data.byteOffset must be 4-byte aligned.');
  }
  return new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
};

export function createStreamBuffer(device: GPUDevice, maxSize: number): StreamBuffer {
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    throw new Error(
      `createStreamBuffer(maxSize): maxSize (bytes) must be a positive number. Received: ${String(maxSize)}`
    );
  }

  const clamped = Math.max(4, Math.floor(maxSize));
  const capacityBytes = align4(clamped);

  const limit = device.limits.maxBufferSize;
  if (capacityBytes > limit) {
    throw new Error(
      `createStreamBuffer(maxSize): requested size ${capacityBytes} bytes exceeds device.limits.maxBufferSize (${limit}).`
    );
  }

  const capacityWords = capacityBytes >>> 2;

  const createSlot = (label: string): { readonly buffer: GPUBuffer; readonly mirror: Uint32Array } => {
    const buffer = device.createBuffer({
      label,
      size: capacityBytes,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    trackBuffer(device, buffer, capacityBytes);
    return { buffer, mirror: new Uint32Array(capacityWords) };
  };

  const slots = [createSlot('streamBuffer/a'), createSlot('streamBuffer/b')] as const;

  let disposed = false;
  let currentIndex = 0; // getBuffer() returns slots[currentIndex]
  let vertexCount = 0;

  const assertNotDisposed = (): void => {
    if (disposed) throw new Error('createStreamBuffer: StreamBuffer is disposed.');
  };

  const writeFull = (slotIndex: number, newWords: Uint32Array, usedWords: number): void => {
    const slot = slots[slotIndex];
    const mirror = slot.mirror;

    if (usedWords < 0 || usedWords > newWords.length) {
      throw new Error('createStreamBuffer.write: internal error (invalid usedWords).');
    }
    if (usedWords === 0) return;

    const usedBytes = usedWords << 2;
    device.queue.writeBuffer(slot.buffer, 0, newWords.buffer, newWords.byteOffset, usedBytes);
    mirror.set(newWords.subarray(0, usedWords), 0);
  };

  const writeRangesByDiff = (slotIndex: number, newWords: Uint32Array, usedWords: number): void => {
    const slot = slots[slotIndex];
    const mirror = slot.mirror;

    // Guard against programming errors.
    if (usedWords < 0 || usedWords > newWords.length) {
      throw new Error('createStreamBuffer.write: internal error (invalid usedWords).');
    }

    // Small-buffer fast path: diffing overhead dominates.
    const usedBytes = usedWords << 2;
    if (usedBytes > 0 && usedBytes <= SMALL_FULL_WRITE_MAX_BYTES) {
      writeFull(slotIndex, newWords, usedWords);
      return;
    }

    // First pass: collect ranges and decide whether we should fall back to a full write.
    const ranges: Array<[start: number, end: number]> = [];
    let rangeCount = 0;
    let changedWords = 0;

    let i = 0;
    while (i < usedWords) {
      // Find first differing word.
      while (i < usedWords && mirror[i] === newWords[i]) i++;
      if (i >= usedWords) break;

      const start = i;
      i++;
      // Extend to contiguous run of differing words.
      while (i < usedWords && mirror[i] !== newWords[i]) i++;
      const end = i;

      ranges.push([start, end]);
      rangeCount++;
      changedWords += end - start;

      // Pathological case guard: alternating changes can create many tiny ranges.
      if (rangeCount > MAX_DIFF_RANGES_BEFORE_FULL_WRITE || changedWords > MAX_CHANGED_WORDS_BEFORE_FULL_WRITE) {
        writeFull(slotIndex, newWords, usedWords);
        return;
      }
    }

    // Second pass: apply range writes.
    for (let r = 0; r < ranges.length; r++) {
      const [start, end] = ranges[r];
      const byteOffset = start << 2;
      const byteSize = (end - start) << 2;

      // WebGPU requires offsets/sizes to be multiples of 4 bytes (satisfied by word addressing).
      device.queue.writeBuffer(slot.buffer, byteOffset, newWords.buffer, newWords.byteOffset + byteOffset, byteSize);
      mirror.set(newWords.subarray(start, end), start);
    }
  };

  const write: StreamBuffer['write'] = (data) => {
    assertNotDisposed();

    if (data.length & 1) {
      throw new Error('createStreamBuffer.write: data length must be even (vec2<f32> vertices).');
    }

    const bytes = data.byteLength;
    if (bytes > capacityBytes) {
      throw new Error(
        `createStreamBuffer.write: data.byteLength (${bytes}) exceeds capacity (${capacityBytes}). Increase maxSize.`
      );
    }

    const nextVertexCount = data.length >>> 1;
    if (bytes === 0) {
      // Avoid swapping buffers for empty payloads.
      vertexCount = nextVertexCount;
      return;
    }

    const words = toU32View(data);
    const nextIndex = 1 - currentIndex;

    // Only swap after the write succeeds so we never expose a partially-updated "current" buffer.
    writeRangesByDiff(nextIndex, words, words.length);
    currentIndex = nextIndex;
    vertexCount = nextVertexCount;
  };

  const getBuffer: StreamBuffer['getBuffer'] = () => {
    assertNotDisposed();
    return slots[currentIndex].buffer;
  };

  const getVertexCount: StreamBuffer['getVertexCount'] = () => {
    assertNotDisposed();
    return vertexCount;
  };

  const dispose: StreamBuffer['dispose'] = () => {
    if (disposed) return;
    disposed = true;
    vertexCount = 0;

    for (const slot of slots) {
      untrackBuffer(device, slot.buffer);
      try {
        slot.buffer.destroy();
      } catch {
        // best-effort
      }
    }
  };

  return { write, getBuffer, getVertexCount, dispose };
}
