// Table of requests a USD file can author and what the request policy must
// do with each. usage: node --test packages/viewer/test/request-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPolicy } from '../src/load-core.js';

const HUB = 'https://huggingface.co/datasets/o/r/resolve/main/pkg/root.usda';
const MODEL = 'https://huggingface.co/o/m/resolve/main/root.usda';
const SITE = 'https://site.example/scenes/root.usda';
const REFUSED = 'refused';
const OWN = 'same-origin';
const OMIT = 'omit';

// [url, root, allowedOrigins, expected]: REFUSED, or the `credentials` to send.
const CASES = [
  // Schemes: http(s) only, whatever the case.
  ['javascript:alert(1)//x.png', HUB, [], REFUSED],
  ['JaVaScRiPt:alert(1)//x.png', SITE, ['*'], REFUSED],
  ['data:image/png;base64,AAAA', SITE, ['*'], REFUSED],
  ['blob:https://site.example/1234', SITE, ['*'], REFUSED],
  ['file:///etc/passwd', SITE, ['*'], REFUSED],
  ['ftp://site.example/a.usda', SITE, ['*'], REFUSED],
  ['omniverse://server/a.usd', HUB, ['*'], REFUSED],
  ['HTTPS://site.example/scenes/a.usda', SITE, [], OWN],
  ['HtTpS://HuggingFace.co/datasets/o/r/resolve/main/a.usda', HUB, [], OWN],
  // The root itself is the caller's choice, whatever its scheme.
  ['blob:https://site.example/1234', 'blob:https://site.example/1234', [], OWN],

  // User info, which also hides the real host.
  ['https://huggingface.co@attacker.example/x', HUB, ['*'], REFUSED],
  ['https://user:pass@huggingface.co/datasets/o/r/resolve/main/a.usda', HUB, [], REFUSED],

  // Hub repo files: credentials only for the root's own repo.
  ['https://huggingface.co/datasets/o/r/resolve/main/pkg/a.usda', HUB, [], OWN],
  ['https://huggingface.co/datasets/o/r/resolve/main/a.usda#frag', HUB, [], OWN],
  ['https://huggingface.co/datasets/o/r/resolve/main//a.usda', HUB, [], OWN],
  ['https://huggingface.co/datasets/o/other/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/victim/private/resolve/main/secret.usda', HUB, [], OMIT],
  ['https://huggingface.co/spaces/o/r/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/o/r/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/o/m/resolve/main/a.usda', MODEL, [], OWN],

  // Hub tree listings, own repo vs another.
  ['https://huggingface.co/api/datasets/o/r/tree/main/pkg?recursive=true', HUB, [], OWN],
  ['https://huggingface.co/api/datasets/o/other/tree/main', HUB, [], OMIT],

  // Every other Hub path, even with any origin allowed.
  ['https://huggingface.co/api/whoami-v2', HUB, ['*'], REFUSED],
  ['https://huggingface.co/api/settings/tokens', HUB, ['*'], REFUSED],
  ['https://huggingface.co/settings', HUB, [], REFUSED],
  ['https://huggingface.co/logout', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/blob/main/a.usda', HUB, [], REFUSED],
  ['https://huggingface.co/api/whoami-v2', SITE, ['*'], REFUSED],
  ['https://huggingface.co/api/whoami-v2.usda', HUB, [], REFUSED],

  // Endpoints and pages shaped like repo files: a reserved first segment is never a model's owner.
  ['https://huggingface.co/api/whoami-v2/resolve/x', HUB, ['*'], REFUSED],
  ['https://huggingface.co/oauth/authorize/resolve/x', HUB, ['*'], REFUSED],
  ['https://huggingface.co/api/resolve-cache/resolve/x', HUB, ['*'], REFUSED],
  ['https://huggingface.co/settings/tokens/resolve/x', HUB, [], REFUSED],
  ['https://huggingface.co/logout/x/resolve/main/a.usda', HUB, [], REFUSED],
  ['https://huggingface.co/API/whoami-v2/resolve/x', HUB, [], REFUSED],
  ['https://huggingface.co/%61pi/whoami-v2/resolve/x', HUB, [], REFUSED],
  ['https://huggingface.co/models/a/resolve/main/x', HUB, [], REFUSED],
  ['https://huggingface.co/api/models/a/b/tree/main/../../../../settings/x', HUB, [], REFUSED],
  // ... but datasets and spaces may use those names.
  ['https://huggingface.co/datasets/api/r/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/spaces/oauth/r/resolve/main/a.usda', HUB, [], OMIT],

  // Pull request revisions: an encoded slash only in the revision of resolve and tree URLs.
  ['https://huggingface.co/datasets/o/r/resolve/refs%2Fpr%2F1/pkg/a.usda', 'https://huggingface.co/datasets/o/r/resolve/refs%2Fpr%2F1/pkg/root.usda', [], OWN],
  ['https://huggingface.co/datasets/o/r/resolve/refs%2fpr%2f1/tex.png', 'https://huggingface.co/datasets/o/r/resolve/refs%2Fpr%2F1/pkg/root.usda', [], OWN],
  [
    'https://huggingface.co/api/datasets/o/r/tree/refs%2Fpr%2F1/pkg?recursive=true',
    'https://huggingface.co/datasets/o/r/resolve/refs%2Fpr%2F1/pkg/root.usda',
    [],
    OWN,
  ],
  ['https://huggingface.co/datasets/o/r/resolve/refs%2Fpr%2F1/a%2Fb.usda', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o%2Fr/x/resolve/main/a.usda', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/resolve/refs%5cpr/a.usda', HUB, [], REFUSED],
  ['https://huggingface.co/api/datasets/o/r/tree/main/a%2Fb', HUB, [], REFUSED],

  // Traversal and encodings: checked on the normalized path, encoded slashes refused.
  ['https://huggingface.co/datasets/o/r/resolve/main/../../../../../api/whoami-v2', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/resolve/main/%2e%2e/%2E%2E/%2e%2e/%2e%2e/%2e%2e/api/whoami-v2', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/resolve/main/../../../../other/r2/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/datasets/o/r/resolve/main/..%2f..%2f..%2fapi%2fwhoami-v2', HUB, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/resolve/main/%5c..%5capi', HUB, [], REFUSED],
  ['https://huggingface.co//api/whoami-v2', HUB, [], REFUSED],
  ['https://huggingface.co\\api\\whoami-v2', HUB, ['*'], REFUSED],
  ['https:\\\\attacker.example\\x.usda', HUB, [], REFUSED],

  // Hub hosts: hf.co (checked as the huggingface.co URL it redirects to), case, trailing dot, ports, look-alikes, plain http.
  ['https://hf.co/datasets/o/r/resolve/main/a.usda', HUB, [], OWN],
  ['https://hf.co/datasets/o/other/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co/datasets/o/r/resolve/main/a.usda', 'https://hf.co/datasets/o/r/resolve/main/pkg/root.usda', [], OWN],
  ['https://hf.co/datasets/o/r/resolve/main/a.usda', 'https://hf.co/datasets/o/r/resolve/main/pkg/root.usda', [], OWN],
  ['https://huggingface.co/victim/private/resolve/main/a.usda', 'https://hf.co/datasets/o/r/resolve/main/pkg/root.usda', [], OMIT],
  ['https://hf.co/api/whoami-v2', HUB, ['*'], REFUSED],
  ['https://HUGGINGFACE.CO/datasets/o/r/resolve/main/a.usda', HUB, [], OWN],
  ['https://cdn-lfs.hf.co/repos/x/y', HUB, [], OMIT],
  ['https://huggingface.co./datasets/o/r/resolve/main/a.usda', HUB, [], OMIT],
  ['https://huggingface.co./api/whoami-v2', HUB, ['*'], REFUSED],
  ['https://huggingface.co./api/settings/tokens', 'https://huggingface.co./datasets/o/r/resolve/main/root.usda', [], REFUSED],
  ['https://huggingface.co.attacker.example/x', HUB, [], REFUSED],
  ['https://xn--huggingfce-5ib.co/datasets/o/r/resolve/main/a.usda', HUB, [], REFUSED],
  ['https://huggingface.co:443/datasets/o/r/resolve/main/a.usda', HUB, [], OWN],
  ['https://huggingface.co:8443/datasets/o/r/resolve/main/a.usda', HUB, [], OMIT],
  ['http://huggingface.co/datasets/o/r/resolve/main/a.usda', HUB, ['*'], REFUSED],

  // Other hosts, local and metadata addresses: only the root's own origin or an explicit allow.
  ['https://attacker.example/beacon.usd?u=1', HUB, [], REFUSED],
  ['http://localhost/a.usda', HUB, [], REFUSED],
  ['http://127.0.0.1:8080/admin.usda', HUB, [], REFUSED],
  ['http://[::1]/a.usda', HUB, [], REFUSED],
  ['http://169.254.169.254/latest/meta-data/', HUB, [], REFUSED],
  ['http://localhost:8080/b.usda', 'http://localhost:8080/a.usda', [], OWN],

  // A non-Hub root: its own origin with credentials, others only if allowed.
  ['https://site.example/other/t.png', SITE, [], OWN],
  ['http://site.example/t.png', SITE, [], REFUSED],
  ['https://evil.example/t.png', SITE, [], REFUSED],
  ['https://huggingface.co/datasets/o/r/resolve/main/a.usda', SITE, [], REFUSED],

  // allowedOrigins: exact origins, or '*' for any, never with credentials.
  ['https://cdn.example/t.png', SITE, ['https://cdn.example'], OMIT],
  ['https://other.example/t.png', SITE, ['https://cdn.example'], REFUSED],
  ['https://evil.example/t.png', SITE, ['*'], OMIT],
  ['http://169.254.169.254/latest/meta-data/', SITE, ['*'], OMIT],
  ['https://huggingface.co/datasets/o/r/resolve/main/a.usda', SITE, ['https://huggingface.co'], OMIT],
  ['https://evil.example/t.png', HUB, ['https://evil.example'], OMIT],
];

test('requestPolicy table', () => {
  for (const [url, root, allowedOrigins, expected] of CASES) {
    const policy = requestPolicy(url, root, allowedOrigins);
    const label = `${url} from ${root} with [${allowedOrigins}]`;
    if (expected === REFUSED) {
      assert.ok(policy.refused, `should refuse ${label}`);
      continue;
    }
    assert.deepEqual(policy, { credentials: expected, referrerPolicy: 'no-referrer' }, label);
  }
});
