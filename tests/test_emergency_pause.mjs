#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-56
 * @maiteuxzanela/ensemble-room-lowcost (plugin) + extensions/ensemble-dashboard
 *
 * SDET: Hugo. Quality Gate: Clara.
 *
 * SEM MOCKS. Componentes reais exercitados:
 *   - dist/index.js REAL (bundle compilado) + SQLite REAL via node:sqlite;
 *   - servidor HTTP real em 127.0.0.1 com o gate anti-DNS-rebinding real;
 *   - guest service REAL da extensão (subprocesso `node service/main.js`)
 *     falando com o dashboard REAL do plugin por HTTP (fim a fim).
 * Único seam (fronteira externa): o client SDK do OpenCode, reduzido a um
 * recorder determinístico de `session.abort` / `session.promptAsync` — o mesmo
 * padrão das demais suítes do repositório. Nenhum componente de produção é
 * substituído.
 *
 * Cobertura:
 *   A) Plugin (TICKET-HARNESS-56-A)
 *      - POST /api/emergency/pause-member: gate Host (DNS rebinding 403 sem
 *        efeito colateral), 400 invalid_json/missing_fields, 404 team/member,
 *        409 member terminal, 413 >16 KiB, campos trimmed, abort de sessão,
 *        limpeza de inflight (signal abortado + entrada removida) e SQLite
 *        ready/standby.
 *      - POST /api/emergency/pause-room: abort PARALELO de todos os membros
 *        ativos (máximo de concorrência >= 2), skip de shutdown/error e de
 *        sessão vazia, tarefas in_progress -> pending (completed/blocked
 *        intactas), ready/standby no SQLite, mensagem de sistema persistida e
 *        wake forçado ao Lead mesmo com silentLead:true.
 *   B) Contrato do proxy da extensão (TICKET-HARNESS-56-B)
 *      N/A explícito quando a extensão não está neste repositório (pré-merge):
 *      resolução portável apenas via ENSEMBLE_EXTENSION_DIR ou
 *      <repo>/extensions/ensemble-dashboard — nenhum caminho absoluto de host
 *      (SDET reject do TICKET-RELEASE-01).
 *      - Bearer gate global (401), validação local (400/400 missing_team_id),
 *        relay verbatim de 404/409, 413 no teto de 16 KiB, 200 com trim e
 *        atualização real do SQLite via upstream, 502 honesto com dashboard
 *        indisponível.
 *   C) Paridade src↔dist dos literais das rotas + thread do config + anti-mock.
 *   D) Prova de mutação: 11 mutantes cirúrgicos no bundle dist.
 *
 * Uso: node tests/test_emergency_pause.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL / rejeição não tratada.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC_DASHBOARD = path.join(REPO, "src", "dashboard.ts");
const SRC_INDEX = path.join(REPO, "src", "index.ts");
const SRC_V2 = path.join(REPO, "src", "v2-setup.ts");
const TMP = path.join(REPO, ".test-scratch", "h56");
mkdirSync(TMP, { recursive: true });

/**
 * Guest service da extensão (frente B). Resolução DETERMINÍSTICA e portável
 * (SDET reject do TICKET-RELEASE-01): zero caminho absoluto de host.
 *   1. ENSEMBLE_EXTENSION_DIR — override explícito (checkout canônico da
 *      extensão, que ainda vive fora deste repositório, pré-merge);
 *   2. <repo>/extensions/ensemble-dashboard — local futuro pós-merge.
 * Se NENHUM candidato existir no ambiente, a frente B é reportada como N/A
 * explícito (SKIP, nunca PASS falso e nunca FAIL): o runner limpo do CI não
 * depende de caminho do host, e quem tiver a extensão pode optar pelo
 * ENSEMBLE_EXTENSION_DIR para exercitar a frente B de ponta a ponta.
 */
