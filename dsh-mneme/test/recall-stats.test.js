import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";

// #217 记忆复用统计：只读聚合口径的回归锚。
// 数据面事实（锚 5bd2dab）：recall_runs.candidates 存最终返回集（service.js
// recordRecall 处 map result），注入侧零留痕 → 「入池未中」语义（B）拿不到，
// v1 只报零曝光（A）；豁免期 7 天按当前时刻计，exemptCount 单独报数不入分母。

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

function run(store, candidates, created_at, query = "q") {
  store.saveRecallRun({ query, mode: "hybrid", topK: 5, threshold: null, candidates, created_at });
}

const cand = (m) => ({ id: m.id, title: m.title, content: m.content, score: 0.9, source: "vector" });

test("Top-N：按窗口内候选出现次数计数，join memories 补 type/source", () => {
  const { store, service } = setup();
  const m1 = service.saveWithDedupe({ type: "decision", title: "甲", content: "内容甲", importance: 3 }).memory;
  const m2 = service.saveWithDedupe({ type: "preference", title: "乙", content: "内容乙", importance: 3 }).memory;
  run(store, [cand(m1), cand(m2)], new Date().toISOString());
  run(store, [cand(m1)], new Date().toISOString());

  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.topRecalled.length, 2);
  assert.equal(stats.topRecalled[0].id, m1.id, "出现 2 次的排第一");
  assert.equal(stats.topRecalled[0].count, 2);
  assert.equal(stats.topRecalled[0].type, "decision");
  // source 取记忆行 provenance（manual/dream/...），不是检索信号；候选里的
  // source 只在记忆已删时兜底（见下一条用例）
  assert.equal(stats.topRecalled[0].source, "manual");
  assert.equal(stats.topRecalled[1].id, m2.id);
  assert.equal(stats.topRecalled[1].count, 1);
  store.close();
});

test("候选里的记忆已删：type=null，标题/来源回退候选值，不计入僵尸分母", () => {
  const { store, service } = setup();
  run(store, [{ id: "ghost-id", title: "幽灵记忆", content: "x", score: 0.5, source: "keyword" }], new Date().toISOString());

  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.topRecalled.length, 1);
  assert.equal(stats.topRecalled[0].id, "ghost-id");
  assert.equal(stats.topRecalled[0].type, null);
  assert.equal(stats.topRecalled[0].title, "幽灵记忆");
  assert.equal(stats.topRecalled[0].source, "keyword");
  assert.equal(stats.zombie.activeCount, 0, "幽灵行不是活跃记忆，不进分母");
  store.close();
});

test("僵尸率：零曝光活跃计入，归档/遗忘剔除，豁免期单独报数", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "零曝光", content: "从未被召回", importance: 3 });
  const hit = service.saveWithDedupe({ type: "decision", title: "被召回", content: "在候选里", importance: 3 }).memory;
  const archived = service.saveWithDedupe({ type: "history", title: "归档件", content: "x", importance: 3 }).memory;
  const forgotten = service.saveWithDedupe({ type: "history", title: "遗忘件", content: "x", importance: 3 }).memory;
  store.setArchived(archived.id, true);
  store.setForget(forgotten.id, true);
  run(store, [cand(hit)], new Date().toISOString());

  // 豁免期默认 7 天：刚写入的活跃记忆全部豁免，不入分母、单独报数；
  // 归档/遗忘在豁免检查之前剔除，不进豁免计数
  const withExempt = service.recallStats({ windowDays: 30 });
  assert.equal(withExempt.zombie.exemptCount, 2);
  assert.equal(withExempt.zombie.activeCount, 0);
  assert.equal(withExempt.zombie.rate, null);

  // 豁免归零：归档/遗忘剔除，零曝光的 z 计僵尸。回拨 created_at 避开
  // nowIso 同毫秒单调顶推的 1ms 豁免边界——刚写入的记忆可能比 recallStats
  // 的 Date.now() 晚 1ms，exemptDays:0 时落进豁免桶，断言随调度抖动翻转。
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  for (const m of store.all()) {
    store.db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(old, m.id);
  }
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.zombie.activeCount, 2, "归档与遗忘不进分母");
  assert.equal(stats.zombie.zombieCount, 1);
  assert.equal(stats.zombie.rate, 0.5);
  assert.equal(stats.zombie.byType.project.zombie, 1);
  assert.equal(stats.zombie.byType.decision.zombie, 0);
  store.close();
});

