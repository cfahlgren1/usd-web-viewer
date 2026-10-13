# usd-web-viewer

[OpenUSD](https://openusd.org) in the browser: USD composition in WebAssembly, built on [openusd](https://github.com/mxpv/openusd) (pure Rust), rendered with [three.js](https://threejs.org). Reads `.usd`, `.usda`, `.usdc` and `.usdz`; loads run in a Web Worker.

```sh
npm install usd-web-viewer three
```

## Usage

A ready-made viewer (renderer, lighting, orbit controls):

```js
import { createViewer } from 'usd-web-viewer';

const viewer = createViewer(document.getElementById('viewer')); // a canvas, or a container for one
const { info } = await viewer.load(
  'https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda',
);
```

Or into your own three.js scene:

```js
import { loadUsd } from 'usd-web-viewer';

const { root, complete, dispose } = await loadUsd(url);
scene.add(root); // a THREE.Group, Y-up, in meters
await complete; // textures stream in after the geometry
```

## Options

`loadUsd(url, options)` and `viewer.load(url, options)` take:

| Option                         | Default             |                                                                                                                            |
| ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `textures`                     | `'preview'`         | `'none'`, `'preview'` (base color, small data maps, no normal maps) or `'full'`                                            |
| `maxTextureSize`               | `1024`              | Long side of decoded textures, in pixels                                                                                   |
| `signal`                       |                     | An `AbortSignal`; the load rejects with a `UsdLoadError` of code `aborted`                                                 |
| `headers`                      |                     | Sent only to the root URL's origin (or, on the Hugging Face Hub, the root's repo), e.g. `{ Authorization: 'Bearer hf_…' }` |
| `onProgress`                   |                     | Called with the stage and an overall `fraction` from 0 to 1                                                                |
| `allowedOrigins`               |                     | Other origins layers and textures may come from; `['*']` for any                                                           |
| `files`                        |                     | Load dropped or picked files instead of the network (see below)                                                            |
| `wasmUrl`, `workerUrl`         | next to the package | Where the WASM binary and the worker script are served from                                                                |
| `maxConcurrentFetches`         | `16`                | Requests in flight at once                                                                                                 |
| `maxLayerBytes`, `maxLayers`   | 768 MiB, 1024       | Layer download limits                                                                                                      |
| `maxTextureBytes`              | 512 MiB             | Texture download limit                                                                                                     |
| `maxTriangles`, `maxInstances` | 20M, 100,000        | What is drawn at most                                                                                                      |

Failures are `UsdLoadError`s with a `code` (`aborted`, `fetch`, `compose`, `worker`, `webgl`); anything that could not be shown faithfully is listed in `info.warnings`. Every option, error and warning is typed.

## Local files

To show files dropped on the page or picked with `<input type="file" webkitdirectory>`, pass them as `files`, keyed by their path in the package, and load the root layer's key. Relative paths in the files resolve against each other; nothing is fetched for them.

```js
const files = new Map([...input.files].map((file) => [file.webkitRelativePath || file.name, file]));
await viewer.load('chair/simready_usd/sm_chair.usd', { files });
```

## Bundlers

The worker and the WASM binary are found with `new URL(..., import.meta.url)`, which Vite, webpack and other bundlers resolve and emit. With the Vite dev server, exclude the package from dependency pre-bundling:

```js
// vite.config.js
export default { optimizeDeps: { exclude: ['usd-web-viewer'] } };
```

MIT licensed. The licenses of the Rust crates compiled into the WASM binary are in `THIRD_PARTY_LICENSES`.
