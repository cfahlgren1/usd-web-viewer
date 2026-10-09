# usd-web-viewer

An MIT-licensed OpenUSD viewer for the web. USD composition runs in pure Rust
(the [`openusd`](https://github.com/mxpv/openusd) crate) compiled to a **527 KB
(brotli) WASM** module inside a Web Worker; rendering is three.js. It needs no
`SharedArrayBuffer` and no COOP/COEP headers, so it works on an ordinary page
and straight from Hugging Face Hub `resolve` URLs.

| | ours | Needle USD viewer | GLB baseline |
|---|---|---|---|
| WASM (brotli) | **527 KB** | 6.0 MB | – |
| Peak renderer RSS, 6 SimReady assets | **167–418 MB** | 1,118–4,941 MB | 117–213 MB |
| WASM heap | **2–88 MB** | 696–724 MB | – |
| Time to geometry (local) | 116–392 ms | – | 85–104 ms |
| Fully loaded incl. textures (local) | **147–552 ms** | 489–11,846 ms | 85–104 ms |
| Renders all 6 test assets | ✅ 6/6 | 5/6 (railing blank) | ✅ 6/6 |
| Matches Pixar OpenUSD (composed meshes, bboxes, bindings, preview inputs) | 6/6, and 186/187 of a 187-package Hub sample | – | – |

Full tables and screenshots: [`bench/results/README.md`](bench/results/README.md).
All runs: headless Chromium, SwiftShader, localhost, median of 3 cold runs.

## How it works

1. **Discover** — the worker fetches the root layer; Rust parses it and lists
   the layers it names (sublayers, references, payloads). The worker fetches
   those in parallel and recursively, resolving relative paths against the
   referencing layer's URL (Hub `resolve` URLs that redirect to the CDN work).
   Arcs inside variants are fetched only when the same layer selects that
   variant; composition reports anything else it still needs and the loop
   fetches it (all six test assets compose in one round).
2. **Compose** — an `openusd` `Stage` opens over an in-memory resolver. The
   stage takes ownership of the fetched bytes instead of copying them.
3. **Extract** — traverse with instance proxies; skip invisible and
   `guide`/`proxy` purpose prims; for each `Mesh`: world matrix
   (`UsdGeomXformCache`), fan-triangulated indices (honoring `leftHanded`),
   normals (authored vertex/faceVarying/uniform, or smooth normals when
   missing), primary UVs, `materialBind` `GeomSubset`s, and the bound material
   (`ComputeBoundMaterial`, preview purpose). faceVarying data is expanded per
   corner and then **welded** back (3–4× fewer vertices). Instances of one
   prototype share a single geometry.
4. **Materials** — `UsdPreviewSurface` (diffuse/roughness/metallic/opacity/
   emissive, `UsdUVTexture` file and wrap modes, `UsdTransform2d`
   scale/rotation/translation, diffuse from a `displayColor` primvar reader).
   MDL-only materials are read by parameter name for `OmniPBR` and glTF
   `pbr.mdl` (no MDL code is loaded); anything else falls back to neutral grey
   so geometry always shows.
5. **Transfer** — typed arrays move to the main thread as Transferables and
   become `BufferGeometry` + `MeshStandardMaterial`. Geometry shows first;
   base-color textures then stream in, decoded in the worker with
   `createImageBitmap` straight to ≤1024 px. The worker is terminated
   afterwards, which releases all WASM memory.

USDZ packages load too: layers and textures are read out of the zip in
memory (`pkg.usdz[inner]` paths).

## Usage

```js
import { createViewer } from 'usd-web-viewer'; // three is a peer dependency

const viewer = await createViewer(document.getElementById('app'));
const result = await viewer.load('https://huggingface.co/datasets/LGElectronics/simready-assets/resolve/main/laptop_17z90ur/simready_usd/laptop_17z90ur.usd');
console.log(result.info); // meshes, triangles, materials, timings
await result.textures;     // resolves when every texture has streamed in
```

Lower level: `loadUsd(url, { maxTextureSize, normalMaps })` returns
`{ root: THREE.Group, info, textures, dispose }` to add to your own scene.

## How to run

Requirements: Rust 1.96 with `wasm32-unknown-unknown` (pinned in
`rust-toolchain.toml`), `wasm-bindgen-cli` 0.2.129, Node 24.

```sh
npm install
cargo install wasm-bindgen-cli --version 0.2.129   # once
npm run build:wasm      # cargo -> wasm-bindgen -> wasm-opt -Oz, prints raw/gzip/brotli sizes
npm run serve           # http://127.0.0.1:8811 (no COOP/COEP), :8810 (isolated)
```

Then open
<http://127.0.0.1:8811/examples/index.html?url=https://huggingface.co/datasets/Robotiq-Official/simready-assets/resolve/main/Robotiq_2F_85/simready_usd/Robotiq_2F_85.usda>
(or any root layer URL).

Tests and benchmark (test assets expected under `USD_BENCH_DATA`, default
`~/dev/scratch/usd-viewer-bench-data/<repo>/<path>`; GLBs under `GLB_DIR`):

```sh
cargo test                                   # resolver unit tests
node scripts/node-test.mjs                   # compose + extract all 6 assets in Node via WASM
cargo run --profile native --example inspect -- <root.usd>   # native, with per-mesh listing (LIST=1)
npm run serve &                              # bench needs the server
node bench/run.mjs --configs usd-wasm,gltf --runs 3          # local files
node bench/run.mjs --configs usd-wasm --files laptop,robotiq,ivpole --hub   # from the Hub
node bench/report.mjs                        # -> bench/results/README.md
```

## Conformance

Details, per-package results and screenshots: [`conformance/results/README.md`](conformance/results/README.md).

- **Pixar oracle.** `conformance/oracle.py` (Pixar `usd-core`) and
  `conformance/extract.mjs` (ours: the WASM build in Node) dump the same JSON for a root
  layer: renderable meshes (instance proxies, default/render purpose,
  visibility), triangle and point counts, world-space bounding boxes, the
  materials bound to their faces (subsets included), UsdPreviewSurface inputs
  and texture paths. `conformance/compare.mjs` diffs them with tolerances.
- **Six benchmark assets: 6/6 match.**
- **Hub sample: 186/187 match** (150 random `nvidia/simready-assets`
  packages plus every package in LGElectronics, Robotiq-Official,
  standardbots thor/core and agibot-assets, and 30 imagineio packages; 6 more
  were skipped for having over 80 MB of layers). The one mismatch is
  `imagineio .../266/cookware_5.usd`: four lid meshes are offset by at most
  1.2e-5 stage units in Z, a floating-point difference in the transform
  (likely quaternion `orient` handling), not a visible error.
- **usd-wg/assets test scenes** (Apache-2.0): texture coordinates,
  references/overrides, payloads and nested variants, USDZ with packaged
  textures, and `UsdTransform2d` render correctly. **Gaps found:** normal maps
  are off by default and ignore `scale`/`bias`; roughness/metallic/occlusion
  textures, texture alpha and `opacityThreshold` cutouts, `sourceColorSpace`,
  HDR/EXR textures, MaterialX materials (grey fallback), UsdSkel skinning
  (bind pose), animation (default time only) and subdivision (control cage)
  are not supported.

```sh
# needs a Python with usd-core: python -m venv .venv && .venv/bin/pip install usd-core
export ORACLE_PYTHON=.venv/bin/python
node conformance/run.mjs --bench                      # the six assets
node conformance/fetch-packages.mjs --out ../simready-conformance-data   # sample + download layers (untrusted data, never executed)
node conformance/run.mjs --packages ../simready-conformance-data/packages.json
git clone --depth 1 https://github.com/usd-wg/assets ../usd-wg-assets/repo
USDWG_DIR=../usd-wg-assets/repo npm run serve & node conformance/usdwg.mjs
node conformance/report.mjs                           # -> conformance/results/README.md
```

## Size optimizations

Release profile `opt-level = "z"`, `lto`, `codegen-units = 1`,
`panic = "abort"`, `strip`; `wasm-opt -Oz`; only the `geom` and `shade`
schema families of `openusd-schemas`; no serde (metadata JSON is written by
hand).

## Notes and findings

- **Standard Bots Thor, 44 vs 37 meshes.** Not a composition bug. Each link
  has a deactivated untextured visual (`/thor/<link>/visuals/<link>`,
  `active = false`) next to the active textured one. A traversal with
  `PrimPredicate::ALL` descends below inactive prims and counts their 7 child
  meshes (44); Pixar never populates children of inactive prims, so even its
  all-prims predicate with instance proxies gives 37 (checked with the
  oracle). With the default predicate plus instance proxies, openusd also
  reports 37. Of
  those, 7 are collision meshes with `purpose = guide`, so 30 are drawn —
  612,452 triangles, identical to the GLB baseline.
- Triangle counts match the usd-core GLB baseline exactly on all six assets.
- Headless Chromium with `--use-angle=metal` stalls `requestAnimationFrame` on
  this machine for every viewer (GLB included), so only SwiftShader numbers
  are reported.

## Third-party notices

- [`openusd`](https://github.com/mxpv/openusd) and `openusd-schemas` — MIT, Copyright (c) 2024 Maksym Pavlenko (mxpv).
- [three.js](https://github.com/mrdoob/three.js) — MIT, Copyright (c) 2010-2026 three.js authors.
- Reference thumbnails in `bench/results/reference/` come from the respective SimReady dataset repositories (CC-BY-4.0).

## License

MIT — see [LICENSE](LICENSE).
