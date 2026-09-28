// dsh-mneme/src/document-index.js
// documentDir 的索引（issue #296 第二批）。`<documentDir>/index.md` 整文件机器所有，
// 可从库随时重建：内容里没有任何「生成时间」，所以删掉再同步一次得到逐字节相同的
// 文件（test/document-dir.test.js 钉住这一条）。
//
// 与镜像侧 documents.md 的分工（#296 第 2 节表格）：这里是 document 子系统自己的
// 索引（id + 标题 + 定位 + managed 标记），那份是带 frontmatter 的镜像只读视图
// （多一个摘要首句）。两份都只列指针行，都不含正文——正文永远在 doc_path 指向的
// 文件里，那是 agent 的东西。
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { STR } from "./lang.js";
import { isManagedDocumentPath } from "./document.js";

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} dir resolved documentDir (see resolveDocumentDir)
 * @param {"zh"|"en"} language instance language, same as the mirror
 */
export function createDocumentIndex(dir, language = "zh") {
  const filePath = join(dir, "index.md");

  /**
   * Render the whole file from the given rows. Sorted updated_at DESC, id ASC:
   * the same store state must always render the same bytes (rebuildable).
   */
  function render(memories) {
    const items = (memories ?? []).slice().sort((a, b) => {
      if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    const lines = [STR.documentIndexHeader[language]()];
    for (const m of items) {
      const where = isManagedDocumentPath(dir, m.doc_path) ? "managed" : "external";
      // doc_path 理论上必带（store.saveDocument 是唯一铸造口），缺了就只写定位
      // 标记，不编造路径。
      const path = m.doc_path ? ` · \`${oneLine(m.doc_path)}\`` : "";
      lines.push(`- \`${m.id}\` **${oneLine(m.title)}** · ${where}${path}`);
    }
    return `${lines.join("\n")}\n`;
  }

  /**
   * Ensure the directory exists (recursive). Never throws: callers warn and move
   * on — a managed directory that cannot be created must not fail plugin boot.
   */
  function ensure() {
    try {
      mkdirSync(dir, { recursive: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /**
   * Write the index if it changed. Never throws: a failed index write must not
   * fail the business write that triggered it (same fail-safe shape as
   * mirror.sync). Returns { ok, changed } or { ok: false, error }.
   */
  function sync(memories) {
    const text = render(memories);
    let prev = null;
    try { prev = readFileSync(filePath, "utf8"); } catch { /* first write */ }
    if (prev === text) return { ok: true, changed: false };
    const ready = ensure();
    if (!ready.ok) return { ok: false, error: ready.error };
    try {
      writeFileSync(filePath, text, "utf8");
      return { ok: true, changed: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  /**
   * Drop the index file (闸关时用）。闸关意味着 document 子系统整体退出，留一份
   * 陈旧索引会列出已归档、已遗忘的指针行——正是 documents.md 在闸关时被镜像删掉
   * 要避免的那种「看着还在、其实已关」的视图。删掉不从库取数，O(1)，也不抛。
   */
  function remove() {
    try {
      rmSync(filePath, { force: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  return { filePath, render, sync, ensure, remove };
}
