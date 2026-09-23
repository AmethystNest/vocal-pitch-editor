'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const PE = require('../src/engine.js');
const sr = 48000;
global.requestAnimationFrame = callback => setImmediate(() => callback(Date.now()));
function sine(f, sec=1.2) { const a=new Float32Array(Math.round(sr*sec)); for(let i=0;i<a.length;i++) a[i]=.25*Math.sin(2*Math.PI*f*i/sr); return a; }
function vibrato(base, depthCents=35, rate=5.5, sec=1.8) { const a=new Float32Array(Math.round(sr*sec)); let phase=0; for(let i=0;i<a.length;i++){const t=i/sr;const f=base*Math.pow(2,(depthCents*Math.sin(2*Math.PI*rate*t))/1200);phase+=2*Math.PI*f/sr;a[i]=.25*Math.sin(phase);} return a; }
function voicedWithNoise(base=220, sec=1.8) { const a=new Float32Array(Math.round(sr*sec)); let seed=0x12345678; for(let i=0;i<a.length;i++){const t=i/sr;seed=(1664525*seed+1013904223)>>>0;const noise=((seed/0xffffffff)*2-1)*.18;const voiced=.24*Math.sin(2*Math.PI*base*t);a[i]=(t>.72&&t<.94)?noise:voiced;} return a; }
function median(pt) {const a=[]; for(let i=0;i<pt.f0s.length;i++) if(pt.voiced[i]&&pt.f0s[i]>0) a.push(pt.f0s[i]);a.sort((x,y)=>x-y);return a[a.length>>1];}
function midiSpread(pt){const a=[];for(let i=0;i<pt.f0s.length;i++)if(pt.voiced[i]&&pt.f0s[i]>0)a.push(69+12*Math.log2(pt.f0s[i]/440));a.sort((x,y)=>x-y);if(a.length<8)return NaN;return a[Math.floor(a.length*.9)]-a[Math.floor(a.length*.1)];}
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
  // A uniform note correction must retain the singer's pitch modulation.
  // Compare robust F0 spread before/after instead of individual YIN frames.
  const vib=vibrato(220);const vibTrack=PE.yinPitchTrack(vib,sr);const vibSegs=PE.segmentNotes(vibTrack);
  assert(vibSegs.length>0,'no vibrato segment');
  const vibEdited=vibSegs.map(s=>({...s,shiftSemitones:2}));
  const vibOut=PE.resynthesize([vib],sr,vibTrack,vibEdited)[0];
  const spreadIn=midiSpread(vibTrack),spreadOut=midiSpread(PE.yinPitchTrack(vibOut,sr));
  assert(Number.isFinite(spreadIn)&&Number.isFinite(spreadOut)&&spreadOut/spreadIn>0.70&&spreadOut/spreadIn<1.35,`vibrato spread ${spreadIn} -> ${spreadOut}`);
  // Consonant/breath-like unvoiced material inside an edited note must stay
  // sample-for-sample dry; pitch correction should touch only voiced frames.
  const mixed=voicedWithNoise();const mixedTrack=PE.yinPitchTrack(mixed,sr);const mixedSegs=PE.segmentNotes(mixedTrack);
  assert(mixedSegs.length>0,'no mixed voiced segment');
  const mixedEdited=mixedSegs.map(s=>({...s,shiftSemitones:3}));
  const mixedOut=PE.resynthesize([mixed],sr,mixedTrack,mixedEdited)[0];
  const noiseLo=Math.floor(.77*sr),noiseHi=Math.floor(.89*sr);let noiseDelta=0;
  for(let i=noiseLo;i<noiseHi;i++)noiseDelta=Math.max(noiseDelta,Math.abs(mixedOut[i]-mixed[i]));
  assert(noiseDelta<1e-7,`unvoiced material changed ${noiseDelta}`);
  // Wet/dry transitions around consonants must not introduce an isolated
  // discontinuity. Compare the largest adjacent-sample step with the source.
  let sourceStep=0,outputStep=0;
  for(let i=Math.floor(.68*sr)+1;i<Math.floor(.99*sr);i++){
    sourceStep=Math.max(sourceStep,Math.abs(mixed[i]-mixed[i-1]));
    outputStep=Math.max(outputStep,Math.abs(mixedOut[i]-mixedOut[i-1]));
  }
  assert(outputStep<=sourceStep*1.15+1e-6,`wet/dry boundary click ${sourceStep} -> ${outputStep}`);
  // All channels share one grain schedule. A proportional stereo image must
  // therefore remain proportional after pitch correction (no L/R phase drift).
  const stereoIn=[input,Float32Array.from(input,x=>x*.5)];
  const stereoOut=PE.resynthesize(stereoIn,sr,track,edited);let stereoError=0;
  for(let i=0;i<stereoOut[0].length;i++)stereoError=Math.max(stereoError,Math.abs(stereoOut[1][i]-stereoOut[0][i]*.5));
  assert(stereoError<1e-7,`stereo image drift ${stereoError}`);
  // Reference matching is contour-based, so a guide with different timing
  // and register should still align to the corresponding phrase.
  const ref=sine(330,1.5),refTrack=PE.yinPitchTrack(ref,sr);
  const refSuggestion=PE.suggestFromReference(track,segments,refTrack);
  assert(refSuggestion&&refSuggestion.suggestions&&refSuggestion.suggestions.length===segments.length,'reference alignment result missing');
  assert(refSuggestion.suggestions.some(Number.isFinite),'reference alignment produced no pitch suggestion');
  assert(refSuggestion.alignXs&&refSuggestion.alignYs&&refSuggestion.alignXs.length>1&&refSuggestion.alignXs.length===refSuggestion.alignYs.length,'reference time map missing');
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
  console.log(`regression PASS: edit→F0 ${outputPitch.toFixed(2)} Hz; vibrato spread ${spreadIn.toFixed(3)}→${spreadOut.toFixed(3)} st; unvoiced max Δ ${noiseDelta}; boundary step ${sourceStep.toFixed(4)}→${outputStep.toFixed(4)}; stereo drift ${stereoError}; reference alignment; standard/chunked max Δ ${difference}; stereo WAV header; worker analyze`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
