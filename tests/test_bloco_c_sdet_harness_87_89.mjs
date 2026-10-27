#!/usr/bin/env node
/**
 * SDET INDEPENDENTE — BLOCO C
 * TICKET-HARNESS-87 (Itens 1 e 2) + TICKET-HARNESS-89
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Suíte de validação independente do SDET (Hugo), executada ANTES do Quality
 * Gate. Não substitui as suítes entregues pelos implementadores — audita o
 * MESMO artefato por caminhos diferentes e mais próximos da realidade:
 *
 *   A. HARNESS-87/Item 1 — fallback de HOME do plugin embutido `ensemble`
 *      A1 HOME e USERPROFILE ausentes em SUBPROCESSO real → os.homedir()
 *      A2 HOME="~" literal → expandido para o home real
 *      A3 HOME="" é ignorado (|| e não ??)
 *      A4 ensureEnsembleConfigDirectory provisiona <home>/.config/opencode
 *      A5 HOME ausente + cwd isolado → cria no home do SO, nunca em ./~
 *      A6 a suíte entregue pelo implementador passa (bun test real)
 *      A7 MUTAÇÃO: reintroduzir `?? "~"` (pré-fix) faz A1/A3/A4 e a suíte
 *         entregue REPROVAREM; o arquivo é restaurado byte-a-byte (sha256)
 *
 *   B. HARNESS-87/Item 2 — exports publicados
 *      B1 `npm pack` REAL produz o tarball de publicação
 *      B2 tarball CONTÉM dist/index.js, dist/rpc.js, dist/tui.js e src/*
 *      B3 tarball NÃO carrega tests/ nem .github/ (higiene de pacote)
 *      B4 import.meta.resolve do CONSUMIDOR real (tarball extraído em
 *         node_modules) entrega dist/index.js, dist/rpc.js e dist/tui.js
 *      B5 node --check em todos os bundles do tarball
 *      B6 MUTAÇÃO: exports apontando para ./src/*.ts faz o resolvedor real
 *         entregar TypeScript cru (prova de sensibilidade)
 *      B7 build determinístico: `npm run build` não altera nenhum bundle
 *      B8 os 3 bundles estão RASTREADOS (git ls-files --error-unmatch) e
 *         dist/ não tem untracked nem drift — regressão do Portão 2 em que
 *         dist/rpc.js e dist/tui.js ficaram fora do commit (o
 *         `git diff --exit-code dist/` do CI é cego para untracked)
 *
 *   C. HARNESS-89 — pins de Node
 *      C1..C4 Bun.YAML.parse REAL dos 3 arquivos (matrix, check-latest,
 *             composite setup-bun) — sem regex sobre o texto
 *      C5 verificador real do opencode_repo: exit 0, "OK —", zero AVISO
 *      C6 baseline de fixture PINS_ROOT sem mutação → exit 0
 *      C7 pin flutuante "24" no composite → exit 1
 *      C8 pin vulnerável 26.4.0 em workflow → exit 1
 *      C9 pin de dois segmentos 24.16 → exit 1
 *      C10 pin exato NÃO citado (24.22.1) → exit 0 (sem falso positivo)
 *
 *   D. Anti-mock: as suítes do bloco não substituem dependências por stubs.
 *
 * SEM MOCKS: subprocessos reais (node/bun/npm/tar), YAML real do Bun,
 * tarball real do npm, resolvedor real do Node, arquivos reais.
 *
 * Uso: node tests/test_bloco_c_sdet_harness_87_89.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const ENSEMBLE = path.resolve(HERE, "..");
const OPENCODE =
  process.env.OPENCODE_REPO_DIR || path.resolve(ENSEMBLE, "..", "opencode_repo");

const CI_YML = path.join(ENSEMBLE, ".github", "workflows", "ci.yml");
const PUBLISH_YML = path.join(ENSEMBLE, ".github", "workflows", "publish.yml");
const SETUP_BUN = path.join(OPENCODE, ".github", "actions", "setup-bun", "action.yml");
const VERIFIER = path.join(OPENCODE, "script", "verify-node-version-pins.mjs");
const ENSEMBLE_TS = path.join(OPENCODE, "packages", "core", "src", "plugin", "builtin", "ensemble.ts");
const DELIVERED_HOME_TEST = path.join(OPENCODE, "packages", "core", "test", "builtin-ensemble-home-fallback.test.ts");
const DELIVERED_EXPORTS_TEST = path.join(ENSEMBLE, "tests", "test_ticket_harness_87_exports.mjs");
const DELIVERED_PINS_TEST = path.join(ENSEMBLE, "tests", "test_ticket_harness_89_node_pins.mjs");

const results = [];
const skips = [];
const check = (name, ok, detail = "") => {
  results.push([name, Boolean(ok)]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
};
const skip = (name, reason) => {
  skips.push([name, reason]);
  console.log(`SKIP | ${name} — ${reason}`);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", timeout: 180_000, ...opts });

const TMP = mkdtempSync(path.join(os.tmpdir(), "blococ-sdet-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

/* ===================================================================== *
 * A. HARNESS-87 / Item 1 — fallback de HOME (subprocesso REAL)
 * ===================================================================== */
