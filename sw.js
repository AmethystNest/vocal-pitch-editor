const CACHE='vocal-pitch-editor-v51-visible-mobile-toolbar-chevrons';
const SHELL=['./','./index.html','./manifest.webmanifest','./src/engine.js','./src/app.js','./src/worker.js','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await Promise.all(SHELL.map(async path=>{
    const url=new URL(path,self.registration.scope);
    const response=await fetch(new Request(url,{cache:'reload'}));
    if(!response.ok)throw new Error(`Failed to precache ${path}: ${response.status}`);
    await cache.put(url,response);
  }));
  await self.skipWaiting();
})()));
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
