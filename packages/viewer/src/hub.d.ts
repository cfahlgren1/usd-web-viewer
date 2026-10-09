/** The URL serving `path` from a Hugging Face Hub repo. Pass a commit sha as `revision` for reproducible multi-layer loads. */
export function hubUrl(
  repo: string,
  path: string,
  options?: { revision?: string | undefined; repoType?: 'dataset' | 'model' | 'space' | undefined; endpoint?: string | undefined },
): string;
