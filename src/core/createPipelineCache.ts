/**
 * Public entrypoint for CGPU-PIPELINE-CACHE.
 *
 * This module re-exports the core PipelineCache types and factory function,
 * plus convenience helpers for stats and disposal.
 */

export type { PipelineCache, PipelineCacheStats } from './PipelineCache';
export { createPipelineCache } from './PipelineCache';

import type { PipelineCache, PipelineCacheStats } from './PipelineCache';

/**
 * Gets statistics for a pipeline cache.
 * 
 * @param cache - The pipeline cache to query
 * @returns Cache statistics including hit/miss counts and pipeline count
 */
export function getPipelineCacheStats(cache: PipelineCache): PipelineCacheStats {
  return cache.getStats();
}

/**
 * Destroys a pipeline cache and releases its resources.
 * 
 * @param cache - The pipeline cache to destroy
 */
export function destroyPipelineCache(cache: PipelineCache): void {
  cache.clear();
}
