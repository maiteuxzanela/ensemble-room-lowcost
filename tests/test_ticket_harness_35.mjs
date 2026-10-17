#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-35
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - startDashboard / handleDashboardRequest -> src/dashboard.ts
 *     A4: isolamento de rede localhost — bind explícito em 127.0.0.1 e gate
 *         Host/Origin (isTrustedLocalRequest) no TOPO do handler, cobrindo
 *         TODAS as rotas (GET /, /api/health, /api/state e POST /api/chat/send).
 *     A5: chat web — roteamento ao lead (to='lead' / @lead) resolvido do team
 *         (lead_session_id/lead_agent), preservação de MODELO (getMemberModel) e
 *         de PERSONA (agent), consumo da janela de STANDBY (resolveStandbyWake
 *         prepende spawn_context) e marcação delivered=1 após transporte 2xx.
 *
 * Cobertura:
 *   (A4/bind)  o listener só aceita IPv4 loopback 127.0.0.1: conecta em
 *              127.0.0.1, RECUSA 127.0.0.2 (prova de bind específico, não
 *              0.0.0.0) e RECUSA ::1 (IPv4-only). Paridade src↔dist do literal
 *              server.listen(port, "127.0.0.1").
 *   (A4/gate)  Host forjado (evil.example.com:<port>) → 403 em /api/health,
 *              /api/state, / e POST /api/chat/send (sem persistir nada); porta
 *              errada → 403; Host ausente → 403; Origin não-loopback → 403;
 *              localhost:port / 127.0.0.1:port legítimos → 200.
 *   (a) lead   to='lead' e '@lead ...' resolvem de team, gravam to_name='lead',
 *              despacham promptAsync(lead_session_id, agent=lead_agent) e 200
 *              recipients=["lead"] (antes 404). lead_agent NULL → fallback "dante".
 *   (b/c)      preservação de model (variant separado do modelID) e agent.
 *   (d) standby execution_status='standby' + spawn_context → o texto entregue
 *              prepende o contexto e a execução vira 'starting'.
 *   (e)        markDelivered: DM, lead e broadcast ficam delivered=1 após o
 *              despacho; falha de transporte NÃO marca delivered (controls negativos).
 *   (mutação) 7 mutantes no bundle dist — cada um detectado pelas sentinelas do
 *              cenário-alvo e cirúrgico nos fluxos intactos.
 *   (paridade) literais das duas frentes presentes em src/ E dist/ + anti-mock.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um recorder
 * determinístico de promptAsync — mesmo padrão das demais suítes do repo. Nenhum
 * componente de produção é substituído: SQLite, bundle dist, HTTP real e o
 * listener de rede são reais. O cabeçalho Host malicioso é forjado com socket
 * HTTP/1.1 cru (o fetch do Node proíbe sobrescrever Host).
 *
 * Uso: node tests/test_ticket_harness_35.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h35");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
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
  writeFileSync(path.join(TMP, "_h35_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h35_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Helpers de transporte (reais, determinísticos).
// ---------------------------------------------------------------------------

/** Conecta no TCP e resolve true/false (sonda de bind, sem HTTP). */
function tcpProbe(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let done = false;
    const fin = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.on("connect", () => fin(true));
    sock.on("error", () => fin(false));
    setTimeout(() => fin(false), 1500);
  });
}

/** Decodifica um corpo HTTP/1.1 com Transfer-Encoding: chunked. */
function dechunk(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = Number.parseInt(body.slice(i, nl).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += body.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2; // pula o CRLF final do chunk
  }
  return out;
}

