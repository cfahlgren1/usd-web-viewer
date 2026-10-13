<div align="center">

# usd-web-viewer

**[OpenUSD](https://openusd.org) in the browser.** USD composition in 625 KiB of WebAssembly, built on [openusd](https://github.com/mxpv/openusd) and rendered with three.js.

<a href="https://huggingface.co/spaces/cfahlgren1/usd-viewer"><img src="https://huggingface.co/datasets/huggingface/badges/resolve/main/open-in-hf-spaces-md.svg" alt="Open in Spaces"></a>
<img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT">
<img src="https://img.shields.io/badge/wasm-625%20KiB%20brotli-orange" alt="625 KiB">

<img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/robotiq.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/laptop.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/thor.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/ivpole.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/chair.png" width="118">

<sub>SimReady packages from the Hugging Face Hub, loaded straight from their <code>resolve</code> URLs</sub>

</div>

## Use it

```js
import { createViewer } from 'usd-web-viewer';

const viewer = createViewer(document.getElementById('viewer')); // a canvas, or a container for one
await viewer.load('https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda');
```

Or with your own three.js scene:

```js
import { loadUsd } from 'usd-web-viewer';

const url = 'https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda';
const { root } = await loadUsd(url);
scene.add(root); // a THREE.Group, Y-up, in meters
```

All options, errors and warnings are typed in [`types.ts`](packages/viewer/src/types.ts). Not on npm yet: depend on `packages/viewer` from this repo. With Vite, add `optimizeDeps: { exclude: ['usd-web-viewer'] }` so the dev server finds the worker and WASM.

## Why

About half the size of tinyusdz, and it renders all [14 public Hub USD files in our test set](https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/crossbench.md), including SimReady packages from [nvidia](https://huggingface.co/datasets/nvidia/simready-assets), [LG](https://huggingface.co/datasets/LGElectronics/simready-assets) and [Robotiq](https://huggingface.co/datasets/Robotiq-Official/simready-assets); Pixar-based builds render 8 and 5 of them.

| | Renders the 14 test files | Download | Load time | Memory |
|---|---|--:|--:|--:|
| **usd-web-viewer** | `██████████████` **14** | **625 KiB** | **1×** | **1×** |
| openusd-wasm | `████████░░░░░░` 8 | 1.8 MB | 4.2× slower | 5.2× more |
| Needle | `█████░░░░░░░░░` 5 | 4.9 MB | 6.0× slower | 5.6× more |
| tinyusdz | `█████░░░░░░░░░` 5 | 1.2 MB | 9.1× slower | 1.5× more |
| three.js USDLoader | `████░░░░░░░░░░` 4 | 20 KB | 4.7× slower | 0.8× (less) |

<sub><i>Headless Chromium with software WebGL, served from localhost; median of 3 cold loads. Download is WASM + JS, brotli. Load time and memory are relative to usd-web-viewer on the files both render. Measured October 2026; <a href="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/crossbench.md">full results</a>.</i></sub>

<details>
<summary>Why it's smaller than Pixar-based builds</summary>

Similar names, different code: openusd-wasm and Needle compile **Pixar's C++ OpenUSD** to WebAssembly; this project uses [**openusd**](https://github.com/mxpv/openusd), a separate **pure-Rust** implementation.

| | Pixar's OpenUSD (C++) | This project (Rust `openusd`) |
|---|---|---|
| Scope | A full production library: authoring and editing APIs, many schema domains, a plugin system, change notification, file-format plugins | Read and compose only: parsers, composition, and the geometry and shading schemas a viewer needs |
| Runtime | Multithreaded (TBB) C++ with its standard library; browser builds need shared memory (COOP/COEP) | Single-threaded, no C++ runtime |
| Dead code | Plugin and type registries keep code reachable even when unused | Statically linked, so link-time optimization and `wasm-opt` strip what isn't called |
| Measured | openusd-wasm: 12.8 MB raw / 1.8 MB brotli, ~680 MB WASM memory reserved up front | 2.3 MB raw / 625 KiB brotli, 1–2 MB WASM memory to start |

The trade: no authoring, no Hydra and fewer schemas, which a viewer doesn't need.
</details>

Checked against Pixar's `usd-core` on all 2,503 packages in [nvidia/simready-assets](https://huggingface.co/datasets/nvidia/simready-assets) (October 2026): the same meshes, triangle counts, world bounds, material bindings and UsdPreviewSurface/texture inputs. MDL shading is approximated, not compared ([how it was checked](https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/conformance/README.md)). Files, renders and full results: [cfahlgren1/simready-usd-web-viewers](https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/crossbench.md).

## Supports

- `.usd`, `.usda`, `.usdc`, `.usdz`: sublayers, references, payloads, variants, instancing (PointInstancers, nested ones included)
- UsdPreviewSurface (color, emissive, roughness, metallic, occlusion, opacity and normal maps); OmniPBR and glTF MDL materials, approximated as PBR; displayColor
- Cube, Sphere, Cylinder, Cone, Capsule, Plane
- Chrome / Edge 111+, Safari 16.4+, Firefox 115+

**Not yet:** MaterialX and other MDL materials (rendered grey, with a warning), lights and cameras, animation, skinning, subdivision, curves, points, volumes, Gaussian splats, EXR textures.

## Develop

    npm install && npm run build:wasm   # needs Rust (wasm32-unknown-unknown) and wasm-bindgen-cli 0.2.129
    npm run build                       # TypeScript to packages/viewer/dist (tshy)
    npm test && cargo test              # vitest; fixture snapshots: cargo insta review
    npm run test:browser                # Playwright, local only: real worker, fetch and rendering, against dist
    npm run lint && npm run check && npm run format:check # oxlint and eslint, tsc, oxfmt

Built on [openusd](https://github.com/mxpv/openusd) (MIT, Maksym Pavlenko) and [three.js](https://github.com/mrdoob/three.js) (MIT). Security model: [SECURITY.md](SECURITY.md). MIT licensed.
