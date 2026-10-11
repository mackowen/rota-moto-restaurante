const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
fs.mkdirSync(vendor, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'map-runtime.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  outfile: path.join(vendor, 'rotamoto-map-runtime.js'),
  legalComments: 'external',
  sourcemap: false
});
fs.copyFileSync(require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs'), path.join(vendor, 'maplibre-gl-worker.mjs'));
fs.copyFileSync(require.resolve('maplibre-gl/dist/maplibre-gl.css'), path.join(vendor, 'maplibre-gl.css'));
