import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createInjector, getInjectionSnapshot } from "../src/inject.js";
import { createSettings } from "../src/settings.js";

function setup(over = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const settings = createSettings(store.db);
  const contexts = [];
  const disposers = [];
  const ctx = {
    systemPrompt: {
      context(def) {
        contexts.push(def);
        const dispose = () => disposers.push(def.name);
        return dispose;
      }
    }
  };
  const config = { maxInjectedItems: 3, importanceThreshold: 3, ...over };
  const injector = createInjector(ctx, service, settings, config);
  return { store, service, contexts, injector, settings };
}

test("registers memory and user-settings contexts", () => {
  const { contexts } = setup();
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].name, "memory");
  assert.equal(contexts[1].name, "user-settings");
});

test("context text renders injected memories as markdown block", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite+Markdown", importance: 4 });
  const text = contexts[0].text({});
  assert.ok(text.includes("[记忆库]"), "has header");
  assert.ok(text.includes("语言"), "includes preference");
  assert.ok(text.includes("记忆插件"), "includes high-importance project");
});

test("returns empty text when nothing qualifies", () => {
  const { contexts } = setup();
  const text = contexts[0].text({});
  assert.equal(text, "");
});

test("renders summary block first when summary candidate exists", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "summary", title: "记忆库总览", content: "这是总览摘要", importance: 5 });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "中文", importance: 5 });
  const text = contexts[0].text({});
  const summaryIdx = text.indexOf("这是总览摘要");
  const prefIdx = text.indexOf("语言");
  assert.ok(summaryIdx !== -1, "summary present");
  assert.ok(prefIdx !== -1, "preference present");
  assert.ok(summaryIdx < prefIdx, "summary rendered first");
});

test("user-settings context renders profile and rules, empty when unset", () => {
  const { contexts, settings } = setup();
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  assert.ok(settingsCtx, "user-settings context registered");
  assert.equal(settingsCtx.text({}), "", "empty when no profile/rules");
  settings.setProfile("我叫小明，是一名前端开发者");
  settings.setRules(["回答时先给结论", "使用简体中文"]);
  const text = settingsCtx.text({});
  assert.ok(text.includes("用户画像"), "has profile header");
  assert.ok(text.includes("前端开发者"), "includes profile");
  assert.ok(text.includes("先给结论"), "includes rule");
  assert.ok(text.includes("简体中文"), "includes second rule");
});

test("user-settings context precedes memory block (order 85 < 90)", () => {
  const { contexts, settings } = setup();
  settings.setProfile("画像");
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  assert.ok(settingsCtx.order < contexts.find((c) => c.name === "memory").order);
});

test("Bug6: long content is truncated to ~300 chars with an ellipsis", () => {
  const { contexts, service } = setup();
  const longContent = "这是一段非常长的记忆正文".repeat(200); // ~2600 chars
  service.saveWithDedupe({ type: "preference", title: "长记忆", content: longContent, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("长记忆"), "memory still rendered");
  assert.ok(text.includes("…"), "ellipsis marks the truncation");
  assert.ok(!text.includes(longContent.slice(300)), "full body not injected verbatim");
});

test("Bug6: injected block stays within the ~1500 char budget, later entries collapse", () => {
  const { contexts, service } = setup({ maxInjectedItems: 8 });
  for (let i = 0; i < 8; i++) {
    service.saveWithDedupe({ type: "preference", title: `长标题记忆${i}`, content: "这是一段".repeat(100), importance: 5 });
  }
  const text = contexts[0].text({});
  assert.ok(text.length <= 1600, `memory block bounded near budget, got ${text.length} chars`);
  // The first entries render full bodies; every entry is present by title.
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`长标题记忆${i}`), `entry ${i} present`);
});

// DSH ≥0.1.2-rc removed Session.events; events are only reachable via
// snapshotEvents(). Regression for #59: the hot block must still render from
// a session object that has no .events property.
// 注意：assistant/message 的消息体在 data.message 下（见 Issue #129），夹具必须用这个
// 真实形状 —— 原先的夹具写的是 data.content，与当时有 bug 的实现是同一个错误假设，
// 所以它永远抓不到这个回归。
test("extracts hot rounds from snapshotEvents() when Session.events is absent", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "怎么修图谱面板" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "用 viewBox 单位跑模拟" }] } } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  assert.ok(text.includes("[短期上下文]"), "hot block rendered");
  assert.ok(text.includes("怎么修图谱面板"), "round query present");
  assert.ok(text.includes("用 viewBox 单位跑模拟"), "round response present");
});

