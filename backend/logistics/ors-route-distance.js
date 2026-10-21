'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');

const MAX_POINTS = 50;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DISTANCE_M = 5_000_000;
const ALLOWED_PROFILES = new Set(['driving-car','driving-hgv','cycling-regular','cycling-road','cycling-mountain','cycling-electric','foot-walking','foot-hiking','wheelchair']);

function normalizeBaseUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('ROUTE_DISTANCE_URL inválida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['/','/openrouteservice','/ors'].includes(url.pathname.replace(/\/$/u,'' )||'/'))
    throw new Error('ORS_ROUTE_DISTANCE_URL deve ser base HTTPS válida, sem credenciais, query ou fragmento.');
  return url.toString().replace(/\/$/u, '');
}

function normalizePoints(input) {
  if (!input || !Array.isArray(input.deliveryIds) || input.deliveryIds.length < 2 || input.deliveryIds.length > MAX_POINTS ||
      new Set(input.deliveryIds).size !== input.deliveryIds.length || !input.coordinatesByDeliveryId || typeof input.coordinatesByDeliveryId !== 'object') return null;
  const points=[];
  for(const id of input.deliveryIds){
    const point=input.coordinatesByDeliveryId[id];
    if(!point||!Number.isFinite(point.latitude)||!Number.isFinite(point.longitude)||point.latitude < -90||point.latitude > 90||point.longitude < -180||point.longitude > 180)return null;
    points.push([Number(point.longitude.toFixed(6)),Number(point.latitude.toFixed(6))]);
  }
  return points;
}

