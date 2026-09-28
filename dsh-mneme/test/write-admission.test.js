import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import {
  createWriteAdmission,
  extractTopicKeys,
  ADMISSION_OPERATION_TYPE,
  ADMISSION_TRIGGER_SOURCE
} from "../src/write-admission.js";

// #254 写入准入（第一阶段：只计量，不拦截）。
// 本批次没有阈值、没有拦截分支，验收看两件事：默认路径零行为变化（无会话身份的
// 写入与未接线的服务都不记行），以及两个闸门的测量点可查（g1 会话写入预算按行聚
// 合、g2 同话题重复带间隔）。第二阶段的拦截（memory_save({confirm:true})）不在这
// 里锁——现在还没有那个分支。

function setup({ wired = true, now, admissionConfig } = {}) {
  const store = createStore(":memory:");
  const writeAdmission = wired ? createWriteAdmission({ store, now, config: admissionConfig }) : null;
  const service = createService({ store, mirror: null, config: {}, writeAdmission });
  return { store, service, writeAdmission };
}

function admissionRows(store, sessionKey) {
  return store.listLlmAudits({ sessionKey }).filter((r) => r.operation_type === ADMISSION_OPERATION_TYPE);
}

test("无会话身份的写入不进预算，也不写准入行", () => {
  const { store, service } = setup();
  const created = service.saveWithDedupe({ type: "project", title: "T", content: "正文内容一段" });
  assert.equal(created.action, "created");
  assert.equal(store.listLlmAudits().length, 0, "系统写入（dream / summarize / import / organize）不记准入行");

  // 未接线写入准入的服务（老调用方 / 单测）同样零变化
  const bare = createService({ store, mirror: null, config: {} });
  assert.equal(bare.saveWithDedupe({ type: "project", title: "T2", content: "另一段内容" }).action, "created");
  assert.equal(store.listLlmAudits().length, 0, "未接线时不产生任何审计行");
});

test("g1：会话内每个新建行记一行，合并行不记", () => {
  const { store, service } = setup();
  const s = { _sessionKey: "sess-1" };
  service.saveWithDedupe({ ...s, type: "project", title: "A", content: "第一段内容" });
  service.saveWithDedupe({ ...s, type: "project", title: "A", content: "追加的第二段" });
  service.saveWithDedupe({ ...s, type: "project", title: "B", content: "另一件事" });

  const rows = admissionRows(store, "sess-1");
  assert.equal(rows.length, 2, "两个新建行 = 两行；并入已有行不算新增（维护者拍板第 2 项）");
  for (const row of rows) {
    assert.equal(row.trigger_source, ADMISSION_TRIGGER_SOURCE);
    assert.equal(row.status, "skipped", "阶段一不拦截，沿用既有 skip 口径");
    assert.equal(row.metadata.gate, "g1");
    assert.equal(row.session_key, "sess-1");
    assert.equal(row.model_id, "-", "不是模型调用，占位串避免混进路由花费统计");
  }
  // 行上的会话键可等值查询：按会话聚合即得「会话内新建条数」分布
  assert.equal(store.countLlmAudits({ sessionKey: "sess-1" }), 2);
  assert.equal(store.countLlmAudits({ sessionKey: "sess-2" }), 0);
});

test("pinned 类型（constraint / preference）不进预算，穿透频率仍可观测", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "C", content: "边界条件" });
  service.saveWithDedupe({ _sessionKey: "s", type: "preference", title: "P", content: "用户偏好" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "普通记录" });

  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 3, "穿透口也记行——否则「预算为什么没算它」不可观测");
  assert.deepEqual(
    rows.map((r) => r.metadata.exempt ?? null).sort(),
    [null, "pinned", "pinned"]
  );
});

test("g2：同会话内同话题锚重复新建时记一行，带间隔", () => {
  let clock = 1_000_000;
  const { store, service } = setup({ now: () => clock });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "开工", content: "先把 #254 的准入做完" });
  assert.equal(admissionRows(store, "s").length, 1, "话题首次出现不算重复");

  clock += 90_000;
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "换了个标题", content: "接着做 #254，另起一段" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2, "一行一个新建行，g2 是这一行上的附加信号，不另起一行");
  assert.equal(rows[0].metadata.gate, "g1");
  assert.equal(rows[0].metadata.g2.topic, "#254");
  assert.equal(rows[0].metadata.g2.gap_ms, 90_000, "间隔按会话内最近一次同话题新建行算");
  assert.equal(rows[1].metadata.g2, undefined, "首次出现没有 g2");
  assert.equal(rows[0].status, "skipped");
});

test("g2：并入已有行不算同话题重写", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "同一标题", content: "看 #254" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "同一标题", content: "再看 #254" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 1, "合并是去重机制在正常工作，既不进预算也不产生 g2");
});

