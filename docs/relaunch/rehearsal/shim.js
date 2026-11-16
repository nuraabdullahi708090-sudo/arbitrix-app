'use strict';
/**
 * Minimal PostgREST-compatible shim over the disposable Docker database.
 *
 * Exists only so the REAL server.js can run against a REAL PostgreSQL during the
 * Kalderix smoke rehearsal. It implements the subset of the PostgREST protocol
 * that supabase-js v2 actually emits for the code paths under test:
 *   GET/HEAD/POST/PATCH/DELETE /rest/v1/<table>  (+ select, eq/in/is/null, order, limit)
 *   POST /rest/v1/rpc/<fn>
 *   Accept: application/vnd.pgrst.object+json  -> single object or PGRST116
 *   Prefer: count=exact (HEAD)                 -> Content-Range: 0-0/N
 *
 * NOT a general-purpose implementation and NOT part of the product.
 */
const http = require('http');
const crypto = require('crypto');

const CT = process.env.SMOKE_CONTAINER || 'kalderix-smoke';
const DB = process.env.SMOKE_DB || 'smoke';
const PORT = Number(process.env.SHIM_PORT || 5431);
const KEY = process.env.SHIM_KEY || 'smoke-anon-key'; // dummy rehearsal key

function psql(sql, { single = false } = {}) {
  const { execFileSync } = require('child_process');
  // -q quiet, -t tuples only, -A unaligned, -v ON_ERROR_STOP=1
  global.__lastSql = sql;
  return execFileSync('sudo', ['-n', 'docker', 'exec', '-i', CT, 'psql', '-U', 'postgres', '-d', DB, '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
  });
}

const boolCache = new Map();
function boolCols(table) {
  if (boolCache.has(table)) return boolCache.get(table);
  let set = new Set();
  try {
    const rows = psql(`select column_name from information_schema.columns where table_schema='public' and table_name='${table}' and data_type='boolean';`);
    set = new Set(rows.split('\n').map((x) => x.trim()).filter(Boolean));
  } catch { /* unknown table: no coercion */ }
  boolCache.set(table, set);
  return set;
}
function valFor(table, col, v) {
  const b = boolCols(table);
  if (b.has(col) && (v === 0 || v === 1 || v === '0' || v === '1' || v === true || v === false)) {
    return (v === 1 || v === '1' || v === true) ? 'TRUE' : 'FALSE';
  }
  return val(v);
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined || v === '' ? 'NULL' : Number(v));
function val(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') return lit(JSON.stringify(v)) + '::jsonb';
  return lit(v);
}

function parseFilters(params) {
  const where = [];
  for (const [rawKey, rawVal] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(rawKey)) continue;
    const key = rawKey.replace(/^not\./, '');
    const negated = rawKey.startsWith('not.');
    let m;
    if ((m = /^eq\.(.*)$/s.exec(rawVal))) where.push(`"${key}" = ${val(coerce(m[1]))}`);
    else if ((m = /^neq\.(.*)$/s.exec(rawVal))) where.push(`"${key}" <> ${val(coerce(m[1]))}`);
    else if ((m = /^in\.\((.*)\)$/s.exec(rawVal))) {
      const items = m[1].split(',').map((s) => val(coerce(s.replace(/^"(.*)"$/, '$1')))).join(',');
      where.push(`"${key}" ${negated ? 'NOT IN' : 'IN'} (${items})`);
    } else if ((m = /^is\.(null|true|false)$/.exec(rawVal))) {
      const w = m[1] === 'null' ? `"${key}" IS NULL` : `"${key}" IS ${m[1].toUpperCase()}`;
      where.push(negated ? `NOT (${w})` : w);
    } else if ((m = /^gte\.(.*)$/s.exec(rawVal))) where.push(`"${key}" >= ${val(coerce(m[1]))}`);
    else if ((m = /^lte\.(.*)$/s.exec(rawVal))) where.push(`"${key}" <= ${val(coerce(m[1]))}`);
    else if ((m = /^gt\.(.*)$/s.exec(rawVal))) where.push(`"${key}" > ${val(coerce(m[1]))}`);
    else if ((m = /^lt\.(.*)$/s.exec(rawVal))) where.push(`"${key}" < ${val(coerce(m[1]))}`);
  }
  return where.length ? ' WHERE ' + where.join(' AND ') : '';
}
function coerce(s) {
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * Expand PostgREST resource embedding, e.g. `referrer:users!referrer_id(id,email,name)`,
 * into a correlated JSON subquery. The rehearsal server embeds the referrer on
 * /api/referral and the admin withdrawal list.
 */
function expandSelect(select, table) {
  if (!select || select === '*') return select;
  const parts = [];
  let depth = 0, buf = '';
  for (const ch of select) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; } else buf += ch;
  }
  if (buf) parts.push(buf);
  return parts.map((part) => {
    const item = part.trim();
    const embedded = /^(\w+):(\w+)!(\w+)\((.+)\)$/.exec(item);
    if (!embedded) return item;
    const [, alias, target, fk, cols] = embedded;
    return `(select row_to_json(z) from (select ${cols} from public.${target} z where z.id = public.${table}.${fk}) z) as ${alias}`;
  }).join(', ');
}

