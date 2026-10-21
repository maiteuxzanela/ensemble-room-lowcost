#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-03 (dashboard CSRF / cross-origin)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * SDET: Hugo. Quality Gate: Clara.
 *
 * SEM MOCKS. Componentes reais exercitados:
 *   - dist/index.js REAL (bundle compilado) carregado como módulo ESM;
 *   - SQLite REAL via node:sqlite (createDb + migrations de produção);
 *   - servidor HTTP REAL em 127.0.0.1 (o mesmo startDashboard do runtime);
 *   - requisições HTTP/1.1 CRUAS via socket, porque o fetch do Node PROÍBE
 *     sobrescrever `Host` — é o único jeito de forjar DNS rebinding de verdade.
 *
 * Único seam (fronteira externa, padrão do repositório): o client SDK do
 * OpenCode reduzido a um recorder de `session.abort` / `session.promptAsync`.
 * Nenhuma decisão de produção é substituída.
 *
 * Cobertura do gate Host/Origin/Referer + session token:
 *   (A) Host: loopback desta porta (com/sem porta) aceito; host remoto, porta
 *       divergente, sufixo (`localhost.evil.com`), userinfo e path recusados
 *       com 403 ANTES de qualquer handler.
 *   (B) Origin: espelho loopback aceito; origem remota, esquema https, porta
 *       divergente e `null` não-JSON recusados; `null` + JSON aceito (curl).
 *   (C) Referer: fallback apenas quando Origin ausente; remoto/file:/data:
 *       recusados; Origin confiável tem precedência sobre Referer hostil.
 *   (D) Cabeçalhos de segurança (nosniff, no-referrer, no-store) em JSON,
 *       HTML e 403; Content-Type HTML com charset explícito.
 *   (E) Rotas de emergência herdam o gate e NÃO produzem efeito colateral
 *       (zero abort, zero escrita no SQLite) quando a origem é hostil.
 *   (F) Paridade src↔dist dos literais do gate + varredura anti-mock.
 *   (G) Prova de mutação M1..M7 no bundle dist: cada mutante derruba as
 *       sentinelas do seu alvo e preserva os fluxos legítimos intactos.
 *   (H) TICKET-RELEASE-08 — session token: endpoint /api/session-token (48
 *       hex, estável por servidor), 401 em mutação sem/ com token inválido
 *       sem efeito colateral, os três canais de aceitação (Bearer,
 *       x-ensemble-token, ?token=) com sucesso, reads sem token, token
 *       injetado no HTML do console, 401 sem vazar o token; mutação M8 prova
 *       a sensibilidade do gate.
 *
 * Uso: node tests/test_release_03_dashboard_csrf.mjs
 * Exit: 0 = todos os checks PASS; 1 = existe FAIL / rejection não tratada.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist", "index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "release03");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, !!ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: bundle REAL + exportação explícita dos símbolos sob teste.
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = ["createDb", "startDashboard"];
const distRaw = readFileSync(DIST, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "harness: dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
  writeFileSync(path.join(TMP, "_release03_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_release03_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Transporte HTTP real (socket cru: Host forjável).
// ---------------------------------------------------------------------------
/**
 * Dechunk HTTP/1.1 em BYTES (Buffer) — nunca em string decodificada.
 * O tamanho declarado do chunk é contagem de BYTES: com corpo UTF-8 multibyte
 * (acentos nas mensagens do sistema), dechunk em caracteres estoura o limite
 * do chunk e engole o terminador final (`0\r\n\r\n`), deixando o JSON.parse
 * com "non-whitespace character after JSON".
 */
function dechunk(buf) {
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = Number.parseInt(buf.subarray(i, nl).toString("latin1").trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(buf.subarray(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function parseHeaders(headPart) {
  const map = new Map();
  for (const line of headPart.split("\r\n").slice(1)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    map.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return map;
}

/**
 * Requisição HTTP/1.1 crua. `host: undefined` OMITE o cabeçalho Host (o parser
 * do Node responde 400 antes do handler — não é um caminho do nosso gate).
 * `headers` adiciona cabeçalhos extras (ex.: Authorization Bearer,
 * x-ensemble-token) — usado pelo TICKET-RELEASE-08.
 */
function rawRequest(port, {
  method = "GET",
  path: reqPath = "/",
  host,
  origin,
  referer,
  contentType,
  body,
  headers,
} = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let settled = false;
    const fin = (val) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* já fechado */ }
      resolve(val);
    };
    socket.on("connect", () => {
      const head = [`${method} ${reqPath} HTTP/1.1`];
      if (host !== undefined) head.push(`Host: ${host}`);
      if (origin !== undefined) head.push(`Origin: ${origin}`);
      if (referer !== undefined) head.push(`Referer: ${referer}`);
      for (const [name, value] of Object.entries(headers ?? {})) head.push(`${name}: ${value}`);
      if (body !== undefined) {
        if (contentType !== undefined) head.push(`Content-Type: ${contentType}`);
        head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      head.push("Connection: close");
      socket.write(head.join("\r\n") + "\r\n\r\n" + (body ?? ""));
    });
    // Bytes crus (sem setEncoding): cabeçalho e dechunk operam sobre o
    // comprimento em BYTES — só o corpo final é decodificado em UTF-8.
    const buffers = [];
    socket.on("data", (d) => { buffers.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
    socket.on("end", () => {
      const rawBuf = Buffer.concat(buffers);
      const rawStr = rawBuf.toString("latin1");
      const idx = rawStr.indexOf("\r\n\r\n");
      const headPart = idx >= 0 ? rawStr.slice(0, idx) : rawStr;
      let bodyBuf = idx >= 0 ? rawBuf.subarray(idx + 4) : Buffer.alloc(0);
      const headers = parseHeaders(headPart);
      const rawBodyHead = bodyBuf.subarray(0, 24).toString("latin1");
      const crlfCount = (rawStr.match(/\r\n/g) ?? []).length;
      if (/chunked/i.test(headers.get("transfer-encoding") ?? "")) bodyBuf = dechunk(bodyBuf);
      const bodyPart = bodyBuf.toString("utf8");
      const status = Number((headPart.split("\r\n")[0] || "").split(" ")[1] ?? 0);
      let json = null;
      let parseErr = null;
      try { json = JSON.parse(bodyPart); } catch (e) { parseErr = e?.message ?? String(e); }
      fin({
        status, body: bodyPart, json, headers, parseErr,
        rawTail: rawBuf.subarray(-50).toString("latin1"),
        rawHead: rawStr.slice(0, 80),
        rawBodyHead, crlfCount,
      });
    });
    socket.on("error", () => fin({ status: 0, body: "", json: null, headers: new Map() }));
    setTimeout(() => fin({ status: 0, body: "", json: null, headers: new Map() }), 5000);
  });
}

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 2. Flow: SQLite real + servidor real + recorder de transporte, por execução.
//    Nunca lança: exceção inesperada vira check (necessário para a mutação).
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, startDashboard } = mod;
  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-r03-${process.pid}-${flowSeq++}-`));
  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = createDb(path.join(base, "db", "ensemble.db"));

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  const aborts = [];
  const wakes = [];
  const client = {
    session: {
      abort: async ({ sessionID }) => { aborts.push(sessionID); return {}; },
      promptAsync: async (o) => { wakes.push(o); return {}; },
      messages: async () => ({ data: [] }),
      get: async () => ({ data: { id: "ses_hugo", title: "ses-hugo" } }),
    },
  };

  const now = Date.now();
  const port = await getFreePort();
  let server = null;
  try {
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING",
      [now, now],
    );
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES ('t1','squad-r03','default','ses_lead','dante','active',0,?,?)",
      [now, now],
    );
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES ('t1','hugo','ses_hugo','hugo','ready','idle',NULL,NULL,?,?,0)`,
      [now, now],
    );
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('t-live','t1','card vivo','in_progress','high','hugo',?,?)",
      [now, now],
    );

    server = await startDashboard(db, port, { client });
    R("server.started", server !== null, `port=${port}`);

    const localHost = `127.0.0.1:${port}`;
    const localOrigins = [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
    ];
    const countMessages = () => db.query("SELECT COUNT(*) c FROM team_message WHERE team_id = 't1'").get().c;
    const taskStatus = () => db.query("SELECT status FROM team_task WHERE id = 't-live'").get()?.status;
    const memberExec = () => db.query("SELECT execution_status FROM team_member WHERE team_id = 't1' AND name = 'hugo'").get()?.execution_status;
    const CHAT = JSON.stringify({ teamId: "t1", to: "hugo", text: "mensagem legitima" });
    const PAUSE_MEMBER = JSON.stringify({ teamId: "t1", memberName: "hugo" });
    const PAUSE_ROOM = JSON.stringify({ teamId: "t1" });

    // ---------------- (H) TICKET-RELEASE-08 — session token ----------------
    // O token é obtido pelo MESMO canal que o tooling local usa (leitura com
    // gate Host/Origin loopback) e nunca é presumido pelo teste.
    let rrToken = await rawRequest(port, { method: "GET", path: "/api/session-token", host: localHost });
    R("token.endpoint-200", rrToken.status === 200 && typeof rrToken.json?.token === "string", `status=${rrToken.status}`);
    const TOKEN = rrToken.json?.token ?? "";
    // 24 bytes via crypto.randomBytes(24).toString("hex") → 48 chars hex.
    R("token.entropy-192bit", /^[0-9a-f]{48}$/.test(TOKEN), `len=${TOKEN.length}`);
    rrToken = await rawRequest(port, { method: "GET", path: "/api/session-token", host: localHost });
    R("token.stable-per-server", rrToken.json?.token === TOKEN, "token muda entre chamadas ao mesmo servidor");

    // Leitura segue SEM token (contrato: gate Host/Origin basta para reads).
    let rr = await rawRequest(port, { method: "GET", path: "/api/health", host: localHost });
    R("token.read-health-without-token-200", rr.status === 200, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost });
    R("token.read-state-without-token-200", rr.status === 200 && rr.json?.version === 1, `status=${rr.status}`);

    // 401 em toda mutação sem token ou com token inválido — ANTES de efeito
    // colateral (nenhuma mensagem persistida, nenhum abort disparado).
    const beforeTokChat = countMessages();
    rr = await rawRequest(port, { method: "POST", path: "/api/chat/send", host: localHost, contentType: "application/json", body: CHAT });
    R("token.chat-missing-401", rr.status === 401 && rr.json?.ok === false && rr.json?.code === "unauthorized", `status=${rr.status} body=${rr.body}`);
    R("token.chat-missing-no-persist", countMessages() === beforeTokChat, `before=${beforeTokChat} after=${countMessages()}`);
    R("token.401-no-leak", !rr.body.includes(TOKEN), "a resposta 401 não pode vazar o token real");

    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost,
      headers: { Authorization: `Bearer deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbe` },
      contentType: "application/json", body: CHAT,
    });
    R("token.chat-invalid-401", rr.status === 401 && rr.json?.code === "unauthorized", `status=${rr.status}`);
    R("token.chat-invalid-no-persist", countMessages() === beforeTokChat, `before=${beforeTokChat} after=${countMessages()}`);

    const abortsBeforeTok = aborts.length;
    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-member", host: localHost,
      contentType: "application/json", body: PAUSE_MEMBER,
    });
    R("token.emergency-missing-401", rr.status === 401 && rr.json?.code === "unauthorized", `status=${rr.status}`);
    R("token.emergency-missing-no-abort", aborts.length === abortsBeforeTok && memberExec() === "idle", `aborts=${aborts.length} exec=${memberExec()}`);

    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-room", host: localHost,
      headers: { "x-ensemble-token": `00000000000000000000000000000000000000000000000${TOKEN.slice(0, -1)}` },
      contentType: "application/json", body: PAUSE_ROOM,
    });
    R("token.emergency-invalid-401", rr.status === 401 && rr.json?.code === "unauthorized", `status=${rr.status}`);
    R("token.emergency-invalid-no-abort", aborts.length === abortsBeforeTok && taskStatus() === "in_progress", `aborts=${aborts.length} task=${taskStatus()}`);

    // Os três canais de aceitação (Authorization Bearer, x-ensemble-token e
    // ?token=) devem autenticar a MESMA mutação com sucesso — um por canal.
    const beforeBearer = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost,
      headers: { Authorization: `Bearer ${TOKEN}` },
      contentType: "application/json", body: CHAT,
    });
    R("token.valid-bearer-200", rr.status === 200 && rr.json?.ok === true && countMessages() === beforeBearer + 1, `status=${rr.status}`);

    const beforeHeader = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost,
      headers: { "x-ensemble-token": TOKEN },
      contentType: "application/json", body: CHAT,
    });
    R("token.valid-header-200", rr.status === 200 && rr.json?.ok === true && countMessages() === beforeHeader + 1, `status=${rr.status}`);

    const beforeQuery = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: `/api/chat/send?token=${TOKEN}`, host: localHost,
      contentType: "application/json", body: CHAT,
    });
    R("token.valid-query-200", rr.status === 200 && countMessages() === beforeQuery + 1, `status=${rr.status}`);

    // O console HTML carrega o token injetado (window.__ENSEMBLE_TOKEN__) para
    // o script embutido autenticar o chat — e apenas para o cliente loopback.
    rr = await rawRequest(port, { method: "GET", path: "/", host: localHost });
    R(
      "token.html-injected",
      rr.status === 200 && rr.body.includes(`window.__ENSEMBLE_TOKEN__=${JSON.stringify(TOKEN)}`),
      `status=${rr.status} injecao=${rr.body.includes("window.__ENSEMBLE_TOKEN__")}`,
    );

    // ---------------- (A) Host gate: aceitos legítimos ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: localHost });
    R("host.ipv4-200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: "localhost" });
    R("host.localhost-bare-200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `[::1]:${port}` });
    R("host.ipv6-200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `localhost:${port}` });
    R("host.localhost-200", rr.status === 200, `status=${rr.status}`);

    // Cliente local direto (curl/TUI/SDK): sem Origin e sem Referer.
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost });
    R("state.no-origin-200", rr.status === 200 && rr.json?.version === 1, `status=${rr.status} ver=${rr.json?.version} len=${rr.body.length} err=${rr.parseErr ?? "-"} bodyHead=${JSON.stringify(rr.rawBodyHead ?? "")} crlfs=${rr.crlfCount} rawTail=${JSON.stringify(rr.rawTail ?? "")}`);

    // ---------------- (A) Host gate: recusados ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com:${port}` });
    R("host.evil-403", rr.status === 403 && rr.json?.ok === false, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `127.0.0.1:${port + 1}` });
    R("host.other-port-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `localhost.evil.example.com:${port}` });
    R("host.suffix-attack-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com@127.0.0.1:${port}` });
    R("host.userinfo-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `127.0.0.1:${port}/evil` });
    R("host.path-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `[::1]:${port + 1}` });
    R("host.ipv6-wrong-port-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com:${port}` });
    R(
      "host.forged-no-state-leak",
      rr.status === 403 && !JSON.stringify(rr.json ?? {}).includes("squad-r03"),
      `body=${JSON.stringify(rr.json)}`,
    );

    // ---------------- (B) Origin gate ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: "http://evil.example.com" });
    R("origin.remote-get-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: `http://127.0.0.1:${port + 1}` });
    R("origin.wrong-port-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: `http://127.0.0.1:${port}/` });
    R("origin.trailing-slash-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: `https://127.0.0.1:${port}` });
    R("origin.https-local-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: localOrigins[0] });
    R("origin.localhost-200", rr.status === 200 && rr.json?.version === 1, `status=${rr.status} ver=${rr.json?.version} len=${rr.body.length}`);
    R(
      "origin.cors-reflects-local",
      rr.headers.get("access-control-allow-origin") === localOrigins[0],
      `acao=${rr.headers.get("access-control-allow-origin")}`,
    );

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: localHost, origin: localOrigins[1] });
    R("origin.127-200", rr.status === 200, `status=${rr.status}`);

    // Origin remota nunca é refletida no CORS (nem no 403).
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: localHost, origin: "http://evil.example.com" });
    R(
      "origin.cors-never-wildcard",
      rr.status === 403 &&
        rr.headers.get("access-control-allow-origin") !== "*" &&
        !String(rr.headers.get("access-control-allow-origin")).includes("evil.example.com"),
      `acao=${rr.headers.get("access-control-allow-origin")}`,
    );

    // Origin: null — GET (leitura) aceito; mutação só com JSON.
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, origin: "null" });
    R("origin.null-get-200", rr.status === 200, `status=${rr.status}`);

    const beforeMessages = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost, origin: "null",
      headers: { "x-ensemble-token": TOKEN },
      contentType: "application/json", body: CHAT,
    });
    R("origin.null-json-post-200", rr.status === 200 && rr.json?.ok === true, `status=${rr.status}`);
    R("origin.null-json-post-persisted", countMessages() === beforeMessages + 1, `before=${beforeMessages} after=${countMessages()}`);

    const beforeText = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost, origin: "null",
      headers: { "x-ensemble-token": TOKEN },
      contentType: "text/plain", body: CHAT,
    });
    R("origin.null-text-plain-403", rr.status === 403, `status=${rr.status}`);
    R("origin.null-text-plain-no-persist", countMessages() === beforeText, `before=${beforeText} after=${countMessages()}`);

    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost, origin: "null",
      headers: { "x-ensemble-token": TOKEN },
      contentType: "application/x-www-form-urlencoded", body: CHAT,
    });
    R("origin.null-form-403", rr.status === 403, `status=${rr.status}`);

    const beforeSuffix = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost, origin: "null",
      headers: { "x-ensemble-token": TOKEN },
      contentType: "application/vnd.api+json", body: CHAT,
    });
    R("origin.null-json-suffix-200", rr.status === 200 && countMessages() === beforeSuffix + 1, `status=${rr.status}`);

    // ---------------- (C) Referer fallback ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, referer: "http://evil.example.com/page" });
    R("referer.remote-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, referer: "file:///tmp/page.html" });
    R("referer.file-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, referer: "data:text/html,<p>x" });
    R("referer.data-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost, referer: `http://localhost:${port}/dash` });
    R("referer.local-200", rr.status === 200, `status=${rr.status}`);

    rr = await rawRequest(port, {
      method: "GET", path: "/api/state", host: localHost,
      origin: localOrigins[0], referer: "http://evil.example.com/page",
    });
    R("referer.origin-precedence-200", rr.status === 200, `status=${rr.status}`);

    // ---------------- (E) Rotas de emergência herdam o gate ----------------
    // As requisições hostis carregam o token válido de PROPÓSITO: cada prova
    // de mutação isola UM gate (o outro permanece intacto), então remover o
    // gate de origem/host sem token seria mascarado pelo gate de token — e
    // vice-versa. Aqui (fluxo real) o gate de origem/host responde 403 ANTES
    // do token ser sequer olhado.
    const abortsBefore = aborts.length;
    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-member", host: localHost,
      origin: "http://evil.example.com",
      headers: { Authorization: `Bearer ${TOKEN}` },
      contentType: "application/json", body: PAUSE_MEMBER,
    });
    R("origin.remote-emergency-403", rr.status === 403, `status=${rr.status}`);
    R("origin.remote-emergency-no-abort", aborts.length === abortsBefore, `aborts=${aborts.length}`);

    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-room", host: `evil.example.com:${port}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
      contentType: "application/json", body: PAUSE_ROOM,
    });
    R("host.forged-emergency-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-room", host: localHost,
      referer: "http://evil.example.com/page",
      headers: { Authorization: `Bearer ${TOKEN}` },
      contentType: "application/json", body: PAUSE_ROOM,
    });
    R("referer.remote-emergency-403", rr.status === 403, `status=${rr.status}`);

    R("side-effects.zero-aborts-on-hostile", aborts.length === abortsBefore, `aborts=${aborts.length - abortsBefore}`);
    R("side-effects.task-still-in-progress", taskStatus() === "in_progress", `status=${taskStatus()}`);
    R("side-effects.member-still-idle", memberExec() === "idle", `exec=${memberExec()}`);

    // ---------------- (D) Cabeçalhos de segurança ----------------
    const hasHeaders = (hdrs) => ({
      nosniff: hdrs.get("x-content-type-options") === "nosniff",
      referrer: hdrs.get("referrer-policy") === "no-referrer",
      cache: hdrs.get("cache-control") === "no-store",
    });
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: localHost });
    let hh = hasHeaders(rr.headers);
    R("headers.health-nosniff", hh.nosniff, `xcto=${rr.headers.get("x-content-type-options")}`);
    R("headers.health-referrer", hh.referrer, `rp=${rr.headers.get("referrer-policy")}`);
    R("headers.health-cache", hh.cache, `cc=${rr.headers.get("cache-control")}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: localHost });
    hh = hasHeaders(rr.headers);
    R("headers.state", hh.nosniff && hh.referrer && hh.cache, JSON.stringify([...rr.headers]));

    rr = await rawRequest(port, { method: "GET", path: "/", host: localHost });
    hh = hasHeaders(rr.headers);
    R("root.200-html-charset", rr.status === 200 && /^text\/html;\s*charset=utf-8/i.test(rr.headers.get("content-type") ?? ""), `ct=${rr.headers.get("content-type")}`);
    R("headers.root", hh.nosniff && hh.referrer && hh.cache, JSON.stringify([...rr.headers]));

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com:${port}` });
    hh = hasHeaders(rr.headers);
    R("headers.forbidden", rr.status === 403 && hh.nosniff && hh.referrer && hh.cache, `status=${rr.status}`);

    // ---------------- (G) safeRequestUrl: alvo absoluto não sequestra o base ----------------
    rr = await rawRequest(port, { method: "GET", path: `http://127.0.0.1:${port}/api/health`, host: localHost });
    R(
      "url.absolute-form-200",
      rr.status === 200 && rr.json?.ensemble === true &&
        rr.headers.get("access-control-allow-origin") !== "http://evil.example.com",
      `status=${rr.status}`,
    );

    rr = await rawRequest(port, {
      method: "GET", path: `http://evil.example.com/api/health`, host: `evil.example.com:${port}`,
    });
    R("url.absolute-form-forged-host-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/nao-existe", host: localHost });
    R("gate.applies-to-404", rr.status === 404, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/nao-existe", host: `evil.example.com:${port}` });
    R("gate.forged-beats-404", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/session/ses_hugo/activity", host: `evil.example.com:${port}` });
    R("gate.forged-activity-403", rr.status === 403, `status=${rr.status}`);

    // ---------------- Legítimos NÃO são over-blocked ----------------
    // Cada mutação legítima usa um CANAL de token diferente (Bearer, header
    // x-ensemble-token, query ?token=) — os três canais ficam cobertos.
    const beforeChatLegit = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: localHost,
      headers: { Authorization: `Bearer ${TOKEN}` },
      contentType: "application/json", body: CHAT,
    });
    R("chat.legit-no-origin-200", rr.status === 200 && countMessages() === beforeChatLegit + 1, `status=${rr.status}`);

    const abortsBeforeLegit = aborts.length;
    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-member", host: localHost,
      origin: localOrigins[1],
      headers: { "x-ensemble-token": TOKEN },
      contentType: "application/json", body: PAUSE_MEMBER,
    });
    R("emergency.legit-member-200", rr.status === 200 && rr.json?.paused === "hugo", `status=${rr.status}`);
    R("emergency.legit-member-aborted", aborts.includes("ses_hugo") && aborts.length === abortsBeforeLegit + 1, `aborts=${aborts.length}`);

    rr = await rawRequest(port, {
      method: "POST", path: `/api/emergency/pause-room?token=${TOKEN}`, host: localHost,
      referer: `http://localhost:${port}/dash`, contentType: "application/json", body: PAUSE_ROOM,
    });
    R("emergency.legit-room-200", rr.status === 200 && Array.isArray(rr.json?.pausedMembers), `status=${rr.status}`);

    R("side-effects.legit-room-released-task", taskStatus() === "pending", `status=${taskStatus()}`);
  } catch (err) {
    console.error("FLOW ERROR:", (err && err.stack) || err);
    if (!got.size) R("flow.executed", false, String((err && err.message) || err));
  } finally {
    try { server?.stop(true); } catch { /* já parado */ }
    try { db.close(); } catch { /* já fechado */ }
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  return got;
}