/** Requisição HTTP/1.1 crua via socket — permite forjar o cabeçalho Host. */
function rawRequest(port, { method = "GET", path: reqPath = "/", host, origin, body } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    let settled = false;
    const fin = (val) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* já fechado */ } resolve(val); } };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const head = [`${method} ${reqPath} HTTP/1.1`];
      if (host !== undefined) head.push(`Host: ${host}`);
      if (origin !== undefined) head.push(`Origin: ${origin}`);
      if (body !== undefined) {
        head.push("Content-Type: application/json");
        head.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      head.push("Connection: close");
      socket.write(head.join("\r\n") + "\r\n\r\n" + (body ?? ""));
    });
    socket.on("data", (d) => { raw += d; });
    socket.on("end", () => {
      const idx = raw.indexOf("\r\n\r\n");
      const headPart = idx >= 0 ? raw.slice(0, idx) : raw;
      let bodyPart = idx >= 0 ? raw.slice(idx + 4) : "";
      if (/transfer-encoding:\s*chunked/i.test(headPart)) bodyPart = dechunk(bodyPart);
      const status = Number((headPart.split("\r\n")[0] || "").split(" ")[1] ?? 0);
      let json = null;
      try { json = JSON.parse(bodyPart); } catch { /* html/plain */ }
      fin({ status, body: bodyPart, json });
    });
    socket.on("error", () => fin({ status: 0, body: "", json: null }));
    setTimeout(() => fin({ status: 0, body: "", json: null }), 4000);
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
// 2. RunFlow: TODOS os cenários A4/A5 contra um módulo harness dado. Cada
//    execução usa SQLite NOVO + servidor HTTP NOVO em scratch isolado. Nunca
//    lança: toda exceção vira resultado de check (necessário para mutação).
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, startDashboard } = mod;

  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-h35-${process.pid}-${flowSeq++}-`));
  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = createDb(path.join(base, "db", "ensemble.db"));

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  // Único seam (fronteira de transporte): recorder determinístico de promptAsync.
  // failSet permite injetar falha de transporte (control negativo de delivered).
  const calls = [];
  const failSet = new Set();
  const client = {
    session: {
      promptAsync: async (o) => {
        calls.push(o);
        if (failSet.has(o.sessionID)) throw new Error("transport boom");
        return {};
      },
    },
  };

  const now = Date.now();
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  const seedTeam = (id, name, lead, leadAgent) => {
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,?,'active',0,?,?)",
      [id, name, lead, leadAgent, now, now],
    );
  };
  const seedMember = (teamId, name, ses, agent, opts = {}) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, opts.exec ?? "idle", opts.model ?? null, opts.ctx ?? null, now, now],
    );
  };

  // t1: squad principal. t2: lead sem lead_agent. t3: control negativo.
  seedTeam("t1", "squad-h35", "ses_lead_t1", "dante");
  seedMember("t1", "cris", "ses_cris", "cris", { model: "google/antigravity-gemini-3.8-flash#low" });
  seedMember("t1", "tulio", "ses_tulio", "tulio", { exec: "standby", ctx: "SPAWNCTX-ROLE: você é o tulio" });
  seedMember("t1", "tales", "ses_tales", "build");

  seedTeam("t2", "squad-h35-nolead", "ses_lead_t2", null);
  seedMember("t2", "ana", "ses_ana", "ana");

  seedTeam("t3", "squad-h35-neg", "ses_lead_t3", "dante");
  seedMember("t3", "p1", "ses_p1", "build");
  seedMember("t3", "p2", "ses_p2", "build");

  const port = await getFreePort();
  let server = null;
  server = await startDashboard(db, port, { client });
  R("server.started", server !== null, `port=${port}`);

  const post = async (payload) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    } catch { return { status: 0, data: null }; }
  };

  // Guardas de id ausente: um mutante que faça a rota falhar devolve
  // messageId undefined; a consulta deve devolver null em vez de lançar
  // (necessário para a fase de mutação não abortar o fluxo inteiro).
  const isId = (id) => typeof id === "string" && id.length > 0;
  const rowById = (id, cols) => (isId(id) ? db.query(`SELECT ${cols} FROM team_message WHERE id = ?`).get(id) : null);
  const waitDelivered = async (id) => {
    if (!isId(id)) return false;
    for (let i = 0; i < 120; i++) {
      const row = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id);
      if (row && row.delivered === 1) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const deliveredOf = (id) => (isId(id) ? db.query("SELECT delivered FROM team_message WHERE id = ?").get(id)?.delivered : undefined);
  const countMessages = (teamId) => db.query("SELECT COUNT(*) c FROM team_message WHERE team_id = ?").get(teamId).c;
  const callFor = (ses) => calls.find((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";

  try {
    // ===================== (A4) BIND LOOPBACK ==============================
    if (server) {
      const loop = await tcpProbe(port, "127.0.0.1");
      R("bind.loopback-reachable", loop === true, `127.0.0.1:${port}=${loop}`);
      const alt = await tcpProbe(port, "127.0.0.2");
      R("bind.ipv4-only", alt === false, `127.0.0.2:${port}=${alt} (bind específico, não 0.0.0.0)`);
      const v6 = await tcpProbe(port, "::1");
      R("bind.no-ipv6", v6 === false, `[::1]:${port}=${v6} (IPv4-only)`);
    } else {
      R("bind.loopback-reachable", false, "server não iniciou");
      R("bind.ipv4-only", false, "server não iniciou");
      R("bind.no-ipv6", false, "server não iniciou");
    }

    // ===================== (A4) GATE HOST/ORIGIN ===========================
    // Host forjado em TODAS as rotas → 403 antes de qualquer processamento.
    let rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `evil.example.com:${port}` });
    R("gate.health-forged-403", rr.status === 403 && rr.json?.ok === false, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com:${port}` });
    R("gate.state-forged-403", rr.status === 403 && rr.json?.ok === false, `status=${rr.status}`);
    // O / devolve texto/html, não JSON: exige apenas o status 403.
    rr = await rawRequest(port, { method: "GET", path: "/", host: `evil.example.com:${port}` });
    R("gate.root-forged-403", rr.status === 403, `status=${rr.status}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `127.0.0.1:${port + 1}` });
    R("gate.health-wrong-port-403", rr.status === 403, `status=${rr.status}`);
    // Host ausente: o parser HTTP do próprio Node já responde 400 antes do handler.
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: undefined });
    R("gate.no-host-rejected", rr.status === 400 || rr.status === 403, `status=${rr.status} (400 do parser Node ou 403 do gate)`);

    // POST forjado não persiste nada.
    const beforeForged = countMessages("t1");
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: `evil.example.com:${port}`,
      body: JSON.stringify({ teamId: "t1", to: "cris", text: "invasão" }),
    });
    R("gate.chat-forged-403", rr.status === 403, `status=${rr.status}`);
    R("gate.chat-forged-not-persisted", countMessages("t1") === beforeForged, `before=${beforeForged} after=${countMessages("t1")}`);

    // Origin não-loopback com Host legítimo → 403.
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `localhost:${port}`, origin: "http://attacker.example" });
    R("gate.origin-mismatch-403", rr.status === 403, `status=${rr.status}`);

    // Clientes legítimos continuam atendidos.
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `localhost:${port}` });
    R("gate.health-legit-200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status} json=${JSON.stringify(rr.json)}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `127.0.0.1:${port}` });
    R("gate.state-legit-200", rr.status === 200 && rr.json !== null, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `localhost:${port}`, origin: `http://localhost:${port}` });
    R("gate.origin-loopback-200", rr.status === 200, `status=${rr.status}`);

    // ===================== (a) ROTEAMENTO AO LEAD ==========================
    calls.length = 0;
    let r = await post({ teamId: "t1", to: "lead", text: "coordenada-alpha" });
    R("lead.200", r.status === 200 && r.data?.ok === true && Array.isArray(r.data.recipients) && r.data.recipients.includes("lead"), `status=${r.status} data=${JSON.stringify(r.data)}`);
    let leadRow = rowById(r.data?.messageId, "from_name, to_name, content");
    R("lead.row-to-name", leadRow?.from_name === "human" && leadRow?.to_name === "lead" && leadRow?.content === "coordenada-alpha", JSON.stringify(leadRow));
    let lc = callFor("ses_lead_t1");
    R("lead.prompt-session-agent", !!lc && lc.agent === "dante" && lc.synthetic === true, `agent=${lc?.agent} synthetic=${lc?.synthetic}`);
    R("lead.prompt-text", textOf(lc).includes("coordenada-alpha"), textOf(lc));
    R("lead.delivered", (await waitDelivered(r.data?.messageId)) === true, `delivered=${deliveredOf(r.data?.messageId)}`);

    // Forma menção: "@lead ..." (sem campo to).
    calls.length = 0;
    r = await post({ teamId: "t1", text: "@lead item-mention" });
    R("lead.mention-200", r.status === 200 && r.data?.ok === true && r.data.recipients.includes("lead"), `status=${r.status} recipients=${JSON.stringify(r.data?.recipients)}`);
    leadRow = rowById(r.data?.messageId, "to_name, content");
    R("lead.mention-row", leadRow?.to_name === "lead" && leadRow?.content === "item-mention", JSON.stringify(leadRow));
    lc = callFor("ses_lead_t1");
    R("lead.mention-prompt", !!lc && lc.agent === "dante" && textOf(lc).includes("item-mention"), `agent=${lc?.agent}`);

    // lead_agent NULL → fallback "dante".
    calls.length = 0;
    r = await post({ teamId: "t2", to: "lead", text: "sem-agente" });
    lc = callFor("ses_lead_t2");
    R("lead.fallback-agent-dante", r.status === 200 && !!lc && lc.agent === "dante", `status=${r.status} agent=${lc?.agent}`);

    // ===================== (b/c) MODELO + PERSONA ==========================
    calls.length = 0;
    r = await post({ teamId: "t1", to: "cris", text: "modelo-preservado" });
    R("model.dm-200", r.status === 200 && r.data?.ok === true, `status=${r.status}`);
    let cc = callFor("ses_cris");
    R(
      "model.preserved",
      !!cc && cc.model?.providerID === "google" && cc.model?.modelID === "antigravity-gemini-3.8-flash",
      JSON.stringify(cc?.model),
    );
    R("model.variant-separate", cc?.model?.variant === "low" && !String(cc?.model?.modelID).includes("#"), JSON.stringify(cc?.model));
    R("agent.preserved", cc?.agent === "cris", `agent=${cc?.agent}`);
    R("model.row-delivered", (await waitDelivered(r.data?.messageId)) === true, `delivered=${deliveredOf(r.data?.messageId)}`);

    // ===================== (d) STANDBY WAKE ================================
    calls.length = 0;
    r = await post({ teamId: "t1", to: "tulio", text: "standby-wake" });
    R("standby.dm-200", r.status === 200 && r.data?.ok === true, `status=${r.status}`);
    const tc = callFor("ses_tulio");
    const TEXT_BASE = "[Direct message from human]: standby-wake";
    R(
      "standby.prepend-context",
      !!tc && textOf(tc).startsWith("SPAWNCTX-ROLE: você é o tulio"),
      JSON.stringify(textOf(tc).slice(0, 80)),
    );
    R(
      "standby.base-text-after-context",
      textOf(tc) === `SPAWNCTX-ROLE: você é o tulio\n\n${TEXT_BASE}`,
      JSON.stringify(textOf(tc)),
    );
    R("standby.agent", tc?.agent === "tulio", `agent=${tc?.agent}`);
    R(
      "standby.status-starting",
      db.query("SELECT execution_status FROM team_member WHERE team_id='t1' AND name='tulio'").get()?.execution_status === "starting",
      db.query("SELECT execution_status FROM team_member WHERE team_id='t1' AND name='tulio'").get()?.execution_status,
    );
    R("standby.delivered", (await waitDelivered(r.data?.messageId)) === true, `delivered=${deliveredOf(r.data?.messageId)}`);

    // ===================== (e) BROADCAST ===================================
    calls.length = 0;
    r = await post({ teamId: "t1", text: "broadcast-h35" });
    R("broadcast.200", r.status === 200 && r.data?.ok === true, `status=${r.status}`);
    const bRow = rowById(r.data?.messageId, "to_name, content");
    R("broadcast.shared-row", bRow?.to_name === null && bRow?.content === "broadcast-h35", JSON.stringify(bRow));
    const recSet = new Set(r.data?.recipients ?? []);
    R(
      "broadcast.recipients",
      ["cris", "tulio", "tales"].every((n) => recSet.has(n)),
      JSON.stringify(r.data?.recipients),
    );
    const bCris = calls.find((c) => c.sessionID === "ses_cris");
    R(
      "broadcast.model-preserved",
      !!bCris && bCris.model?.providerID === "google" && bCris.model?.modelID === "antigravity-gemini-3.8-flash",
      JSON.stringify(bCris?.model),
    );
    const bTales = calls.find((c) => c.sessionID === "ses_tales");
    R("broadcast.agent-preserved", bTales?.agent === "build", `agent=${bTales?.agent}`);
    R("broadcast.delivered", (await waitDelivered(r.data?.messageId)) === true, `delivered=${deliveredOf(r.data?.messageId)}`);

    // Broadcast com FALHA PARCIAL de transporte → linha fica NÃO delivered.
    failSet.add("ses_p2");
    calls.length = 0;
    r = await post({ teamId: "t3", text: "broadcast-falha-parcial" });
    await settle();
    R(
      "broadcast.partial-failure-not-delivered",
      r.status === 200 && deliveredOf(r.data?.messageId) === 0,
      `status=${r.status} delivered=${deliveredOf(r.data?.messageId)}`,
    );
    failSet.clear();

    // DM com falha de transporte → linha fica NÃO delivered.
    failSet.add("ses_p1");
    calls.length = 0;
    r = await post({ teamId: "t3", to: "p1", text: "dm-falha" });
    await settle();
    R(
      "dm.failure-not-delivered",
      r.status === 200 && deliveredOf(r.data?.messageId) === 0,
      `status=${r.status} delivered=${deliveredOf(r.data?.messageId)}`,
    );
    failSet.clear();
  } finally {
    try { server?.stop(true); } catch { /* já parado */ }
    try { db.close(); } catch { /* já fechado */ }
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  return got;
}

