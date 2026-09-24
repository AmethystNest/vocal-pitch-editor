"""Actual Chromium solo-preview lifecycle regression (synthetic hidden event).

Run in an environment where Python Playwright can launch Chromium:
    py -3.12 tests/solo-browser-e2e.py
The hidden transition below dispatches the browser's visibilitychange event;
it does not claim to reproduce physical iPhone or OS background suspension.
"""
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_e2e import serve, tone


TRACK = """(() => {
    const Native=window.AudioContext || window.webkitAudioContext;
    window.__soloTrack={created:0,started:0,stopped:0,active:new Set(),events:[]};
    const start=AudioBufferSourceNode.prototype.start;
    const stop=AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start=function(...args){
        const t=window.__soloTrack;t.started++;t.active.add(this);
        t.events.push('start');return start.apply(this,args);
    };
    AudioBufferSourceNode.prototype.stop=function(...args){
        const t=window.__soloTrack;t.stopped++;t.active.delete(this);
        t.events.push('stop');return stop.apply(this,args);
    };
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__testHidden||false});
    window.__testHidden=false;
    document.addEventListener('visibilitychange',()=>window.__soloTrack.events.push('visibility:'+document.hidden));
    window.__nativeAudioContext=Native;
    window.__testUnlockPending=[];
    window.__testDelayResume=false;
    const nativeResume=Native.prototype.resume;
    Native.prototype.resume=function(...args){
        if(window.__testDelayResume) return new Promise(resolve=>window.__testUnlockPending.push(()=>resolve(nativeResume.apply(this,args))));
        return nativeResume.apply(this,args);
    };
    window.__testAudioContexts=[];
    const Tracked=function(...args){
        const ctx=new Native(...args);window.__testAudioContexts.push(ctx);return ctx;
    };
    Tracked.prototype=Native.prototype;
    window.AudioContext=Tracked;
})()"""


def main():
    with TemporaryDirectory() as tmp, serve() as url, sync_playwright() as pw:
        fixture=Path(tmp)/'solo-tone.wav'
        tone(fixture,seconds=3.2)
        browser=pw.chromium.launch(headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,
            user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')
        page=context.new_page()
        page.add_init_script(TRACK)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(url)
        page.locator('#fileInput').set_input_files(str(fixture))
        page.wait_for_function("document.querySelector('#exportBtn').disabled === false",timeout=45000)
        assert not errors, f'JavaScript errors during audio load: {errors}'
        canvas=page.locator('#rollCanvas')
        box=canvas.bounding_box()
        assert box and box['width']>0 and box['height']>0
        canvas.focus()
        canvas.press('ArrowRight')
        page.wait_for_function("document.querySelector('#inspector').classList.contains('show')",timeout=5000)
        play=page.locator('#inspPlay')
        assert play.is_visible(), 'solo preview control is not visible'
        play.tap()
        page.wait_for_function('window.__soloTrack.started > 0',timeout=5000)
        active=page.evaluate('window.__soloTrack.active.size')
        assert active==1, f'expected exactly one preview source, got {active}'
        page.evaluate("window.__testHidden=true; document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function('window.__soloTrack.active.size === 0',timeout=5000)
        hidden=page.evaluate("() => ({stopped:window.__soloTrack.stopped,events:window.__soloTrack.events,ctx:window.__nativeAudioContext.name})")
        assert hidden['stopped']>=1 and 'visibility:true' in hidden['events'], f'old solo was not stopped: {hidden}'
        before=page.evaluate('window.__soloTrack.started')
        page.wait_for_timeout(250)
        assert page.evaluate('window.__soloTrack.started')==before, 'stale solo preview restarted while hidden'
        page.evaluate("window.__testHidden=false; document.dispatchEvent(new Event('visibilitychange'))")
        play.tap()
        page.wait_for_function('(prior) => window.__soloTrack.started > prior',arg=before,timeout=5000)
        assert page.evaluate('window.__soloTrack.active.size')==1, 'foreground solo did not start cleanly'
        # Force an actual async Web Audio unlock boundary by suspending the
        # browser AudioContext. Hide while resume() is pending and ensure the
        # obsolete continuation never starts an additional source.
        page.evaluate("window.__testHidden=true; document.dispatchEvent(new Event('visibilitychange'))")
        page.wait_for_function('window.__soloTrack.active.size === 0',timeout=5000)
        page.evaluate("window.__testHidden=false; document.dispatchEvent(new Event('visibilitychange'))")
        page.evaluate("async () => { await window.__testAudioContexts.at(-1).suspend(); window.__testDelayResume=true; }")
        paused=page.evaluate('window.__soloTrack.started')
        play.tap()
        page.wait_for_function('window.__testUnlockPending.length === 1',timeout=5000)
        assert page.evaluate('window.__soloTrack.started')==paused, 'solo started before audio unlock completed'
        page.evaluate("window.__testHidden=true; document.dispatchEvent(new Event('visibilitychange'))")
        page.evaluate("window.__testDelayResume=false; window.__testUnlockPending.shift()()")
        page.wait_for_timeout(350)
        assert page.evaluate('window.__soloTrack.started')==paused, 'pending stale preview started after hidden interruption'
        page.evaluate("window.__testHidden=false; document.dispatchEvent(new Event('visibilitychange'))")
        play.tap()
        page.wait_for_function('(prior) => window.__soloTrack.started > prior',arg=paused,timeout=5000)
        assert page.evaluate('window.__soloTrack.active.size')==1, 'new preview failed after interrupted async unlock'
        assert not errors, f'JavaScript errors during solo lifecycle: {errors}'
        print('solo-browser-e2e: PASS (Chromium mobile viewport, WAV, real Web Audio nodes, synthetic visibilitychange, stale async unlock and fresh solo)')
        browser.close()


if __name__=='__main__':
    main()
