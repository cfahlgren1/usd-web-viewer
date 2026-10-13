import { createViewer } from 'usd-web-viewer';

const viewer = createViewer(document.getElementById('viewer'));
const src =
  new URLSearchParams(location.search).get('src') ??
  'https://huggingface.co/datasets/LGElectronics/simready-assets/resolve/main/laptop_17z90ur/simready_usd/laptop_17z90ur.usd';
viewer.load(src).then(
  (result) => (window.loaded = result.info),
  (error) => (window.loadError = `${error.code}: ${error.message}`),
);
