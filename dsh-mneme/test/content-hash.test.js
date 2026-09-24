import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { contentHashOf, normalizeForHash } from "../src/content-hash.js";

// #254 内容哈希（写入准入的确定性计量锚）。
// 这批用例锁三件事：归一化口径（只差格式不算两次）、派生列随内容走（insert/update/
// CAS 三处都得重算，漏一处标记就在说谎）、以及老库打开时的迁移顺序（索引必须在加列
// 之后建，否则 exec(SCHEMA) 直接报 no such column，插件整树加载失败）。

test("归一化口径：大小写/空白/标点/全角差异落在同一个键上", () => {
  assert.equal(normalizeForHash("Hello,  World!\n"), "hello world");
  assert.equal(normalizeForHash("ｈｅｌｌｏ　ｗｏｒｌｄ"), "hello world", "NFKC 折全角");
  assert.equal(
    contentHashOf({ title: "Task A", content: "Line1.\n\nLine2" }),
    contentHashOf({ title: "task a", content: "line1 line2" })
  );
  // 分隔符防拼接歧义：('ab','c') 与 ('a','bc') 不能同键
  assert.notEqual(contentHashOf({ title: "ab", content: "c" }), contentHashOf({ title: "a", content: "bc" }));
  assert.notEqual(contentHashOf({ title: "t", content: "同一件事" }), contentHashOf({ title: "t", content: "另一件事" }));
});

test("归一化口径：同义词与词序不折叠（哈希只认逐字节相同）", () => {
  assert.notEqual(contentHashOf({ title: "t", content: "a b" }), contentHashOf({ title: "t", content: "b a" }));
});

test("已知等价类：去标点让 3.5 与 35 同键（口径选择的结果，不是判据出错）", () => {
  // 这条把「已知会误报」的样子钉住，防止有人把文件头的「命中即精确重复」当承诺、
  // 进而以为这是个 bug 去改归一化——改口径要带存量重算（见 content-hash.js 文件头）。
  assert.equal(contentHashOf({ title: "t", content: "版本 3.5" }), contentHashOf({ title: "t", content: "版本 35" }));
  assert.equal(contentHashOf({ title: "t", content: "a-b" }), contentHashOf({ title: "t", content: "ab" }));
  // 但数字本身没被折叠：不同数值不落同一键
  assert.notEqual(contentHashOf({ title: "t", content: "3.5" }), contentHashOf({ title: "t", content: "3.6" }));
});

test("空标题空正文没有可比内容 → null（不互相匹配成「全是重复」）", () => {
  assert.equal(contentHashOf({ title: "", content: "" }), null);
  assert.equal(contentHashOf({ title: "   ", content: "\n\t" }), null);
  assert.equal(contentHashOf({}), null);
  assert.ok(contentHashOf({ title: "只有标题" }));
});

test("save 落 content_hash，findContentHashMatches 按 type + scope 收窄", () => {
  const store = createStore(":memory:");
  const a = store.save({ type: "project", title: "同一件事", content: "正文", agent_scope: "A" });
  assert.equal(a.content_hash, contentHashOf({ title: "同一件事", content: "正文" }));

  const sameScope = store.findContentHashMatches({ type: "project", hash: a.content_hash, agent_scope: "A" });
  assert.deepEqual(sameScope.map((m) => m.id), [a.id]);

  // 跨 scope 永不互判（与 saveWithDedupe 的三维去重键同口径）
  const otherScope = store.findContentHashMatches({ type: "project", hash: a.content_hash, agent_scope: "B" });
  assert.equal(otherScope.length, 0);
  const unannotated = store.findContentHashMatches({ type: "project", hash: a.content_hash });
  assert.equal(unannotated.length, 0, "已标注行不与未标注行匹配");

  // 入参先按 store 自己的口径归一，免得调用方传 " A " 就漏配
  assert.equal(store.findContentHashMatches({ type: "project", hash: a.content_hash, agent_scope: " A " }).length, 1);
  // type 不同不互判
  assert.equal(store.findContentHashMatches({ type: "preference", hash: a.content_hash, agent_scope: "A" }).length, 0);
  store.close();
});

test("归档行在候选集内（#275 分界：出口止体积、不止重复）", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "project", title: "被归档的事实", content: "同样的正文" });
  store.setArchived(saved.id, true);
  const hits = store.findContentHashMatches({ type: "project", hash: saved.content_hash });
  assert.deepEqual(hits, [{ id: saved.id, archived: true, forgotten: false }]);
  store.close();
});

test("同键命中超过窗口宽度时，活跃行仍在窗口内（归档动作会顶 updated_at）", () => {
  // 回归（自动评审 #311 store.js:1055）：LIMIT 先于调用方的「活区优先」执行。若只按
  // updated_at 倒序，第 11 条起写下的归档行会把更早的活跃行挤出窗口，调用方只能看见
  // 归档命中，把「活跃重复」错记成「归档重复」——正是 dup 信号要分流的两类。
  const store = createStore(":memory:");
  const live = store.save({ type: "project", title: "窗口内", content: "同一段正文" });
  assert.ok(live.content_hash, "写入即落 content_hash");
  const sinks = [];
  for (let i = 0; i < 10; i++) {
    sinks.push(store.save({ type: "project", title: "窗口内", content: "同一段正文" }));
  }
  for (const row of sinks) store.setArchived(row.id, true);
  const hits = store.findContentHashMatches({ type: "project", hash: live.content_hash });
  assert.equal(hits.length, 10, "窗口宽度不变");
  assert.deepEqual(hits[0], { id: live.id, archived: false, forgotten: false });
  store.close();
});

