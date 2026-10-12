const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
const maplibreVendor = path.join(vendor, 'maplibre');
fs.mkdirSync(maplibreVendor, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'map-runtime.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  outfile: path.join(maplibreVendor, 'rotamoto-map-runtime.js'),
  legalComments: 'external',
  sourcemap: false
});
fs.copyFileSync(require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs'), path.join(maplibreVendor, 'maplibre-gl-worker.js'));
fs.copyFileSync(require.resolve('maplibre-gl/dist/maplibre-gl.css'), path.join(maplibreVendor, 'maplibre-gl.css'));
