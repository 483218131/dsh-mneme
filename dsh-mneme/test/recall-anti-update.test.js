// Anti-update 回归集（E6，#280 链；StatemenBench anti-update probes）。
//
// 锁的回归类：**supersede 后旧值复现**。取代关系没有专属列——落库状态完全
// 由 applySupersede（dream/decisions.js）的产物表达：loser 的 archived=1 +
// 正文 (superseded by: …) 注记。四条默认检索路径各自过滤 archived（keyword
// store.js:1528、vector store.js:1564、BM25 池 service.js bm25Recall、entity
// service.js:470），本文件把它们钉成「排除，而非降权」：
//   - 任何一路让归档旧条回到候选集 → 红；
//   - 归档行被误删/误遗忘（取代是归档不是删除）→ 红；
//   - includeArchived 显式口子仍在（排除发生在检索层，不是行消失）→ 红。
// seedService 已种好取代对（winner = mem_rust_switch，loser = mem_rust_switch_old）。
import test from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, runFusionBenchmark, seedService } from "../scripts/benchmark-recall.js";

const WINNER = "mem_rust_switch";
const LOSER = "mem_rust_switch_old";

test("benchmark 里带 forbidden 的 anti-update 用例在 legacy/fused 两配置下都零泄露", async () => {
  const report = await runBenchmark({ topK: 5 });
  for (const run of report.runs) {
    const probes = run.rows.filter((r) => r.forbidden?.length);
    assert.ok(probes.length >= 2, `${run.config}: anti-update probes present`);
    for (const r of probes) {
      assert.equal(r.forbiddenHit, 0, `${run.config} "${r.query}": superseded old row leaked`);
      assert.equal(r.recall, 1, `${run.config} "${r.query}": winner must still answer the topic`);
    }
  }
});

test("fusion 三个配方同样零泄露（排除发生在融合上游，与配方无关）", async () => {
  const report = await runFusionBenchmark({ topK: 5 });
  for (const run of report.runs) {
    for (const r of run.rows) {
      if (!r.forbidden?.length) continue;
      assert.equal(r.forbiddenHit, 0, `${run.config} "${r.query}": leaked via fusion recipe`);
    }
  }
});

test("mode=keyword / vector / auto 三条路径都不再返回被取代旧值", async () => {
  const svc = seedService();
  // 查询用 winner 标题「语言迁移决策」：toy 哈希嵌入按连续 CJK 段整段分词，
  // 只有这个串在 keyword（LIKE 子串）与 vector（token 精确重叠）两条路上都
  // 能命中 winner。注意 loser 的 superseded-by 注记里恰好也含这个串——
  // 归档排除一旦失效，注记自己就会把旧值钓回来，本用例立即红。
  for (const mode of ["keyword", "vector", "auto"]) {
    const rows = await svc.searchMemories("语言迁移决策", { mode, topK: 10, useRerank: false });
    const ids = rows.map((r) => r.id);
    assert.ok(!ids.includes(LOSER), `mode=${mode}: archived loser resurfaced`);
    assert.ok(ids.includes(WINNER), `mode=${mode}: winner missing from default recall`);
  }
});

test("BM25 的候选池（store.list）不含归档行——降权化改动在这里最先红", async () => {
  const svc = seedService();
  // bm25Recall 的取数源就是 store.list({limit, includeForgotten:false}) 再
  // filter !m.archived；list 层面归档行本就不回来，这里锁「池子是干净的」。
  const pool = svc.list({ limit: 500, includeForgotten: false });
  assert.ok(pool.length > 0, "pool non-empty");
  assert.ok(!pool.some((m) => m.id === LOSER), "archived loser must not enter the bm25 pool");
});

test("取代是归档不是删除：旧行还在、未遗忘、带 superseded-by 注记", async () => {
  const svc = seedService();
  const loser = svc.getById(LOSER);
  assert.ok(loser, "loser row must still exist");
  assert.equal(loser.archived, true, "loser must be archived (supersede semantics)");
  assert.equal(loser.forgotten, false, "supersede must not forget the row (heat/forget 是另一条线)");
  assert.ok(loser.content.includes("(superseded by: 语言迁移决策)"), "content carries the superseded-by note");
});

test("includeArchived 显式口子仍在：排除发生在检索层，不是行消失", async () => {
  const svc = seedService();
  // store.search 是整串 LIKE 子串扫描（不切词），所以这里用 loser 正文的
  // 连续子串作探针；被取代旧条不在默认结果里、但在 includeArchived 下回来。
  const probe = "选型理由是部署简单";
  const without = svc.search(probe, { limit: 50 });
  const withArchived = svc.search(probe, { limit: 50, includeArchived: true });
  assert.ok(!without.some((m) => m.id === LOSER), "default search excludes the archived loser");
  assert.ok(withArchived.some((m) => m.id === LOSER), "includeArchived must still surface it (row exists)");
});
