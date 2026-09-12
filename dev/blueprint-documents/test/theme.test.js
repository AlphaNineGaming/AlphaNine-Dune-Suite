"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{EventEmitter}=require("node:events");
const {attachControls,normalizeTheme}=require("../theme-control");
test("theme pipe handles partial messages, multiple commands, invalid values, and cleanup",()=>{
 const input=new EventEmitter(),win=new EventEmitter(),seen=[];Object.assign(win,{isDestroyed:()=>false,isMinimized:()=>true,restore:()=>seen.push("restore"),show:()=>{},focus:()=>seen.push("focus"),setDesignerTheme:t=>seen.push(t)});
 attachControls(win,input);input.emit("data",Buffer.from("theme:pur"));input.emit("data",Buffer.from("ple\nfocus\ntheme:royal\ntheme:invalid\n"));assert.deepEqual(seen,["purple","restore","focus","royal"]);win.emit("closed");assert.equal(input.listenerCount("data"),0);assert.equal(normalizeTheme("unknown"),"gold");
});
test("designer palettes match every Suite theme token",()=>{
 const suite=fs.readFileSync(path.join(__dirname,"../../../server.js"),"utf8"),css=fs.readFileSync(path.join(__dirname,"../themes.css"),"utf8");
 for(const theme of ["gold","command","purple","contrast","royal"]){
  const source=(theme==="gold"?suite.match(/:root \{\s*--bg:([\s\S]*?)\n    \}/)[0]:suite.split("body.theme-"+theme+" {")[1].split("}")[0]);
  const target=css.split(theme==="gold"?"body{":"body.theme-"+theme+"{")[1].split("}")[0];
  assert(target.includes("--bg:")&&target.includes("--text:"),theme+" requires palette");
  for(const m of target.matchAll(/(--[\w-]+):([^;]+);/g))assert(source.includes(m[1]+":"+m[2]+";"),theme+" "+m[1]);
 }
});
test("launcher propagates initial and live themes only from Suite main frame",async()=>{
 const {createDesignerLauncher}=require("../../../electron/blueprint-designer-launcher"),frame={url:"http://127.0.0.1:8810/"},webContents={mainFrame:frame},event={sender:webContents,senderFrame:frame};let env;const messages=[],child=new EventEmitter();child.stdout=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=s=>messages.push(s);
 const launcher=createDesignerLauncher({app:{isPackaged:true,getAppPath:()=>process.cwd()},existsSync:()=>true,getMainWindow:()=>({webContents}),port:8810,spawn:(_exe,_args,options)=>{env=options.env;return child;}});
 launcher.setTheme(event,"purple");const opening=launcher.open(event);assert.equal(env.ALPHANINE_DESIGNER_THEME,"purple");launcher.setTheme(event,"royal");assert.deepEqual(messages,["theme:royal\n"]);assert.throws(()=>launcher.setTheme(event,"bad\nfocus"));assert.throws(()=>launcher.setTheme({sender:{},senderFrame:frame},"gold"));child.stdout.emit("data",Buffer.from("ALPHANINE_DESIGNER_READY\n"));await opening;
});
