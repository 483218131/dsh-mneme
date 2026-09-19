// #230：document 型记忆——注册校验 / 摘要+doc_path 落库 / C2 去重 / supersede
// 记账 / 注入档位与预算 / 写入权分离守卫。口径基线 = #164 设计稿评审线
// （discussioncomment-18495098 + 维护者对账 18502150）。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createDocumentRegistrar } from "../src/document.js";
import { MEMORY_ITEM_SCHEMA } from "../src/tools.js";
import { TYPE_DECAY_DEFAULTS } from "../src/heat.js";

function makeService(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  return { store, service, close: () => store.close() };
}

async function makeDocDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dsh-mneme-doc-"));
  const writeDoc = async (name, content = "# Doc\n\nbody text") => {
    const p = path.join(dir, name);
    await writeFile(p, content, "utf8");
    return p;
  };
  return { dir, writeDoc, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** 单元级 registrar：注入假 embedQuery，隔离 vector 档行为。 */
function makeRegistrar(store, config = {}, embedQuery = async () => null) {
  const finalized = [];
  const register = createDocumentRegistrar({
    store,
    config,
    embedQuery,
    // 与 service.js 的 pushContentHistory 同形（FIFO cap 20）
    pushContentHistory: (existing, source) => [
      { content: existing?.content ?? "", source, updated_at: new Date().toISOString() },
      ...(Array.isArray(existing?.content_history) ? existing.content_history : [])
    ].slice(0, 20),
    transaction: (fn) => fn(),
    finalize: (rows) => finalized.push(...rows)
  });
  return { register, finalized };
}

// ============================================================ 注册校验（DoD 1）

test("registration is refused while the feature flag is off", async () => {
  const { service, close } = makeService({});
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("a.md");
    await assert.rejects(
      () => service.registerDocument({ path: p, title: "T", summary: "S" }),
      /documentMemoryEnabled/
    );
  } finally {
    cleanup();
    close();
  }
});

test("path validation: required / absolute-only / existing non-empty regular file", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { dir, writeDoc, cleanup } = await makeDocDir();
  try {
    await assert.rejects(
      () => service.registerDocument({ title: "T", summary: "S" }),
      /path is required/
    );
    await assert.rejects(
      () => service.registerDocument({ path: "rel.md", title: "T", summary: "S" }),
      /must be absolute/
    );
    await assert.rejects(
      () => service.registerDocument({ path: path.join(dir, "missing.md"), title: "T", summary: "S" }),
      /not found or empty/
    );
    await assert.rejects(
      () => service.registerDocument({ path: dir, title: "T", summary: "S" }),
      /not found or empty/
    );
    const empty = await writeDoc("empty.md", "");
    await assert.rejects(
      () => service.registerDocument({ path: empty, title: "T", summary: "S" }),
      /not found or empty/
    );
  } finally {
    cleanup();
    close();
  }
});

test("~ paths expand to the real home and register", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("tilde.md");
    const rel = path.relative(os.homedir(), p);
    const res = await service.registerDocument({
      path: `~/${rel.split(path.sep).join("/")}`,
      title: "TildeDoc",
      summary: "S"
    });
    assert.equal(res.action, "created");
    assert.equal(res.memory.doc_path, p);
  } finally {
    cleanup();
    close();
  }
});