function orderBy(params) {
  const o = params.get('order');
  if (!o) return '';
  return ' ORDER BY ' + o.split(',').map((part) => {
    const [col, ...rest] = part.split('.');
    const dir = rest.includes('desc') ? 'DESC' : 'ASC';
    return `"${col}" ${dir}`;
  }).join(', ');
}
function limitOf(params) {
  const l = params.get('limit');
  return l ? ` LIMIT ${Number(l)}` : '';
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf ? JSON.parse(buf) : null));
  });
}

function json(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const ALLOWED = (process.env.SHIM_KEYS || KEY).split(',');
  if (req.headers.apikey && !ALLOWED.includes(req.headers.apikey)) return json(res, 401, { message: 'bad key' });

  // ---------- RPC ----------
  const rpc = /^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname);
  if (rpc) {
    const fn = decodeURIComponent(rpc[1]);
    const body = (await readBody(req)) || {};
    const args = Object.entries(body).map(([k, v]) => `${k} => ${val(v)}`).join(', ');
    try {
      const out = psql(`select public.${fn}(${args});`);
      const raw = out.trim();
      let parsed;
      if (raw === 't') parsed = true;
      else if (raw === 'f') parsed = false;
      else { try { parsed = JSON.parse(raw); } catch { parsed = raw; } }
      return json(res, 200, parsed === '' ? null : parsed);
    } catch (e) {
      return json(res, 400, { code: 'PGRST202', message: String(e.stderr || e.message).slice(0, 400) });
    }
  }

  // ---------- table ----------
  const table = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(url.pathname);
  if (!table) return json(res, 404, { message: 'not found' });
  const t = table[1];
  const params = url.searchParams;
  const select = params.get('select') || '*';
  const single = String(req.headers.accept || '').includes('pgrst.object');

  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const countWanted = String(req.headers.prefer || '').includes('count=exact');
      if (countWanted) {
        const n = Number(psql(`select count(*) from public.${t}${parseFilters(params)};`).trim());
        res.writeHead(200, { 'Content-Range': `0-0/${n}`, 'Content-Type': 'application/json' });
        return res.end('[]');
      }
      const sql = `select coalesce(json_agg(row_to_json(x)), '[]'::json) from (select ${expandSelect(select, t)} from public.${t}${parseFilters(params)}${orderBy(params)}${limitOf(params)}) x;`;
      const rows = JSON.parse(psql(sql).trim() || '[]');
      if (single) {
        if (rows.length !== 1) return json(res, 406, { code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned` });
        return json(res, 200, rows[0]);
      }
      return json(res, 200, rows);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body) ? body : [body];
      if (!rows.length) return json(res, 201, []);
      const cols = Object.keys(rows[0]);
      const onConflict = params.get('on_conflict');
      const merge = String(req.headers.prefer || '').includes('merge-duplicates');
      const values = rows.map((r) => `(${cols.map((c) => valFor(t, c, r[c])).join(',')})`).join(',');
      const conflict = onConflict && merge ? ` ON CONFLICT ("${onConflict}") DO UPDATE SET ` + cols.filter((c) => c !== onConflict).map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ') : '';
      const sql = `WITH ins AS (insert into public.${t} (${cols.map((c) => `"${c}"`).join(',')}) values ${values}${conflict} returning ${select === '*' ? '*' : select}) select coalesce(json_agg(row_to_json(x)), '[]'::json) from ins x;`;
      const out = psql(sql).trim();
      const inserted = JSON.parse(out || '[]');
      if (single) {
        if (inserted.length !== 1) return json(res, 406, { code: 'PGRST116', message: 'JSON object requested' });
        return json(res, 201, inserted[0]);
      }
      return json(res, 201, inserted);
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const sets = Object.entries(body).map(([k, v]) => `"${k}" = ${valFor(t, k, v)}`).join(', ');
      const wantRows = String(req.headers.prefer || '').includes('return=representation');
      if (wantRows) {
        // A data-modifying statement is only legal as a CTE, never as a derived table.
        const sql = `with upd as (update public.${t} set ${sets}${parseFilters(params)} returning ${select === '*' ? '*' : expandSelect(select, t)}) select coalesce(json_agg(row_to_json(x)), '[]'::json) from upd x;`;
        const out = JSON.parse(psql(sql).trim() || '[]');
        if (single) {
          if (out.length !== 1) return json(res, 406, { code: 'PGRST116', message: 'JSON object requested' });
          return json(res, 200, out[0]);
        }
        return json(res, 200, out);
      }
      psql(`update public.${t} set ${sets}${parseFilters(params)};`);
      return json(res, 204);
    }

    if (req.method === 'DELETE') {
      psql(`delete from public.${t}${parseFilters(params)};`);
      return json(res, 204);
    }
  } catch (e) {
    console.error('[shim] SQL ERROR on ' + req.method + ' ' + url.pathname + url.search);
    if (global.__lastSql) console.error('[shim] SQL: ' + global.__lastSql.slice(0, 400));
    const msg = String((e && (e.stderr || e.message)) || 'error').slice(0, 500);
    console.error('[shim] ' + msg.slice(0, 300));
    return json(res, 400, { code: 'PGRST100', message: msg });
  }
  return json(res, 405, { message: 'method not allowed' });
});

server.listen(PORT, '127.0.0.1', () => console.log('[shim] listening on ' + PORT));
