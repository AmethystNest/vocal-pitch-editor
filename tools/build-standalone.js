'use strict';
// Builds one self-contained HTML file (dist/pitch-editor-standalone.html)
// that can be downloaded and opened directly, without a web server.
// Engine and app code are inlined; the analysis/resynthesis Worker is
// created from a Blob holding the engine plus worker code. The PWA
// manifest/service worker are omitted (they need an https origin).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
// Keep inline code from terminating its <script> element early.
const inlineScript = (code) => code.replace(/<\/script/gi, '<\\/script');

const engine = read('src/engine.js');
const worker = read('src/worker.js');
const app = read('src/app.js');
if (!worker.includes("importScripts('./engine.js');")) throw new Error('worker.js no longer imports engine.js as expected');
const workerBundle = engine + '\n' + worker.replace("importScripts('./engine.js');", '');

let html = read('index.html');
const icon = fs.readFileSync(path.join(root, 'icon-180.png')).toString('base64');
const replaceOnce = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html is missing: ${from}`);
  html = html.replace(from, () => to);
};
replaceOnce('<link rel="manifest" href="./manifest.webmanifest">\n', '');
replaceOnce('<link rel="icon" type="image/png" sizes="192x192" href="./icon-192.png">', `<link rel="icon" type="image/png" href="data:image/png;base64,${icon}">`);
replaceOnce('<link rel="apple-touch-icon" href="./icon-180.png">', `<link rel="apple-touch-icon" href="data:image/png;base64,${icon}">`);
replaceOnce('<script src="./src/engine.js"></script>', `<script>\n${inlineScript(engine)}\n</script>\n<script>\n(function () {\n  try {\n    const source = ${JSON.stringify(workerBundle).replace(/<\//g, '<\\/')};\n    window.PITCH_EDITOR_WORKER_URL = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));\n  } catch (e) {}\n})();\n</script>`);
replaceOnce('<script src="./src/app.js"></script>', `<script>\n${inlineScript(app)}\n</script>`);

const out = path.join(root, 'dist', 'pitch-editor-standalone.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`standalone build: ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);
