// #254 写入准入（第一阶段：只计量，不拦截）。
//
// 为什么先只计量：会话写入预算的 N 与同话题冷却的 X 在没有真实分布时拍任何数字
// 都是误杀面（维护者 2026-09-23 拍板「先记录不拦，由遥测定」）。所以这一阶段只把
// 两个闸门的原始测量点写进 llm_audit_logs（status='skipped'、metadata.gate='g1'
// 且同话题重复时附 metadata.g2），不做判定、不改任何写入行为；第二阶段把拦截打开
// 时才引入阈值与二次确认（memory_save({confirm:true})）。
//
// 为什么复用 llm_audit_logs：它是仓库既有的「后台动作回执」表（bookkeeping，不
// 触发写钩子，见 store.js 的表注释）。第二阶段落地时「第一次 skipped/gate →
// 第二次 confirm:true 放行」在审计里成对出现，因果可回放。
//
// 一行一个新建行（不是一行一个信号）：这样「会话内新建条数」就是按 session_key
// 的直接计数，不需要任何 JSON 解析；g2 命中时作为该行的 metadata.g2 附带，不做第
// 二行。测量点只取在新行上——并入已有行是去重机制在正常工作，既不进预算也不记行。
// 会话身份来自工具 exec（scope.js › sessionKeyOf）：没有会话身份的写入（dream /
// summarize / import / organize）不进预算，预算管的是「一次对话里写飞了」。
//
// 穿透口（与 #275 拍板 5 的 pinned 豁免同口径）：constraint / preference 是 #249
// 第一批立的逐字保真池，永不进预算；仍记一行审计（metadata.exempt='pinned'）以便
// 观察穿透频率。穿透行既不参与 g2 判定，也不推进同话题的时间基准——它整个不在闸门
// 里，成为下一次比较的基准会把 g2 的样本混进穿透流量。
//
// 内容哈希（exact duplicate，第三类测量点，维护者 2026-09-24 拍板）：归一化口径定在
// content-hash.js，命中即「同一内容又被写了一次」。判据用哈希而不是相似度——相似度
// 阈值在同一件事换个说法 / 不同的事共享话题词之间来回挪，只会换一种错法。候选集先按
// type 与 scope 三维等值收窄再比哈希（不是全表扫），并把归档行一并纳入：「出口止体积、
// 不止重复」，被质量闸归档的同一个事实不在 saveWithDedupe 的候选集里（store.list 默认
// 排除归档），同样的内容再写一次就是一条新行，这正是这条信号要量的穿透。两个穿透口与
// pinned 豁免同口径：pinned 在这里返回得更早，连候选集查询都不发。
//
// 信号跟着同一行审计走，所以内容哈希与 g1/g2 覆盖同一批写入（会话内新建行）；无会话
// 身份的系统写入（dream / summarize / import / organize）要另立行形状，不在本批。
//
// 与 llmAudit.enabled 的关系：那个开关同时关掉审计行的启动期清理（index.js 的
// deleteOldLlmAudits），所以关掉时本模块一行都不写，否则就是在无保留期的表里做
// 按写入频次增长。
import { PINNED_MEMORY_TYPES } from "./service.js";
import { contentHashOf } from "./content-hash.js";

// 审计口径（llm_audit_logs 的既有列）：trigger_source = 组件名，operation_type =
// 动作名，status='skipped' = 本行没有产生任何 LLM 花费（与 summarize 的间隔门、
// 尖峰门同款读法）。
export const ADMISSION_TRIGGER_SOURCE = "writeAdmission";
export const ADMISSION_OPERATION_TYPE = "write_admission";
export const ADMISSION_GATE_SESSION_BUDGET = "g1";

// 首次见到某会话时的回填深度：话题表由审计行重建，只回填最近这么多行。更早的
// 话题会漏（测量口径可接受），换来的是一次查询与有界的常驻内存。
export const TOPIC_LOOKBACK_ROWS = 200;

