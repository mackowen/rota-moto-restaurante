const fs=require('fs');
const src=fs.readFileSync('./ifood-integration.js','utf8');
for(const x of ['normalize','simulateOrder','receiveLocalEvent','processLocalEvent','acknowledgeLocal','diagnostics','prepareOAuth']) if(!src.includes(x)) throw new Error('missing '+x);
const app=fs.readFileSync('./app.js','utf8');
for(const x of ['Pedidos e integrações','data-ifood-simulate-event','data-ifood-diagnostics','data-ifood-clear-queue','processedEventIds','queue']) if(!app.includes(x)) throw new Error('missing app '+x);
console.log('ifood structure tests: OK');
