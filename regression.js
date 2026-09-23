'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PE = require('../src/engine.js');
const sr = 48000;
global.requestAnimationFrame = callback => setImmediate(() => callback(Date.now()));
function sine(f, sec=1.2) { const a=new Float32Array(Math.round(sr*sec)); for(let i=0;i<a.length;i++) a[i]=.25*Math.sin(2*Math.PI*f*i/sr); return a; }
function median(pt) {const a=[]; for(let i=0;i<pt.f0s.length;i++) if(pt.voiced[i]&&pt.f0s[i]>0) a.push(pt.f0s[i]);a.sort((x,y)=>x-y);return a[a.length>>1];}
function maxDiff(a,b){assert.equal(a.length,b.length);let m=0;for(let i=0;i<a.length;i++){assert(Number.isFinite(b[i]),`nonfinite sample ${i}`);m=Math.max(m,Math.abs(a[i]-b[i]));}return m;}
async function main(){
  const input=sine(220); const track=PE.yinPitchTrack(input,sr);const segments=PE.segmentNotes(track);
  assert(segments.length>0,'no segments');
  const dry=PE.resynthesize([input],sr,track,segments)[0];
  assert.equal(maxDiff(input,dry),0,'dry output differs');
  const edited=segments.map(s=>({...s,shiftSemitones:3}));
  const standard=PE.resynthesize([input],sr,track,edited)[0];
  const chunked=(await PE.resynthesizeChunked([input],sr,track,edited,{blockFrames:4096}))[0];
  const difference=maxDiff(standard,chunked);
  assert(difference<1e-5,`chunked vs standard ${difference}`);
  const outputPitch=median(PE.yinPitchTrack(standard,sr));
  assert(Number.isFinite(outputPitch) && Math.abs(1200*Math.log2(outputPitch/(220*Math.pow(2,3/12))))<30,`edited F0 ${outputPitch}`);
  const stereo=[input,Float32Array.from(input,x=>x*.5)];
  const wav=await PE.encodeWavChunked(stereo,sr,{framesPerChunk:4096});
  const bytes=new DataView(await wav.arrayBuffer());
  assert.equal(bytes.getUint32(0,true),0x46464952); // RIFF
  assert.equal(bytes.getUint32(8,true),0x45564157); // WAVE
  assert.equal(bytes.getUint16(22,true),2);
  assert.equal(bytes.getUint32(24,true),sr);
  assert.equal(bytes.getUint16(34,true),24);
  assert.equal(bytes.getUint32(40,true),input.length*2*3);
  assert.equal(bytes.byteLength,44+input.length*2*3);
  const messages=[];
  const context={PitchEngine:PE,Float32Array,postMessage:(m)=>messages.push(m)};
  context.self=context;
  context.importScripts=(path)=>assert.equal(path,'./engine.js');
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/worker.js'),'utf8'),context,{filename:'worker.js'});
  context.onmessage({data:{type:'analyze',id:12,signal:sine(220,.4),sr}});
  assert.equal(messages[0].type,'analyzed');assert.equal(messages[0].id,12);
  assert(messages[0].segments.length>0);
  console.log(`regression PASS: edit→F0 ${outputPitch.toFixed(2)} Hz; standard/chunked max Δ ${difference}; stereo WAV header; worker analyze`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
