// dsh-mneme/src/document.js
// document 型记忆注册（issue #230，口径基线 = #164 设计稿评审线）：agent 产
// 长文档的指针行铸造口。写入权分离——全文归 agent（管线对文件零读零写零改），
// 管线只做四件事：注册校验（文件存在 + 路径合法 + evidence 求交）、摘要 +
// doc_path 落库（库里只存这三样）、C2 vector 档比对去重、supersede 记账
// （出新版 = 新摘要行 supersede 旧行，旧文件不删，content_history 可追溯）。
//
// 独立成模块（AGENTS.md 尺寸约定，同 recallStats 先例）：service.js 已过
// 2000 行参考线，这里只依赖注入 service 内部件，barrel 出口在 service.js，
// 调用方零改动。防绕过三层兜底：service 两条业务守卫（saveWithDedupe /
// updateMemory）+ 存储层唯一铸造口（store.saveDocument，通用 save/update/
// CAS 整类拒绝 document）——注册是唯一铸造口。

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { scopeKeyOf } from "./scope.js";
import { cosineSimilarity } from "./dream/clustering.js";

// C2 vector 档阈值（#164 拍板 0.92，与 findSessionDuplicate 的 vector 档同源）。
// 刻意不做 24h 时间窗：那个窗是会话去重的「近邻界」（findSessionDuplicate 注释），
// 不是相似度语义本身；document 版本更新天然跨天/跨周，套窗会把一周后重注册的
// 新版判成「无近重复」，留下两行活跃摘要漂移——supersede 探测必须全时段。
const DOCUMENT_MIN_SIM = 0.92;
const CANDIDATE_LIMIT = 200;

// 追加到被取代行正文的指针注记。刻意不带语言分支：id 是跨语言稳定键（用户
// 对 tag/章节名建议用英文同理——指针性内容不翻译）；可追溯链 = 注记里的新行
// id + 旧行 content_history 里的旧摘要（source=superseded）。
const supersededByPointer = (id) => `\n\n[superseded by ${id}]`;

/**
 * Build the document registrar. Injected deps are service.js closure members
 * (store / embedQuery / transaction / finalize) so this module stays free of
 * service-internal wiring; `finalize` is the single write epilogue (mirror
 * sync + notify + re-embed) so callers never duplicate it.
 *
 * @returns {(payload: object) => Promise<object>}
 *   `{ action: "created"|"superseded", memory, superseded?, evidence_kept,
 *      evidence_dropped, degraded }`
 * @throws flag 关 / 路径非法或文件缺失 / title 或 summary 为空 / evidence 全部
 *   捏造 / 仅 vector 近重复（疑似重复外档，交 agent 裁决而不是静默二选一）。
 */
