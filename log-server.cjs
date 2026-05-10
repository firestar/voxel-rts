// Tiny log relay: game POSTs console output here, we print to stdout and file.
const http = require('http');
const fs = require('fs');
const out = fs.createWriteStream('/tmp/voxel-game-logs.txt', { flags: 'a' });

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
      out.write(body);
      res.writeHead(204); res.end();
    });
  } else if (req.method === 'POST' && req.url === '/trace') {
    // Binary PNG dump from the path-trace mode. Saved with a timestamp so
    // multiple sessions don't clobber each other.
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const path = `/tmp/voxel-game-trace-${Date.now()}.png`;
      fs.writeFile(path, buf, (err) => {
        if (err) process.stderr.write(`trace write failed: ${err}\n`);
        else process.stderr.write(`trace saved: ${path} (${buf.length} bytes)\n`);
      });
      res.writeHead(204); res.end();
    });
  } else {
    res.writeHead(404); res.end();
  }
});

server.listen(4444, () => process.stderr.write('log-server listening on :4444\n'));
