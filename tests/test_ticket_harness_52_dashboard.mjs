#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-52
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, HTTP real e o
 * renderer REAL do dashboard executado num ambiente DOM mínimo — SEM MOCKS):
 *   - src/dashboard.ts        -> startDashboard / handleDashboardRequest
 *   - src/dashboard-js-render.ts -> rSum / rTasks (renderer entregue ao browser)
 *   - src/schema.ts           -> Migration 19 (expurgo de depends_on e 'blocked')
 *
 * Cobertura:
 *   (1) Endpoints: GET /api/health, GET /api/state, GET /api/session/:id/activity,
 *       POST /api/chat/send e HTML raiz GET /.
 *   (2) Migration 19: banco criado por createDb fica em user_version >= 19, a
 *       tabela team_task NÃO tem a coluna depends_on, o CHECK de status NÃO
 *       aceita 'blocked' (INSERT é rejeitado) e aceita 'in_review'. O dashboard
 *       carrega e serializa essa base sem referenciar campos expurgados.
 *   (3) Fidelidade de in_review: /api/state serializa status/priority/assignee/
 *       rejectionCount/reviewNotes fielmente e o renderer REAL (extraído do HTML
 *       servido, avaliado num DOM mínimo) agrupa a tarefa em "In Review", com o
 *       badge "in review", ícone âmbar e notas de rejeição; o resumo mostra o
 *       chip "N in review". Payload legado 'blocked'/desconhecido é normalizado
 *       para "Pending" (defesa em profundidade).
 *   (4) DNS Rebinding: gate Host/Origin no topo do handler cobre GET e POST,
 *       devolvendo 403 e sem persistir nada; clientes loopback legítimos = 200.
 *   (5) Prova de mutação M1..M6 no bundle dist com sentinelas sensíveis e
 *       fluxos intactos preservados.
 *   (6) Paridade src↔dist + varredura anti-mock.
 *
 * Seam único: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync/messages/get. Nenhum componente de
 * produção é substituído: SQLite, bundle dist, HTTP e renderer são reais. O
 * cabeçalho Host malicioso é forjado com socket HTTP/1.1 cru (fetch do Node
 * proíbe sobrescrever Host).
 *
 * Uso: node tests/test_ticket_harness_52_dashboard.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import vm from "node:vm";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h52");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, !!ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " | " + detail : ""}`);
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
  writeFileSync(path.join(TMP, "_h52_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h52_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Helpers de transporte reais e determinísticos.
// ---------------------------------------------------------------------------
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
      fin({ status, body: bodyPart, json, headers: headPart });
    });
    socket.on("error", () => fin({ status: 0, body: "", json: null, headers: "" }));
    setTimeout(() => fin({ status: 0, body: "", json: null, headers: "" }), 4000);
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
// 2. Ambiente DOM mínimo para executar o RENDERER REAL entregue ao browser.
//    Extrai o <script> inline servido em "/", remove apenas o bloco de eventos
//    (timers/listeners/poll de topo) e avalia core+render no vm. Não substitui
//    lógica de produção: as funções rSum/rTasks executadas são as do bundle.
// ---------------------------------------------------------------------------
function extractRendererScript(html) {
  const anchor = html.indexOf("function rTasks(");
  if (anchor < 0) return null;
  const open = html.lastIndexOf("<script>", anchor);
  const close = html.indexOf("</script>", anchor);
  if (open < 0 || close < 0) return null;
  let script = html.slice(open + "<script>".length, close);
  const eventsMarker = "function toggleMsg(";
  const cut = script.indexOf(eventsMarker);
  if (cut > 0) script = script.slice(0, cut);
  return script;
}