// #254 内容哈希（exact duplicate）：判据是归一化后逐字节相同，不是相似度；候选集把
// 归档行一起纳入——归档行不在 saveWithDedupe 的候选集里（store.list 默认排除归档），
// 同一个事实再写一次就是新行，这正是这条信号要量的穿透。
test("dup：命中归档行的重复写入被记下来（归档行在候选集内）", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "归档事实", content: "同一件事的正文" });
  store.setArchived(first.memory.id, true);
  const second = service.saveWithDedupe({
    _sessionKey: "sess-dup",
    type: "project",
    title: "归档事实",
    content: "同一件事的正文"
  });
  assert.equal(second.action, "created", "归档行不在去重候选集里，所以确实新建了一行");

  const rows = admissionRows(store, "sess-dup");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].metadata.dup, { memory_id: first.memory.id, archived: true, forgotten: false });
});

test("dup：只差格式（大小写/空白/标点）的重复也算命中", () => {
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "Task A", content: "Line1.\n\nLine2" });
  // 标题只差大小写 → saveWithDedupe 的精确标题匹配落空 → 走新建路径
  const second = service.saveWithDedupe({
    _sessionKey: "sess-fmt",
    type: "project",
    title: "task a",
    content: "line1 line2"
  });
  assert.equal(second.action, "created");
  const rows = admissionRows(store, "sess-fmt");
  assert.deepEqual(rows[0].metadata.dup, { memory_id: first.memory.id, archived: false, forgotten: false });
});

test("dup：同内容既有活跃行又有归档行时报活跃那条（活区优先，而不是谁最近被改过）", () => {
  // 回归点（单盲审查 L2）：候选集按 updated_at 倒序返回，直接取第一条会把「命中归档
  // 区」这个信号盖掉（归档动作刚刷过 updated_at）。口径：有活跃命中就报它。
  const { store, service } = setup();
  const active = store.save({ type: "project", title: "Task A", content: "同一件事" });
  const archived = store.save({ type: "project", title: "task a", content: "同一件事" });
  store.setArchived(archived.id, true);
  const created = service.saveWithDedupe({
    _sessionKey: "sess-both", type: "project", title: "TASK a", content: "同一件事"
  });
  assert.equal(created.action, "created", "标题只差大小写 → 精确标题匹配落空，走新建路径");
  assert.deepEqual(admissionRows(store, "sess-both")[0].metadata.dup, { memory_id: active.id, archived: false, forgotten: false });
});

test("dup：只剩已遗忘未归档的命中时，不把它记成活区命中", () => {
  // 回归（自动评审 #311 write-admission.js:158）：只回 archived 会把遗忘区命中写成
  // archived:false，读审计的人会以为存在活跃重复；而 saveWithDedupe 的候选集本来就排除
  // 遗忘行（store.list 默认 includeForgotten=false），这类命中同样是穿透。两个出口分字段记。
  // 两条行同标题同正文：遗忘之后标题候选集里已经没有它，第二次写入自然走新建路径。
  const { store, service } = setup();
  const first = service.saveWithDedupe({ type: "project", title: "遗忘事实", content: "同一段遗忘正文" });
  store.setForget(first.memory.id, true);
  const second = service.saveWithDedupe({
    _sessionKey: "sess-forgot", type: "project", title: "遗忘事实", content: "同一段遗忘正文"
  });
  assert.equal(second.action, "created", "遗忘行不在去重候选集里，所以确实新建了一行");
  assert.deepEqual(admissionRows(store, "sess-forgot")[0].metadata.dup, {
    memory_id: first.memory.id, archived: false, forgotten: true
  });
});

test("dup：不同内容不记 dup（负样本，免得信号恒真）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T1", content: "第一件事的正文" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T2", content: "另一件事的正文" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.metadata.dup, undefined);
});

test("dup：pinned 行不查候选集（整个不在闸门里，与 g2 的不当基准同口径）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界 X", content: "同一段边界" });
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界 x", content: "同一段边界" });
  const rows = admissionRows(store, "s");
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.metadata.exempt, "pinned");
    assert.equal(row.metadata.dup, undefined, "穿透口不发候选集查询，也不记 dup");
  }
});

test("话题表由审计行重建：新实例（进程重启）仍能认出同话题", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "A", content: "#99 的记录" });

  // 新实例 = 进程重启：内存视图为空，只能从审计行回填
  const revived = createWriteAdmission({ store });
  const service2 = createService({ store, mirror: null, config: {}, writeAdmission: revived });
  service2.saveWithDedupe({ _sessionKey: "s", type: "project", title: "B", content: "#99 又记了一笔" });

  const g2 = admissionRows(store, "s").filter((r) => r.metadata.g2);
  assert.equal(g2.length, 1, "审计行是唯一真相源，重启不回退");
  assert.equal(g2[0].metadata.g2.topic, "#99");
});

test("pinned 行不推进同话题基准（它整个不在闸门里）", () => {
  const { store, service } = setup();
  service.saveWithDedupe({ _sessionKey: "s", type: "constraint", title: "边界", content: "见 #254" });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "记录", content: "见 #254 的另一段" });
  assert.equal(
    admissionRows(store, "s").filter((r) => r.metadata.g2).length,
    0,
    "穿透行不当基准，g2 样本不掺穿透流量"
  );
});

test("llmAudit 关掉时一行都不写（那个开关同时关掉了审计行的保留期清理）", () => {
  const { store, service } = setup({ admissionConfig: { llmAudit: { enabled: false } } });
  service.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "内容 #254" });
  assert.equal(store.listLlmAudits().length, 0, "审计关掉时不得在无保留期的表里按写入频次增长");
});

