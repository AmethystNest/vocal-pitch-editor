
const assert=require('assert');
const PE=require('../src/engine.js');
const sr=48000;
function sine(f,sec=1,amp=.22){const x=new Float32Array(Math.round(sr*sec));for(let i=0;i<x.length;i++)x[i]=amp*Math.sin(2*Math.PI*f*i/sr);return x}
function median(pt){const a=[];for(let i=0;i<pt.f0s.length;i++)if(pt.voiced[i]&&pt.f0s[i]>0)a.push(pt.f0s[i]);a.sort((a,b)=>a-b);return a.length?a[a.length>>1]:NaN}
function cents(a,b){return 1200*Math.log2(a/b)}
for(const f of [70,80,90,110,150,220,440,880]){
 const pt=PE.yinPitchTrack(sine(f),sr),m=median(pt);
 assert(Number.isFinite(m),`no F0 ${f}Hz`);
 assert(Math.abs(cents(m,f))<5,`${f}Hz error ${cents(m,f)}c`);
 assert(PE.segmentNotes(pt).length>=1,`no segment ${f}Hz`);
}
let seed=123456789;function rnd(){seed=(1664525*seed+1013904223)>>>0;return seed/4294967296*2-1}
const noise=new Float32Array(sr);for(let i=0;i<noise.length;i++)noise[i]=rnd()*.1;
const np=PE.yinPitchTrack(noise,sr);assert([...np.voiced].reduce((a,b)=>a+b,0)===0,'noise falsely voiced');
const dry=sine(220,.8),dpt=PE.yinPitchTrack(dry,sr),ds=PE.segmentNotes(dpt);
const dout=PE.resynthesize([dry],sr,dpt,ds)[0];let max=0;for(let i=0;i<dry.length;i++)max=Math.max(max,Math.abs(dry[i]-dout[i]));
assert.strictEqual(max,0,'dry path changed');
console.log('engine-smoke: PASS');
