#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Schema de fallback de modelo
 * (fallbackModels + modelFallback) do @maiteuxzanela/ensemble-room-lowcost.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/config.ts          → DEFAULT_CONFIG, DEFAULT_MODEL_FALLBACK,
 *                              parseModelSelector, formatModelSelector,
 *                              resolveFallbackChain, selectFallbackModel,
 *                              loadConfig (leitura real de ensemble.json em
 *                              HOME temporário isolado — sem fixture falsa de
 *                              parser: o arquivo é JSON de verdade em disco).
 *   - src/member-model.ts    → parseModelId (strip de "#variant").
 *   - dist/index.js          → paridade byte-funcional do bundle real (mesmas
 *                              asserções centrais aplicadas ao harness do dist).
 *
 * Único ponto de emenda do dist: cláusulas de export anexadas à cópia do
 * bundle (mesmo padrão homologado em test_watchdog_heartbeat.mjs). Nenhuma
 * lógica de decisão é substituída: sem mock library, sem stub de banco.
 *
 * Uso:  node tests/test_fallback_models.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: cópia byte-a-byte + apenas cláusulas de export  *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_fallback_harness.mjs");
const DIST_EXPORTS = [
  "loadConfig", "DEFAULT_CONFIG", "DEFAULT_MODEL_FALLBACK",
  "parseModelSelector", "formatModelSelector", "resolveFallbackChain",
  "selectFallbackModel", "parseModelId",
];
{
  const distRaw = readFileSync(DIST, "utf8");
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = DIST_EXPORTS.filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
  check(
    "harness do dist é o bundle real + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + append,
    `${distRaw.length} bytes de bundle; anexados=[${need.join(",")}]`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules (type-stripping do    *
 *    Node recusa node_modules) + resolução mecânica de extensão .ts    *
 * ------------------------------------------------------------------ */
const SRC_COPY = path.join(TMP, "ensemble_src_fallback");
{
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const next = text.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, a, spec, c) => {
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        try {
          const target = path.resolve(path.dirname(file), spec + ext);
          readFileSync(target);
          rewritten++;
          return a + spec + ext + c;
        } catch { /* tenta próximo */ }
      }
      return m;
    });
    if (next !== text) writeFileSync(file, next);
  }
  check("cópia do src preparada (só extensão de import, lógica intacta)", rewritten > 0, `${rewritten} specifiers`);
}

/* ------------------------------------------------------------------ *
 * 3. Imports dos módulos reais (src copiado + bundle do dist)         *
 * ------------------------------------------------------------------ */
const srcConfig = await import(`${SRC_COPY}/config.ts`);
const srcMemberModel = await import(`${SRC_COPY}/member-model.ts`);
const distMod = await import(HARNESS);
check(
  "módulos reais carregados (src/config.ts, src/member-model.ts, dist/index.js)",
  typeof srcConfig.loadConfig === "function" && typeof srcMemberModel.parseModelId === "function" && typeof distMod.loadConfig === "function",
);

/* ------------------------------------------------------------------ *
 * 4. parseModelSelector — seletor OpenCode "provider/model#variant"   *
 * ------------------------------------------------------------------ */