const EXT_CANDIDATES = [
  process.env.ENSEMBLE_EXTENSION_DIR,
  path.join(REPO, "extensions", "ensemble-dashboard"),
].filter(Boolean);
const EXT_DIR = EXT_CANDIDATES.find((dir) => {
  try { return readFileSync(path.join(dir, "service", "main.js"), "utf8").includes("/api/emergency/pause-member"); } catch { return false; }
}) || EXT_CANDIDATES[0];
const EXT_SERVICE = path.join(EXT_DIR, "service", "main.js");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exports exigidos (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = ["createDb", "startDashboard", "trackPrompt", "abortInflight"];
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
  writeFileSync(path.join(TMP, "_h56_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h56_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Transporte HTTP real.
// ---------------------------------------------------------------------------
function dechunk(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const nl = body.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = Number.parseInt(body.slice(i, nl).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out += body.slice(nl + 2, nl + 2 + size);
    i = nl + 2 + size + 2;
  }
  return out;
}

/** Requisição HTTP/1.1 crua via socket — permite forjar o cabeçalho Host. */
function rawRequest(port, { method = "GET", path: reqPath = "/", host, body } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    let settled = false;
    const fin = (val) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* já fechado */ } resolve(val); } };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const head = [`${method} ${reqPath} HTTP/1.1`];
      if (host !== undefined) head.push(`Host: ${host}`);
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
    setTimeout(() => fin({ status: 0, body: "", json: null }), 5000);
  });
}