// Issue #129 的复现：assistant 轮的正文取自 data.message.content。修复前 textOf 只读
// data.content，于是每一轮的 response 都落成空串 —— 表现为「N 轮 A 全空」。
test("Issue #129: response 取自 data.message.content，N 轮不再出现空 A", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第一个问题" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第一个回答" }] } } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "第二个问题" }] } },
      { type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二个回答" }] } } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  for (const s of ["第一个问题", "第一个回答", "第二个问题", "第二个回答"]) {
    assert.ok(text.includes(s), `hot block 应包含 ${s}`);
  }
});

// 修复用的是 ?? 兜底而非破坏性替换：扁平的 data.content 形状（user 消息一贯如此，
// 历史事件也可能如此）必须继续可用。
test("Issue #129: 扁平的 data.content 形状仍被兼容", () => {
  const { contexts } = setup();
  const session = {
    snapshotEvents: () => [
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "问题" }] } },
      { type: "assistant/message", data: { content: [{ type: "text", text: "扁平形状的回答" }] } }
    ]
  };
  const text = contexts[0].text({ agent: { session } });
  assert.ok(text.includes("问题"), "query present");
  assert.ok(text.includes("扁平形状的回答"), "flat content shape still supported");
});

// ---- issue #162: 注入边界花括号转义(v0.7.4 #40 修复被 v0.7.11 误删后恢复) ----

test("issue #162: {{...}} in memory content is escaped at the injection boundary", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "模板记忆", content: "{{hl|highlight}} 和 {{挖空}} {{关键词}}", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("模板记忆"), "memory still rendered by title");
  assert.ok(text.includes("{\\{hl|highlight}\\}"), "ASCII template braces escaped");
  assert.ok(text.includes("{\\{挖空}\\}"), "CJK template braces escaped");
  assert.ok(!text.includes("{{"), "no raw {{ survives into the prompt");
  assert.ok(!text.includes("}}"), "no raw }} survives into the prompt");
});

test("issue #162: odd brace runs like {{{a}}} are escaped too", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "三层模板", content: "{{{a}}} 和 }}} 结尾", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(!text.includes("{{"), "no raw {{ for odd brace runs");
  assert.ok(!text.includes("}}"), "no raw }} for odd brace runs");
});

test("issue #162: {{...}} in user profile/rules is escaped", () => {
  const { contexts, settings } = setup();
  settings.setProfile("我叫{{名字}}，前端开发者");
  settings.setRules(["回答时用 {{hl|term}}", "以 }} 结尾的规则"]);
  const settingsCtx = contexts.find((c) => c.name === "user-settings");
  const text = settingsCtx.text({});
  assert.ok(text.includes("{\\{名字}\\}"), "profile braces escaped");
  assert.ok(text.includes("{\\{hl|term}\\}"), "rule braces escaped");
  assert.ok(!text.includes("{{"), "no raw {{ in user-settings block");
  assert.ok(!text.includes("}}"), "no raw }} in user-settings block");
});

test("issue #162: hot-context rounds with {{...}} are escaped", () => {
  const { contexts } = setup();
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s1",
        events: [
          { type: "user/message", data: { source: { kind: "user" }, content: ["用 {{hl|你好}} 测试"] } },
          { type: "assistant/message", data: { source: { kind: "assistant" }, content: ["返回 {{答案}}"] } }
        ]
      }
    }
  });
  assert.ok(text.includes("[短期上下文]"), "hot context rendered");
  assert.ok(!text.includes("{{"), "no raw {{ in hot context");
  assert.ok(!text.includes("}}"), "no raw }} in hot context");
});