check(
  "parseModelSelector: provider/model simples",
  eq(srcConfig.parseModelSelector("google/antigravity-gemini-3.8-flash"), { providerID: "google", modelID: "antigravity-gemini-3.8-flash" }),
  JSON.stringify(srcConfig.parseModelSelector("google/antigravity-gemini-3.8-flash")),
);
check(
  "parseModelSelector: sufixo #variant vira campo variant",
  eq(srcConfig.parseModelSelector("google/antigravity-gemini-3.8-flash#low"), { providerID: "google", modelID: "antigravity-gemini-3.8-flash", variant: "low" }),
  JSON.stringify(srcConfig.parseModelSelector("google/antigravity-gemini-3.8-flash#low")),
);
check(
  "parseModelSelector: model com barras extras preserva o corpo",
  eq(srcConfig.parseModelSelector("openrouter/anthropic/claude-sonnet-4.5#high"), { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5", variant: "high" }),
);
check(
  "parseModelSelector: malformados retornam undefined",
  srcConfig.parseModelSelector("") === undefined
    && srcConfig.parseModelSelector("sem-barra") === undefined
    && srcConfig.parseModelSelector("/model") === undefined
    && srcConfig.parseModelSelector("provider/") === undefined
    && srcConfig.parseModelSelector("#low") === undefined,
);
check(
  "formatModelSelector: round-trip com e sem variant",
  srcConfig.formatModelSelector({ model: "google/antigravity-gemini-3.8-flash", variant: "low" }) === "google/antigravity-gemini-3.8-flash#low"
    && srcConfig.formatModelSelector({ model: "google/antigravity-gemini-3.8-flash" }) === "google/antigravity-gemini-3.8-flash",
);

/* ------------------------------------------------------------------ *
 * 5. Defaults — o fallback padrão mandatório é gemini-3.8-flash#low   *
 * ------------------------------------------------------------------ */
check(
  "DEFAULT_MODEL_FALLBACK = google/antigravity-gemini-3.8-flash variant low",
  srcConfig.DEFAULT_MODEL_FALLBACK.model === "google/antigravity-gemini-3.8-flash"
    && srcConfig.DEFAULT_MODEL_FALLBACK.variant === "low",
  JSON.stringify(srcConfig.DEFAULT_MODEL_FALLBACK),
);
check(
  "DEFAULT_CONFIG.fallbackModels = [] e modelFallback = default congelado",
  eq(srcConfig.DEFAULT_CONFIG.fallbackModels, [])
    && eq(srcConfig.DEFAULT_CONFIG.modelFallback, { model: "google/antigravity-gemini-3.8-flash", variant: "low" }),
);
check(
  "DEFAULT_MODEL_FALLBACK é imutável (Object.freeze)",
  Object.isFrozen(srcConfig.DEFAULT_MODEL_FALLBACK),
);

/* ------------------------------------------------------------------ *
 * 6. resolveFallbackChain — cadeia ordenada e deduplicada             *
 * ------------------------------------------------------------------ */
check(
  "chain: config vazio cai no DEFAULT_MODEL_FALLBACK",
  eq(srcConfig.resolveFallbackChain({}), [{ model: "google/antigravity-gemini-3.8-flash", variant: "low" }]),
  JSON.stringify(srcConfig.resolveFallbackChain({})),
);
check(
  "chain: fallbackModels parseado, malformadas descartadas, dedup aplicado",
  eq(
    srcConfig.resolveFallbackChain({
      fallbackModels: [
        "openrouter/anthropic/claude-sonnet-4.5#high",
        "lixin/lixin-4.5",
        "lixin/lixin-4.5", // duplicada
        "lixin/lixin-4.5#high", // mesmo primário com outra variant — mantida
        "invalida-sem-barra",
      ],
    }),
    [
      { model: "openrouter/anthropic/claude-sonnet-4.5", variant: "high" },
      { model: "lixin/lixin-4.5" },
      { model: "lixin/lixin-4.5", variant: "high" },
    ],
  ),
);
check(
  "chain: modelFallback estruturado usado quando fallbackModels vazio",
  eq(srcConfig.resolveFallbackChain({ modelFallback: { model: "opencode/gpt-5.1-codex", variant: "medium" } }),
    [{ model: "opencode/gpt-5.1-codex", variant: "medium" }]),
);
check(
  "chain: modelFallback.model tolera sufixo #variant embutido",
  eq(srcConfig.resolveFallbackChain({ modelFallback: { model: "opencode/gpt-5.1-codex#medium" } }),
    [{ model: "opencode/gpt-5.1-codex", variant: "medium" }]),
);
check(
  "chain: fallbackModels prevalece sobre modelFallback",
  eq(srcConfig.resolveFallbackChain({
    fallbackModels: ["google/antigravity-gemini-3.7-flash#low"],
    modelFallback: { model: "opencode/gpt-5.1-codex" },
  }), [{ model: "google/antigravity-gemini-3.7-flash", variant: "low" }]),
);

/* ------------------------------------------------------------------ *
 * 7. selectFallbackModel — nunca falha-over para o próprio primário   *
 * ------------------------------------------------------------------ */
const chain = srcConfig.resolveFallbackChain({ fallbackModels: ["a/primary#low", "b/first-fallback", "c/second-fallback"] });
check(
  "select: primário igual à 1ª entrada pula para a seguinte",
  eq(srcConfig.selectFallbackModel(chain, "a/primary#low"), { model: "b/first-fallback" }),
  JSON.stringify(srcConfig.selectFallbackModel(chain, "a/primary#low")),
);
check(
  "select: sem primário retorna a cabeça da chain",
  eq(srcConfig.selectFallbackModel(chain), { model: "a/primary", variant: "low" }),
);
check(
  "select: primário fora da chain retorna a cabeça",
  eq(srcConfig.selectFallbackModel(chain, "z/other"), { model: "a/primary", variant: "low" }),
);
check(
  "select: chain vazia retorna undefined",
  srcConfig.selectFallbackModel([], "a/primary") === undefined,
);
check(
  "select: default — primário gemini-3.8-flash cai no próprio default e retorna undefined",
  (() => {
    const defChain = srcConfig.resolveFallbackChain({});
    return srcConfig.selectFallbackModel(defChain, "google/antigravity-gemini-3.8-flash#low") === undefined;
  })(),
);

/* ------------------------------------------------------------------ *
 * 8. loadConfig — leitura real de ensemble.json em HOME temporário    *
 * ------------------------------------------------------------------ */
const FAKE_HOME = mkdtempSync(path.join(TMP, "home_"));
const CFG_DIR = path.join(FAKE_HOME, ".config", "opencode");
mkdirSync(CFG_DIR, { recursive: true });
const prevHome = process.env.HOME;
try {
  writeFileSync(path.join(CFG_DIR, "ensemble.json"), JSON.stringify({
    fallbackModels: ["opencode/nemotron-3.5-lightning-free", "google/antigravity-gemini-3.8-flash#low"],
    modelFallback: { model: "google/antigravity-gemini-3.7-flash", variant: "high" },
  }));
  process.env.HOME = FAKE_HOME;
  const loaded = srcConfig.loadConfig(path.join(TMP, "no_project"));
  check(
    "loadConfig: fallbackModels e modelFallback lidos do ensemble.json real",
    eq(loaded.fallbackModels, ["opencode/nemotron-3.5-lightning-free", "google/antigravity-gemini-3.8-flash#low"])
      && eq(loaded.modelFallback, { model: "google/antigravity-gemini-3.7-flash", variant: "high" }),
    JSON.stringify({ fallbackModels: loaded.fallbackModels, modelFallback: loaded.modelFallback }),
  );

  writeFileSync(path.join(CFG_DIR, "ensemble.json"), JSON.stringify({
    fallbackModels: [42, null],
    modelFallback: "não é objeto",
  }));
  const invalid = srcConfig.loadConfig(path.join(TMP, "no_project"));
  check(
    "loadConfig: tipos inválidos são ignorados e defaults preservados",
    eq(invalid.fallbackModels, [])
      && eq(invalid.modelFallback, { model: "google/antigravity-gemini-3.8-flash", variant: "low" }),
  );

  writeFileSync(path.join(CFG_DIR, "ensemble.json"), "{ json inválido");
  const broken = srcConfig.loadConfig(path.join(TMP, "no_project"));
  check(
    "loadConfig: JSON inválido cai nos defaults sem lançar",
    eq(broken.fallbackModels, []) && broken.modelFallback.variant === "low",
  );
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
}

/* ------------------------------------------------------------------ *
 * 9. parseModelId (member-model) — strip de "#variant"                *
 * ------------------------------------------------------------------ */
check(
  "parseModelId: comportamento pré-existente preservado sem '#'",
  eq(srcMemberModel.parseModelId("google/antigravity-gemini-3.8-flash"), { providerID: "google", modelID: "antigravity-gemini-3.8-flash" })
    && eq(srcMemberModel.parseModelId("openrouter/anthropic/claude-sonnet-4.5"), { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4.5" }),
);
check(
  "parseModelId: sufixo #variant é stripado (variant nunca entra no modelID)",
  eq(srcMemberModel.parseModelId("google/antigravity-gemini-3.8-flash#low"), { providerID: "google", modelID: "antigravity-gemini-3.8-flash", variant: "low" }),
  JSON.stringify(srcMemberModel.parseModelId("google/antigravity-gemini-3.8-flash#low")),
);
check(
  "parseModelId: malformados continuam retornando undefined",
  srcMemberModel.parseModelId("") === undefined && srcMemberModel.parseModelId("sem-barra") === undefined,
);

/* ------------------------------------------------------------------ *
 * 10. Paridade dist × src — mesmas asserções centrais no bundle       *
 * ------------------------------------------------------------------ */
check(
  "dist: DEFAULT_CONFIG carrega o fallback default correto",
  eq(distMod.DEFAULT_CONFIG.modelFallback, { model: "google/antigravity-gemini-3.8-flash", variant: "low" })
    && eq(distMod.DEFAULT_CONFIG.fallbackModels, []),
);
check(
  "dist: resolveFallbackChain/selectFallbackModel idênticos ao src",
  eq(distMod.resolveFallbackChain({}), srcConfig.resolveFallbackChain({}))
    && eq(
      distMod.selectFallbackModel(distMod.resolveFallbackChain({ fallbackModels: ["a/p", "b/f"] }), "a/p"),
      srcConfig.selectFallbackModel(srcConfig.resolveFallbackChain({ fallbackModels: ["a/p", "b/f"] }), "a/p"),
    ),
);
check(
  "dist: parseModelSelector/parseModelId idênticos ao src",
  eq(distMod.parseModelSelector("google/antigravity-gemini-3.8-flash#low"), srcConfig.parseModelSelector("google/antigravity-gemini-3.8-flash#low"))
    && eq(distMod.parseModelId("google/antigravity-gemini-3.8-flash#low"), srcMemberModel.parseModelId("google/antigravity-gemini-3.8-flash#low")),
);

/* ------------------------------------------------------------------ *
 * Relatório                                                            *
 * ------------------------------------------------------------------ */
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
const fails = results.filter(([, ok]) => !ok).map(([name]) => name);
console.log("-".repeat(78));
console.log(`CHECKS: ${passed}/${total} passaram`);
if (fails.length > 0) for (const f of fails) console.log(`FAIL | ${f}`);
console.log(`RESULT: ${passed === total ? "all checks passed" : "SUITE FAILURE"} (${passed}/${total})`);
process.exit(passed === total ? 0 : 1);
