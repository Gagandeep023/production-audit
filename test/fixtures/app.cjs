// A small application configured the way most are: nothing wrong on the page,
// every dangerous default left exactly where the library put it.
const http = require('node:http');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: 'postgres://localhost/app' });

const server = http.createServer((_req, res) => {
  res.end('ok');
});

server.listen(0, async () => {
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/`);
  await pool.end();
  server.close();
});
