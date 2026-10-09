// Hugging Face Hub helpers: file URLs and SimReady package roots.

const PREFIX = { dataset: 'datasets/', model: '', space: 'spaces/' };
const LAYER = /\.(usd|usda|usdc|usdz)$/i;

/**
 * The URL that serves `path` from a Hub repo (it redirects to the CDN).
 * @param {string} repo  e.g. `nvidia/simready-assets`
 * @param {string} path  file path inside the repo
 * @param {{ revision?: string, repoType?: 'dataset' | 'model' | 'space', endpoint?: string }} [options]
 */
export function hubUrl(repo, path, { revision = 'main', repoType = 'dataset', endpoint = 'https://huggingface.co' } = {}) {
  const encode = (p) => p.split('/').map(encodeURIComponent).join('/');
  return `${endpoint}/${PREFIX[repoType]}${repo}/resolve/${encodeURIComponent(revision)}/${encode(path)}`;
}

/**
 * The root layer of a SimReady package, from its file listing (paths relative
 * to the package folder) and, when available, the parsed
 * `.metadata/com.nvidia.simready.root_usds.json`. Returns null when the
 * listing holds no USD layer.
 * @param {string[]} files
 * @param {{ entries?: string[] }} [rootUsds]
 */
export function findSimReadyRoot(files, rootUsds) {
  const listed = rootUsds?.entries?.find((entry) => files.includes(entry));
  if (listed) return listed;
  // SimReady keeps the root at the package top or in simready_usd/, next to payloads/.
  const candidates = files.filter((f) => LAYER.test(f) && !/(^|\/)(payloads|\.thumbs|\.[^/]*)\//.test(f));
  const depth = (f) => f.replace(/^simready_usd\//, '').split('/').length;
  candidates.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  return candidates[0] ?? null;
}
