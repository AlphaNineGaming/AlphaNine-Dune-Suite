"use strict";
const fs=require("fs");
const [statePath,command]=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(statePath,"utf8"));
const id=n=>"sha256:"+String(n).repeat(64),repo="registry.funcom.com/funcom/self-hosting/seabass-server";
if(state.mode==="invalid"&&command.includes(" images ")){process.stdout.write("{invalid");process.exit(0);}
if(state.mode==="exit"&&command.includes(" images ")){process.stderr.write("Simulated runtime unavailable");process.exit(7);}
if(state.mode==="timeout"&&command.includes(" images ")){setInterval(()=>{},1000);}
else if(command.includes(" images "))process.stdout.write(JSON.stringify({images:[1,2,3,4,5].filter(n=>!state.removed.includes(id(n))).map(n=>({id:id(n),repoTags:[repo+":"+(2000000+n)+"-0-shipping"],repoDigests:[repo+"@"+id(n)],size:"1000"}))}));
else if(command.includes(" ps "))process.stdout.write(JSON.stringify({containers:[{id:"a".repeat(64),state:"CONTAINER_RUNNING",metadata:{name:"running-fixture"},imageRef:id(1),labels:{padding:"x".repeat(18*1024*1024)}},{id:"b".repeat(64),state:"CONTAINER_EXITED",metadata:{name:"stopped-fixture"},imageRef:id(1)}]}));
else if(command==="sudo -n k3s --version")process.stdout.write("k3s version v1.34.5+k3s1 (fixture)\n");
else if(command.includes("kubectl get nodes"))process.stdout.write(JSON.stringify({items:[{metadata:{name:"fixture-node"},status:{conditions:[{type:"Ready",status:"True"}]}}]}));
else if(command.includes("/proxy/configz"))process.stdout.write(JSON.stringify({kubeletconfig:{imageGCHighThresholdPercent:99,imageGCLowThresholdPercent:98,evictionHard:{"nodefs.available":"1%"},tlsPrivateKeyFile:"must-not-appear-in-review"}}));
else if(command.includes("kubectl get "))process.stdout.write('{"items":[]}');
else if(command.includes(" df "))process.stdout.write("Filesystem Blocks Used Available Capacity Mounted\n/dev/fixture 2000 1000 1000 50% /\n");
else if(command.includes(" rmi ")){state.removed.push(command.split(" ").at(-1));fs.writeFileSync(statePath,JSON.stringify(state));process.stdout.write("Simulated package removal only");}
else {process.stderr.write("Unknown fixture command");process.exitCode=1;}
