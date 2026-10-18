// SSE practice server: no dependencies, just node:http.  Run: node sse-lab.mjs
import http from 'node:http';

const page = `<!doctype html><meta charset="utf-8"><title>SSE lab</title>
<h3>1. EventSource (GET, built into the browser)</h3>
<button onclick="startClock()">Start clock</button> <button onclick="es?.close()">Close</button>
<pre id="clock"></pre>
<h3>2. fetch + reader (POST with a body, like DocuMind)</h3>
<input id="text" value="streaming is just HTTP that does not end yet" size="45">
<button onclick="startEcho()">Send</button> <button onclick="ctrl?.abort()">Stop</button>
<pre id="echo"></pre>
<script>
let es, ctrl;
function startClock() {
  es = new EventSource('/clock');                       // GET only, no body
  es.addEventListener('tick', (e) => (clock.textContent += JSON.parse(e.data) + '\\n'));  // data is a JSON string
  es.onerror = () => (clock.textContent += '(connection lost, EventSource retries automatically)\\n');
}
async function startEcho() {
  ctrl = new AbortController(); echo.textContent = '';
  const res = await fetch('/echo', { method: 'POST', body: text.value, signal: ctrl.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\\n\\n')) !== -1) {      // one frame = up to a blank line
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = frame.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(frame.match(/^data: (.*)$/m)[1]);
        if (event === 'token') echo.textContent += data.word + ' ';   // handle each event type separately
        if (event === 'done') echo.textContent += '\\n[done: ' + data.count + ' words]';
      }
    }
  } catch (e) { echo.textContent += '\\n[stopped: ' + e.name + ']'; }
}
</script>`;

const sseHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const send = (res, event, data, id) =>
  res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

http
  .createServer((req, res) => {
    if (req.url === '/') return res.end(page);

    if (req.url === '/clock') {                          // endless stream, one event per second
      res.writeHead(200, sseHeaders);
      res.write('retry: 2000\n\n');                      // tell EventSource: reconnect after 2 s
      let n = Number(req.headers['last-event-id'] ?? 0); // resume after a reconnect
      const timer = setInterval(() => send(res, 'tick', `#${++n} ${new Date().toLocaleTimeString()}`, n), 1000);
      res.on('close', () => { clearInterval(timer); console.log('clock client disconnected'); });
      return;
    }

    if (req.url === '/echo' && req.method === 'POST') {  // finite stream, like an LLM answer
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, sseHeaders);
        const words = body.split(/\s+/).filter(Boolean);
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) return send(res, 'token', { word: words[i++] });
          send(res, 'done', { count: words.length });
          clearInterval(timer);
          res.end();                                     // finished: close the response
        }, 300);
        res.on('close', () => {                          // client pressed Stop / closed the tab
          if (!res.writableFinished) { clearInterval(timer); console.log('echo stopped by client'); }
        });
      });
      return;
    }
    res.writeHead(404).end();
  })
  .listen(3001, () => console.log('SSE lab on http://localhost:3001'));
