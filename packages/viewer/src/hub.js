// Hugging Face Hub file URLs: `import { hubUrl } from 'usd-web-viewer/hub'`.

const PREFIX = { dataset: 'datasets/', model: '', space: 'spaces/' };

/**
 * The URL that serves `path` from a Hub repo (it redirects to the CDN). Pass
 * a commit sha as `revision` so every layer of a multi-layer stage comes from
 * the same commit.
 * @param {string} repo  e.g. `nvidia/simready-assets`
 * @param {string} path  file path inside the repo
 * @param {{ revision?: string, repoType?: 'dataset' | 'model' | 'space', endpoint?: string }} [options]
 */
export function hubUrl(repo, path, { revision = 'main', repoType = 'dataset', endpoint = 'https://huggingface.co' } = {}) {
  if (!(repoType in PREFIX)) throw new TypeError(`repoType must be dataset, model or space, not ${repoType}`);
  const encode = (p) => p.split('/').map(encodeURIComponent).join('/');
  return `${endpoint.replace(/\/+$/, '')}/${PREFIX[repoType]}${repo}/resolve/${encodeURIComponent(revision)}/${encode(path)}`;
}
