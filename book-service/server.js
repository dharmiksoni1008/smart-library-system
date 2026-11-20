'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3001;
const RESOURCE = 'books';
const FIELDS = ["title","author"];
const DATABASE = path.join(__dirname, RESOURCE + '.json');
const MAX_BODY = 16 * 1024;

function reply(res, status, body, headers = {}) {
  const json = JSON.stringify(body, null, 2) + '\n';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json), ...headers });
  res.end(json);
}

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validFields(record) {
  return FIELDS.every(field => typeof record[field] === 'string' && record[field].trim().length > 0)
    && (RESOURCE !== 'students' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email.trim()));
}

function readRecords() {
  const records = JSON.parse(fs.readFileSync(DATABASE, 'utf8'));
  if (!Array.isArray(records) || records.some(record => !record || !validId(record.id) || !validFields(record))
      || new Set(records.map(record => record.id)).size !== records.length) {
    throw new Error('Invalid database structure');
  }
  return records;
}


function saveRecords(records) {
  const temporary = DATABASE + '.tmp';
  let descriptor;
  let owned = false;
  try {
   
    descriptor = fs.openSync(temporary, 'wx');
    owned = true;
    fs.writeFileSync(descriptor, JSON.stringify(records, null, 2) + '\n', 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, DATABASE);
    owned = false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (owned && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function handle(req, res, id, raw) {
  try {
    let input;
    if (req.method === 'POST' || req.method === 'PUT') {
      try { input = JSON.parse(raw); }
      catch { return reply(res, 400, { error: 'Body must contain valid JSON.' }); }
      if (!input || Array.isArray(input) || typeof input !== 'object'
          || !validFields(input) || Object.keys(input).some(key => !['id', ...FIELDS].includes(key))) {
        return reply(res, 400, { error: 'Supply only id and required non-empty fields: ' + FIELDS.join(', ') + '.' });
      }
      if ((req.method === 'POST' && !validId(input.id))
          || (req.method === 'PUT' && input.id !== undefined && input.id !== id)) {
        return reply(res, 400, { error: 'POST requires a positive safe-integer id; PUT cannot change the route id.' });
      }
    }
    const records = readRecords();
    if (req.method === 'GET' && id === null) return reply(res, 200, records);
    const index = records.findIndex(record => record.id === (id === null ? input.id : id));
    if (req.method === 'POST') {
      if (index !== -1) return reply(res, 400, { error: 'That id already exists.' });
      const record = { id: input.id };
      FIELDS.forEach(field => { record[field] = input[field].trim(); });
      records.push(record);
      saveRecords(records);
      return reply(res, 201, record, { Location: '/' + RESOURCE + '/' + record.id });
    }
    if (index === -1) return reply(res, 404, { error: 'Record not found.' });
    if (req.method === 'GET') return reply(res, 200, records[index]);
    if (req.method === 'PUT') {
      const record = { id };
      FIELDS.forEach(field => { record[field] = input[field].trim(); });
      records[index] = record;
      saveRecords(records);
      return reply(res, 200, record);
    }
    const [deleted] = records.splice(index, 1);
    saveRecords(records);
    return reply(res, 200, { message: 'Record deleted.', record: deleted });
  } catch (error) {
    console.error('Storage operation failed:', error.message);
    return reply(res, 500, { error: 'Database operation failed.' });
  }
}

const server = http.createServer((req, res) => {
  req.on('error', error => console.error('Request stream failed:', error.message));
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { req.resume(); return reply(res, 400, { error: 'Invalid URL.' }); }
  const parts = url.pathname.split('/');
  if (url.search || parts[1] !== RESOURCE || parts.length < 2 || parts.length > 3
      || (parts.length === 3 && parts[2] === '')) {
    req.resume(); return reply(res, 404, { error: 'Route not found.' });
  }
  const id = parts.length === 2 ? null : Number(parts[2]);
  if (id !== null && (!/^[1-9]\d*$/.test(parts[2]) || !validId(id))) {
    req.resume(); return reply(res, 400, { error: 'Route id must be a positive safe integer.' });
  }
  const allowed = id === null ? ['GET', 'POST'] : ['GET', 'PUT', 'DELETE'];
  if (!allowed.includes(req.method)) {
    req.resume(); return reply(res, 405, { error: 'Method not allowed.' }, { Allow: allowed.join(', ') });
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      req.resume(); return reply(res, 400, { error: 'Content-Type must be application/json.' });
    }
    const chunks = [];
    let length = 0;
    let rejected = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > MAX_BODY) {
        if (!rejected) { rejected = true; reply(res, 400, { error: 'JSON body exceeds 16384 bytes.' }); }
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) handle(req, res, id, Buffer.concat(chunks).toString('utf8')); });
  } else {
    req.resume();
    handle(req, res, id);
  }
});
server.requestTimeout = 10000;
server.on('error', error => { console.error('Service failed:', error.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', () => console.log(RESOURCE + ' service listening on loopback port ' + PORT));
