#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Pins de Node da CI endurecidos
 * (TICKET-HARNESS-89)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * SEM MOCKS: lê os arquivos REAIS dos dois repositórios, executa o verificador
 * real (`opencode_repo/script/verify-node-version-pins.mjs`) com o parser real
 * de YAML do Bun e prova por MUTAÇÃO que o verificador reprova um pin flutuante
 * e uma versão vulnerável. Nenhuma dependência é substituída por stub.
 *
 * Cobertura:
 *   A. ensemble-room-lowcost/.github/workflows/ci.yml
 *      A1 matrix fixada em ["22.23.4", "24.22.1"] (patch exato, sem major flutuante)
 *      A2 setup-node declara check-latest: true
 *      A3 não há matrix antiga [22, 24] nem node-version numérico solto
 *   B. ensemble-room-lowcost/.github/workflows/publish.yml
 *      B1 node-version: "22.23.4"
 *      B2 check-latest: true
 *      B3 não há node-version: 22 (major flutuante)
 *   C. opencode_repo/.github/actions/setup-bun/action.yml
 *      C1 node-version: "24.22.1"
 *      C2 nenhum setup-bun regride para "24"/24 flutuante
 *   D. Verificador real do opencode_repo (quando `bun` está disponível)
 *      D1 a árvore real passa (exit 0, "OK —")
 *      D2 mutação pin flutuante "24" no composite action  → exit 1
 *      D3 mutação versão vulnerável "26.4.0" em workflow   → exit 1
 *      D4 cópia íntegra da árvore real                     → exit 0
 *
 * Execução: node tests/test_ticket_harness_89_node_pins.mjs
 * Exit: 0 apenas com todas as verificações aplicáveis verdes.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ENSEMBLE = path.resolve(HERE, "..");
const OPENCODE =
  process.env.OPENCODE_REPO_DIR || path.resolve(ENSEMBLE, "..", "opencode_repo");

const CI_YML = path.join(ENSEMBLE, ".github", "workflows", "ci.yml");
const PUBLISH_YML = path.join(ENSEMBLE, ".github", "workflows", "publish.yml");
const SETUP_BUN = path.join(OPENCODE, ".github", "actions", "setup-bun", "action.yml");
const VERIFIER = path.join(OPENCODE, "script", "verify-node-version-pins.mjs");

const results = [];
const skips = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, reason) => {
  skips.push([name, reason]);
  console.log(`SKIP | ${name} — ${reason}`);
};

const read = (file) => readFileSync(file, "utf8");

// ---------------------------------------------------------------------------
// A. CI matrix do ensemble-room-lowcost
// ---------------------------------------------------------------------------
const ci = read(CI_YML);
check(
  "A1.ci-matrix-pins-exatos",
  /^\s*node:\s*\["22\.23\.4",\s*"24\.22\.1"\]\s*$/m.test(ci),
  "esperado node: [\"22.23.4\", \"24.22.1\"]"
);
check(
  "A2.ci-check-latest",
  /^\s*check-latest:\s*true\s*$/m.test(ci),
  "setup-node deve resolver o patch mais recente da linha pinada"
);
check(
  "A3.ci-sem-major-flutuante",
  !/^\s*node:\s*\[\s*22\s*,\s*24\s*\]\s*$/m.test(ci) &&
    !/^\s*node-version:\s*(22|24|26)\s*$/m.test(ci),
  "matrix antiga [22, 24] e node-version major solto devem estar ausentes"
);

