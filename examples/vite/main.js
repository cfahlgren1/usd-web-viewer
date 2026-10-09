import 'usd-web-viewer/element';
import { hubUrl } from 'usd-web-viewer/hub';

const viewer = document.getElementById('viewer');
viewer.addEventListener('load', (e) => (window.loaded = e.detail));
viewer.addEventListener('error', (e) => (window.loadError = `${e.error.code}: ${e.error.message}`));
viewer.setAttribute(
  'src',
  new URLSearchParams(location.search).get('src') ?? hubUrl('LGElectronics/simready-assets', 'laptop_17z90ur/simready_usd/laptop_17z90ur.usd'),
);
