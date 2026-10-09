// UsdPreviewSurface on three.js MeshStandardMaterial.
//
// Each textured input becomes the matching three.js map. UsdUVTexture can read
// any channel (`r`, `g`, `b`, `a`, `rgb`) and remaps it as `texel * scale + bias`;
// three.js maps read fixed channels with no remap, so the sampling line of the
// map's shader chunk is rewritten to the authored channel, scale and bias.
import * as THREE from 'three';

// input -> three.js map, whether it carries color, and the shader chunk line to rewrite.
const SLOTS = {
  diffuseColor: { map: 'map', color: true, chunk: 'map_fragment', from: 'diffuseColor *= sampledDiffuseColor;', to: (e) => `diffuseColor.rgb *= ${e('sampledDiffuseColor', 3)};` },
  emissiveColor: { map: 'emissiveMap', color: true, chunk: 'emissivemap_fragment', from: 'totalEmissiveRadiance *= emissiveColor.rgb;', to: (e) => `totalEmissiveRadiance *= ${e('emissiveColor', 3)};` },
  roughness: { map: 'roughnessMap', chunk: 'roughnessmap_fragment', from: 'texelRoughness.g', to: (e) => e('texelRoughness', 1) },
  metallic: { map: 'metalnessMap', chunk: 'metalnessmap_fragment', from: 'texelMetalness.b', to: (e) => e('texelMetalness', 1) },
  occlusion: { map: 'aoMap', chunk: 'aomap_fragment', from: 'texture2D( aoMap, vAoMapUv ).r', to: (e) => e('texture2D( aoMap, vAoMapUv )', 1) },
  opacity: { map: 'alphaMap', chunk: 'alphamap_fragment', from: 'texture2D( alphaMap, vAlphaMapUv ).g', to: (e) => e('texture2D( alphaMap, vAlphaMapUv )', 1) },
  normal: { map: 'normalMap', chunk: 'normal_fragment_maps', from: 'texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0', to: (e) => e('texture2D( normalMap, vNormalMapUv )', 3) },
};

/** A material from the extracted parameters; maps attach later as textures arrive. */
export function createMaterial(m) {
  const linear = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  const material = new THREE.MeshStandardMaterial({
    color: linear(m.color),
    emissive: linear(m.emissive),
    roughness: m.roughness,
    metalness: m.metallic,
    opacity: m.opacity,
  });
  const textured = 'opacity' in m.maps;
  if (m.opacityThreshold > 0 && (textured || m.opacity < 1)) {
    // A threshold makes opacity a cutout mask, drawn in the opaque pass.
    material.alphaTest = m.opacityThreshold;
  } else if (textured || m.opacity < 1) {
    material.transparent = true;
    material.depthWrite = false;
  }
  material.name = m.path;
  material.userData.usd = { kind: m.kind, maps: m.maps, colorPrimvar: m.colorPrimvar, uvChannels: {}, color: m.color };
  // Until its base color texture streams in, a textured surface shows mid grey
  // (18%, the usual neutral) rather than the stark white texture multiplier.
  if (m.maps.diffuseColor) material.color.setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace);
  return prepare(material);
}

/** A copy that reads per-vertex colors, double-sided, or both. */
export function variant(material, { doubleSided, vertexColors }) {
  const copy = material.clone();
  if (doubleSided) copy.side = THREE.DoubleSide;
  if (vertexColors) {
    copy.vertexColors = true;
    copy.color.setRGB(1, 1, 1);
  }
  return prepare(copy);
}

/** Wires the shader rewrite; `userData.patches` grows as textured inputs attach. */
function prepare(material) {
  material.userData.patches = {};
  material.onBeforeCompile = (shader) => {
    for (const [input, ref] of Object.entries(material.userData.patches)) {
      const { chunk, from, to } = SLOTS[input];
      const code = THREE.ShaderChunk[chunk].replaceAll(from, to((base, size) => remap(base, size, ref)));
      shader.fragmentShader = shader.fragmentShader.replace(`#include <${chunk}>`, code);
    }
  };
  material.customProgramCacheKey = () => JSON.stringify(material.userData.patches);
  return material;
}

