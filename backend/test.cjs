const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 4000,
  path: '/api/workspaces/test/runs',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', e => console.error(e));
req.write(JSON.stringify({ task: "test task 1234567890" }));
req.end();
