'use strict';

const crypto = require('node:crypto');
const ACTIVE = ['CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY'];
const TERMINAL = ['DELIVERED','CANCELLED','FAILED','RETURNED'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PREFIX = 'rm-presence.v1';
const QR_TTL_SECONDS = 60;
const ACTIVE_DRIVER = new Set(['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED']);
function fail(code, message) { throw Object.assign(new Error(message), { code, name: 'RestaurantDriverQueueError' }); }
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
async function permissions(client,principal,allowed) {
  if(!principal?.role_id)fail('FORBIDDEN','Operação não autorizada.');
  const result=await client.query(`SELECT 1 FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2
    AND permission_key=ANY($3::text[]) AND catalog_version=1 LIMIT 1`,[principal.company_id,principal.role_id,allowed]);
  if(!result.rowCount)fail('FORBIDDEN','Operação não autorizada.');
}
function normalizeDriverStatus(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase();
}

function createRestaurantDriverQueueService({ clock = () => new Date(), uuid = crypto.randomUUID, qrKey = null, qrKid = null } = {}) {
  function now() { return clock(); }
  function issueToken(claims, privateKey) {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${PREFIX}.${payload}`;
    return `${input}.${crypto.sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  }
  function verifyToken(token, publicKey) {
    if (typeof token !== 'string' || token.length > 1024) fail('PRESENCE_QR_INVALID','QR de presença inválido.');
    const parts = token.split('.');
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX || !/^[A-Za-z0-9_-]+$/u.test(parts[2]) || !/^[A-Za-z0-9_-]{80,100}$/u.test(parts[3])) fail('PRESENCE_QR_INVALID','QR de presença inválido.');
    let claims;
    try { claims=JSON.parse(Buffer.from(parts[2],'base64url').toString('utf8')); } catch (_) { fail('PRESENCE_QR_INVALID','QR de presença inválido.'); }
    if (claims.v!==1 || !UUID.test(claims.c||'') || !UUID.test(claims.jti||'') || claims.kid!==qrKid ||
        !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.exp<=claims.iat || claims.exp-claims.iat>QR_TTL_SECONDS ||
        claims.iat>Math.floor(now().getTime()/1000)+5 || claims.exp<=Math.floor(now().getTime()/1000) ||
        !crypto.verify(null,Buffer.from(`${PREFIX}.${parts[2]}`),publicKey,Buffer.from(parts[3],'base64url'))) fail('PRESENCE_QR_INVALID','QR de presença inválido ou expirado.');
    return claims;
  }
  async function issueRestaurantQr(client, principal) {
    await permissions(client,principal,['orders.manage','company.manage']);
    if (!qrKey || !qrKid) fail('PRESENCE_QR_UNAVAILABLE','QR de presença seguro não está configurado.');
    const key = typeof qrKey === 'function' ? await qrKey() : qrKey;
    const keyObject = key?.type === 'private' ? key : crypto.createPrivateKey(key);
    if (keyObject.asymmetricKeyType!=='ed25519') fail('PRESENCE_QR_UNAVAILABLE','Chave de presença inválida.');
    const issued=now(),nonce=uuid(),exp=Math.floor(issued.getTime()/1000)+QR_TTL_SECONDS;
    await client.query(`INSERT INTO rotamoto.restaurant_presence_qr_nonces(company_id,nonce_id,issued_by_user_id,expires_at)
      VALUES($1,$2,$3,to_timestamp($4))`,[principal.company_id,nonce,principal.user_id,exp]);
    const claims={v:1,c:principal.company_id,jti:nonce,kid:qrKid,iat:Math.floor(issued.getTime()/1000),exp};
    return {token:issueToken(claims,keyObject),expiresAt:new Date(exp*1000).toISOString(),expiresInSeconds:QR_TTL_SECONDS};
  }
  async function assertDriver(client, principal, lock=true) {
    if (!principal?.driver_id) fail('DRIVER_LINK_REQUIRED','Esta conta não está vinculada a um motoboy.');
    const result=await client.query(`SELECT d.payload->>'status' AS status FROM rotamoto.domain_records d
      JOIN rotamoto.memberships m ON m.company_id=d.company_id AND m.driver_id=d.record_id
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Driver' AND d.deleted_at IS NULL
        AND m.user_id=$3 AND m.status='active' ${lock?'FOR UPDATE OF d,m':''}`,[principal.company_id,principal.driver_id,principal.user_id]);
    if(!result.rowCount)fail('DRIVER_LINK_REQUIRED','O vínculo desta sessão com o motoboy não está ativo.');
    return {id:principal.driver_id,status:normalizeDriverStatus(result.rows[0].status)};
  }
  async function availability(client, companyId, driverId, lock=true) {
    const result=await client.query(`SELECT status,lease_expires_at FROM rotamoto.driver_availability
      WHERE company_id=$1 AND driver_id=$2 ${lock?'FOR UPDATE':''}`,[companyId,driverId]);
    return !!(result.rowCount&&result.rows[0].status==='online'&&new Date(result.rows[0].lease_expires_at).getTime()>now().getTime());
  }
  async function activeDelivery(client,companyId,driverId) {
    const result=await client.query(`SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery' AND deleted_at IS NULL
      AND payload->>'driverId'=$2 AND upper(coalesce(payload->>'status',''))<>ALL($3::text[]) LIMIT 1`,[companyId,driverId,TERMINAL]);
    return result.rowCount>0;
  }
  async function checkIn(client,principal,input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['qrToken','gpsAccuracyM'].includes(key)))fail('INVALID_INPUT','Check-in inválido.');
    const driver=await assertDriver(client,principal,true);
    if(!ACTIVE_DRIVER.has(driver.status))fail('DRIVER_INACTIVE','Cadastro do motoboy não está habilitado.');
    if(!await availability(client,principal.company_id,driver.id,true))fail('DRIVER_NOT_AVAILABLE','Fique Online antes de registrar presença.');
    if(await activeDelivery(client,principal.company_id,driver.id))fail('DRIVER_BUSY','Finalize ou encerre a atribuição atual antes do check-in.');
    const gps=Number.isFinite(input.gpsAccuracyM)&&input.gpsAccuracyM>=0&&input.gpsAccuracyM<=10000?Number(input.gpsAccuracyM):null;
    let method='self_reported',confirmed=false;
    if(input.qrToken){
      if(!qrKey||!qrKid)fail('PRESENCE_QR_UNAVAILABLE','QR de presença seguro não está configurado.');
      const key=typeof qrKey==='function'?await qrKey():qrKey;
      const publicKey=crypto.createPublicKey(key?.type==='private'?key:crypto.createPrivateKey(key));
      const claims=verifyToken(input.qrToken,publicKey);
      if(claims.c!==principal.company_id)fail('PRESENCE_QR_TENANT_MISMATCH','QR pertence a outro restaurante.');
      const consumed=await client.query(`UPDATE rotamoto.restaurant_presence_qr_nonces SET consumed_at=$3
        WHERE company_id=$1 AND nonce_id=$2 AND expires_at>=$3 AND consumed_at IS NULL RETURNING nonce_id`,
      [principal.company_id,claims.jti,now()]);
      if(!consumed.rowCount)fail('PRESENCE_QR_REPLAY','QR de presença já foi usado ou expirou.');
      method='restaurant_qr';confirmed=true;
    }
    const current=await client.query(`SELECT is_present,checked_in_at,checkin_method,confirmed,revision FROM rotamoto.restaurant_driver_presence
      WHERE company_id=$1 AND driver_id=$2 FOR UPDATE`,[principal.company_id,driver.id]);
    if(current.rowCount&&current.rows[0].is_present){
      let confirmed=current.rows[0].confirmed,method=current.rows[0].checkin_method,revision=Number(current.rows[0].revision);
      if(input.qrToken&&!confirmed){
        const upgraded=await client.query(`UPDATE rotamoto.restaurant_driver_presence SET confirmed=true,checkin_method='restaurant_qr',revision=revision+1,updated_at=$3
          WHERE company_id=$1 AND driver_id=$2 RETURNING revision`,[principal.company_id,driver.id,now()]);
        confirmed=true;method='restaurant_qr';revision=Number(upgraded.rows[0].revision);
      }
      if(gps!==null)await client.query(`UPDATE rotamoto.restaurant_driver_presence SET last_gps_accuracy_m=$3,updated_at=$4
        WHERE company_id=$1 AND driver_id=$2`,[principal.company_id,driver.id,gps,now()]);
      return {presence:{driverId:driver.id,present:true,checkedInAt:new Date(current.rows[0].checked_in_at).toISOString(),
        method,confirmed,revision,duplicate:true,
        gps:{available:gps!==null,accuracyM:gps,confirmsPhysicalPresence:false}}};
    }
    const at=now(),revision=Number(current.rows[0]?.revision||0)+1;
    await client.query(`INSERT INTO rotamoto.restaurant_driver_presence(company_id,driver_id,checked_in_at,checkin_method,confirmed,is_present,checked_out_at,revision,last_gps_accuracy_m,updated_at)
      VALUES($1,$2,$3,$4,$5,true,NULL,$6,$7,$3) ON CONFLICT(company_id,driver_id) DO UPDATE SET
        checked_in_at=EXCLUDED.checked_in_at,checkin_method=EXCLUDED.checkin_method,confirmed=EXCLUDED.confirmed,
        is_present=true,checked_out_at=NULL,revision=EXCLUDED.revision,last_gps_accuracy_m=EXCLUDED.last_gps_accuracy_m,updated_at=EXCLUDED.updated_at`,
    [principal.company_id,driver.id,at,method,confirmed,revision,gps]);
    return {presence:{driverId:driver.id,present:true,checkedInAt:at.toISOString(),method,confirmed,revision,duplicate:false,
      gps:{available:gps!==null,accuracyM:gps,confirmsPhysicalPresence:false}}};
  }
  async function checkOut(client,principal) {
    const driver=await assertDriver(client,principal,true);
    const result=await client.query(`UPDATE rotamoto.restaurant_driver_presence SET is_present=false,checked_out_at=$3,revision=revision+1,updated_at=$3
      WHERE company_id=$1 AND driver_id=$2 AND is_present=true RETURNING revision`,[principal.company_id,driver.id,now()]);
    return {presence:{driverId:driver.id,present:false,revision:Number(result.rows[0]?.revision||0),changed:!!result.rowCount}};
  }
  async function confirmPresence(client,principal,driverId) {
    await permissions(client,principal,['orders.manage','company.manage']);
    if(!UUID.test(driverId||''))fail('INVALID_INPUT','Motoboy inválido.');
    await client.query(`SELECT record_id FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Driver' AND deleted_at IS NULL FOR UPDATE`,[principal.company_id,driverId]);
    const result=await client.query(`UPDATE rotamoto.restaurant_driver_presence SET confirmed=true,checkin_method='restaurant_confirmed',revision=revision+1,updated_at=$3
      WHERE company_id=$1 AND driver_id=$2 AND is_present=true RETURNING revision`,[principal.company_id,driverId,now()]);
    if(!result.rowCount)fail('PRESENCE_NOT_FOUND','O motoboy não está presente para confirmação.');
    return {confirmed:true,revision:Number(result.rows[0].revision)};
  }
  async function setMode(client,principal,mode,expectedRevision) {
    await permissions(client,principal,['orders.manage','company.manage']);
    if(!['manual','automatic'].includes(mode)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('INVALID_INPUT','Configuração de distribuição inválida.');
    const result=await client.query(`INSERT INTO rotamoto.restaurant_dispatch_settings(company_id,mode,revision,updated_by_user_id,updated_at)
      VALUES($1,$2,1,$3,$4) ON CONFLICT(company_id) DO UPDATE SET mode=EXCLUDED.mode,revision=rotamoto.restaurant_dispatch_settings.revision+1,
        updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at
      WHERE rotamoto.restaurant_dispatch_settings.revision=$5 RETURNING mode,revision,updated_at`,[principal.company_id,mode,principal.user_id,now(),expectedRevision]);
    if(!result.rowCount)fail('REVISION_CONFLICT','A configuração mudou em outra sessão; atualize e tente novamente.');
    return {settings:{mode:result.rows[0].mode,revision:Number(result.rows[0].revision),updatedAt:new Date(result.rows[0].updated_at).toISOString()}};
  }
  async function getSettings(client,principal) {
    if(!principal?.driver_id)await permissions(client,principal,['orders.read','orders.manage','company.manage']);
    const result=await client.query('SELECT mode,revision,updated_at FROM rotamoto.restaurant_dispatch_settings WHERE company_id=$1',[principal.company_id]);
    return {settings:result.rowCount?{mode:result.rows[0].mode,revision:Number(result.rows[0].revision),updatedAt:new Date(result.rows[0].updated_at).toISOString()}:{mode:'manual',revision:0,updatedAt:null}};
  }
  async function getQueue(client,principal) {
    if(principal?.driver_id){
      const driver=await assertDriver(client,principal,false);
      const presence=await client.query(`SELECT checked_in_at,checkin_method,confirmed,is_present,revision FROM rotamoto.restaurant_driver_presence WHERE company_id=$1 AND driver_id=$2`,[principal.company_id,driver.id]);
      const online=await availability(client,principal.company_id,driver.id,false);
      const busy=await activeDelivery(client,principal.company_id,driver.id);
      const row=presence.rows[0];
      if(!row)return {presence:{driverId:driver.id,present:false,confirmed:false,online,eligible:false,busy,checkedInAt:null,revision:0}};
      const others=await client.query(`SELECT count(*)::int AS ahead FROM rotamoto.restaurant_driver_presence p
        JOIN rotamoto.driver_availability a ON a.company_id=p.company_id AND a.driver_id=p.driver_id
        JOIN rotamoto.domain_records d ON d.company_id=p.company_id AND d.record_id=p.driver_id AND d.entity_type='Driver' AND d.deleted_at IS NULL
        WHERE p.company_id=$1 AND p.is_present AND p.confirmed AND a.status='online' AND a.lease_expires_at>now()
          AND upper(coalesce(d.payload->>'status',''))=ANY($4::text[])
        AND NOT EXISTS(SELECT 1 FROM rotamoto.domain_records dl WHERE dl.company_id=p.company_id AND dl.entity_type='Delivery' AND dl.deleted_at IS NULL
            AND dl.payload->>'driverId'=p.driver_id::text AND upper(coalesce(dl.payload->>'status',''))<>ALL($5::text[]))
          AND (p.checked_in_at<$2 OR (p.checked_in_at=$2 AND p.driver_id<$3::uuid))`,[principal.company_id,row.checked_in_at,driver.id,[...ACTIVE_DRIVER],[...TERMINAL]]);
      return {presence:{driverId:driver.id,present:row.is_present,confirmed:row.confirmed,online,eligible:online&&row.is_present&&row.confirmed&&!busy,busy,
        checkedInAt:new Date(row.checked_in_at).toISOString(),method:row.checkin_method,revision:Number(row.revision),position:row.is_present&&row.confirmed?Number(others.rows[0].ahead)+1:null}};
    }
    await permissions(client,principal,['orders.read','orders.manage','company.manage']);
    const result=await client.query(`SELECT d.record_id::text AS driver_id,d.payload->>'name' AS name,d.payload->>'status' AS driver_status,
      a.status AS availability_status,a.lease_expires_at,a.revision AS availability_revision,
      p.checked_in_at,p.checkin_method,p.confirmed,p.is_present,p.checked_out_at,p.revision AS presence_revision,
      EXISTS(SELECT 1 FROM rotamoto.domain_records dl WHERE dl.company_id=d.company_id AND dl.entity_type='Delivery' AND dl.deleted_at IS NULL
        AND dl.payload->>'driverId'=d.record_id::text AND upper(coalesce(dl.payload->>'status',''))<>ALL($2::text[])) AS busy
      FROM rotamoto.domain_records d LEFT JOIN rotamoto.driver_availability a ON a.company_id=d.company_id AND a.driver_id=d.record_id
      LEFT JOIN rotamoto.restaurant_driver_presence p ON p.company_id=d.company_id AND p.driver_id=d.record_id
      WHERE d.company_id=$1 AND d.entity_type='Driver' AND d.deleted_at IS NULL
      ORDER BY p.checked_in_at NULLS LAST,d.record_id`,[principal.company_id,TERMINAL]);
    const nowMs=now().getTime();
    const records=result.rows.map(row=>{
      const online=row.availability_status==='online'&&Date.parse(row.lease_expires_at)>nowMs&&ACTIVE_DRIVER.has(normalizeDriverStatus(row.driver_status));
      const present=row.is_present===true,confirmed=row.confirmed===true,eligible=online&&present&&confirmed&&!row.busy;
      return {driverId:row.driver_id,name:row.name||'Motoboy',online,present,confirmed,eligible,busy:row.busy,
        checkedInAt:row.checked_in_at?new Date(row.checked_in_at).toISOString():null,checkinMethod:row.checkin_method||null,
        leaseExpiresAt:row.lease_expires_at?new Date(row.lease_expires_at).toISOString():null,
        availabilityRevision:Number(row.availability_revision||0),presenceRevision:Number(row.presence_revision||0)};
    });
    return {records,queue:records.filter(row=>row.eligible).sort((a,b)=>Date.parse(a.checkedInAt)-Date.parse(b.checkedInAt)||a.driverId.localeCompare(b.driverId))};
  }
  async function assignForNewDelivery(client,companyId,delivery) {
    const mode=await client.query(`SELECT mode FROM rotamoto.restaurant_dispatch_settings WHERE company_id=$1 FOR UPDATE`,[companyId]);
    if(mode.rows[0]?.mode!=='automatic'||!['CREATED','REDELIVERY'].includes(delivery.status)||delivery.driverId)return {delivery,assigned:false,reason:'manual_or_not_ready'};
    const candidates=await client.query(`SELECT p.driver_id::text AS driver_id FROM rotamoto.restaurant_driver_presence p
      JOIN rotamoto.domain_records d ON d.company_id=p.company_id AND d.record_id=p.driver_id AND d.entity_type='Driver' AND d.deleted_at IS NULL
      JOIN rotamoto.driver_availability a ON a.company_id=p.company_id AND a.driver_id=p.driver_id
      WHERE p.company_id=$1 AND p.is_present AND p.confirmed AND a.status='online' AND a.lease_expires_at>now()
        AND upper(coalesce(d.payload->>'status',''))=ANY($2::text[])
        AND NOT EXISTS(SELECT 1 FROM rotamoto.domain_records dl WHERE dl.company_id=p.company_id AND dl.entity_type='Delivery' AND dl.deleted_at IS NULL
          AND dl.payload->>'driverId'=p.driver_id::text AND upper(coalesce(dl.payload->>'status',''))<>ALL($3::text[]))
      ORDER BY p.checked_in_at,p.driver_id LIMIT 1 FOR UPDATE OF d,a,p SKIP LOCKED`,[companyId,[...ACTIVE_DRIVER,'DISPONÍVEL'],[...TERMINAL]]);
    for(const candidate of candidates.rows){
      const eligibility=await client.query(`SELECT a.status,a.lease_expires_at,d.payload->>'status' AS driver_status
        FROM rotamoto.domain_records d JOIN rotamoto.driver_availability a ON a.company_id=d.company_id AND a.driver_id=d.record_id
        JOIN rotamoto.restaurant_driver_presence p ON p.company_id=d.company_id AND p.driver_id=d.record_id
        WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Driver' AND d.deleted_at IS NULL AND p.is_present AND p.confirmed
        FOR UPDATE OF d,a,p`,[companyId,candidate.driver_id]);
      const row=eligibility.rows[0];
      if(!row||row.status!=='online'||new Date(row.lease_expires_at).getTime()<=now().getTime()||!ACTIVE_DRIVER.has(normalizeDriverStatus(row.driver_status)))continue;
      if(await activeDelivery(client,companyId,candidate.driver_id))continue;
      const assignedAt=now().toISOString();
      const assigned={...delivery,driverId:candidate.driver_id,status:'ASSIGNED',assignedAt,updatedAt:assignedAt};
      await client.query(`UPDATE rotamoto.restaurant_driver_presence SET is_present=false,checked_out_at=$3,revision=revision+1,updated_at=$3
        WHERE company_id=$1 AND driver_id=$2 AND is_present`,[companyId,candidate.driver_id,assignedAt]);
      return {delivery:assigned,assigned:true,driverId:candidate.driver_id};
    }
    return {delivery,assigned:false,reason:'no_eligible_driver'};
  }
  async function assignmentConsumed(client,companyId,driverId) {
    if(!driverId)return;
    if(!(await schemaReady(client)))return;
    await client.query(`UPDATE rotamoto.restaurant_driver_presence SET is_present=false,checked_out_at=$3,revision=revision+1,updated_at=$3
      WHERE company_id=$1 AND driver_id=$2 AND is_present`,[companyId,driverId,now()]);
  }
  async function schemaReady(client){const result=await client.query(`SELECT to_regclass('rotamoto.restaurant_dispatch_settings') IS NOT NULL AND
    to_regclass('rotamoto.restaurant_driver_presence') IS NOT NULL AND to_regclass('rotamoto.restaurant_presence_qr_nonces') IS NOT NULL AS ready`);return result.rows[0]?.ready===true;}
  return Object.freeze({issueRestaurantQr,checkIn,checkOut,confirmPresence,setMode,getSettings,getQueue,assignForNewDelivery,assignmentConsumed,schemaReady,qrTtlSeconds:QR_TTL_SECONDS});
}

module.exports={createRestaurantDriverQueueService,PREFIX,QR_TTL_SECONDS};