// ---------------------------------------------------------------------------
// 3. Fase REAL: todos os cenários contra o dist autêntico, 100% verdes.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 4. Paridade src↔dist + varredura anti-mock.
// ---------------------------------------------------------------------------
const srcDashboard = readFileSync(path.join(SRC, "dashboard.ts"), "utf8");

const PARITY_LITERALS = [
  "DASHBOARD_SECURITY_HEADERS",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Cache-Control",
  "isTrustedLocalReferer",
  "isJsonContentType",
  "safeRequestUrl",
  "STATE_CHANGING_METHODS",
  'res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...DASHBOARD_SECURITY_HEADERS })',
  "if (!isTrustedLocalRequest(port, req)) {",
  // TICKET-RELEASE-08 — session token.
  "mintSessionToken",
  "extractSessionToken",
  "isSessionTokenValid",
  "MUTATING_ROUTES",
  "/api/session-token",
  "window.__ENSEMBLE_TOKEN__",
  "Unauthorized: valid session token required",
];
for (const literal of PARITY_LITERALS) {
  check(
    `paridade src↔dist: ${literal.slice(0, 48)}`,
    srcDashboard.includes(literal) && distRaw.includes(literal),
    `src=${srcDashboard.includes(literal)} dist=${distRaw.includes(literal)}`,
  );
}