async function boundedJson(response) {
  const type=String(response.headers?.get?.('content-type')||'').toLowerCase();
  if(!type.includes('json'))return {body:null,reason:'ROUTE_DISTANCE_CONTENT_TYPE_INVALID'};
  const length=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(length)&&length>MAX_RESPONSE_BYTES)return {body:null,reason:'ROUTE_DISTANCE_RESPONSE_TOO_LARGE'};
  if(!response.body?.getReader)return {body:null,reason:'ROUTE_DISTANCE_RESPONSE_INVALID'};
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_RESPONSE_BYTES){await reader.cancel();return {body:null,reason:'ROUTE_DISTANCE_RESPONSE_TOO_LARGE'};}chunks.push(Buffer.from(part.value));}
  try{return {body:JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')),reason:null};}catch(_){return {body:null,reason:'ROUTE_DISTANCE_JSON_INVALID'};}
}

function createOrsRouteDistanceProvider({baseUrl='https://api.heigit.org/openrouteservice',apiKey,profile='driving-car',timeoutMs=2500,
  fetchImpl=globalThis.fetch,clock=()=>new Date(),cacheTtlMs=30_000,maxCacheEntries=500,requestsPerMinute=40}={}){
  const endpoint=normalizeBaseUrl(baseUrl);
  if(typeof apiKey!=='string'||!apiKey.trim()||apiKey.length>512||/[\r\n\u0000]/u.test(apiKey))throw new TypeError('ORS API key is required in the backend environment.');
  if(!ALLOWED_PROFILES.has(profile)||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>10_000||
      !Number.isInteger(cacheTtlMs)||cacheTtlMs<0||cacheTtlMs>300_000||!Number.isInteger(maxCacheEntries)||maxCacheEntries<0||maxCacheEntries>5_000||
      !Number.isInteger(requestsPerMinute)||requestsPerMinute<1||requestsPerMinute>120||typeof fetchImpl!=='function')
    throw new TypeError('Invalid ORS route provider configuration.');
  const providerId=`openrouteservice-${profile}-v2`;
  const configuration=crypto.createHash('sha256').update(`${endpoint}\0${profile}\0${crypto.createHash('sha256').update(apiKey).digest('hex')}`).digest('hex').slice(0,24);
  const cache=new Map(),inFlight=new Map(),requestTimes=[];
  const unavailable=(reason,status='unavailable')=>({status,geometry:null,distanceM:null,reason,provenance:null});
  async function request(input){
    if(!endpoint)return unavailable('ROUTE_DISTANCE_PROVIDER_NOT_CONFIGURED');
    const points=normalizePoints(input);if(!points)return unavailable('ROUTE_DISTANCE_COORDINATES_INVALID','unknown');
    const tenant=typeof input.companyId==='string'?input.companyId:'';
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify([tenant,configuration,points])).digest('hex');
    const now=clock().getTime(),cached=cache.get(fingerprint);
    if(cached&&cached.expiresAt>now){cache.delete(fingerprint);cache.set(fingerprint,cached);return cached.value;}
    if(cached)cache.delete(fingerprint);
    if(inFlight.has(fingerprint))return inFlight.get(fingerprint);
    const minuteAgo=now-60_000;while(requestTimes.length&&requestTimes[0]<=minuteAgo)requestTimes.shift();
    if(requestTimes.length>=requestsPerMinute)return unavailable('ROUTE_DISTANCE_RATE_LIMITED');
    requestTimes.push(now);
    const pending=Promise.resolve().then(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await fetchImpl(`${endpoint}/v2/directions/${profile}/geojson`,{method:'POST',redirect:'error',signal:controller.signal,
          headers:{accept:'application/geo+json, application/json','content-type':'application/json',Authorization:apiKey},
          body:JSON.stringify({coordinates:points})});
        if(!response)return unavailable('ROUTE_DISTANCE_PROVIDER_UNAVAILABLE');
        const parsed=await boundedJson(response),body=parsed.body;
        if(!response.ok){
          const reason=response.status===401||response.status===403?'ROUTE_DISTANCE_CREDENTIAL_REJECTED':response.status===429?'ROUTE_DISTANCE_RATE_LIMITED':
            response.status>=500?'ROUTE_DISTANCE_HTTP_SERVER_ERROR':parsed.reason?parsed.reason:'ROUTE_DISTANCE_HTTP_ERROR';
          return unavailable(reason);
        }
        if(parsed.reason)return unavailable(parsed.reason,'unknown');
        const feature=body?.type==='FeatureCollection'&&Array.isArray(body.features)&&body.features.length===1?body.features[0]:null;
        const coords=feature?.geometry?.coordinates,summary=feature?.properties?.summary;
        if(feature?.type!=='Feature'||feature.geometry?.type!=='LineString'||!Array.isArray(coords)||coords.length<2||coords.length>20_000||
          coords.some(p=>!Array.isArray(p)||p.length!==2||!Number.isFinite(p[0])||p[0]<-180||p[0]>180||!Number.isFinite(p[1])||p[1]<-90||p[1]>90)||
          !summary||!Number.isFinite(summary.distance)||summary.distance<0||summary.distance>MAX_DISTANCE_M)
          return unavailable('ROUTE_GEOMETRY_SCHEMA_INVALID','unknown');
        if(Array.isArray(feature.properties.way_points)&&feature.properties.way_points.length!==points.length)
          return unavailable('ROUTE_GEOMETRY_SCHEMA_INVALID','unknown');
        const value={status:'known',geometry:{type:'LineString',coordinates:coords.map(p=>[Number(p[0].toFixed(6)),Number(p[1].toFixed(6))])},
          distanceM:Math.round(summary.distance),reason:null,provenance:{kind:'canonical',providerId,configuration,evaluatedAt:clock().toISOString()}};
        if(cacheTtlMs&&maxCacheEntries){cache.set(fingerprint,{value,expiresAt:now+cacheTtlMs});while(cache.size>maxCacheEntries)cache.delete(cache.keys().next().value);}
        return value;
      }catch(_){return unavailable('ROUTE_DISTANCE_PROVIDER_UNAVAILABLE');}
      finally{clearTimeout(timer);inFlight.delete(fingerprint);}
    });
    inFlight.set(fingerprint,pending);return pending;
  }
  return Object.freeze({providerId,profile,async calculateGeometry(input){return request(input);},async calculateDistance(input){
    const value=await request(input);return {status:value.status,distanceM:value.distanceM,reason:value.reason,provenance:value.provenance};
  },cacheStats(){return Object.freeze({entries:cache.size,inFlight:inFlight.size});}});
}

module.exports={createOrsRouteDistanceProvider,MAX_POINTS,MAX_RESPONSE_BYTES};
