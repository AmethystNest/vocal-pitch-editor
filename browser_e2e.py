"""Real Chromium smoke test: file upload -> analysis -> WAV export.
Requires Python playwright and installed Chromium. Does not replace iPhone testing.
"""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from threading import Thread
from tempfile import TemporaryDirectory
from contextlib import contextmanager
import math, struct, wave, os
from playwright.sync_api import sync_playwright

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
        browser=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
        page=browser.new_page(accept_downloads=True)
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(url,wait_until='load',timeout=30000)
        page.locator('#fileInput').set_input_files(str(wav))
        page.wait_for_function("document.querySelector('#exportBtn').disabled === false",timeout=45000)
        assert 'tone.wav' in page.locator('#fileNameLabel').inner_text()
        assert not errors, f'JS errors: {errors}'
        # Exercise the actual export UI and validate WAV container/length.
        with page.expect_download(timeout=45000) as info:
            page.locator('#exportBtn').click()
        download=info.value
        target=Path(temp)/'export.wav';download.save_as(target)
        with wave.open(str(target),'rb') as f:
            assert f.getnchannels()==1
            assert f.getsampwidth()==3
            assert f.getframerate()==24000
            assert abs(f.getnframes()-int(24000*1.4))<2
        assert not errors, f'JS errors after export: {errors}'
        print('browser-e2e: PASS (Chromium upload -> Worker analysis -> WAV export)')
        browser.close()

if __name__=='__main__':main()
