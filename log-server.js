// Tiny log relay: game POSTs console output here, we print to stdout.
// Run with: node log-server.js
const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      process.stdout.write(body);
      res.writeHead(204); res.end();
    });
  } else {
    res.writeHead(404); res.end();
  }
});

server.listen(4444, () => process.stderr.write('log-server listening on :4444\n'));
