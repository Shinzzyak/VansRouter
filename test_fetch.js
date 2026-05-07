const https = require('https');

const data = JSON.stringify({
  model: "glm-4.5",
  messages: [{ role: "user", content: "Halo test" }]
});

const options = {
  hostname: 'agentrouter.org',
  path: '/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk-0Q14N2rUsC8cqRTkxeqzZxtJS47QBIGXiG5dCQaahFGXXgG6',
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'User-Agent': 'vscode-fetch/1.0.0 KiloCode/1.0.0'
  }
};

const req = https.request(options, res => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', d => process.stdout.write(d));
});

req.on('error', error => console.error(error));
req.write(data);
req.end();