console.log("\n=== A. HARNESS-87 Item 1: fallback de HOME ===");

const HOME_PROBE = path.join(TMP, "home-probe.mjs");
writeFileSync(
  HOME_PROBE,
  `import os from "node:os"
import fs from "node:fs"
import path from "node:path"
const cwd = process.cwd()
const cwdBeforeImport = fs.readdirSync(cwd)
const mod = await import(process.env.ENSEMBLE_MODULE_URL)
const cwdAfterImport = fs.readdirSync(cwd)
const scenario = process.env.SCENARIO
const out = { osHome: os.homedir(), realHome: process.env.EXPECTED_REAL_HOME, cwd, cwdBeforeImport, cwdAfterImport, home: mod.resolveEnsembleHomeDirectory() }
if (scenario === "ensure") {
  out.dir = mod.ensureEnsembleConfigDirectory()
  out.exists = fs.existsSync(out.dir)
  out.cwdEntries = fs.readdirSync(cwd)
  // Atribuição precisa: o Bun cria ./~/.bun/install/cache no IMPORT; o que é
  // do PRODUTO é ./~/.config/opencode (só existe se ensure... usar "~").
  out.tildeConfigExists = fs.existsSync(path.join(cwd, "~", ".config", "opencode"))
}
console.log(JSON.stringify(out))
`,
  "utf8",
);