/** `texel.<channel> * scale + bias` as GLSL, sized to the slot (1 or 3 components). */
function remap(base, size, ref) {
  const f = (v) => v.toFixed(6);
  const channel = ref.channel === 'rgb' || ref.channel === 'rgba' ? 'rgb' : ref.channel;
  if (channel === 'rgb') {
    const expr = `(${base}.rgb * vec3(${ref.scale.slice(0, 3).map(f)}) + vec3(${ref.bias.slice(0, 3).map(f)}))`;
    return size === 3 ? expr : `${expr}.r`;
  }
  const i = 'rgba'.indexOf(channel);
  const expr = `(${base}.${channel} * ${f(ref.scale[i])} + ${f(ref.bias[i])})`;
  return size === 3 ? `vec3${expr}` : expr;
}

/**
 * Attaches a decoded image to every input of `material` that samples `path`.
 * `textureFor(ref, colorSpace)` returns a configured three.js texture.
 */
export function attachTexture(material, path, textureFor) {
  const usd = material.userData.usd;
  let changed = false;
  for (const [input, ref] of Object.entries(usd.maps)) {
    const slot = SLOTS[input];
    if (ref.path !== path || !slot) continue;
    const texture = textureFor(ref, colorSpace(ref, slot), usd.uvChannels[ref.uvSet] ?? 0);
    material[slot.map] = texture;
    material.userData.patches[input] = { channel: ref.channel, scale: ref.scale, bias: ref.bias };
    // The texture now carries the value: the constant factor becomes neutral.
    if (input === 'diffuseColor') material.color.setRGB(...usd.color, THREE.LinearSRGBColorSpace);
    if (input === 'roughness') material.roughness = 1;
    if (input === 'metallic') material.metalness = 1;
    if (input === 'emissiveColor') material.emissive.setRGB(1, 1, 1);
    if (input === 'opacity') material.opacity = 1;
    changed = true;
  }
  if (changed) material.needsUpdate = true;
}

/** Uses each input's `fallback` value when its image cannot be read. */
export function applyFallback(material, path) {
  for (const [input, ref] of Object.entries(material.userData.usd.maps)) {
    if (ref.path !== path || !ref.fallback) continue;
    const [r, g, b, a] = ref.fallback;
    const value = { r, g, b, a }[ref.channel] ?? r;
    if (input === 'diffuseColor') material.color.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    if (input === 'emissiveColor') material.emissive.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    if (input === 'roughness') material.roughness = value;
    if (input === 'metallic') material.metalness = value;
    if (input === 'opacity') material.opacity = value;
  }
}

/** `sourceColorSpace`: explicit `raw`/`sRGB` wins; `auto` decodes color inputs as sRGB and data as linear. */
function colorSpace(ref, slot) {
  if (ref.colorSpace === 'raw') return THREE.NoColorSpace;
  if (ref.colorSpace === 'sRGB') return THREE.SRGBColorSpace;
  return slot.color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
}

/** A texture for `ref` sharing the decoded image of `base`: color space, wrap, UV set and UsdTransform2d. */
export function configureTexture(base, ref, colorSpaceValue, uvChannel) {
  const texture = base.clone();
  texture.colorSpace = colorSpaceValue;
  texture.channel = uvChannel;
  // `black` has no three.js equivalent (no border color); clamp is closest.
  const wrap = (token) => ({ mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping, black: THREE.ClampToEdgeWrapping })[token] ?? THREE.RepeatWrapping;
  texture.wrapS = wrap(ref.wrapS);
  texture.wrapT = wrap(ref.wrapT);
  const [sx, sy] = ref.uvScale;
  const [tx, ty] = ref.uvTranslation;
  const angle = (ref.uvRotation * Math.PI) / 180;
  if (sx !== 1 || sy !== 1 || tx !== 0 || ty !== 0 || angle !== 0) {
    // UsdTransform2d: st' = rotate(st * scale) + translation (counterclockwise degrees).
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    texture.matrixAutoUpdate = false;
    texture.matrix.set(c * sx, -s * sy, tx, s * sx, c * sy, ty, 0, 0, 1);
  }
  texture.needsUpdate = true;
  return texture;
}
