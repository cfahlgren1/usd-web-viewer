# Security

usd-web-viewer loads untrusted, user-uploaded USD files in the browser. This is what it guarantees.

## Model

- **Memory-safe parsing.** The parser and extractor are Rust with no `unsafe` code, compiled to WebAssembly and run in a Web Worker. A malformed file can fail a load or exhaust its worker, never run code.
- **Restricted fetching.** Every request goes through one policy:
  - http(s) only, and no URLs with credentials;
  - on huggingface.co, only `resolve` file URLs and tree listings;
  - cookies and caller `headers` only for the root file's origin (for Hub URLs, the root's repo);
  - every other request sent with `credentials: 'omit'` and `no-referrer`;
  - `allowedOrigins` narrows or widens the allowed hosts.
- **Bounded resources.** Each load is capped. Hitting a cap fails the load or skips the item with a warning, never hangs the page.

  | Option | Default |
  |---|---|
  | `maxLayerBytes` | 768 MiB |
  | `maxLayers` | 1024 |
  | `maxTextureBytes` | 512 MiB |
  | `maxTriangles` | 20M |
  | Packaged zip entries | 512 MiB per file, 1 GiB per package |
  | Image size | 16384 px per side |

- **No code from files.** Nothing from a file reaches `eval`, `innerHTML` or shader source.

## Not in scope

- Denial of service within the caps above (a large legitimate scene can use them).
- Bugs in three.js or the browser's image decoders.

## Reporting

Please report vulnerabilities privately to security@huggingface.co. Don't open public issues for them. Include a sample file if you can.
