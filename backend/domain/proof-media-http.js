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
      if(up){sameOrigin(req,allowedOrigin);const proofId=(url.searchParams.get('proofId')||'').toLowerCase();const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();if(!['image/png','image/jpeg'].includes(type))throw fail('UNSUPPORTED_MEDIA_TYPE',415);
        const length=Number(req.headers['content-length']);if(!Number.isSafeInteger(length)||length<1)throw fail('INVALID_INPUT',400);if(length>MAX_PROOF_BYTES){req.resume();throw fail('PAYLOAD_TOO_LARGE',413)}
        const token=cookie(req);if(!token)throw fail('UNAUTHENTICATED',401);
        const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string')throw fail('CSRF_INVALID',403);
        let objectRef=null,objectCreated=false,stored=null;
        try{
          stored=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
            if(!await identityService.verifyCsrf(client,principal.session_id,csrf))throw fail('CSRF_INVALID',403);
            if(!UUID.test(proofId||''))throw fail('INVALID_INPUT',400,'Identificador da prova inválido.');
            if(!principal.driver_id)throw fail('DRIVER_LINK_REQUIRED',403);
            // Shared barrier with coordinated backups and garbage collection.
            // Hold it in this transaction from before blob creation through intent commit.
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['rotamoto:proof-media:snapshot:v1']);
            const delivery=await client.query(`SELECT payload->>'driverId' AS driver_id,deleted_at FROM rotamoto.domain_records
              WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Delivery'`,[principal.company_id,deliveryId]);
            if(!delivery.rowCount||delivery.rows[0].deleted_at||delivery.rows[0].driver_id!==principal.driver_id)throw fail('NOT_FOUND',404);
            await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`proof-media:${principal.company_id}:${deliveryId}`]);
            const prior=await client.query(`SELECT delivery_id::text,object_key FROM rotamoto.proof_media_upload_intents
              WHERE company_id=$1 AND proof_id=$2::uuid FOR UPDATE`,[principal.company_id,proofId]);
            const extension=type==='image/png'?'.png':'.jpg';
            if(prior.rowCount&&(prior.rows[0].delivery_id!==deliveryId||!prior.rows[0].object_key.endsWith(`/${proofId}${extension}`)))
              throw fail('MEDIA_PROOF_CONFLICT',409,'Este comprovante já foi associado a outra entrega ou tipo de mídia.');
            const mappings=await client.query(`SELECT DISTINCT canonical_id::text FROM rotamoto.local_id_maps
              WHERE company_id=$1 AND app_key='motoboy' AND entity_type='DeliveryProof' AND local_id=$2`,[principal.company_id,proofId]);
            if(mappings.rowCount>1)throw fail('MEDIA_PROOF_CONFLICT',409,'Identificador do comprovante possui mapeamentos canônicos ambíguos.');
            const canonicalId=mappings.rows[0]?.canonical_id||proofId;
            const canonical=await client.query(`SELECT payload,related_record_id::text AS delivery_id,deleted_at FROM rotamoto.domain_records
              WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='DeliveryProof'`,[principal.company_id,canonicalId]);
            if(canonical.rowCount&&canonical.rows[0].deleted_at)throw fail('MEDIA_PROOF_CONFLICT',409,'Este comprovante canônico foi removido.');
            const canonicalMedia=canonical.rows[0]?.payload?.media||null;
            if(canonical.rowCount&&(canonical.rows[0].delivery_id!==deliveryId||canonicalMedia?.storageRef?.provider!=='filesystem-v1'))
              throw fail('MEDIA_PROOF_CONFLICT',409,'Este comprovante já foi associado a outra entrega ou armazenamento.');
            const result=await mediaStorage.storeProof({companyId:principal.company_id,deliveryId,proofId,
              ...(canonicalMedia?.storageRef?.objectKey?{objectKey:canonicalMedia.storageRef.objectKey}:{}),contentType:type,source:req});objectRef=result.storageRef;objectCreated=result.created;
            if(result.sizeBytes!==length)throw fail('INVALID_INPUT',400,'Tamanho do upload divergente.');
            if(canonicalMedia){
              if(canonicalMedia.mimeType!==result.mimeType||canonicalMedia.sizeBytes!==result.sizeBytes||canonicalMedia.sha256!==result.sha256||
                canonicalMedia.storageRef?.provider!==result.storageRef.provider||canonicalMedia.storageRef?.objectKey!==result.storageRef.objectKey)
                throw fail('MEDIA_PROOF_CONFLICT',409,'O conteúdo não corresponde ao comprovante canônico.');
              return result;
            }
            await client.query(`INSERT INTO rotamoto.proof_media_upload_intents(company_id,delivery_id,proof_id,object_key)
              VALUES($1,$2::uuid,$3::uuid,$4) ON CONFLICT(company_id,proof_id) DO NOTHING`,
            [principal.company_id,deliveryId,proofId,result.storageRef.objectKey]);
            const intent=await client.query(`SELECT delivery_id::text,object_key FROM rotamoto.proof_media_upload_intents
              WHERE company_id=$1 AND proof_id=$2::uuid`,[principal.company_id,proofId]);
            if(!intent.rowCount||intent.rows[0].delivery_id!==deliveryId||intent.rows[0].object_key!==result.storageRef.objectKey)
              throw fail('MEDIA_PROOF_CONFLICT',409,'Este comprovante já foi associado a outra entrega.');
            return result;
          },'sync.push');
        }catch(error){if(objectRef&&objectCreated)await mediaStorage.remove?.(objectRef).catch(()=>{});throw error;}
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
    }catch(error){if(up)req.resume();const status=error.status||({'UNAUTHENTICATED':401,'FORBIDDEN':403,'MFA_REQUIRED':403,'CSRF_INVALID':403,'ORIGIN_INVALID':403,'DRIVER_LINK_REQUIRED':403,'NOT_FOUND':404,'INVALID_INPUT':400,'UNSUPPORTED_MEDIA_TYPE':415,'PAYLOAD_TOO_LARGE':413,'MEDIA_STORAGE_UNAVAILABLE':503,'RATE_LIMITED':429,'MEDIA_PROOF_CONFLICT':409}[error.code]||500);sendJson(res,status,{error:{code:status>=500?'INTERNAL_ERROR':error.code,message:status>=500?'Falha interna ao processar mídia.':error.message}});return true;}
  };
}
module.exports={createProofMediaHttpHandler};
