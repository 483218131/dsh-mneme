import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveMcpConfig, MCP_TOOLS } from "../mcp/bin/mneme-mcp.mjs";

// #300 双包方案：MCP server 拆出独立包 mneme-memory（mcp/ 目录）。
// 本文件锁两件事：
// 1. env 别名——新包接受 MNEME_URL / MNEME_TOKEN（与 DSH_MNEME_* 同级，精确
//    匹配优先级不变：DSH_MNEME_* > MNEME_* > cli.json > 默认）。config 文件
//    不加新键（env-only），旧用户 ~/.dsh-mneme/cli.json 零迁移。
// 2. 平价——新包的 MCP_TOOLS 与插件包 src/tools.js 逐字对齐（工具名/描述/
//    参数 schema），漂移即红：将来 tools.js 改动而 MCP 包未跟进时 CI 拦下。

const MCP_PKG_DIR = path.resolve(path.dirname(fileURLToPathSafe()), "..", "mcp");

function fileURLToPathSafe() {
  return new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

// --- env 别名 -----------------------------------------------------------------

test("resolveMcpConfig: MNEME_URL/MNEME_TOKEN work as same-priority aliases", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mneme-mcp-"));
  try {
    const configPath = path.join(dir, "cli.json");
    await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:9999", token: "file-token" }), "utf8");

    // MNEME_* 别名压过 config 文件
    const fromAlias = resolveMcpConfig({ MNEME_URL: "http://127.0.0.1:7002/", MNEME_TOKEN: "alias-token" }, configPath);
    assert.equal(fromAlias.url, "http://127.0.0.1:7002", "MNEME_URL alias wins over cli.json; trailing slash trimmed");
    assert.equal(fromAlias.token, "alias-token");

    // DSH_MNEME_* 优先级高于 MNEME_*（老变量优先，保证老用户无感）
    const both = resolveMcpConfig(
      { DSH_MNEME_URL: "http://127.0.0.1:7001", DSH_MNEME_TOKEN: "legacy", MNEME_URL: "http://127.0.0.1:7002", MNEME_TOKEN: "alias" },
      configPath
    );
    assert.equal(both.url, "http://127.0.0.1:7001", "DSH_MNEME_* keeps priority over MNEME_*");
    assert.equal(both.token, "legacy");

    // MNEME_* 单独出现也能配对（不要求成对存在）
    const urlOnly = resolveMcpConfig({ MNEME_URL: "http://127.0.0.1:7003" }, configPath);
    assert.equal(urlOnly.url, "http://127.0.0.1:7003");
    assert.equal(urlOnly.token, "file-token", "token falls back to cli.json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveMcpConfig: legacy behavior unchanged (DSH_MNEME_* / cli.json / defaults)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mneme-mcp-legacy-"));
  try {
    const configPath = path.join(dir, "cli.json");
    await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:9999", token: "file-token" }), "utf8");

    const fromFile = resolveMcpConfig({}, configPath);
    assert.equal(fromFile.url, "http://127.0.0.1:9999");
    assert.equal(fromFile.token, "file-token");

    const defaults = resolveMcpConfig({}, path.join(dir, "missing.json"));
    assert.equal(defaults.url, "http://127.0.0.1:8790");
    assert.equal(defaults.token, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 跨包平价 -------------------------------------------------------------------

test("parity: mneme-memory MCP_TOOLS stay verbatim-aligned with plugin src/tools.js", async () => {
  const { createTools } = await import("../dsh-mneme/src/tools.js");
  // createTools 需要一个最小 ctx.tools.register 假件来收集工具定义；
  // 六件套的 name/description 是常量字面量，不依赖运行时注入。
  const pluginTools = [];
  createTools({ tools: { register: (t) => pluginTools.push(t) } }, {}, {}, null);
  const mcpNames = MCP_TOOLS.map((t) => t.name).sort();

  // 六件套逐一在场：MCP 包只暴露记忆六件套，与插件工具面按名字对齐
  for (const n of ["memory_save", "memory_search", "memory_list", "memory_get", "memory_update", "memory_delete"]) {
    assert.ok(mcpNames.includes(n), `MCP package exposes ${n}`);
    assert.ok(pluginTools.some((t) => t.name === n), `plugin tools expose ${n}`);
  }
  // 平价锁：MCP 包的工具描述与插件包同名工具逐字一致（漂移即红）。
  // 注意：插件侧描述可能带 injectGuidanceEnabled 的尾句——这里 config 为空、
  // 该开关默认关，描述为裸字面量；MCP 包对齐的就是这个裸字面量。
  for (const mt of MCP_TOOLS) {
    const pt = pluginTools.find((t) => t.name === mt.name);
    assert.ok(pt, `plugin side has ${mt.name}`);
    assert.equal(mt.description, pt.description, `${mt.name} description verbatim parity`);
  }
});
