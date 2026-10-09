<div align="center">

# usd-web-viewer

**OpenUSD in the browser.** Real USD composition in 604 KiB of WebAssembly, rendered with three.js.

<a href="https://huggingface.co/spaces/cfahlgren1/usd-viewer"><img src="https://huggingface.co/datasets/huggingface/badges/resolve/main/open-in-hf-spaces-md.svg" alt="Open in Spaces"></a>
<img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT">
<img src="https://img.shields.io/badge/wasm-604%20KiB%20brotli-orange" alt="604 KiB">

<img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/robotiq.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/laptop.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/thor.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/ivpole.png" width="118"> <img src="https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/resolve/main/readme/chair.png" width="118">

<sub>SimReady packages from the Hugging Face Hub, loaded straight from their <code>resolve</code> URLs</sub>

</div>

## Use it

```html
<script type="module">import 'usd-web-viewer/element';</script>

<usd-viewer
  src="https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda"
  alt="Robotiq 2F-85 gripper"></usd-viewer>
```

Attributes: `src`, `textures`, `alt`, `poster`, `loading`, `reveal`. Events: `progress`, `load`, `error`.

Or with your own three.js scene:

```js
import { loadUsd } from 'usd-web-viewer';

const url = 'https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda';
const { root } = await loadUsd(url);
scene.add(root); // a THREE.Group, Y-up, in meters
```

All options, errors and warnings are typed in [`index.d.ts`](packages/viewer/src/index.d.ts). Not on npm yet: depend on `packages/viewer` from this repo.

## Why

About half the size of tinyusdz, with the same composition support as Pixar-based viewers on SimReady assets.

| | usd-web-viewer | Needle | openusd-wasm | tinyusdz | three.js USDLoader |
|---|---|---|---|---|---|
| Renders the 14 test files | **14/14** | 5/14 | 8/14 | 5/14 | 4/14 |
| Download (WASM + JS, brotli) | **608 KB** | 4.9 MB | 1.8 MB | 1.2 MB | 20 KB |
| Load time vs ours | **1×** | 6.0× | 4.2× | 9.1× | 4.7× |
| Memory vs ours | **1×** | 5.6× | 5.2× | 1.5× | 0.8× |

<details>
<summary>Why it's smaller than Pixar-based builds</summary>

Similar names, different code: openusd-wasm and Needle compile **Pixar's C++ OpenUSD** to WebAssembly; this project uses [**openusd**](https://github.com/mxpv/openusd), a separate **pure-Rust** implementation.

| | Pixar's OpenUSD (C++) | This project (Rust `openusd`) |
|---|---|---|
| Scope | A full production library: authoring and editing APIs, many schema domains, a plugin system, change notification, file-format plugins | Read and compose only: parsers, composition, and the geometry and shading schemas a viewer needs |
| Runtime | Multithreaded (TBB) C++ with its standard library; browser builds need shared memory (COOP/COEP) | Single-threaded, no C++ runtime |
| Dead code | Plugin and type registries keep code reachable even when unused | Statically linked, so link-time optimization and `wasm-opt` strip what isn't called |
| Measured | openusd-wasm: 12.8 MB raw / 1.8 MB brotli, ~680 MB WASM memory reserved up front | 2.2 MB raw / 604 KiB brotli, 1–2 MB WASM memory to start |

The trade: no authoring, no Hydra and fewer schemas, which a viewer doesn't need.
</details>

Matches Pixar's OpenUSD on every package in [nvidia/simready-assets](https://huggingface.co/datasets/nvidia/simready-assets) ([how it was checked](https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/conformance/README.md)). Files, renders and full results: [cfahlgren1/simready-usd-web-viewers](https://huggingface.co/datasets/cfahlgren1/simready-usd-web-viewers/blob/main/crossbench.md).

## Supports

- `.usd`, `.usda`, `.usdc`, `.usdz`: sublayers, references, payloads, variants, instancing (PointInstancers, nested ones included)
- UsdPreviewSurface (color, emissive, roughness, metallic, occlusion, opacity and normal maps), OmniPBR and glTF MDL parameters, displayColor
- Cube, Sphere, Cylinder, Cone, Capsule, Plane
- Chrome / Edge 111+, Safari 16.4+, Firefox 115+

**Not yet:** MaterialX and custom MDL (grey), lights and cameras, animation, skinning, subdivision, curves, points, volumes, Gaussian splats, EXR textures.

## Develop

    npm install && npm run build:wasm   # needs Rust (wasm32-unknown-unknown) and wasm-bindgen-cli 0.2.129
    npm test && cargo test              # fixture snapshots: cargo insta review
    npm run test:browser                # Playwright: element, real worker and fetch
    npm run serve                       # examples on :8811

Security model: [SECURITY.md](SECURITY.md). MIT licensed.
