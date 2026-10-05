'use strict';
const crypto = require('node:crypto');
const { COOKIE_NAME } = require('../identity/http');
const { createRateLimiter } = require('../identity/http');
const { MAX_PROOF_BYTES } = require('./filesystem-object-store');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function fail(code, status, message='Solicitação não autorizada.') { return Object.assign(new Error(message), { code, status }); }
function cookie(req) {
  const values=String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${COOKIE_NAME}=`));
  if(values.length!==1)return null;const token=values[0].slice(COOKIE_NAME.length+1);return /^[A-Za-z0-9_-]{43}$/u.test(token)?token:null;
}
function sendJson(res,status,body){const data=Buffer.from(JSON.stringify(body));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Length':data.length});res.end(data)}
function sameOrigin(req, allowed) {
  const origin=req.headers.origin;if(!origin)return;
  let parsed;try{parsed=new URL(origin)}catch(_){throw fail('ORIGIN_INVALID',403)}
  const list=Array.isArray(allowed)?allowed:[allowed];
  const protocol=req.socket?.encrypted?'https:':'http:';
  const requestOrigin=`${protocol}//${String(req.headers.host||'').toLowerCase()}`;
  if(parsed.origin!==requestOrigin&&!list.includes(parsed.origin))throw fail('ORIGIN_INVALID',403);
}

function createProofMediaHttpHandler({identityService,mediaStorage,allowedOrigin,rateLimiter=createRateLimiter()}){
  const upload=/^\/api\/domain\/deliveries\/([0-9a-f-]{36})\/proofs\/media$/iu;
  const read=/^\/api\/domain\/deliveries\/([0-9a-f-]{36})\/proofs\/([0-9a-f-]{36})\/media$/iu;
  return async function proofMediaHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1'),up=upload.exec(url.pathname),get=read.exec(url.pathname);
    if(!up&&!get)return url.pathname.startsWith('/api/domain/deliveries/')&&url.pathname.includes('/proofs/')?false:false;
    const requestId=req.requestId||crypto.randomUUID();res.req=req;
    try{
      const deliveryId=(up||get)[1].toLowerCase();if(!UUID.test(deliveryId))throw fail('NOT_FOUND',404);
      const method=up?'POST':'GET';if(req.method!==method){res.writeHead(405,{Allow:method,'Cache-Control':'no-store'});res.end();return true;}
      const rate=rateLimiter.consume(`${req.clientIp||req.socket.remoteAddress||'unknown'}:proof-media:${method}`,'default');if(!rate.allowed)throw fail('RATE_LIMITED',429,'Limite de solicitações excedido.');
      if(up){sameOrigin(req,allowedOrigin);const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(!['image/png','image/jpeg'].includes(type))throw fail('UNSUPPORTED_MEDIA_TYPE',415);
        const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length<1)throw fail('INVALID_INPUT',400);if(length>MAX_PROOF_BYTES){req.resume();throw fail('PAYLOAD_TOO_LARGE',413)}
        const token=cookie(req);if(!token)throw fail('UNAUTHENTICATED',401);
        const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string')throw fail('CSRF_INVALID',403);
        let objectRef=null,stored=null;
        try{
          stored=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
            if(!await identityService.verifyCsrf(client,principal.session_id,csrf))throw fail('CSRF_INVALID',403);
            if(!principal.driver_id)throw fail('DRIVER_LINK_REQUIRED',403);
            const delivery=await client.query(`SELECT payload->>'driverId' AS driver_id,deleted_at FROM rotamoto.domain_records
              WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Delivery'`,[principal.company_id,deliveryId]);
            if(!delivery.rowCount||delivery.rows[0].deleted_at||delivery.rows[0].driver_id!==principal.driver_id)throw fail('NOT_FOUND',404);
            const result=await mediaStorage.storeProof({companyId:principal.company_id,deliveryId,contentType:type,source:req});objectRef=result.storageRef;
            if(result.sizeBytes!==length)throw fail('INVALID_INPUT',400,'Tamanho do upload divergente.');return result;
          },'sync.push');
        }catch(error){if(objectRef)await mediaStorage.remove?.(objectRef).catch(()=>{});throw error;}
        sendJson(res,201,{provider:stored.provider,storageRef:stored.storageRef,mimeType:stored.mimeType,sizeBytes:stored.sizeBytes,sha256:stored.sha256,requestId});return true;
      }
      const token=cookie(req);if(!token)throw fail('UNAUTHENTICATED',401);
      const proofId=get[2].toLowerCase();if(!UUID.test(proofId))throw fail('NOT_FOUND',404);
      const result=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
        const proof=await client.query(`SELECT payload,related_record_id::text AS delivery_id FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='DeliveryProof' AND related_entity_type='Delivery'
          AND related_record_id=$3::uuid AND deleted_at IS NULL`,[principal.company_id,proofId,deliveryId]);
        if(!proof.rowCount)throw fail('NOT_FOUND',404);
        const delivery=await client.query(`SELECT payload->>'driverId' AS driver_id,deleted_at FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Delivery'`,[principal.company_id,deliveryId]);
        if(!delivery.rowCount||delivery.rows[0].deleted_at)throw fail('NOT_FOUND',404);
        if(principal.driver_id!==delivery.rows[0].driver_id){
          const admin=await client.query(`SELECT 1 FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2
            AND catalog_version=1 AND permission_key='company.manage'`,[principal.company_id,principal.role_id]);
          if(!admin.rowCount)throw fail('NOT_FOUND',404);
          if(!principal.mfa_verified_at)throw fail('MFA_REQUIRED',403);
        }
        const media=proof.rows[0].payload.media;if(!media||media.storageRef?.provider!=='filesystem-v1')throw fail('NOT_FOUND',404);
        const parts=String(media.storageRef.objectKey||'').split('/');if(parts[1]!==principal.company_id||parts[3]!==deliveryId)throw fail('NOT_FOUND',404);
        return mediaStorage.read(media.storageRef,{mimeType:media.mimeType,sizeBytes:media.sizeBytes,sha256:media.sha256});
      },'sync.pull');
      res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.sizeBytes,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Disposition':'attachment; filename="delivery-proof"'});res.end(result.data);return true;
    }catch(error){if(up)req.resume();const status=error.status||({'UNAUTHENTICATED':401,'FORBIDDEN':403,'MFA_REQUIRED':403,'CSRF_INVALID':403,'ORIGIN_INVALID':403,'DRIVER_LINK_REQUIRED':403,'NOT_FOUND':404,'INVALID_INPUT':400,'UNSUPPORTED_MEDIA_TYPE':415,'PAYLOAD_TOO_LARGE':413,'MEDIA_STORAGE_UNAVAILABLE':503,'RATE_LIMITED':429}[error.code]||500);sendJson(res,status,{error:{code:status>=500?'INTERNAL_ERROR':error.code,message:status>=500?'Falha interna ao processar mídia.':error.message}});return true;}
  };
}
module.exports={createProofMediaHttpHandler};
