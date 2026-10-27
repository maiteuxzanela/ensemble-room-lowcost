#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-87 (Item 2)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Defeito sob teste (ressalva do Portão 2, 22/10/2026):
 *   O `package.json` publicado (commit pinado `486d2fc`, v0.18.1) declarava
 *   `"exports": { ".": "./src/index.ts" }`. Em Node.js ESM `exports` tem
 *   precedência sobre `main`, então o resolvedor tentava carregar TypeScript
 *   cru de dentro de `node_modules` — que o Node RECUSA — e o plugin embutido
 *   caía silenciosamente no `Effect.logWarning` de `ensemble.ts`. Funcionava
 *   só sob Bun (TS nativo), mascarando o defeito.
 *
 * Contrato sob teste:
 *   EX1  `exports["."]` entrega o bundle compilado ao runtime Node
 *        (`import`/`default` → `./dist/index.js`) e mantém os tipos em
 *        `./src/index.ts` para consumidores TypeScript.
 *   EX2  O RESOLVEDOR REAL do Node (`import.meta.resolve`) instala o pacote
 *        num layout de `node_modules` e resolve o especificador raiz para
 *        `dist/index.js` — nunca para um `.ts`.
 *   EX3  Os subpaths `./rpc` e `./tui` também resolvem para bundles
 *        compilados (`dist/rpc.js`, `dist/tui.js`), não para `.ts`/`.tsx`.
 *   EX4  Nenhuma condição de RUNTIME (`import`/`default`/`node`/string) de
 *        nenhum subpath aponta para TypeScript cru; `types` é a única
 *        condição que pode apontar para `src/`.
 *   EX5  Todo alvo de `exports` existe no disco e cada bundle de runtime
 *        passa em `node --check` (parse real do Node, exit 0).
 *   EX6  Sensibilidade do gate (prova de mutação): com o `package.json`
 *        PRÉ-FIX (`".": "./src/index.ts"`, subpaths em `.ts`), o mesmo
 *        resolvedor real entrega um arquivo `.ts` — ou seja, EX2/EX3
 *        reprovariam a versão pinada que a Diana apontou.
 *   EX7  Os 3 bundles estão RASTREADOS (`git ls-files --error-unmatch`) e
 *        `dist/` não tem untracked nem drift de worktree — fecha a regressão
 *        do Portão 2 em que `dist/rpc.js` e `dist/tui.js` ficaram fora do
 *        commit porque `git diff --exit-code dist/` é cego para untracked.
 *
 * SEM MOCKS: `package.json` REAL do repositório, arquivos REALMENTE
 * publicados (mesma lista de `files`), resolvedor REAL do Node
 * (`import.meta.resolve`) e `node --check` REAL. Nenhuma lógica é substituída.
 *
 * Uso: node tests/test_ticket_harness_87_exports.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const PKG = path.resolve(import.meta.dirname, "..");
const SCRATCH = path.join(PKG, ".test-scratch", "harness87_exports");

