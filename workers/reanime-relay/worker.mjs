const ORIGIN = 'https://reanime.to';
const MAX_RESPONSE = 4_000_000;
const headers = {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'};
const failure = (status, error) => Response.json({error}, {status, headers});

function allowedPath(path) {
  if (typeof path !== 'string' || path.length > 2000 || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) return false;
  const url = new URL(path, ORIGIN);
  const keys = [...url.searchParams.keys()];
  if (url.origin !== ORIGIN || path.split('?')[0] !== url.pathname) return false;
  if (url.pathname === '/api/v1/search') {
    const q = url.searchParams.get('q');
    return keys.length === 1 && keys[0] === 'q' && !!q?.trim() && q.length <= 120;
  }
  if (/^\/watch\/[a-zA-Z0-9_-]{1,230}\/__data\.json$/.test(url.pathname)) {
    return keys.length === 1 && keys[0] === 'ep' && url.searchParams.get('ep') === '1';
  }
  if (keys.length) return false;
  if (['/api/v1/home', '/home/__data.json'].includes(path)) return true;
  if (/^\/api\/v1\/anime\/[a-zA-Z0-9_-]{1,230}(?:\/episodes)?$/.test(path)) return true;
  const stream = /^\/api\/flix\/([1-9]\d{0,8})\/(\d{1,5}(?:\.\d)?)$/.exec(path);
  return !!stream && Number(stream[2]) <= 10000;
}

async function boundedBody(response, limit) {
  if (Number(response.headers.get('Content-Length')) > limit) throw new Error('Response too large');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel(); throw new Error('Response too large');}
      parts.push(value);
    }
  } finally {reader.releaseLock();}
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) {result.set(part, offset); offset += part.byteLength;}
  return result;
}

function authorized(value, token) {
  const expected = `Bearer ${token}`;
  if (!value || value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export async function handleRequest(request, env, fetcher = fetch) {
  const path = new URL(request.url).pathname;
  const configured = typeof env.REANIME_WORKER_TOKEN === 'string' && env.REANIME_WORKER_TOKEN.length >= 32;
  if (path === '/health' && request.method === 'GET') {
    return Response.json({service: 'anihub-reanime-relay', version: 1, configured}, {headers});
  }
  if (path !== '/resolve') return failure(404, 'Not found');
  if (request.method !== 'POST') return failure(405, 'Method not allowed');
  if (!configured) return failure(503, 'Reanime 중계 서버의 인증 설정이 필요합니다.');
  if (!authorized(request.headers.get('Authorization'), env.REANIME_WORKER_TOKEN)) return failure(401, 'Unauthorized');
  let metadataPath;
  try {
    const body = JSON.parse(new TextDecoder().decode(await boundedBody(request, 4096)));
    if (!body || Object.keys(body).length !== 1 || !allowedPath(body.path)) return failure(400, '잘못된 Reanime 조회 경로입니다.');
    metadataPath = body.path;
  } catch {return failure(400, '잘못된 Reanime 조회 요청입니다.');}
  try {
    const upstream = await fetcher(`${ORIGIN}${metadataPath}`, {
      // workerd supports manual/follow only. Reject 3xx below without following Location.
      headers: {Accept: 'application/json'}, redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return failure(upstream.status >= 400 ? upstream.status : 502, `Reanime 요청 실패 (HTTP ${upstream.status}).`);
    }
    if (!(upstream.headers.get('Content-Type') || '').toLowerCase().includes('application/json') || upstream.headers.has('cf-mitigated')) {
      await upstream.body?.cancel();
      return failure(502, 'Reanime에서 JSON 응답 대신 보안 확인 페이지를 반환했습니다.');
    }
    // Forward metadata only. Browser cookies, account headers and video bytes never pass through this Worker.
    return new Response(await boundedBody(upstream, MAX_RESPONSE), {headers});
  } catch {return failure(502, 'Reanime 응답을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.');}
}

export default {fetch: (request, env) => handleRequest(request, env)};
