const path=require('node:path');
function createDesignerLauncher({app,spawn,existsSync,getMainWindow,port}) {
  let child=null, pending=null, ready=false;
  const entry=path.join(app.getAppPath(),'dev','blueprint-documents','main.js');
  const catalog=path.join(app.getAppPath(),'assets','designer-native','catalog.json');
  function authorize(event){
    const window=getMainWindow();
    const url=new URL(event.senderFrame?.url||'about:blank');
    if(!window||event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||url.origin!==`http://127.0.0.1:${port}`||url.pathname!=='/'||url.search||url.username||url.password)throw Error('Designer launch requires the Suite desktop main page.');
  }
  function status(event){authorize(event);return {available:app.isPackaged?existsSync(path.join(app.getAppPath(),'blueprint-designer.json')):existsSync(entry)&&existsSync(catalog)};}
  async function open(event){
    if(!status(event).available)throw Error('The designer is not included in this Suite build.');
    if(child){if(pending)return pending;if(ready){child.stdin?.write("focus\n");return {opened:true,alreadyOpen:true};}}
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
    const args=app.isPackaged?['--blueprint-designer']:[entry,'--assembly',`--geometry-catalog=${catalog}`];
    const next=spawn(process.execPath,args,{cwd:app.isPackaged?path.dirname(process.execPath):app.getAppPath(),env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    child=next;
    pending=new Promise((resolve,reject)=>{
      let output="", errors="", settled=false;
      const timer=setTimeout(()=>fail(new Error("Designer did not finish opening within 30 seconds.")),30000);
      const clear=()=>{if(child===next){child=null;pending=null;ready=false;}};
      function fail(error){if(settled)return;settled=true;clearTimeout(timer);clear();try{next.kill();}catch{}reject(error);}
      next.once("error",fail);
      next.once("exit",(code,signal)=>{if(!settled)fail(new Error("Designer closed before its window opened ("+(signal||code)+"). "+errors.trim()));clear();});
      next.stderr?.on("data",data=>{errors=(errors+data.toString()).slice(-2000);});
      next.stdin?.on("error",()=>{});
      next.stdout?.on("data",data=>{
        output=(output+data.toString()).slice(-2000);
        if(!settled&&output.includes("ALPHANINE_DESIGNER_READY\n")){settled=true;clearTimeout(timer);ready=true;pending=null;resolve({opened:true});}
      });
    });
    return pending;
  }
  return {status,open};
}
module.exports={createDesignerLauncher};
