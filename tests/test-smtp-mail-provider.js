'use strict';
const assert=require('node:assert/strict');
const net=require('node:net');
const {createSmtpMailProvider}=require('../backend/identity/smtp-mail-provider');

async function main(){
 const captured=[];
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');socket.write('220 localhost test-only SMTP\r\n');let buffer='',inData=false,data='';
  socket.on('data',chunk=>{buffer+=chunk;for(;;){if(inData){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;data+=buffer.slice(0,end);buffer=buffer.slice(end+5);inData=false;captured.push(data);data='';socket.write('250 2.0.0 accepted\r\n');continue}const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);const command=line.split(' ')[0].toUpperCase();if(command==='EHLO'||command==='HELO')socket.write('250-localhost\r\n250 OK\r\n');else if(command==='MAIL'||command==='RCPT')socket.write('250 OK\r\n');else if(command==='DATA'){inData=true;socket.write('354 end with dot\r\n')}else if(command==='RSET')socket.write('250 OK\r\n');else if(command==='QUIT'){socket.write('221 bye\r\n');socket.end()}else socket.write('250 OK\r\n')}});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const provider=createSmtpMailProvider({host:'127.0.0.1',port:server.address().port,secure:false,requireTLS:false,password:'test-only-unused',
  from:'RotaMoto <noreply@example.test>',baseUrl:'https://app.example.test/'});
 try{
  assert.equal(await provider.verify(),true);
  assert.equal(await provider.send({kind:'password_recovery',to:'recipient@example.test',token:'opaque-token-only-in-mail',expiresAt:new Date()}),true);
  assert.equal(await provider.send({kind:'owner_invitation',to:'owner@example.test',token:'invite-token-only-in-mail',expiresAt:new Date()}),true);
  assert.match(captured[0],/To: recipient@example\.test/iu);
  assert.match(captured[0],/^Subject: =\?UTF-8\?Q\?/imu);
  assert.match(captured[0].replace(/=\r\n/gu,''),/https:\/\/app\.example\.test\/#action=3Dpassword_recovery&token=3Dopaque-token-only-in-mail/iu);
  assert.match(captured[1],/To: owner@example\.test/iu);
  assert.match(captured[1].replace(/=\r\n/gu,''),/action=3Downer_invitation&token=3Dinvite-token-only-in-mail/iu);
 }finally{provider.close();await new Promise(resolve=>server.close(resolve))}
 console.log('SMTP local test-only transport: verify and password recovery delivery OK');
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