test("issue #162: reasoning parts are excluded from hot memory (docker --format case)", () => {
  const { contexts } = setup();
  // issue #162 的触发源：assistant 的 reasoning part 是 { type: "reasoning", text }
  // 结构，内容里出现 docker --format "{{.Server.Version}}" 时，若被注入 hot memory
  // 会让 DSH interpolate() 扫到非法变量名 throw → 整轮永久失败。textOf 必须跳过它。
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s1",
        events: [
          { type: "user/message", data: { source: { kind: "user" }, content: ["检查 docker 版本"] } },
          {
            type: "assistant/message",
            data: {
              source: { kind: "assistant" },
              content: [
                { type: "reasoning", text: "运行 docker version --format \"{{.Server.Version}}\" 查看版本" },
                { type: "text", text: "已检查，Docker 版本 27.1.1。" }
              ]
            }
          }
        ]
      }
    }
  });
  // reasoning 不应进入 hot memory
  assert.ok(!text.includes("Server.Version"), "reasoning text excluded from hot memory");
  // 正文保留
  assert.ok(text.includes("27.1.1"), "assistant text part still injected");
  // 整个注入块没有任何原始 {{ (双保险：即使将来 reasoning 被引入，也会被转义)
  assert.ok(!text.includes("{{"), "no raw {{ anywhere in injected context");
  assert.ok(!text.includes("}}"), "no raw }} anywhere in injected context");
});

test("issue #162: escapePromptVariables=false passes {{...}} through verbatim", () => {
  const { contexts, service } = setup({ escapePromptVariables: false });
  service.saveWithDedupe({ type: "preference", title: "模板", content: "{{挖空}} 与 {{hl|term}}", importance: 5 });
  const text = contexts[0].text({});
  assert.ok(text.includes("{{挖空}}"), "raw braces preserved when escaping disabled");
  assert.ok(text.includes("{{hl|term}}"), "raw ASCII braces preserved when escaping disabled");
});

// --- Issue #179：注入预览快照（旁路缓存最近一帧组装） ---

test("injection snapshot: records last assembly and clears on dispose (issue #179)", () => {
  const { contexts, service, injector } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  contexts[0].text({});
  let snap = getInjectionSnapshot();
  assert.ok(snap, "snapshot exists after first render");
  assert.equal(snap.entries.length, 1, "entries mirror the injected candidates");
  assert.equal(snap.entries[0].title, "语言");
  assert.equal(snap.entries[0].type, "preference");
  assert.ok(snap.entries[0].chars > 0, "per-entry char count recorded");
  assert.ok(snap.totalChars > 0, "total char count recorded");
  assert.ok(snap.totalChars >= snap.entries.reduce((a, e) => a + e.chars, 0), "total >= sum of entry contents");
  assert.equal(snap.maxItems, 3, "effective maxItems recorded (adaptive off → base)");
  assert.equal(snap.hotChars, 0, "no hot context in this mock");
  const before = snap.at;
  contexts[0].text({});
  snap = getInjectionSnapshot();
  assert.ok(snap.at >= before, "second render refreshes the snapshot");
  injector();
  assert.equal(getInjectionSnapshot(), null, "dispose clears the snapshot");
});

test("injection snapshot: records adaptive budget and rotation state (issue #179)", () => {
  const { contexts, service } = setup({ injectUncertaintyAdaptive: true, injectRotationTurns: 2 });
  service.saveWithDedupe({ type: "project", title: "记忆插件", content: "SQLite+Markdown", importance: 4 });
  contexts[0].text({});
  const snap = getInjectionSnapshot();
  assert.equal(snap.adaptive, true, "adaptive flag recorded");
  assert.equal(snap.rotated, 0, "no suppression on first render of a fresh session");
  assert.equal(snap.scoped, null, "no scope when strict scope is off");
});


// ---- issue #334: emoji 代理对截断——注入路径的 4 处截断点绝不留孤立代理项 ----
//
// 回归类（报告 #334）：UTF-16 slice 切在代理对中间留下孤立低位代理项，序列化成
// 非法 UTF-8，DeepSeek API 对每个请求回 400；畸形文本随注入消息被永久写进会话
// 历史，之后每一轮都带着它——会话级不可逆损坏。锁的是「少一个字符都行，绝不留
// 半个」这个语义本身，不是某个具体上限值。

// 孤立代理项检测：合法文本不含未配对的 UTF-16 代理项。
function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

