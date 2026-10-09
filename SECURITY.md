# Security

usd-web-viewer loads untrusted, user-uploaded USD files in the browser. This is what it guarantees.

## Model

- **Memory-safe parsing.** The parser and extractor are Rust with no `unsafe` code, compiled to WebAssembly and run in a Web Worker. A malformed file can fail a load or exhaust its worker, never run code.
- **Restricted fetching.** Every layer, texture and Hub listing request a load makes goes through one policy:
  - the root URL the caller passes is always fetched;
  - otherwise http(s) only, and no URLs with credentials;
  - hf.co URLs are fetched and checked as the huggingface.co URLs they redirect to;
  - on huggingface.co, only `resolve` file URLs and tree listings of user or organization repos, never `/api`, `/oauth` or other Hub pages;
  - cookies and caller `headers` only for the root file's origin (for Hub URLs, the root's repo); every other request is sent with `credentials: 'omit'` and `no-referrer`;
  - requests carrying `headers` never follow a redirect with them: off the Hub, a redirect is fetched again without headers or cookies;
  - `allowedOrigins` adds more allowed hosts; the root's origin (and, for a Hub root, the Hub) is always allowed.

  The `.wasm` module is fetched by the page from `wasmUrl`, not under this policy.
- **Bounded resources.** Each load is capped:

  | Option | Default | At the cap |
  |---|---|---|
  | `maxLayerBytes` | 768 MiB | the load fails |
  | `maxLayers` | 1024 | the load fails |
  | `maxTextureBytes` | 512 MiB | further textures fail, with a warning |
  | `maxTriangles` | 20M | further meshes are skipped, with a warning (triangles count once per instance drawn) |
  | `maxInstances` | 100,000 | further instances are skipped, with a warning |
  | Packaged zip entries | 512 MiB per file, 1 GiB per package | the package, or that texture, fails |
  | Image size | 16384 px per side | that texture fails, with a warning |

  `maxLayers` counts requested files; layers inside a `.usdz` count toward the package limits instead.
- **No code from files.** No arbitrary code or shader source from files; only validated channel names and numbers reach generated shader code. Nothing from a file reaches `eval` or `innerHTML`.

## Not in scope

- Denial of service within the caps above (a large legitimate scene can use them).
- Bugs in three.js or the browser's image decoders.

## Reporting

Please report vulnerabilities privately to security@huggingface.co. Don't open public issues for them. Include a sample file if you can.
