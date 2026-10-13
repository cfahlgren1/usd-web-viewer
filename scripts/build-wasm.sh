#!/usr/bin/env bash
# Builds the WASM module into packages/viewer/wasm: cargo (size profile) ->
# stub the layer writers -> wasm-bindgen (web target) -> wasm-opt -Os.
set -euo pipefail
cd "$(dirname "$0")/.."

OPT_LEVEL="${OPT_LEVEL:-s}"
OUT=packages/viewer/wasm

CARGO_PROFILE_RELEASE_OPT_LEVEL="$OPT_LEVEL" cargo build --locked --release --target wasm32-unknown-unknown -p usd-wasm
node scripts/stub-writers.mjs target/wasm32-unknown-unknown/release/usd_wasm.wasm target/usd_wasm_stubbed.wasm
wasm-bindgen --target web --out-dir "$OUT" --out-name usd_wasm target/usd_wasm_stubbed.wasm
node_modules/.bin/wasm-opt -O"$OPT_LEVEL" --strip-debug --strip-producers \
  --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  --enable-reference-types --enable-multivalue \
  "$OUT/usd_wasm_bg.wasm" -o "$OUT/usd_wasm_bg.wasm"