const moduleUrl = pathToFileURL(ENSEMBLE_TS).href;
// Home REAL do SO por passwd, medido no processo Node pai (o os.homedir()/
// os.userInfo() do Node/Bun segue $HOME, então não serve de referência).
const NODE_REAL_HOME = os.userInfo().homedir;
const runHomeProbe = ({ scenario, home, userprofile, cwd }) => {
  const env = {
    ...process.env,
    ENSEMBLE_MODULE_URL: moduleUrl,
    SCENARIO: scenario,
    EXPECTED_REAL_HOME: NODE_REAL_HOME,
  };
  delete env.HOME;
  delete env.USERPROFILE;
  if (home !== undefined) env.HOME = home;
  if (userprofile !== undefined) env.USERPROFILE = userprofile;
  const r = run("bun", [HOME_PROBE], { cwd, env });
  let parsed = null;
  try {
    parsed = JSON.parse((r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "null");
  } catch {}
  return { ...r, parsed };
};

const cwdA = path.join(TMP, "cwd-a");
const cwdB = path.join(TMP, "cwd-b");
const cwdC = path.join(TMP, "cwd-c");
const cwdD = path.join(TMP, "cwd-d");
const cwdMut = path.join(TMP, "cwd-mut");
const cwdRel = path.join(TMP, "cwd-rel");
for (const d of [cwdA, cwdB, cwdC, cwdD, cwdMut, cwdRel]) mkdirSync(d, { recursive: true });

// A1 — HOME e USERPROFILE ausentes
const a1 = runHomeProbe({ scenario: "resolve", cwd: cwdA });
check(
  "A1 HOME ausente → os.homedir() real (subprocesso separate)",
  a1.status === 0 && a1.parsed && a1.parsed.home === a1.parsed.osHome && a1.parsed.home !== "~",
  JSON.stringify(a1.parsed ?? a1.stderr),
);

// A2 — HOME="~": o contrato declarado pelo fix é EXPANDIR para o home real do
// SO. Cwd DEDICADO. ATRIBUIÇÃO: o Bun cria ./~/.bun/install/cache no import
// (medido: cwdBeforeImport=[] → cwdAfterImport=["~"]); o que pertence ao
// PRODUTO é ./~/.config/opencode, que só nasce se ensure... usar "~".
const a2 = runHomeProbe({ scenario: "ensure", home: "~", cwd: cwdC });
check(
  "A2 HOME='~' literal → home REAL do SO e nunca ./~/.config/opencode no cwd",
  a2.status === 0 &&
    a2.parsed &&
    a2.parsed.home === a2.parsed.realHome &&
    a2.parsed.dir === path.join(a2.parsed.realHome, ".config", "opencode") &&
    path.isAbsolute(a2.parsed.dir) &&
    !a2.parsed.dir.startsWith(a2.parsed.cwd + path.sep) &&
    !a2.parsed.dir.includes("/~/") &&
    a2.parsed.tildeConfigExists === false,
  JSON.stringify({
    home: a2.parsed?.home,
    dir: a2.parsed?.dir,
    realHome: a2.parsed?.realHome,
    bunCacheOnly: a2.parsed?.cwdBeforeImport?.length === 0 && a2.parsed?.cwdAfterImport?.includes("~"),
    tildeConfigExists: a2.parsed?.tildeConfigExists,
  }),
);

// A2b — HOME="~/sub" também não pode virar caminho relativo literal
const a2b = runHomeProbe({ scenario: "resolve", home: "~/sub", cwd: cwdA });
check(
  "A2b HOME='~/sub' não vira caminho relativo literal",
  a2b.status === 0 && a2b.parsed && !a2b.parsed.home.startsWith("~"),
  JSON.stringify(a2b.parsed ?? a2b.stderr),
);

// A2c — HOME relativo SEM tilde (ex.: "relative/home"): com path.isAbsolute no
// predicado, nem o tilde nem qualquer relativo pode virar dir no cwd.
const a2c = runHomeProbe({ scenario: "ensure", home: "relative/home", cwd: cwdRel });
check(
  "A2c HOME relativo 'relative/home' rejeitado (isAbsolute) → home real, nada no cwd",
  a2c.status === 0 &&
    a2c.parsed &&
    a2c.parsed.home === a2c.parsed.realHome &&
    a2c.parsed.dir === path.join(a2c.parsed.realHome, ".config", "opencode") &&
    // Atribuição: `relative` no cwd é $HOME/.bun/install/cache do Bun no import.
    // O que seria do PRODUTO ao aceitar o relativo é relative/home/.config/opencode.
    !existsSync(path.join(cwdRel, "relative", "home", ".config", "opencode")),
  JSON.stringify({
    home: a2c.parsed?.home,
    dir: a2c.parsed?.dir,
    bunCache: existsSync(path.join(cwdRel, "relative", "home", ".bun")),
    productDir: existsSync(path.join(cwdRel, "relative", "home", ".config", "opencode")),
  }),
);

// A3 — HOME vazio é ignorado (||, não ??)
const upA = path.join(TMP, "userprofile-a");
const a3 = runHomeProbe({ scenario: "resolve", home: "", userprofile: upA, cwd: cwdA });
check(
  "A3 HOME='' ignorado em favor de USERPROFILE (|| não ??)",
  a3.status === 0 && a3.parsed && a3.parsed.home === upA,
  JSON.stringify(a3.parsed ?? a3.stderr),
);

// A4 — ensureEnsembleConfigDirectory hermético (cwd próprio, sem contaminação)
const upHome = path.join(TMP, "home-hermetic");
const a4 = runHomeProbe({ scenario: "ensure", home: "", userprofile: upHome, cwd: cwdD });
const a4dir = path.join(upHome, ".config", "opencode");
check(
  "A4 ensureEnsembleConfigDirectory provisiona <USERPROFILE>/.config/opencode",
  a4.status === 0 &&
    a4.parsed &&
    a4.parsed.dir === a4dir &&
    a4.parsed.exists === true &&
    !a4.parsed.cwdEntries.includes("~"),
  JSON.stringify(a4.parsed ?? a4.stderr),
);

// A5 — HOME ausente de verdade: usa o home do SO, nunca ./~ no cwd
const realConfig = path.join(os.homedir(), ".config", "opencode");
if (existsSync(realConfig)) {
  const a5 = runHomeProbe({ scenario: "ensure", cwd: cwdB });
  check(
    "A5 HOME ausente → cria no home do SO (nunca ./~ no cwd)",
    a5.status === 0 &&
      a5.parsed &&
      a5.parsed.dir === path.join(a5.parsed.osHome, ".config", "opencode") &&
      a5.parsed.exists === true &&
      !a5.parsed.cwdEntries.includes("~"),
    JSON.stringify(a5.parsed ?? a5.stderr),
  );
} else {
  // Evita efeito colateral em um home real sem a pasta (não cria recurso do produto).
  skip("A5 HOME ausente → cria no home do SO", `${realConfig} inexistente; cenário hermético A4 já cobre`);
}

// A6 — suíte entregue pelo implementador
const a6 = run("bun", ["test", "test/builtin-ensemble-home-fallback.test.ts"], {
  cwd: path.join(OPENCODE, "packages", "core"),
});
const a6out = `${a6.stdout ?? ""}${a6.stderr ?? ""}`;
check(
  "A6 suíte entregue (bun test) verde: 4 pass / 0 fail",
  a6.status === 0 && /\b4 pass\b/.test(a6out) && /\b0 fail\b/.test(a6out),
  `exit=${a6.status} ${a6out.split("\n").filter((l) => /pass|fail/.test(l)).join(" | ")}`,
);

// A7 — MUTAÇÃO reversível: aceitar "~"/"~/..." de novo (comportamento pré-fix).
// O fix atual usa o predicado `isUsableHome`; neutralizá-lo reproduz exatamente
// o defeito original (HOME="~" aceito → dir relativo → ./~/.config/opencode).
const ENSEMBLE_ORIGINAL = readFileSync(ENSEMBLE_TS);
const ensembleHash = sha256(ENSEMBLE_ORIGINAL);
const originalText = ENSEMBLE_ORIGINAL.toString("utf8");
const PREDICATE = 'return Boolean(candidate) && path.isAbsolute(candidate)';
const iPred = originalText.indexOf(PREDICATE);
const predOccurrences = iPred < 0 ? 0 : originalText.split(PREDICATE).length - 1;
let mutationApplied = false;
try {
  if (iPred < 0) {
    check("A7 mutação do predicado `isUsableHome` reprovada (sensibilidade)", false, "predicado do fix não localizado");
  } else {
    writeFileSync(
      ENSEMBLE_TS,
      originalText.slice(0, iPred) + "return Boolean(candidate)" + originalText.slice(iPred + PREDICATE.length),
      "utf8",
    );
    mutationApplied = true;

    const m2 = runHomeProbe({ scenario: "ensure", home: "~", cwd: cwdMut }); // aceita "~" e cria ./~
    const m2b = runHomeProbe({ scenario: "resolve", home: "~/sub", cwd: cwdA }); // devolve relativo
    const mSuite = run("bun", ["test", "test/builtin-ensemble-home-fallback.test.ts"], {
      cwd: path.join(OPENCODE, "packages", "core"),
    });
    const mSuiteOut = `${mSuite.stdout ?? ""}${mSuite.stderr ?? ""}`;

    const m2Detected =
      m2.parsed?.home === "~" && m2.parsed?.dir === path.join("~", ".config", "opencode") && m2.parsed?.tildeConfigExists === true;
    const m2bDetected = m2b.parsed?.home === "~/sub";
    const suiteDetected = mSuite.status !== 0 && /\b[1-9]\d* fail\b/.test(mSuiteOut);
    check(
      "A7 mutação do predicado `isUsableHome` reprovada (sensibilidade)",
      predOccurrences === 1 && m2Detected && m2bDetected && suiteDetected,
      JSON.stringify({
        occurrences: predOccurrences,
        home: m2.parsed?.home,
        dir: m2.parsed?.dir,
        tildeConfig: m2.parsed?.tildeConfigExists,
        nested: m2b.parsed?.home,
        suiteExit: mSuite.status,
      }),
    );
  }
} finally {
  if (mutationApplied) writeFileSync(ENSEMBLE_TS, ENSEMBLE_ORIGINAL);
  check(
    "A7b ensemble.ts restaurado byte-a-byte após a mutação",
    sha256(readFileSync(ENSEMBLE_TS)) === ensembleHash,
    `sha256=${ensembleHash.slice(0, 16)}…`,
  );
}

/* ===================================================================== *
 * B. HARNESS-87 / Item 2 — exports publicados (tarball REAL do npm)
 * ===================================================================== */
console.log("\n=== B. HARNESS-87 Item 2: exports do pacote publicado ===");

const packDir = path.join(TMP, "pack");
mkdirSync(packDir, { recursive: true });
const pack = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: ENSEMBLE });
let packMeta = null;
try {
  packMeta = JSON.parse((pack.stdout ?? "").trim())[0] ?? null;
} catch {}
check(
  "B1 npm pack real produz tarball de publicação",
  pack.status === 0 && packMeta && existsSync(path.join(packDir, packMeta.filename)),
  pack.status !== 0 ? (pack.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" | ") : packMeta?.filename,
);