test("evidence intersection: valid subset kept, unknown dropped + degraded tag, all-fabricated rejected", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const a = service.saveWithDedupe({ type: "preference", title: "P1", content: "c1" }).memory;
    const b = service.saveWithDedupe({ type: "decision", title: "D1", content: "c2" }).memory;
    const p = await writeDoc("r.md");

    const partial = await service.registerDocument({
      path: p, title: "R", summary: "S", evidence: [a.id, "nope-1", b.id]
    });
    assert.equal(partial.action, "created");
    assert.deepEqual(partial.memory.evidence, [a.id, b.id]);
    assert.equal(partial.evidence_kept, 2);
    assert.equal(partial.evidence_dropped, 1);
    assert.equal(partial.degraded, true);
    assert.ok(partial.memory.tags.includes("evidence_degraded"));

    await assert.rejects(
      () => service.registerDocument({ path: p, title: "T2", summary: "S", evidence: ["nope-2"] }),
      /fabricated evidence is rejected/
    );

    const clean = await service.registerDocument({ path: await writeDoc("clean.md"), title: "T3", summary: "S" });
    assert.equal(clean.degraded, false);
    assert.deepEqual(clean.memory.evidence, []);
    assert.ok(!clean.memory.tags.includes("evidence_degraded"));
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ supersede 记账（DoD 2）

test("re-registering the same path supersedes: old row archived + traceable, file untouched", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p = await writeDoc("v.md");
    const v1 = await service.registerDocument({ path: p, title: "T1", summary: "summary v1", tags: ["doc"] });
    const v2 = await service.registerDocument({ path: p, title: "T2", summary: "summary v2" });

    assert.equal(v2.action, "superseded");
    assert.equal(v2.superseded.id, v1.memory.id);
    assert.equal(v2.memory.doc_path, p);

    const old = service.getById(v1.memory.id);
    assert.equal(old.archived, true, "old row archived (no physical delete)");
    assert.ok(old.content.includes(`[superseded by ${v2.memory.id}]`), "loser carries the pointer note");
    assert.equal(old.content_history[0].source, "superseded");
    assert.equal(old.content_history[0].content, "summary v1", "old summary traceable via content_history");
    assert.equal(old.doc_path, p, "old pointer preserved");

    const fresh = service.getById(v2.memory.id);
    assert.equal(fresh.archived, false);
    assert.equal(fresh.content, "summary v2");
  } finally {
    cleanup();
    close();
  }
});

test("same title on a different path also supersedes (new version of the moved doc)", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p1 = await writeDoc("old.md");
    const p2 = await writeDoc("new.md");
    const v1 = await service.registerDocument({ path: p1, title: "Same", summary: "s1" });
    const v2 = await service.registerDocument({ path: p2, title: "Same", summary: "s2" });
    assert.equal(v2.action, "superseded");
    assert.equal(v2.superseded.id, v1.memory.id);
    assert.equal(service.getById(v1.memory.id).archived, true);
    assert.equal(service.getById(v2.memory.id).doc_path, p2);
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ C2 去重（DoD 6 前半）

test("vector near-duplicate on a different path/title is rejected (agent decides, no silent supersede)", async () => {
  const { writeDoc, cleanup } = await makeDocDir();
  const store = createStore(":memory:");
  try {
    store.save({
      type: "document", title: "Alpha", content: "existing summary",
      doc_path: "X:\\elsewhere\\a.md", embedding: [1, 0, 0], source: "tool"
    });
    const b = await writeDoc("b.md");
    const c = await writeDoc("c.md");
    const { register } = makeRegistrar(store, { documentMemoryEnabled: true }, async () => [1, 0, 0]);
    await assert.rejects(
      () => register({ path: b, title: "Beta", summary: "similar summary" }),
      /near duplicate/
    );
    // 正交向量 = 无近重复 → 正常创建。
    const { register: register2 } = makeRegistrar(store, { documentMemoryEnabled: true }, async () => [0, 1, 0]);
    const res = await register2({ path: c, title: "Gamma", summary: "unrelated summary" });
    assert.equal(res.action, "created");
  } finally {
    cleanup();
    store.close();
  }
});

test("embedder unavailable: dedupe degrades to path/title tiers, writes still land", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const p1 = await writeDoc("d1.md");
    const p2 = await writeDoc("d2.md");
    const r1 = await service.registerDocument({ path: p1, title: "A", summary: "identical summary text" });
    const r2 = await service.registerDocument({ path: p2, title: "B", summary: "identical summary text" });
    assert.equal(r1.action, "created");
    assert.equal(r2.action, "created", "no vector signal = no near-dup verdict, write is never blocked");
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ 写入权分离守卫（DoD 1/3 旁路防护）

test("saveWithDedupe refuses to mint document rows", () => {
  const { service, close } = makeService({});
  try {
    assert.throws(
      () => service.saveWithDedupe({ type: "document", title: "x", content: "y" }),
      /registerDocument/
    );
  } finally {
    close();
  }
});

test("updateMemory cannot retype a row into document, but document summary repair passes", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pref = service.saveWithDedupe({ type: "preference", title: "P", content: "c" }).memory;
    assert.throws(() => service.update(pref.id, { type: "document" }), /registerDocument/);

    const p = await writeDoc("fix.md");
    const atomic = service.saveWithDedupe({ type: "decision", title: "D", content: "c" }).memory;
    const doc = (await service.registerDocument({
      path: p, title: "Doc", summary: "s", evidence: [atomic.id, "nope"]
    })).memory;
    const updated = service.update(doc.id, { content: "repaired summary", tags: ["user-tag"] });
    assert.equal(updated.content, "repaired summary");
    assert.equal(updated.doc_path, p, "pointer untouched by summary repair");
    assert.equal(updated.archived, false);
    assert.ok(
      updated.tags.includes("evidence_degraded") && updated.tags.includes("user-tag"),
      "system signal tag survives a tags-replacing update"
    );
  } finally {
    cleanup();
    close();
  }
});

