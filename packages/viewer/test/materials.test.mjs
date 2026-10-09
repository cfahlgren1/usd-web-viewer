// UsdPreviewSurface inputs on three.js materials, and the image facts they depend on.
// usage: node --test packages/viewer/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { imageInfo } from '../src/load-core.js';
import { applyFallback, attachTexture, configureTexture, createMaterial } from '../src/materials.js';

const ref = { path: 'image.png', channel: 'r', scale: [1, 1, 1, 1], bias: [0, 0, 0, 0], uvScale: [1, 1], uvTranslation: [0, 0], uvRotation: 0 };
const material = (maps) => createMaterial({ path: '/M', kind: 'preview', color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.5, metallic: 0, opacity: 1, opacityThreshold: 0, maps });
const attach = (m, isColor) => attachTexture(m, 'image.png', isColor, (r, colorSpace, channel) => configureTexture(new THREE.Texture(), r, colorSpace, channel));

test('auto color space is decided by the image, the same for every input that samples it', () => {
  for (const [isColor, expected] of [[true, THREE.SRGBColorSpace], [false, THREE.NoColorSpace]]) {
    const m = material({ roughness: ref, diffuseColor: { ...ref, channel: 'rgb' } });
    attach(m, isColor);
    assert.deepEqual([m.map.colorSpace, m.roughnessMap.colorSpace], [expected, expected]);
  }
  const explicit = material({ diffuseColor: { ...ref, channel: 'rgb', colorSpace: 'raw' }, roughness: { ...ref, colorSpace: 'sRGB' } });
  attach(explicit, true);
  assert.deepEqual([explicit.map.colorSpace, explicit.roughnessMap.colorSpace], [THREE.NoColorSpace, THREE.SRGBColorSpace]);
});

test("an image that cannot be read leaves the input's own value, not the texture's fallback", () => {
  const blue = material({ diffuseColor: { ...ref, channel: 'rgb', fallback: [1, 0, 0, 1], value: [0, 0, 1] }, roughness: { ...ref, value: [0.5, 0.5, 0.5] } });
  // Grey while loading.
  assert.deepEqual(blue.color.toArray().map((v) => +v.toFixed(6)), [0.18, 0.18, 0.18]);
  applyFallback(blue, 'image.png');
  assert.deepEqual(blue.color.toArray(), [0, 0, 1]);
  assert.equal(blue.roughness, 0.5);
});

test('only r, g, b or a from an authored channel reaches the shader', () => {
  const m = material({ roughness: { ...ref, channel: 'r_evil' }, metallic: { ...ref, channel: 'g' } });
  attach(m, false);
  const shader = { fragmentShader: '#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>' };
  m.onBeforeCompile(shader);
  assert.ok(!shader.fragmentShader.includes('r_evil'));
  assert.match(shader.fragmentShader, /\.rgb \* vec3/);
  assert.match(shader.fragmentShader, /\.g \* /);
});

/** A PNG signature and IHDR chunk with the given bit depth and color type. */
function pngHeader(bitDepth, colorType) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(64, 16);
  b.writeUInt32BE(32, 20);
  b[24] = bitDepth;
  b[25] = colorType;
  return new Uint8Array(b);
}

/** A JPEG SOI and baseline SOF0 segment with `components` channels. */
function jpegHeader(components) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0, 32, 0, 64, components, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

test('8-bit RGB(A) images are color (sRGB under auto); single-channel and 16-bit images are data', () => {
  const color = (bytes) => imageInfo(bytes)?.color;
  assert.deepEqual(imageInfo(new Uint8Array(readFileSync(new URL('../../../conformance/fixtures/quadrants.png', import.meta.url)))), { width: 2, height: 2, color: true });
  assert.equal(color(pngHeader(8, 6)), true, 'RGBA');
  assert.equal(color(pngHeader(8, 3)), true, 'palette');
  assert.equal(color(pngHeader(8, 0)), false, 'grey');
  assert.equal(color(pngHeader(8, 4)), false, 'grey + alpha');
  assert.equal(color(pngHeader(16, 2)), false, '16-bit RGB');
  assert.equal(color(jpegHeader(3)), true, 'JPEG YCbCr');
  assert.equal(color(jpegHeader(1)), false, 'JPEG grey');
  assert.equal(imageInfo(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null, 'unknown format');
});
