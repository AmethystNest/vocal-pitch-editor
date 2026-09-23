"""Real browser smoke test: file upload -> analysis -> WAV export.
Set BROWSER=webkit for Safari-engine coverage or BROWSER=mobile for an iPhone-sized,
touch-enabled Chromium run through the iOS-specific application path. Neither
browser mode replaces iPhone hardware testing.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from tempfile import TemporaryDirectory
from contextlib import contextmanager
import math, struct, wave, os
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

ROOT=Path(__file__).resolve().parents[1]
@contextmanager
def serve():
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield f'http://127.0.0.1:{server.server_port}/'
    finally:server.shutdown();server.server_close()

def tone(path,rate=24000,seconds=1.4):
    with wave.open(str(path),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate)
        samples=(int(0.25*32767*math.sin(2*math.pi*220*i/rate)) for i in range(int(rate*seconds)))
        f.writeframes(b''.join(struct.pack('<h',s) for s in samples))

def main():
    with TemporaryDirectory() as temp,serve() as url,sync_playwright() as pw:
        wav=Path(temp)/'tone.wav';tone(wav)
        browser_name=os.environ.get('BROWSER','chromium').lower()
        if browser_name=='webkit':
            browser=pw.webkit.launch(headless=True)
        else:
            chromium_path=os.environ.get('CHROMIUM_PATH')
            launch_args=dict(headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
            if chromium_path:
                launch_args['executable_path']=chromium_path
            browser=pw.chromium.launch(**launch_args)
        context_args=dict(accept_downloads=True)
        if browser_name=='webkit':
            # Exercise the iPhone-specific memory/resynthesis path as well as
            # WebKit itself. Playwright WebKit on Windows otherwise identifies
            # as desktop Safari and skips the code guarded by IS_IOS.
            context_args['user_agent']=(
                'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
                'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 '
                'Mobile/15E148 Safari/604.1'
            )
        elif browser_name=='mobile':
            # Chromium supplies working Web Audio on this host while the iPhone
            # user agent exercises the app's iOS memory-first code paths.
            context_args.update(
                viewport={'width':390,'height':844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
                user_agent=(
                    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
                    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 '
                    'Mobile/15E148 Safari/604.1'
                ),
            )
        context=browser.new_context(**context_args)
        page=context.new_page()
        errors=[]
        console_errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m: console_errors.append(m.text) if m.type=='error' else None)
        page.goto(url,wait_until='load',timeout=30000)
        if browser_name=='mobile':
            metrics=page.evaluate("""() => ({
                width: innerWidth,
                height: innerHeight,
                documentWidth: document.documentElement.scrollWidth,
                touchPoints: navigator.maxTouchPoints
            })""")
            assert metrics['width']==390 and metrics['height']==844, f'mobile viewport mismatch: {metrics}'
            assert metrics['documentWidth']<=metrics['width'], f'horizontal overflow on mobile: {metrics}'
            assert metrics['touchPoints']>0, f'touch input unavailable: {metrics}'
        page.locator('#fileInput').set_input_files(str(wav))
        try:
            page.wait_for_function("document.querySelector('#exportBtn').disabled === false",timeout=45000)
        except PlaywrightTimeoutError:
            state=page.evaluate("""() => ({
                loading: document.querySelector('#loadingStatus')?.textContent || '',
                file: document.querySelector('#fileNameLabel')?.textContent || '',
                toast: document.querySelector('#toast')?.textContent || '',
                exportDisabled: document.querySelector('#exportBtn')?.disabled,
                userAgent: navigator.userAgent
            })""")
            raise AssertionError(
                f'analysis timeout: state={state}; pageErrors={errors}; consoleErrors={console_errors}'
            )
        assert 'tone.wav' in page.locator('#fileNameLabel').inner_text()
        assert not errors, f'JS errors: {errors}'
        assert not console_errors, f'Console errors: {console_errors}'
        # Import intentionally leaves the full-song AudioBuffer unmaterialized
        # to reduce iPhone peak memory. Exercise Play so the lazy playback path
        # is covered by the browser test rather than only by static inspection.
        if browser_name=='mobile': page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('停止')",timeout=10000)
        if browser_name=='mobile': page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('再生')",timeout=10000)
        assert not errors, f'JS errors after playback: {errors}'
        assert not console_errors, f'Console errors after playback: {console_errors}'
        # Exercise the actual export UI and validate WAV container/length.
        with page.expect_download(timeout=45000) as info:
            if browser_name=='mobile': page.locator('#exportBtn').tap()
            else: page.locator('#exportBtn').click()
        download=info.value
        target=Path(temp)/'export.wav';download.save_as(target)
        with wave.open(str(target),'rb') as f:
            assert f.getnchannels()==1
            assert f.getsampwidth()==3
            # Web Audio decodes into the AudioContext's native sample rate.
            # The editor deliberately exports at that decoded rate, so a
            # 24 kHz fixture commonly becomes 48 kHz in Chromium.
            out_rate=f.getframerate()
            assert 22050 <= out_rate <= 192000
            assert abs((f.getnframes()/out_rate)-1.4) < (2/out_rate)
        assert not errors, f'JS errors after export: {errors}'
        assert not console_errors, f'Console errors after export: {console_errors}'
        print(f'browser-e2e: PASS ({browser_name} upload -> Worker analysis -> lazy playback -> WAV export)')
        browser.close()

if __name__=='__main__':main()
