const electron=require('electron'),fs=require('node:fs'),path=require('node:path');
const {app}=electron;
const smoke=process.argv.includes('--blueprint-designer-smoke');
function saveReport(report){fs.mkdirSync(app.getPath('userData'),{recursive:true});fs.writeFileSync(path.join(app.getPath('userData'),'smoke-result.json'),JSON.stringify(report,null,2));}
if(!fs.existsSync(path.join(app.getAppPath(),'blueprint-designer.json')))app.exit(1);
else {
  const outputArg=process.argv.find(a=>a.startsWith('--designer-smoke-output='));
  const designerData=smoke&&outputArg?path.resolve(outputArg.slice('--designer-smoke-output='.length)):path.join(app.getPath('appData'),'AlphaNine Blueprint Designer');
  fs.mkdirSync(designerData,{recursive:true});
  app.setPath('userData',designerData);
  app.whenReady().then(async()=>{
    const {loadCatalog}=require(path.join(process.resourcesPath,'designer-runtime','geometry-catalog'));
    const {createDocumentWindow}=require(path.join(process.resourcesPath,'designer-runtime','desktop'));
    const geometryCatalog=loadCatalog(path.join(process.resourcesPath,'designer-native','catalog.json'));
    const window=await createDocumentWindow(electron,{mode:'assembly',geometryCatalog,packagedDesigner:true});
    window.show();
    window.moveTop();
    window.focus();
    app.focus({steal:true});
    if(!window.isVisible())throw Error('Designer window was created but Windows did not show it.');
    process.stdin.on('data',data=>{if(data.toString().trim()==='focus'&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
    process.stdout.write('ALPHANINE_DESIGNER_READY\n');
    if(smoke){
      const result=await window.webContents.executeJavaScript(`(async()=>{
        async function command(action,payload){const p=await api.project(action,payload);if(p?.error)throw Error(action+": "+p.error);if(!p?.project||!p.scene)throw Error(action+": missing project response");return p;}
        if(busy)throw Error("Unexpected startup file operation");
        const p=await command("new");applyConstruction(p,true);
        const entry=constructionEntries.find(e=>e.status==="available"&&e.geometry?.kind==="native-render-lod");
        if(!entry)throw Error("No available native mesh");
        const added=await command("command",{kind:"add",type:entry.id,position:[0,0,0],yaw:0});applyConstruction(added);
        if(!viewport?.gl||viewport.gl.isContextLost())throw Error("WebGL context unavailable");
        viewport.fit();viewport.draw();
        if(viewport.lastDraw?.instances!==1||!(viewport.lastDraw.triangles>0)||viewport.gl.getError()!==viewport.gl.NO_ERROR)throw Error("Native mesh draw failed");
        return {runtime:api.runtime,webgl:true,projectPieces:added.project.pieces.length,catalogEntries:constructionEntries.filter(e=>e.status==="available").length,draw:viewport.lastDraw};
      })()`);
      if(!result.runtime.sandboxed||!result.runtime.contextIsolated||!result.webgl||result.catalogEntries<565)throw Error('Packaged sandbox/graphics/catalog check failed: '+JSON.stringify(result));
      await fs.promises.writeFile(path.join(app.getPath('userData'),'smoke-window.png'),(await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript('(async()=>{const p=await api.project("command",{kind:"undo"});if(p.error||p.project?.pieces.length!==0||p.project.dirty)throw Error("Smoke cleanup failed");})()');
      saveReport({passed:true,...result,noSandboxFlag:app.commandLine.hasSwitch('no-sandbox'),serverStarted:false});app.quit();
    }
  }).catch(error=>{process.stderr.write('Designer startup failed: '+error.message+'\n');if(smoke)saveReport({passed:false,error:String(error.stack),serverStarted:false});app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
}
