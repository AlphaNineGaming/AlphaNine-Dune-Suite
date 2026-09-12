"use strict";
// Original WebGL2 renderer. CPU source data and GPU view buffers are separate.
class AssemblyViewport {
  constructor(canvas,onSelect,onStatus) {
    this.canvas=canvas;this.onSelect=onSelect;this.onStatus=onStatus;this.gl=canvas.getContext("webgl2",{antialias:true,alpha:false});
    this.target=[0,0,0];this.yaw=Math.PI/4;this.pitch=Math.asin(1/Math.sqrt(3));this.scale=1;this.radius=1;this.selection=new Set();this.groups=[];this.model=null;this.visible=()=>true;this.pending=false;
    this.pieceColor=[1,1,1];
    if(!this.gl)throw Error("WebGL 2 is unavailable. The document is still preserved.");
    this.initialize();
    canvas.addEventListener("contextmenu",e=>e.preventDefault());
    canvas.addEventListener("pointerdown",e=>{if(![0,1,2].includes(e.button))return;canvas.focus();canvas.setPointerCapture(e.pointerId);this.drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,pan:e.button!==0||e.shiftKey,button:e.button,additive:e.ctrlKey||e.metaKey,moved:false};});
    canvas.addEventListener("pointermove",e=>{const d=this.drag;if(!d){this.onHover?.(e.clientX,e.clientY,e.altKey);return;}const dx=e.clientX-d.x,dy=e.clientY-d.y;d.moved ||= Math.hypot(e.clientX-d.startX,e.clientY-d.startY)>4;
      if(d.moved){if(d.pan){const b=this.basis(),f=2*this.scale/Math.max(canvas.clientHeight,1);this.target=this.target.map((n,i)=>n-dx*f*b.right[i]+dy*f*b.up[i]);}else{this.yaw+=dx*.007;this.pitch=Math.max(-1.55,Math.min(1.55,this.pitch+dy*.007));}this.requestDraw();}d.x=e.clientX;d.y=e.clientY;});
    canvas.addEventListener("pointerup",e=>{const d=this.drag;this.drag=null;if(d&&!d.moved&&d.button===0&&!d.pan&&!this.onClick?.(e.clientX,e.clientY,e.altKey))this.onSelect(this.pick(e.clientX,e.clientY),d.additive);if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});
    for(const event of ["pointercancel","lostpointercapture"])canvas.addEventListener(event,()=>this.drag=null);
    canvas.addEventListener("wheel",e=>{e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1;this.scale=Math.max(this.radius*.003,Math.min(this.radius*30,this.scale*Math.exp(Math.max(-1,Math.min(1,e.deltaY*unit*.001)))));this.requestDraw();},{passive:false});
    canvas.addEventListener("keydown",e=>{if(e.key.toLowerCase()==="f"){e.preventDefault();this.focus();}});
    canvas.addEventListener("webglcontextlost",e=>{e.preventDefault();this.lost=true;this.onStatus("Graphics context lost. Reopen the development app.");});
    new ResizeObserver(()=>this.requestDraw()).observe(canvas);
  }
  initialize(){
    const gl=this.gl,shader=(kind,source)=>{const s=gl.createShader(kind);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
    const p=this.program=gl.createProgram();
    gl.attachShader(p,shader(gl.VERTEX_SHADER,`#version 300 es
    layout(location=0) in vec3 vertex;layout(location=1) in vec3 normal;
    layout(location=2) in vec4 q;layout(location=3) in vec3 translation;layout(location=4) in vec3 scaling;layout(location=5) in float selected;
    uniform vec3 target,right,up,forward,range;out vec3 surface;flat out float highlight;
    vec3 rotateQ(vec3 v){return v+2.0*(q.w*cross(q.xyz,v)+cross(q.xyz,cross(q.xyz,v)));}
    void main(){vec3 p=rotateQ(vertex*scaling)+translation-target;gl_Position=vec4(dot(p,right)/range.x,dot(p,up)/range.y,-dot(p,forward)/range.z,1.0);surface=rotateQ(normal/scaling);highlight=selected;}`));
    gl.attachShader(p,shader(gl.FRAGMENT_SHADER,`#version 300 es
    precision highp float;in vec3 surface;flat in float highlight;uniform vec3 pieceColor,selectionColor;out vec4 color;
    void main(){vec3 n=normalize(surface);float light=.24+.55*abs(dot(n,normalize(vec3(.35,-.5,1.))))+.16*abs(n.z);vec3 base=mix(pieceColor,selectionColor,highlight);color=vec4(base*light,1.0);}`));
    gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));
    this.uniforms=Object.fromEntries(["target","right","up","forward","range","pieceColor","selectionColor"].map(n=>[n,gl.getUniformLocation(p,n)]));gl.enable(gl.DEPTH_TEST);
  }
  setPieceColor(name){if(!["white","gray"].includes(name))throw Error("Choose white or gray pieces.");this.pieceColor=name==="gray"?[.62,.62,.62]:[1,1,1];this.requestDraw();}
  basis(){const y=this.yaw,p=this.pitch;return {right:[Math.cos(y),-Math.sin(y),0],up:[-Math.sin(y)*Math.sin(p),-Math.cos(y)*Math.sin(p),Math.cos(p)],forward:[Math.sin(y)*Math.cos(p),Math.cos(y)*Math.cos(p),Math.sin(p)]};}
  setScene(scene,preserveCamera=false){
    const gl=this.gl;for(const g of this.groups){gl.deleteBuffer(g.vertices);gl.deleteBuffer(g.instances);gl.deleteVertexArray(g.vao);}this.groups=[];
    // A large palette is not the current scene. Validate and prepare only the
    // meshes referenced by instances/preview; keep the source catalog intact.
    const used=new Set(scene?.instances.map(r=>r.type)||[]);
    this.model=scene?BlueprintScene.prepared({...scene,entries:scene.entries.filter(e=>used.has(e.id))}):null;this.selection=new Set();
    if(!this.model){this.requestDraw();return;}
    const started=performance.now();
    for(const [type,mesh] of this.model.meshes){
      const rows=this.model.rows.filter(r=>r.type===type&&r.box);if(!rows.length)continue;
      const {vertices,indices}=mesh.entry.geometry,packed=new Float32Array(indices.length*6);let count=0;
      for(let i=0;i<indices.length;i+=3){const points=indices.slice(i,i+3).map(j=>vertices[j]);const normal=BlueprintScene.cross(BlueprintScene.sub(points[1],points[0]),BlueprintScene.sub(points[2],points[0])),length=Math.hypot(...normal);if(length<1e-12)continue;for(const v of points){packed.set(v,count);packed.set(normal.map(n=>n/length),count+3);count+=6;}}
      const group={type,rows,vao:gl.createVertexArray(),vertices:gl.createBuffer(),instances:gl.createBuffer(),count:count/6,visibleCount:0};this.groups.push(group);
      gl.bindVertexArray(group.vao);gl.bindBuffer(gl.ARRAY_BUFFER,group.vertices);gl.bufferData(gl.ARRAY_BUFFER,packed.subarray(0,count),gl.STATIC_DRAW);
      for(const [loc,offset] of [[0,0],[1,12]]){gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,3,gl.FLOAT,false,24,offset);}
      gl.bindBuffer(gl.ARRAY_BUFFER,group.instances);
      for(const [loc,size,offset] of [[2,4,0],[3,3,16],[4,3,28],[5,1,40]]){gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,size,gl.FLOAT,false,44,offset);gl.vertexAttribDivisor(loc,1);}
    }
    this.uploadInstances();if(!preserveCamera)this.fit();else this.radius=Math.max(this.radius,this.model.box?.radius||1);this.loadMs=performance.now()-started;
  }
  uploadInstances(){const gl=this.gl;for(const g of this.groups){const rows=g.rows.filter(this.visible),data=new Float32Array(rows.length*11);rows.forEach((r,i)=>data.set([...r.quaternion,...r.position,...r.scale,this.selection.has(r.key)?1:0],i*11));gl.bindBuffer(gl.ARRAY_BUFFER,g.instances);gl.bufferData(gl.ARRAY_BUFFER,data,gl.DYNAMIC_DRAW);g.visibleCount=rows.length;}this.requestDraw();}
  setView(selection,visible){this.selection=new Set(selection);this.visible=visible;this.uploadInstances();}
  fit(){if(!this.model)return;const rows=this.model.rows.filter(r=>r.box&&this.visible(r));this.fitRows(rows);}
  focus(){if(!this.model)return;const rows=this.model.rows.filter(r=>r.box&&this.visible(r)&&this.selection.has(r.key));if(rows.length)this.fitRows(rows);}
  fitRows(rows){const f=BlueprintScene.frame(rows,this.basis(),this.canvas.clientWidth/Math.max(1,this.canvas.clientHeight));if(!f)return;this.target=f.target;this.radius=Math.max(f.radius,this.model.box?.radius||1);this.scale=f.scale;this.requestDraw();}
  setAngle(name){if(name==="top"){this.yaw=0;this.pitch=Math.PI/2;}else if(name==="front"){this.yaw=0;this.pitch=0;}else{this.yaw=Math.PI/4;this.pitch=Math.asin(1/Math.sqrt(3));}this.requestDraw();}
  ray(x,y){const r=this.canvas.getBoundingClientRect(),b=this.basis(),aspect=r.width/r.height,px=((x-r.left)/r.width*2-1)*this.scale*aspect,py=(1-(y-r.top)/r.height*2)*this.scale,depth=Math.max(this.radius*4,this.scale*4);return {origin:this.target.map((n,i)=>n+b.right[i]*px+b.up[i]*py+b.forward[i]*depth),direction:b.forward.map(n=>-n)};}
  planePoint(x,y,z){const {origin,direction}=this.ray(x,y);return BlueprintScene.planePoint(origin,direction,z);}
  projector(){const r=this.canvas.getBoundingClientRect(),b=this.basis(),target=[...this.target],scale=this.scale;return point=>{const delta=BlueprintScene.sub(point,target);return [(BlueprintScene.dot(delta,b.right)/(scale*r.width/r.height)+1)*r.width/2,(1-BlueprintScene.dot(delta,b.up)/scale)*r.height/2];};}
  projectPoint(point){return this.projector()(point);}
  pick(x,y){if(!this.model)return null;const {origin,direction}=this.ray(x,y);return BlueprintScene.pick(this.model,origin,direction,r=>!r.preview&&this.visible(r));}
  requestDraw(){if(this.pending||this.lost)return;this.pending=true;requestAnimationFrame(()=>{this.pending=false;this.draw();});}
  draw(){
    if(this.lost)return;const start=performance.now(),gl=this.gl,c=this.canvas,dpr=Math.min(devicePixelRatio||1,2),w=Math.round(c.clientWidth*dpr),h=Math.round(c.clientHeight*dpr);if(!w||!h)return;
    if(c.width!==w||c.height!==h){c.width=w;c.height=h;}gl.viewport(0,0,w,h);gl.clearColor(...(this.backgroundColor||[.047,.059,.064]),1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(this.program);
    const b=this.basis();gl.uniform3fv(this.uniforms.target,this.target);for(const key of ["right","up","forward"])gl.uniform3fv(this.uniforms[key],b[key]);gl.uniform3f(this.uniforms.range,this.scale*w/h,this.scale,Math.max(this.radius*4,this.scale*4));
    gl.uniform3fv(this.uniforms.pieceColor,this.pieceColor);gl.uniform3fv(this.uniforms.selectionColor,this.selectionColor||[1,.70,.22]);
    let instances=0,triangles=0;for(const g of this.groups){gl.bindVertexArray(g.vao);gl.drawArraysInstanced(gl.TRIANGLES,0,g.count,g.visibleCount);instances+=g.visibleCount;triangles+=g.count/3*g.visibleCount;}
    this.lastDraw={instances,triangles,cpuSubmitMs:performance.now()-start,drawCalls:this.groups.length};this.onStatus(`${instances.toLocaleString()} meshes · ${triangles.toLocaleString()} triangles · Z up`);this.onDraw?.();
  }
}
window.AssemblyViewport=AssemblyViewport;
