## Description

<!-- Provide a brief description of the changes in this PR -->

## Type of Change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Code refactoring
- [ ] Other (please describe):

## Related Issues

<!-- Link to any related issues, e.g., "Fixes #123" or "Closes #456" -->

## Testing

<!-- Describe the testing you've performed -->

- [ ] Tested in Chrome/Edge 113+
- [ ] Tested in Safari 18+
- [ ] Added or updated examples in `examples/` (when behavior changes)
- [ ] Verified WebGPU validation is clean (no console warnings)
- [ ] Tested on different GPUs/platforms (if applicable)

## Documentation

<!-- Documentation updates for public-facing changes -->

- [ ] Updated `docs/` when public API or behavior changes
- [ ] Updated `CHANGELOG.md` when public behavior changes
- [ ] Updated README (if relevant)
- [ ] Added code comments for complex logic

## WebGPU Correctness

<!-- Important checks for WebGPU code -->

- [ ] All `queue.writeBuffer()` calls use 4-byte aligned offsets and sizes
- [ ] Uniform buffer sizes are properly aligned (typically 16 bytes)
- [ ] Dynamic uniform buffer offsets respect `minUniformBufferOffsetAlignment` (if applicable)
- [ ] Render pipeline target formats match render pass attachment formats
- [ ] GPU resources are properly cleaned up (`buffer.destroy()`, `device.destroy()`, etc.)

## Browser Testing Checklist

<!-- Check the browsers you've tested in -->

- [ ] Chrome 113+
- [ ] Edge 113+
- [ ] Safari 18+
- [ ] Other (specify): 

## Screenshots / Videos

<!-- If applicable, add screenshots or videos demonstrating the changes -->

## Performance Impact

<!-- If this change affects performance, describe the impact and any measurements -->

## Additional Notes

<!-- Any additional information, context, or concerns -->

---

**For Reviewers:**

- Does this PR follow the functional-first architecture patterns?
- Are WebGPU resources properly managed?
- Are examples updated and working?
- Is documentation complete and accurate?
