const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('const HOUSE_SCRIP_CURRENCY_ID = 1;');
const end = source.indexOf('function progressionLookupTimer(', start);
assert(start >= 0 && end > start, 'House Scrip implementation was not found.');
const section = source.slice(start, end);
function fixture(enumCurrency) {
  return {
    table: 'dune.player_virtual_currency_balances',
    columns: [
      {name:'player_controller_id',detail:'bigint'},
      {name:'currency_id',detail:enumCurrency?'USER-DEFINED':'smallint',value:enumCurrency?'virtualwallettype':'int2'},
      {name:'balance',detail:'bigint'}
    ],
    enums: enumCurrency ? [{name:'dune.virtualwallettype',detail:'HouseCredit'}] : [],
    functions: [{name:'adjust_player_virtual_currency_balance',detail:`in_controller_id bigint, in_currency_id ${enumCurrency?'dune.virtualwallettype':'smallint'}, in_delta bigint`,value:'bigint'}]
  };
}
function harness(enumCurrency, overrides={}) {
  const storage = fixture(enumCurrency);
  const events = [], queries = [], audits = [];
  let reads=0;
  const context={
    crypto, BigInt, console,
    fs:{writeFileSync:()=>events.push('backup')},
    PROGRESSION_AUDIT_LOG:'test-audit',
    loadConfig:()=>({progressionEditingEnabled:overrides.enabled!==false}),
    requireInteger:(value,label,min,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw Error(label);return Number(value);},
    progressionPlayerLookup:async()=>({ok:true,player:{player_controller_id:7,online_status:overrides.online?'online':'offline'}}),
    withProgressionStepTimeout:promise=>promise,
    progressionUnsupported:reason=>({ok:false,reason}),
    progressionBackupPath:()=>'/test/backup.json',
    progressionAudit:async(event,data)=>audits.push({event,data}),
    progressionPhaseTimer:()=>({timings:{},currentStep:'test',step:async(name,fn)=>fn(),finish:()=>{}}),
    parseDbRows:()=>[
      ...storage.columns.map(row=>({kind:'column',...row})),
      ...storage.functions.map(row=>({kind:'function',...row})),
      ...storage.enums.map(row=>({kind:'enum',...row}))
    ],
    dbQuery:async(sql)=>{
      queries.push(sql);
      if(sql.includes("select 'column'::text"))return '';
      if(sql.includes('select dune.adjust_player_virtual_currency_balance')){events.push('write');return '5';}
      events.push('read');
      reads++;
      return reads===1?'9007199254740993':overrides.badReadback?'0':'9007199254740998';
    }
  };
  vm.createContext(context);
  vm.runInContext(section+'\nthis.api={requireSupportedHouseScripStorage,progressionHouseScripBalance,progressionGrantHouseScrip,progressionHouseScripStorageInspect};',context);
  return {api:context.api,storage,queries,events,audits};
}
const payload={query:'test',amount:5,confirmText:'GIVE HOUSE SCRIP'};
(async()=>{
  let checks=0;
  for(const enumCurrency of [false,true]) {
    const expected=enumCurrency?"'HouseCredit'::dune.virtualwallettype":'1::smallint';
    const h=harness(enumCurrency);
    assert.equal(h.api.requireSupportedHouseScripStorage(h.storage).currencySql,expected);checks++;
    const balance=await h.api.progressionHouseScripBalance('test');
    assert.equal(balance.balance,'9007199254740993');
    assert(h.queries.some(sql=>sql.includes('and currency_id = '+expected)));checks++;
    const grant=harness(enumCurrency);
    const result=await grant.api.progressionGrantHouseScrip(payload);
    assert.equal(result.ok,true);
    assert.equal(result.expectedBalance,'9007199254740998');
    assert.equal(result.currencyId,enumCurrency?'HouseCredit':1);
    assert.deepEqual(grant.events,['read','backup','write','read']);
    assert(grant.queries.some(sql=>sql.includes(`adjust_player_virtual_currency_balance(7::bigint, ${expected}, 5::bigint)`)));
    assert.equal(grant.audits[0].data.verified,true);checks++;
    for(const change of [{online:true},{enabled:false}]) {
      const blocked=harness(enumCurrency,change);
      assert.equal((await blocked.api.progressionGrantHouseScrip(payload)).ok,false);
      assert(!blocked.events.includes('write'));checks++;
    }
    const confirmation=harness(enumCurrency);
    assert.equal((await confirmation.api.progressionGrantHouseScrip({...payload,confirmText:''})).ok,false);
    assert(!confirmation.events.includes('write'));checks++;
    const invalidAmount=harness(enumCurrency);
    assert.equal((await invalidAmount.api.progressionGrantHouseScrip({...payload,amount:-1})).ok,false);
    assert(!invalidAmount.events.includes('write'));checks++;
    const mismatch=harness(enumCurrency,{badReadback:true});
    assert.equal((await mismatch.api.progressionGrantHouseScrip(payload)).status,'verification_failed');checks++;
    const signatures=harness(enumCurrency);
    signatures.storage.functions.unshift({name:'adjust_player_virtual_currency_balance',detail:'bigint, text, bigint',value:'bigint'});
    assert.equal(signatures.api.requireSupportedHouseScripStorage(signatures.storage).currencySql,expected);checks++;
    signatures.storage.functions=[];
    assert.throws(()=>signatures.api.requireSupportedHouseScripStorage(signatures.storage),/was not detected/);checks++;
  }
  const unknown=harness(true);
  unknown.storage.enums=[];
  assert.throws(()=>unknown.api.requireSupportedHouseScripStorage(unknown.storage),/no HouseCredit/);checks++;
  const wrongColumn=harness(true);
  wrongColumn.storage.columns[1].value='unrelated_enum';
  assert.throws(()=>wrongColumn.api.requireSupportedHouseScripStorage(wrongColumn.storage),/storage is unsupported/);checks++;
  const report={passed:true,checks,liveBalancesChanged:false,coverage:['enum and legacy balance queries','enum and legacy mocked grants','exact BigInt balance verification','backup before grant','offline player requirement','typed confirmation','editing enabled requirement','invalid amounts','missing enum label','unsupported storage','matching function overload','failed readback']};
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