// ---------------------------------------------------------------------------
// B. Publish do ensemble-room-lowcost
// ---------------------------------------------------------------------------
const publish = read(PUBLISH_YML);
check(
  "B1.publish-pin-exato",
  /^\s*node-version:\s*"22\.23\.4"\s*$/m.test(publish),
  "esperado node-version: \"22.23.4\""
);
check(
  "B2.publish-check-latest",
  /^\s*check-latest:\s*true\s*$/m.test(publish),
  "check-latest: true exigido junto do piso exato"
);
check(
  "B3.publish-sem-major-flutuante",
  !/^\s*node-version:\s*(22|24|26)\s*$/m.test(publish) &&
    !/^\s*node-version:\s*["']?(22|24|26)["']?\s*$/m.test(publish),
  "node-version não pode ser major flutuante"
);

// ---------------------------------------------------------------------------
// C. Composite action setup-bun do opencode_repo
// ---------------------------------------------------------------------------
if (!existsSync(SETUP_BUN)) {
  skip("C.setup-bun", `arquivo ausente: ${SETUP_BUN}`);
} else {
  const action = read(SETUP_BUN);
  check(
    "C1.setup-bun-pin-exato",
    /^\s*node-version:\s*"24\.22\.1"\s*$/m.test(action),
    "esperado node-version: \"24.22.1\""
  );
  check(
    "C2.setup-bun-sem-flutuante",
    !/^\s*node-version:\s*["']?(24|26|22)["']?\s*$/m.test(action),
    "nenhum pin major solto no composite action"
  );
}

// ---------------------------------------------------------------------------
// D. Verificador real (Bun.YAML) + prova de mutação
// ---------------------------------------------------------------------------
const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8" });
const hasBun = bunProbe.status === 0 && /\d+\.\d+\.\d+/.test(bunProbe.stdout ?? "");

const runVerifier = (pinsRoot) =>
  spawnSync("bun", [VERIFIER], {
    encoding: "utf8",
    timeout: 120_000,
    env: pinsRoot ? { ...process.env, PINS_ROOT: pinsRoot } : process.env,
  });

if (!hasBun) {
  skip("D.verificador-real", "binário `bun` ausente no PATH (Bun.YAML indisponível)");
} else if (!existsSync(VERIFIER)) {
  skip("D.verificador-real", `script ausente: ${VERIFIER}`);
} else {
  const real = runVerifier(null);
  check(
    "D1.arvore-real-verde",
    real.status === 0 && /^OK —/m.test(real.stdout ?? ""),
    `exit=${real.status} ${(real.stderr ?? "").split("\n").find(Boolean) ?? ""}`.trim()
  );

  // Fixture: cópia REAL de .github/ + package.json (o verificador lê ambos).
  const scratchRoot = path.join(ENSEMBLE, ".test-scratch");
  cpSync(path.join(OPENCODE, ".github"), path.join(scratchRoot, "pins", ".github"), {
    recursive: true,
  });
  cpSync(
    path.join(OPENCODE, "package.json"),
    path.join(scratchRoot, "pins", "package.json")
  );
  const pinsRoot = path.join(scratchRoot, "pins");
  const mutableAction = path.join(pinsRoot, ".github", "actions", "setup-bun", "action.yml");
  const mutablePublish = path.join(pinsRoot, ".github", "workflows", "publish.yml");

  const baseline = runVerifier(pinsRoot);
  check(
    "D4.copia-integra-verde",
    baseline.status === 0,
    `exit=${baseline.status} (cópia sem mutação deve passar)`
  );

  const actionOriginal = read(mutableAction);
  writeFileSync(mutableAction, actionOriginal.replace('node-version: "24.22.1"', 'node-version: "24"'));
  const mutatedFloat = runVerifier(pinsRoot);
  check(
    "D2.mutacao-flutuante-reprovada",
    mutatedFloat.status === 1 && /fora da allowlist/.test(mutatedFloat.stderr ?? ""),
    `exit=${mutatedFloat.status} (pin "24" flutuante deve reprovar)`
  );

  writeFileSync(mutableAction, actionOriginal);
  const publishOriginal = read(mutablePublish);
  writeFileSync(
    mutablePublish,
    publishOriginal.replace('node-version: "26.12.1"', 'node-version: "26.4.0"')
  );
  const mutatedVuln = runVerifier(pinsRoot);
  check(
    "D3.mutacao-vulneravel-reprovada",
    mutatedVuln.status === 1 && /vulner[aá]vel/.test(mutatedVuln.stderr ?? ""),
    `exit=${mutatedVuln.status} (26.4.0 vulnerável deve reprovar)`
  );

  writeFileSync(mutablePublish, publishOriginal);
  rmSync(pinsRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok);
console.log(
  `\nRESULT: ${results.length - failed.length}/${results.length} checks passed, ${skips.length} skipped`
);
for (const [name, reason] of skips) console.log(`SKIP | ${name} — ${reason}`);
process.exit(failed.length === 0 ? 0 : 1);