export function createDocumentRegistrar({ store, config, embedQuery, pushContentHistory, transaction, finalize }) {
  return async function registerDocument(payload, { hiddenEvidenceIds = [] } = {}) {
    // opt-in 总闸（#230 对齐 #228 形态）：关 = 注册入口整体不存在，错误信息
    // 指回配置键，agent 能准确转告用户去开。
    if (config?.documentMemoryEnabled !== true) {
      throw new Error("document memory is disabled (documentMemoryEnabled)");
    }

    // --- 1. 路径合法 + 文件存在 --------------------------------------------
    // 只认展开 ~ 后的绝对路径：相对路径依赖进程 cwd，注册时的 cwd 与读取时
    // 的 cwd 不保证一致，指针必须自带完整定位。校验存在 + 常规文件 + 非空——
    // 空文件/被截断成 0 字节是「文字结构意外破坏」的最早信号，注册时拦住
    // 而不是落一条死指针（回退路径：agent 修好文件后重注册，同 path/title
    // 自动 supersede 旧行）。
    const rawPath = String(payload?.path ?? "").trim();
    if (!rawPath) throw new Error("registerDocument: path is required");
    // 只展开 ~ / ~/（~user 形式拒收为普通相对路径走 isAbsolute 拦截——不猜测
    // 其他用户的 home，错展开比报错更糟）。
    const isTilde = rawPath === "~" || rawPath.startsWith("~/") || rawPath.startsWith("~\\");
    const absolute = isTilde ? resolve(homedir(), rawPath.slice(2)) : rawPath;
    if (!isAbsolute(absolute)) {
      throw new Error(`registerDocument: path must be absolute (got "${rawPath}")`);
    }
    // 所有绝对路径统一 resolve 归一化（. / .. / 重复分隔符）——归一化不做的话，
    // D:\a\.\b.md 与 D:\a\b.md 会被判成两个路径，同文件绕过 same-path
    // supersede，留下双活跃指针。realpathSync 刻意不用：符号链接合并会改写
    // agent 提交的路径字面量，指针的可读性比追符号链更重要。
    const expanded = resolve(absolute);
    let stat = null;
    try { stat = statSync(expanded); } catch { /* missing/unreadable → null */ }
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`registerDocument: document file not found or empty: ${expanded}`);
    }

    // --- 2. evidence 求交（sleep.js 扫描集求交同款语义）---------------------
    // 引用的原子条必须真实存在且未归档（归档行已被降级，不再为新鲜 document
    // 背书）。红线 4 宽容形态：合法子集落库 + evidence_degraded 系统标记；
    // 提供了 evidence 但全军覆没 = 捏造信号，整单拒绝，agent 修正后重试。
    const wanted = [...new Set(
      (Array.isArray(payload?.evidence) ? payload.evidence : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    )];
    // strictScope（tools 层传入，#170 复核项 4 同款）：调用者 scope 看不见的
    // 行按「不存在」处理——不得为跨 scope id 建立引用（存在性泄漏），与
    // unknown/archived 同落 dropped，evidence_kept/dropped 计数保持诚实。
    const hidden = new Set((Array.isArray(hiddenEvidenceIds) ? hiddenEvidenceIds : []).map((id) => String(id)));
    const kept = [];
    const dropped = [];
    for (const id of wanted) {
      const row = hidden.has(id) ? null : store.getById(id);
      (row && !row.archived ? kept : dropped).push(id);
    }
    if (wanted.length > 0 && kept.length === 0) {
      throw new Error(
        `registerDocument: all ${wanted.length} evidence ids are unknown, archived or out of scope — fabricated evidence is rejected`
      );
    }

    const title = String(payload?.title ?? "").trim();
    if (!title) throw new Error("registerDocument: title is required");
    const summary = String(payload?.summary ?? "").trim();
    if (!summary) throw new Error("registerDocument: summary is required");

    // --- 3. supersede 目标探测（三层）---------------------------------------
    // 同 doc_path / 同标题 = agent 显式的「出新版」意图 → supersede；仅 vector
    // 近重复而路径标题都不同 = 疑似重复外档 → 拒绝并指路。C2×C1 硬线：比对
    // 不得越过矛盾裁决替 agent 二选一——改既有行还是归档后重注册，判断权留在
    // agent 手里。去重键带 scope（scopeKeyOf）：跨作用域永不互判（防泄漏，与
    // saveWithDedupe 的 scopeMatches 同口径）。
    const scopeMatches = (m) =>
      scopeKeyOf(m.agent_scope) === scopeKeyOf(payload?.agent_scope) &&
      scopeKeyOf(m.workspace_scope) === scopeKeyOf(payload?.workspace_scope) &&
      scopeKeyOf(m.sensitivity) === scopeKeyOf(payload?.sensitivity);
    const samePath = (a, b) => {
      if (!a || !b) return false;
      // Windows 文件系统大小写不敏感：比较前归一，否则 C:\a.md 与 c:\A.md
      // 会被判成两个版本。
      const norm = (p) => (process.platform === "win32" ? String(p).toLowerCase() : String(p));
      return norm(a) === norm(b);
    };
    // 精确层（同路径/同标题）必须全量扫描、不允许窗口截断：>200 行活跃
    // document 时，窗口外的同路径旧版漏检会留下双活跃版本——supersede 判定
    // 是正确性要求，不是性能优化对象。vector 档比对保留 CANDIDATE_LIMIT
    // （getEmbeddings + 两两 cosine 才是有界对象）。
    const scopeMatched = store
      .list({ type: "document", limit: null })
      .filter((m) => scopeMatches(m));
    const explicitTarget = scopeMatched.find((m) => samePath(m.doc_path, expanded))
      ?? scopeMatched.find((m) => m.title.trim() === title);
    if (!explicitTarget) {
      // vector 档：embedder 不可用/向量缺失一律跳过——去重是增强不是写入依赖
      // （findSessionDuplicate 同原则）。probe 用 title+summary，与行向量
      // （同两段拼接 embed）同构。
      const candidates = scopeMatched.slice(0, CANDIDATE_LIMIT);
      try {
        const vecs = store.getEmbeddings(candidates.map((m) => m.id));
        if (vecs.size) {
          const probe = await embedQuery([title, summary].filter(Boolean).join("\n"));
          if (probe) {
            let best = null;
            for (const m of candidates) {
              const v = vecs.get(m.id);
              if (!v) continue; // 无向量的既有行不参与比对（无信号 = 不判定）
              const sim = cosineSimilarity(probe, v);
              if (sim >= DOCUMENT_MIN_SIM && (!best || sim > best.sim)) best = { m, sim };
            }
            if (best) {
              throw new Error(
                `registerDocument: summary is a near duplicate (C2 >= ${DOCUMENT_MIN_SIM}, sim ${best.sim.toFixed(3)}) ` +
                `of document row ${best.m.id} "${best.m.title}" — update that row via memory_update, or archive it ` +
                `before registering a separate document`
              );
            }
          }
        }
      } catch (e) {
        // 近重复拒绝是业务结果，原样上抛；embedder 故障吞掉回落（只做路径/标题层）。
        if (e instanceof Error && e.message.startsWith("registerDocument:")) throw e;
      }
    }

    // --- 4. 落库 + supersede 记账（同事务）----------------------------------
    // 新摘要行：库里只存 summary + doc_path + evidence（+ scope 标注），旧文件
    // 零触碰。supersede：旧行 content_history 存旧摘要（source=superseded）、
    // 正文追加指向新行的注记、归档（降可及性可复活，无物理删除）。
    const userTags = (Array.isArray(payload?.tags) ? payload.tags : [])
      .map((t) => String(t ?? "").trim())
      .filter(Boolean);
    const tags = [...new Set([...userTags, ...(dropped.length ? ["evidence_degraded"] : [])])];
    const result = transaction(() => {
      // saveDocument 是存储层唯一 document 铸造口（通用 save/update/CAS 拒绝
      // document——CodeRabbit 复核 #8/#882）：registerDocument 传入的 doc_path
      // 已过归一化与文件校验。
      const created = store.saveDocument({
        type: "document",
        title,
        content: summary,
        tags,
        importance: Number.isInteger(payload?.importance)
          ? Math.min(5, Math.max(1, payload.importance))
          : 3,
        source: payload?.source ?? "tool",
        evidence: kept,
        doc_path: expanded,
        // sensitivity 进 supersede 匹配键（scopeKeyOf 第三维）：不落库的话，
        // 首注册带 sensitivity、重注册同键会在匹配时判成两 scope，旧版漏检。
        ...(payload?.sensitivity !== undefined ? { sensitivity: payload.sensitivity } : {}),
        ...(payload?.agent_scope !== undefined
          ? { agent_scope: payload.agent_scope, agent_scope_source: payload.agent_scope_source }
          : {}),
        ...(payload?.workspace_scope !== undefined
          ? { workspace_scope: payload.workspace_scope, workspace_scope_source: payload.workspace_scope_source }
          : {})
      });
      let superseded;
      const loser = explicitTarget ? store.getById(explicitTarget.id) : null;
      if (loser && !loser.archived) {
        store.update(loser.id, {
          content: `${loser.content}${supersededByPointer(created.id)}`,
          content_history: pushContentHistory(loser, "superseded")
        });
        store.setArchived(loser.id, true);
        superseded = store.getById(loser.id);
      }
      return { created, superseded };
    });
    finalize(result.superseded ? [result.created, result.superseded] : [result.created]);
    return {
      action: result.superseded ? "superseded" : "created",
      memory: result.created,
      ...(result.superseded ? { superseded: result.superseded } : {}),
      evidence_kept: kept.length,
      evidence_dropped: dropped.length,
      degraded: dropped.length > 0
    };
  };
}
