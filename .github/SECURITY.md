# Security Policy

## Supported Versions

We currently support the following versions with security updates:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in ChartGPU, please report it responsibly:

1. **Do NOT open a public issue** - Security issues should remain private until resolved
2. **Email us at**: `security@example.com` (replace with actual contact email) with:
   - A clear description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Any suggested fixes (if applicable)
3. **Allow reasonable time** for us to respond and address the issue before public disclosure

We aim to respond to security reports within **72 hours** and will keep you updated throughout the resolution process.

## Known Security Considerations

### Tooltip Content Safety

ChartGPU's tooltip overlay uses `innerHTML` to render tooltip content. When providing custom tooltip formatters via `ChartGPUOptions.tooltip.formatter`, **only return trusted and sanitized HTML strings**.

**Risk**: Unsanitized user input in tooltip formatters can lead to XSS (Cross-Site Scripting) vulnerabilities.

**Mitigation**:
- Always sanitize user-provided data before including it in tooltip content
- Use text-only formatters when displaying untrusted data
- Consider using a dedicated HTML sanitization library (e.g., DOMPurify) if you must render user content

**Safe usage patterns**:
- SAFE: Static content like `formatter: (params) => 'Value: ' + params.value[1]`
- SAFE: Sanitized content using `escapeHtml()` or similar sanitization functions before including in HTML
- UNSAFE: Directly embedding unsanitized user input in HTML strings

See [`docs/API.md`](https://github.com/hunterg325/ChartGPU/blob/main/docs/API.md) for complete tooltip configuration details and [examples/interactive/main.ts](../examples/interactive/main.ts) for working tooltip implementations.

### WebGPU Security Model

ChartGPU operates within the browser's WebGPU security sandbox. The WebGPU specification includes built-in protections against:
- Memory access violations
- Cross-origin resource access
- GPU-level exploits

Users should ensure they're using up-to-date browsers with the latest WebGPU security patches.

## Security Best Practices

When using ChartGPU:

1. **Keep dependencies updated** - Regularly update ChartGPU and browser versions
2. **Validate user input** - Always sanitize data before passing it to chart options
3. **Use Content Security Policy (CSP)** - Configure CSP headers appropriately for your application
4. **Review custom code** - Audit any custom formatters, event handlers, or extensions

## Acknowledgments

We appreciate the security research community's efforts in making ChartGPU safer. Security researchers who responsibly disclose vulnerabilities will be acknowledged (with permission) in our release notes.
