import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { STR, langOf } from "./lang.js";
import { PACKAGE_VERSION } from "./version-check.js";

export const TYPE_FILE = {
  preference: "preferences.md",
  project: "projects.md",
  decision: "decisions.md",
  history: "history.md",
  summary: "summary.md",
  pitfall: "pitfalls.md",
  constraint: "constraints.md",
  rejected_solution: "rejected-solutions.md",
  pattern: "patterns.md",
  document: "documents.md"
};

// 不落镜像的 type。现在是空集：document 由 #296 第二批收进来——第一版排除它的
// 理由是「镜像块渲染的字段里没有 doc_path，落一个 documents.md 会得到看着完整、
// 其实找不到文件的视图」，doc_path 进指针行以后这条理由不再成立。这个集合由
// test/mirror-types.test.js 钉死（TYPES \ TYPE_FILE 必须恰好等于本集合）：将来
// 新增 type 时必须显式决定它落不落镜像，静默漏掉才是 #278 要修的那种盲区。
export const MIRROR_EXCLUDED_TYPES = new Set([]);

// 只读视图（#296）：document 的镜像只有指针行（id + 标题 + 摘要首句 + doc_path），
// 没有可编辑的正文，所以它不参与 readHumanEdits 的人改合并，手工改动一律被下次
// 同步覆盖；导出/导入也不带它（那两个是 round-trip 通道，见 api.js）。
export const MIRROR_READONLY_TYPES = new Set(["document"]);