const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, Boolean(ok)]);
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ""}`);
};

const readPkg = (file) => JSON.parse(readFileSync(file, "utf8"));
const pkg = readPkg(path.join(PKG, "package.json"));
const exps = pkg.exports ?? {};

/* ------------------------------------------------------------------ *
 * EX1. Contrato da entry raiz (runtime → dist, tipos → src)
 * ------------------------------------------------------------------ */
const root = exps["."];
check(
  "EX1 exports['.'] é objeto com condição de runtime",
  root && typeof root === "object" && !Array.isArray(root),
  JSON.stringify(root),
);
check(
  "EX1 exports['.'].import → ./dist/index.js (bundle compilado)",
  root?.import === "./dist/index.js",
  JSON.stringify(root?.import),
);
check(
  "EX1 exports['.'].default → ./dist/index.js (bundle compilado)",
  root?.default === "./dist/index.js",
  JSON.stringify(root?.default),
);
check(
  "EX1 exports['.'].types → ./src/index.ts (tipos preservados para TS)",
  root?.types === "./src/index.ts",
  JSON.stringify(root?.types),
);
check(
  "EX1 pacote continua type:module e main/module no bundle compilado",
  pkg.type === "module" && pkg.main === "dist/index.js" && pkg.module === "dist/index.js",
  JSON.stringify({ type: pkg.type, main: pkg.main, module: pkg.module }),
);

/* ------------------------------------------------------------------ *
 * EX4 (estático). Nenhuma condição de runtime aponta para TypeScript cru
 * ------------------------------------------------------------------ */
const leaves = (node, condition = "runtime") =>
  typeof node === "string"
    ? [{ condition, target: node }]
    : Object.entries(node ?? {}).flatMap(([key, value]) => leaves(value, key));

const allLeaves = Object.entries(exps).flatMap(([subpath, node]) =>
  leaves(node).map((leaf) => ({ subpath, ...leaf })),
);
const runtimeLeaves = allLeaves.filter((leaf) => leaf.condition !== "types");
const rawTs = runtimeLeaves.filter((leaf) => /\.tsx?$/.test(leaf.target));
check(
  "EX4 nenhuma condição de runtime de exports aponta para .ts/.tsx",
  rawTs.length === 0,
  JSON.stringify(rawTs),
);
check(
  "EX4 subpaths rpc/tui declarados e resolvidos por condição de runtime",
  runtimeLeaves.some((l) => l.subpath === "./rpc") && runtimeLeaves.some((l) => l.subpath === "./tui"),
  JSON.stringify(runtimeLeaves.map((l) => `${l.subpath}:${l.condition}`)),
);

/* ------------------------------------------------------------------ *
 * EX5 (estático). Todo alvo existe no disco
 * ------------------------------------------------------------------ */
const missing = allLeaves.filter((leaf) => !existsSync(path.join(PKG, leaf.target)));
check("EX5 todos os alvos de exports existem no disco", missing.length === 0, JSON.stringify(missing));

/* ------------------------------------------------------------------ *
 * Layout de consumidor: cópia REAL do que `files` publica
 * ------------------------------------------------------------------ */
const consumer = (name) => {
  const dir = path.join(SCRATCH, name);
  const installed = path.join(dir, "node_modules", "@maiteuxzanela", "ensemble-room-lowcost");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  // npm always publishes package.json regardless of `files`.
  const published = [...new Set(["package.json", ...(pkg.files ?? [])])];
  for (const entry of published) {
    const from = path.join(PKG, entry);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(installed, entry), { recursive: true });
  }
  writeFileSync(
    path.join(dir, "probe.mjs"),
    [
      "const out = { ok: true }",
      "try {",
      "  out.resolved = import.meta.resolve(process.argv[2])",
      "} catch (error) {",
      "  out.ok = false",
      "  out.error = String(error && error.message ? error.message : error)",
      "}",
      "process.stdout.write(JSON.stringify(out))",
      "",
    ].join("\n"),
  );
  return { dir, installed };
};

const resolveSpec = ({ dir }, spec) => {
  const run = spawnSync(process.execPath, ["probe.mjs", spec], { cwd: dir, encoding: "utf8" });
  if (run.status !== 0) return { ok: false, error: `probe exit ${run.status}: ${run.stderr}`.trim() };
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { ok: false, error: `unparsable probe output: ${run.stdout}` };
  }
};

rmSync(SCRATCH, { recursive: true, force: true });
const fixed = consumer("fixed");

/* ------------------------------------------------------------------ *
 * EX2. Resolvedor REAL do Node na entry raiz
 * ------------------------------------------------------------------ */
const rootResolved = resolveSpec(fixed, "@maiteuxzanela/ensemble-room-lowcost");
const rootPath = rootResolved.ok ? rootResolved.resolved : "";
check(
  "EX2 import.meta.resolve(PACOTE) resolve com sucesso sob Node ESM",
  rootResolved.ok === true,
  rootResolved.error ?? rootResolved.resolved,
);
check(
  "EX2 resolução raiz cai dentro de node_modules/@maiteuxzanela/ensemble-room-lowcost/dist/index.js",
  rootPath.startsWith("file://") &&
    rootPath.includes("/node_modules/@maiteuxzanela/ensemble-room-lowcost/dist/index.js"),
  rootPath,
);
check("EX2 resolução raiz NUNCA entrega TypeScript cru", !/\.tsx?$/.test(rootPath), rootPath);
check("EX2 arquivo resolvido existe no disco do consumidor", rootPath.startsWith("file://") && existsSync(new URL(rootPath)), rootPath);

/* ------------------------------------------------------------------ *
 * EX3. Subpaths rpc/tui no resolvedor real
 * ------------------------------------------------------------------ */
const rpcResolved = resolveSpec(fixed, "@maiteuxzanela/ensemble-room-lowcost/rpc");
const tuiResolved = resolveSpec(fixed, "@maiteuxzanela/ensemble-room-lowcost/tui");
check(
  "EX3 subpath ./rpc resolve para dist/rpc.js",
  rpcResolved.ok === true && rpcResolved.resolved.endsWith("/dist/rpc.js"),
  rpcResolved.error ?? rpcResolved.resolved,
);
check(
  "EX3 subpath ./tui resolve para dist/tui.js",
  tuiResolved.ok === true && tuiResolved.resolved.endsWith("/dist/tui.js"),
  tuiResolved.error ?? tuiResolved.resolved,
);
check(
  "EX3 subpaths NUNCA entregam .ts/.tsx ao Node",
  !/\.tsx?$/.test(rpcResolved.resolved ?? "") && !/\.tsx?$/.test(tuiResolved.resolved ?? ""),
  `${rpcResolved.resolved} | ${tuiResolved.resolved}`,
);

/* ------------------------------------------------------------------ *
 * EX5 (dinâmico). `node --check` em cada bundle de runtime
 * ------------------------------------------------------------------ */
const runtimeTargets = [...new Set(runtimeLeaves.map((leaf) => leaf.target))].filter(
  (t) => !t.endsWith(".json") && existsSync(path.join(PKG, t)),
);
for (const target of runtimeTargets) {
  const run = spawnSync(process.execPath, ["--check", path.join(PKG, target)], { encoding: "utf8" });
  check(`EX5 node --check ${target}`, run.status === 0, (run.stderr ?? "").trim().split("\n")[0] ?? "");
}

/* ------------------------------------------------------------------ *
 * EX6. Sensibilidade: o pacote PRÉ-FIX (pin 486d2fc) é reprovado
 * ------------------------------------------------------------------ */
const broken = consumer("broken");
const brokenPkgPath = path.join(broken.installed, "package.json");
const brokenPkg = readPkg(brokenPkgPath);
brokenPkg.exports = {
  ".": "./src/index.ts",
  "./rpc": "./src/rpc.ts",
  "./tui": "./src/tui.tsx",
};
writeFileSync(brokenPkgPath, `${JSON.stringify(brokenPkg, null, 2)}\n`);

const brokenRoot = resolveSpec(broken, "@maiteuxzanela/ensemble-room-lowcost");
check(
  "EX6 mutante (exports['.'] = ./src/index.ts) é DETECTADO: resolvedor entrega arquivo TypeScript",
  brokenRoot.ok === true && /\.ts$/.test(brokenRoot.resolved ?? ""),
  brokenRoot.error ?? brokenRoot.resolved,
);
check(
  "EX6 mutante reprova EX2 (não cai em dist/index.js)",
  !(brokenRoot.resolved ?? "").includes("/dist/index.js"),
  brokenRoot.resolved,
);
const brokenRpc = resolveSpec(broken, "@maiteuxzanela/ensemble-room-lowcost/rpc");
check(
  "EX6 mutante reprova EX3 (subpath ./rpc entrega .ts cru)",
  /\.ts$/.test(brokenRpc.resolved ?? ""),
  brokenRpc.error ?? brokenRpc.resolved,
);

rmSync(SCRATCH, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * EX7. Os bundles estão RASTREADOS no Git e dist/ não tem untracked
 *      (regressão do Portão 2: dist/rpc.js e dist/tui.js ficaram
 *      untracked fora do commit e `git diff --exit-code dist/` é CEGO
 *      para untracked). Em checkout limpo de CI o porcelain é vazio;
 *      antes do commit do Portão 1 admite-se apenas a ADIÇÃO STAGED.
 * ------------------------------------------------------------------ */
const git = (args) => spawnSync("git", args, { cwd: PKG, encoding: "utf8" });
const BUNDLES = ["dist/index.js", "dist/rpc.js", "dist/tui.js"];

const tracked = git(["ls-files", "--error-unmatch", ...BUNDLES]);
check(
  "EX7 git ls-files --error-unmatch dist/index.js dist/rpc.js dist/tui.js (os 3 rastreados)",
  tracked.status === 0,
  ((tracked.stderr ?? "").trim() || (tracked.stdout ?? "").trim()) || "",
);

const porcelainRun = git(["status", "--porcelain", "dist/"]);
const porcelain = (porcelainRun.stdout ?? "").split("\n").filter(Boolean);
const untrackedBundles = porcelain.filter((line) => line.startsWith("??"));
check(
  "EX7 dist/ sem UNTRACKED (o buraco que `git diff --exit-code` não vê)",
  porcelainRun.status === 0 && untrackedBundles.length === 0,
  JSON.stringify({ porcelain, untracked: untrackedBundles }),
);
check(
  "EX7 dist/ sem drift de worktree (pós-commit vazio; pré-commit só adições staged)",
  porcelainRun.status === 0 && porcelain.filter((line) => !/^A\s/.test(line)).length === 0,
  JSON.stringify(porcelain),
);

/* ------------------------------------------------------------------ *
 * Resultado
 * ------------------------------------------------------------------ */
const failed = results.filter(([, ok]) => !ok);
console.log("-".repeat(78));
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`RESULT: ${failed.length} FAILURE(S)`);
  process.exit(1);
}
console.log("RESULT: all checks passed");
process.exit(0);
