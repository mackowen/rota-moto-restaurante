'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function readAssetManifest(root = path.resolve(__dirname, '../..')) {
  const context = vm.createContext({ self: {} });
  vm.runInContext(fs.readFileSync(path.join(root, 'asset-manifest.js'), 'utf8'), context);
  return JSON.parse(JSON.stringify(context.self.RotaMotoAssetManifest));
}
module.exports = { readAssetManifest };
