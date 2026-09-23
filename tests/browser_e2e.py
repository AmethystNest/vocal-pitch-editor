"""Real browser smoke test: file upload -> analysis -> WAV export.
Set BROWSER=webkit for Safari-engine coverage, BROWSER=mobile for an iPhone-sized
touch run, BROWSER=mobile-se for a compact iPhone viewport, BROWSER=mobile-long
to exercise long-file memory handling, or BROWSER=pwa-offline to verify offline use.
Chromium simulations do not replace iPhone hardware testing.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import tempfile
import uuid
import math, struct, wave, os
import ssl
import mimetypes
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

ROOT=Path(__file__).resolve().parents[1]
@contextmanager
def serve(https=False):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
        def log_message(self,*args):pass
        def guess_type(self,path):
            if path.endswith(('.js','.mjs')): return 'text/javascript'
            return mimetypes.guess_type(path)[0] or 'application/octet-stream'
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    if https:
        # Chromium accepts this test-only TLS endpoint; no certificate is
        # installed in or trusted by the host operating system.
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1))
            .not_valid_after(datetime.now(timezone.utc)+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]),critical=False)
            .sign(key,hashes.SHA256()))
        cert_path=Path(tempfile.gettempdir())/f'pitch-e2e-{uuid.uuid4().hex}-cert.pem'
        key_path=Path(tempfile.gettempdir())/f'pitch-e2e-{uuid.uuid4().hex}-key.pem'
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()))
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert_path,key_path)
        server.socket=tls.wrap_socket(server.socket,server_side=True)
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield f'{"https" if https else "http"}://localhost:{server.server_port}/'
    finally:
        server.shutdown();server.server_close()
        if https:
            cert_path.unlink(missing_ok=True);key_path.unlink(missing_ok=True)

def tone(path,rate=24000,seconds=1.4):
    with wave.open(str(path),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate)
        samples=(int(0.25*32767*math.sin(2*math.pi*220*i/rate)) for i in range(int(rate*seconds)))
        f.writeframes(b''.join(struct.pack('<h',s) for s in samples))

def main():
    browser_name=os.environ.get('BROWSER','chromium').lower()
    with TemporaryDirectory() as temp,serve(https=browser_name=='pwa-offline') as url,sync_playwright() as pw:
        mobile_modes=('mobile','mobile-se','mobile-long')
        expected_seconds=75.2 if browser_name=='mobile-long' else 1.4
        wav=Path(temp)/'tone.wav';tone(wav,seconds=expected_seconds)
        if browser_name=='webkit':
            browser=pw.webkit.launch(headless=True)
        else:
            chromium_path=os.environ.get('CHROMIUM_PATH')
            launch_args=dict(headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
            if browser_name=='pwa-offline':
                launch_args['args'].append('--ignore-certificate-errors')
            if chromium_path:
                launch_args['executable_path']=chromium_path
            browser=pw.chromium.launch(**launch_args)
        context_args=dict(accept_downloads=True,ignore_https_errors=browser_name=='pwa-offline')
        if browser_name=='webkit':
            # Playwright's Windows WebKit shell is not iOS Safari, but still
            # gives useful responsive-layout and API-availability coverage.
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
        elif browser_name in mobile_modes:
            # Chromium supplies working Web Audio on this host while the iPhone
            # user agent exercises the app's iOS memory-first code paths.
            context_args.update(
                viewport={'width':375,'height':667} if browser_name=='mobile-se' else {'width':390,'height':844},
                device_scale_factor=2 if browser_name=='mobile-se' else 3,
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
        if browser_name=='webkit':
            webkit_state=page.evaluate("""() => ({
                title:document.title,
                viewport:[innerWidth,innerHeight],
                pageWidth:document.documentElement.scrollWidth,
                audioConstructor:!!(window.AudioContext||window.webkitAudioContext),
                uploadVisible:getComputedStyle(document.querySelector('#emptyUploadCard')).display!=='none'
            })""")
            webkit_state['hasAudioContext']=bool(webkit_state.pop('audioConstructor'))
            assert webkit_state['title']=='ボーカルピッチエディタ', f'WebKit app shell failed: {webkit_state}'
            assert webkit_state['viewport']==[390,844], f'WebKit mobile viewport mismatch: {webkit_state}'
            assert webkit_state['pageWidth']<=webkit_state['viewport'][0], f'WebKit horizontal overflow: {webkit_state}'
            assert webkit_state['uploadVisible'], f'WebKit upload surface missing: {webkit_state}'
            if not webkit_state['hasAudioContext']:
                assert not errors, f'WebKit shell JS errors: {errors}'
                print(f'browser-e2e: PARTIAL PASS (webkit mobile shell; Web Audio unavailable in this host: {webkit_state})')
                browser.close()
                return
        if browser_name=='pwa-offline':
            page.wait_for_function("navigator.serviceWorker?.controller !== null",timeout=15000)
            page.evaluate("navigator.serviceWorker.ready")
            context.set_offline(True)
            page.reload(wait_until='load',timeout=15000)
            page.wait_for_selector('#fileInput',state='attached',timeout=5000)
            assert page.locator('#emptyUpload').is_visible(), 'cached app shell did not render offline'
        did_pitch_edit=False
        if browser_name in mobile_modes:
            metrics=page.evaluate("""() => ({
                width: innerWidth,
                height: innerHeight,
                documentWidth: document.documentElement.scrollWidth,
                touchPoints: navigator.maxTouchPoints
            })""")
            expected_viewport=(375,667) if browser_name=='mobile-se' else (390,844)
            assert (metrics['width'],metrics['height'])==expected_viewport, f'mobile viewport mismatch: {metrics}'
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
        if browser_name in mobile_modes:
            # Select the fixture's centered A3 note through the real canvas
            # pointer path, make a small correction, and restore it with Undo.
            canvas=page.locator('#rollCanvas')
            canvas_box=canvas.bounding_box()
            assert canvas_box and canvas_box['width']>0 and canvas_box['height']>0
            canvas.tap(position={'x':canvas_box['width']/2,'y':canvas_box['height']/2})
            page.wait_for_function("document.querySelector('#inspector').classList.contains('show')",timeout=5000)
            initial_offset=page.locator('#inspOffset').inner_text()
            page.locator('#inspector [data-d=\"10\"]').tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === false",timeout=5000)
            corrected_offset=page.locator('#inspOffset').inner_text()
            assert corrected_offset!=initial_offset, f'touch pitch edit had no effect: {initial_offset}'
            did_pitch_edit=True
            # Render the edited pitch and prove that it reaches exported PCM.
            with page.expect_download(timeout=45000) as edited_info:
                page.locator('#exportBtn').tap()
            edited_target=Path(temp)/'edited.wav'
            edited_info.value.save_as(edited_target)
            with wave.open(str(edited_target),'rb') as edited_wav:
                edited_rate=edited_wav.getframerate()
                edited_raw=edited_wav.readframes(edited_wav.getnframes())
            edited_pcm=[int.from_bytes(edited_raw[i:i+3],'little',signed=True) for i in range(0,len(edited_raw),3)]
            lo=int(edited_rate*0.25);hi=min(len(edited_pcm)-1,int(edited_rate*1.1))
            crossings=sum(1 for i in range(lo,hi) if edited_pcm[i]<=0<edited_pcm[i+1])
            edited_hz=crossings*edited_rate/(hi-lo)
            assert edited_hz>235, f'touch pitch edit did not reach exported PCM: {edited_hz:.1f} Hz'
            page.locator('#undoBtn').tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === true",timeout=5000)

        # Measure the post-Undo output too; it must return near the 220 Hz source.
        if did_pitch_edit:
            with page.expect_download(timeout=45000) as restored_info:
                page.locator('#exportBtn').tap()
            restored_target=Path(temp)/'restored.wav'
            restored_info.value.save_as(restored_target)
            with wave.open(str(restored_target),'rb') as restored_wav:
                restored_rate=restored_wav.getframerate()
                restored_raw=restored_wav.readframes(restored_wav.getnframes())
            restored_pcm=[int.from_bytes(restored_raw[i:i+3],'little',signed=True) for i in range(0,len(restored_raw),3)]
            lo=int(restored_rate*0.25);hi=min(len(restored_pcm)-1,int(restored_rate*1.1))
            crossings=sum(1 for i in range(lo,hi) if restored_pcm[i]<=0<restored_pcm[i+1])
            restored_hz=crossings*restored_rate/(hi-lo)
            assert abs(restored_hz-220)<3, f'Undo export did not restore source pitch: {restored_hz:.1f} Hz'
            assert page.locator('#inspOffset').inner_text()==initial_offset, 'touch Undo did not restore pitch'

            # Split the same note through the toolbar and canvas hit target,
            # then undo so playback/export still cover a continuous note.
            page.locator('#splitBtn').scroll_into_view_if_needed()
            page.locator('#splitBtn').tap()
            page.wait_for_function("document.querySelector('#splitBtn').classList.contains('armed')",timeout=3000)
            canvas_box=canvas.bounding_box()
            canvas.tap(position={'x':canvas_box['width']*0.4,'y':canvas_box['height']/2})
            page.wait_for_function("document.querySelector('#toast').style.display === 'block'",timeout=3000)
            split_message=page.locator('#toast').text_content()
            assert 'ノートを分割しました' in split_message, f'touch split failed: {split_message.encode("unicode_escape")}'
            page.wait_for_function("document.querySelector('#undoBtn').disabled === false",timeout=5000)
            page.locator('#undoBtn').tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === true",timeout=5000)

            if browser_name in ('mobile','mobile-se'):
                # Two actual touch points exercise the pinch-to-zoom handler;
                # the canvas image must be redrawn at the new time scale.
                cdp=context.new_cdp_session(page)
                pinch_x=canvas_box['x']+canvas_box['width']/2
                pinch_y=canvas_box['y']+canvas_box['height']*0.72
                signature="""() => {
                    const c=document.querySelector('#rollCanvas'),x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                    let h=2166136261; for(let i=0;i<x.length;i+=37){h^=x[i];h=Math.imul(h,16777619)} return h>>>0;
                }"""
                before_zoom=page.evaluate(signature)
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':pinch_x-22,'y':pinch_y,'id':1},{'x':pinch_x+22,'y':pinch_y,'id':2}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':pinch_x-55,'y':pinch_y,'id':1},{'x':pinch_x+55,'y':pinch_y,'id':2}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                page.wait_for_timeout(100)
                after_zoom=page.evaluate(signature)
                assert after_zoom!=before_zoom, 'two-finger pinch did not redraw the pitch canvas'
        if browser_name=='mobile-long':
            assert 'iPhone省メモリ解析' in page.locator('#fileNameLabel').text_content(), 'long iPhone analysis did not select downsampled memory mode'
        # Import intentionally leaves the full-song AudioBuffer unmaterialized
        # to reduce iPhone peak memory. Exercise Play so the lazy playback path
        # is covered by the browser test rather than only by static inspection.
        if browser_name in mobile_modes: page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('停止')",timeout=10000)
        if browser_name in mobile_modes: page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('再生')",timeout=10000)
        assert not errors, f'JS errors after playback: {errors}'
        assert not console_errors, f'Console errors after playback: {console_errors}'
        # Exercise the actual export UI and validate WAV container/length.
        with page.expect_download(timeout=45000) as info:
            if browser_name in mobile_modes: page.locator('#exportBtn').tap()
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
            assert abs((f.getnframes()/out_rate)-expected_seconds) < (2/out_rate)
        assert not errors, f'JS errors after export: {errors}'
        assert not console_errors, f'Console errors after export: {console_errors}'
        print(f'browser-e2e: PASS ({browser_name} upload -> Worker analysis -> lazy playback -> WAV export)')
        browser.close()

if __name__=='__main__':main()
