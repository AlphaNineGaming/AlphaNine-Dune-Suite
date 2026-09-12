const path=require('node:path');
function createDesignerLauncher({app,spawn,existsSync,getMainWindow,port}) {
  let child=null;
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
    if(child)return {opened:true,alreadyOpen:true};
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
    const args=app.isPackaged?['--blueprint-designer']:[entry,'--assembly',`--geometry-catalog=${catalog}`];
    const next=spawn(process.execPath,args,{cwd:app.isPackaged?path.dirname(process.execPath):app.getAppPath(),env,stdio:'ignore',windowsHide:true});
    child=next;
    const clear=()=>{if(child===next)child=null;};next.once('exit',clear);
    return new Promise((resolve,reject)=>{next.once('error',error=>{clear();reject(error);});next.once('spawn',()=>resolve({opened:true}));});
  }
  return {status,open};
}
module.exports={createDesignerLauncher};
