'use strict';

const assert = require('node:assert/strict');
const { createMarketplaceAdminHandler } = require('../backend/integrations/marketplace-admin-http');

function response() {
  return { status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    end(body) { this.body = body ? JSON.parse(body) : null; } };
}

async function invoke(handler, { method='GET', url='/api/admin/marketplace/orders?limit=50', cookie=`__Host-rotamoto_session=${'A'.repeat(43)}`, body, csrf='valid-csrf' }={}) {
  const req = { method, url, requestId: '00000000-0000-4000-8000-000000000001',
    headers: { cookie, origin: 'https://app.example.test', host: 'app.example.test', 'content-type': 'application/json', 'x-csrf-token': csrf },
    socket: { encrypted: true }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  const res = response();
  assert.equal(await handler(req,res), true);
  return res;
}

async function main() {
  const orders = [{ provider:'ifood', domainOrderId:'00000000-0000-4000-8000-000000000002', displayId:'F-41', providerStatus:'PLACED' }];
  const calls=[];
  let permissions = new Set(['orders.read','orders.manage']);
  let csrfValid = true;
  const identityService = {
    async withAuthenticatedTenant(token, callback, permission) {
      assert.match(token,/^[A-Za-z0-9_-]{43}$/u);
      if (!permissions.has(permission)) throw Object.assign(new Error('forbidden'),{code:'FORBIDDEN'});
      return callback({ query:async()=>({rows:[]}) },{session_id:'session-e2e',company_id:'00000000-0000-4000-8000-000000000003'});
    },
    async verifyCsrf(_client,session,token) { return csrfValid && session==='session-e2e' && token==='valid-csrf'; }
  };
  const handler=createMarketplaceAdminHandler({identityService,accountService:{},adminService:{},accountWriter:{},
    marketplaceRuntime:{
      async listOrders(companyId,limit) { calls.push({kind:'list',companyId,limit}); return orders; },
      async enqueueOrderCommand(input) { calls.push({kind:'command',...input}); return {status:'queued',duplicate:false}; }
    },allowedOrigin:['https://app.example.test']});

  const listed=await invoke(handler);
  assert.equal(listed.status,200);assert.deepEqual(listed.body.orders,orders);
  assert.equal(calls[0].companyId,'00000000-0000-4000-8000-000000000003');assert.equal(calls[0].limit,50);
  const command=await invoke(handler,{method:'POST',url:'/api/admin/marketplace/orders/00000000-0000-4000-8000-000000000002/commands',
    body:{operation:'CONFIRM',idempotencyKey:'campaign0143-command-key',commandData:{}}});
  assert.equal(command.status,200);assert.equal(command.body.status,'queued');
  assert.equal(calls[1].companyId,'00000000-0000-4000-8000-000000000003');
  assert.equal(calls[1].domainOrderId,'00000000-0000-4000-8000-000000000002');
  assert.equal(calls[1].operation,'CONFIRM');

  permissions=new Set();
  const forbidden=await invoke(handler);
  assert.equal(forbidden.status,403);assert.equal(forbidden.body.error.code,'FORBIDDEN');
  permissions=new Set(['orders.manage']);csrfValid=false;
  const csrfDenied=await invoke(handler,{method:'POST',url:'/api/admin/marketplace/orders/00000000-0000-4000-8000-000000000002/commands',
    body:{operation:'CONFIRM',idempotencyKey:'campaign0143-command-key2',commandData:{}}});
  assert.equal(csrfDenied.status,403);assert.equal(csrfDenied.body.error.code,'CSRF_INVALID');
  process.stdout.write('Marketplace admin HTTP: PASS (tenant-scoped order read, command enqueue, permission and CSRF gates)\n');
}

main().catch(error=>{process.stderr.write(`Marketplace admin HTTP: FAIL (${error.stack||error})\n`);process.exitCode=1;});
