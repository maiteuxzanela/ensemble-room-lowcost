#!/usr/bin/env node
/**
 * Runner determinístico das suítes do ensemble-room-lowcost.
 *
 * Executa, em sequência estrita (fail-report, sem aborte antecipado):
 *
 *   1. test_watchdog_heartbeat.mjs     — Heartbeat ativo + imunidade a compaction (53 checks)
 *   2. test_standby_lifecycle.mjs      — Spawn em standby + blindagem de nudge/fast-idle (130 checks,
 *                                        re-executa a suíte 1 como regressão)
 *   3. test_silent_lead_board_wake.mjs — Silent lead + despertar sistemático por board (151 checks,
 *                                        re-executa as suítes 1 e 2 como regressão)
 *
 * Regras:
 *   - SEM MOCKS: toda suíte roda contra src/ e dist/ REAIS deste repositório,
 *     SQLite real (node:sqlite) e, para o schema `session`, leitura read-only
 *     de ~/.local/share/opencode/opencode.db (pré-requisito documentado no README).
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
