#!/usr/bin/env bash
# Builds the WASM module into packages/viewer/wasm: cargo (size profile) ->
# wasm-bindgen (web target) -> wasm-opt -Os. Prints raw / gzip / brotli sizes.
set -euo pipefail
cd "$(dirname "$0")/.."

OPT_LEVEL="${OPT_LEVEL:-s}"
OUT=packages/viewer/wasm

CARGO_PROFILE_RELEASE_OPT_LEVEL="$OPT_LEVEL" cargo build --locked --release --target wasm32-unknown-unknown -p usd-wasm
wasm-bindgen --target web --no-typescript --out-dir "$OUT" target/wasm32-unknown-unknown/release/usd_wasm.wasm
node_modules/.bin/wasm-opt -O"$OPT_LEVEL" --strip-debug --strip-producers \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  --enable-reference-types --enable-multivalue \
  "$OUT/usd_wasm_bg.wasm" -o "$OUT/usd_wasm_bg.wasm"

node scripts/sizes.mjs "$OUT/usd_wasm_bg.wasm" "$OUT/usd_wasm.js"
