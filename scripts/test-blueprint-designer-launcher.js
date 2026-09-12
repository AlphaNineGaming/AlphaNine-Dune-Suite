const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createDesignerLauncher}=require('../electron/blueprint-designer-launcher');
(async()=>{
  const frame={url:'http://127.0.0.1:8810/'},webContents={mainFrame:frame},event={sender:webContents,senderFrame:frame},calls=[];
  const app={isPackaged:false,getAppPath:()=>process.cwd()};
  const launcher=createDesignerLauncher({app,getMainWindow:()=>({webContents}),port:8810,existsSync:p=>!p.endsWith("blueprint-designer.json"),spawn:(...args)=>{calls.push(args);const child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=()=>{};process.nextTick(()=>{child.emit('spawn');child.stdout.emit('data',Buffer.from('ALPHANINE_DESIGNER_READY\n'));});return child;}});
  assert.equal(launcher.status(event).available,true);
  for(const bad of [{sender:{},senderFrame:frame},{sender:webContents,senderFrame:{...frame}}]){assert.throws(()=>launcher.status(bad));await assert.rejects(launcher.open(bad));}
  frame.url='https://example.org/';assert.throws(()=>launcher.status(event));frame.url='http://127.0.0.1:8810/';
  for(const url of ['http://127.0.0.1:8810/other#blueprints','http://127.0.0.1:8811/#blueprints','http://127.0.0.1:8810/?other=1#blueprints']){frame.url=url;assert.throws(()=>launcher.status(event));}
  frame.url='http://127.0.0.1:8810/#blueprints';assert.equal(launcher.status(event).available,true);
  await launcher.open(event);assert.equal((await launcher.open(event)).alreadyOpen,true);assert.equal(calls.length,1);
  const [exe,args,options]=calls[0];assert.equal(exe,process.execPath);assert.equal(args.length,3);assert.equal(args[1],'--assembly');
  assert.ok(!args.some(a=>a.includes('no-sandbox')||a.includes('disable-renderer-sandbox')));assert.equal(options.windowsHide,true);assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);
  app.isPackaged=true;assert.equal(launcher.status(event).available,false);await assert.rejects(launcher.open(event));assert.equal(calls.length,1);
  app.isPackaged=false;
  const missing=createDesignerLauncher({app,getMainWindow:()=>({webContents}),port:8810,existsSync:()=>false,spawn:()=>{throw Error('Must not spawn');}});assert.equal(missing.status(event).available,false);await assert.rejects(missing.open(event));
  const failed=createDesignerLauncher({app,getMainWindow:()=>({webContents}),port:8810,existsSync:()=>true,spawn:()=>{const child=new EventEmitter();process.nextTick(()=>child.emit('error',Error('launch failed')));return child;}});
  await assert.rejects(failed.open(event),/launch failed/);await assert.rejects(failed.open(event),/launch failed/);
  const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const ui=source.slice(source.indexOf('async function initBlueprintDesigner()'),source.indexOf('function setBlueprintStatus('));
  const button={hidden:true,disabled:false,style:{display:'none'}},message={textContent:''};let launches=0;
  const context={document:{readyState:'complete',getElementById:id=>id==='blueprintDesignerButton'?button:message},window:{alphaNineSuite:{blueprintDesignerStatus:async()=>({available:true}),openBlueprintDesigner:async()=>{launches++;return {opened:true};}}}};
  vm.createContext(context);vm.runInContext(ui,context);await context.initBlueprintDesigner();assert.equal(button.hidden,false);assert.equal(button.style.display,'');
  await context.openBlueprintDesigner();assert.equal(launches,1);assert.equal(button.disabled,false);assert.match(message.textContent,/separate window/);
  context.window.alphaNineSuite.openBlueprintDesigner=async()=>{throw Error('synthetic failure');};await context.openBlueprintDesigner();assert.equal(button.disabled,false);assert.match(message.textContent,/synthetic failure/);
  context.window.alphaNineSuite.blueprintDesignerStatus=async()=>({available:false});await context.initBlueprintDesigner();assert.equal(button.hidden,true);assert.equal(button.style.display,'none');
  console.log('Designer launcher and UI checks passed; no process or server started.');
})().catch(e=>{console.error(e);process.exitCode=1;});
