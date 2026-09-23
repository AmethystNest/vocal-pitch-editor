const CACHE='vocal-pitch-editor-v19-yin-low-f0';
const SHELL=['./','./index.html','./manifest.webmanifest','./src/engine.js','./src/app.js','./src/worker.js','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL))));
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys()){if(k!==CACHE&&k.startsWith('vocal-pitch-editor-'))await caches.delete(k);}await self.clients.claim();})()));
self.addEventListener('fetch',e=>{
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(r=>{
      const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)); return r;
    }).catch(()=>caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