test("窗口过滤：窗外回执不计，coverage.earliestRunAt 标注可信度", () => {
  const { store, service } = setup();
  const m = service.saveWithDedupe({ type: "project", title: "老回执", content: "x", importance: 3 }).memory;
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  run(store, [cand(m)], old, "老查询");

  const narrow = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(narrow.coverage.runsScanned, 0);
  assert.equal(narrow.coverage.earliestRunAt, null, "窗口内无回执 → 口径不可信，前端整卡不渲染");
  assert.equal(narrow.topRecalled.length, 0);
  assert.equal(narrow.zombie.zombieCount, 1, "零曝光照算（这正是零回执窗口要暴露的口径缺口）");

  const wide = service.recallStats({ windowDays: 365, exemptDays: 0 });
  assert.equal(wide.coverage.runsScanned, 1);
  assert.equal(wide.coverage.earliestRunAt, old);
  assert.equal(wide.zombie.zombieCount, 0, "老回执里的记忆不算僵尸");
  store.close();
});

test("windowDays/exemptDays 越界回默认；扫描超上限标 truncated", () => {
  const { store, service } = setup();
  const m = service.saveWithDedupe({ type: "project", title: "x", content: "x", importance: 3 }).memory;
  run(store, [cand(m)], new Date().toISOString());
  run(store, [cand(m)], new Date().toISOString());

  const clamped = service.recallStats({ windowDays: 9999, exemptDays: -1 });
  assert.equal(clamped.windowDays, 30, "windowDays 越界回 30");
  assert.equal(clamped.zombie.exemptCount, 1, "exemptDays 越界回 7 → 刚写入的豁免");

  const { rows, total } = store.listRecallRunsSince(new Date(Date.now() - 86400000).toISOString(), { limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(total, 2, "窗口总数不截断 → truncated = total > rows.length");
  store.close();
});

// ============================ 第五指标（#275）：归档净增速率 + 可压掉行数

test("归档净增速率：按 updated_at 取归档时刻，窗外归档只进总数不进净增", () => {
  const { store, service } = setup();
  const fresh = service.saveWithDedupe({ type: "history", title: "刚归档", content: "x", importance: 3 }).memory;
  const old = service.saveWithDedupe({ type: "history", title: "早归档", content: "y", importance: 3 }).memory;
  service.saveWithDedupe({ type: "history", title: "活跃件", content: "z", importance: 3 });
  store.setArchived(fresh.id, true);
  store.setArchived(old.id, true);
  // 归档时刻 = 最后一次写（setArchived 刷 updated_at）：把这行推到窗口外
  store.db.prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 100 * 86400000).toISOString(), old.id);

  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.archive.total, 2, "归档区现有行数（活跃件不算）");
  assert.equal(stats.archive.addedInWindow, 1, "窗外那次归档不算本窗口净增");
  assert.equal(stats.archive.perDay, Math.round((1 / 30) * 100) / 100);
  store.close();
});

test("可压掉行数：同 type 同 scope 的内容哈希精确重复（跨 scope / 活跃行都不算）", () => {
  const { store, service } = setup();
  // 标题只差大小写、正文只差标点与空白 → 归一化后同哈希（#254 的口径）
  const a = store.save({ type: "history", title: "Task A", content: "line1.\n\nline2" });
  const b = store.save({ type: "history", title: "task a", content: "line1 line2" });
  const otherScope = store.save({ type: "history", title: "Task A", content: "line1 line2", agent_scope: "other" });
  store.save({ type: "history", title: "Task A", content: "line1 line2" });
  for (const id of [a.id, b.id, otherScope.id]) store.setArchived(id, true);

  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.equal(stats.archive.compressible.groups, 1, "跨 scope 不互判（与去重候选集同一把尺）");
  assert.equal(stats.archive.compressible.rows, 1, "每组留一行，多出来的才叫可压掉");
  assert.equal(stats.archive.total, 3, "跨 scope 行照进总数，只是不参与可压掉");
  assert.equal(stats.archive.addedInWindow, 3, "三行都是本窗口内归档的");
  store.close();
});

test("可压掉行数：向量口径不可用时的兜底——指标不依赖 embedding", () => {
  // 回归点：回收动作会清掉归档行向量（clearArchivedEmbeddings），若指标建在向量近
  // 重复上，回收一跑它就归零。这里清完向量后指标必须不变。
  const { store, service } = setup();
  const a = store.save({ type: "history", title: "同题", content: "同一件事" });
  const b = store.save({ type: "history", title: "同题", content: "同一件事" });
  store.setArchived(a.id, true);
  store.setArchived(b.id, true);
  assert.equal(service.recallStats({ windowDays: 30, exemptDays: 0 }).archive.compressible.rows, 1);

  store.clearArchivedEmbeddings();
  assert.equal(
    service.recallStats({ windowDays: 30, exemptDays: 0 }).archive.compressible.rows,
    1,
    "清向量不影响可压掉行数"
  );
  store.close();
});

test("没有归档行时给 0，不返回 null / NaN", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ type: "project", title: "只有活跃", content: "x", importance: 3 });
  const stats = service.recallStats({ windowDays: 30, exemptDays: 0 });
  assert.deepEqual(stats.archive, {
    total: 0, addedInWindow: 0, perDay: 0, compressible: { rows: 0, groups: 0 }
  });
  store.close();
});
