"""Chromium regression: obsolete reference analysis cannot replace a newer guide.

Exercises actual file input, decode and Worker analysis on the real app. The
first guide's worker response is held while a second guide completes.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_e2e import serve, tone


DELAY_FIRST_REFERENCE = """(() => {
  // Inspect the real playback buffer without exposing private app state.
  const nativeStart=AudioBufferSourceNode.prototype.start;
  window.__playedReferenceHz=null;
  AudioBufferSourceNode.prototype.start=function(...args){
    if(this.buffer && this.buffer.duration>2){
      const pcm=this.buffer.getChannelData(0);
      const n=Math.min(pcm.length,Math.round(this.buffer.sampleRate*0.5));
      let crossings=0;
      for(let i=1;i<n;i++) if(pcm[i-1]<=0 && pcm[i]>0) crossings++;
      window.__playedReferenceHz=crossings*this.buffer.sampleRate/n;
    }
    return nativeStart.apply(this,args);
  };
  const nativePost = Worker.prototype.postMessage;
  window.__referenceRace = {firstId:null, delayed:null, release:null};
  // Delay the first reference result at the application-facing message handler.
  const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
  Object.defineProperty(Worker.prototype, 'onmessage', {
    configurable:true,
    get(){return this.__testMessageHandler || null;},
    set(handler){
      this.__testMessageHandler=handler;
      descriptor.set.call(this, function(ev){
        const race=window.__referenceRace;
        if(ev.data && ev.data.type==='referenced' && ev.data.id===race.firstId && !race.release){
          race.delayed=ev;
          return;
        }
        if(ev.data && ev.data.type==='referenced'){
          window.__referenceSnapshots.push({id:ev.data.id, f0:Array.from(ev.data.refPitchTrack.f0s).filter(Number.isFinite).find(n=>n>0)});
        }
        handler.call(this,ev);
      });
    }
  });
  Worker.prototype.postMessage=function(msg,...rest){
    if(msg.type==='reference' && window.__referenceRace.firstId===null)
      window.__referenceRace.firstId=msg.id;
    return nativePost.call(this,msg,...rest);
  };
  window.__referenceSnapshots=[];
  window.__releaseOldReference=()=>{
    const race=window.__referenceRace;
    if(!race.delayed) throw Error('first reference response not available');
    race.release=true;
    const ev=race.delayed;
    race.delayed=null;
    // Worker is the one actual application Worker in this fixture.
    window.__referenceSnapshots.push({id:ev.data.id, f0:Array.from(ev.data.refPitchTrack.f0s).filter(Number.isFinite).find(n=>n>0)});
    window.__testAudioWorker.__testMessageHandler.call(window.__testAudioWorker,ev);
  };
  const OriginalWorker=Worker;
  window.Worker=function(...args){
    const worker=new OriginalWorker(...args);
    window.__testAudioWorker=worker;
    return worker;
  };
  window.Worker.prototype=OriginalWorker.prototype;
})()"""


def main():
    with TemporaryDirectory() as tmp, serve() as url, sync_playwright() as pw:
        vocal = Path(tmp) / 'vocal.wav'
        old = Path(tmp) / 'old-guide.wav'
        new = Path(tmp) / 'new-guide.wav'
        tone(vocal, seconds=2.8, hz=220)
        tone(old, seconds=2.8, hz=330)
        tone(new, seconds=2.8, hz=440)
        browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page()
        page.add_init_script(DELAY_FIRST_REFERENCE)
        errors = []
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto(url)
        page.locator('#fileInput').set_input_files(str(vocal))
        page.wait_for_function("document.querySelector('#exportBtn').disabled===false", timeout=45000)
        page.locator('#refFileInput').set_input_files(str(old))
        page.wait_for_function('window.__referenceRace.delayed!==null', timeout=45000)
        # The UI disables the reference picker while decoding, but a second
        # real change event can still occur (e.g. from another input path).
        page.locator('#refFileInput').set_input_files(str(new))
        page.wait_for_function("document.querySelector('#refPlayBtn').disabled===false", timeout=45000)
        current = page.evaluate("""() => ({
          text:document.querySelector('#toast').textContent,
          oldDelayed:!!window.__referenceRace.delayed,
          referenceEnabled:!document.querySelector('#refPlayBtn').disabled,
          snapshots:window.__referenceSnapshots
        })""")
        assert current['oldDelayed'] and current['referenceEnabled'], current
        assert current['snapshots'] and abs(current['snapshots'][-1]['f0'] - 440)<20, current
        page.evaluate('window.__releaseOldReference()')
        page.wait_for_timeout(300)
        assert not errors, f'JavaScript exception after stale response: {errors}'
        snapshots=page.evaluate('window.__referenceSnapshots')
        assert len(snapshots)==2 and abs(snapshots[0]['f0']-440)<20 and abs(snapshots[1]['f0']-330)<20, snapshots
        # The reference note overlay is stored on current segments, so use
        # the observable inspector recommendation after selecting a note.
        page.locator('#rollCanvas').focus()
        page.locator('#rollCanvas').press('ArrowRight')
        page.wait_for_function("document.querySelector('#inspector').classList.contains('show')")
        content = page.locator('#inspector').inner_text()
        assert content, 'inspector was empty after competing reference loads'
        assert page.locator('#refPlayBtn').is_enabled(), 'stale response disabled the current reference'
        page.locator('#refPlayBtn').click()
        page.wait_for_function('window.__playedReferenceHz!==null')
        played_hz=page.evaluate('window.__playedReferenceHz')
        assert abs(played_hz-440)<8, f'stale result replaced new guide playback: {played_hz} Hz'
        print('reference-race-e2e: PASS (new guide wins when obsolete Worker response arrives late)')
        browser.close()


if __name__ == '__main__':
    main()