const tarball = packMeta ? path.join(packDir, packMeta.filename) : null;
const packedFiles = new Set((packMeta?.files ?? []).map((f) => f.path));
const mustShip = ["package.json", "dist/index.js", "dist/rpc.js", "dist/tui.js", "src/index.ts"];
const missingShip = tarball ? mustShip.filter((f) => !packedFiles.has(f)) : mustShip;
check(
  "B2 tarball contém os 3 bundles + package.json + tipos src",
  Boolean(tarball) && missingShip.length === 0,
  JSON.stringify({ missing: missingShip, total: packedFiles.size }),
);
const leaked = [...packedFiles].filter((f) => /^(tests|\.github)\//.test(f));
check("B3 tarball não vaza tests/ nem .github/", Boolean(tarball) && leaked.length === 0, JSON.stringify(leaked));

const consumer = path.join(TMP, "consumer");
const installed = path.join(consumer, "node_modules", "@maiteuxzanela", "ensemble-room-lowcost");
if (tarball) {
  mkdirSync(installed, { recursive: true });
  const untar = run("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed]);
  check("B4 tarball extraído num node_modules de consumidor real", untar.status === 0, untar.stderr?.trim() ?? "");
}

const resolveSpec = (spec) => {
  const r = run(process.execPath, ["--input-type=module", "-e", `process.stdout.write(import.meta.resolve(${JSON.stringify(spec)}))`], {
    cwd: consumer,
  });
  return { status: r.status, url: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
};

const spec = "@maiteuxzanela/ensemble-room-lowcost";
const rRoot = resolveSpec(spec);
const rRpc = resolveSpec(`${spec}/rpc`);
const rTui = resolveSpec(`${spec}/tui`);
check(
  "B4 import.meta.resolve(root) → dist/index.js no tarball extraído",
  rRoot.status === 0 && rRoot.url.endsWith("/dist/index.js") && !rRoot.url.includes("/src/"),
  rRoot.url || rRoot.err,
);
check(
  "B4 import.meta.resolve(./rpc) → dist/rpc.js; (./tui) → dist/tui.js",
  rRpc.status === 0 &&
    rRpc.url.endsWith("/dist/rpc.js") &&
    rTui.status === 0 &&
    rTui.url.endsWith("/dist/tui.js") &&
    !rRpc.url.includes("/src/") &&
    !rTui.url.includes("/src/"),
  JSON.stringify({ rpc: rRpc.url, tui: rTui.url }),
);

const bundles = ["dist/index.js", "dist/rpc.js", "dist/tui.js"].map((f) => path.join(installed, f));
const checkResults = bundles.map((f) => (existsSync(f) ? run(process.execPath, ["--check", f]).status : 127));
check(
  "B5 node --check em todos os bundles do tarball (runtime Node puro)",
  checkResults.every((s) => s === 0),
  JSON.stringify(bundles.map((b, i) => `${path.basename(b)}=${checkResults[i]}`)),
);

// B6 — MUTAÇÃO: exports de runtime apontando para TypeScript cru
if (tarball) {
  const pkgPath = path.join(installed, "package.json");
  const installedPkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  installedPkg.exports = {
    ".": { types: "./src/index.ts", import: "./src/index.ts", default: "./src/index.ts" },
    "./rpc": { types: "./src/rpc.ts", import: "./src/rpc.ts", default: "./src/rpc.ts" },
    "./tui": { types: "./src/tui.tsx", import: "./src/tui.tsx", default: "./src/tui.tsx" },
    "./package.json": "./package.json",
  };
  writeFileSync(pkgPath, JSON.stringify(installedPkg, null, 2));
  const mutRoot = resolveSpec(spec);
  const mutRpc = resolveSpec(`${spec}/rpc`);
  check(
    "B6 mutação: resolvedor real entrega .ts/.tsx cru (EX2/EX3 reprovariam)",
    mutRoot.url.endsWith("/src/index.ts") && mutRpc.url.endsWith("/src/rpc.ts"),
    JSON.stringify({ root: mutRoot.url.split("/node_modules/").pop(), rpc: mutRpc.url.split("/node_modules/").pop() }),
  );
}

// B7 — build determinístico (o CI tem gate `git diff --exit-code dist/`)
const distFiles = ["index.js", "rpc.js", "tui.js"].map((f) => path.join(ENSEMBLE, "dist", f));
const before = distFiles.map((f) => (existsSync(f) ? sha256(readFileSync(f)) : null));
const build = run("npm", ["run", "build"], { cwd: ENSEMBLE });
const after = distFiles.map((f) => (existsSync(f) ? sha256(readFileSync(f)) : null));
check(
  "B7 `npm run build` reproduz os bundles byte-a-byte (gate de drift do CI)",
  build.status === 0 && before.every((h, i) => h && h === after[i]),
  `exit=${build.status} ${distFiles.map((f, i) => `${path.basename(f)}=${before[i] === after[i] ? "stable" : "DRIFT"}`).join(",")}`,
);

// B8 — os bundles estão RASTREADOS no Git (regressão do Portão 2: dist/rpc.js e
// dist/tui.js ficaram untracked fora do commit e `git diff --exit-code dist/` é
// CEGO para untracked). Em checkout limpo de CI o porcelain é vazio; antes do
// commit do Portão 1 admite-se apenas a ADIÇÃO STAGED dos bundles novos.
const gitCmd = (args) => run("git", args, { cwd: ENSEMBLE });
const bundlesRel = ["dist/index.js", "dist/rpc.js", "dist/tui.js"];
const trackedRes = gitCmd(["ls-files", "--error-unmatch", ...bundlesRel]);
check(
  "B8 dist/index.js, dist/rpc.js e dist/tui.js RASTREADOS (git ls-files --error-unmatch, exit 0)",
  trackedRes.status === 0,
  (trackedRes.stderr ?? "").trim() || (trackedRes.stdout ?? "").trim(),
);
const porcelainRes = gitCmd(["status", "--porcelain", "dist/"]);
const porcelainLines = (porcelainRes.stdout ?? "").split("\n").filter(Boolean);
const untrackedDist = porcelainLines.filter((l) => l.startsWith("??"));
check(
  "B8 dist/ sem arquivos UNTRACKED (o buraco que `git diff --exit-code` não vê)",
  porcelainRes.status === 0 && untrackedDist.length === 0,
  JSON.stringify({ porcelain: porcelainLines, untracked: untrackedDist }),
);
const unexpectedDist = porcelainLines.filter((l) => !/^A\s/.test(l));
check(
  "B8 dist/ sem drift de worktree (pós-commit vazio; pré-commit só adições staged)",
  porcelainRes.status === 0 && unexpectedDist.length === 0,
  JSON.stringify(porcelainLines),
);

/* ===================================================================== *
 * C. HARNESS-89 — pins de Node (YAML REAL do Bun + verificador real)
 * ===================================================================== */
console.log("\n=== C. HARNESS-89: pins de Node ===");

const YAML_PROBE = path.join(TMP, "yaml-probe.mjs");
writeFileSync(
  YAML_PROBE,
  `import { readFileSync } from "node:fs"
const files = JSON.parse(process.env.PROBE_FILES)
const out = {}
for (const [k, f] of Object.entries(files)) out[k] = Bun.YAML.parse(readFileSync(f, "utf8"))
console.log(JSON.stringify(out))
`,
  "utf8",
);
const yamlRun = run("bun", [YAML_PROBE], {
  env: { ...process.env, PROBE_FILES: JSON.stringify({ ci: CI_YML, publish: PUBLISH_YML, action: SETUP_BUN }) },
});
let yaml = null;
try {
  yaml = JSON.parse((yamlRun.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "null");
} catch {}
check("C0 Bun.YAML.parse lê os 3 YAMLs reais", yamlRun.status === 0 && yaml && yaml.ci && yaml.publish && yaml.action, yamlRun.stderr?.trim() ?? "");

const findStep = (doc, uses) =>
  (doc?.jobs ? Object.values(doc.jobs).flatMap((j) => j.steps ?? []) : (doc?.runs?.steps ?? [])).find((s) =>
    String(s?.uses ?? "").startsWith(uses),
  );
const ciMatrix = yaml?.ci?.jobs?.["deterministic-suite"]?.strategy?.matrix?.node;
const ciSetup = findStep(yaml?.ci, "actions/setup-node");
const pubSetup = findStep(yaml?.publish, "actions/setup-node");
const bunSetup = findStep(yaml?.action, "actions/setup-node");
const exactPin = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);

check(
  "C1 ci matrix é EXATAMENTE ['22.23.4','24.22.1'] (YAML parseado)",
  Array.isArray(ciMatrix) &&
    ciMatrix.length === 2 &&
    ciMatrix[0] === "22.23.4" &&
    ciMatrix[1] === "24.22.1" &&
    ciMatrix.every(exactPin),
  JSON.stringify(ciMatrix),
);
check(
  "C2 ci setup-node: node-version da matrix + check-latest: true (boolean)",
  ciSetup?.with?.["node-version"] === "${{ matrix.node }}" && ciSetup?.with?.["check-latest"] === true,
  JSON.stringify(ciSetup?.with),
);
check(
  "C3 publish setup-node: node-version '22.23.4' + check-latest: true",
  pubSetup?.with?.["node-version"] === "22.23.4" && pubSetup?.with?.["check-latest"] === true,
  JSON.stringify(pubSetup?.with),
);
check(
  "C4 composite setup-bun: using=composite e node-version '24.22.1' (sem flutuante)",
  yaml?.action?.runs?.using === "composite" && bunSetup?.with?.["node-version"] === "24.22.1",
  JSON.stringify({ using: yaml?.action?.runs?.using, with: bunSetup?.with }),
);

const runVerifier = (pinsRoot) =>
  run("bun", [VERIFIER], {
    env: pinsRoot ? { ...process.env, PINS_ROOT: pinsRoot } : process.env,
  });

const real = runVerifier(null);
check(
  "C5 verificador real: exit 0, 'OK —', zero AVISO",
  real.status === 0 && /^OK —/m.test(real.stdout ?? "") && !/^AVISO/m.test(real.stdout ?? "") && (real.stderr ?? "").trim() === "",
  `exit=${real.status} ${(real.stdout ?? "").trim().slice(0, 200)}${(real.stderr ?? "").trim() ? ` ERR:${real.stderr.trim().slice(0, 160)}` : ""}`,
);

// Fixture REAL: cópia de .github + package.json (o verificador lê ambos)
const pins = path.join(TMP, "pins");
cpSync(path.join(OPENCODE, ".github"), path.join(pins, ".github"), { recursive: true });
cpSync(path.join(OPENCODE, "package.json"), path.join(pins, "package.json"));
const mutAction = path.join(pins, ".github", "actions", "setup-bun", "action.yml");
const mutPublish = path.join(pins, ".github", "workflows", "publish.yml");
const actionOrig = readFileSync(mutAction, "utf8");
const publishOrig = readFileSync(mutPublish, "utf8");

const base = runVerifier(pins);
check("C6 fixture íntegra (controle) → exit 0", base.status === 0, `exit=${base.status}`);

writeFileSync(mutAction, actionOrig.replace('node-version: "24.22.1"', 'node-version: "24"'));
const c7 = runVerifier(pins);
check(
  "C7 pin flutuante '24' no composite → exit 1 (allowlist e X.Y.Z)",
  c7.status === 1 && /fora da allowlist/.test(c7.stderr ?? "") && /X\.Y\.Z/.test(c7.stderr ?? ""),
  `exit=${c7.status}`,
);

writeFileSync(mutAction, actionOrig.replace('node-version: "24.22.1"', 'node-version: "24.16"'));
const c9 = runVerifier(pins);
check(
  "C9 pin de dois segmentos 24.16 → exit 1 (sem pin exato)",
  c9.status === 1 && /X\.Y\.Z/.test(c9.stderr ?? ""),
  `exit=${c9.status}`,
);

writeFileSync(mutAction, actionOrig.replace('node-version: "24.22.1"', "node-version: 24.22.1"));
const c10 = runVerifier(pins);
check(
  "C10 pin exato NÃO citado (24.22.1) → exit 0 (sem falso positivo)",
  c10.status === 0,
  `exit=${c10.status} ${(c10.stderr ?? "").trim().slice(0, 120)}`,
);
writeFileSync(mutAction, actionOrig);

writeFileSync(mutPublish, publishOrig.replace('node-version: "26.12.1"', 'node-version: "26.4.0"'));
const c8 = runVerifier(pins);
check(
  "C8 versão vulnerável 26.4.0 num workflow → exit 1 (bloqueante)",
  c8.status === 1 && /vulner[aá]vel/.test(c8.stderr ?? "") && /fora da allowlist/.test(c8.stderr ?? ""),
  `exit=${c8.status}`,
);
writeFileSync(mutPublish, publishOrig);

/* ===================================================================== *
 * D. Anti-mock + integração das suítes entregues
 * ===================================================================== */
console.log("\n=== D. Anti-mock e integração ===");

const MOCK_PATTERN = /\b(jest\.mock|sinon\.(stub|spy|mock)|vi\.mock|unittest\.mock|MagicMock|mock\.patch)\s*\(/;
const scanned = [DELIVERED_HOME_TEST, DELIVERED_EXPORTS_TEST, DELIVERED_PINS_TEST, import.meta.filename].filter((f) =>
  existsSync(f),
);
const offenders = scanned.filter((f) => MOCK_PATTERN.test(readFileSync(f, "utf8")));
check(
  "D1 suítes do bloco não usam mocks/stubs (varredura estática)",
  offenders.length === 0,
  JSON.stringify(offenders.map((f) => path.basename(f))),
);

const delivered87 = run(process.execPath, [DELIVERED_EXPORTS_TEST], { cwd: ENSEMBLE });
check(
  "D2 suíte entregue HARNESS-87 (exports) verde",
  delivered87.status === 0 && /all checks passed/.test(delivered87.stdout ?? ""),
  `exit=${delivered87.status}`,
);
const delivered89 = run(process.execPath, [DELIVERED_PINS_TEST], { cwd: ENSEMBLE });
check(
  "D3 suíte entregue HARNESS-89 (pins) verde: 12/12 sem skip",
  delivered89.status === 0 && /12\/12 checks passed, 0 skipped/.test(delivered89.stdout ?? ""),
  `exit=${delivered89.status}`,
);

/* ===================================================================== *
 * Relatório
 * ===================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed, ${skips.length} skipped`);
for (const [name, ok] of failed) console.log(`FAILED: ${name}`);
for (const [name, reason] of skips) console.log(`SKIP: ${name} — ${reason}`);
process.exit(failed.length === 0 ? 0 : 1);