async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  try {
    const res = await fetch(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* texto puro */ }
    return { status: res.status, json, text };
  } catch {
    return { status: 0, json: null, text: "" };
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 2. Flow do plugin: um SQLite NOVO + servidor NOVO + recorder NOVO por run.
//    Nunca lança: toda exceção vira check (necessário para a mutação).
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, startDashboard, trackPrompt, abortInflight } = mod;

  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-h56-${process.pid}-${flowSeq++}-`));
  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = createDb(path.join(base, "db", "ensemble.db"));

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  // Seam determinístico (fronteira SDK). Mede concorrência real dos aborts.
  const aborts = [];
  const wakes = [];
  let activeAborts = 0;
  let maxConcurrentAborts = 0;
  const client = {
    session: {
      abort: async ({ sessionID }) => {
        aborts.push(sessionID);
        activeAborts += 1;
        maxConcurrentAborts = Math.max(maxConcurrentAborts, activeAborts);
        await sleep(12);
        activeAborts -= 1;
        return {};
      },
      promptAsync: async (o) => { wakes.push(o); return {}; },
    },
  };

  const now = Date.now();
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  const seedTeam = (id, lead, leadAgent) => {
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,?,'active',0,?,?)",
      [id, `team-${id}`, lead, leadAgent, now, now],
    );
  };
  const seedMember = (teamId, name, ses, status, exec) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?,?,?,?,?,0)`,
      [teamId, name, ses, name, status, exec, now, now],
    );
  };
  const seedTask = (id, teamId, status, assignee) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,'medium',?,?,?)",
      [id, teamId, `task ${id}`, status, assignee, now, now],
    );
  };

  // t1 — pausa individual. t2 — pausa de sala. t3 — pausa de sala forjada.
  seedTeam("t1", "ses_lead_t1", "dante");
  seedMember("t1", "cris", "ses_cris", "busy", "running");
  seedMember("t1", "ana", "ses_ana", "busy", "starting");
  seedMember("t1", "zed", "ses_zed", "shutdown", "completed");

  seedTeam("t2", "ses_lead_t2", "dante");
  seedMember("t2", "alice", "ses_alice", "busy", "running");
  seedMember("t2", "bob", "ses_bob", "busy", "running");
  seedMember("t2", "zed2", "ses_zed2", "shutdown", "completed");
  seedMember("t2", "ghost", "", "ready", "idle");
  seedTask("tk1", "t2", "in_progress", "alice");
  seedTask("tk2", "t2", "in_progress", "bob");
  seedTask("tk3", "t2", "pending", "alice");
  seedTask("tk4", "t2", "completed", "alice");
  seedTask("tk5", "t2", "in_review", "alice");

  seedTeam("t3", "ses_lead_t3", "dante");
  seedMember("t3", "carol", "ses_carol", "busy", "running");

  const port = await getFreePort();
  let server = null;
  try {
    server = await startDashboard(db, port, {
      client,
      // silentLead:true é o default de produto — a pausa de sala PRECISA furar.
      config: { silentLead: true, fallbackModels: [], fallbackModelsByAgent: {} },
    });
  } catch { server = null; }
  R("server.started", server !== null, `port=${port}`);

  const post = (route, payload) => rawJsonPost(port, route, payload);
  const memberRow = (teamId, name) => db.query("SELECT status, execution_status, time_updated FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
  const taskRow = (id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
  const leadMessages = (teamId) => db.query("SELECT from_name, to_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead'").all(teamId);
  const wakeFor = (ses) => wakes.find((w) => w.sessionID === ses);

  try {
    // =================== A1. PAUSA INDIVIDUAL — GUARDAS ====================
    let rr = await rawRequest(port, {
      method: "POST",
      path: "/api/emergency/pause-member",
      host: `evil.example.com:${port}`,
      body: JSON.stringify({ teamId: "t1", memberName: "cris" }),
    });
    R("member.forged-host-403", rr.status === 403, `status=${rr.status}`);
    R(
      "member.forged-host-no-side-effect",
      memberRow("t1", "cris")?.status === "busy" && aborts.length === 0,
      `status=${memberRow("t1", "cris")?.status} aborts=${aborts.join(",") || "-"}`,
    );

    let r = await post("/api/emergency/pause-member", "{");
    R("member.invalid-json-400", r.status === 400 && r.json?.code === "invalid_json", `status=${r.status} body=${r.text}`);
    r = await post("/api/emergency/pause-member", "[]");
    R("member.non-object-400", r.status === 400 && r.json?.code === "invalid_json", `status=${r.status} body=${r.text}`);
    r = await post("/api/emergency/pause-member", "{}");
    R("member.missing-fields-400", r.status === 400 && r.json?.code === "missing_fields", `status=${r.status} body=${r.text}`);
    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: "t1" }));
    R("member.missing-member-400", r.status === 400 && r.json?.code === "missing_fields", `status=${r.status}`);

    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: "nope", memberName: "cris" }));
    R("member.unknown-team-404", r.status === 404 && r.json?.code === "team_not_found", `status=${r.status} body=${r.text}`);
    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: "t1", memberName: "nobody" }));
    R("member.unknown-member-404", r.status === 404 && r.json?.code === "member_not_found", `status=${r.status} body=${r.text}`);

    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: "t1", memberName: "zed" }));
    R(
      "member.terminal-409",
      r.status === 409 && r.json?.code === "member_not_active" && !aborts.includes("ses_zed"),
      `status=${r.status} body=${r.text}`,
    );
    R("member.terminal-untouched", memberRow("t1", "zed")?.status === "shutdown", memberRow("t1", "zed")?.status);

    const huge = JSON.stringify({ teamId: "t1", memberName: "cris", pad: "x".repeat(17 * 1024) });
    rr = await rawRequest(port, {
      method: "POST", path: "/api/emergency/pause-member", host: `127.0.0.1:${port}`, body: huge,
    });
    R(
      "member.body-413",
      rr.status === 413 && rr.json?.code === "payload_too_large" && memberRow("t1", "cris")?.status === "busy",
      `status=${rr.status} code=${rr.json?.code}`,
    );

    // =================== A2. PAUSA INDIVIDUAL — SUCESSO ====================
    const ctrlCris = trackPrompt("ses_cris");
    const beforeCris = memberRow("t1", "cris")?.time_updated ?? 0;
    // Campos com espaços provam o trim local (sem alterar o nome persistido).
    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: "  t1  ", memberName: "  cris  " }));
    R(
      "member.200",
      r.status === 200 && r.json?.ok === true && r.json?.paused === "cris" && r.json?.teamId === "t1",
      `status=${r.status} body=${r.text}`,
    );
    R("member.abort-called", aborts.filter((s) => s === "ses_cris").length === 1, `aborts=${aborts.join(",") || "-"}`);
    R("member.inflight-aborted", ctrlCris.signal.aborted === true, `aborted=${ctrlCris.signal.aborted}`);
    R("member.inflight-cleared", abortInflight("ses_cris") === false, "segunda limpeza deve ser no-op");
    const crisAfter = memberRow("t1", "cris");
    R(
      "member.db-standby",
      crisAfter?.status === "ready" && crisAfter?.execution_status === "standby" && crisAfter.time_updated >= beforeCris,
      JSON.stringify(crisAfter),
    );

    // Segundo membro: trim sem caminho de abort (regressão de stringField).
    const ctrlAna = trackPrompt("ses_ana");
    r = await post("/api/emergency/pause-member", JSON.stringify({ teamId: " t1 ", memberName: " ana " }));
    R(
      "member.trimmed",
      r.status === 200 && r.json?.paused === "ana" && memberRow("t1", "ana")?.execution_status === "standby",
      `status=${r.status} row=${JSON.stringify(memberRow("t1", "ana"))}`,
    );
    R("member.inflight-aborted-second", ctrlAna.signal.aborted === true, `aborted=${ctrlAna.signal.aborted}`);

    // =================== B1. PAUSA DE SALA — GUARDAS =======================
    rr = await rawRequest(port, {
      method: "POST",
      path: "/api/emergency/pause-room",
      host: `evil.example.com:${port}`,
      body: JSON.stringify({ teamId: "t3" }),
    });
    R("room.forged-host-403", rr.status === 403, `status=${rr.status}`);
    R(
      "room.forged-host-no-side-effect",
      memberRow("t3", "carol")?.status === "busy" && !aborts.includes("ses_carol"),
      `status=${memberRow("t3", "carol")?.status}`,
    );

    r = await post("/api/emergency/pause-room", "{}");
    R("room.missing-teamid-400", r.status === 400 && r.json?.code === "missing_team_id", `status=${r.status} body=${r.text}`);
    r = await post("/api/emergency/pause-room", "not-json");
    R("room.invalid-json-400", r.status === 400 && r.json?.code === "invalid_json", `status=${r.status}`);
    r = await post("/api/emergency/pause-room", JSON.stringify({ teamId: "nope" }));
    R("room.unknown-team-404", r.status === 404, `status=${r.status} body=${r.text}`);

    // =================== B2. PAUSA DE SALA — SUCESSO =======================
    aborts.length = 0;
    maxConcurrentAborts = 0;
    wakes.length = 0;
    const ctrlAlice = trackPrompt("ses_alice");
    const ctrlBob = trackPrompt("ses_bob");
    r = await post("/api/emergency/pause-room", JSON.stringify({ teamId: " t2 " }));
    const paused = Array.isArray(r.json?.pausedMembers) ? [...r.json.pausedMembers].sort() : [];
    R(
      "room.200",
      r.status === 200 && r.json?.ok === true && r.json?.teamId === "t2" && paused.join(",") === "alice,bob",
      `status=${r.status} body=${r.text}`,
    );
    R(
      "room.aborts-active-only",
      aborts.filter((s) => s === "ses_alice").length === 1
        && aborts.filter((s) => s === "ses_bob").length === 1
        && !aborts.includes("ses_zed2")
        && !aborts.includes(""),
      `aborts=${aborts.join(",") || "-"}`,
    );
    R("room.parallel", maxConcurrentAborts >= 2, `maxConcurrent=${maxConcurrentAborts}`);
    R(
      "room.inflight-cleared",
      ctrlAlice.signal.aborted === true && ctrlBob.signal.aborted === true
        && abortInflight("ses_alice") === false && abortInflight("ses_bob") === false,
      `alice=${ctrlAlice.signal.aborted} bob=${ctrlBob.signal.aborted}`,
    );
    const aliceAfter = memberRow("t2", "alice");
    const bobAfter = memberRow("t2", "bob");
    R(
      "room.db-standby",
      aliceAfter?.status === "ready" && aliceAfter?.execution_status === "standby"
        && bobAfter?.status === "ready" && bobAfter?.execution_status === "standby"
        && memberRow("t2", "zed2")?.status === "shutdown",
      JSON.stringify({ alice: aliceAfter, bob: bobAfter, zed2: memberRow("t2", "zed2") }),
    );
    R(
      "room.tasks-reverted",
      taskRow("tk1") === "pending" && taskRow("tk2") === "pending"
        && taskRow("tk3") === "pending" && taskRow("tk4") === "completed" && taskRow("tk5") === "in_review",
      JSON.stringify({ tk1: taskRow("tk1"), tk2: taskRow("tk2"), tk3: taskRow("tk3"), tk4: taskRow("tk4"), tk5: taskRow("tk5") }),
    );
    const systemRows = leadMessages("t2").filter((m) => m.from_name === "system");
    R(
      "room.system-message",
      systemRows.length === 1 && /pausada/i.test(systemRows[0].content) && /emerg/i.test(systemRows[0].content),
      JSON.stringify(systemRows),
    );
    // Wake forçado: config.silentLead === true NÃO pode engolir a emergência.
    let wake = wakeFor("ses_lead_t2");
    for (let i = 0; i < 50 && !wake; i += 1) { await sleep(10); wake = wakeFor("ses_lead_t2"); }
    R(
      "room.wake-forced",
      !!wake && wake.agent === "dante" && wake.parts?.[0]?.text === "[System: New team message from system]",
      JSON.stringify(wake ?? null),
    );
  } catch (err) {
    R("flow.executed", false, err?.stack ?? String(err));
  } finally {
    try { server?.stop(true); } catch { /* já parado */ }
  }
  return got;
}

