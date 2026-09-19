const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(require('path').join(__dirname, '..', 'server.js'),'utf8');
const context=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function portalLiveGiveStatus('),source.indexOf('async function liveGiveEnvStatus()')),context);
const transport={mode:'http-json',configured:true,reachable:true,statusCode:200,token:'SECRET',url:'http://private/SECRET',password:'SECRET',error:'SECRET',activeRuntimeConfig:{password:'SECRET'}};
assert.equal(context.portalLiveGiveStatus(transport).liveGiveAvailable,true);
assert(!JSON.stringify(context.portalLiveGiveStatus(transport)).includes('SECRET'));
for(const code of [401,403,500])assert.equal(context.portalLiveGiveStatus({...transport,statusCode:code}).liveGiveAvailable,false);
assert.equal(context.portalLiveGiveStatus({...transport,reachable:false}).liveGiveAvailable,false);
vm.runInContext(source.slice(source.indexOf('const REMOTE_LOCAL_ONLY_PREFIXES'),source.indexOf('function appendRemoteRequestAudit')),context);
const policy=(role,method,path,reauthenticatedUntil=0)=>context.remoteRoutePolicy({method},{role,reauthenticatedUntil},{pathname:path});
for(const role of ['viewer','operator','owner']) {
 assert.equal(policy(role,'GET','/api/live-give/status').allowed,true);
 assert.equal(policy(role,'GET','/api/live-give/env').allowed,false);
}
assert.equal(policy('viewer','POST','/api/admin/give-item').allowed,false);
assert.equal(policy('operator','POST','/api/admin/give-item').allowed,true);
assert.equal(policy('owner','POST','/api/admin/give-item').status,428);
assert.equal(policy('owner','POST','/api/admin/give-item',Date.now()+10000).allowed,true);
(async()=>{
 const calls=[];const ui=vm.createContext({location:{protocol:'https:'},getJson:async url=>{calls.push(url);if(url!=='/api/live-give/status')throw Error('local-only');return context.portalLiveGiveStatus(transport);},syncLiveGiveTransportStatus(){},renderEnvSetup(){},badge(){},tone(){},liveGiveTransportMessage:()=>'',betterError:e=>e.message});
 const start=source.indexOf('async function refreshLiveGiveEnv(){');
 vm.runInContext(source.slice(start,source.indexOf('\n',start)),ui);
 await ui.refreshLiveGiveEnv();assert.equal(ui.adminLiveGiveAvailable,true);assert.deepEqual(calls,['/api/live-give/status']);
 console.log('PASS portal preflight, unavailable/auth failures, response secret isolation, viewer/operator/owner authorization and owner reauthentication');
})().catch(e=>{console.error(e);process.exitCode=1;});
