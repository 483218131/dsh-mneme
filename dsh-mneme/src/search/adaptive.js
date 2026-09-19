// Adaptive vector threshold (v0.5.0 召回率优化 1.2): replaces the fixed
// vectorSearchThreshold=0.65 with a query-aware cutoff.
//   entity:/attr: prefixes → 0.5  (entity recall is name-driven; loosen)
//   very short queries      → 0.7  (<5 chars match almost anything; tighten)
//   very long queries       → 0.6  (semantically specific; loosen a little)
//   head-gap rule           → when the top-1 vs top-5 candidate gap exceeds
//                             0.3 the head is decisive — loosen to 0.5 so
//                             the tail still reaches the reranker
//   otherwise               → 0.65 (the legacy default)
// Pure and total: same inputs, same cutoff, no store access.
export function adaptiveThreshold(query, candidates = []) {
  const q = String(query ?? "");
  if (q.startsWith("entity:") || q.startsWith("attr:")) return 0.5;
  if (q.length > 0 && q.length < 5) return 0.7;
  if (q.length > 50) return 0.6;
  const scores = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (typeof c?._score === "number" ? c._score : typeof c?.score === "number" ? c.score : 0))
    .filter((s) => s > 0)
    .sort((a, b) => b - a);
  if (scores.length >= 5 && scores[0] - scores[4] > 0.3) return 0.5;
  return 0.65;
}

// Issue #239（第 5 项）：注入条数的查询自适应（去 always-on 化的一半）。
// 依据：不确定性强的话题多召回、确定性的少召回（Oblivion 的不确定性驱动读路径）；
// 但**注入相关却带偏生成**的内容可能比不注入更糟（2607.24010 与 2604.02280 两处
// 独立出处），所以这里只做**单向收缩**：模糊 → 维持用户配置的上限，确定 → 收缩，
// 绝不越过上限。判据只看查询本身——不做额外检索（2607.24010：触发侧成本别忽略，
// 先探针检索等于白付一次 fuseRecall）。
const RECALL_CUES = [
  // 中文回指 / 时间线索：出现即说明用户要的是「记忆里的东西」，当场算不出来
  "上次", "之前", "以前", "那天", "那次", "刚才", "刚刚", "后来", "很早",
  "还记得", "记不记得", "我们讨论", "我们聊", "我说过", "你提过", "提到过",
  "最近", "上次说", "之前说",
  // 英文同类线索
  "last time", "previously", "earlier", "remember", "we discussed",
  "i mentioned", "you said", "that thing", "remind me"
];

/**
 * 这段查询是否需要「宽召回」。命中回指/时间线索，或短到几乎匹配任何东西
 * （与 adaptiveThreshold 对 <5 字符的判断同源）。纯函数、零成本。
 * 拿不到查询时不猜——返回 true 维持现状。
 */
export function needsBroadRecall(query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (q === "") return true;
  if (q.length < 5) return true;
  return RECALL_CUES.some((cue) => q.includes(cue));
}

/**
 * 注入条数的自适应预算：模糊 → 维持配置上限；确定 → 收缩到一半（下限 1）。
 * `maxItems <= 1` 时原样返回（含 0 = 不注入，flag 打开也不该把 0 变成 1）。
 */
export function adaptiveInjectBudget(query, maxItems) {
  const cap = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : maxItems;
  if (!Number.isFinite(cap) || cap <= 1) return cap;
  return needsBroadRecall(query) ? cap : Math.max(1, Math.ceil(cap / 2));
}