/** POST JSON real com Host legítimo (fetch põe 127.0.0.1:port). */
async function rawJsonPost(port, route, body) {
  return fetchJson(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

// ---------------------------------------------------------------------------
// 3. Flow principal (real).
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(name, ok, detail);

// ---------------------------------------------------------------------------
// 4. Prova de mutação: patch cirúrgico no bundle dist + reexecução do flow.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "gate Host/Origin global removido (rotas de emergência aceitam Host forjado)",
    from: "if (!isTrustedLocalRequest(port, req)) {",
    to: "if (false) {",
    detect: ["member.forged-host-403", "member.forged-host-no-side-effect", "room.forged-host-403", "room.forged-host-no-side-effect"],
    unaffected: ["room.200", "room.tasks-reverted", "member.terminal-409"],
  },
  {
    id: "M2",
    desc: "guarda de membro terminal removida (shutdown/error volta a ser 'pausável')",
    from: 'if (member.status === "shutdown" || member.status === "error") {\n    sendJson(res, { ok: false, code: "member_not_active"',
    to: 'if (false) {\n    sendJson(res, { ok: false, code: "member_not_active"',
    detect: ["member.terminal-409", "member.terminal-untouched"],
    unaffected: ["member.200", "member.trimmed", "room.200"],
  },
  {
    id: "M3",
    desc: "abort de sessão individual removido",
    from: "if (options?.client && member.session_id) {",
    to: "if (false) {",
    detect: ["member.abort-called"],
    unaffected: ["member.200", "member.db-standby", "room.200"],
  },
  {
    id: "M4",
    desc: "limpeza de inflight removida na pausa individual",
    from: 'const inflightCleared = member.session_id ? abortInflight(member.session_id) : false;',
    to: "const inflightCleared = false;",
    detect: ["member.inflight-aborted", "member.inflight-cleared"],
    unaffected: ["member.abort-called", "member.200", "room.200"],
  },
  {
    id: "M5",
    desc: "UPDATE de standby removido na pausa individual",
    from: '"UPDATE team_member SET status = \'ready\', execution_status = \'standby\', time_updated = ? WHERE team_id = ? AND name = ?"',
    to: '"UPDATE team_member SET time_updated = ? WHERE team_id = ? AND name = ?"',
    detect: ["member.db-standby"],
    unaffected: ["member.200", "member.abort-called"],
  },
  {
    id: "M6",
    desc: "fan-out paralelo trocado por loop sequencial (maxConcurrent < 2)",
    from: "  await Promise.allSettled(members.map(async (member) => {\n    abortInflight(member.session_id);\n    if (!options?.client) return;\n    try {\n      await options.client.session.abort({ sessionID: member.session_id });\n    } catch (err) {\n      log(`dashboard:emergency:pause-room:abort-failed team=${teamId} member=${member.name} err=${err instanceof Error ? err.message : String(err)}`);\n    }\n  }));",
    to: "  for (const member of members) {\n    abortInflight(member.session_id);\n    if (!options?.client) continue;\n    try {\n      await options.client.session.abort({ sessionID: member.session_id });\n    } catch (err) {\n      log(`dashboard:emergency:pause-room:abort-failed team=${teamId} member=${member.name} err=${err instanceof Error ? err.message : String(err)}`);\n    }\n  }",
    detect: ["room.parallel"],
    unaffected: ["room.aborts-active-only", "room.tasks-reverted", "room.200"],
  },
  {
    id: "M7",
    desc: "reversão de tarefas in_progress -> pending removida",
    from: '"UPDATE team_task SET status = \'pending\', time_updated = ? WHERE team_id = ? AND status = \'in_progress\'",\n      now,\n      teamId\n    );\n  });\n  pauseRoom();',
    to: '"UPDATE team_task SET time_updated = ? WHERE team_id = ? AND status = \'in_progress\'",\n      now,\n      teamId\n    );\n  });\n  pauseRoom();',
    detect: ["room.tasks-reverted"],
    unaffected: ["room.db-standby", "room.parallel", "room.200"],
  },
  {
    id: "M8",
    desc: "forceWake removido (silentLead:true engole o wake da emergência)",
    from: "          ...options.config ? { config: options.config } : {},\n          forceWake: true",
    to: "          ...options.config ? { config: options.config } : {},\n          forceWake: false",
    detect: ["room.wake-forced"],
    unaffected: ["room.system-message", "room.200", "member.200"],
  },
  {
    id: "M9",
    desc: "UPDATE de standby removido na pausa de sala",
    from: '"UPDATE team_member SET status = \'ready\', execution_status = \'standby\', time_updated = ? WHERE team_id = ? AND status NOT IN (\'shutdown\', \'error\')"',
    to: '"UPDATE team_member SET time_updated = ? WHERE team_id = ? AND status NOT IN (\'shutdown\', \'error\')"',
    detect: ["room.db-standby"],
    unaffected: ["room.tasks-reverted", "room.200"],
  },
  {
    id: "M10",
    desc: "trim dos campos removido (payload com espaços deixa de resolver)",
    from: 'return typeof value === "string" ? value.trim() : "";',
    to: 'return typeof value === "string" ? value : "";',
    detect: ["member.trimmed"],
    unaffected: ["member.terminal-409", "member.body-413"],
  },
  {
    id: "M11",
    desc: "teto de 16 KiB removido (payload gigante aceito)",
    from: "var MAX_EMERGENCY_BODY_BYTES = 16 * 1024;",
    to: "var MAX_EMERGENCY_BODY_BYTES = Number.MAX_SAFE_INTEGER;",
    detect: ["member.body-413"],
    unaffected: ["member.200", "room.200"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h56_${m.id.toLowerCase()}.mjs`);
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
// 5. Contrato do proxy da extensão (B): guest REAL <-> dashboard REAL.
// ---------------------------------------------------------------------------
async function runExtensionContract() {
  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  const serviceExists = (() => {
    try { return readFileSync(EXT_SERVICE, "utf8").length > 0; } catch { return false; }
  })();
  if (!serviceExists) {
    // N/A explícito (nunca PASS falso, nunca FAIL): a extensão ainda não está
    // neste repositório e nenhum caminho absoluto de host é aceito aqui.
    return {
      available: false,
      reason: `service/main.js não encontrado em ${EXT_SERVICE} — exporte ENSEMBLE_EXTENSION_DIR ou traga a extensão para extensions/ensemble-dashboard`,
    };
  }
  R("ext.service.present", serviceExists, EXT_SERVICE);

  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-h56-ext-${process.pid}-`));
  mkdirSync(path.join(base, "db"), { recursive: true });
  const dbPath = path.join(base, "db", "ensemble.db");
  const db = REAL.createDb(dbPath);

  const aborts = [];
  const client = {
    session: {
      abort: async ({ sessionID }) => { aborts.push(sessionID); return {}; },
      promptAsync: async () => ({}),
    },
  };
  const now = Date.now();
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES ('ext','ext','default','ses_lead_ext','dante','active',0,?,?)",
    [now, now],
  );
  const seed = (name, ses, status, exec) => db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, reported_to_lead) VALUES ('ext',?,?,?,?,?,?,?,0)",
    [name, ses, name, status, exec, now, now],
  );
  seed("cris", "ses_ext_cris", "busy", "running");
  seed("bob", "ses_ext_bob", "busy", "running");
  seed("zed", "ses_ext_zed", "shutdown", "completed");
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('tkx','ext','task tkx','in_progress','medium','cris',?,?)",
    [now, now],
  );

  const pluginPort = await getFreePort();
  const guestPort = await getFreePort();
  const TOKEN = "h56-contract-token";
  let dashboard = null;
  let guest = null;
  const guestOut = [];
  const memberRow = (name) => db.query("SELECT status, execution_status FROM team_member WHERE team_id = 'ext' AND name = ?").get(name);

  try {
    dashboard = await REAL.startDashboard(db, pluginPort, {
      client,
      config: { silentLead: true, fallbackModels: [], fallbackModelsByAgent: {} },
    });
    R("ext.upstream-dashboard-started", dashboard !== null, `port=${pluginPort}`);

    guest = spawn(process.execPath, [EXT_SERVICE], {
      cwd: EXT_DIR,
      env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(guestPort),
        OPENCHAMBER_SERVICE_TOKEN: TOKEN,
        ENSEMBLE_DASHBOARD_DB: dbPath,
        ENSEMBLE_DASHBOARD_URL: `http://127.0.0.1:${pluginPort}`,
        ENSEMBLE_ACTIVITY_URL: `http://127.0.0.1:${pluginPort}`,
        ENSEMBLE_CHAT_TIMEOUT_MS: "2000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    guest.stdout.on("data", (d) => guestOut.push(String(d)));
    guest.stderr.on("data", (d) => guestOut.push(String(d)));

    const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const guestUrl = (route) => `http://127.0.0.1:${guestPort}${route}`;
    let ready = false;
    for (let i = 0; i < 200 && !ready; i += 1) {
      const h = await fetchJson(guestUrl("/health"), { headers: auth });
      if (h.status === 200) ready = true; else await sleep(15);
    }
    R("ext.guest-ready", ready, ready ? `port=${guestPort}` : guestOut.join("").slice(-400));

    let r = await fetchJson(guestUrl("/health"), { headers: {} });
    R("ext.bearer-401", r.status === 401, `status=${r.status} body=${r.text}`);
    r = await fetchJson(guestUrl("/api/emergency/pause-member"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId: "ext", memberName: "cris" }),
    });
    R("ext.bearer-blocks-mutation", r.status === 401 && memberRow("cris")?.status === "busy", `status=${r.status}`);

    r = await fetchJson(guestUrl("/api/emergency/pause-member"), { method: "POST", headers: auth, body: "{" });
    R("ext.invalid-json-400", r.status === 400 && r.json?.code === "invalid_json", `status=${r.status} body=${r.text}`);

    r = await fetchJson(guestUrl("/api/emergency/pause-member"), { method: "POST", headers: auth, body: JSON.stringify({ teamId: "ext" }) });
    R("ext.missing-fields-400", r.status === 400 && r.json?.code === "missing_fields" && /teamId and memberName/.test(r.json?.error ?? ""), `status=${r.status} body=${r.text}`);

    r = await fetchJson(guestUrl("/api/emergency/pause-room"), { method: "POST", headers: auth, body: "{}" });
    R("ext.missing-teamid-400", r.status === 400 && r.json?.code === "missing_team_id", `status=${r.status} body=${r.text}`);

    r = await fetchJson(guestUrl("/api/emergency/pause-member"), { method: "POST", headers: auth, body: JSON.stringify({ teamId: "nope", memberName: "cris" }) });
    R(
      "ext.404-relayed",
      r.status === 404 && r.json?.ok === false && r.json?.upstreamStatus === 404 && /not found/i.test(r.json?.error ?? ""),
      `status=${r.status} body=${r.text}`,
    );

    r = await fetchJson(guestUrl("/api/emergency/pause-member"), { method: "POST", headers: auth, body: JSON.stringify({ teamId: "ext", memberName: "zed" }) });
    R(
      "ext.409-relayed",
      r.status === 409 && r.json?.upstreamStatus === 409 && /not active/i.test(r.json?.error ?? ""),
      `status=${r.status} body=${r.text}`,
    );

    r = await fetchJson(guestUrl("/api/emergency/pause-member"), {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ teamId: "ext", memberName: "cris", pad: "x".repeat(17 * 1024) }),
    });
    R("ext.413-local", r.status === 413 && r.json?.code === "payload_too_large", `status=${r.status} body=${r.text}`);

    // Sucesso fim a fim: trim no guest, proxy real, SQLite real pelo upstream.
    aborts.length = 0;
    r = await fetchJson(guestUrl("/api/emergency/pause-member"), {
      method: "POST", headers: auth, body: JSON.stringify({ teamId: " ext ", memberName: " cris " }),
    });
    R(
      "ext.member-200",
      r.status === 200 && r.json?.ok === true && r.json?.paused === "cris" && typeof r.json?.proxiedAt === "number",
      `status=${r.status} body=${r.text}`,
    );
    R(
      "ext.member-upstream-state",
      memberRow("cris")?.status === "ready" && memberRow("cris")?.execution_status === "standby" && aborts.includes("ses_ext_cris"),
      `row=${JSON.stringify(memberRow("cris"))} aborts=${aborts.join(",")}`,
    );

    r = await fetchJson(guestUrl("/api/emergency/pause-room"), { method: "POST", headers: auth, body: JSON.stringify({ teamId: "ext" }) });
    const paused = Array.isArray(r.json?.pausedMembers) ? [...r.json.pausedMembers].sort() : [];
    R(
      "ext.room-200",
      r.status === 200 && r.json?.ok === true && paused.join(",") === "bob,cris",
      `status=${r.status} body=${r.text}`,
    );
    R("ext.room-task-reverted", db.query("SELECT status FROM team_task WHERE id = 'tkx'").get()?.status === "pending", db.query("SELECT status FROM team_task WHERE id = 'tkx'").get()?.status);

    // 502 honesto: upstream derrubado — o guest NUNCA fabrica sucesso.
    try { dashboard?.stop(true); } catch { /* já parado */ }
    dashboard = null;
    r = await fetchJson(guestUrl("/api/emergency/pause-room"), { method: "POST", headers: auth, body: JSON.stringify({ teamId: "ext" }) });
    R("ext.502-upstream-down", r.status === 502 && r.json?.code === "dashboard_unavailable", `status=${r.status} body=${r.text}`);
  } catch (err) {
    R("ext.flow.executed", false, err?.stack ?? String(err));
  } finally {
    try { dashboard?.stop(true); } catch { /* já parado */ }
    if (guest) {
      try { guest.kill("SIGTERM"); } catch { /* já morto */ }
      await Promise.race([
        new Promise((resolve) => guest.once("exit", resolve)),
        sleep(2000),
      ]);
      try { guest.kill("SIGKILL"); } catch { /* já morto */ }
    }
  }
  return got;
}

