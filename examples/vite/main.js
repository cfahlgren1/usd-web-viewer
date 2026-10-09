import 'usd-web-viewer/element';
import { hubUrl } from 'usd-web-viewer';

const viewer = document.getElementById('viewer');
viewer.addEventListener('load', (e) => (window.loaded = e.detail.info));
viewer.addEventListener('error', (e) => (window.loadError = String(e.detail)));
viewer.setAttribute(
  'src',
  new URLSearchParams(location.search).get('src') ?? hubUrl('LGElectronics/simready-assets', 'laptop_17z90ur/simready_usd/laptop_17z90ur.usd'),
);