check(
  "anti-as-any: src/dashboard.ts sem asserção 'as any'",
  !/\bas\s+any\b/.test(srcDashboard),
);

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
    }
  };
  walk(SRC);
  check("anti-mock: zero mocks em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
  check("anti-mock: suíte não contém marcadores proibidos", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")));
}

// ---------------------------------------------------------------------------
// 5. PROVA DE MUTAÇÃO no bundle dist. Cada mutante derruba EXATAMENTE as
//    sentinelas do alvo e mantém os fluxos legítimos intactos.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "Origin null aceito em mutação não-JSON (CSRF por formulário passa)",
    from: '    return !isStateChangingMethod(req.method) || isJsonContentType(req.headers["content-type"]);',
    to: "    return true;",
    detect: ["origin.null-text-plain-403", "origin.null-text-plain-no-persist", "origin.null-form-403"],
    unaffected: ["origin.null-json-post-200", "origin.null-get-200", "host.evil-403", "origin.localhost-200"],
  },
  {
    id: "M2",
    desc: "fallback de Referer desativado (Referer remoto passa a ser confiado)",
    from: "  if (referer !== void 0) return isTrustedLocalReferer(port, referer);",
    to: "  if (referer !== void 0) return true;",
    detect: ["referer.remote-403", "referer.file-403", "referer.data-403", "referer.remote-emergency-403"],
    unaffected: ["referer.local-200", "referer.origin-precedence-200", "host.evil-403"],
  },
  {
    id: "M3",
    desc: "gate de Origin removido (origem remota arbitrária passa)",
    from: "  if (origin !== void 0) return isTrustedLocalOrigin(port, origin, req);",
    to: "  if (origin !== void 0) return true;",
    detect: [
      "origin.remote-get-403", "origin.wrong-port-403", "origin.trailing-slash-403",
      "origin.https-local-403", "origin.remote-emergency-403", "origin.remote-emergency-no-abort",
    ],
    unaffected: ["origin.localhost-200", "origin.null-get-200", "state.no-origin-200", "host.evil-403"],
  },
  {
    id: "M4",
    desc: "X-Content-Type-Options degradado de nosniff",
    from: '  "X-Content-Type-Options": "nosniff",',
    to: '  "X-Content-Type-Options": "sniff",',
    detect: ["headers.health-nosniff", "headers.state", "headers.root", "headers.forbidden"],
    unaffected: ["headers.health-referrer", "headers.health-cache", "host.ipv4-200", "root.200-html-charset"],
  },
  {
    id: "M5",
    desc: "porta do Host deixa de ser comparada (proxy hop/DNS rebind em outra porta)",
    from: "  return Number(authority.port) === port;",
    to: "  return true;",
    detect: ["host.other-port-403", "host.ipv6-wrong-port-403"],
    unaffected: ["host.evil-403", "host.localhost-200", "host.localhost-bare-200", "host.ipv6-200"],
  },
  {
    id: "M6",
    desc: "authority malformada (userinfo/path) deixa de ser recusada",
    from: "  if (!authority) return false;",
    to: "  if (!authority) return true;",
    detect: ["host.userinfo-403", "host.path-403"],
    unaffected: ["host.evil-403", "host.suffix-attack-403", "host.ipv4-200"],
  },
  {
    id: "M7",
    desc: "gate Host/Origin/Referer global removed (todas as rotas abertas)",
    from: "  if (!isTrustedLocalRequest(port, req)) {",
    to: "  if (false) {",
    detect: [
      "host.evil-403", "host.forged-no-state-leak", "origin.remote-get-403",
      "referer.remote-403", "origin.remote-emergency-403", "origin.remote-emergency-no-abort",
      "host.forged-emergency-403", "referer.remote-emergency-403",
      "side-effects.zero-aborts-on-hostile", "side-effects.task-still-in-progress",
      "side-effects.member-still-idle",
    ],
    unaffected: ["host.ipv4-200", "root.200-html-charset", "origin.localhost-200", "chat.legit-no-origin-200", "emergency.legit-member-200"],
  },
  {
    id: "M8",
    desc: "gate do session token removido (mutação sem token passa a executar)",
    from: "if (isStateChangingMethod(req.method) && isMutatingRoute(url.pathname) && !isSessionTokenValid(extractSessionToken(req, url), sessionToken)) {",
    to: "if (false) {",
    detect: [
      "token.chat-missing-401", "token.chat-missing-no-persist",
      "token.chat-invalid-401", "token.chat-invalid-no-persist",
      "token.emergency-missing-401", "token.emergency-missing-no-abort",
      "token.emergency-invalid-401", "token.emergency-invalid-no-abort",
    ],
    unaffected: [
      "token.endpoint-200", "token.entropy-192bit", "token.read-health-without-token-200",
      "host.ipv4-200", "state.no-origin-200", "token.html-injected", "origin.localhost-200",
    ],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_release03_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, (err && err.stack) || String(err));
    continue;
  }
  check(
    `${m.id}: mutante executável (fluxo roda por completo)`,
    mutatedFlow.size === realFlow.size,
    `checks=${mutatedFlow.size}/${realFlow.size}`,
  );

  const missed = m.detect.filter((n) => mutatedFlow.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutatedFlow.get(n)?.ok !== true);
  check(
    `${m.id}: mutação cirúrgica — fluxos intactos preservados`,
    broken.length === 0,
    broken.length
      ? `quebrou: ${broken.map((n) => `${n}(${mutatedFlow.get(n)?.detail || "sem detalhe"})`).join(", ")}`
      : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`,
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