const extFlow = await runExtensionContract();
if (extFlow?.available === false) {
  // N/A EXPLÍCITO: o contrato do proxy (frente B) não é executado neste
  // ambiente porque a extensão não faz parte deste repositório (pré-merge).
  // O check abaixo atesta o fato "frente B N/A aqui" — ele NÃO atesta o
  // contrato da extensão, que continua coberto quando ENSEMBLE_EXTENSION_DIR
  // aponta para o checkout canônico (aí a frente B roda de ponta a ponta).
  check(
    "ext.frente-B N/A: extensão fora deste repositório (contrato do proxy NÃO executado neste ambiente)",
    true,
    extFlow.reason,
  );
} else {
  for (const [name, { ok, detail }] of extFlow) check(name, ok, detail);
}

// ---------------------------------------------------------------------------
// 6. Paridade src↔dist + thread do config + anti-mock / anti-segredo trivial.
// ---------------------------------------------------------------------------
{
  const src = readFileSync(SRC_DASHBOARD, "utf8");
  const srcIndex = readFileSync(SRC_INDEX, "utf8");
  const srcV2 = readFileSync(SRC_V2, "utf8");
  const markers = [
    "/api/emergency/pause-member",
    "/api/emergency/pause-room",
    "MAX_EMERGENCY_BODY_BYTES",
    "execution_status = 'standby'",
    "status = 'pending'",
    "forceWake: true",
  ];
  const missingSrc = markers.filter((m) => !src.includes(m));
  const missingDist = markers.filter((m) => !distRaw.includes(m));
  check("parity: literais presentes em src/dashboard.ts", missingSrc.length === 0, missingSrc.join(",") || `${markers.length} marcadores`);
  check("parity: literais presentes em dist/index.js", missingDist.length === 0, missingDist.join(",") || `${markers.length} marcadores`);

  check(
    "parity: config threaded no V1 e no V2",
    /startDashboard\(db, config\.dashboardPort, \{ activityBuffer, client, config \}\)/.test(srcIndex)
      && /startDashboard\(db, dashboardPort, \{ activityBuffer, client, config \}\)/.test(srcV2),
    "src/index.ts + src/v2-setup.ts",
  );
  check(
    "parity: pausa individual aborta a sessão e limpa inflight",
    /abortInflight\(member\.session_id\)/.test(src) && /client\.session\.abort\(\{ sessionID: member\.session_id \}\)/.test(src),
    "abortInflight + session.abort",
  );

  const forbidden = /\b(?:unittest\.mock|MagicMock|jest\.mock|vi\.mock|sinon|mockImplementation)\b/;
  const offenders = [];
  for (const rel of ["dashboard.ts", "index.ts", "v2-setup.ts", "v2-session.ts", "notify.ts"]) {
    const text = readFileSync(path.join(REPO, "src", rel), "utf8");
    if (forbidden.test(text)) offenders.push(rel);
  }
  check("anti-mock: nenhum marcador de mock no caminho de produção", offenders.length === 0, offenders.join(",") || "limpo");
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