test("update 与 compareAndUpdate 都重算 content_hash", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "project", title: "T", content: "旧正文" });
  assert.equal(store.findContentHashMatches({ type: "project", hash: contentHashOf({ title: "T", content: "旧正文" }) }).length, 1);

  const updated = store.update(saved.id, { content: "新正文" });
  assert.equal(updated.content_hash, contentHashOf({ title: "T", content: "新正文" }));
  assert.equal(
    store.findContentHashMatches({ type: "project", hash: contentHashOf({ title: "T", content: "旧正文" }) }).length,
    0,
    "旧内容的锚必须失效"
  );

  const cas = store.compareAndUpdate(updated.id, updated.updated_at, { title: "T2" });
  assert.equal(cas.content_hash, contentHashOf({ title: "T2", content: "新正文" }));
  assert.equal(
    store.findContentHashMatches({ type: "project", hash: contentHashOf({ title: "T", content: "新正文" }) }).length,
    0,
    "CAS 路径漏重算的话标记会指向不再存在的内容"
  );
  store.close();
});

test("demoteToSummary 与 restoreContent 也重算 content_hash", () => {
  const store = createStore(":memory:");
  const saved = store.save({ type: "project", title: "T", content: "完整正文" });
  const demoted = store.demoteToSummary(saved.id, "摘要行");
  assert.equal(demoted.content_hash, contentHashOf({ title: "T", content: "摘要行" }));
  assert.equal(
    store.findContentHashMatches({ type: "project", hash: contentHashOf({ title: "T", content: "完整正文" }) }).length,
    0,
    "降级后的行装的是摘要，锚不能还指着完整正文"
  );

  const restored = store.restoreContent(saved.id);
  assert.equal(restored.content_hash, contentHashOf({ title: "T", content: "完整正文" }));
  store.close();
});

test("老库打开：加列 + 建索引 + 存量回填（索引顺序错会直接开不起来）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-hash-migrate-"));
  const dbPath = join(dir, "legacy.db");
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', importance INTEGER NOT NULL DEFAULT 3,
      forgotten INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    legacy
      .prepare(
        "INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 3, 0, ?, NULL, ?, ?)"
      )
      .run("legacy-1", "project", "老库事实", "同一件事的正文", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    legacy
      .prepare(
        "INSERT INTO memories (id, type, title, content, tags, importance, forgotten, archived, source, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 3, 0, ?, NULL, ?, ?)"
      )
      .run("legacy-2", "project", "被归档的老事实", "归档区里同一件事的正文", 1, "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    legacy.close();

    const store = createStore(dbPath);
    const index = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_content_hash'")
      .get();
    assert.ok(index, "老库也要建上索引（候选集靠它 seek，否则每次写入都是全表扫）");

    // 索引不只是「存在」：回填的 NULL 扫描与准入的候选集查询都得真的走它。列序写反
    // （type 打头）时前者退化成全表扫——每次打开都要把全部正文读一遍。
    const planOf = (sql, ...params) =>
      store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(" | ");
    assert.match(
      planOf("SELECT id, title, content FROM memories WHERE content_hash IS NULL"),
      /idx_memories_content_hash/,
      "存量回填走索引"
    );
    assert.match(
      planOf("SELECT id FROM memories WHERE type = ? AND content_hash = ?", "project", "x"),
      /idx_memories_content_hash/,
      "候选集查询走索引"
    );

    const backfilled = store.getById("legacy-1");
    assert.equal(backfilled.content_hash, contentHashOf({ title: "老库事实", content: "同一件事的正文" }));
    assert.deepEqual(
      store.findContentHashMatches({ type: "project", hash: backfilled.content_hash }).map((m) => m.id),
      ["legacy-1"]
    );
    const archivedBackfilled = store.getById("legacy-2");
    assert.deepEqual(
      store.findContentHashMatches({ type: "project", hash: archivedBackfilled.content_hash }),
      [{ id: "legacy-2", archived: true, forgotten: false }],
      "存量归档行回填后也要在候选集里（不然这条信号在老库上量不到归档区）"
    );

    // 回填后仍能正常写入（幂等迁移没有把表锁死）
    const fresh = store.save({ type: "project", title: "新行", content: "新正文" });
    assert.ok(fresh.content_hash);
    const firstPassHash = archivedBackfilled.content_hash;
    store.close();

    // 再开一次：只算 NULL 行，已有锚原样保留
    const again = createStore(dbPath);
    assert.equal(again.getById("legacy-2").content_hash, firstPassHash, "重复打开不得改写已有锚");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