// ---------------------------------------------------------------------------
// 3. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 4. Paridade src↔dist (build compilou as duas frentes) + literais de defesa.
// ---------------------------------------------------------------------------
const srcDashboard = readFileSync(path.join(SRC, "dashboard.ts"), "utf8");

check(
  "paridade A4: gate isTrustedLocalRequest no topo do handler (src E dist)",
  srcDashboard.includes("if (!isTrustedLocalRequest(port, req)) {") &&
    distRaw.includes("if (!isTrustedLocalRequest(port, req)) {"),
);
check(
  "paridade A4: bind explícito em 127.0.0.1 (src E dist)",
  srcDashboard.includes('server.listen(port, "127.0.0.1"') &&
    distRaw.includes('server.listen(port, "127.0.0.1"'),
);
check(
  "paridade A5: rota ao lead resolve de team (src E dist)",
  srcDashboard.includes('} else if (to === "lead") {') && distRaw.includes('} else if (to === "lead") {') &&
    srcDashboard.includes("lead_session_id, lead_agent FROM team") && distRaw.includes("lead_session_id, lead_agent FROM team"),
);
check(
  "paridade A5: preservação de modelo e standby no DM (src E dist)",
  srcDashboard.includes("getMemberModel(db, teamId, to)") && distRaw.includes("getMemberModel(db, teamId, to)") &&
    srcDashboard.includes("resolveStandbyWake(db, teamId, to,") && distRaw.includes("resolveStandbyWake(db, teamId, to,"),
);
check(
  "paridade A5: markDelivered nos três caminhos (src E dist)",
  (srcDashboard.match(/markDelivered\(db, messageId\)/g) ?? []).length >= 3 &&
    (distRaw.match(/markDelivered\(db, messageId\)/g) ?? []).length >= 3,
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
  check(
    "anti-mock: suíte não contém marcadores proibidos",
    !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")),
  );
}

