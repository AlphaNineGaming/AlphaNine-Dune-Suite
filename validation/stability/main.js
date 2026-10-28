"use strict";
const {app,BrowserWindow,session}=require("electron");
const fs=require("fs"),path=require("path"),os=require("os"),net=require("net"),{fork}=require("child_process"),assert=require("assert/strict");
const reportArg=process.argv.find(a=>a.startsWith("--validation-report="));
const selfTest=Boolean(reportArg),profile=process.env.ALPHANINE_CLEANUP_TEST_PROFILE||fs.mkdtempSync(path.join(os.tmpdir(),"a9-packaged-cleanup-"));
fs.mkdirSync(profile,{recursive:true});app.setName("AlphaNine Cleanup Test");app.setPath("userData",path.join(profile,"electron"));
let backend,window,report={testOnly:true,packaged:false,liveConnectionsPermitted:false,checks:[],errors:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(name,value)=>{assert(value,name);report.checks.push({name,passed:true});};
function writeReport(){if(reportArg){const file=reportArg.slice("--validation-report=".length);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));}}
app.on("before-quit",()=>backend?.kill());
app.on("window-all-closed",()=>app.quit());
app.whenReady().then(async()=>{
  const socket=net.createServer();await new Promise(r=>socket.listen(0,"127.0.0.1",r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const root=process.env.ALPHANINE_STABILITY_ASAR;if(!root||!root.endsWith("app.asar"))throw Error("Explicit production ASAR required");report.harnessPackaged=app.isPackaged;report.packaged=true;report.appPath=root;report.versions=process.versions;
  fs.writeFileSync(path.join(profile,"config.json"),JSON.stringify({serverType:"local-hyperv",vmName:"SIMULATED-ONLY",sshHost:"127.0.0.1",vmIp:"127.0.0.1",sshUser:"fixture",autoStartServer:false}));
  fs.writeFileSync(path.join(profile,"fixture-state.json"),JSON.stringify({mode:"valid",removed:[]}));
  backend=fork(path.join(__dirname,"backend.js"),[],{execArgv:[],env:{...process.env,ELECTRON_RUN_AS_NODE:"1",PORT:String(port),ALPHANINE_DATA_DIR:profile,ALPHANINE_CONFIG_PATH:path.join(profile,"config.json"),ALPHANINE_SIDE_EFFECT_FREE_RUNNER:"0",ALPHANINE_SKIP_STARTUP_SERVICES:"1",ALPHANINE_SKIP_MANAGER:"1",ALPHANINE_DISABLE_SERVER_ITEM_DISCOVERY:"1",ALPHANINE_CLEANUP_TEST_PACKAGE:"1",ALPHANINE_TEST_BINARY:process.execPath},windowsHide:true,stdio:["ignore","pipe","pipe","ipc"]});
  let output="";backend.stdout.on("data",c=>{output=(output+c).slice(-32000);report.backendLog=output;});backend.stderr.on("data",c=>{output=(output+c).slice(-32000);report.backendLog=output;});
  const origin="http://127.0.0.1:"+port;
  for(let i=0;i<150;i++){try{if((await fetch(origin+"/__validation/health")).ok)break;}catch{}if(i===149)throw Error("Backend did not start: "+output);await sleep(100);}
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{const url=new URL(details.url);callback({cancel:!((url.protocol==="http:"&&url.hostname==="127.0.0.1"&&url.port===String(port))||["data:","devtools:"].includes(url.protocol))});});
  window=new BrowserWindow({width:1400,height:950,title:"AlphaNine Cleanup Test — simulated VM only",show:!selfTest,webPreferences:{preload:path.join(root,"electron","preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:selfTest}});
  let paintedFrames=0;if(selfTest){window.webContents.setFrameRate(30);window.webContents.on("paint",()=>paintedFrames++);}
  window.webContents.setWindowOpenHandler(()=>({action:"deny"}));window.webContents.on("will-navigate",(event,url)=>{if(!url.startsWith(origin+"/"))event.preventDefault();});
  await window.loadURL(origin+"/");
  await window.webContents.executeJavaScript('document.body.insertAdjacentHTML("afterbegin",\'<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#3a2100;color:#ffe4a0;padding:6px;text-align:center">DEVELOPMENT TEST — SIMULATED VM ONLY</div>\')');
  if(!selfTest)return;
  const js=source=>window.webContents.executeJavaScript(source,true);
  const until=async expression=>{for(let i=0;i<400;i++){if(await js(expression))return;await sleep(40);}report.failureStatus=await js('document.getElementById("serverPackageCleanupStatus").textContent');report.failureAudit=await(await fetch(origin+"/__validation/audit")).json();throw Error("Renderer condition timed out: "+expression);};
  const mode=async value=>{await fetch(origin+"/__validation/mode",{method:"POST",body:JSON.stringify({mode:value})});};
  check("ASAR packaged application",root.endsWith("app.asar")&&fs.existsSync(root));
  check("Renderer sandbox enabled",window.webContents.getLastWebPreferences().sandbox===true);
  check("Real Suite cleanup functions loaded",await js('typeof scanServerPackages==="function"&&typeof cleanServerPackages==="function"'));
  await js('setView(document.getElementById("serverPackageCleanupScanButton").closest("section").id);document.getElementById("serverPackageCleanupScanButton").scrollIntoView({block:"center"})');
  check("Cleanup controls visible in real Server Control page",await js('document.getElementById("serverPackageCleanupScanButton").getBoundingClientRect().width>0'));
  const isolatedConfigurationBefore=fs.readFileSync(path.join(profile,"config.json"),"utf8");
  let ticks=0,probes=0;const framesBefore=paintedFrames;await js('window.__validationTicks=0;window.__validationAnimationFrames=0;window.__validationRaf=function(){window.__validationAnimationFrames++;requestAnimationFrame(window.__validationRaf)};requestAnimationFrame(window.__validationRaf);window.__validationTimer=setInterval(()=>window.__validationTicks++,10);document.getElementById("serverPackageCleanupScanButton").click()');
  for(let i=0;i<400;i++){check;assert.equal(await(await fetch(origin+"/__validation/health")).text(),"ready");probes++;if(await js('!document.getElementById("serverPackageCleanupScanButton").disabled'))break;await sleep(20);}
  await until('!document.getElementById("serverPackageCleanupRunButton").disabled');ticks=await js('window.__validationTicks');check("18 MiB inventory scan and renderer heartbeat",ticks>2&&probes>1);
  report.animationFramesDuringScan=await js('window.__validationAnimationFrames');report.paintedFramesDuringScan=paintedFrames-framesBefore;check("Chromium keeps painting and animating during inventory",report.animationFramesDuringScan>1&&report.paintedFramesDuringScan>1);
  check("Package preview uses readable line breaks",await js('document.getElementById("serverPackageCleanupList").textContent.includes("\\n")'));
  await js('document.getElementById("serverPackageCleanupRunButton").click()');await until('!document.getElementById("suiteConfirmDialog").classList.contains("hidden")');await js('document.getElementById("suiteConfirmOk").click()');
  await until('document.getElementById("serverPackageCleanupStatus").textContent.includes("Cleanup complete")');check("Real confirmation dialog and fixture cleanup complete",true);
  check("Only unprotected fixture packages removed",JSON.parse(fs.readFileSync(path.join(profile,"fixture-state.json"),"utf8")).removed.length===2);
  report.failureStatuses={};
  for(const failureMode of ["invalid","exit","timeout","oom"]){await mode(failureMode);await js('document.getElementById("serverPackageCleanupScanButton").click()');await until('!document.getElementById("serverPackageCleanupScanButton").disabled');const status=await js('document.getElementById("serverPackageCleanupStatus").textContent');report.failureStatuses[failureMode]=status;check("Failure reported and controls restored: "+failureMode,new RegExp({invalid:"JSON|Unexpected|property",exit:"code 7",timeout:"timed out",oom:"heap budget"}[failureMode],"i").test(status));assert.equal(await(await fetch(origin+"/__validation/health")).text(),"ready");}
  await mode("valid");await js('document.getElementById("serverPackageCleanupScanButton").click()');await until('!document.getElementById("serverPackageCleanupRunButton").disabled');check("Rescan succeeds after all injected failures",true);
  await mode("invalid");await js('document.getElementById("serverPackageCleanupRunButton").click()');await until('!document.getElementById("suiteConfirmDialog").classList.contains("hidden")');await js('document.getElementById("suiteConfirmOk").click()');await until('!document.getElementById("serverPackageCleanupScanButton").disabled');
  const failedOperations=await(await fetch(origin+"/api/operations")).json();check("Failed packaged cleanup releases operation",failedOperations.active.length===0&&failedOperations.operations[0].status==="failed");
  await mode("valid");await js('document.getElementById("serverPackageCleanupScanButton").click()');await until('!document.getElementById("serverPackageCleanupRunButton").disabled');await js('document.getElementById("serverPackageCleanupRunButton").click()');await until('!document.getElementById("suiteConfirmDialog").classList.contains("hidden")');await js('document.getElementById("suiteConfirmOk").click()');await until('document.getElementById("serverPackageCleanupStatus").textContent.includes("Cleanup complete")');check("Packaged cleanup succeeds after failed operation",true);
  check("Isolated configuration unchanged by policy/workflow",fs.readFileSync(path.join(profile,"config.json"),"utf8")===isolatedConfigurationBefore);
  await js('document.getElementById("serverPackageCleanupStatus").scrollIntoView({block:"center"})');
  await sleep(150);fs.writeFileSync(path.join(path.dirname(reportArg.slice("--validation-report=".length)),"packaged-dashboard.png"),(await window.webContents.capturePage()).toPNG());
  check("Automatic cleanup panels absent from production UI",await js('!document.getElementById("containerGcReviewPanel")&&!document.getElementById("containerGcLifecyclePanel")'));
  check("Automatic cleanup browser actions absent",await js('typeof gcLifecycleAction==="undefined"&&typeof previewContainerGcPolicy==="undefined"'));
  const callsBefore=(await(await fetch(origin+"/__validation/audit")).json()).commands.length;
  for(const prefix of ["container-gc","container-gc-lifecycle"]){for(const action of ["status","inspect","apply","enable","disable","rollback","restart"]){const response=await fetch(origin+"/api/"+prefix+"/"+action,{method:action==="status"?"GET":"POST",headers:{"content-type":"application/json"},body:action==="status"?undefined:JSON.stringify({administratorApproved:true,restartApproved:true,enabled:true})});check("Removed automatic cleanup endpoint refuses: "+prefix+"/"+action,response.status===404);}}
  check("Removed routes execute no commands",(await(await fetch(origin+"/__validation/audit")).json()).commands.length===callsBefore);
  check("Current Discord invitation opened by UI",await js('(()=>{const original=window.open;let url;window.open=value=>{url=value};try{openSupportDiscord();return url==="https://discord.gg/cz4Zwbt7k"}finally{window.open=original}})()'));
  check("Server configuration unchanged",fs.readFileSync(path.join(profile,"config.json"),"utf8")===isolatedConfigurationBefore);
  const audit=await(await fetch(origin+"/__validation/audit")).json();check("Parser fork uses packaged helper",audit.parserForks.length>0&&audit.parserForks.every(p=>p.includes("app.asar")));check("No live SSH processes launched",audit.blocked.every(x=>x.binary!=="ssh"));
  report.fixtureAudit=audit;report.rendererTicks=ticks;report.healthProbesDuringScan=probes;report.backendLog=output;report.passed=true;
  await sleep(300);report.finalStatus=await js('document.getElementById("serverPackageCleanupStatus").textContent');
  const shot=await window.webContents.capturePage();const reportPath=reportArg.slice("--validation-report=".length);fs.writeFileSync(path.join(path.dirname(reportPath),"packaged-stability-dashboard.png"),shot.toPNG());
  writeReport();app.quit();
}).catch(error=>{report.passed=false;report.errors.push(error.stack||String(error));writeReport();process.exitCode=1;app.quit();});
