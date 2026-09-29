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
function lowFormantVoice(seed=20) {
  const rate=24000, a=new Float32Array(Math.round(rate*.8)), phases=[];
  let phase=0;
  for(let h=1;h<=12;h++){seed=(1664525*seed+1013904223)>>>0;phases.push(seed/4294967296*Math.PI*2);}
  for(let i=0;i<a.length;i++){
    const t=i/rate, f=80+2*Math.sin(2*Math.PI*3*t);
    phase+=2*Math.PI*f/rate;
    let v=0;
    for(let h=1;h<=12;h++){
      const formant=Math.exp(-Math.pow((h*f-650)/320,2))+.2*Math.exp(-Math.pow((h*f-1300)/500,2));
      v+=formant*Math.sin(h*phase+phases[h-1]);
    }
    a[i]=.08*v*Math.min(1,t/.04,(.8-t)/.04);
  }
  return a;
}
// A glottal-pulse vowel with a single strong formant. When that formant sits
// at (about) twice f0, its energy can make YIN report exactly an octave too
// high (observed on synthetic "e"/"o"-like vowels around C4).
function glottalVowel(f0, F1, B1=90, sec=.9, seed=5) {
  const N=Math.round(sr*sec), src=new Float64Array(N);
  let phase=0, seedState=seed;
  const rand=()=>{seedState=(1664525*seedState+1013904223)>>>0; return seedState/4294967296;};
  for(let i=0;i<N;i++){
    const t=i/sr;
    phase+=f0/sr; if(phase>=1) phase-=1;
    const op=.42, cl=.16; let gp;
    if(phase<op) gp=.5-.5*Math.cos(Math.PI*phase/op);
    else if(phase<op+cl) gp=Math.cos(Math.PI/2*(phase-op)/cl);
    else gp=0;
    const env=Math.min(1,t/.03,(sec-t)/.03);
    src[i]=gp*env+.01*(rand()-.5)*env;
  }
  const d=new Float64Array(N); for(let n=1;n<N;n++) d[n]=src[n]-src[n-1];
  const R=Math.exp(-Math.PI*B1/sr), a1=-2*R*Math.cos(2*Math.PI*F1/sr), a2=R*R;
  let y1=0, y2=0; const out=new Float64Array(N);
  for(let n=0;n<N;n++){ const y=d[n]-a1*y1-a2*y2; y2=y1; y1=y; out[n]=y; }
  let pk=0; for(const v of out) pk=Math.max(pk,Math.abs(v));
  return Float32Array.from(out, v=>.5*v/pk);
}
// Glottal-pulse vowel through formant resonators; consecutive notes glide
// into each other (legato), so edited note boundaries sit inside voicing.
function legatoVoice(semis,base=196,noteSec=.45){
  const N=Math.round(sr*noteSec*semis.length),src=new Float64Array(N);let phase=0;
  for(let i=0;i<N;i++){
    const k=Math.floor(i/(sr*noteSec)),t=i/sr-k*noteSec;
    const prev=base*Math.pow(2,semis[Math.max(0,k-1)]/12),cur=base*Math.pow(2,semis[k]/12);
    phase=(phase+prev*Math.pow(cur/prev,Math.min(1,t/.06))/sr)%1;
    src[i]=phase<.4?.5-.5*Math.cos(Math.PI*phase/.4):phase<.55?Math.cos(Math.PI/2*(phase-.4)/.15):0;
  }
  const out=new Float64Array(N);
  for(const [F,B,g] of [[730,80,1],[1090,90,.5],[2440,120,.25]]){
    const R=Math.exp(-Math.PI*B/sr),a1=-2*R*Math.cos(2*Math.PI*F/sr),a2=R*R;let y1=0,y2=0;
    for(let i=1;i<N;i++){const y=(src[i]-src[i-1])-a1*y1-a2*y2;y2=y1;y1=y;out[i]+=g*y;}
  }
  let peak=0;for(const v of out)peak=Math.max(peak,Math.abs(v));
  return Float32Array.from(out,(v,i)=>.5*v/peak*Math.min(1,i/(sr*.02),(N-i)/(sr*.02)));
}
function maxCurvature(a,lo=2,hi=a.length){let m=0;for(let i=Math.max(2,lo);i<hi;i++)m=Math.max(m,Math.abs(a[i]-2*a[i-1]+a[i-2]));return m;}
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
  // Voice-like harmonics exposed a brief near-silent hole after an upward edit.
  // Check local energy, since whole-note RMS can hide a 10 ms dropout.
  const lowVoice=lowFormantVoice(), lowRate=24000;
  const lowTrack=PE.yinPitchTrack(lowVoice,lowRate);
  const lowEdits=PE.segmentNotes(lowTrack).map(s=>({...s,shiftSemitones:5}));
  assert(lowEdits.length>0,'no low voice segments');
  const lowOut=PE.resynthesize([lowVoice],lowRate,lowTrack,lowEdits)[0];
  const lowChunk=(await PE.resynthesizeChunked([lowVoice],lowRate,lowTrack,lowEdits,{blockFrames:4096}))[0];
  assert(maxDiff(lowOut,lowChunk)<1e-5,'low voice chunked render differs');
  assert(Math.abs(1200*Math.log2(median(PE.yinPitchTrack(lowOut,lowRate))/(80*Math.pow(2,5/12))))<100,
    'low voice edit lost its target pitch');
  for(let t=.1;t<.7;t+=.01){
    const start=Math.round(t*lowRate),end=start+Math.round(.01*lowRate);
    let dryPower=0,wetPower=0;
    for(let i=start;i<end;i++){dryPower+=lowVoice[i]*lowVoice[i];wetPower+=lowOut[i]*lowOut[i];}
    if(dryPower/(end-start)>.01*.01)
      assert(wetPower/dryPower>=.25,`edited voice dropout at ${t.toFixed(2)} s`);
  }
  // A second phase layout cancels near a wet/dry boundary unless level is
  // measured at a finer time scale than the transition itself.
  const edgeVoice=lowFormantVoice(33);
  const edgeTrack=PE.yinPitchTrack(edgeVoice,lowRate);
  const edgeEdits=PE.segmentNotes(edgeTrack).map(s=>({...s,shiftSemitones:5}));
  const edgeOut=PE.resynthesize([edgeVoice],lowRate,edgeTrack,edgeEdits)[0];
  assert(Math.abs(1200*Math.log2(median(PE.yinPitchTrack(edgeOut,lowRate))/(80*Math.pow(2,5/12))))<100,
    'boundary edit lost its target pitch');
  for(let t=.1;t<.7;t+=.01){
    const start=Math.round(t*lowRate),end=start+Math.round(.01*lowRate);
    let dryPower=0,wetPower=0;
    for(let i=start;i<end;i++){dryPower+=edgeVoice[i]*edgeVoice[i];wetPower+=edgeOut[i]*edgeOut[i];}
    if(dryPower/(end-start)>.01*.01)
      assert(wetPower/dryPower>=.25,`edited boundary dropout at ${t.toFixed(2)} s`);
  }
  // Moving one note inside a legato phrase used to leave a few milliseconds
  // of silence at each note boundary (the blend reached past the last grain)
  // followed by a full-scale step: an audible click/crackle on every edit.
  const phrase=legatoVoice([0,2,4,5,7]),phraseTrack=PE.yinPitchTrack(phrase,sr),phraseSegs=PE.segmentNotes(phraseTrack);
  assert(phraseSegs.length>=4,`legato phrase segments ${phraseSegs.length}`);
  const phraseCurv=maxCurvature(phrase);
  for(const shift of [-12,-7,-2,2,7]){
    for(const edits of [phraseSegs.map((s,k)=>k===2?{...s,shiftSemitones:shift}:{...s}),phraseSegs.map((s,k)=>({...s,shiftSemitones:k%2?shift:-shift/2}))]){
      const out=PE.resynthesize([phrase],sr,phraseTrack,edits)[0];
      const curv=maxCurvature(out);
      assert(curv<=phraseCurv*3,`pitch edit ${shift} st click: curvature ${phraseCurv.toFixed(4)} -> ${curv.toFixed(4)}`);
      // A silent run longer than 1 ms inside loud voicing is a dropout.
      let run=0;
      for(let i=Math.round(.03*sr);i<out.length-Math.round(.03*sr);i++){
        run=Math.abs(out[i])<1e-3&&Math.abs(phrase[i-24])+Math.abs(phrase[i])+Math.abs(phrase[i+24])>.03?run+1:0;
        assert(run<Math.round(sr*.001),`pitch edit ${shift} st hole at ${(i/sr).toFixed(3)} s`);
      }
    }
  }
  // The app sends segmentToPlain() copies (no durationSec etc.) to the
  // renderer. Those must be corrected exactly like full segment objects;
  // previously the edited note was rendered as silence.
  const plainEdits=phraseSegs.map((s,k)=>({startFrame:s.startFrame,endFrame:s.endFrame,startTime:s.startTime,endTime:s.endTime,
    shiftSemitones:k===2?2:0,fineCents:0,lineOffsets:null,autoCurve:false}));
  const plainOut=PE.resynthesize([phrase],sr,phraseTrack,plainEdits)[0];
  const fullOut=PE.resynthesize([phrase],sr,phraseTrack,phraseSegs.map((s,k)=>({...s,shiftSemitones:k===2?2:0})))[0];
  assert(maxDiff(fullOut,plainOut)<1e-7,'plain app segments render differently from full segments');
  const plainChunk=(await PE.resynthesizeChunked([phrase],sr,phraseTrack,plainEdits,{blockFrames:4096}))[0];
  assert(maxDiff(fullOut,plainChunk)<1e-5,'plain app segments differ on the chunked iPhone path');
  const plainSeg=phraseSegs[2],plainTrack=PE.yinPitchTrack(plainOut,sr),plainErr=[];
  for(let i=0;i<plainTrack.times.length;i++){
    const t=plainTrack.times[i];
    if(t>plainSeg.startTime+.08&&t<plainSeg.endTime-.08&&phraseTrack.voiced[i])plainErr.push(plainTrack.voiced[i]?Math.abs(1200*Math.log2(plainTrack.f0s[i]/(phraseTrack.f0s[i]*Math.pow(2,2/12)))):1200);
  }
  plainErr.sort((a,b)=>a-b);
  assert(plainErr.length>5&&plainErr[Math.floor(plainErr.length*.9)]<30,`plain app segment edit pitch p90 ${plainErr[Math.floor(plainErr.length*.9)]} cents`);
  // Smooth note transitions. Moving one legato note used to switch its
  // shift instantly at the boundary (a pitch step), and every note restarted
  // its own grain chain, so even a uniform edit broke the waveform there.
  const plainOf=(s,shift)=>({startFrame:s.startFrame,endFrame:s.endFrame,startTime:s.startTime,endTime:s.endTime,shiftSemitones:shift,fineCents:0,lineOffsets:null,autoCurve:false});
  const fineOpts={frameSize:1024,hopSize:64,fmin:90};
  const glideOut=PE.resynthesize([phrase],sr,phraseTrack,phraseSegs.map((s,k)=>plainOf(s,k===2?2:0)))[0];
  const glideTrack=PE.yinPitchTrack(glideOut,sr,fineOpts),glideSource=PE.yinPitchTrack(phrase,sr,fineOpts);
  let worstStep=0,lostVoicing=0;
  for(const b of [phraseSegs[2].startTime,phraseSegs[3].startTime]){
    let prev=null;
    for(let i=0;i<glideTrack.times.length;i++){
      const t=glideTrack.times[i];if(t<b-.06||t>b+.06)continue;
      // An instant step reads as a burst of unvoiced frames, not a jump.
      if(glideSource.voiced[i]&&!glideTrack.voiced[i])lostVoicing++;
      if(!glideTrack.voiced[i]){prev=null;continue;}
      const m=PE.freqToMidi(glideTrack.f0s[i]);
      if(prev!=null){let d=m-prev;d-=12*Math.round(d/12);worstStep=Math.max(worstStep,Math.abs(d));}
      prev=m;
    }
  }
  assert(worstStep<0.6&&lostVoicing<=2,`edited note boundary is not continuous: ${(worstStep*100).toFixed(0)} cent step, ${lostVoicing} frames lost periodicity`);
  // Equal shifts on neighbouring notes must render exactly like one note.
  const merged=[Object.assign(plainOf(phraseSegs[0],3),{endFrame:phraseSegs[phraseSegs.length-1].endFrame,endTime:phraseSegs[phraseSegs.length-1].endTime})];
  const uniformOut=PE.resynthesize([phrase],sr,phraseTrack,phraseSegs.map(s=>plainOf(s,3)))[0];
  const mergedOut=PE.resynthesize([phrase],sr,phraseTrack,merged)[0];
  assert(maxDiff(mergedOut,uniformOut)<1e-6,'uniform edit restarts the grain chain at note boundaries');
  // A local render covering a whole resynthesis span, with the song's guide
  // channel, must match the full render there (the app's per-note path).
  const stereoPhrase=[phrase,Float32Array.from(phrase,(v,i)=>.8*v+.2*(phrase[i-331]||0))];
  const localEdits=phraseSegs.map((s,k)=>plainOf(s,[1,-1,2,0,0][k]||0));
  const fullStereo=PE.resynthesize(stereoPhrase,sr,phraseTrack,localEdits,{guideChannel:0});
  const span=PE.resynthRegions(localEdits,phraseTrack)[0];
  const w0=Math.max(0,span.startTime-.05),w1=span.endTime+.05,s0=Math.round(w0*sr),s1=Math.round(w1*sr);
  const f0=phraseTrack.times.findIndex(t=>t>=w0);let f1=phraseTrack.times.findIndex(t=>t>w1);if(f1<0)f1=phraseTrack.times.length;
  const localTrack={times:phraseTrack.times.slice(f0,f1).map(t=>t-s0/sr),f0s:phraseTrack.f0s.slice(f0,f1),voiced:phraseTrack.voiced.slice(f0,f1),clarity:phraseTrack.clarity.slice(f0,f1),hopSize:phraseTrack.hopSize};
  const localSegs=localEdits.filter(s=>s.endTime>w0&&s.startTime<w1).map(s=>Object.assign({},s,{startFrame:Math.max(0,s.startFrame-f0),endFrame:Math.min(f1-f0,s.endFrame-f0),startTime:s.startTime-s0/sr,endTime:s.endTime-s0/sr}));
  const localStereo=PE.resynthesize(stereoPhrase.map(c=>c.slice(s0,s1)),sr,localTrack,localSegs,{guideChannel:0});
  let localErr=0,localPow=0;
  for(let c=0;c<2;c++)for(let i=0;i<s1-s0;i++){const e=localStereo[c][i]-fullStereo[c][s0+i];localErr+=e*e;localPow+=fullStereo[c][s0+i]**2;}
  assert(10*Math.log10(localErr/localPow)<-40,`local render differs from full render by ${(10*Math.log10(localErr/localPow)).toFixed(1)} dB`);
  // Do not glide into a neighbour whose pitch jumps implausibly (usually an
  // analysis octave error): resynthesising it with a wrong period is worse.
  const octaveTrack2={...phraseTrack,f0s:Float64Array.from(phraseTrack.f0s,(f,i)=>i>=phraseSegs[3].startFrame&&i<phraseSegs[3].endFrame?f*2:f)};
  const octaveSpans=PE.resynthRegions(phraseSegs.map((s,k)=>plainOf(s,k===2?2:0)),octaveTrack2);
  assert(octaveSpans.length===1&&Math.abs(octaveSpans[0].endTime-phraseSegs[2].endTime)<1e-9,'transition extended into an octave-jump neighbour');
  // An octave-down edit must actually sound an octave lower. Normalising by a
  // near-zero overlap sum restored the original period between grains.
  const octaveSeg=phraseSegs[2];
  const octaveOut=PE.resynthesize([phrase],sr,phraseTrack,phraseSegs.map(s=>s===octaveSeg?{...s,shiftSemitones:-12}:{...s}))[0];
  const octaveTrack=PE.yinPitchTrack(octaveOut,sr);const octaveErr=[];
  for(let i=0;i<octaveTrack.times.length;i++){
    const t=octaveTrack.times[i];
    if(t>octaveSeg.startTime+.08&&t<octaveSeg.endTime-.08&&phraseTrack.voiced[i])octaveErr.push(octaveTrack.voiced[i]?Math.abs(1200*Math.log2(octaveTrack.f0s[i]/(phraseTrack.f0s[i]/2))):1200);
  }
  octaveErr.sort((a,b)=>a-b);
  assert(octaveErr.length>5&&octaveErr[octaveErr.length>>1]<30,`octave-down edit pitch error ${octaveErr[octaveErr.length>>1]} cents`);
  // A vowel whose only strong formant sits at ~2x f0 (an "e"/"o"-like shape
  // around C4) previously made YIN report exactly an octave too high on
  // every frame -- the note displayed, corrected and exported wrong.
  const secondHarmonicVowel=glottalVowel(261.63,523.26);
  const shTrack=PE.yinPitchTrack(secondHarmonicVowel,sr,{frameSize:2048,hopSize:512,fmin:70,fmax:1000,threshold:0.15});
  const shVoiced=[]; for(let i=0;i<shTrack.f0s.length;i++) if(shTrack.voiced[i]) shVoiced.push(shTrack.f0s[i]);
  shVoiced.sort((a,b)=>a-b);
  assert(shVoiced.length>10,'formant-dominant vowel produced too few voiced frames');
  const shMedian=shVoiced[shVoiced.length>>1];
  assert(Math.abs(1200*Math.log2(shMedian/261.63))<50,`formant-dominant vowel detected an octave error: ${shMedian.toFixed(1)} Hz (expected ~261.6 Hz)`);
  // A genuinely high, cleanly periodic tone must not be second-guessed down
  // an octave just because CMNDF also dips at its own doubled period.
  for(const cleanF0 of [261.63,349.23,440,523.25,659.26]){
    const cleanTrack=PE.yinPitchTrack(sine(cleanF0,.5),sr);
    const cleanVoiced=[]; for(let i=0;i<cleanTrack.f0s.length;i++) if(cleanTrack.voiced[i]) cleanVoiced.push(cleanTrack.f0s[i]);
    cleanVoiced.sort((a,b)=>a-b);
    const cleanMedian=cleanVoiced[cleanVoiced.length>>1];
    assert(Math.abs(1200*Math.log2(cleanMedian/cleanF0))<20,`clean tone ${cleanF0} Hz was second-guessed to ${cleanMedian?.toFixed(1)} Hz`);
  }
  // iPhone long files analyse a 2x downsampled copy; analysis hop samples
  // must not be reused as output-rate samples when building the wet mask.
  const halfRate=Float32Array.from({length:phrase.length>>1},(_,i)=>(phrase[2*i]+phrase[2*i+1])/2);
  const halfTrack=PE.yinPitchTrack(halfRate,sr/2,{frameSize:1024,hopSize:256}),halfSegs=PE.segmentNotes(halfTrack);
  const halfSeg=halfSegs[Math.min(2,halfSegs.length-1)];
  const halfOut=PE.resynthesize([phrase],sr,halfTrack,halfSegs.map(s=>s===halfSeg?{...s,shiftSemitones:3}:{...s}))[0];
  const halfOutTrack=PE.yinPitchTrack(halfOut,sr);const halfErr=[];
  for(let i=0;i<halfOutTrack.times.length;i++){
    const t=halfOutTrack.times[i];
    if(t>halfSeg.startTime+.08&&t<halfSeg.endTime-.08&&phraseTrack.voiced[i])halfErr.push(halfOutTrack.voiced[i]?Math.abs(1200*Math.log2(halfOutTrack.f0s[i]/(phraseTrack.f0s[i]*Math.pow(2,3/12)))):1200);
  }
  halfErr.sort((a,b)=>a-b);
  assert(halfErr.length>5&&halfErr[Math.floor(halfErr.length*.9)]<30,`downsampled-analysis edit pitch p90 ${halfErr[Math.floor(halfErr.length*.9)]} cents`);
  assert(maxCurvature(halfOut)<=phraseCurv*3,'downsampled-analysis edit click');
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
  // Opposite-polarity stereo must not cancel the pitch-mark guide and
  // silently disable correction. Both channels must remain phase-opposed.
  const opposite=PE.resynthesize([input,Float32Array.from(input,x=>-x)],sr,track,edited);
  const oppositePitch=median(PE.yinPitchTrack(opposite[0],sr));
  assert(Math.abs(1200*Math.log2(oppositePitch/(220*Math.pow(2,3/12))))<30,`opposite stereo pitch ${oppositePitch}`);
  let oppositeError=0;
  for(let i=0;i<opposite[0].length;i++)oppositeError=Math.max(oppositeError,Math.abs(opposite[0][i]+opposite[1][i]));
  assert(oppositeError<1e-7,`opposite stereo phase drift ${oppositeError}`);
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
  assert.equal(messages.length,1,'worker sent progress without opting in');
  assert.equal(messages[0].type,'analyzed');assert.equal(messages[0].id,12);
  assert(messages[0].segments.length>0);
  // Analysis progress: opt-in worker messages, monotonic fractions in [0,1).
  context.onmessage({data:{type:'analyze',id:13,signal:sine(220,1.2),sr,reportProgress:true}});
  const progress=messages.slice(1,-1);
  assert(progress.length>=10&&progress.every(m=>m.type==='progress'&&m.id===13),'worker analysis progress missing');
  assert(progress.every((m,i)=>m.fraction>=0&&m.fraction<1&&(i===0||m.fraction>progress[i-1].fraction)),'analysis progress is not monotonic');
  assert.equal(messages[messages.length-1].type,'analyzed');assert.equal(messages[messages.length-1].id,13);
  // featherMask must equal the plain sliding box filter it replaced, sample for sample.
  {
    const ref=(mask,fade)=>{const n=mask.length,sm=new Float32Array(n),win=fade*2+1;let acc=0;
      for(let i=0;i<n+fade;i++){acc+=(i<n?mask[i]:0)-(i-win>=0?mask[i-win]:0);const o=i-fade;if(o>=0&&o<n)sm[o]=Math.min(1,acc/Math.max(1,fade));}return sm;};
    let seedState=9;const rnd=()=>{seedState=(1664525*seedState+1013904223)>>>0;return seedState/4294967296;};
    for(let k=0;k<400;k++){
      const n=Math.floor(rnd()*3000),fade=[8,10,384,3][k%4],flip=[0.5,0.001,0.01,0.05,0.2][k%5];
      const m=new Float32Array(n);let v=rnd()<.5?1:0;
      for(let i=0;i<n;i++){if(rnd()<flip)v=1-v;m[i]=v;}
      const a=ref(m,fade),b=PE.featherMask(m,fade);
      for(let i=0;i<n;i++) assert.equal(b[i],a[i],`featherMask differs at ${i} (n=${n}, fade=${fade})`);
    }
  }
  // Formant shift moves the spectral envelope, not the pitch.
  {
    const f0=100,F1=900,x=glottalVowel(f0,F1,90,1.2);
    const opt={frameSize:2048,hopSize:512,fmin:70,fmax:1000,threshold:0.15};
    const tr=PE.yinPitchTrack(x,sr,opt), segs=PE.segmentNotes(tr);
    const envPeak=(sig,pitch)=>{const a=Math.round(.35*sr),b=Math.round(.85*sr),H=[];
      for(let k=1;k*pitch<2500;k++){const f=k*pitch;if(f<450)continue;let re=0,im=0;
        for(let i=a;i<b;i++){const w=.5-.5*Math.cos(2*Math.PI*(i-a)/(b-a)),ph=2*Math.PI*f*i/sr;re+=sig[i]*w*Math.cos(ph);im-=sig[i]*w*Math.sin(ph);}
        H.push([f,Math.hypot(re,im)]);}
      let bi=0;for(let k=1;k<H.length;k++)if(H[k][1]>H[bi][1])bi=k;
      const l=Math.log(H[bi-1][1]),m=Math.log(H[bi][1]),r=Math.log(H[bi+1][1]);
      return H[bi][0]+0.5*(l-r)/(l-2*m+r)*pitch;};
    const render=(fs,ps)=>{
      const edits=segs.map(g=>({startFrame:g.startFrame,endFrame:g.endFrame,startTime:g.startTime,endTime:g.endTime,shiftSemitones:ps,fineCents:0,lineOffsets:null,formantSemitones:fs}));
      const [y]=PE.resynthesize([x],sr,tr,edits);
      const ot=PE.yinPitchTrack(y,sr,opt),v=[];
      for(let i=0;i<ot.f0s.length;i++) if(ot.voiced[i]&&ot.times[i]>.3&&ot.times[i]<.9) v.push(ot.f0s[i]);
      v.sort((p,q)=>p-q);const f=v[v.length>>1];
      return {f0:f,peak:envPeak(y,f)};};
    const base=envPeak(x,f0);
    assert(Math.abs(base-F1)/F1<.05,`test vowel formant not where expected: ${base}`);
    const up=render(3,0), down=render(-3,0), pitchOnly=render(0,2), both=render(3,2);
    assert(Math.abs(1200*Math.log2(up.f0/f0))<15&&Math.abs(1200*Math.log2(down.f0/f0))<15,`formant shift changed the pitch: ${up.f0} / ${down.f0}`);
    assert(up.peak/base>1.12&&up.peak/base<1.35,`+3 st formant moved the envelope by x${(up.peak/base).toFixed(3)} (expected about 1.19)`);
    assert(down.peak/base<.92&&down.peak/base>.72,`-3 st formant moved the envelope by x${(down.peak/base).toFixed(3)} (expected about 0.84)`);
    assert(Math.abs(pitchOnly.peak/base-1)<.06,`a pitch-only edit moved the formant by x${(pitchOnly.peak/base).toFixed(3)}`);
    assert(Math.abs(1200*Math.log2(both.f0/(f0*Math.pow(2,2/12))))<15&&both.peak/base>1.1,'pitch and formant edits together are not independent');
    // both render paths agree
    const editsC=segs.map(g=>({startFrame:g.startFrame,endFrame:g.endFrame,startTime:g.startTime,endTime:g.endTime,shiftSemitones:0,fineCents:0,lineOffsets:null,formantSemitones:3}));
    const [a]=PE.resynthesize([x],sr,tr,editsC),[b]=await PE.resynthesizeChunked([x],sr,tr,editsC,{blockFrames:8192});
    let dmax=0;for(let i=0;i<a.length;i++)dmax=Math.max(dmax,Math.abs(a[i]-b[i]));
    assert(dmax<1e-4,`standard and chunked formant renders differ by ${dmax}`);
  }
  // Octave-error repair: short bursts (1-4 frames) between two agreeing anchors are fixed;
  // a sustained octave jump (or a burst too long to be an analysis slip) is left alone.
  {
    const mk=(len)=>{const f=new Float64Array(len).fill(270),v=new Uint8Array(len).fill(1),c=new Float64Array(len).fill(0.97);
      return {f,v,c,burst:(from,to,factor)=>{for(let i=from;i<=to;i++){f[i]=270*factor;c[i]=0.87;}}};};
    for(const burstLen of [1,2,3,4]){
      const t=mk(24); t.burst(9,8+burstLen,2); PE.stabilizeOctaveErrors(t.f,t.v,t.c);
      for(let i=0;i<24;i++) assert(Math.abs(t.f[i]-270)<1,`octave burst of ${burstLen} frame(s) left at ${t.f[i]} (frame ${i})`);
    }
    const down=mk(24); down.burst(9,10,0.5); PE.stabilizeOctaveErrors(down.f,down.v,down.c);
    for(let i=0;i<24;i++) assert(Math.abs(down.f[i]-270)<1,'2-frame octave-down burst not repaired');
    const long=mk(24); long.burst(9,14,2); PE.stabilizeOctaveErrors(long.f,long.v,long.c);
    assert(long.f[9]>500&&long.f[14]>500,'a 6-frame octave excursion must not be rewritten');
    const jump=mk(24); jump.burst(9,23,2); PE.stabilizeOctaveErrors(jump.f,jump.v,jump.c);
    assert(jump.f[9]>500&&jump.f[23]>500,'a sustained octave jump must not be rewritten');
    // anchors that disagree (a real 5-semitone step) leave a short different-pitch run alone
    const step=mk(24); for(let i=9;i<=10;i++) step.f[i]=270*Math.pow(2,5/12); PE.stabilizeOctaveErrors(step.f,step.v,step.c);
    assert(Math.abs(step.f[9]-270*Math.pow(2,5/12))<1,'a real short step was treated as an octave error');
  }
  // Key/scale snapping and per-note mute.
  assert.equal(PE.snapToScale(61.4,0,'chromatic'),61);
  assert.equal(PE.snapToScale(61.4,0,'major'),62,'C# is not in C major: 61.4 goes to D');
  assert.equal(PE.snapToScale(60.6,0,'major'),60,'60.6 is nearer C than D in C major');
  assert.equal(PE.snapToScale(63.2,0,'major'),64,'Eb is out of C major; 63.2 goes to E');
  assert.equal(PE.snapToScale(63.2,0,'minor'),63,'Eb is in C minor');
  assert.equal(PE.snapToScale(70.4,9,'pentatonicMinor'),69,'A minor pentatonic has A but no Bb');
  assert.equal(PE.snapToScale(59.6,0,'major'),60,'octave boundaries snap across octaves');
  {
    const tone=sine(261.63,1.0);
    const track=PE.yinPitchTrack(tone,sr);
    const segs=[{startFrame:0,endFrame:track.times.length,startTime:track.times[0],endTime:track.times[track.times.length-1],shiftSemitones:0,fineCents:0,lineOffsets:null,muted:true}];
    const from=Math.round(.3*sr), to=Math.round(.7*sr);
    segs[0].startTime=.3; segs[0].endTime=.7;
    for(const fn of ['resynthesize','resynthesizeChunked']){
      const out=await PE[fn]([tone],sr,track,segs,{});
      let mid=0,outside=0;
      for(let i=from+300;i<to-300;i++) mid=Math.max(mid,Math.abs(out[0][i]));
      for(let i=0;i<from-10;i++) outside=Math.max(outside,Math.abs(out[0][i]-tone[i]));
      for(let i=to+10;i<tone.length;i++) outside=Math.max(outside,Math.abs(out[0][i]-tone[i]));
      assert.equal(mid,0,`${fn}: muted note is not silent`);
      assert.equal(outside,0,`${fn}: mute changed audio outside the note`);
    }
  }
  // Reference import progress: opt-in, monotonic pitch stage, then an align stage before the result.
  {
    const vocalTrack=PE.yinPitchTrack(sine(220,1.2),sr), vocalSegs=PE.segmentNotes(vocalTrack).map(g=>({startTime:g.startTime,endTime:g.endTime,startFrame:g.startFrame,endFrame:g.endFrame,noteMidi:g.noteMidi}));
    const refMsg={type:'reference',refSignal:sine(246.94,1.2),refSr:sr,vocalPitchTrack:vocalTrack,vocalSegments:vocalSegs};
    context.onmessage({data:Object.assign({id:20},refMsg)});
    const plain=messages.filter(m=>m.id===20);
    assert(plain.length===1&&plain[0].type==='referenced','reference sent progress without opting in');
    context.onmessage({data:Object.assign({id:21,reportProgress:true},refMsg,{refSignal:sine(246.94,1.2)})});
    const rp=messages.filter(m=>m.id===21);
    const pitch=rp.filter(m=>m.type==='progress'&&m.stage==='pitch'), align=rp.filter(m=>m.type==='progress'&&m.stage==='align');
    assert(pitch.length>=5&&pitch.every((m,i)=>m.fraction>=0&&m.fraction<1&&(i===0||m.fraction>pitch[i-1].fraction)),'reference pitch progress missing or not monotonic');
    assert.equal(align.length,1,'reference align stage missing');
    assert.equal(rp[rp.length-1].type,'referenced');
    assert(rp.indexOf(align[0])>rp.indexOf(pitch[pitch.length-1]),'align stage came before pitch progress finished');
  }
  console.log(`regression PASS: edit→F0 ${outputPitch.toFixed(2)} Hz; vibrato spread ${spreadIn.toFixed(3)}→${spreadOut.toFixed(3)} st; unvoiced max Δ ${noiseDelta}; boundary step ${sourceStep.toFixed(4)}→${outputStep.toFixed(4)}; stereo drift ${stereoError}; reference alignment; standard/chunked max Δ ${difference}; stereo WAV header; worker analyze`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