const ESCAPE = /([\\`*_[\]{}()#+.!|>~-])/g;
const UNESCAPE = new RegExp("\\\\" + ESCAPE.source, "g");
// 只读视图里摘要首句的字符上限（#296）：够定位就行，长摘要不该把一行撑成一段。
const POINTER_MAX = 120;

function esc(text) {
  return String(text).replace(ESCAPE, "\\$1");
}

function unescape(text) {
  return String(text).replace(UNESCAPE, "$1");
}

// 元数据标签的唯一来源是 STR.mirrorLabel（lang.js）：渲染按实例语言取，解析两套
// 都认。下面的正则从那张表现算——旧实现把手写正则与 lang.js 的两处文案分开维护，
// 加一个字段要改三处，漏改一处那一行就会随 /import 写进 entry 的 content。
const META_LABELS = [];
for (const language of Object.keys(STR.mirrorLabel)) META_LABELS.push(...Object.values(STR.mirrorLabel[language]));

function reEsc(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 元数据行的值必须单行：值里带换行会多出一行，轻则破坏「整段元数据行」的解析契约，
// 重则伪造出一个条目头（sensitivity 是调用方传入的任意字符串，属信任边界）。
function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

// 结构头锚：ID 行紧跟类型行才算条目头（正文里机器格式的 ID 行不会切开块）。
const ANCHOR_RE = new RegExp(
  "^- \\*\\*ID\\*\\*: `([^`]+)`\\n- \\*\\*(?:" +
    [STR.mirrorLabel.zh.type, STR.mirrorLabel.en.type].map(reEsc).join("|") +
    ")\\*\\*:", "gm"
);
// 渲染出的整段元数据行（加字段只需改 lang.js 的 mirrorLabel）。
const META_RUN_RE = new RegExp(`^(- \\*\\*(?:${META_LABELS.map(reEsc).join("|")})\\*\\*:.*\\n?)+`);
// 三方合并用的版本令牌（service.syncMirror 比对并发写）。
const UPDATED_RE = new RegExp(
  "- \\*\\*(?:" + [STR.mirrorLabel.zh.updated, STR.mirrorLabel.en.updated].map(reEsc).join("|") +
    ")\\*\\*: ([^\\n]+)"
);

function renderMemory(m, language = "zh") {
  // last-rendered digest baseline: sha256(title \x00 content). service.js
  // compares the file hash against this to tell "untouched by a human" (machine
  // write wins) apart from a real human edit, so a not-yet-re-rendered store
  // update is not misread as a concurrent human edit.
  const digest = createHash("sha256")
    .update(`${m.title}\x00${m.content}`)
    .digest("hex");
  const lines = [];
  lines.push(`## ${esc(m.title)}`);
  lines.push("");
  lines.push(`- **ID**: \`${m.id}\``);
  const ML = STR.mirrorLabel[language];
  lines.push(`- **${ML.type}**: ${m.type}`);
  lines.push(`- **${ML.importance}**: ${m.importance}`);
  lines.push(`- **${ML.tags}**: ${m.tags.map((t) => `\`${esc(t)}\``).join(" ")}`);
  lines.push(`- **${ML.updated}**: ${m.updated_at}`);
  if (m.source) lines.push(`- **${ML.source}**: ${esc(m.source)}`);
  // scope / sensitivity 是只读展示字段（#278：sensitivity 的过滤语义另有归属，见
  // 那条讨论；这里只把值摆出来）。只在真有值时渲染——本机 2843 条里只有 37 条带
  // scope 标签，无条件渲染会给每条目多添两行空字段。
  const scopeText = [m.agent_scope, m.workspace_scope].filter(Boolean).map(oneLine).join(" / ");
  if (scopeText) lines.push(`- **${ML.scope}**: ${scopeText}`);
  if (m.sensitivity) lines.push(`- **${ML.sensitivity}**: ${oneLine(m.sensitivity)}`);
  lines.push("");
  lines.push(`<!-- mirror-digest: ${digest} -->`);
  lines.push(m.content);
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

/**
 * 文件头 frontmatter（#278 第一批）。按 type 分文件时一个文件装 N 条，所以
 * frontmatter 只能落在文件级；条目级元数据仍是块内的 `- **字段**:` 行（见
 * renderMemory）。
 *
 * `covered` / `coverage` 是覆盖范围的自述，必须与这份文本**实际包含的行集**一致：
 * 磁盘镜像写活跃集（active-only），/export 的文档写全表（all）。说一套写一套比
 * 没有这个字段更糟——外部工具会照着它聚合条数与标签。
 *
 * 键名对齐 OKF v0.2：`type` 是 §4.1 唯一必填键，`tags` 是 §4.1 的推荐键，
 * `generated.by` / `generated.at` 是 §5.2 的 trust 族。`generated.by` 按 §7 的
 * actor 约定写 `<producer>/<version>`（所以带版本号）；`generated.at` 按 §5.2 的
 * 语义只记「内容上次真正变化」，sync 因此只在正文变化时才落盘。v0.2 已用
 * `generated.at` 取代 v0.1 的 `timestamp`，没有 `updated` 这个顶层键。
 * `covered` / `coverage` 是 §4.1 允许的 producer 自定义扩展。
 */
export function renderFileHeader(type, items, coverage = "active-only") {
  const tags = [...new Set(items.flatMap((m) => (m.tags ?? []).map(String)))].sort();
  return [
    "---",
    `type: ${type}`,
    `generated.by: dsh-mneme/${PACKAGE_VERSION}`,
    `generated.at: ${new Date().toISOString()}`,
    `covered: ${items.length}`,
    `coverage: ${coverage}`,
    `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    ""
  ].join("\n");
}

/**
 * document 的只读视图一行（#296）：一句话定位 + 文件指针，正文按 doc_path 去读。
 * 摘要首句按句末标点切，切不出来就整段（超长再按字符数兜底），保证「一行一个
 * 文档」的形态不被长摘要撑破。
 */
function renderPointer(m) {
  const flat = String(m.content ?? "").replace(/\s+/g, " ").trim();
  // 句末标点切首句：中文的。！？ 后面通常不跟空格，不能像英文那样要求一个空白
  // （要求了就一句都切不出来，整段摘要被当成「首句」塞进视图）。英文的 . 仍要求
  // 后接空白或结尾，免得把 e.g. / v1.2 这类点号当成句末。
  const first = flat.match(/^.*?(?:[。！？]|[!?]|[.](?=\s|$))|^.*$/s)?.[0] ?? flat;
  // 按码点切，不按 UTF-16 码元：后者会在 emoji / 代理对中间落刀，落盘成 U+FFFD。
  const chars = [...first];
  const summary = chars.length > POINTER_MAX ? `${chars.slice(0, POINTER_MAX).join("")}…` : first;
  const where = m.doc_path ? ` · \`${oneLine(m.doc_path)}\`` : "";
  return `- \`${m.id}\` **${oneLine(m.title)}**：${oneLine(summary)}${where}\n`;
}

/**
 * Render one type's memories into exactly the mirror-file text (header +
 * per-memory blocks, updated_at DESC like sync). sync() writes this to disk;
 * the /export endpoint reuses the same entry blocks for its per-type sections,
 * so an exported markdown round-trips back through parseHumanEdits →
 * mergeHumanEdits. Unknown type → undefined.
 *
 * `fileHeader: false` 供 /export 用：一个文档只能有一个 frontmatter 块（在文档
 * 最前，见 api.js 的 /export），所以分节不再各自带文件头。只读 type（#296 的
 * document）只走磁盘镜像这一条：渲染指针行 + 只读文件头，导出侧不取它。
 */
export function renderMirrorText(type, memories, language = "zh", { fileHeader = true } = {}) {
  const name = TYPE_FILE[type];
  if (!name) return undefined;
  const items = (memories ?? [])
    .slice()
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const readonly = MIRROR_READONLY_TYPES.has(type);
  const header = readonly ? STR.mirrorReadonlyHeader[language](name) : STR.mirrorHeader[language](name);
  const body = items.map((m) => (readonly ? renderPointer(m) : renderMemory(m, language))).join("\n");
  return (fileHeader ? renderFileHeader(type, items) : "") + header + body;
}

/**
 * Parse mirror text back into {id, title, content} entries for human edits.
 * Pure text-in/edits-out core: readHumanEdits feeds it mirror file contents
 * and the /import endpoint feeds it user-pasted markdown, so both paths share
 * one parsing implementation (行为一致是硬约束——import 必须能吃回 export 与
 * 磁盘镜像)。Entries are anchored on "- **ID**: `...`" lines that are followed
 * by the "- **类型**:" metadata line (structural entry head): each entry's
 * block spans from its ID line up to the next ID line (or end of text). The
 * block head (the ID line plus the generated metadata run) and the trailing
 * structural "---" separator are stripped; everything in between is the entry
 * body, so user content containing "---", metadata-like lines, or even a
 * machine-format "- **ID**: `x`" line is preserved. The title is the "## "
 * heading preceding the ID line.
 */
export function parseHumanEdits(text) {
  // CRLF 归一化（readHumanEdits 原有的读取侧处理移入纯函数，Windows 手工编辑
  // 的文件与导入文本都能正确解析）。
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const edits = [];
  // Anchor on the ID line only when it is a structural entry head: the
  // machine-rendered ID line is always followed by the "- **类型**:" line.
  // A body line like "- **ID**: `x`" is not, so it never splits the block
  // or produces a ghost entry.
  // 解析同时接受两种语言的标签：切换语言前渲染的镜像文件仍能合并。
  const anchors = [...normalized.matchAll(ANCHOR_RE)];
  let prevEnd = 0;
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const blockStart = anchor.index;
    const blockEnd = i + 1 < anchors.length ? anchors[i + 1].index : normalized.length;

    // Title: last "## " heading before this ID line (file header region /
    // previous block tail). Body headings of earlier entries come before
    // the structural "---" + "## " of this entry, so the last match wins.
    const titleMatches = [...normalized.slice(prevEnd, blockStart).matchAll(/^## (.+)$/gm)];
    const titleMatch = titleMatches[titleMatches.length - 1];

    // Body: the ID line and the generated metadata run are structural head;
    // everything after them up to the trailing "---" separator is the body.
    let body = normalized
      .slice(blockStart, blockEnd)
      .replace(/^- \*\*ID\*\*: `[^`]+`\n?/, "")
      .replace(META_RUN_RE, "")
      .replace(/^<!-- mirror-digest: [a-f0-9]+ -->\n?/m, "");
    const separators = [...body.matchAll(/^---\s*$/gm)];
    const lastSep = separators[separators.length - 1];
    if (lastSep) body = body.slice(0, lastSep.index);
    body = body.trim();

    // The machine-written "更新时间" line records the store's updated_at at
    // render time — the version token for detecting a concurrent store write
    // during a three-way merge of human edits (see service.syncMirror).
    const block = normalized.slice(blockStart, blockEnd);
    const updatedMatch = block.match(UPDATED_RE);
    const digestMatch = block.match(/<!-- mirror-digest: ([a-f0-9]+) -->/);
    edits.push({
      id: anchor[1],
      title: titleMatch ? unescape(titleMatch[1]).trim() : undefined,
      content: body,
      updated_at: updatedMatch ? updatedMatch[1].trim() : undefined,
      digest: digestMatch ? digestMatch[1] : undefined
    });

    const lineEnd = normalized.indexOf("\n", blockStart);
    prevEnd = lineEnd === -1 ? normalized.length : lineEnd + 1;
  }
  return edits;
}

/**
 * 判断「这份文本的内容有没有变」时忽略 generated.at：它每次渲染都是新时间戳，
 * 带上它就永远判为变化。其余字节必须逐字相同才算没变——镜像的幂等性（同样的库
 * 渲染两次得到同样的文件）才是可断言的。
 */
function stripGeneratedAt(text) {
  return String(text).replace(/^generated\.at: .*$/m, "");
}

export function createMirror(dir, language = "zh") {
  mkdirSync(dir, { recursive: true });

  function filePath(type) {
    const name = TYPE_FILE[type];
    return name ? join(dir, name) : undefined;
  }

  /**
   * Read the mirror files and parse them back into human edits. The pure
   * parsing logic lives in the exported parseHumanEdits (shared with /import);
   * this wrapper only owns the "read file → text" side.
   */
  function readHumanEdits(type = undefined) {
    // 只读 type 不参与人改合并（#296）：它们的文件里没有可编辑的正文，解析出来的
    // 指针行文本若被当成「人改」写回库，会污染摘要。整类跳过，包括 type 指定的
    // 那条调用路径。
    const types = (type ? [type] : Object.keys(TYPE_FILE)).filter((t) => !MIRROR_READONLY_TYPES.has(t));
    const edits = [];
    for (const t of types) {
      const file = filePath(t);
      if (!file || !existsSync(file)) continue;
      edits.push(...parseHumanEdits(readFileSync(file, "utf8")));
    }
    return edits;
  }

  function sync(memories) {
    const byType = {};
    for (const m of memories) {
      (byType[m.type] ??= []).push(m);
    }
    // Per-type physical outcomes (audit peer D): a failed write for one type
    // must not abort the whole render. Each type is written (or pruned) in its
    // own try/catch and the result reported so the caller can persist per-type
    // committed/failed receipts — a file that was already written is a real
    // physical commit even when a sibling type errors.
    const results = {};
    for (const type of Object.keys(TYPE_FILE)) {
      try {
        const file = filePath(type);
        const items = (byType[type] ?? [])
          .slice()
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
        if (items.length === 0) {
          // no memories of this type: drop any stale mirror file so deleted
          // memories do not "resurrect" via readHumanEdits
          rmSync(file, { force: true });
        } else {
          // 渲染走 renderMirrorText（与 /export 共用同一条渲染路径）。
          const text = renderMirrorText(type, items, language);
          // 内容没变就不落盘。generated.at 每次渲染都新，无脑写会让编辑器、同步盘
          // 与 git 在每次业务写后看到全部镜像文件「被外部修改」，而内容其实一字未
          // 变；按 OKF 的语义它只该记内容变化，未变就保留旧值。这也是同步读 9 个
          // 小文件的代价，比无谓写 9 次盘便宜。
          let prev = null;
          try {
            prev = readFileSync(file, "utf8");
          } catch { /* 首次写：读不到就是没有旧文件 */ }
          if (prev === null || stripGeneratedAt(prev) !== stripGeneratedAt(text)) {
            writeFileSync(file, text, "utf8");
          }
        }
        results[type] = { ok: true };
      } catch (error) {
        results[type] = { ok: false, error: error?.message ?? String(error) };
      }
    }
    return results;
  }

  return { filePath, sync, readHumanEdits };
}
