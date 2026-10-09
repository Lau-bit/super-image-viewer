// Page half of tools/click-recorder.ps1 — started by it when -CdpPort is given.
// Usage: node click-recorder-page.mjs <cdpPort> <logFile> [minutes]
// Hooks the main window's page over CDP: logs every pointerdown/mousedown/click/dblclick that
// reaches the DOM (target, CSS coords, uiHidden) and any windowClose / window.close call with its
// stack. Re-attaches if the app is relaunched on the same port. Reads and logs only.
import { appendFileSync } from 'node:fs';

const [port, logFile, minutes = '30'] = process.argv.slice(2);
const stamp = () => {
  const d = new Date();
  return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};
const log = (s) => appendFileSync(logFile, `${stamp()} ${s}\n`);

const HOOK = `(() => {
  if (window.__clickRecorder) return 'already installed';
  window.__clickRecorder = true;
  const d = (e) => {
    const t = e.target;
    const name = t.id ? '#' + t.id : (typeof t.className === 'string' && t.className ? '.' + t.className.split(' ')[0] : t.tagName);
    return name + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' of ' + innerWidth + 'x' + innerHeight +
      ' (r=' + Math.round(innerWidth - e.clientX) + ' t=' + Math.round(e.clientY) + ' css px) uiHidden=' + state.uiHidden;
  };
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu']) {
    document.addEventListener(type, e => console.log('[click-recorder] ' + type + ' ' + d(e)), true);
  }
  const origClose = window.viewerAPI.windowClose;
  window.viewerAPI.windowClose = (...a) => { console.log('[click-recorder] viewerAPI.windowClose CALLED\\n' + new Error().stack); return origClose(...a); };
  const origWindowClose = window.close.bind(window);
  window.close = () => { console.log('[click-recorder] window.close CALLED\\n' + new Error().stack); origWindowClose(); };
  window.addEventListener('beforeunload', () => console.log('[click-recorder] beforeunload'));
  return 'installed';
})()`;

let connected = false;
async function attach() {
  let targets;
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return; }
  const page = targets.find(t => t.type === 'page' && t.title === 'Super Image Viewer');
  if (!page) return;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', resolve, { once: true }); });
  if (ws.readyState !== WebSocket.OPEN) return;
  connected = true;
  // Runtime.enable replays console messages logged before we attached; those are old clicks.
  const attachedAt = Date.now();
  let id = 0;
  const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      if (msg.params.timestamp < attachedAt - 50) return;
      const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
      if (text.startsWith('[click-recorder]')) log(text.replace('[click-recorder] ', 'PAGE '));
    } else if (msg.method === 'Runtime.executionContextCreated') {
      send('Runtime.evaluate', { expression: HOOK });   // page reloaded: re-install
    } else if (msg.id && msg.result?.result?.value) {
      log(`PAGE hook ${msg.result.result.value}`);
    }
  });
  ws.addEventListener('close', () => { connected = false; log('PAGE CDP connection closed (page or app gone)'); });
  send('Runtime.enable', {});
  send('Runtime.evaluate', { expression: HOOK, returnByValue: true });
  log(`PAGE attached on CDP port ${port}`);
}

log(`page recorder started, CDP port ${port}`);
const deadline = Date.now() + Number(minutes) * 60_000;
while (Date.now() < deadline) {
  if (!connected) await attach();
  await new Promise(r => setTimeout(r, 2000));
}
log('page recorder finished');
process.exit(0);
