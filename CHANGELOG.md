# Changelog

## 0.1.0

First release.

- Settings section under *Settings → PixelFly*: upstream base URL, timeout, API key ring, retry
  policy, default model, default size, output directory.
- Studio page and sidebar icon: prompt composer, live attempt trace, result preview, gallery.
- Agent tools `pixelfly_generate`, `pixelfly_config`, `pixelfly_status`.
- Multi-key round-robin rotation with per-key cooldown; a rejected key rotates instead of aborting.
- Exponential backoff with jitter and `Retry-After` support.
- Token-fenced HTTP API with loopback default and explicit trusted-host opt-in.
