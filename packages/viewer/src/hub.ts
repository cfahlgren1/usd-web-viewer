// Hugging Face Hub file URLs: `import { hubUrl } from 'usd-web-viewer/hub'`.

const PREFIX = { dataset: 'datasets/', model: '', space: 'spaces/' };

/**
 * The URL that serves `path` from a Hub repo (it redirects to the CDN). Pass
 * a commit sha as `revision` so every layer of a multi-layer stage comes from
 * the same commit.
 * @param repo  e.g. `nvidia/simready-assets`
 * @param path  file path inside the repo
 */
export function hubUrl(
  repo: string,
  path: string,
  {
    revision = 'main',
    repoType = 'dataset',
    endpoint = 'https://huggingface.co',
  }: { revision?: string | undefined; repoType?: 'dataset' | 'model' | 'space' | undefined; endpoint?: string | undefined } = {},
): string {
  if (!(repoType in PREFIX)) throw new TypeError(`repoType must be dataset, model or space, not ${repoType}`);
  const encode = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return `${endpoint.replace(/\/+$/, '')}/${PREFIX[repoType]}${repo}/resolve/${encodeURIComponent(revision)}/${encode(path)}`;
}
