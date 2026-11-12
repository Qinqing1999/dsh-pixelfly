# dsh-pixelfly

Image generation for **DeepSeek Harness**. Pixelfly adds a settings page, a studio page and three
agent tools that turn a text prompt into a picture through an OpenAI-compatible
`/images/generations` upstream (tuned for the SenseNova image models
`sensenova-u1.5-fast` and `sensenova-u1.5-lite`).

Everything is configured in the Harness UI — no environment variables, no config files to edit by
hand.

## Features

- **Settings page** in *Settings → PixelFly*: upstream base URL, request timeout, API keys,
  retry policy, default model, default size, output directory.
- **Multi-key ring** with round-robin rotation. A rejected key (401/402/403) is put on cooldown and
  the very next attempt uses a *different* key — a bad key never aborts the run.
- **Exponential backoff with jitter** on `429`/`5xx`/network errors, capped by a configurable
  ceiling, and `Retry-After` is honoured when the upstream sends it.
- **Studio page** in the sidebar: prompt, model, size, count, live attempt trace, the resulting
  image, and a gallery of recent generations.
- **Agent tools** so the model can generate images mid-conversation:
  `pixelfly_generate`, `pixelfly_config`, `pixelfly_status`.
- **Keys never leave the machine.** They are stored `0600` under the Harness data directory and the
  UI only ever receives a mask such as `sk-dT6…Jtfn`.

## Install

```bash
# from the profile you want the plugin in
dsh plugin --profile web add file:/path/to/dsh-pixelfly
```

Then add the bundle to the profile's `package.json` (`dsh.profile.bundles`) and a row to its
`cordis.patch.yml`:

```yaml
- insert:
    - id: pixelfly-host
      name: dsh-pixelfly
      config: {}
```

Restart the Harness. The plugin appears in *Settings* and as a sidebar icon.

### Serving the Web UI beyond loopback

Named HTTP routes are loopback-only by default. If your Harness is reachable on a LAN address or
behind a tunnel, widen the fence explicitly — exactly as you would for the Harness' own
`--trusted-host`:

```yaml
- insert:
    - id: pixelfly-host
      name: dsh-pixelfly
      config:
        allowNonLoopback: true
        trustedHosts:
          - '192.168.1.10:8888'
```

Requests still need the per-process bearer token that the browser half fetches from
`GET /pixelfly/api/token`, and cross-origin callers are rejected.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Upstream base URL | `https://token.sensenova.cn/v1` | Any OpenAI-compatible base URL |
| Request timeout | `180000` ms | Image models are slow; do not set this low |
| Default model | `sensenova-u1.5-fast` | `sensenova-u1.5-lite` is the cheaper one |
| Default size | `1024x1024` | Passed straight to the upstream |
| Max attempts | `4` | Never less than one pass over the key ring |
| Base delay | `700` ms | Doubles per retry |
| Max delay | `20000` ms | Backoff ceiling |
| Jitter | `0.25` | ±12.5% band, avoids lock-step retries |
| Key cooldown | `60000` ms | How long a rejected key sits out |
| Keep files | `200` | Older images are pruned automatically |

Data lives in `$DSH_HOME/plugins-data/pixelfly/` (default `~/.dsh/plugins-data/pixelfly/`):
`config.json`, `state.json`, `images/`, and `http.token`.

Environment overrides for CI or headless use: `PIXELFLY_BASE_URL`, `PIXELFLY_API_KEYS`
(whitespace- or comma-separated, used when no key is configured in the UI), `PIXELFLY_HTTP_TOKEN`.

## Tools

```jsonc
// pixelfly_generate
{ "prompt": "a lighthouse on a cliff at dusk, painterly",
  "model": "sensenova-u1.5-fast", "size": "1024x1024", "n": 1 }
```

Returns the saved file paths, image dimensions, token usage and the attempt trace. When the Harness
attachment store is available the image is also attached to the conversation, so it renders inline
and stays readable by `read_image`.

```jsonc
// pixelfly_config — read or change settings without opening the UI
{ "action": "read" }
{ "action": "addKey", "key": "sk-…", "label": "work" }
{ "action": "setDefaultModel", "model": "sensenova-u1.5-lite" }

// pixelfly_status — masked keys, cooldowns, recent files, optional live probe
{ "probe": true }
```

## HTTP API

All routes require `Authorization: Bearer <token>` from `GET /pixelfly/api/token`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/pixelfly/api/config` | Public config, resolved paths, last run |
| `POST` | `/pixelfly/api/config` | Whitelisted settings patch |
| `GET`/`POST`/`DELETE` | `/pixelfly/api/keys` | List, add/remove/toggle/clear keys |
| `POST` | `/pixelfly/api/test` | Probe each key against the models endpoint |
| `GET` | `/pixelfly/api/models` | List upstream models |
| `POST` | `/pixelfly/api/generate` | Generate images |
| `GET` | `/pixelfly/api/gallery` | Recent generated files |
| `GET` | `/pixelfly/api/file?path=…` | Serve one generated file (traversal-guarded) |
| `GET` | `/pixelfly/api/stats` | Key ring snapshot |

## Layout

```
host/index.js     routes, HTTP fence, plugin entry (apply/inject)
host/config.js    config + state on disk, masking, env overrides
host/upstream.js  key ring, backoff, error mapping, HTTP client
host/images.js    PNG/JPEG/WebP/GIF sniffing, save, prune, gallery
host/generate.js  request building, orchestration, history
host/tools.js     the three agent tools
client.js         settings section, studio page, sidebar icon
```

The Host half is plain ESM with no build step; the Web half is a single lazy-CJS bundle that only
requires `react`.

## License

MIT
