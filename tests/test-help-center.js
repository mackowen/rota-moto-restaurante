'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8'),sw=fs.readFileSync('sw.js','utf8');
for(const title of ['Primeiros passos','Configurar empresa','Localização do estabelecimento','Cadastrar e gerenciar motoboys','Criar ou receber pedidos','Origem do pedido','Preparar entregas','Criar e organizar Rotas','Frota própria e parceiros','Provas de entrega','Imprimir comandas','Custos e inteligência logística','Ganhos','Relatórios','Trabalhar offline','Pendente de publicação','Conflitos e sincronização','Segurança','Problemas comuns'])assert.ok(app.includes(title),`help topic: ${title}`);
assert.match(app,/function help\(\)/u);assert.match(app,/helpSearch.*addEventListener\("input"/u);assert.match(app,/canModule\(tab\).*tab==='help'/u);assert.match(sw,/app\.js\?v=40\.3/u,'app bundle with local help is in offline shell');
console.log('Restaurant local Help Center content/search/offline contract: PASS');
