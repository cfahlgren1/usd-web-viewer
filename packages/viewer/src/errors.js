/** Why a load failed: `aborted`, `fetch` (root layer or a resource limit), `compose`, `worker` or `webgl`. */
export class UsdLoadError extends Error {
  /**
   * @param {'aborted' | 'fetch' | 'compose' | 'worker' | 'webgl'} code
   * @param {string} message
   * @param {{ url?: string, status?: number, cause?: unknown }} [details]
   */
  constructor(code, message, { url, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'UsdLoadError';
    this.code = code;
    if (url !== undefined) this.url = url;
    if (status !== undefined) this.status = status;
  }
}