// ---------------------------------------------------------------------------
// 5. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução dos
//    mesmos cenários. Cada mutante FALHA nas sentinelas do alvo (sensibilidade)
//    e PERMANECE VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "gate Host/Origin global removido (todas as rotas passam a aceitar Host forjado)",
    from: "if (!isTrustedLocalRequest(port, req)) {",
    to: "if (false) {",
    detect: [
      "gate.health-forged-403", "gate.state-forged-403", "gate.root-forged-403",
      "gate.health-wrong-port-403", "gate.chat-forged-403",
      "gate.chat-forged-not-persisted", "gate.origin-mismatch-403",
    ],
    unaffected: [
      "gate.health-legit-200", "gate.state-legit-200", "gate.origin-loopback-200",
      "lead.200", "lead.delivered", "model.preserved", "standby.prepend-context", "broadcast.delivered",
    ],
  },
  {
    id: "M2",
    desc: "bind deixa de fixar 127.0.0.1 (listener dual-stack 0.0.0.0/::)",
    from: 'server.listen(port, "127.0.0.1", () => {',
    to: "server.listen(port, () => {",
    detect: ["bind.ipv4-only", "bind.no-ipv6"],
    unaffected: ["bind.loopback-reachable", "gate.health-legit-200", "lead.200", "model.preserved"],
  },
  {
    id: "M3",
    desc: "rota ao lead desabilitada (to='lead' volta a cair no lookup de membro → 404)",
    from: '} else if (to === "lead") {',
    to: "} else if (false) {",
    detect: [
      "lead.200", "lead.row-to-name", "lead.prompt-session-agent", "lead.prompt-text", "lead.delivered",
      "lead.mention-200", "lead.mention-row", "lead.mention-prompt", "lead.fallback-agent-dante",
    ],
    unaffected: ["model.preserved", "standby.prepend-context", "broadcast.delivered", "gate.health-forged-403"],
  },
  {
    id: "M4",
    desc: "preservação de modelo removida no DM (promptAsync sem model)",
    from: "const model = getMemberModel(db, teamId, to);",
    to: "const model = void 0;",
    detect: ["model.preserved", "model.variant-separate"],
    unaffected: ["agent.preserved", "lead.prompt-session-agent", "broadcast.model-preserved", "standby.prepend-context"],
  },
  {
    id: "M5",
    desc: "preservação de persona removida no DM (promptAsync sem agent)",
    from: "const agent = wake.agent ?? member.agent ?? void 0;",
    to: "const agent = void 0;",
    detect: ["agent.preserved", "standby.agent"],
    unaffected: ["model.preserved", "lead.prompt-session-agent", "broadcast.agent-preserved", "standby.prepend-context"],
  },
  {
    id: "M6",
    desc: "consumo da janela de standby removido (spawn_context não é prependido)",
    from: 'if (!row || row.execution_status !== "standby") {',
    to: "if (true) {",
    detect: ["standby.prepend-context", "standby.base-text-after-context", "standby.status-starting"],
    unaffected: ["standby.agent", "model.preserved", "broadcast.delivered", "lead.200"],
  },
  {
    id: "M7",
    desc: "markDelivered neutralizado (nenhuma mensagem é carimbada entregue)",
    from: 'function markDelivered(db, messageId) {\n  db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [messageId]);\n}',
    to: "function markDelivered(db, messageId) {\n}",
    detect: ["lead.delivered", "model.row-delivered", "standby.delivered", "broadcast.delivered"],
    unaffected: [
      "dm.failure-not-delivered",
      "model.preserved", "gate.health-forged-403",
    ],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h35_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, err?.stack ?? String(err));
    continue;
  }
  check(`${m.id}: mutante executável (fluxo roda por completo)`, mutatedFlow.size === realFlow.size, `checks=${mutatedFlow.size}/${realFlow.size}`);

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
    broken.length ? `quebrou: ${broken.join(", ")}` : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`,
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
