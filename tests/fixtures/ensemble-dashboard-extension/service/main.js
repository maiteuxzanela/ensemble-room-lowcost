#!/usr/bin/env node
/**
 * FIXTURE HERMÉTICO — Frente B do TICKET-HARNESS-56 (contrato do proxy da
 * extensão ensemble-dashboard).
 *
 * Substituto VERSIONADO no repositório para o guest service da extensão, que
 * ainda vive fora do OpenChamber (pré-merge). NÃO é mock: é um serviço HTTP
 * REAL, spawnado como subprocesso pela suíte `tests/test_emergency_pause.mjs`
 * e exercitado de ponta a ponta contra o dashboard REAL do plugin (HTTP de
 * verdade, SQLite de verdade, sem nenhum stub de lógica de produção).
 *
 * Contrato coberto pela suíte:
 *   - gate Bearer global (401 sem/ token errado, inclusive bloqueando mutação);
 *   - validação local: JSON inválido (400 invalid_json), campos ausentes
 *     (400 missing_fields / missing_team_id), teto de 16 KiB (413);
 *   - relay verbatim do upstream (404/409 com `upstreamStatus` e a mensagem
 *     de erro original);
 *   - 200 com trim local, `proxiedAt` numérico e efeito real no SQLite via
 *     upstream;
 *   - 502 honesto (`dashboard_unavailable`) quando o dashboard cai.
 *
 * Auth com a suíte: `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN`.
 * Env de upstream: ENSEMBLE_DASHBOARD_URL (obrigatório).
 *
 * O session token do dashboard (TICKET-RELEASE-08) é obtido do próprio
 * upstream via GET /api/session-token (rota de leitura protegida pelo gate
 * Host/Origin loopback — este guest roda na mesma máquina) e anexado a toda
 * mutação proxied. Tokens são cacheados por URL e renovados automaticamente
 * em 401.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || "0");
const SERVICE_TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN || "";
const UPSTREAM = (process.env.ENSEMBLE_DASHBOARD_URL || "").replace(/\/+$/, "");

const MAX_BODY_BYTES = 16 * 1024;
const tokenCache = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Connection": "close",
  });
  res.end(body);
}

function bearerMatches(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(\S+)$/i);
  return Boolean(SERVICE_TOKEN) && match?.[1] === SERVICE_TOKEN;
}

/** Lê o corpo com teto duro; descarta o buffer ao cruzar o limite. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on("error", () => { /* cliente caiu — nada a parsear */ });
    req.on("data", (chunk) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ tooLarge: false, raw: Buffer.concat(chunks).toString("utf8") }));
  });
}

/** Session token do dashboard (cacheado; renova uma vez em 401). */
async function upstreamToken(url) {
  if (tokenCache.has(url)) return tokenCache.get(url);
  const res = await fetch(`${UPSTREAM}/api/session-token`);
  if (!res.ok) throw new Error(`upstream session-token HTTP ${res.status}`);
  const { token } = await res.json();
  tokenCache.set(url, token);
  return token;
}

/** Repassa uma mutação ao dashboard com o session token vigente. */
async function proxyMutation(url, rawBody) {
  const token = await upstreamToken(url);
  const res = await fetch(`${UPSTREAM}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: rawBody,
  });
  if (res.status === 401) {
    // Dashboard reiniciou e girou o token — renova UMA vez e tenta de novo.
    tokenCache.delete(url);
    const fresh = await upstreamToken(url);
    const retry = await fetch(`${UPSTREAM}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fresh}` },
      body: rawBody,
    });
    return { status: retry.status, json: await retry.json().catch(() => null) };
  }
  return { status: res.status, json: await res.json().catch(() => null) };
}

function stringField(payload, key) {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (url.pathname === "/health") {
    if (!bearerMatches(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return sendJson(res, 200, { ok: true, ensemble: true });
  }

  const mutating = (req.method === "POST")
    && (url.pathname === "/api/emergency/pause-member" || url.pathname === "/api/emergency/pause-room");
  if (!mutating) return sendJson(res, 404, { ok: false, error: "Not Found" });

  if (!bearerMatches(req)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

  const body = await readBody(req);
  if (body.tooLarge) return sendJson(res, 413, { ok: false, code: "payload_too_large", error: "Payload Too Large", limit: MAX_BODY_BYTES });

  let payload;
  try {
    payload = JSON.parse(body.raw || "");
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return sendJson(res, 400, { ok: false, code: "invalid_json", error: "Invalid JSON body: expected an object" });
    }
  } catch {
    return sendJson(res, 400, { ok: false, code: "invalid_json", error: "Invalid JSON body" });
  }

  const teamId = stringField(payload, "teamId");
  if (url.pathname === "/api/emergency/pause-member") {
    const memberName = stringField(payload, "memberName");
    if (!teamId || !memberName) {
      return sendJson(res, 400, { ok: false, code: "missing_fields", error: "teamId and memberName are required" });
    }
  } else if (!teamId) {
    return sendJson(res, 400, { ok: false, code: "missing_team_id", error: "teamId is required" });
  }

  const trimmed = { ...payload, teamId };
  if (url.pathname === "/api/emergency/pause-member") trimmed.memberName = stringField(payload, "memberName");

  let upstream;
  try {
    upstream = await proxyMutation(url.pathname, JSON.stringify(trimmed));
  } catch {
    return sendJson(res, 502, { ok: false, code: "dashboard_unavailable", error: "Upstream dashboard unreachable" });
  }

  if (upstream.status >= 400) {
    return sendJson(res, upstream.status, {
      ok: false,
      upstreamStatus: upstream.status,
      error: upstream.json?.error ?? `Upstream HTTP ${upstream.status}`,
    });
  }
  return sendJson(res, 200, { ...(upstream.json ?? {}), proxiedAt: Date.now() });
});

server.listen(PORT, "127.0.0.1", () => {
  // Silencioso de propósito: a suíte sonda /health até responder.
});