test("话题锚只取机械可判的两类：issue 引用与文件路径", () => {
  assert.deepEqual(
    extractTopicKeys({ title: "修 #254，#254 已经报过", content: "见 src/service.js 与 docs/handbook/02-write-path.md" }),
    ["#254", "docs/handbook/02-write-path.md", "src/service.js"],
    "去重 + 排序 + 小写归一（同话题必须逐字节相等才能等值比较）"
  );
  assert.deepEqual(extractTopicKeys({ title: "SRC/Service.JS", content: "大小写不该造出两个话题" }), ["src/service.js"]);
  assert.deepEqual(
    extractTopicKeys({ title: "路径", content: "src\\service.js 与 src/service.js 是同一处" }),
    ["src/service.js"],
    "分隔符归一：同一个文件不能因为写法不同变成两个话题"
  );
  // 误报样本：Markdown 标题（###1）、比值（3.5/2.0）、版本号（v1.2.3）都不该成为话题锚
  assert.deepEqual(extractTopicKeys({ title: "###1 小节", content: "比例约 3.5/2.0，版本 v1.2.3" }), []);
  assert.deepEqual(extractTopicKeys({ title: "普通记录", content: "没有任何锚点的一段话" }), []);
  assert.deepEqual(extractTopicKeys({}), []);
});

test("计量失败不反噬写入（旁路，只 warn）", () => {
  const store = createStore(":memory:");
  const throwing = createService({
    store,
    mirror: null,
    config: {},
    writeAdmission: {
      evaluate() { throw new Error("evaluate boom"); },
      record() { throw new Error("record boom"); }
    }
  });
  assert.equal(
    throwing.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T", content: "内容" }).action,
    "created",
    "evaluate 抛错不能挡下写入"
  );

  // evaluate 成功、record 抛错：写入照常返回
  const real = createWriteAdmission({ store });
  const halfBroken = createService({
    store,
    mirror: null,
    config: {},
    writeAdmission: { evaluate: real.evaluate, record() { throw new Error("record boom"); } }
  });
  assert.equal(
    halfBroken.saveWithDedupe({ _sessionKey: "s", type: "project", title: "T2", content: "内容二" }).action,
    "created",
    "record 抛错不能反噬写入"
  );
});

test("接线：memory_save 把会话键交给写入准入，缺会话身份的宿主落 null", async () => {
  const store = createStore(":memory:");
  const writeAdmission = createWriteAdmission({ store });
  const service = createService({ store, mirror: null, config: {}, writeAdmission });
  const registered = [];
  createTools({ tools: { register(def) { registered.push(def); return () => {}; } } }, service, {}, null);
  const save = registered.find((t) => t.name === "memory_save");
  assert.ok(save, "memory_save 应已注册");

  await save.execute(
    { type: "project", title: "T", content: "记录 #254" },
    { agent: { session: { id: "sess-9", header: { agentPreset: "coder", cwd: "D:\\proj" } } } }
  );
  assert.equal(store.countLlmAudits({ sessionKey: "sess-9" }), 1, "工具层要真的把会话键传下去");

  await save.execute({ type: "project", title: "T2", content: "无会话身份" }, {});
  assert.equal(store.countLlmAudits(), 1, "缺会话身份时既不记行也不报错");
});

test("旧库（llm_audit_logs 无 session_key）打开自动补列，准入行照常落", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-admission-"));
  const dbPath = join(dir, "memory.db");
  try {
    // 用裸 DatabaseSync 构造带 #254 之前表结构的旧库
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE llm_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        related_memory_ids TEXT,
        metadata TEXT
      );
      INSERT INTO llm_audit_logs (timestamp, trigger_source, operation_type, model_id, status, metadata)
        VALUES ('2026-01-01T00:00:00.000Z', 'autoDream', 'dream_consolidate', 'm', 'success', '{"old":1}');
    `);
    old.close();

    let store = createStore(dbPath);
    const cols = store.db.prepare("PRAGMA table_info(llm_audit_logs)").all().map((c) => c.name);
    assert.ok(cols.includes("session_key"), "旧库打开必须自动补 session_key 列");
    assert.equal(store.listLlmAudits().length, 1, "存量审计行保留");
    assert.equal(store.listLlmAudits()[0].session_key, undefined, "存量行该列为空");

    const admission = createWriteAdmission({ store });
    const memory = { title: "开工", content: "#254 的准入" };
    admission.record({
      sessionKey: "s1",
      verdict: admission.evaluate({ memory, sessionKey: "s1" }),
      memoryId: "m1"
    });
    assert.equal(store.countLlmAudits({ sessionKey: "s1" }), 1, "迁移后的库上准入行可落可查");

    // 重复打开幂等：列不重复、既有行不丢
    store.close();
    store = createStore(dbPath);
    assert.equal(store.countLlmAudits({ sessionKey: "s1" }), 1, "重复打开不丢数据");
    assert.equal(store.countLlmAudits(), 2, "既有的 LLM 审计行与准入行都在");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