// 复现 #334 的现场形状：`## Review 18/40 — 🔴` 恰好在 800 字符上限处切到 🔴。
const EMOJI_PAD = "# Review 18/40 — ".padEnd(799, "x");
test("issue #334: hot round response truncated mid-emoji leaves no lone surrogate", () => {
  const { contexts } = setup();
  // 799 个 ASCII + 🔴（2 个 UTF-16 码元）= 801：slice(0, 800) 恰好切在代理对中间。
  const body = EMOJI_PAD + "🔴";
  assert.equal(body.length, 801, "fixture: cut point lands inside the surrogate pair");
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s-emoji",
        events: [
          { type: "user/message", data: { source: { kind: "user" }, content: ["看下评审进度"] } },
          { type: "assistant/message", data: { message: { content: [{ type: "text", text: body }] } } }
        ]
      }
    }
  });
  assert.ok(text.includes("[短期上下文]"), "hot block rendered");
  assert.ok(!hasLoneSurrogate(text), "no lone surrogate survives the hot-round truncation");
  assert.ok(text.includes("Review 18/40"), "truncated body still present up to the cut");
});

test("issue #334: memory content truncated mid-emoji carries no lone surrogate", () => {
  const { contexts, service } = setup();
  // injectContentMaxChars 最小 60：凑一条「恰好把 🔴 切成两半」的记忆。
  const content = "r".repeat(59) + "🔴";
  service.saveWithDedupe({ type: "preference", title: "评审", content, importance: 5 });
  const text = contexts[0].text({});
  assert.ok(!hasLoneSurrogate(text), "no lone surrogate in the truncated memory entry");
  assert.ok(text.includes("评审"), "entry still rendered by title");
});

test("issue #334: lastUserQuery truncation never produces a lone surrogate", () => {
  const { contexts } = setup();
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s-q",
        snapshotEvents: () => [
          // 499 个 ASCII + 🔴：lastUserQuery 的 slice(0, 500) 切在代理对中间。
          { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "q".repeat(499) + "🔴" }] } },
          { type: "assistant/message", data: { message: { content: [{ type: "text", text: "答" }] } } }
        ]
      }
    }
  });
  assert.ok(text.includes("[短期上下文]"), "round rendered from snapshot events");
  assert.ok(!hasLoneSurrogate(text), "no lone surrogate from the query truncation path");
});

// ---- issue #34 恢复（#333）：对话开始注入当前时间，per-session 闩锁 ----

test("issue #34/#333: injectTimePrefix off by default (byte-identical behavior)", () => {
  const { contexts, service } = setup();
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  const text = contexts[0].text({ agent: { session: { id: "s-t0" } } });
  assert.ok(!text.includes("当前时间"), "no time prefix when the flag is off (default)");
});

test("issue #34/#333: enabled prefix appears once per session and carries the date format", () => {
  const { contexts, service } = setup({ injectTimePrefix: true });
  service.saveWithDedupe({ type: "preference", title: "语言", content: "用户用中文交流", importance: 5 });
  const first = contexts[0].text({ agent: { session: { id: "s-t1" } } });
  assert.match(first, /\[当前时间: \d{4}-\d{2}-\d{2} 周. \d{2}:\d{2}\]/, "prefix format matches v0.7.2 shape");
  assert.ok(first.startsWith("[当前时间: "), "prefix leads the block");
  // 同一会话第二次渲染：闩锁生效，不再出现。
  const second = contexts[0].text({ agent: { session: { id: "s-t1" } } });
  assert.ok(!second.includes("当前时间"), "latched: same session never re-injects");
  // 新会话：重新注入。
  const third = contexts[0].text({ agent: { session: { id: "s-t2" } } });
  assert.match(third, /\[当前时间: /, "new session re-injects");
});

test("issue #34/#333: time prefix coexists with hot context (time first, then hot, then memory)", () => {
  const { contexts } = setup({ injectTimePrefix: true, hotMemoryEnabled: true });
  const text = contexts[0].text({
    agent: {
      session: {
        id: "s-t3",
        snapshotEvents: () => [
          { type: "user/message", data: { source: { kind: "user" }, content: ["问题"] } },
          { type: "assistant/message", data: { message: { content: [{ type: "text", text: "回答" }] } } }
        ]
      }
    }
  });
  const ti = text.indexOf("当前时间");
  const hi = text.indexOf("[短期上下文]");
  assert.ok(ti >= 0 && hi > ti, "time prefix precedes the hot block");
});
