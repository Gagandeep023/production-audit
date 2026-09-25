// The same application with every one of those decisions actually made. This
// is the fixture that must produce a completely silent report.
const http = require('node:http');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgres://localhost/app',
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  statement_timeout: 30000,
  query_timeout: 30000,
  max: 20,
  allowExitOnIdle: false,
});

const server = http.createServer((_req, res) => {
  res.end('ok');
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;
server.setTimeout(0);

server.listen(0, async () => {
  const { port } = server.address();
  await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  await pool.end();
  server.close();
});
