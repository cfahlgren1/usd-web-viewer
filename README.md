# usd-web-viewer

An MIT-licensed OpenUSD viewer for the web: USD composition in pure Rust
(the [`openusd`](https://github.com/mxpv/openusd) crate) compiled to WASM,
rendering with three.js.

Work in progress.

## Build

```sh
npm install
npm run build:wasm   # cargo (1.96, wasm32) -> wasm-bindgen -> wasm-opt -Oz
```

## Third-party notices

- [`openusd`](https://github.com/mxpv/openusd) and `openusd-schemas` — MIT, Copyright (c) Maksym Pavlenko (mxpv).
- [three.js](https://github.com/mrdoob/three.js) — MIT, Copyright (c) 2010-2026 three.js authors.
