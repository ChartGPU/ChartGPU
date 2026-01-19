# Documentation Command

Use this command to create, update, or maintain project documentation. Always delegate to the appropriate subagent based on documentation type.

## Quick Decision Guide

- **Internal Documentation** → `/documentation-engineer`
  - Architecture guides, tutorials, README files
  - Internal guides, contributing docs, development docs
  - Technical documentation, guides, how-tos
  
- **External/Public API Documentation** → `/api-documenter`
  - Public API documentation (exports from `src/index.ts`)
  - OpenAPI/Swagger specifications
  - Interactive API portals
  - SDK documentation

## Project Documentation Standards

### Core Principles

1. **No code blocks in documentation** - Link to source files instead
2. **Link to source files** - Use relative paths like `[GPUContext](src/core/GPUContext.ts)`
3. **Essential information only** - Avoid duplicating what's in source code

### What to Include

- Function/method signatures
- Critical parameters (only if not obvious)
- Return types
- Key error conditions (brief)
- Links to source files

### What to Avoid

- Code block examples (link to `examples/` instead)
- Verbose error message listings
- Redundant descriptions
- Long property/method lists (link to source)
- Generic best practices

## Delegation Process

### For Internal Documentation

Use `/documentation-engineer` for:
- Architecture documentation (`docs/` directory)
- Getting started guides
- Tutorials and how-tos
- Contributing guidelines
- Internal technical documentation
- README files
- Development guides

**Delegation template:**
```
/documentation-engineer [task description]
- Context: [relevant files, current docs]
- Type: [architecture guide / tutorial / README / etc.]
- Requirements: [specific needs, target audience]
- Expected outcome: [what the documentation should achieve]
```

### For Public API Documentation

Use `/api-documenter` for:
- Public API reference (`src/index.ts` exports)
- API method documentation
- Type definitions documentation
- Interactive API documentation
- OpenAPI specifications
- Public-facing developer documentation

**Delegation template:**
```
/api-documenter [task description]
- Context: [API files, current API docs]
- Scope: [specific API surface to document]
- Requirements: [examples needed, interactive features, etc.]
- Expected outcome: [comprehensive API documentation]
```

## Examples

### Example 1: Internal Architecture Guide

```
User: "Document the GPUContext architecture"

✅ CORRECT: Delegate to documentation-engineer
/documentation-engineer Create architecture documentation for GPUContext:
- Context: See src/core/GPUContext.ts and CLAUDE.md architecture section
- Type: Architecture guide
- Requirements: Explain functional vs class-based API pattern, lifecycle, WebGPU initialization
- Expected outcome: Architecture guide in docs/ that explains GPUContext design and usage patterns
```

### Example 2: Public API Documentation

```
User: "Document the ChartGPU.create() API"

✅ CORRECT: Delegate to api-documenter
/api-documenter Document ChartGPU.create() public API:
- Context: See src/ChartGPU.ts and src/index.ts exports
- Scope: ChartGPU.create() method and ChartGPUOptions type
- Requirements: Include method signature, parameters, return type, usage examples, link to examples/
- Expected outcome: Comprehensive API documentation for ChartGPU.create() following project standards
```

### Example 3: Getting Started Guide

```
User: "Update the getting started guide"

✅ CORRECT: Delegate to documentation-engineer
/documentation-engineer Update getting started guide:
- Context: See docs/GETTING_STARTED.md and examples/hello-world/
- Type: Tutorial/guide
- Requirements: Keep it concise, link to examples, follow project documentation standards
- Expected outcome: Updated getting started guide that helps new users quickly start using ChartGPU
```

### Example 4: API Reference Update

```
User: "Document the new zoom API methods"

✅ CORRECT: Delegate to api-documenter
/api-documenter Document zoom API methods:
- Context: See src/interaction/createZoomState.ts and ChartGPU zoom methods
- Scope: All public zoom-related API methods
- Requirements: Document method signatures, parameters, return types, link to examples
- Expected outcome: Complete API documentation for zoom functionality
```

## Documentation File Locations

- **Internal docs**: `docs/` directory
  - `docs/API.md` - API overview (may reference public API)
  - `docs/GETTING_STARTED.md` - Getting started guide
  - `docs/GPU_TIMING_IMPLEMENTATION.md` - Technical implementation docs
  - `docs/INCREMENTAL_APPEND_OPTIMIZATION.md` - Technical implementation docs
  
- **Public API**: Documented in `docs/API.md` (maintained by api-documenter)
- **Examples**: `examples/` directory (referenced from docs, not documented directly)
- **README**: `README.md` (maintained by documentation-engineer)

## Critical Rules

- **Always delegate** - Never create documentation directly, always use the appropriate subagent
- **Match documentation type** - Internal docs → documentation-engineer, Public API → api-documenter
- **Follow project standards** - No code blocks, link to source, essential info only
- **Link to examples** - Reference `examples/` directory instead of embedding code
- **Keep it maintainable** - Documentation should stay in sync with code changes

## When Documentation Standards Apply

These standards apply to all documentation in:
- `docs/` directory
- `README.md`
- `CONTRIBUTING.md`
- Any markdown documentation files

Public API documentation should also follow these standards but may include additional API-specific requirements (examples, interactive features) as determined by api-documenter.