// 话题锚只收机械可判的两类：issue/PR 引用与文件路径。两条都带前缀或分隔符，误报
// 面小；自由文本里看不出确定性的「同话题」，硬判只会把误杀面提前引进来（#254 已
// 定：计量信号用确定性锚，不用相似度阈值——同一件事换个说法就掉下去，不同的事
// 共享话题词又顶上来，阈值怎么挪都是在两种误判之间来回）。
// 两处收紧都来自误报样本：`(?<![#\w])` 挡掉 Markdown 标题 `###1` 与紧跟标识符的
// 井号；扩展名要求首字符是字母，挡掉 `3.5/2.0` 这类比值（否则一个算式就成了话题）。
const ISSUE_REF = /(?<![#\w])#\d{1,7}\b/g;
const FILE_PATH = /(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,5}\b/g;

/**
 * 写入文本里的确定性话题锚：小写归一 + 路径分隔符统一为 `/` + 去重 + 排序。
 * 同一话题在不同轮次必须逐字节相等，才能用等值比较而不是相似度比较——所以
 * `src\service.js` 与 `src/service.js` 必须归到同一个锚。
 * @param {{title?: string, content?: string, tags?: string[]}} memory
 * @returns {string[]} 排序后的话题锚
 */
export function extractTopicKeys(memory) {
  const text = [memory?.title, memory?.content, ...(Array.isArray(memory?.tags) ? memory.tags : [])]
    .filter((s) => typeof s === "string")
    .join("\n");
  const keys = new Set();
  const add = (raw) => keys.add(raw.toLowerCase().replace(/\\/g, "/"));
  for (const m of text.matchAll(ISSUE_REF)) add(m[0]);
  for (const m of text.matchAll(FILE_PATH)) add(m[0]);
  return [...keys].sort();
}

/**
 * 写入准入（#254）。返回的两个方法就是三个消费方共用的那份接口：
 *   evaluate 给出决策形状（阶段一恒 allow），record 把测量点写成审计行。
 * 阶段二在 evaluate 里引入阈值与 confirm 分支；#249 的注入提示与 #275 的水位计数
 * 都读同一份 decision/审计行，而不是各写一套判定。
 *
 * @param {object} deps
 * @param {object} deps.store 存储层（listLlmAudits / saveLlmAudit）
 * @param {object} [deps.config] 已解析配置（读 llmAudit.enabled）
 * @param {object} [deps.logger]
 * @param {() => number} [deps.now] 时钟注入（测试用）
 */
export function createWriteAdmission({ store, config, logger, now = Date.now } = {}) {
  // sessionKey → Map<话题锚, 最近一次新建行时刻(ms)>。真相源是审计行，这里只是它的
  // 增量视图：进程重启后按需回填。FIFO 上限防长驻进程内存无界（同 store.js 的
  // embedding 解析缓存口径）。
  const topicTables = new Map();
  const SESSION_CACHE_MAX = 200;

  const warn = (msg) => {
    // 计量是旁路：任何一环失败都不能影响写入，日志自身故障也一样。
    try {
      logger?.warn?.(msg);
    } catch { /* ignore */ }
  };

  /** 某会话的话题表（首见时从审计行回填，之后走内存增量）。 */
  function topicTable(sessionKey) {
    const cached = topicTables.get(sessionKey);
    if (cached) return cached;
    const table = new Map();
    try {
      const rows = store?.listLlmAudits?.({ sessionKey, limit: TOPIC_LOOKBACK_ROWS }) ?? [];
      for (const row of rows) {
        const metadata = row?.metadata;
        if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.topics)) continue;
        // 穿透行（pinned）整个不在闸门里，也就不该进基准表——只挡内存路径不挡回填，
        // 重启后口径就变了（同一个话题会因为一条穿透行而被判成重复）。
        if (metadata.exempt) continue;
        const at = Date.parse(row.timestamp);
        // 坏时间戳跳过：落到 0 会让 gap 变成几十年，一个离群值就能带偏按分位定的 X。
        if (!Number.isFinite(at)) continue;
        for (const topic of metadata.topics) {
          // 审计行按时间倒序返回，先到的那条就是该话题最近一次写入——后来的不覆盖。
          if (!table.has(topic)) table.set(topic, at);
        }
      }
    } catch (e) {
      // 回填失败降级为「本会话此前的话题不可见」：漏一个 g2 测量点，不影响写入。
      warn(`[dsh-mneme] write admission topic backfill failed: ${String(e)}`);
    }
    if (topicTables.size >= SESSION_CACHE_MAX && !topicTables.has(sessionKey)) {
      topicTables.delete(topicTables.keys().next().value);
    }
    topicTables.set(sessionKey, table);
    return table;
  }

  /**
   * 内容哈希候选集查询（#254 第三类测量点）。失败降级为「没命中」：漏一个测量点，
   * 不影响写入，也不让计量反噬。
   * 多条命中时的取舍（活区优先）：有活跃/未遗忘的命中就报它（判据是「去重候选集本该
   * 拦住」），只有归档/遗忘行命中才报它们。store 侧已把活跃行排在窗口头部，这里的 find
   * 是防御性重复：排序口径将来再变，本判据也不跟着变。
   * archived 与 forgotten 分开回：两者都是「出口」，但穿透含义不同——只命中已遗忘行时
   * 若只回 archived=false，读审计的人会以为库里有活跃重复；而 saveWithDedupe 的候选集
   * 本来就排除遗忘行（store.list 默认 includeForgotten=false），这类命中同样是穿透。
   * @returns {{memory_id: string, archived: boolean, forgotten: boolean}|null}
   */
  function lookupContentDup(memory) {
    try {
      const hash = contentHashOf(memory);
      if (!hash) return null;
      const hits = store?.findContentHashMatches?.({
        type: memory?.type,
        hash,
        agent_scope: memory?.agent_scope,
        workspace_scope: memory?.workspace_scope,
        sensitivity: memory?.sensitivity
      }) ?? [];
      const hit = hits.find((h) => !h.archived && !h.forgotten) ?? hits[0];
      return hit ? { memory_id: hit.id, archived: hit.archived === true, forgotten: hit.forgotten === true } : null;
    } catch (e) {
      warn(`[dsh-mneme] write admission content hash lookup failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 阶段一决策：恒 allow（本模块里没有阈值），只算出三个闸门的测量点。返回形状一次
   * 定死，阶段二只往里加分支、不改字段：
   *   decision — "allow" | "confirm"（阶段一只可能 allow）
   *   gate     — "g1" | null（null = 这次写入不进预算，不记行）
   *   topics   — 本次写入的确定性话题锚
   *   repeat   — {topic, gapMs} | null（g2 的命中面）
   *   dup      — {memory_id, archived, forgotten} | null（内容哈希的命中面）
   *   exempt   — null | "pinned"
   * @param {{memory: object, sessionKey?: string|null}} input
   */
  function evaluate({ memory, sessionKey } = {}) {
    const verdict = { decision: "allow", gate: null, topics: [], repeat: null, dup: null, exempt: null };
    // 无会话身份 = 系统写入（dream / summarize / import / organize），不进预算。
    if (!sessionKey) return verdict;
    // 审计关掉时不记行、也不推进话题表（见文件头：那个开关连启动期清理一起关掉）。
    if (config?.llmAudit?.enabled === false) return verdict;
    const topics = extractTopicKeys(memory);
    const pinned = PINNED_MEMORY_TYPES.has(String(memory?.type ?? ""));
    if (pinned) return { ...verdict, gate: ADMISSION_GATE_SESSION_BUDGET, topics, exempt: "pinned" };
    const dup = lookupContentDup(memory);
    const table = topicTable(sessionKey);
    const at = now();
    let repeat = null;
    for (const topic of topics) {
      if (!table.has(topic)) continue;
      const gapMs = Math.max(0, at - table.get(topic));
      // 同一行可能命中多个锚：取最近的那次（间隔最短＝最有价值的那次重复）。
      if (!repeat || gapMs < repeat.gapMs) repeat = { topic, gapMs };
    }
    return { ...verdict, gate: ADMISSION_GATE_SESSION_BUDGET, topics, repeat, dup };
  }

  /**
   * 把测量点落成审计行（一行一个新建行）。三个信号的读法：
   *   g1 会话写入预算：`GROUP BY session_key` 计数即得「会话内新建条数」分布；要剔
   *      掉穿透行（pinned 不进预算）就加 `json_extract(metadata,'$.exempt') IS NULL`。
   *   g2 同话题冷却：`json_extract(metadata,'$.g2.gap_ms')` 即得「同话题新建行间隔」
   *      分布。间隔算的是同一话题两次**新建行**之间——标题命中走并入的那次不在这里
   *      （并入正是冷却要做的事，已经做到了）。
   *   dup 内容哈希：`json_extract(metadata,'$.dup.memory_id')` 非空即「这条新行的内容
   *      与某条既有行归一化后逐字节相同」；`$.dup.archived` 区分命中那条在活区还是
   *      归档区——归档区命中就是去重候选集漏掉的那一类穿透。
   * 计量绝不影响写入：任何异常只 warn。
   * @returns {object[]} 落下的审计行（无测量点或失败时为空数组）
   */
  function record({ sessionKey, verdict, memoryId } = {}) {
    if (!sessionKey || !verdict || verdict.gate == null) return [];
    const at = now();
    const topics = Array.isArray(verdict.topics) ? verdict.topics : [];
    const rows = [];
    try {
      rows.push(store.saveLlmAudit({
        timestamp: new Date(at).toISOString(),
        trigger_source: ADMISSION_TRIGGER_SOURCE,
        operation_type: ADMISSION_OPERATION_TYPE,
        // 不是模型调用，但该列 NOT NULL——用显式占位串，免得被当成某条路由的
        // 花费来源统计进去。
        model_id: "-",
        status: "skipped",
        related_memory_ids: memoryId ? [memoryId] : [],
        session_key: sessionKey,
        metadata: {
          gate: verdict.gate,
          topics,
          ...(verdict.exempt ? { exempt: verdict.exempt } : {}),
          ...(verdict.repeat ? { g2: { topic: verdict.repeat.topic, gap_ms: verdict.repeat.gapMs } } : {}),
          // dup 两个出口分字段落盘：archived 与 forgotten 是两类不同的穿透，合成一个布尔
          // 会让「只剩遗忘行命中」读起来像「库里有活跃重复」（见 lookupContentDup 注释）。
          ...(verdict.dup
            ? { dup: {
              memory_id: verdict.dup.memory_id,
              archived: verdict.dup.archived === true,
              forgotten: verdict.dup.forgotten === true
            } }
            : {})
        }
      }));
    } catch (e) {
      // 审计失败只 warn（同 saveLlmAudit 的调用惯例），写入本身照常完成。
      warn(`[dsh-mneme] write admission audit failed: ${String(e)}`);
    }
    // 只有真正落库、且不是穿透口的行才推进话题表：审计写失败时内存视图不能跑在审计
    // 前面（重启回填会得到另一条时间线），pinned 写入整个不在闸门里。
    if (rows.length > 0 && !verdict.exempt) {
      const table = topicTable(sessionKey);
      for (const topic of topics) table.set(topic, at);
    }
    return rows;
  }

  return { evaluate, record };
}
