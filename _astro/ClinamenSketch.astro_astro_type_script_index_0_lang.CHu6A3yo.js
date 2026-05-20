import{m as Vt}from"./sketch-lifecycle.DmMJK9ls.js";const Xt=`#version 300 es
// Clinamen vertex shader — full-screen quad.
// a_pos is in clip space [-1, 1]^2; v_uv carries [0, 1]^2 with origin at
// bottom-left (standard GL). The fragment shader flips y if it wants a
// top-left origin.
precision highp float;

in vec2 a_pos;
out vec2 v_uv;

void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`,Kt=`#version 300 es
// Clinamen — fragment shader (phase 2b, dispersion tuned).
//
// Reverted from phase 2c's wave-equation height field back to the analytic
// ripple-packet framework. The wave equation gave real interference and
// wall reflection but smeared the clean concentric-ring aesthetic. Discrete
// packets (Gaussian envelope × radial sine) produce crisp geometric rings
// with clearly-separable caustic bands — exactly the reference look.
//
// Dispersion coefficients lifted back up so the bright caustic edges carry
// visible spectral fringing (R on outer, B on inner), matching the classic
// caustic-with-chromatic-aberration aesthetic.
//
// Iteration trace:
//   - Phase 1 iter 1-3: point lights + analytic surface + ripples.
//   - Phase 2a: physical-radius lanterns, collision-driven ripples.
//   - Phase 2b: audio (modal bells).
//   - Phase 2c: wave equation (reverted — lost the visual target).
//   - Phase 2b-revised (this): back to analytic, dispersion tuned to match
//     the reference pool-caustic aesthetic.
//
// Coordinates:
//   - v_uv [0,1]^2 with bottom-left origin → flipped to top-left.
//   - World space is aspect-corrected: x ∈ [0, aspect], y ∈ [0, 1].
//   - Lanterns and ripples upload positions in [0, 1]^2 UV space.
//   - Lantern radius uploads in world units (uniform under aspect change).

precision highp float;

in vec2 v_uv;
out vec4 o_color;

uniform vec2  u_resolution;
uniform float u_time;
uniform int   u_lanternCount;
uniform int   u_rippleCount;
// Lantern: xy = position in [0,1]^2, z = intensity, w = radius (world units).
uniform vec4  u_lanterns[64];
// Ripple: xy = center in [0,1]^2, z = age in seconds, w = amplitude.
uniform vec4  u_ripples[24];
// Ripple shape: x = wavelength (world), y = outward speed (world/sec),
// z = temporal decay constant (sec), w = initial envelope width (world).
uniform vec4  u_rippleShape[24];

// Water base — near-black teal.
const vec3 WATER_SHALLOW = vec3(0.013, 0.021, 0.033);
const vec3 WATER_DEEP    = vec3(0.002, 0.003, 0.008);

// Lantern color layers.
const vec3 LANTERN_CORE  = vec3(1.00, 0.94, 0.82);
const vec3 LANTERN_SHELL = vec3(1.00, 0.76, 0.48);
const vec3 LANTERN_GLOW  = vec3(1.00, 0.56, 0.20);

// Caustic tint + wavelength absorption.
const vec3 CAUSTIC_TINT  = vec3(1.00, 0.88, 0.70);
const vec3 ABSORPTION    = vec3(6.0, 2.4, 1.3);
const float CAUSTIC_FALLOFF = 20.0;

const int   MAX_LANTERNS = 64;
const int   MAX_RIPPLES  = 24;
const float EPS = 0.0025;
const float TWO_PI = 6.28318530718;

// Ripple: Gaussian wave packet traveling outward from c.
//
// Two refinements beyond the textbook packet:
//   - coreMask: pins the height to zero at and near the center. Without it,
//     the sin factor at r=0 oscillates with age as the wave "passes
//     through" the source — physically wrong for a splash (water is
//     displaced around the impact, not at the impact point).
//   - fadeIn: ramps amplitude smoothly over ~45ms so ripples swell into
//     existence instead of popping on frame 1.
float rippleHeight(vec2 p, vec2 c, float age, float amp, vec4 shape) {
  float lambda   = shape.x;
  float v        = shape.y;
  float decay    = shape.z;
  float sigma0   = shape.w;
  float r        = length(p - c);
  float sigma    = sigma0 + age * 0.09;
  float temporal = exp(-age / decay);
  float fadeIn   = 1.0 - exp(-age / 0.045);
  float offset   = r - v * age;
  float spatial  = exp(-(offset * offset) / (sigma * sigma));
  const float CORE_R = 0.022;
  float coreMask = 1.0 - exp(-(r * r) / (CORE_R * CORE_R));
  return amp * sin(offset * TWO_PI / lambda) * temporal * fadeIn * spatial * coreMask;
}

float surfaceHeight(vec2 p, float t) {
  // Quiet omnipresent undulation.
  float h = 0.0;
  h += sin(dot(p, vec2(18.0,  0.0)) + t * 0.60) * 0.018;
  h += sin(dot(p, vec2( 0.0, 16.0)) - t * 0.55) * 0.018;
  h += sin(dot(p, vec2(14.0, 14.0)) + t * 0.78) * 0.012;
  h += sin(dot(p, vec2(23.0,-23.0)) - t * 0.72) * 0.010;

  // Event ripples.
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  for (int i = 0; i < MAX_RIPPLES; i++) {
    if (i >= u_rippleCount) break;
    vec2 c = u_ripples[i].xy * aspect;
    h += rippleHeight(p, c, u_ripples[i].z, u_ripples[i].w, u_rippleShape[i]);
  }
  return h;
}

void main() {
  vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 p = uv * aspect;
  float t = u_time;

  // ---- Caustics (single-sample laplacian, per-channel scale) ----
  // Previous version sampled 3 position-shifted laplacians for chromatic
  // dispersion — 19 surfaceHeight() calls per pixel, each looping through
  // all active ripples. Collapsed to one 5-tap stencil (4x cheaper at
  // 24-ripple load) and kept chromatic flavor via per-channel multiplier
  // only. The position-shift dispersion was invisible once caustic blend
  // dropped to 0.18 anyway.
  float hC = surfaceHeight(p,                       t);
  float hL = surfaceHeight(p - vec2(EPS, 0.0),      t);
  float hR = surfaceHeight(p + vec2(EPS, 0.0),      t);
  float hD = surfaceHeight(p - vec2(0.0, EPS),      t);
  float hU = surfaceHeight(p + vec2(0.0, EPS),      t);
  float lap = (hL + hR + hD + hU - 4.0 * hC) / (EPS * EPS);
  vec3 causticPattern = clamp(vec3(
    1.0 - lap * 0.0013,
    1.0 - lap * 0.0014,
    1.0 - lap * 0.0016
  ), 0.0, 2.0);

  // ---- Base water ----
  float vignette = smoothstep(0.10, 1.25, length(v_uv - 0.5));
  vec3 col = mix(WATER_SHALLOW, WATER_DEEP, vignette);

  // ---- Per-lantern: halo + own caustic zone ----
  vec3 halos = vec3(0.0);
  vec3 caustic = vec3(0.0);

  for (int i = 0; i < MAX_LANTERNS; i++) {
    if (i >= u_lanternCount) break;
    vec4 L = u_lanterns[i];
    vec2 lpWorld = vec2(L.x * aspect.x, L.y);
    float intensity = L.z;
    float radius = L.w;
    float dist = length(p - lpWorld);
    float nd = dist / radius;

    float shell = (1.0 - smoothstep(0.20, 1.10, nd)) * 0.38;
    float core  = exp(-nd * 6.0) * 0.55;
    float glow  = exp(-nd * 1.5) * 0.25;
    float near  = exp(-nd * 0.55) * 0.050;
    halos += LANTERN_CORE  * core  * intensity;
    halos += LANTERN_SHELL * shell * intensity;
    halos += LANTERN_GLOW  * (glow + near) * intensity;

    float falloff = exp(-dist * CAUSTIC_FALLOFF);
    vec3 absorption = exp(-ABSORPTION * dist);
    caustic += causticPattern * CAUSTIC_TINT * absorption * falloff * intensity;
  }

  // ---- Compose ----
  // Caustic blend pulled down from 0.42 — user direction was to cut
  // further; 0.18 leaves just a hint of under-lantern ripple shimmer
  // without the water pattern dominating.
  col += caustic * 0.18;
  col += halos * 0.82;

  col = col / (col + 0.45);
  col = pow(col, vec3(1.0 / 2.2));

  o_color = vec4(col, 1.0);
}
`,Yt=[{ratio:1,amp:1,decayBase:1,decaySpan:1.4},{ratio:2.01,amp:.5,decayBase:.7,decaySpan:.7},{ratio:2.76,amp:.32,decayBase:.45,decaySpan:.4},{ratio:4.13,amp:.18,decayBase:.25,decaySpan:.2}],gt=.003,jt=6,Zt=.38,$t=.58,Qt=.78,Jt=6.5,te=1.5,ee=2500,ne=7;class ae{ctx=null;voiceBus=null;get ready(){return this.ctx!==null}async wake(){if(this.ctx)return;const n=window.AudioContext||window.webkitAudioContext;if(!n){console.warn("[modal-bell] Web Audio API not available.");return}const p=new n;if(p.state==="suspended")try{await p.resume()}catch{}const M=p.createGain();M.gain.value=Zt;const _=p.createGain();_.gain.value=$t;const r=p.createGain();r.gain.value=Qt;const w=p.createConvolver();w.buffer=this.buildReverbIR(p,Jt,te);const A=p.createBiquadFilter();A.type="highshelf",A.frequency.value=ee,A.gain.value=ne;const v=p.createDynamicsCompressor();v.threshold.value=-16,v.knee.value=8,v.ratio.value=3,v.attack.value=.005,v.release.value=.25,M.connect(_),M.connect(w),w.connect(A),A.connect(r),_.connect(v),r.connect(v),v.connect(p.destination),this.ctx=p,this.voiceBus=M}strike({pitch:n,velocity:p,size:M}){const _=this.ctx,r=this.voiceBus;if(!_||!r||p<=0)return;const w=_.currentTime,A=Math.pow(2,(Math.random()*2-1)*jt/1200),v=Math.min(1,p),V=Math.min(1,Math.max(0,M));for(const b of Yt){const D=_.createOscillator();D.type="sine",D.frequency.value=n*b.ratio*A;const I=_.createGain(),Y=v*b.amp*.32,et=b.decayBase+V*b.decaySpan;I.gain.setValueAtTime(1e-4,w),I.gain.linearRampToValueAtTime(Y,w+gt),I.gain.exponentialRampToValueAtTime(1e-4,w+gt+et),D.connect(I),I.connect(r),D.start(w),D.stop(w+gt+et+.05)}}suspend(){this.ctx?.suspend().catch(()=>{})}resume(){this.ctx?.resume().catch(()=>{})}dispose(){try{this.ctx?.close()}catch{}this.ctx=null,this.voiceBus=null}buildReverbIR(n,p,M){const _=n.sampleRate,r=Math.max(1,Math.floor(p*_)),w=n.createBuffer(2,r,_);for(let A=0;A<2;A++){const v=w.getChannelData(A);let V=0;for(let b=0;b<r;b++){const D=b/r,I=Math.random()*2-1,Y=I-.6*V;V=I,v[b]=Y*Math.pow(1-D,M)}}return w}}const J=24,oe=5,se=15,tt=.018,it=.055,ie=.025,ce=440,Dt=.012,ct=.018,xt=.18,kt=340,re=3,le=64,rt=1200,Bt=3e3,Ot=.03,H=.14,lt=1.6,pe=.985,Ft=.06,fe=.12;Vt(()=>{const m=document.getElementById("clinamen-gl");if(!m)return;const n=m.getContext("webgl2",{antialias:!1,alpha:!1,premultipliedAlpha:!1});if(!n){console.warn("[clinamen] WebGL2 not available; sketch cannot render.");return}function p(i,c){const a=n.createShader(i);if(n.shaderSource(a,c),n.compileShader(a),!n.getShaderParameter(a,n.COMPILE_STATUS)){const l=n.getShaderInfoLog(a);throw n.deleteShader(a),new Error(`[clinamen] Shader compile error:
${l}`)}return a}const M=p(n.VERTEX_SHADER,Xt),_=p(n.FRAGMENT_SHADER,Kt),r=n.createProgram();if(n.attachShader(r,M),n.attachShader(r,_),n.linkProgram(r),!n.getProgramParameter(r,n.LINK_STATUS))throw new Error(`[clinamen] Program link error:
${n.getProgramInfoLog(r)}`);n.useProgram(r);const w=new Float32Array([-1,-1,1,-1,-1,1,1,1]),A=n.createBuffer();n.bindBuffer(n.ARRAY_BUFFER,A),n.bufferData(n.ARRAY_BUFFER,w,n.STATIC_DRAW);const v=n.getAttribLocation(r,"a_pos");n.enableVertexAttribArray(v),n.vertexAttribPointer(v,2,n.FLOAT,!1,0,0);const V=n.getUniformLocation(r,"u_resolution"),b=n.getUniformLocation(r,"u_time"),D=n.getUniformLocation(r,"u_lanternCount"),I=n.getUniformLocation(r,"u_lanterns"),Y=n.getUniformLocation(r,"u_rippleCount"),et=n.getUniformLocation(r,"u_ripples"),Wt=n.getUniformLocation(r,"u_rippleShape"),f=(i,c)=>i+Math.random()*(c-i);function Ht(i,c){const a=[];for(let x=0;x<i;x++){let L=!1;for(let t=0;t<500&&!L;t++){const o=f(tt,it),e=f(o,c-o),s=f(o,1-o);let R=!0;for(const d of a){const E=e-d.x,C=s-d.y,S=o+d.radius+.01;if(E*E+C*C<S*S){R=!1;break}}if(R){const d=f(.45,.78),E=ce*(ie/o)*f(.98,1.02);a.push({x:e,y:s,vx:f(-.015,.015),vy:f(-.015,.015),radius:o,intensity:d,pitch:E,lastStrikeAt:-1/0,flash:0,proximityDim:0,targetDim:0}),L=!0}}}return a}const k=new Float32Array(256);let y=[];const g=[],B=new Float32Array(J*4),O=new Float32Array(J*4),_t=(i,c)=>{const a=Math.min(i,1-i,c,1-c),l=Math.max(0,Math.min(1,a/fe));return l*l*(3-2*l)};function Ut(i,c,a,l){const x=a*_t(i,c);if(x<1e-4)return;g.length>=J&&g.shift();const L=f(.1,.24),t=f(.25,.65),o=f(1.3,2.6),e=f(.14,.26);g.push({cx:i,cy:c,birth:l,amp:x,lambda:L,v:t,decay:o,sigma0:e})}function Gt(i){let c=0,a=0,l=-1;for(let R=0;R<6;R++){const d=f(.08,.92),E=f(.08,.92),C=d*P;let S=1/0;for(const G of y){const u=C-G.x,h=E-G.y,mt=u*u+h*h;mt<S&&(S=mt)}S>l&&(l=S,c=d,a=E)}const L=f(.006,.015)*_t(c,a);if(L<1e-4)return;g.length>=J&&g.shift();const t=f(.1,.24),o=f(.25,.65),e=f(1.3,2.6),s=f(.14,.26);g.push({cx:c,cy:a,birth:i,amp:L,lambda:t,v:o,decay:e,sigma0:s})}let wt=performance.now()+rt+Math.random()*(Bt-rt);const nt=new Set;function At(i,c,a){const l=(o,e)=>{const s=Math.sin(Math.PI*o/P)*Math.sin(Math.PI*e);return s<=0?0:s*(Math.sin(o*2.4+a*.35)*Math.cos(e*2.1-a*.3)+.55*Math.sin((o+e)*1.3+a*.22)+.3*Math.cos(o*3.5-e*2.8+a*.28)+.4*Math.sin(o*5.7-a*.42)*Math.cos(e*5.2+a*.38))},L=(l(i,c+.01)-l(i,c-.01))/.02,t=(l(i+.01,c)-l(i-.01,c))/(2*.01);return[L*Ot,-t*Ot]}let P=1;function pt(){const i=Math.min(window.devicePixelRatio||1,1.5),c=m.getBoundingClientRect(),a=Math.max(1,Math.floor(c.width*i)),l=Math.max(1,Math.floor(c.height*i));(m.width!==a||m.height!==l)&&(m.width=a,m.height=l,n.viewport(0,0,a,l)),P=m.width/m.height}pt(),y=Ht(se,P),window.addEventListener("resize",pt);let U=!1,ft=0,Et=0;const Lt=i=>{const c=i.detail,a=performance.now();c?.paused&&!U?(U=!0,ft=a,F.suspend()):!c?.paused&&U&&(U=!1,Et+=a-ft,F.resume())};window.addEventListener("stage:pause",Lt);const ut=matchMedia("(prefers-reduced-motion: reduce)").matches,F=new ae,ht=m.parentElement?.querySelector("[data-audio-hint]")??null,Rt=()=>{F.wake().then(()=>{F.ready&&ht&&ht.classList.add("awake")})};ut?ht?.classList.add("awake"):m.addEventListener("pointerdown",Rt);let St=0,Mt=!1;const dt=performance.now();let bt=dt;function zt(i,c,a){const l=Math.pow(pe,i*60);let x=re;for(const t of y){const[o,e]=At(t.x,t.y,c);t.vx=t.vx*l+(o-t.vx)*Ft*i*60,t.vy=t.vy*l+(e-t.vy)*Ft*i*60;const s=t.x,R=P-t.x,d=t.y,E=1-t.y;s<H&&(t.vx+=lt*(1-s/H)*i),R<H&&(t.vx-=lt*(1-R/H)*i),d<H&&(t.vy+=lt*(1-d/H)*i),E<H&&(t.vy-=lt*(1-E/H)*i),t.x+=t.vx*i,t.y+=t.vy*i}for(const t of y)t.x<t.radius&&(t.x=t.radius,t.vx<0&&(t.vx=-t.vx)),t.x>P-t.radius&&(t.x=P-t.radius,t.vx>0&&(t.vx=-t.vx)),t.y<t.radius&&(t.y=t.radius,t.vy<0&&(t.vy=-t.vy)),t.y>1-t.radius&&(t.y=1-t.radius,t.vy>0&&(t.vy=-t.vy));for(const t of y)t.targetDim=0;for(let t=0;t<y.length;t++)for(let o=t+1;o<y.length;o++){const e=y[t],s=y[o],R=s.x-e.x,d=s.y-e.y,E=R*R+d*d,C=e.radius+s.radius,S=t*le+o;if(E>=C*C){nt.has(S)&&nt.delete(S);const N=C*1,T=Math.sqrt(E),z=T-C;if(z<N){const X=R/T,W=d/T;if((e.vx-s.vx)*X+(e.vy-s.vy)*W>0){const Q=1-z/N,K=Q*Q*(3-2*Q);K>e.targetDim&&(e.targetDim=K),K>s.targetDim&&(s.targetDim=K)}}continue}const G=Math.sqrt(E);if(G<1e-6)continue;const u=R/G,h=d/G,at=(C-G)*.5+3e-4;if(e.x-=u*at,e.y-=h*at,s.x+=u*at,s.y+=h*at,nt.has(S)){const N=e.vx*u+e.vy*h,T=s.vx*u+s.vy*h;if(N-T>0){const z=e.radius*e.radius,X=s.radius*s.radius,W=(z*N+X*T)/(z+X);e.vx+=(W-N)*u,e.vy+=(W-N)*h,s.vx+=(W-T)*u,s.vy+=(W-T)*h}continue}const j=e.vx*u+e.vy*h,Z=s.vx*u+s.vy*h,vt=j-Z;if(nt.add(S),vt<=0)continue;const ot=e.radius*e.radius,st=s.radius*s.radius,Tt=ot+st,It=(j*(ot-st)+2*st*Z)/Tt,Ct=(Z*(st-ot)+2*ot*j)/Tt;if(e.vx+=(It-j)*u,e.vy+=(It-j)*h,s.vx+=(Ct-Z)*u,s.vy+=(Ct-Z)*h,vt>Dt){const N=-(e.vx*u+e.vy*h);if(N<ct){const q=ct-N;e.vx-=u*q,e.vy-=h*q}const T=s.vx*u+s.vy*h;if(T<ct){const q=ct-T;s.vx+=u*q,s.vy+=h*q}const z=e.x+u*e.radius,X=e.y+h*e.radius,W=Math.min(1,Math.max(0,(vt-Dt)/.05)),$=Math.pow(W,2.5),Q=.002+$*.028;Ut(z/P,X,Q,a);const K=Math.sqrt((e.radius+s.radius)/(2*it)),Nt=$*K*1.5;if(e.flash=Math.min(1,e.flash+Nt),s.flash=Math.min(1,s.flash+Nt),F.ready){const q=x>0&&a-e.lastStrikeAt>kt,qt=x>0&&a-s.lastStrikeAt>kt;if(q){const yt=(e.radius-tt)/(it-tt);F.strike({pitch:e.pitch,velocity:$*.55,size:yt}),e.lastStrikeAt=a,x--}if(qt&&x>0){const yt=(s.radius-tt)/(it-tt);F.strike({pitch:s.pitch,velocity:$*.55,size:yt}),s.lastStrikeAt=a,x--}}}}for(const t of g){const[o,e]=At(t.cx*P,t.cy,c);t.cx=Math.max(0,Math.min(1,t.cx+o/P*i)),t.cy=Math.max(0,Math.min(1,t.cy+e*i))}const L=xt*xt;for(const t of y){const o=t.vx*t.vx+t.vy*t.vy;if(o>L){const e=xt/Math.sqrt(o);t.vx*=e,t.vy*=e}}}function Pt(){if(Mt)return;ut||(St=requestAnimationFrame(Pt));const i=performance.now();let c=(i-bt)/1e3;bt=i,c>.1&&(c=.1),U&&(c=0);const a=U?ft:i-Et,l=(a-dt)/1e3;if(!U)for(zt(c,l,a),a>=wt&&(Gt(a),wt=a+rt+Math.random()*(Bt-rt));g.length>0&&(a-g[0].birth)/1e3>oe;)g.shift();const x=Math.exp(-c/.34);for(const t of y)t.flash*=x;const L=1-Math.exp(-c/.2);for(const t of y)t.proximityDim+=(t.targetDim-t.proximityDim)*L;for(let t=0;t<64;t++)if(t<y.length){const o=y[t],s=1-o.proximityDim*(1-o.flash)*.55;k[t*4+0]=o.x/P,k[t*4+1]=o.y,k[t*4+2]=o.intensity*s*(1+o.flash*2.5),k[t*4+3]=o.radius}else k[t*4+0]=0,k[t*4+1]=0,k[t*4+2]=0,k[t*4+3]=.01;for(let t=0;t<J;t++)if(t<g.length){const o=g[t],e=(a-o.birth)/1e3;B[t*4+0]=o.cx,B[t*4+1]=o.cy,B[t*4+2]=e,B[t*4+3]=o.amp,O[t*4+0]=o.lambda,O[t*4+1]=o.v,O[t*4+2]=o.decay,O[t*4+3]=o.sigma0}else B[t*4+0]=0,B[t*4+1]=0,B[t*4+2]=0,B[t*4+3]=0,O[t*4+0]=0,O[t*4+1]=0,O[t*4+2]=1,O[t*4+3]=1;n.uniform2f(V,m.width,m.height),n.uniform1f(b,l),n.uniform1i(D,y.length),n.uniform4fv(I,k),n.uniform1i(Y,g.length),n.uniform4fv(et,B),n.uniform4fv(Wt,O),n.drawArrays(n.TRIANGLE_STRIP,0,4)}if(ut){const i=dt+2e3;g.push({cx:.3,cy:.35,birth:i-800,amp:.022,lambda:.13,v:.55,decay:1.6,sigma0:.16}),g.push({cx:.62,cy:.58,birth:i-1800,amp:.014,lambda:.21,v:.32,decay:2.4,sigma0:.22})}return Pt(),()=>{Mt=!0,cancelAnimationFrame(St),window.removeEventListener("resize",pt),window.removeEventListener("stage:pause",Lt),m.removeEventListener("pointerdown",Rt),F.dispose(),n.deleteBuffer(A),n.deleteProgram(r),n.deleteShader(M),n.deleteShader(_),n.getExtension("WEBGL_lose_context")?.loseContext()}});
