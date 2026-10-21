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
const configuredDevHttp=loadRuntimeConfig({NODE_ENV:'development',ROTAMOTO_SECRET_STORE_DIRECTORY:'/private/identity/keystore',
  ROTAMOTO_SECRET_MASTER_KEY_FILE:'/private/identity/keys/master.key'});
assert.equal(configuredDevHttp.secretStoreDirectory,null,'HTTP development context cannot see the keystore');
assert.equal(configuredDevHttp.secretMasterKeyFile,null,'HTTP development context cannot see the master key');
const operatorConfig=loadRuntimeConfig({NODE_ENV:'development',ROTAMOTO_SECRET_STORE_DIRECTORY:'/private/identity/keystore',
  ROTAMOTO_SECRET_MASTER_KEY_FILE:'/private/identity/keys/master.key'},{context:'operator'});
assert.equal(operatorConfig.secretStoreDirectory,'/private/identity/keystore','standalone operator context can use the local keystore');
assert.equal(operatorConfig.secretMasterKeyFile,'/private/identity/keys/master.key');
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',
  ROTAMOTO_SECRET_STORE_DIRECTORY:'/private/identity/keystore',ROTAMOTO_SECRET_MASTER_KEY_FILE:'/private/identity/keys/master.key'},
  {context:'operator'}),/não pode usar configuração E2E/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development'},{context:'unknown'}),/Contexto de configuração inválido/u);
const e2e=loadRuntimeConfig({NODE_ENV:'test',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e'});
assert.equal(e2e.databaseUrl,'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e');
assert.equal(e2e.nodeEnv,'test');
const isolatedE2e=loadRuntimeConfig({NODE_ENV:'test',ROTAMOTO_E2E_RUNTIME_ROLE:'rotamoto_e2e_app',
  E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_e2e_app@127.0.0.1:5432/rotamoto_e2e'});
assert.equal(isolatedE2e.databaseName,'rotamoto_e2e');
assert.equal(isolatedE2e.databaseUser,'rotamoto_app','E2E session activates only the existing application role');
assert.equal(isolatedE2e.databaseSessionUser,'rotamoto_e2e_app','login role remains E2E-exclusive');
assert.equal(isolatedE2e.databaseSessionOptions,'-c role=rotamoto_app');
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',ROTAMOTO_E2E_RUNTIME_ROLE:'rotamoto_e2e_app',
  E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e'}),/role runtime E2E configurada/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',ROTAMOTO_E2E_RUNTIME_ROLE:'rotamoto',
  E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto@127.0.0.1:5432/rotamoto_e2e'}),/ROLE não permitida/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test'}),/E2E_RUNTIME_DATABASE_URL é obrigatória/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto'}),/rotamoto_e2e/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@db.example:5432/rotamoto_e2e'}),/PostgreSQL local/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e'}),/Use E2E_RUNTIME_DATABASE_URL/u);
const localRoad=loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',
  ROUTEMOTO_ROUTE_DISTANCE_URL:'http://127.0.0.1:5000',ROUTEMOTO_ROUTE_DISTANCE_VERSION:'local-map-1'});
assert.deepEqual(localRoad.routeDistance,{enabled:true,provider:'osrm',baseUrl:'http://127.0.0.1:5000',version:'local-map-1',profile:'driving-car',credentialConfigured:false,timeoutMs:2500,requestsPerMinute:null});
const orsRoute=loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_PROVIDER:'ors',
  ROUTEMOTO_ROUTE_DISTANCE_URL:'https://api.heigit.org/openrouteservice',ROUTEMOTO_ROUTE_DISTANCE_API_KEY:'synthetic-config-key'});
assert.equal(orsRoute.routeDistance.provider,'ors');assert.equal(orsRoute.routeDistance.baseUrl,'https://api.heigit.org/openrouteservice');
assert.equal(orsRoute.routeDistance.credentialConfigured,true);
assert.equal(Object.hasOwn(orsRoute.routeDistance,'apiKey'),false,'runtime config does not copy the secret into the route configuration object');
assert.equal(orsRoute.routeDistance.requestsPerMinute,40);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_PROVIDER:'ors',ROUTEMOTO_ROUTE_DISTANCE_URL:'https://api.heigit.org/unexpected/path'}),/base HTTP/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'test',E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',
  ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_PROVIDER:'ors',ROUTEMOTO_ROUTE_DISTANCE_URL:'https://api.heigit.org/openrouteservice'}),/API_KEY somente no backend/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_PROVIDER:'unknown'}),/deve ser osrm ou ors/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true'}),/exige ROUTEMOTO_ROUTE_DISTANCE_URL/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_URL:'http://example.org'}),/HTTPS/u);
assert.throws(()=>loadRuntimeConfig({NODE_ENV:'development',ROUTEMOTO_ROUTE_DISTANCE_ENABLED:'true',ROUTEMOTO_ROUTE_DISTANCE_URL:'http://127.0.0.1:5000?token=x'}),/base HTTP/u);
const localOfficial=loadRuntimeConfig({NODE_ENV:'development',PORT:'8788',ALLOWED_ORIGINS:'http://localhost:8081,http://localhost:8082'});
assert.deepEqual(localOfficial.allowedOrigins,['http://localhost:8081','http://localhost:8082'],
  'explicit local API origins replace the development fallback instead of inheriting the E2E origin');
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