function makeDom() {
  const els = new Map();
  const mk = (id) => ({
    id, innerHTML: "", textContent: "", value: "", hidden: false, open: false,
    style: {}, dataset: {}, scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, closest() { return null; },
  });
  return {
    els,
    document: {
      getElementById(id) { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
  };
}

function evalRenderer(script, state) {
  const dom = makeDom();
  const sandbox = {
    document: dom.document,
    console,
    Date, Math, JSON, Set, Map, String, Number, Object, Array, RegExp, Boolean,
    isNaN, parseInt, parseFloat,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const out = { tasksHtml: "", sumHtml: "", tasksError: null, sumError: null };
  try {
    vm.runInContext(script, sandbox, { timeout: 10000 });
    try { sandbox.rTasks(state); out.tasksHtml = dom.document.getElementById("tasks").innerHTML; }
    catch (e) { out.tasksError = String((e && e.stack) || e); }
    try { sandbox.rSum(state); out.sumHtml = dom.document.getElementById("sum").innerHTML; }
    catch (e) { out.sumError = String((e && e.stack) || e); }
  } catch (e) {
    out.tasksError = out.tasksError ?? String((e && e.stack) || e);
  }
  return out;
}

const LEGACY_STATE = {
  name: "legacy-team",
  status: "active",
  members: [{ name: "x", status: "ready" }],
  messages: [],
  tasks: [
    { id: "l1", content: "tarefa-legada-blocked", status: "blocked", priority: "medium", assignee: "x", rejectionCount: 0, reviewNotes: null, timeCreated: 0, timeUpdated: 0 },
    { id: "l2", content: "tarefa-status-desconhecido", status: "mystery", priority: "low", assignee: "y", rejectionCount: 0, reviewNotes: null, timeCreated: 0, timeUpdated: 0 },
    { id: "l3", content: "tarefa-pendente-viva", status: "pending", priority: "high", assignee: "z", rejectionCount: 0, reviewNotes: null, timeCreated: 0, timeUpdated: 0 },
  ],
};

// ---------------------------------------------------------------------------
// 3. RunFlow: todos os cenários contra um bundle harness. Cada execução usa
//    SQLite + servidor HTTP novos. Nunca lança: exceção vira check falso
//    (necessário para a fase de mutação).
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, startDashboard } = mod;
  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-h52-${process.pid}-${flowSeq++}-`));
  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = createDb(path.join(base, "db", "ensemble.db"));

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  const now = Date.now();
  const activityBuffer = new (class {
    constructor() { this.buf = new Map(); }
    record(sid, entry) { const a = this.buf.get(sid) ?? []; a.push(entry); this.buf.set(sid, a); }
    getActivity(sid) { return [...(this.buf.get(sid) ?? [])]; }
  })();

  // Único seam: recorder de transporte (promptAsync/messages/get). Determinístico.
  const calls = [];
  const client = {
    session: {
      promptAsync: async (o) => { calls.push(o); return {}; },
      messages: async () => ({
        data: [{
          info: { role: "assistant", time: { created: 2000 } },
          parts: [
            { type: "text", text: "saida-real-da-sessao" },
            { type: "tool", tool: "bash", state: { status: "completed", title: "exec", input: { cmd: "ls" }, output: "ok" } },
          ],
        }],
      }),
      get: async () => ({ data: { id: "ses_hugo", title: "sessao-hugo" } }),
    },
  };

  const port = await getFreePort();
  let server = null;
  try {
    // ---------------- Migration 19: estrutura real da base ----------------
    const uv = db.query("PRAGMA user_version").get()?.user_version;
    R("m19.user-version", typeof uv === "number" && uv >= 19, `user_version=${uv}`);
    const cols = db.query("PRAGMA table_info(team_task)").all().map((c) => c.name);
    R("m19.no-depends-on-column", !cols.includes("depends_on"), cols.join(","));
    const ddl = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_task'").get()?.sql ?? "";
    R(
      "m19.check-excludes-blocked",
      /in_review/.test(ddl) && !/'blocked'/.test(ddl),
      `in_review=${/in_review/.test(ddl)} blockedLiteral=${/'blocked'/.test(ddl)}`,
    );

    // ---------------- Seed real (schema pós-Migration 19) ----------------
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES ('t1','squad-h52','default','ses_lead','dante','active',0,?,?)",
      [now, now],
    );
    const seedMember = (name, ses, agent, opts = {}) => {
      db.run(
        `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, time_created, time_updated, reported_to_lead)
         VALUES ('t1',?,?,?, 'ready', ?, ?, ?, ?, ?, 0)`,
        [name, ses, agent, opts.exec ?? "idle", opts.model ?? null, opts.ctx ?? null, now, now],
      );
    };
    seedMember("hugo", "ses_hugo", "hugo", { model: "opencode/glm-5.3-flash-free" });
    seedMember("cris", "ses_cris", "cris");

    // 'blocked' deve ser rejeitado pelo CHECK pós-Migration 19.
    let blockedRejected = false;
    try {
      db.run(
        "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('probe_blocked','t1','probe','blocked','medium',?,?)",
        [now, now],
      );
    } catch { blockedRejected = true; }
    R("m19.blocked-insert-rejected", blockedRejected, `rejected=${blockedRejected}`);

    const seedTask = (id, content, status, priority, assignee, rej = 0, notes = null) => {
      db.run(
        "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, review_notes, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [id, "t1", content, status, priority, assignee, rej, notes, now, now],
      );
    };
    seedTask("t-review", "Revisar handover SDET do dashboard H52", "in_review", "high", "hugo", 2, "ajustar o gate");
    seedTask("t-progress", "Implementar dashboard H52", "in_progress", "medium", "cris");
    seedTask("t-pending", "Aguardando claims", "pending", "low", null);
    seedTask("t-done", "Concluir migracao 19", "completed", "medium", "cris");
    R(
      "m19.in-review-insert-accepted",
      db.query("SELECT COUNT(*) c FROM team_task WHERE status = 'in_review'").get().c === 1,
      `in_review=${db.query("SELECT COUNT(*) c FROM team_task WHERE status = 'in_review'").get().c}`,
    );

    // Atividade real no buffer.
    activityBuffer.record("ses_hugo", { type: "tool_call", tool: "qmd_search", input: "consulta", timestamp: 1000 });

    server = await startDashboard(db, port, { client, activityBuffer });
    R("server.started", server !== null, `port=${port}`);

    // ---------------- (1/3) Endpoints + serialização in_review ----------------
    let rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `127.0.0.1:${port}` });
    R("health.200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status} json=${JSON.stringify(rr.json)}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `127.0.0.1:${port}` });
    const state = rr.json;
    R("state.200", rr.status === 200 && state !== null, `status=${rr.status}`);
    R("state.version", state?.version === 1, `version=${state?.version}`);
    R(
      "state.projects-teams-shape",
      Array.isArray(state?.projects) && Array.isArray(state?.teams) && state.teams.length === 1,
      `projects=${state?.projects?.length} teams=${state?.teams?.length}`,
    );
    const team = state?.teams?.find((t) => t.id === "t1") ?? null;
    const project = state?.projects?.find((p) => p.id === "default") ?? null;
    R("state.project-active-teams", project?.activeTeams === 1 && project?.workingAgents === 0, `activeTeams=${project?.activeTeams} workingAgents=${project?.workingAgents}`);

    const review = team?.tasks?.find((t) => t.id === "t-review") ?? null;
    R(
      "state.in-review-task-serialized",
      review?.status === "in_review" && review?.priority === "high" && review?.assignee === "hugo" &&
        review?.content === "Revisar handover SDET do dashboard H52",
      JSON.stringify(review),
    );
    R(
      "state.in-review-review-metadata",
      review?.rejectionCount === 2 && review?.reviewNotes === "ajustar o gate" &&
        typeof review?.timeCreated === "number" && typeof review?.timeUpdated === "number",
      JSON.stringify(review),
    );
    R(
      "state.no-legacy-dependency-fields",
      review !== null && !("dependsOn" in review) && !("depends_on" in review) &&
        team.tasks.every((t) => !("dependsOn" in t) && !("depends_on" in t)),
      review ? Object.keys(review).join(",") : "task ausente",
    );

    // ---------------- (1) Activity endpoint ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/session/ses_hugo/activity", host: `127.0.0.1:${port}` });
    const act = rr.json?.activity ?? [];
    R("activity.200", rr.status === 200 && Array.isArray(rr.json?.activity), `status=${rr.status}`);
    R("activity.buffered-entry", act[0]?.type === "tool_call" && act[0]?.tool === "qmd_search", JSON.stringify(act[0]));
    R("activity.fallback-text", act.some((a) => a.type === "text" && a.text === "saida-real-da-sessao"), JSON.stringify(act.map((a) => a.type)));
    R("activity.fallback-tool", act.some((a) => a.type === "tool_result" && a.tool === "bash"), JSON.stringify(act.map((a) => a.type)));
    R("activity.session", rr.json?.session?.id === "ses_hugo", JSON.stringify(rr.json?.session));
    R("activity.ordering", act.length === 3 && act[0].timestamp <= act[1].timestamp && act[1].timestamp <= act[2].timestamp, act.map((a) => a.timestamp).join(","));

    rr = await rawRequest(port, { method: "GET", path: "/api/session/desconhecida/activity", host: `127.0.0.1:${port}` });
    R("activity.unknown-404", rr.status === 404 && rr.json?.error === "Unknown session", `status=${rr.status} json=${JSON.stringify(rr.json)}`);

    // ---------------- (1) Chat endpoint ----------------
    const countMessages = () => db.query("SELECT COUNT(*) c FROM team_message WHERE team_id = 't1'").get().c;
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
    const waitDelivered = async (id) => {
      if (typeof id !== "string" || !id) return false;
      for (let i = 0; i < 120; i++) {
        const row = db.query("SELECT delivered FROM team_message WHERE id = ?").get(id);
        if (row && row.delivered === 1) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };

    calls.length = 0;
    let r = await post({ teamId: "t1", to: "hugo", text: "fidelidade visual" });
    R("chat.dm-200", r.status === 200 && r.data?.ok === true && r.data?.recipients?.includes("hugo"), `status=${r.status} data=${JSON.stringify(r.data)}`);
    const row = typeof r.data?.messageId === "string"
      ? db.query("SELECT from_name, to_name, content FROM team_message WHERE id = ?").get(r.data.messageId)
      : null;
    R("chat.dm-row", row?.from_name === "human" && row?.to_name === "hugo" && row?.content === "fidelidade visual", JSON.stringify(row));
    const call = calls.find((c) => c.sessionID === "ses_hugo");
    R("chat.dm-prompt", !!call && call.agent === "hugo" && call.synthetic === true && String(call.parts?.[0]?.text ?? "").includes("fidelidade visual"), `agent=${call?.agent}`);
    R("chat.dm-delivered", (await waitDelivered(r.data?.messageId)) === true, `messageId=${r.data?.messageId}`);

    r = await post({ teamId: "t1", to: "hugo", text: "   " });
    R("chat.empty-400", r.status === 400 && r.data?.ok === false, `status=${r.status} data=${JSON.stringify(r.data)}`);

    // ---------------- (3) Renderer REAL sobre o estado REAL ----------------
    rr = await rawRequest(port, { method: "GET", path: "/", host: `127.0.0.1:${port}` });
    const html = rr.body;
    R("html.root-200", rr.status === 200 && /text\/html/i.test(rr.headers), `status=${rr.status}`);
    R("html.title", html.includes("<title>Ensemble</title>"), `len=${html.length}`);
    R("html.task-container", html.includes('id="tasks"') && html.includes('id="sum"'));
    R(
      "html.render-contract-in-review",
      html.includes("x.status==='in_review'?chip('in review','amber'):''") &&
        html.includes("grp('In Review',g.in_review||[],'bg-amber-500',true)"),
    );
    R("html.render-contract-normalization", html.includes("(x.status==='blocked'||!g[x.status])?'pending':x.status"));
    R("html.render-contract-summary-chip", html.includes("chip(rc+' in review','amber')"));

    const script = extractRendererScript(html);
    R("render.script-extracted", typeof script === "string" && script.includes("function rTasks("), `len=${script?.length ?? 0}`);
    const rendered = script ? evalRenderer(script, team) : { tasksHtml: "", sumHtml: "", tasksError: "sem script", sumError: null };
    const th = rendered.tasksHtml;
    const sh = rendered.sumHtml;

    const pReview = th.indexOf("In Review");
    const pPending = th.indexOf("Pending");
    const pDone = th.indexOf("Completed");
    const pTask = th.indexOf("Revisar handover SDET do dashboard H52");
    R(
      "render.tasks-summary-group",
      pReview >= 0 && /In Review\s*<span[^>]*>\(1\)<\/span>/.test(th),
      `review=${pReview}`,
    );
    R("render.tasks-review-row", pTask >= 0 && th.includes("hugo"), `task=${pTask}`);
    R("render.tasks-review-badge", th.includes("in review"), th.includes("in review") ? "badge presente" : "badge ausente");
    R("render.tasks-review-icon", th.includes("\u25C9") && th.includes("text-amber-400"), `icon=${th.includes("\u25C9")}`);
    R(
      "render.tasks-review-notes",
      th.includes("rejections: 2") && th.includes("notes: ajustar o gate"),
      `rej=${th.includes("rejections: 2")} notes=${th.includes("notes: ajustar o gate")}`,
    );
    R(
      "render.tasks-review-order",
      pReview >= 0 && pPending > pReview && pTask > pReview && pTask < pPending,
      `review=${pReview} task=${pTask} pending=${pPending}`,
    );
    R(
      "render.tasks-completed-order",
      pDone >= 0 && th.indexOf("Concluir migracao 19") > pDone,
      `done=${pDone} taskDone=${th.indexOf("Concluir migracao 19")}`,
    );
    R("render.summary-in-review-chip", sh.includes("1 in review") && sh.includes("amber"), `sum=${JSON.stringify(sh.slice(0, 220))}`);
    R("render.summary-task-count", sh.includes("1/4 tasks"), `sum=${JSON.stringify(sh.slice(0, 220))}`);

    const legacy = script ? evalRenderer(script, LEGACY_STATE) : { tasksHtml: "", tasksError: "sem script" };
    const lh = legacy.tasksHtml;
    const lPend = lh.indexOf("Pending");
    R("render.legacy-no-throw", legacy.tasksError === null, legacy.tasksError || "ok");
    R("render.legacy-blocked-to-pending", lPend >= 0 && lh.indexOf("tarefa-legada-blocked") > lPend, `pending=${lPend}`);
    R("render.legacy-unknown-to-pending", lPend >= 0 && lh.indexOf("tarefa-status-desconhecido") > lPend, `pending=${lPend}`);

    // ---------------- (4) DNS Rebinding / gate Host-Origin ----------------
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `evil.example.com:${port}` });
    R("gate.health-forged-403", rr.status === 403 && rr.json?.ok === false, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `evil.example.com:${port}` });
    R("gate.state-forged-403", rr.status === 403, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/", host: `evil.example.com:${port}` });
    R("gate.root-forged-403", rr.status === 403, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/session/ses_hugo/activity", host: `evil.example.com:${port}` });
    R("gate.activity-forged-403", rr.status === 403, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `127.0.0.1:${port + 1}` });
    R("gate.wrong-port-403", rr.status === 403, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `localhost:${port}`, origin: "http://attacker.example" });
    R("gate.origin-mismatch-403", rr.status === 403, `status=${rr.status}`);

    const before = countMessages();
    rr = await rawRequest(port, {
      method: "POST", path: "/api/chat/send", host: `evil.example.com:${port}`,
      body: JSON.stringify({ teamId: "t1", to: "hugo", text: "invasao" }),
    });
    R("gate.chat-forged-403", rr.status === 403, `status=${rr.status}`);
    R("gate.chat-forged-not-persisted", countMessages() === before, `before=${before} after=${countMessages()}`);

    rr = await rawRequest(port, { method: "GET", path: "/api/health", host: `localhost:${port}` });
    R("gate.legit-health-200", rr.status === 200 && rr.json?.ensemble === true, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/state", host: `127.0.0.1:${port}` });
    R("gate.legit-state-200", rr.status === 200 && rr.json?.version === 1, `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/", host: `localhost:${port}` });
    R("gate.legit-root-200", rr.status === 200 && rr.body.includes("<title>Ensemble</title>"), `status=${rr.status}`);
    rr = await rawRequest(port, { method: "GET", path: "/api/session/ses_hugo/activity", host: `127.0.0.1:${port}` });
    R("gate.legit-activity-200", rr.status === 200, `status=${rr.status}`);
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
// 4. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 5. Paridade src↔dist + varredura anti-mock.
// ---------------------------------------------------------------------------
const srcRender = readFileSync(path.join(SRC, "dashboard-js-render.ts"), "utf8");
const srcDashboard = readFileSync(path.join(SRC, "dashboard.ts"), "utf8");
const srcSchema = readFileSync(path.join(SRC, "schema.ts"), "utf8");

check(
  "paridade Migration 19: rebuild da team_task em src E dist",
  srcSchema.includes("team_task_old_m19") && distRaw.includes("team_task_old_m19") &&
    srcSchema.includes("CASE WHEN status = 'blocked' THEN 'pending' ELSE status END") &&
    distRaw.includes("CASE WHEN status = 'blocked' THEN 'pending' ELSE status END"),
);
check(
  "paridade render: in_review na rSum e normalização blocked→pending (src E dist)",
  srcRender.includes("chip(rc+' in review','amber')") && distRaw.includes("chip(rc+' in review','amber')") &&
    srcRender.includes("(x.status==='blocked'||!g[x.status])?'pending':x.status") &&
    distRaw.includes("(x.status==='blocked'||!g[x.status])?'pending':x.status"),
);
check(
  "paridade gate Host/Origin global (src E dist)",
  srcDashboard.includes("if (!isTrustedLocalRequest(port, req)) {") &&
    distRaw.includes("if (!isTrustedLocalRequest(port, req)) {"),
);
check(
  "paridade bind explícito em 127.0.0.1 (src E dist)",
  srcDashboard.includes('server.listen(port, "127.0.0.1"') && distRaw.includes('server.listen(port, "127.0.0.1"'),
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
// 6. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
//    Cada mutante FALHA nas sentinelas do alvo (sensibilidade) e PERMANECE
//    VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "gate Host/Origin global removido (DNS rebinding passa)",
    from: "if (!isTrustedLocalRequest(port, req)) {",
    to: "if (false) {",
    detect: [
      "gate.health-forged-403", "gate.state-forged-403", "gate.root-forged-403",
      "gate.activity-forged-403", "gate.wrong-port-403", "gate.origin-mismatch-403",
      "gate.chat-forged-403", "gate.chat-forged-not-persisted",
    ],
    unaffected: ["health.200", "state.200", "state.in-review-task-serialized", "activity.200", "chat.dm-200", "render.tasks-summary-group", "render.summary-in-review-chip", "html.root-200"],
  },
  {
    id: "M2",
    desc: "chip 'in review' do resumo (rSum) removido",
    from: "(rc?chip(rc+' in review','amber'):'')",
    to: "''",
    detect: ["render.summary-in-review-chip"],
    unaffected: ["render.tasks-summary-group", "render.tasks-review-notes", "render.tasks-review-order", "state.200", "chat.dm-200", "gate.state-forged-403"],
  },
  {
    id: "M3",
    desc: "badge 'in review' da linha de tarefa (rTasks) removido",
    from: "const reviewBadge=x.status==='in_review'?chip('in review','amber'):'';",
    to: "const reviewBadge='';",
    detect: ["render.tasks-review-badge"],
    unaffected: ["render.tasks-summary-group", "render.tasks-review-icon", "render.tasks-review-notes", "render.summary-in-review-chip", "state.200"],
  },
  {
    id: "M4",
    desc: "normalização blocked/desconhecido→pending removida no renderer",
    from: "for(const x of tk){const st=(x.status==='blocked'||!g[x.status])?'pending':x.status;g[st].push(x)}",
    to: "for(const x of tk){const st=x.status;g[st].push(x)}",
    detect: ["render.legacy-no-throw", "render.legacy-blocked-to-pending", "render.legacy-unknown-to-pending"],
    unaffected: ["render.tasks-summary-group", "render.tasks-review-badge", "render.summary-in-review-chip", "state.200"],
  },
  {
    id: "M5",
    desc: "grupo 'In Review' esvaziado (tarefas em review desaparecem do board)",
    from: "grp('In Review',g.in_review||[],'bg-amber-500',true)",
    to: "grp('In Review',[],'bg-amber-500',true)",
    detect: ["render.tasks-summary-group", "render.tasks-review-order"],
    unaffected: ["render.summary-in-review-chip", "state.200", "chat.dm-200", "gate.state-forged-403"],
  },
  {
    id: "M6",
    desc: "reviewNotes deixa de ser serializado em /api/state",
    from: "reviewNotes: tk.review_notes ?? null",
    to: "reviewNotes: null",
    detect: ["state.in-review-review-metadata", "render.tasks-review-notes"],
    unaffected: ["state.in-review-task-serialized", "render.tasks-summary-group", "render.tasks-review-badge", "render.summary-in-review-chip", "state.200"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h52_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, (err && err.stack) || String(err));
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
