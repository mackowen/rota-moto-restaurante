'use strict';
const assert=require('node:assert/strict');
const {loadRuntimeConfig,validateDatabaseUrl,hostAllowed,resolveClientAddress}=require('../backend/runtime/config');
const {loadSecretProvider}=require('../backend/runtime/secret-provider');

const dev=loadRuntimeConfig({NODE_ENV:'development'});
assert.equal(dev.host,'127.0.0.1');
assert.equal(dev.databaseUrl,'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto');
assert.equal(dev.trustProxy,false);
assert.equal(dev.routeDistance.enabled,false);
assert.equal(dev.routeDistance.baseUrl,null);
const localRoad=loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',
  ROUTEMOTO_ROUTE_DISTANCE_URL:'http://127.0.0.1:5000',ROUTEMOTO_ROUTE_DISTANCE_VERSION:'local-map-1'});
assert.deepEqual(localRoad.routeDistance,{enabled:true,baseUrl:'http://127.0.0.1:5000',version:'local-map-1',timeoutMs:2500});
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true'}),/exige ROUTEMOTO_ROUTE_DISTANCE_URL/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_URL:'http://example.org'}),/HTTPS/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_URL:'http://127.0.0.1:5000?token=x'}),/base HTTP/u);
assert.equal(hostAllowed('127.0.0.1:8787',dev.allowedHosts,false),true);
assert.equal(hostAllowed('[::1]:8787',dev.allowedHosts,false),true);
assert.equal(hostAllowed('attacker.example',dev.allowedHosts,false),false);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'production'}),/HOST deve ser explicitamente loopback/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:''}),/NODE_ENV inválido/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'production',HOST:'127.0.0.1',PORT:'8787'}),/DATABASE_URL runtime é obrigatória/u);
const prod={NODE_ENV:'production',HOST:'127.0.0.1',PORT:'8787',
  DATABASE_URL:'postgresql://rotamoto_app@db.internal:5432/rotamoto?sslmode=verify-full',
  ALLOWED_ORIGINS:'https://app.example.test',ALLOWED_HOSTS:'api.example.test',
  TRUSTED_PROXY_ADDRESSES:'127.0.0.1',DATABASE_TLS_CA_FILE:'/etc/ssl/certs/rotamoto-ca.pem',
  ROTAMOTO_SECRET_PROVIDER_MODULE:'/opt/rotamoto-secrets/provider.js'};
const config=loadRuntimeConfig(prod);
assert.equal(config.routeDistance.enabled,false,'road engine is disabled unless explicitly configured');
assert.throws(()=>loadRuntimeConfig({...prod,ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_URL:'http://router.internal:5000'}),/HTTPS/u);
assert.equal(config.production,true);
assert.equal(config.trustProxy,true);
assert.equal(config.deliveryQrKeyRef,null);
assert.equal(config.deliveryQrKeyId,null);
const qrConfig=loadRuntimeConfig({...prod,ROTAMOTO_DELIVERY_QR_SIGNING_KEY_REF:'local-v1:00000000-0000-4000-8000-000000000000',ROTAMOTO_DELIVERY_QR_KEY_ID:'install-qr-key-01'});
assert.equal(qrConfig.deliveryQrKeyId,'install-qr-key-01');
assert.throws(()=>loadRuntimeConfig({...prod,ROTAMOTO_DELIVERY_QR_KEY_ID:'install-qr-key-01'}),/QR inválida/u);
assert.throws(()=>loadRuntimeConfig({...prod,ROTAMOTO_DELIVERY_QR_SIGNING_KEY_REF:'ref\nleak',ROTAMOTO_DELIVERY_QR_KEY_ID:'install-qr-key-01'}),/QR inválida/u);
assert.equal(hostAllowed('api.example.test',config.allowedHosts,true),true);
assert.equal(hostAllowed('attacker.example',config.allowedHosts,true),false);
assert.equal(resolveClientAddress({socket:{remoteAddress:'127.0.0.1'},headers:{'x-forwarded-for':'198.51.100.23'}},config),'198.51.100.23');
assert.equal(resolveClientAddress({socket:{remoteAddress:'192.0.2.5'},headers:{'x-forwarded-for':'198.51.100.23'}},config),'192.0.2.5');
assert.equal(loadRuntimeConfig({...prod,PUBLIC_BASE_URL:'https://rota.example.test'}).smtp.baseUrl,'https://rota.example.test');
assert.throws(()=>loadRuntimeConfig({...prod,PUBLIC_BASE_URL:'http://rota.example.test'}),/HTTPS/u);
const smtp=loadRuntimeConfig({...prod,SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_SECURE:'false',SMTP_USER:'mailer',SMTP_PASSWORD_REF:'local-v1:00000000-0000-4000-8000-000000000000',SMTP_FROM:'RotaMoto <noreply@example.test>',PUBLIC_BASE_URL:'https://rota.example.test'});
assert.equal(smtp.smtp.host,'smtp.example.test');
const localSecrets=loadRuntimeConfig({...prod,ROTAMOTO_SECRET_PROVIDER_MODULE:'',ROTAMOTO_SECRET_STORE_DIRECTORY:'/var/lib/rotamoto/secrets',ROTAMOTO_SECRET_MASTER_KEY_FILE:'/etc/rotamoto/master.key',ROTAMOTO_DATABASE_PASSWORD_REF:'local-v1:00000000-0000-4000-8000-000000000000'});
assert.equal(localSecrets.secretStoreDirectory,'/var/lib/rotamoto/secrets');
assert.throws(()=>loadRuntimeConfig({...prod,ROTAMOTO_SECRET_PROVIDER_MODULE:'',ROTAMOTO_SECRET_STORE_DIRECTORY:'/var/lib/rotamoto/secrets'}),/keystore local completo/u);
for(const override of [
  {DATABASE_URL:'postgresql://rotamoto_migrator@db.internal:5432/rotamoto'},
  {DATABASE_URL:'postgresql://rotamoto_app:plaintext@db.internal:5432/rotamoto'},
  {ALLOWED_ORIGINS:'http://app.example.test'},
  {HOST:'0.0.0.0'},
  {MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@db.internal:5432/rotamoto'},
  {TRUST_PROXY:'*'},
  {TRUSTED_PROXY_ADDRESSES:''},
  {DATABASE_URL:'postgresql://rotamoto_app@db.internal:5432/rotamoto'},
  {DATABASE_URL:'postgresql://rotamoto_app@db.internal:5432/rotamoto?sslmode=verify-full&password=leak'},
  {DATABASE_URL:'postgresql://rotamoto_app@db.internal:5432/rotamoto?sslmode=verify-full#secret'},
  {DATABASE_TLS_CA_FILE:''},
  {ROTAMOTO_SECRET_PROVIDER_MODULE:''}
]) assert.throws(()=>loadRuntimeConfig({...prod,...override}),Error);
assert.throws(()=>validateDatabaseUrl('postgresql://rotamoto_app@127.0.0.1:5432/rotamoto',{production:true}),/loopback/u);
assert.throws(()=>loadSecretProvider(require.resolve('../backend/runtime/config')),/fora do repositório/u);
console.log('runtime configuration fail-closed tests: OK');