// ============================================================ 注入档位与预算（DoD 5）

function seedInjectionFixtures(service, store) {
  service.saveWithDedupe({ type: "summary", title: "当前项目状态", content: "resident digest", source: "dream", importance: 5, _overwrite: true });
  service.saveWithDedupe({ type: "summary", title: "叙述：topic", content: "narrative bar", source: "narrative", tags: ["topic-n"], importance: 3 });
  // document 行铸造口唯一：测试种子也走 store.save（saveWithDedupe 有守卫）。
  for (let i = 1; i <= 3; i++) {
    store.save({ type: "document", title: `Doc${i}`, content: `d${i}`, source: "tool", doc_path: `X:\\${i}.md`, importance: 3 });
  }
}

test("injection: document rows at the next-priority tier, capped by documentInjectBudget; narrative tier re-enabled", () => {
  const { store, service, close } = makeService({ documentMemoryEnabled: true, documentInjectBudget: 2, dreamNarrativeEnabled: true });
  try {
    seedInjectionFixtures(service, store);
    const picked = service.injectCandidates({});
    assert.equal(picked[0].type, "summary");
    assert.equal(picked[0].source, "dream", "resident digest keeps tier 0");
    assert.equal(picked.filter((m) => m.type === "document").length, 2, "document budget caps at 2 of 3");
    assert.ok(picked.some((m) => m.source === "narrative"), "narrative rows inject at the next-priority tier (#230 拍板)");
  } finally {
    close();
  }
});

test("injection: flags off → document and narrative rows stay out, behavior unchanged", () => {
  const { store, service, close } = makeService({});
  try {
    seedInjectionFixtures(service, store);
    const picked = service.injectCandidates({});
    assert.ok(picked.every((m) => m.type !== "document"), "document rows excluded while flag off");
    assert.ok(picked.every((m) => m.source !== "narrative"), "narrative rows excluded while dreamNarrativeEnabled off");
    assert.ok(picked.some((m) => m.type === "summary" && m.source === "dream"), "dream digest unaffected");
  } finally {
    close();
  }
});

// ============================================================ DTO / 扩展面（DoD 3）

test("toApiList exposes doc_path on pointer rows only, within MEMORY_ITEM_SCHEMA", async () => {
  const { service, close } = makeService({ documentMemoryEnabled: true });
  const { writeDoc, cleanup } = await makeDocDir();
  try {
    const pref = service.saveWithDedupe({ type: "preference", title: "P", content: "c" }).memory;
    const p = await writeDoc("dto.md");
    const doc = (await service.registerDocument({ path: p, title: "D", summary: "s" })).memory;

    const prefDto = service.toApiList([pref])[0];
    assert.ok(!("doc_path" in prefDto), "non-pointer rows keep the pre-#230 DTO shape");
    const docDto = service.toApiList([doc])[0];
    assert.equal(docDto.doc_path, p);
    for (const key of Object.keys(docDto)) {
      assert.ok(key in MEMORY_ITEM_SCHEMA.properties, `DTO key "${key}" declared in MEMORY_ITEM_SCHEMA`);
    }
  } finally {
    cleanup();
    close();
  }
});

test("document rows are heat-immune (pointer rows do not decay)", () => {
  assert.equal(TYPE_DECAY_DEFAULTS.document, 0);
});
