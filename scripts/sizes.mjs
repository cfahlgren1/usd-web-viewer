// Prints raw, gzip (-9) and brotli (q11) sizes of the given files.
import fs from 'node:fs';
import zlib from 'node:zlib';

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const gzip = zlib.gzipSync(buf, { level: 9 }).length;
  const brotli = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  console.log(`${file}: raw ${kb(buf.length)}  gzip ${kb(gzip)}  brotli ${kb(brotli)}`);
}
