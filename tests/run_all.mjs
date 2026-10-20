#!/usr/bin/env node
/**
 * Runner determinístico das suítes do ensemble-room-lowcost.
 *
 * Executa, em sequência estrita (fail-report, sem aborte antecipado):
 *
 *   1. test_watchdog_heartbeat.mjs     — Heartbeat ativo + imunidade a compaction (55 checks)
 *   2. test_standby_lifecycle.mjs      — Spawn em standby + blindagem de nudge/fast-idle (130 checks,
 *                                        re-executa a suíte 1 como regressão)
 *   3. test_silent_lead_board_wake.mjs — Silent lead + despertar sistemático por board (151 checks,
 *                                        re-executa as suítes 1 e 2 como regressão)
 *
 * Regras:
 *   - SEM MOCKS: toda suíte roda contra src/ e dist/ REAIS deste repositório,
 *     SQLite real (node:sqlite) e, para o schema `session`, o DDL versionado em
 *     tests/fixtures/session_schema.sql (TICKET-RELEASE-01: a suíte é hermética
 *     e não lê ~/.local/share/opencode/opencode.db).
 *   - Scratch isolado em <repo>/.test-scratch (gitignore), recriado a cada execução.
 *   - Exit 0 apenas quando TODAS as suítes retornarem status 0 e nenhuma linha
 *     "FAIL" tiver sido emitida; caso contrário exit 1.
 *
 * Uso:  node tests/run_all.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const SUITES = [
  { file: "test_watchdog_heartbeat.mjs", label: "Watchdog Heartbeat & Compaction Immunity" },
  { file: "test_standby_lifecycle.mjs", label: "Spawn em Standby + Blindagem de Hooks" },
  { file: "test_silent_lead_board_wake.mjs", label: "Silent Lead & Board Wake" },
  { file: "test_dashboard_chat.mjs", label: "Dashboard Chat API (Fase 3)" },
  { file: "test_auto_standby_seq.mjs", label: "Auto-Sequenciamento & Auto-Standby" },
  { file: "test_auto_wake_unblock.mjs", label: "Auto-Wake de Subagentes no Desbloqueio" },
  { file: "test_cyclic_graph_loop.mjs", label: "Grafos Cíclicos & Trava da Guardiã Clara" },
  { file: "test_runtime_standby_unblock.mjs", label: "Runtime Standby & Auto-Wake Unblock" },
  { file: "test_force_model_abort.mjs", label: "AbortController & Forced Model Switch" },
  { file: "test_fallback_models.mjs", label: "Schema de Fallback de Modelo" },
  { file: "test_rate_limit_failover.mjs", label: "Rate-Limit Failover Silencioso" },
  { file: "test_per_agent_fallback.mjs", label: "Fallback de Modelo Por-Agente (Per-Agent + Sessão Isolada)" },
  { file: "test_fallback_hardening.mjs", label: "Fallback Hardening (Variant default + HARNESS-13/15)" },
  { file: "test_failover_integration.mjs", label: "Integração do Failover + Variant no switchModel V2" },
  { file: "test_clara_lead_routing.mjs", label: "Roteamento e Auto-Wake da Guardiã Clara" },
  { file: "test_room_inactivity_watchdog.mjs", label: "Watchdog de Ociosidade da Sala & Despacho da Clara" },
  { file: "test_retry_failover_active.mjs", label: "Failover Ativo de Modelo (Abort + Re-prompt)" },
  { file: "test_in_review_idle_nudge.mjs", label: "Nudge de Correção Automática em Silêncio com Tarefas sob Review" },
  { file: "test_multi_instance_spawn.mjs", label: "Instâncias Múltiplas de Persona & Trava da Guardiã" },
  { file: "test_agnostic_qa_role.mjs", label: "Papel Agnóstico do Quality Gate (Migration 14)" },
  { file: "test_model_aware_wakes.mjs", label: "Wake Ciente de Modelo (F1 board-complete + F2 watchdog/spawn)" },
  { file: "test_harness16_unblock_wake.mjs", label: "HARNESS-16 (Wake Incondicional do Assignee + Watchdog de Inatividade)" },
  { file: "test_agent_identity_nudges.mjs", label: "HARNESS-17 (Identidade do agent nos 4 nudges secundários)" },
  { file: "test_hugo_sdet_integration.mjs", label: "Hugo/SDET (Standby default, Trava de Exclusividade & Paridade V1↔V2)" },
  { file: "test_decision_lead_anti_redundancy.mjs", label: "HARNESS-22 (decision_lead, Pausa da Clara & Anti-Redundância)" },
  { file: "test_global_agent_injection.mjs", label: "HARNESS-21 (Injeção Global de Persona: choke point V1 + transporte V2)" },
  { file: "test_sdet_handover_flow.mjs", label: "HARNESS-23 (Handover SDET: submit_review SDET-first, retrocompat Clara & prova de mutação)" },
  { file: "test_sdet_dependency_unblock.mjs", label: "HARNESS-24 (Desrepresamento no submit_review: SDET/QA blocked→in_progress, contrato estrito & prova de mutação)" },
  { file: "test_harness25_guardians.mjs", label: "HARNESS-25 (Guardiões em in_review: reject SDET, complete QA, guarda de lote consolidado & expurgo textual)" },
  { file: "test_auto_commit_on_complete.mjs", label: "HARNESS-26A (Auto-commit local nativo no complete QA/lead: git real em sandbox, árvore limpa, não-repo, aninhado, fail-graceful, injeção & prova de mutação)" },
  { file: "test_multi_repo_commit_and_sdet_pass.mjs", label: "HARNESS-27A/27B (Auto-commit multi-repo: room+aninhado, frescor de irmãos & sdet_pass: autorização, estado, card em in_review, wake canônico da Clara, git real + prova de mutação)" },
  { file: "test_ticket_harness_33_board_and_messaging.mjs", label: "HARNESS-33A/33B (Action estrita fail-fast + schema V1↔V2; isolamento de team_results & fan-out resiliente de team_broadcast + injeção no prompt; git real + prova de mutação)" },
  { file: "test_ticket_harness_34_quality_gate_and_silent_lead.mjs", label: "HARNESS-34 (A6 trava anti-bypass do Quality Gate + A2 filtro de abort + A1 coerência do silentLead; git real + prova de mutação)" },
  { file: "test_ticket_harness_35.mjs", label: "HARNESS-35 (A4 bind 127.0.0.1 + gate Host/Origin global + A5 chat do lead com modelo/persona/standby/delivered; prova de mutação)" },
  { file: "test_ticket_harness_36.mjs", label: "HARNESS-36 (A3/A7 unificação de Watchdogs V1/V2 + P3 anti-amnésia recovery/wake-peer + P4 releaseMemberTasks + P5 revert de standby no spawn + P6 resolveAgentForSession só times active + P7 decision_lead no spawn_context; prova de mutação)" },
  { file: "test_ticket_harness_37.mjs", label: "HARNESS-37 (M1 prompts/nudges silentLead + M2 sem handoff manual ao SDET + M3 role SDET V1/V2 + M4 fila por membro decision_lead + M5 cleanup shutdown por team_id + M6 resiliência de mensagens + M7 auto-commit antes do wake + M8 review_notes concatenadas; git real + prova de mutação)" },
  { file: "test_ticket_harness_48_handover.mjs", label: "HARNESS-48 (Handover Intra-Card team_task_handover: reatribuição atômica + notas, wake do receptor com persona/spawn_context, standby do transmissor, fail-fast sem side effects, lead soberano, paridade V1↔V2 + allowlist + Parceria de Bancada; prova de mutação)" },
  { file: "test_ticket_harness_48_ledger_discovery.mjs", label: "HARNESS-48/Frente 1 (Auto-commit universal via ledger: repo fora da árvore da sala, multi-mount, diretório não-git, repo já-limpo + prova de mutação)" },
  { file: "test_ticket_harness_49_lifecycle.mjs", label: "HARNESS-49/Frente 2 (Ciclo de vida unificado: team_shutdown wildcard/omisso/'*'/'all' paralelo, retrocompat single-member, guarda de uncommitted, alias team_cleanup + prova de mutação)" },
  { file: "test_ticket_harness_38.mjs", label: "HARNESS-38 (M9 unref+catch+dispose idempotente do Watchdog, M10 re-arme do report chatty, M11 poda/limpeza escopada de nudgedMembers no shutdown, M12 defaults + higienização de README/residuais/package.json; watchdog e plugin V1 reais + prova de mutação)" },
  { file: "test_ticket_harness_52_dashboard.mjs", label: "HARNESS-52 (Dashboard: endpoints /api/state /api/health /api/session/:id/activity /api/chat/send /, compatibilidade Migration 19 sem depends_on/blocked, serialização e renderer REAL de in_review, gate DNS rebinding Host/Origin em GET e POST; prova de mutação M1-M6)" },
  { file: "test_ticket_harness_53_failover_cooldown.mjs", label: "HARNESS-53 (Cooldown model-aware: debounce curto + avanço imediato de degrau no 429 do fallback recém-aplicado, membro e isolada/Lead, cadeia de Hugo/Clara/Diana no ensemble.json real + prova de mutação M1-M4)" },
  { file: "test_ticket_harness_54_system_prompt_anti_polling.mjs", label: "HARNESS-54 (Blindagem anti-polling do Lead: diretiva condicional de pulso sintético [Continue]/Continue só com board aberto + paridade src↔dist e prova de mutação)" },
  { file: "test_ticket_harness_55_auto_sizing.mjs", label: "HARNESS-55 (Auto-Dimensionamento Nativo: protocolo pedagógico no prompt do Lead + compaction + retorno enriquecido de team_create + saneamento depends_on; SQLite real e prova de mutação M1-M3)" },
  { file: "test_emergency_pause.mjs", label: "HARNESS-56 (Emergency kill-switch: pausa individual/sala real com SQLite + gate Host, abort paralelo, tasks in_progress->pending, wake forçado ao Lead + contrato do proxy da extensão real; prova de mutação M1-M11)" },
  { file: "test_ticket_harness_57_failover_refinement.mjs", label: "HARNESS-57 (Failover model-aware: supressão do eco residual vs bypass imediato do modelo novo + AbortController no spawn sem rollback destrutivo; SQLite/transporte reais, paridade src↔dist e prova de mutação M1-M3)" },
  { file: "test_release_03_dashboard_csrf.mjs", label: "TICKET-RELEASE-03 (Dashboard CSRF/cross-origin: Host loopback+porta, Origin allow-list, null+JSON, fallback de Referer, cabeçalhos nosniff/no-referrer/no-store em JSON/HTML/403, emergência sem efeito colateral; HTTP cru real, paridade src↔dist e prova de mutação M1-M7)" },
];
const SUITE_TIMEOUT_MS = 600_000;

const started = Date.now();
const rows = [];

console.log("=".repeat(78));
console.log("ensemble-room-lowcost — suíte determinística (sem mocks)");
console.log(`node ${process.version} | runner: ${path.relative(process.cwd(), import.meta.filename) || import.meta.filename}`);
console.log("=".repeat(78));

for (const { file, label } of SUITES) {
  const target = path.join(HERE, file);
  const exists = existsSync(target);
  console.log(`\n${"=".repeat(78)}\n▶ ${file} — ${label}\n${"=".repeat(78)}`);

  if (!exists) {
    console.log(`FAIL | suíte ausente: ${target}`);
    rows.push({ file, label, status: -1, result: "(suíte ausente)", fails: ["suíte ausente"], ms: 0 });
    continue;
  }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [target], {
    encoding: "utf8",
    timeout: SUITE_TIMEOUT_MS,
    cwd: HERE,
    env: process.env,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out.endsWith("\n") || out === "" ? out : `${out}\n`);

  const lines = out.split("\n");
  const resultLine = lines.filter((l) => l.startsWith("RESULT:")).pop() ?? "(sem linha RESULT)";
  const fails = lines.filter((l) => l.startsWith("FAIL"));
  const status = r.status ?? -1;
  const ok = status === 0 && fails.length === 0 && /checks passed/.test(resultLine);

  console.log(`\n— ${file}: ${ok ? "PASS" : "FAIL"} (exit=${status}, ${ms} ms) → ${resultLine.trim()}`);
  rows.push({ file, label, status, result: resultLine.trim(), fails, ms, ok });
}

const passed = rows.filter((r) => r.ok).length;
const total = rows.length;
const elapsed = Date.now() - started;

console.log(`\n${"=".repeat(78)}`);
console.log("RELATÓRIO CONSOLIDADO");
console.log("=".repeat(78));
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"} | ${r.file.padEnd(34)} | exit=${r.status} | ${String(r.ms).padStart(6)} ms | ${r.result}`);
  for (const f of r.fails) console.log(`       ↳ ${f}`);
}
console.log("-".repeat(78));
console.log(`SUÍTES: ${passed}/${total} passaram | tempo total: ${elapsed} ms`);
console.log(`RESULT_ALL: ${passed === total ? "ALL SUITES PASSED" : "SUITE FAILURE"}`);
console.log("=".repeat(78));

process.exit(passed === total ? 0 : 1);
