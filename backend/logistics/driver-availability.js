'use strict';

const { randomUUID } = require('node:crypto');

const LEASE_SECONDS = 120;
const ACTIVE_DRIVER_STATUSES = new Set(['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED']);

function fail(code, message) { throw Object.assign(new Error(message), { code, name: 'DriverAvailabilityError' }); }
function normalizeStatus(value) {
  if (typeof value !== 'string' || !['online','offline'].includes(value)) fail('INVALID_INPUT', 'Estado deve ser online ou offline.');
  return value;
}
function project(row, driverStatus = null, now = Date.now()) {
  const status = row?.status === 'online' ? 'online' : 'offline';
  const leaseExpiresAt = row?.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null;
  const driverEligible = ACTIVE_DRIVER_STATUSES.has(String(driverStatus || '').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase());
  const leaseValid = status === 'online' && leaseExpiresAt && Date.parse(leaseExpiresAt) > now;
  const effectiveOnline = !!(leaseValid && driverEligible);
  const reason = effectiveOnline ? null : status !== 'online' ? 'not_requested' : !driverEligible ? 'driver_inactive' : 'lease_expired';
  return { requestedStatus: status, effectiveStatus: effectiveOnline ? 'online' : 'offline', effectiveOnline,
    reason, revision: Number(row?.revision || 0), leaseExpiresAt, updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
}

function createDriverAvailabilityService({ clock = () => new Date(), uuid = randomUUID } = {}) {
  async function assertSelf(client, principal, { lock = false } = {}) {
    if (!principal?.driver_id) fail('DRIVER_LINK_REQUIRED', 'Esta conta não está vinculada a um Driver.');
    const result = await client.query(`SELECT d.payload->>'status' AS driver_status
      FROM rotamoto.domain_records d JOIN rotamoto.memberships m
        ON m.company_id=d.company_id AND m.driver_id=d.record_id
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Driver' AND d.deleted_at IS NULL
        AND m.user_id=$3 AND m.status='active'
      ${lock ? 'FOR UPDATE OF d,m' : ''}`,[principal.company_id,principal.driver_id,principal.user_id]);
    if (!result.rowCount) fail('DRIVER_LINK_REQUIRED', 'O vínculo desta sessão com o Driver não está mais ativo.');
    return { driverId: principal.driver_id, driverStatus: result.rows[0].driver_status };
  }
  async function read(client, companyId, driverId, driverStatus = null) {
    const result = await client.query(`SELECT status,revision,lease_expires_at,updated_at
      FROM rotamoto.driver_availability WHERE company_id=$1 AND driver_id=$2`,[companyId,driverId]);
    return project(result.rows[0],driverStatus,clock().getTime());
  }
  async function get(client, principal) {
    let canReadFleet = Boolean(principal.company_manage || principal.permissions?.some(permission => ['orders.read','orders.manage','company.manage'].includes(permission)));
    if (!canReadFleet && principal.role_id) {
      const access = await client.query(`SELECT coalesce(bool_or(permission_key=ANY($3::text[])),false) AS allowed
        FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2 AND catalog_version=1`,
      [principal.company_id,principal.role_id,['orders.read','orders.manage','company.manage']]);
      canReadFleet = Boolean(access.rows[0]?.allowed);
    }
    if (principal.driver_id && !canReadFleet) {
      const {driverId,driverStatus}=await assertSelf(client,principal);
      return { availability: await read(client,principal.company_id,driverId,driverStatus) };
    }
    if (!canReadFleet) fail('FORBIDDEN','Apenas usuários autorizados da operação podem consultar a frota.');
    const rows = await client.query(`SELECT d.record_id::text AS driver_id,d.payload->>'status' AS driver_status,
        a.status,a.revision,a.lease_expires_at,a.updated_at
      FROM rotamoto.domain_records d LEFT JOIN rotamoto.driver_availability a
        ON a.company_id=d.company_id AND a.driver_id=d.record_id
      WHERE d.company_id=$1 AND d.entity_type='Driver' AND d.deleted_at IS NULL ORDER BY d.record_id`,[principal.company_id]);
    return { records: rows.rows.map(row => ({ driverId:row.driver_id, ...project(row,row.driver_status,clock().getTime()) })) };
  }
  async function set(client, principal, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['desiredStatus','expectedRevision','commandId'].includes(key)))
      fail('INVALID_INPUT','Comando de disponibilidade inválido.');
    const desired = normalizeStatus(input?.desiredStatus);
    if (!Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision < 0 ||
        typeof input?.commandId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.commandId))
      fail('INVALID_INPUT','Comando de disponibilidade inválido.');
    const {driverId,driverStatus}=await assertSelf(client,principal,{lock:true});
    const previousCommand=await client.query(`SELECT desired_status,result_revision FROM rotamoto.driver_availability_commands
      WHERE company_id=$1 AND driver_id=$2 AND command_id=$3`,[principal.company_id,driverId,input.commandId]);
    if(previousCommand.rowCount){
      if(previousCommand.rows[0].desired_status!==desired)fail('IDEMPOTENCY_CONFLICT','Chave de comando reutilizada para outro estado.');
      return {command:{duplicate:true,revision:Number(previousCommand.rows[0].result_revision)},availability:await read(client,principal.company_id,driverId,driverStatus)};
    }
    await client.query(`INSERT INTO rotamoto.driver_availability(company_id,driver_id,status,revision)
      VALUES($1,$2,'offline',0) ON CONFLICT(company_id,driver_id) DO NOTHING`,[principal.company_id,driverId]);
    const current=await client.query(`SELECT status,revision,lease_expires_at,lease_session_id,updated_at
      FROM rotamoto.driver_availability WHERE company_id=$1 AND driver_id=$2 FOR UPDATE`,[principal.company_id,driverId]);
    const row=current.rows[0];
    if(Number(row.revision)!==input.expectedRevision)fail('REVISION_CONFLICT','A disponibilidade mudou em outra sessão. Atualize o estado e tente novamente.');
    if(desired==='online'&&!ACTIVE_DRIVER_STATUSES.has(String(driverStatus||'').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase()))
      fail('DRIVER_INACTIVE','O perfil do motoboy não está ativo no Restaurante.');
    const changed=row.status!==desired||desired==='online'&&row.lease_session_id!==principal.session_id;
    const revision=Number(row.revision)+(changed?1:0),now=clock();
    const wasEffectivelyOnline=project(row,driverStatus,now.getTime()).effectiveOnline;
    const expiry=desired==='online'?new Date(now.getTime()+LEASE_SECONDS*1000):null;
    await client.query(`UPDATE rotamoto.driver_availability SET status=$3,revision=$4,lease_expires_at=$5,
        lease_session_id=$6,updated_by_user_id=$7,updated_at=$8
      WHERE company_id=$1 AND driver_id=$2`,[principal.company_id,driverId,desired,revision,expiry,
      desired==='online'?principal.session_id:null,principal.user_id,now]);
    await client.query(`INSERT INTO rotamoto.driver_availability_commands(company_id,driver_id,command_id,desired_status,result_revision,applied_at)
      VALUES($1,$2,$3,$4,$5,$6)`,[principal.company_id,driverId,input.commandId,desired,revision,now]);
    if(desired==='offline'||!wasEffectivelyOnline){
      const schema=await client.query("SELECT to_regclass('rotamoto.restaurant_driver_presence') IS NOT NULL AS ready");
      if(schema.rows[0]?.ready)await client.query(`UPDATE rotamoto.restaurant_driver_presence SET is_present=false,checked_out_at=$3,revision=revision+1,updated_at=$3
        WHERE company_id=$1 AND driver_id=$2 AND is_present`,[principal.company_id,driverId,now]);
    }
    return {command:{duplicate:false,revision},availability:await read(client,principal.company_id,driverId,driverStatus)};
  }
  async function heartbeat(client,principal,input) {
    if(!Number.isSafeInteger(input?.revision)||input.revision<1||Object.keys(input||{}).some(key=>key!=='revision'))
      fail('INVALID_INPUT','Renovação de disponibilidade inválida.');
    const {driverId,driverStatus}=await assertSelf(client,principal,{lock:true});
    const current=await client.query(`SELECT status,revision,lease_expires_at,lease_session_id,updated_at
      FROM rotamoto.driver_availability WHERE company_id=$1 AND driver_id=$2 FOR UPDATE`,[principal.company_id,driverId]);
    if(!current.rowCount||current.rows[0].status!=='online'||Number(current.rows[0].revision)!==input.revision||
        current.rows[0].lease_session_id!==principal.session_id) {
      return {renewed:false,availability:await read(client,principal.company_id,driverId,driverStatus)};
    }
    const now=clock(),expiresAt=new Date(now.getTime()+LEASE_SECONDS*1000);
    await client.query(`UPDATE rotamoto.driver_availability SET lease_expires_at=$4,updated_at=$4
      WHERE company_id=$1 AND driver_id=$2 AND revision=$3`,[principal.company_id,driverId,input.revision,expiresAt]);
    return {renewed:true,availability:await read(client,principal.company_id,driverId,driverStatus)};
  }
  async function assertEligibleForAssignment(client, companyId, driverId) {
    const driver=await client.query(`SELECT payload->>'status' AS driver_status FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Driver' AND deleted_at IS NULL FOR UPDATE`,[companyId,driverId]);
    if(!driver.rowCount)fail('INVALID_DRIVER','Driver não pertence a esta empresa ou está removido.');
    const availability=await client.query(`SELECT status,revision,lease_expires_at,updated_at FROM rotamoto.driver_availability
      WHERE company_id=$1 AND driver_id=$2 FOR UPDATE`,[companyId,driverId]);
    const state=project(availability.rows[0],driver.rows[0].driver_status,clock().getTime());
    if(!state.effectiveOnline)fail('DRIVER_NOT_AVAILABLE','O Driver não está Online no estado canônico; nenhuma atribuição nova foi feita.');
    return state;
  }
  return Object.freeze({get,set,heartbeat,assertEligibleForAssignment,leaseSeconds:LEASE_SECONDS});
}

module.exports={LEASE_SECONDS,createDriverAvailabilityService};
