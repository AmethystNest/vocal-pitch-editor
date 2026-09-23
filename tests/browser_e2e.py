"""Real browser smoke test: file upload -> analysis -> WAV export.
Set BROWSER=webkit for Safari-engine coverage, BROWSER=mobile for an iPhone-sized
touch run, BROWSER=mobile-se for a compact iPhone viewport, BROWSER=mobile-mini
for a 320px-wide mobile viewport, BROWSER=mobile-long
to exercise long-file memory handling, or BROWSER=pwa-offline to verify offline use.
BROWSER=mobile-share-fallback, BROWSER=mobile-share-cancel and BROWSER=mobile-share-success simulate iOS share-sheet outcomes.
BROWSER=mobile-mp3, BROWSER=mobile-m4a and BROWSER=mobile-aac cover compressed audio; these modes require FFmpeg.
Chromium simulations do not replace iPhone hardware testing.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import tempfile
import uuid
import math, struct, wave, os
import shutil, subprocess
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

def tone(path,rate=24000,seconds=1.4,hz=220):
    with wave.open(str(path),'wb') as f:
        f.setnchannels(1);f.setsampwidth(2);f.setframerate(rate)
        samples=(int(0.25*32767*math.sin(2*math.pi*hz*i/rate)) for i in range(int(rate*seconds)))
        f.writeframes(b''.join(struct.pack('<h',s) for s in samples))

def prepare_mobile_download(page):
    page.locator('#exportBtn').tap()
    page.wait_for_function("document.querySelector('#exportBtn').dataset.exportAction === 'download'",timeout=45000)

def main():
    browser_name=os.environ.get('BROWSER','chromium').lower()
    with TemporaryDirectory() as temp,serve(https=browser_name=='pwa-offline') as url,sync_playwright() as pw:
        mobile_modes=('mobile','mobile-se','mobile-mini','mobile-long','mobile-cycle','mobile-share-fallback','mobile-share-cancel','mobile-share-success','mobile-mp3','mobile-m4a','mobile-aac')
        mobile_share_modes=('mobile-share-fallback','mobile-share-cancel','mobile-share-success')
        expected_seconds=75.2 if browser_name=='mobile-long' else 1.4
        wav=Path(temp)/'tone.wav';tone(wav,seconds=expected_seconds)
        oversized_wav=Path(temp)/'oversized.wav'
        header=bytearray(44)
        struct.pack_into('<4sI4s4sIHHIIHH4sI',header,0,
            b'RIFF',57_600_036,b'WAVE',b'fmt ',16,1,2,48_000,192_000,4,16,b'data',57_600_000)
        oversized_wav.write_bytes(header)
        extensible_wav=Path(temp)/'oversized-extensible.wav'
        extensible_header=bytearray(68)
        struct.pack_into('<4sI4s4sIHHIIHHHHI',extensible_header,0,
            b'RIFF',57_600_060,b'WAVE',b'fmt ',40,0xfffe,2,48_000,192_000,4,16,22,16,3)
        struct.pack_into('<IHH8B',extensible_header,44,1,0,16,128,0,0,170,0,56,155,113)
        struct.pack_into('<4sI',extensible_header,60,b'data',57_600_000)
        extensible_wav.write_bytes(extensible_header)
        unknown_wav=Path(temp)/'unknown-subformat.wav'
        unknown_header=bytearray(44)
        struct.pack_into('<4sI4s4sIHHIIHH4sI',unknown_header,0,
            b'RIFF',52,b'WAVE',b'fmt ',16,6,1,48_000,48_000,1,8,b'data',16)
        unknown_wav.write_bytes(unknown_header)
        combined_oversized_wav=Path(temp)/'combined-oversized.wav'
        ref_bytes=196*48_000*4
        ref_header=bytearray(44)
        struct.pack_into('<4sI4s4sIHHIIHH4sI',ref_header,0,
            b'RIFF',36+ref_bytes,b'WAVE',b'fmt ',16,1,2,48_000,192_000,4,16,b'data',ref_bytes)
        combined_oversized_wav.write_bytes(ref_header)
        audio_file=wav
        if browser_name in ('mobile-mp3','mobile-m4a','mobile-aac'):
            ffmpeg=os.environ.get('FFMPEG_PATH') or shutil.which('ffmpeg')
            if not ffmpeg:
                raise RuntimeError('MP3/M4A/AAC browser coverage requires FFmpeg (set FFMPEG_PATH or add ffmpeg to PATH)')
            audio_file=Path(temp)/('tone.mp3' if browser_name=='mobile-mp3' else 'tone.m4a' if browser_name=='mobile-m4a' else 'tone.aac')
            encode_args=[ffmpeg,'-y','-hide_banner','-loglevel','error','-i',str(wav),'-vn']
            if browser_name=='mobile-mp3':
                encode_args += ['-c:a','libmp3lame','-b:a','128k']
            elif browser_name=='mobile-m4a':
                encode_args += ['-c:a','aac','-b:a','128k','-movflags','+faststart']
            else:
                encode_args += ['-c:a','aac','-b:a','128k','-f','adts']
            encode_args.append(str(audio_file))
            encoded=subprocess.run(encode_args,capture_output=True,text=True)
            assert encoded.returncode==0 and audio_file.is_file(), f'could not create {audio_file.suffix} fixture: {encoded.stderr}'
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
                viewport=({'width':375,'height':667} if browser_name=='mobile-se' else
                          {'width':320,'height':568} if browser_name=='mobile-mini' else
                          {'width':390,'height':844}),
                device_scale_factor=2 if browser_name in ('mobile-se','mobile-mini') else 3,
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
        if browser_name in mobile_modes:
            page.add_init_script("""(() => {
                const Native = window.AudioContext || window.webkitAudioContext;
                if (!Native) return;
                window.__testDecodeAudioCalls = 0;
                window.__testDecodeAudioSettled = 0;
                const nativeDecode = Native.prototype.decodeAudioData;
                Native.prototype.decodeAudioData = function(...args) {
                    window.__testDecodeAudioCalls++;
                    const result = nativeDecode.apply(this,args);
                    if (result && typeof result.then === 'function') {
                        result.then(() => window.__testDecodeAudioSettled++, () => window.__testDecodeAudioSettled++);
                    }
                    return result;
                };
                window.__testDocumentHidden = false;
                Object.defineProperty(document, 'hidden', {
                    configurable:true,
                    get:() => window.__testDocumentHidden
                });
                window.__testAudioContexts = [];
                const Tracked = function(...args) {
                    const context = new Native(...args);
                    window.__testAudioContexts.push(context);
                    return context;
                };
                Tracked.prototype = Native.prototype;
                window.AudioContext = Tracked;
            })();""")
        if browser_name in mobile_modes and browser_name not in mobile_share_modes:
            page.add_init_script("Object.defineProperty(navigator, 'share', {configurable:true, value:undefined}); Object.defineProperty(navigator, 'canShare', {configurable:true, value:undefined});")
        if browser_name in mobile_share_modes:
            share_error='NotAllowedError' if browser_name=='mobile-share-fallback' else 'AbortError' if browser_name=='mobile-share-cancel' else None
            page.add_init_script(f"""(() => {{
                window.__testShareEnabled = false;
                window.__testShareCalls = 0;
                window.__testSharedFiles = [];
                Object.defineProperty(navigator, 'canShare', {{ configurable:true, value:() => window.__testShareEnabled }});
                Object.defineProperty(navigator, 'share', {{ configurable:true, value:async (data) => {{
                    window.__testShareCalls++;
                    window.__testSharedFiles = (data.files || []).map(file => file.name);
                    if ('{share_error}' !== 'None') throw new DOMException('simulated share result', '{share_error}');
                }} }});
            }})();""")
        errors=[]
        console_errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m: console_errors.append(m.text) if m.type=='error' else None)
        page.goto(url,wait_until='load',timeout=30000)
        pwa_state=page.evaluate("""async () => {
            const viewport=document.querySelector('meta[name="viewport"]')?.content || '';
            const manifestUrl=document.querySelector('link[rel="manifest"]')?.href;
            const manifestResponse=manifestUrl && await fetch(manifestUrl);
            const manifest=manifestResponse?.ok ? await manifestResponse.json() : null;
            const icons=manifest ? await Promise.all(manifest.icons.map(async icon => ({
                src:icon.src,sizes:icon.sizes,ok:(await fetch(new URL(icon.src,manifestUrl))).ok
            }))) : [];
            const appleIcon=document.querySelector('link[rel="apple-touch-icon"]')?.href;
            return {viewport,themeColor:document.querySelector('meta[name="theme-color"]')?.content,manifestOk:!!manifest,manifest,icons,appleIconOk:appleIcon ? (await fetch(appleIcon)).ok : false};
        }""")
        assert 'user-scalable=no' not in pwa_state['viewport'] and 'maximum-scale=1' not in pwa_state['viewport'], f'page zoom is restricted on mobile: {pwa_state["viewport"]}'
        assert pwa_state['manifestOk'], f'PWA manifest is missing or invalid: {pwa_state}'
        assert pwa_state['manifest'].get('display')=='standalone' and pwa_state['manifest'].get('start_url')=='./' and pwa_state['manifest'].get('scope')=='./', f'PWA install settings are incorrect: {pwa_state["manifest"]}'
        assert pwa_state['manifest'].get('name')=='ボーカルピッチエディタ' and pwa_state['manifest'].get('background_color')==pwa_state['themeColor']==pwa_state['manifest'].get('theme_color'), f'PWA launch appearance is inconsistent: {pwa_state}'
        assert len(pwa_state['icons'])>=2 and all(icon['ok'] for icon in pwa_state['icons']), f'PWA icons are missing: {pwa_state["icons"]}'
        assert pwa_state['appleIconOk'], 'iOS home-screen icon is missing'
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
            offline_pwa=page.evaluate("""async () => {
                const manifest=await (await fetch('./manifest.webmanifest')).json();
                const icon=await fetch('./icon-512.png');
                return {theme:manifest.theme_color,background:manifest.background_color,iconOk:icon.ok};
            }""")
            assert offline_pwa['theme']==pwa_state['themeColor']==offline_pwa['background'] and offline_pwa['iconOk'], f'offline PWA assets are stale or incomplete: {offline_pwa}; online={pwa_state}'
        did_pitch_edit=False
        if browser_name in mobile_modes:
            metrics=page.evaluate("""() => ({
                width: innerWidth,
                height: innerHeight,
                documentWidth: document.documentElement.scrollWidth,
                touchPoints: navigator.maxTouchPoints,
                essentialButtonsVisible: ['backBtn','playBtn','undoBtn','exportBtn'].every(id => {
                    const r=document.getElementById(id).getBoundingClientRect();
                    return r.width>0 && r.left>=0 && r.right<=innerWidth;
                })
            })""")
            expected_viewport=((375,667) if browser_name=='mobile-se' else
                               (320,568) if browser_name=='mobile-mini' else
                               (390,844))
            assert (metrics['width'],metrics['height'])==expected_viewport, f'mobile viewport mismatch: {metrics}'
            assert metrics['documentWidth']<=metrics['width'], f'horizontal overflow on mobile: {metrics}'
            assert metrics['touchPoints']>0, f'touch input unavailable: {metrics}'
            assert metrics['essentialButtonsVisible'], f'essential mobile controls are not visible: {metrics}'
            assert page.locator('#backBtn').is_enabled() and page.locator('#backBtn').get_attribute('aria-label')=='ボーカル音源を選択', 'initial audio picker is not clearly accessible'
            unavailable_controls=page.locator('#topbar button:not(#backBtn)').evaluate_all("els => els.filter(el => el.getAttribute('tabindex') !== '-1').map(el => el.id)")
            assert not unavailable_controls, f'editor-only controls remain in initial keyboard/VoiceOver order: {unavailable_controls}'
            assert page.locator('#emptyUploadBtn').get_attribute('aria-label')=='ボーカル音源を選択', 'empty-state picker has no descriptive accessible name'
            page.evaluate('document.activeElement.blur()')
            page.keyboard.press('Tab')
            assert page.evaluate('document.activeElement.id')=='backBtn', 'keyboard focus did not start at the audio picker'
            page.keyboard.press('Tab')
            assert page.evaluate('document.activeElement.id')=='emptyUploadBtn', 'empty-state file picker is not the next keyboard action'
            assert page.locator('#rollCanvas').get_attribute('tabindex')=='-1', 'empty pitch canvas is reachable before a track is loaded'
            unnamed_buttons=page.locator('#topbar button:not([aria-label])').evaluate_all("els => els.filter(el => !(el.getAttribute('title') || el.querySelector('.toolLabel')?.textContent?.trim())).map(el => el.id)")
            assert not unnamed_buttons, f'mobile toolbar has unnamed buttons: {unnamed_buttons}'
            assert page.locator('#interactionGuide').get_attribute('aria-live')=='polite', 'interaction guide is not announced'
            assert page.locator('#rollCanvas').get_attribute('tabindex')=='-1', 'empty pitch canvas should not be in the keyboard focus order'
            assert page.locator('#rollCanvas').get_attribute('aria-describedby')=='a11yStatus', 'pitch canvas is not linked to live pitch details'
            assert page.locator('#inspClose').get_attribute('aria-label')=='選択ノートの詳細を閉じる', 'inspector close button has no descriptive accessible name'
            assert page.locator('#accessibleNoteNav').get_attribute('hidden') is not None, 'note navigation is exposed before analysis'
            assert page.locator('#a11yPreviousNote').get_attribute('aria-label')=='前のノートを選択'
            assert page.locator('#a11yNextNote').get_attribute('aria-label')=='次のノートを選択'
            page.locator('#modeLineBtn').tap()
            assert page.locator('#modeLineBtn').get_attribute('aria-pressed')=='true', 'line tool state was not exposed'
            page.locator('#modeNoteBtn').tap()
            assert page.locator('#modeNoteBtn').get_attribute('aria-pressed')=='true', 'note tool state was not exposed'
        if browser_name=='mobile-mini':
            # A tiny WAV header declaring five minutes of stereo PCM would
            # otherwise make decodeAudioData allocate a >600 MiB AudioBuffer.
            page.locator('#fileInput').set_input_files(str(oversized_wav))
            page.wait_for_function("document.querySelector('#toast').style.display === 'block' && document.querySelector('#loadingScreen').style.display === 'none'",timeout=5000)
            guard_state=page.evaluate("""() => ({
                toast:document.querySelector('#toast').textContent,
                loading:document.querySelector('#loadingScreen').style.display,
                uploadVisible:!document.querySelector('#emptyUpload').classList.contains('hidden'),
                disabled:document.querySelector('#exportBtn').disabled,
                pickerAvailable:!document.querySelector('#backBtn').disabled,
                canvasTabIndex:document.querySelector('#rollCanvas').tabIndex,
                fileName:document.querySelector('#fileNameLabel').textContent,
                decodeCalls:window.__testDecodeAudioCalls
            })""")
            assert 'iPhone' in guard_state['toast'] and 'WAV' in guard_state['toast'], f'oversized WAV was not rejected before decode: {guard_state}'
            assert page.locator('#toast').get_attribute('role')=='alert' and page.locator('#toast').get_attribute('aria-live')=='assertive', 'audio import failure is not announced assertively'
            assert guard_state['uploadVisible'] and guard_state['disabled'] and not guard_state['fileName'], f'failed WAV import did not return to a clean upload state: {guard_state}'
            assert guard_state['pickerAvailable'] and guard_state['canvasTabIndex']==-1, f'failed WAV import left an inaccessible recovery state: {guard_state}'
            assert guard_state['decodeCalls']==0, f'oversized WAV reached decodeAudioData: {guard_state}'
            assert len(console_errors)==1 and 'decodeAudioFile' in console_errors[0], f'oversized WAV rejection did not report one expected import error: {console_errors}'
            console_errors.clear()
            page.locator('#fileInput').set_input_files(str(extensible_wav))
            page.wait_for_function("document.querySelector('#toast').style.display === 'block' && document.querySelector('#loadingScreen').style.display === 'none'",timeout=5000)
            extensible_calls=page.evaluate('window.__testDecodeAudioCalls')
            assert extensible_calls==0, f'oversized WAVE_FORMAT_EXTENSIBLE PCM reached decodeAudioData: {extensible_calls}'
            assert len(console_errors)==1 and 'decodeAudioFile' in console_errors[0], f'extensible WAV preflight did not report one expected error: {console_errors}'
            console_errors.clear()
            page.locator('#fileInput').set_input_files(str(unknown_wav))
            page.wait_for_function('window.__testDecodeAudioSettled === 1',timeout=5000)
            page.wait_for_function("document.querySelector('#toast').textContent.includes('Unable to decode audio data')",timeout=5000)
            unknown_state=page.evaluate("""() => ({
                calls:window.__testDecodeAudioCalls,
                uploadVisible:!document.querySelector('#emptyUpload').classList.contains('hidden'),
                loading:document.querySelector('#loadingScreen').style.display,
                exportDisabled:document.querySelector('#exportBtn').disabled
            })""")
            assert unknown_state['calls']==1, f'unknown WAV subformat was misclassified as PCM by the preflight: {unknown_state}'
            assert unknown_state['uploadVisible'] and unknown_state['loading']=='none' and unknown_state['exportDisabled'], f'unsupported WAV did not fail cleanly through Web Audio: {unknown_state}'
            assert console_errors and any('EncodingError' in message for message in console_errors), f'unknown WAV was not sent to the Web Audio decoder: {console_errors}'
            console_errors.clear()
        page.locator('#fileInput').set_input_files(str(audio_file))
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
        assert audio_file.name in page.locator('#fileNameLabel').inner_text()
        if browser_name in mobile_modes:
            assert page.locator('#modeLineBtn').get_attribute('tabindex') is None, 'editor controls did not return to the VoiceOver/keyboard order after analysis'
            assert page.locator('#backBtn').is_enabled(), 'audio picker became unavailable after analysis'
            assert page.locator('#rollCanvas').get_attribute('tabindex')=='0', 'analyzed pitch canvas is not keyboard reachable'
        if browser_name in mobile_modes:
            assert page.locator('#fileInput').evaluate('(input) => input.value') == '', 'main file picker value was not cleared after selection'
        assert not errors, f'JS errors: {errors}'
        assert not console_errors, f'Console errors: {console_errors}'
        if browser_name in ('mobile','mobile-se','mobile-mini','mobile-cycle','mobile-mp3','mobile-m4a','mobile-aac'):
            # A short iPhone-UA guide exercises the combined-memory guard,
            # transferred mono analysis PCM, and full-rate reference playback.
            if browser_name=='mobile-mini':
                page.locator('#refFileInput').set_input_files(str(combined_oversized_wav))
                page.wait_for_function("document.querySelector('#refBtn').disabled === false && document.querySelector('#toast').style.display === 'block'",timeout=5000)
                ref_guard=page.evaluate("""() => ({
                    toast:document.querySelector('#toast').textContent,
                    decodeCalls:window.__testDecodeAudioCalls,
                    vocalStillLoaded:!document.querySelector('#exportBtn').disabled,
                    referenceDisabled:document.querySelector('#refPlayBtn').disabled
                })""")
                assert 'iPhone' in ref_guard['toast'] and 'WAV' in ref_guard['toast'], f'combined audio-memory preflight did not reject reference WAV: {ref_guard}'
                assert page.locator('#toast').get_attribute('role')=='alert' and page.locator('#toast').get_attribute('aria-live')=='assertive', 'reference import failure is not announced assertively'
                assert ref_guard['decodeCalls']==2, f'reference WAV reached decodeAudioData despite combined memory limit: {ref_guard}'
                assert ref_guard['vocalStillLoaded'] and ref_guard['referenceDisabled'], f'reference preflight damaged the current vocal session: {ref_guard}'
                assert len(console_errors)==1 and 'loadReference' in console_errors[0], f'reference memory guard did not report one expected error: {console_errors}'
                console_errors.clear()
            reference_file=audio_file if browser_name in ('mobile-mp3','mobile-m4a','mobile-aac') else wav
            page.locator('#refFileInput').set_input_files(str(reference_file))
            page.wait_for_function("document.querySelector('#refPlayBtn').disabled === false",timeout=30000)
            assert not errors, f'JS errors after reference analysis: {errors}'
            page.locator('#refPlayBtn').tap()
            page.wait_for_function("document.querySelector('#refPlayBtn').textContent.includes('⏸')",timeout=5000)
            page.locator('#refPlayBtn').tap()
            page.wait_for_function("document.querySelector('#refPlayBtn').textContent.includes('▶')",timeout=5000)
        if browser_name in mobile_modes:
            # Select the fixture's centered A3 note through the real canvas
            # pointer path, make a small correction, and restore it with Undo.
            assert page.locator('#accessibleNoteNav').get_attribute('hidden') is None, 'analyzed notes are missing VoiceOver navigation'
            page.locator('#a11yNextNote').focus()
            nav_box=page.locator('#accessibleNoteNav').bounding_box()
            assert nav_box and nav_box['width']>=120 and nav_box['height']>=60 and nav_box['x']>=0, f'keyboard-focused assistive controls are not visibly reachable: {nav_box}'
            page.keyboard.press('Enter')
            page.wait_for_function("document.querySelector('#inspector').classList.contains('show')",timeout=5000)
            assert page.locator('#a11yStatus').text_content().startswith('ノート 1 / '), 'VoiceOver next-note control did not announce the selected note position'
            canvas=page.locator('#rollCanvas')
            canvas.focus()
            canvas.press('ArrowRight')
            page.wait_for_function("document.querySelector('#inspector').classList.contains('show')",timeout=5000)
            assert page.locator('#a11yStatus').text_content().startswith('ノート '), 'keyboard note selection was not announced with its position'
            assert page.locator('#rollCanvas').get_attribute('aria-describedby')=='a11yStatus', 'selected pitch description is disconnected from the focused canvas'
            keyboard_offset=page.locator('#inspOffset').inner_text()
            canvas.press('ArrowUp')
            page.wait_for_function("document.querySelector('#undoBtn').disabled === false",timeout=5000)
            assert page.locator('#inspOffset').inner_text()!=keyboard_offset, 'keyboard pitch correction did not change the selected note'
            page.locator('#undoBtn').tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === true",timeout=5000)
            canvas_box=canvas.bounding_box()
            assert canvas_box and canvas_box['width']>0 and canvas_box['height']>0
            canvas.tap(position={'x':canvas_box['width']/2,'y':canvas_box['height']/2})
            page.wait_for_function("document.querySelector('#inspector').classList.contains('show')",timeout=5000)
            mobile_targets=page.locator('#inspector .closeX, #inspector .inspActionBtn, #inspector .strengthPreset, #inspector .strengthRange, #inspector .rowBtns button, #inspector .resetBtn, #inspector .playSegBtn').evaluate_all("els => els.map(el => ({id:el.id || el.className, height:el.getBoundingClientRect().height, width:el.getBoundingClientRect().width}))")
            too_small=[target for target in mobile_targets if target['height']<43.5 or target['width']<43.5]
            assert not too_small, f'mobile pitch inspector has undersized touch targets: {too_small}'
            inspector_box=page.locator('#inspector').bounding_box()
            assert inspector_box and inspector_box['y']>=0 and inspector_box['y']+inspector_box['height']<=metrics['height'], f'mobile pitch inspector exceeds viewport: {inspector_box}'
            portrait_size={'width':metrics['width'],'height':metrics['height']}
            page.set_viewport_size({'width':portrait_size['height'],'height':portrait_size['width']})
            page.wait_for_function('(size) => innerWidth === size.width && innerHeight === size.height',arg={'width':portrait_size['height'],'height':portrait_size['width']},timeout=5000)
            page.wait_for_function("() => { const c=document.querySelector('#rollCanvas'), w=document.querySelector('#rollWrap'), d=Math.min(devicePixelRatio||1,2); return c.width===Math.round(w.clientWidth*d) && c.height===Math.round(w.clientHeight*d); }",timeout=5000)
            landscape_metrics=page.evaluate("() => ({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth})")
            assert landscape_metrics['documentWidth']<=landscape_metrics['width'], f'horizontal overflow after mobile rotation: {landscape_metrics}'
            landscape_inspector=page.locator('#inspector').bounding_box()
            inspector_style=page.locator('#inspector').evaluate("el => ({maxHeight:getComputedStyle(el).maxHeight,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,rollTop:document.querySelector('#rollWrap').getBoundingClientRect().top})")
            assert landscape_inspector and landscape_inspector['y']>=0 and landscape_inspector['y']+landscape_inspector['height']<=landscape_metrics['height'], f'inspector escaped the landscape viewport: {landscape_inspector}; {landscape_metrics}; {inspector_style}'
            landscape_adjustment=page.locator('#inspector [data-d="10"]')
            landscape_adjustment.scroll_into_view_if_needed()
            adjustment_box=landscape_adjustment.bounding_box()
            assert adjustment_box and adjustment_box['y']>=0 and adjustment_box['y']+adjustment_box['height']<=landscape_metrics['height'], f'pitch adjustment is unreachable in landscape: {adjustment_box}'
            initial_offset=page.locator('#inspOffset').inner_text()
            landscape_adjustment.tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === false",timeout=5000)
            corrected_offset=page.locator('#inspOffset').inner_text()
            assert corrected_offset!=initial_offset, f'touch pitch edit had no effect: {initial_offset}'
            page.set_viewport_size(portrait_size)
            page.wait_for_function('(size) => innerWidth === size.width && innerHeight === size.height',arg=portrait_size,timeout=5000)
            did_pitch_edit=True
            # Render the edited pitch and prove that it reaches exported PCM.
            if browser_name in mobile_modes: prepare_mobile_download(page)
            with page.expect_download(timeout=45000) as edited_info:
                if browser_name in mobile_modes: page.locator('#exportBtn').tap()
                else: page.locator('#exportBtn').click()
            edited_target=Path(temp)/'edited.wav'
            edited_info.value.save_as(edited_target)
            assert page.locator('#exportBtn .toolLabel').count()==1, 'export button label markup was lost after export'
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
            if browser_name in mobile_modes: prepare_mobile_download(page)
            with page.expect_download(timeout=45000) as restored_info:
                if browser_name in mobile_modes: page.locator('#exportBtn').tap()
                else: page.locator('#exportBtn').click()
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
            assert page.locator('#toast').get_attribute('role')=='status' and page.locator('#toast').get_attribute('aria-live')=='polite', 'successful edits did not restore polite status announcements'
            page.wait_for_function("document.querySelector('#undoBtn').disabled === false",timeout=5000)
            page.locator('#undoBtn').tap()
            page.wait_for_function("document.querySelector('#undoBtn').disabled === true",timeout=5000)

            if browser_name in ('mobile','mobile-se'):
                # Two actual touch points exercise the pinch-to-zoom handler;
                # the canvas image must be redrawn at the new time scale.
                cdp=context.new_cdp_session(page)
                pinch_x=canvas_box['x']+canvas_box['width']/2
                # Put the first finger over the detected note and move it
                # diagonally; the pinch must not leak into a pitch drag.
                pinch_y=canvas_box['y']+canvas_box['height']*0.5
                signature="""() => {
                    const c=document.querySelector('#rollCanvas'),x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
                    let h=2166136261; for(let i=0;i<x.length;i+=37){h^=x[i];h=Math.imul(h,16777619)} return h>>>0;
                }"""
                before_zoom=page.evaluate(signature)
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':pinch_x-22,'y':pinch_y,'id':1},{'x':pinch_x+22,'y':pinch_y,'id':2}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':pinch_x-55,'y':pinch_y-35,'id':1},{'x':pinch_x+55,'y':pinch_y,'id':2}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                page.wait_for_timeout(100)
                after_zoom=page.evaluate(signature)
                assert after_zoom!=before_zoom, 'two-finger pinch did not redraw the pitch canvas'
                assert page.locator('#undoBtn').is_disabled(), 'pinch gesture leaked into a note edit'
                # OS interruptions can cancel a touch after a partial note
                # drag. Cancellation must restore the original state without
                # leaving an Undo entry or a stuck drag cursor/state.
                canvas_box=canvas.bounding_box()
                cancel_x=canvas_box['x']+canvas_box['width']/2
                cancel_y=canvas_box['y']+canvas_box['height']/2
                before_cancel=page.evaluate(signature)
                cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':cancel_x,'y':cancel_y,'id':3}]})
                cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':cancel_x,'y':cancel_y-45,'id':3}]})
                during_cancel=page.evaluate(signature)
                assert during_cancel!=before_cancel, 'touch interruption fixture did not move the canvas or note'
                cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
                page.wait_for_timeout(100)
                assert page.locator('#undoBtn').is_disabled(), 'cancelled touch created an Undo entry'
                after_cancel=page.evaluate(signature)
                assert after_cancel==before_cancel, 'cancelled touch left a partial note or pan edit behind'
                assert page.evaluate("!!document.querySelector('#rollCanvas').matches(':active')") is False, 'canvas remained active after cancelled touch'
                # Safari may transition or rotate without delivering the
                # pointercancel that a standard drag relies on. Those page
                # lifecycle events must independently retire the gesture.
                for interruption in ('visibilitychange','orientationchange','pagehide'):
                    before_interrupt=page.evaluate(signature)
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':cancel_x,'y':cancel_y,'id':10}]})
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':cancel_x,'y':cancel_y-45,'id':10}]})
                    during_interrupt=page.evaluate(signature)
                    assert during_interrupt!=before_interrupt, f'{interruption} fixture did not start a moved gesture'
                    if interruption=='visibilitychange':
                        page.evaluate("window.__testDocumentHidden=true; document.dispatchEvent(new Event('visibilitychange'))")
                    elif interruption=='orientationchange':
                        page.evaluate("window.dispatchEvent(new Event('orientationchange'))")
                    else:
                        page.evaluate("window.dispatchEvent(new Event('pagehide'))")
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchCancel','touchPoints':[]})
                    page.wait_for_timeout(250 if interruption=='orientationchange' else 100)
                    after_interrupt=page.evaluate(signature)
                    if interruption=='visibilitychange':
                        assert after_interrupt==before_interrupt, f'{interruption} left a partial pitch or pan edit behind'
                    elif interruption=='orientationchange':
                        geometry=page.evaluate("""() => {const c=document.querySelector('#rollCanvas'),r=c.getBoundingClientRect();return {canvas:[c.width,c.height],rect:[r.width,r.height],viewport:[innerWidth,innerHeight]}}""")
                        assert geometry['rect']==[canvas_box['width'],canvas_box['height']], f'orientationchange left a stale canvas size: {geometry}'
                    assert page.locator('#undoBtn').is_disabled(), f'{interruption} created an Undo entry'
                    if interruption=='visibilitychange':
                        page.evaluate("window.__testDocumentHidden=false; document.dispatchEvent(new Event('visibilitychange'))")
        if browser_name=='mobile-long':
            assert 'iPhone省メモリ解析' in page.locator('#fileNameLabel').text_content(), 'long iPhone analysis did not select downsampled memory mode'
        final_expected_hz=220
        if browser_name=='mobile-cycle':
            # Replace a session with a decoded guide and completed edits. The
            # old guide and undo state must be released before the new song is
            # used, and the new export must contain only the replacement tone.
            page.locator('#refFileInput').set_input_files(str(wav))
            page.wait_for_function("document.querySelector('#refPlayBtn').disabled === false",timeout=30000)
            page.locator('#refPlayBtn').tap()
            page.wait_for_function("document.querySelector('#refPlayBtn').textContent.includes('⏸')",timeout=5000)
            page.locator('#refPlayBtn').tap()
            page.wait_for_function("document.querySelector('#refPlayBtn').textContent.includes('▶')",timeout=5000)
            replacement=Path(temp)/'replacement.wav'
            tone(replacement,seconds=expected_seconds,hz=330)
            page.locator('#fileInput').set_input_files(str(replacement))
            page.wait_for_function("document.querySelector('#fileNameLabel').textContent.includes('replacement.wav') && document.querySelector('#exportBtn').disabled === false",timeout=45000)
            assert page.locator('#refPlayBtn').is_disabled(), 'old reference audio remained enabled after replacement'
            assert page.locator('#undoBtn').is_disabled(), 'old edit history remained available after replacement'
            assert not errors, f'JS errors after replacing the audio session: {errors}'
            assert not console_errors, f'Console errors after replacing the audio session: {console_errors}'
            final_expected_hz=330
            page.locator('#fileInput').set_input_files(str(replacement))
            page.wait_for_function("document.querySelector('#fileNameLabel').textContent.includes('replacement.wav') && document.querySelector('#exportBtn').disabled === false",timeout=45000)
            assert page.locator('#refPlayBtn').is_disabled(), 'reference audio returned after selecting the same source again'
        # Import intentionally leaves the full-song AudioBuffer unmaterialized
        # to reduce iPhone peak memory. Exercise Play so the lazy playback path
        # is covered by the browser test rather than only by static inspection.
        if browser_name in mobile_modes: page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('停止')",timeout=10000)
        if browser_name in mobile_modes:
            page.evaluate("window.__testDocumentHidden=true; document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_function("document.querySelector('#playBtn').textContent.includes('再生')",timeout=5000)
            hidden_state=page.evaluate("() => ({hidden:document.hidden,playLabel:document.querySelector('#playBtn').textContent.trim(),context:window.__testAudioContexts?.at(-1)?.state})")
            assert hidden_state['hidden'] and hidden_state['context'] in ('running','suspended'), f'background transition left invalid playback state: {hidden_state}'
            page.evaluate("window.__testDocumentHidden=false; document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_function("window.__testAudioContexts?.at(-1)?.state === 'running'",timeout=5000)
            page.locator('#playBtn').tap()
            page.wait_for_function("document.querySelector('#playBtn').textContent.includes('停止')",timeout=10000)
        if browser_name in mobile_modes: page.locator('#playBtn').tap()
        else: page.locator('#playBtn').click()
        page.wait_for_function("document.querySelector('#playBtn').textContent.includes('再生')",timeout=10000)
        if browser_name in ('mobile','mobile-se','mobile-mini'):
            page.set_viewport_size({'width':844,'height':390})
            page.wait_for_function("document.querySelector('#rollCanvas').clientWidth > 500",timeout=5000)
            page.wait_for_timeout(250)
            landscape=page.evaluate("""() => ({
                cssWidth:document.querySelector('#rollCanvas').clientWidth,
                canvasWidth:document.querySelector('#rollCanvas').width,
                dpr:Math.min(devicePixelRatio || 1,2),
                pageWidth:document.documentElement.scrollWidth,
                viewportWidth:innerWidth
            })""")
            assert abs(landscape['canvasWidth']-landscape['cssWidth']*landscape['dpr']) <= 2, f'canvas backing store stale in landscape: {landscape}'
            assert landscape['pageWidth'] <= landscape['viewportWidth'], f'horizontal overflow in landscape: {landscape}'
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_function("document.querySelector('#rollCanvas').clientWidth < 500",timeout=5000)
            page.wait_for_timeout(250)
        if browser_name in mobile_modes:
            recovered=page.evaluate("""async () => {
                const context=window.__testAudioContexts?.at(-1);
                if (!context) return {available:false};
                await context.suspend();
                window.dispatchEvent(new Event('pageshow'));
                const deadline=Date.now()+3000;
                while(context.state!=='running' && Date.now()<deadline)
                    await new Promise(resolve=>setTimeout(resolve,20));
                return {available:true,state:context.state};
            }""")
            assert recovered.get('available') and recovered.get('state')=='running', f'AudioContext did not recover on pageshow: {recovered}'
        assert not errors, f'JS errors after playback: {errors}'
        assert not console_errors, f'Console errors after playback: {console_errors}'
        # Exercise the actual export UI and validate WAV container/length.
        if browser_name in mobile_share_modes:
            page.evaluate("window.__testShareEnabled=true; window.__testShareCalls=0; window.__testSharedFiles=[]")
        if browser_name=='mobile-share-cancel':
            unexpected_downloads=[]
            page.on('download',lambda download: unexpected_downloads.append(download.suggested_filename))
            page.locator('#exportBtn').tap()
            page.wait_for_function("document.querySelector('#exportBtn').dataset.exportAction === 'share'",timeout=45000)
            assert page.evaluate('window.__testShareCalls')==0, 'share was attempted before the fresh user tap'
            page.locator('#exportBtn').tap()
            page.wait_for_function("document.querySelector('#toast').style.display === 'block' && document.querySelector('#toast').textContent.includes('共有をキャンセルしました')",timeout=45000)
            page.wait_for_timeout(100)
            share_state=page.evaluate("() => ({calls:window.__testShareCalls,files:window.__testSharedFiles})")
            assert share_state['calls']==1 and share_state['files']==['tone_edited.wav'], f'native share cancellation was not handled: {share_state}'
            assert not page.locator('#exportBtn').is_disabled(), 'export button stayed disabled after cancelling share'
            assert not unexpected_downloads, f'cancelled share unexpectedly triggered a download: {unexpected_downloads}'
            assert not errors and not console_errors, f'share cancellation raised browser errors: {errors}; {console_errors}'
            print(f'browser-e2e: PASS ({browser_name} native share cancellation)')
            browser.close()
            return
        if browser_name=='mobile-share-fallback':
            page.locator('#exportBtn').tap()
            page.wait_for_function("document.querySelector('#exportBtn').dataset.exportAction === 'share'",timeout=45000)
            assert page.evaluate('window.__testShareCalls')==0, 'share was attempted before the fresh user tap'
            page.locator('#exportBtn').tap()
            page.wait_for_function("document.querySelector('#exportBtn').dataset.exportAction === 'download'",timeout=5000)
            page.wait_for_function("!document.querySelector('#exportBtn').disabled",timeout=5000)
        elif browser_name=='mobile-share-success':
            page.locator('#exportBtn').tap()
            page.wait_for_function("document.querySelector('#exportBtn').dataset.exportAction === 'share'",timeout=45000)
            page.locator('#exportBtn').tap()
            page.wait_for_function("!document.querySelector('#exportBtn').disabled && !document.querySelector('#exportBtn').dataset.exportAction",timeout=5000)
            share_state=page.evaluate("() => ({calls:window.__testShareCalls,files:window.__testSharedFiles})")
            assert share_state['calls']==1 and share_state['files']==['tone_edited.wav'], f'native share success was not handled: {share_state}'
            assert not errors and not console_errors, f'share success raised browser errors: {errors}; {console_errors}'
            print(f'browser-e2e: PASS ({browser_name} native share success)')
            browser.close()
            return
        elif browser_name in mobile_modes:
            prepare_mobile_download(page)
        with page.expect_download(timeout=45000) as info:
            page.locator('#exportBtn').tap() if browser_name in mobile_modes else page.locator('#exportBtn').click()
        if browser_name=='mobile-share-fallback':
            share_state=page.evaluate("() => ({calls:window.__testShareCalls,files:window.__testSharedFiles})")
            assert share_state['calls']==1 and share_state['files']==['tone_edited.wav'], f'native share was not attempted: {share_state}'
        download=info.value
        assert page.locator('#exportBtn .toolLabel').count()==1, 'export button label markup was lost after export'
        target=Path(temp)/'export.wav';download.save_as(target)
        with wave.open(str(target),'rb') as f:
            assert f.getnchannels()==1
            assert f.getsampwidth()==3
            # Web Audio decodes into the AudioContext's native sample rate.
            # The editor deliberately exports at that decoded rate, so a
            # 24 kHz fixture commonly becomes 48 kHz in Chromium.
            out_rate=f.getframerate()
            assert 22050 <= out_rate <= 192000
            duration_tolerance=0.08 if audio_file.suffix.lower() in ('.mp3','.m4a','.aac') else 2/out_rate
            assert abs((f.getnframes()/out_rate)-expected_seconds) < duration_tolerance
            raw=f.readframes(f.getnframes())
        pcm=[int.from_bytes(raw[i:i+3],'little',signed=True) for i in range(0,len(raw),3)]
        lo=int(out_rate*0.25);hi=min(len(pcm)-1,int(out_rate*1.1))
        crossings=sum(1 for i in range(lo,hi) if pcm[i]<=0<pcm[i+1])
        exported_hz=crossings*out_rate/(hi-lo)
        assert abs(exported_hz-final_expected_hz)<3, f'export pitch/session mismatch: expected {final_expected_hz} Hz, measured {exported_hz:.1f} Hz'
        assert not errors, f'JS errors after export: {errors}'
        assert not console_errors, f'Console errors after export: {console_errors}'
        if browser_name=='mobile-mini':
            # Replacing an active session with a WAV rejected by the iPhone
            # preflight must discard stale metadata and leave a recovery path.
            decode_calls_before_failure=page.evaluate('window.__testDecodeAudioCalls')
            page.locator('#fileInput').set_input_files(str(oversized_wav))
            page.wait_for_function("document.querySelector('#toast').getAttribute('role') === 'alert' && document.querySelector('#loadingScreen').style.display === 'none'",timeout=5000)
            failed_replacement=page.evaluate("() => ({file:document.querySelector('#fileNameLabel').textContent,exportDisabled:document.querySelector('#exportBtn').disabled,playDisabled:document.querySelector('#playBtn').disabled,pickerEnabled:!document.querySelector('#backBtn').disabled,canvasTabIndex:document.querySelector('#rollCanvas').tabIndex,noteNavHidden:document.querySelector('#accessibleNoteNav').hidden,decodeCalls:window.__testDecodeAudioCalls})")
            assert not failed_replacement['file'] and failed_replacement['exportDisabled'] and failed_replacement['playDisabled'], f'failed replacement retained stale audio metadata or actions: {failed_replacement}'
            assert failed_replacement['pickerEnabled'] and failed_replacement['canvasTabIndex']==-1 and failed_replacement['noteNavHidden'], f'failed replacement did not return to a clean accessible picker state: {failed_replacement}'
            assert failed_replacement['decodeCalls']==decode_calls_before_failure, f'oversized replacement reached Web Audio decode: {failed_replacement}'
            assert len(console_errors)==1 and 'decodeAudioFile' in console_errors[0], f'expected one reported oversized replacement: {console_errors}'
        print(f'browser-e2e: PASS ({browser_name} upload -> Worker analysis -> lazy playback -> WAV export)')
        browser.close()

if __name__=='__main__':main()
