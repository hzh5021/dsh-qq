/**
 * dsh-qq — 把 QQ 接成一条能进来的路。
 *
 * 来历：一个 OneBot 实现（如 NapCat）接上去之后，QQ 只是管道。要让那条线上
 * 说话的是 agent，得在 DSH 进程里自己开一个会话、挂同一个 preset ——
 * 这个插件就是那一截：收私聊、喂给 agent、把回答发回去。
 *
 * 设计约束（照 dsh-wakeup 的路子）：
 *  - 不 import 任何第三方包，也不碰宿主给的 @deepseek-ai/*（外面那份版本跟
 *    宿主里跑的不是同一个，引进来会多一份错版核心）。DSH 的 Node 是 v24，
 *    内置 WebSocket 够用（`typeof WebSocket === "function"`）。
 *  - 只认一个人（config.ownerId）。群里、别人、自己发的，一律不理。
 *  - 出错不能把 DSH 拖下水：每一步都包着，失败只 log。
 *
 * @module dsh-qq
 */

export const name = "dsh-qq";

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/**
 * 开一个会话要用宿主的花名册。
 * agentDefaultModel 给 provider/model（不给的话会话醒不来），
 * agentPresets 给 preset 的挂载点 —— wakeup 就是从那一步进来的。
 * Cordis 的规矩：没报名的服务连读都不让读。
 */
export const inject = ["agents", "agentDefaultModel", "agentPresets", "workspaceRegistry"];

const TAG = "[dsh-qq]";

const DEFAULTS = {
  wsUrl: "ws://127.0.0.1:3001",
  /**
   * 唯一放行的那个人。**不配（0）就谁都不放行** —— 私聊一律丢掉，并大声报一次。
   * 默认收紧：一条没配好的通道不能把所有私聊都喂进 agent。
   */
  ownerId: 0,
  /** 这条线的会话工作目录。不配就用 ~/.dsh/dsh-qq/workspace（免得会话落在 _no-cwd）。 */
  cwd: join(homedir(), ".dsh", "dsh-qq", "workspace"),
  // 会话的 provider / model 不在这里配：从宿主的 agentDefaultModel.currentSelection() 取。
  /** 回答停顿这么久没新内容，就当它说完了。 */
  settleMs: 2000,
  /** 一条 QQ 消息最多带多少字，长了切开。 */
  maxChars: 1700,
  /** 隔这么久没说话，下一条消息就当新话题（毫秒）。0 = 关掉。 */
  idleResetMs: 6 * 60 * 60 * 1000,
  /** 等用户在 QQ 上批/不批最多这么久，到点就还给别的应答者。 */
  approvalTimeoutMs: 5 * 60 * 1000,
  /** 等太久先催一句（毫秒）。0 = 不催。 */
  approvalRemindMs: 90 * 1000,
  reconnectMaxMs: 30_000,
  logFile: join(homedir(), ".dsh", "dsh-qq", "dsh-qq.log"),
  /** OneBot 实现（如 NapCat）每次要扫码时会把码落在这儿；默认空 = 按需配置。 */
  qrPath: "",
  /** 解码 URL 在这个日志里（图片扫不动时能手敲）；默认空 = 按需配置。 */
  napCatLog: "",
  /** 用户发来的图 / 语音 / 文件落在这儿，插件按路径读。 */
  mediaDir: join(homedir(), ".dsh", "dsh-qq", "media"),
};

let LOG_FILE = "";
// 坑：logFile 曾经指着一个已经不存在的目录，写失败被 catch 吞掉，于是
// "日志里没有 connected"被当成了断线的证据 —— 那是一条从来没有出口的证据。
// 写不进去必须出声，哪怕只喊一次。
let LOG_DEAD = false;

const log = (...a) => {
  const line = new Date().toISOString() + " " + a.map(function (x) { if (typeof x === "string") return x; try { return JSON.stringify(x); } catch (e) { return String(x); } }).join(" ");
  console.log(TAG, ...a);
  if (!LOG_FILE) return;
  try {
    appendFileSync(LOG_FILE, line + String.fromCharCode(10));
    LOG_DEAD = false;
  } catch (e) {
    if (!LOG_DEAD) {
      LOG_DEAD = true;
      console.error(TAG, "LOG FILE UNWRITABLE:", LOG_FILE, (e && e.message) || e,
        "-- 从这行起，文件里看不到任何日志，别拿它当证据");
    }
  }
};

/** 事件里的消息体：有的包一层 message，有的就是它自己。 */
function messageOf(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.content)) return data;
  if (Array.isArray(data.message?.content)) return data.message;
  return null;
}

/** 只取 text block（reasoning 不算）。 */
function textOf(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** OneBot 事件里的纯文本。 */
function oneBotText(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s) => (s?.type === "text" ? String(s.data?.text ?? "") : ""))
    .join("")
    .trim();
}

/**
 * 从消息段里挑出"不是字"的那些。
 * 根子：原来只认 text，图片段被静默丢掉，连"有张图"都不知道。
 * 现在先留个名目，再向 OneBot 实现要原图落地。
 */
function mediaSegments(segments) {
  const out = [];
  for (const s of Array.isArray(segments) ? segments : []) {
    const t = s?.type;
    if (!t || t === "text" || t === "reply" || t === "face" || t === "at") continue;
    const d = s.data || {};
    if (t === "image") out.push({ kind: "图片", file: d.file || d.url || "", url: d.url || "" });
    else if (t === "record") out.push({ kind: "语音", file: d.file || d.url || "" });
    else if (t === "video") out.push({ kind: "视频", file: d.file || d.url || "" });
    else if (t === "file") out.push({ kind: "文件", file: d.file || "", name: d.file_name || d.name || "" });
    else out.push({ kind: t, file: d.file || d.url || "" });
  }
  return out;
}

/** 长回答切成几条发。 */
function split(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}

/** 发这几个词（不分大小写）就换一条新会话。 */
const NEW_CHAT_CUES = new Set(["新对话", "新会话", "/new", "/新对话", "/新会话", "换个话题", "/clear"]);

/**
 * 用户在 QQ 上批/不批的答复词。
 * 先看否、再看肯 —— "不批"里也含"批"，顺序反了就会把拒绝读成同意。
 */
const APPROVAL_NO = ["不批", "不行", "不用", "不要", "别", "停", "算了", "拒绝", "取消", "no", "0"];
const APPROVAL_YES = ["批", "行", "好", "可以", "同意", "允许", "ok", "yes", "1"];

/** 一条 QQ 消息算不算对审批的答复：算就给结论，不算给 null（照常当消息走）。 */
function approvalAnswer(text) {
  const t = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!t || t.length > 12) return null;
  for (const w of APPROVAL_NO) if (t.includes(w)) return "rejected";
  for (const w of APPROVAL_YES) if (t.includes(w)) return "allowed-once";
  return null;
}

/** 正文里的出站文件指令：[SEND_FILE: <绝对路径>]，单独一行。 */
const SEND_FILE_RE = /^[ \t]*\[SEND_FILE:[ \t]*(.+?)[ \t]*\][ \t]*$/gim;

/** 把正文里的文件指令剥出来（正文跟附件分开走）。 */
function extractFiles(text) {
  const files = [];
  const clean = String(text === undefined || text === null ? "" : text)
    .replace(SEND_FILE_RE, function (_m, p1) { files.push(String(p1).trim()); return ""; })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean: clean, files: files };
}

/** 按扩展名决定走哪种消息段：语音条 / 图片 / 文件。 */
function oneBotSegmentFor(file) {
  const path = String(file);
  const uri = "file:///" + path.replace(/\\/g, "/");
  const low = path.toLowerCase();
  if (/\.(silk|amr|slk)$/.test(low)) return { type: "record", data: { file: uri } };
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(low)) return { type: "image", data: { file: uri } };
  return { type: "file", data: { file: uri, name: path.split(/[\\/]/).pop() } };
}

export function apply(ctx, config = {}) {
  LOG_FILE = String((config && config.logFile) || DEFAULTS.logFile || "");
  const opts = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
  const ownerId = Number(opts.ownerId) || 0;
  if (!ownerId) {
    log("!! ownerId 没配：这条通道不会认任何人，收到的私聊一律丢掉。请在 config 里写上你的 QQ 号。");
  }
  // cwd 先建出来：工作区是按路径认人的，路径不存在会话就会落在 _no-cwd。
  opts.cwd = String(opts.cwd || DEFAULTS.cwd || "");
  if (opts.cwd) {
    try { mkdirSync(opts.cwd, { recursive: true }); }
    catch (e) { log("cwd 建不出来:", opts.cwd, (e && e.message) || String(e)); }
  }

  /** userId -> { userId, sessionId, agent, chunks, timer } */
  const convs = new Map();
  /** sessionId -> 一条正等着用户在 QQ 上批/不批的请求。 */
  const pendingApprovals = new Map();
  const approvalTimeoutMs = Number(opts.approvalTimeoutMs) || 0;
  const approvalRemindMs = Number(opts.approvalRemindMs) || 0;
  /** userId -> 最后一次说话的时间，用来判断"隔太久了"。 */
  const lastSeen = new Map();

  /** 丢掉手里那条会话；下一条消息会就地开一条新的。 */
  const dropConv = (key) => convs.delete(key);

  /** 距上次说话超过 idleResetMs 了没。 */
  const idleExpired = (key) => {
    if (!opts.idleResetMs) return false;
    const prev = lastSeen.get(key);
    return typeof prev === "number" && Date.now() - prev > opts.idleResetMs;
  };
  let ws = null;
  let attempts = 0;
  let disposed = false;

  // ---- 给浏览器那半看的小口子 ----
  // 为什么不走 DSH 正规的 ctx.remote：那条路的 /remote 产物要 tsdown 构建，
  // 为这点东西搭一条构建链不划算。开个只听本机的小 HTTP 口，不引任何包。
  // 状态全从现成的东西推：ws 的连接态、convs 里那几条会话、日志尾部 —— 不侵入上面的逻辑。
  const httpPort = Number(opts.httpPort) || 3002;
  const statusJson = () => {
    let tail = [];
    try {
      tail = readFileSync(LOG_FILE || DEFAULTS.logFile, "utf8")
        .trim().split(String.fromCharCode(10)).slice(-40);
    } catch (e) { /* 读不到就空着 */ }
    // 二维码：图在 qrPath，解码 URL 在 NapCat 日志里（图扫不动时能手敲）。
    let qr = null;
    try { qr = { mtime: statSync(opts.qrPath).mtimeMs }; } catch (e) { /* 没有就没有 */ }
    if (qr) {
      try {
        const hit = readFileSync(opts.napCatLog, "utf8").match(/二维码解码URL:\s*(\S+)/g);
        if (hit && hit.length) qr.url = hit[hit.length - 1].replace(/^二维码解码URL:\s*/, "");
      } catch (e) { /* 同上 */ }
    }
    return JSON.stringify({
      connected: !!ws && ws.readyState === 1,
      wsUrl: opts.wsUrl,
      ownerId: opts.ownerId,
      cwd: opts.cwd,
      qr,
      sessions: [...convs.values()].map((e) => ({
        userId: e.userId, sessionId: e.sessionId, chunks: e.chunks.length,
      })),
      log: tail,
      now: Date.now(),
    });
  };
  const httpSrv = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const path = String(req.url || "").split("?")[0];
    // 二维码原图直接搬：NapCat 已经把它写成文件了，读出来吐给浏览器就行。
    if (path === "/qr") {
      try {
        const img = readFileSync(opts.qrPath);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-store");
        res.end(img);
      } catch (e) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end('{"error":"qrcode.png not found"}');
      }
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (path === "/status") { res.end(statusJson()); return; }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  });
  httpSrv.on("error", (e) => log("status server failed:", (e && e.message) || e));
  httpSrv.listen(httpPort, "127.0.0.1", () => log("status server http://127.0.0.1:" + httpPort + "/status"));

  const wsSend = (obj) => {
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify(obj));
        return true;
      }
    } catch (e) {
      log("ws send failed:", e?.message ?? e);
    }
    return false;
  };

  /** 一条 send_private_msg：message 可以是字符串，也可以是段数组。 */
  const sendRaw = (userId, message) =>
    wsSend({
      action: "send_private_msg",
      params: { user_id: userId, message: message },
      echo: `dsh-qq-${Date.now()}`,
    });

  const sendToQq = (userId, text) => {
    const picked = extractFiles(text);
    for (const file of picked.files) {
      try {
        sendRaw(userId, [oneBotSegmentFor(file)]);
        log(`out file -> ${userId}: ${file}`);
      } catch (e) {
        log("send file failed:", (e && e.message) || e);
      }
    }
    if (!picked.clean) return;
    const parts = split(picked.clean, opts.maxChars);
    for (const part of parts) sendRaw(userId, part);
    log(`out -> ${userId}: ${picked.clean.length} chars in ${parts.length} part(s), files ${picked.files.length}`);
  };

  // ---- 进来的图 / 语音 / 文件，落成本地路径 ----
  // 以前只认文字段，图直接丢了。这里做两件事：向 OneBot 实现问这个段对应的
  // 本地文件（get_image / get_file），拿到就搬到 mediaDir 里留个副本，
  // 再把路径写进正文交给 agent。拿不到也不拦这条消息。

  /** 等一个 echo 的回包（NapCat 的 WS 是请求-应答式的）。 */
  const pending = new Map();
  const request = (action, params, timeoutMs) =>
    new Promise((resolve) => {
      const echo = `dsh-qq-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        resolve(null);
      }, timeoutMs || 15000);
      pending.set(echo, (payload) => {
        clearTimeout(timer);
        pending.delete(echo);
        resolve(payload);
      });
      if (!wsSend({ action: action, params: params, echo: echo })) {
        clearTimeout(timer);
        pending.delete(echo);
        resolve(null);
      }
    });

  const mediaDir = String(opts.mediaDir || DEFAULTS.mediaDir || "");

  /** 把 NapCat 给的东西变成本地文件：已经是路径就认，是 http 就下，是 base64 就写。 */
  async function materialize(src, hintExt) {
    const raw = String(src || "").trim();
    if (!raw) return "";
    try {
      mkdirSync(mediaDir, { recursive: true });
    } catch (e) { /* 建不出来就试着直接用原路径 */ }

    const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const ext = (hintExt || ".bin").startsWith(".") ? (hintExt || ".bin") : "." + hintExt;

    // 1) 本地路径（NapCat 常给的形态）
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("file://")) {
      const p = raw.startsWith("file://") ? raw.replace(/^file:\/\/\/?/, "") : raw;
      const local = p.replace(/\//g, "\\");
      try {
        if (statSync(local).isFile()) {
          const dest = join(mediaDir, `qq-in-${stamp}${extname(local) || ext}`);
          copyFileSync(local, dest);
          return dest;
        }
      } catch (e) { /* 不是本地文件，往下走 */ }
      return "";
    }

    // 2) http(s) 链接
    if (/^https?:\/\//i.test(raw)) {
      try {
        const r = await fetch(raw, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return "";
        const buf = Buffer.from(await r.arrayBuffer());
        const dest = join(mediaDir, `qq-in-${stamp}${ext}`);
        writeFileSync(dest, buf);
        return dest;
      } catch (e) {
        log("media download failed:", (e && e.message) || e);
        return "";
      }
    }

    // 3) base64（有的实现直接给 data）
    if (raw.length > 64 && /^[A-Za-z0-9+/=\r\n]+$/.test(raw)) {
      try {
        const dest = join(mediaDir, `qq-in-${stamp}${ext}`);
        writeFileSync(dest, Buffer.from(raw, "base64"));
        return dest;
      } catch (e) { /* 落不下就算了 */ }
    }
    return "";
  }

  /** 一个段 -> 本地路径（拿不到就空串）。 */
  async function saveIncoming(seg) {
    const action = seg.kind === "图片" ? "get_image" : seg.kind === "语音" ? "get_record" : "get_file";
    const guess = seg.kind === "图片" ? ".png" : seg.kind === "语音" ? ".amr" : "";
    let got = "";

    if (seg.file) {
      const r = await request(action, { file: seg.file, out_format: "mp3" });
      got = materialize(r?.data?.file || r?.data?.path || r?.file, guess);
    }
    if (!got && seg.url) got = await materialize(seg.url, guess);
    if (!got && seg.file) got = await materialize(seg.file, guess);
    return got;
  }

  /** 把一条消息里所有非文字段收下来，拼成给我看的那几行。 */
  async function collectMedia(segments) {
    const segs = mediaSegments(segments);
    if (!segs.length) return { lines: [], paths: [] };
    const lines = [];
    const paths = [];
    for (const seg of segs) {
      let local = "";
      try {
        local = await saveIncoming(seg);
      } catch (e) {
        log("save incoming failed:", (e && e.message) || e);
      }
      if (local) {
        paths.push(local);
        lines.push(`[${seg.kind}] ${local}`);
        log(`in media <- ${seg.kind} ${local}`);
      } else {
        lines.push(`[${seg.kind}]（没取到原文件${seg.name ? "：" + seg.name : ""}）`);
        log(`in media <- ${seg.kind} FAILED`);
      }
    }
    return { lines: lines, paths: paths };
  }

  /** 拿到（或就地开出）跟这个人的那条会话。 */
  async function convFor(userId) {
    const key = String(userId);
    const existing = convs.get(key);
    if (existing) return existing;
    const sessionId = `qq-${key}`;
    log("creating session", sessionId);
    // 照着 dsh-api-session-controller 的 createAgent 抄的，三处都不能省：
    //  - provider/model 从默认选择里取，不给就是 undefined，会话醒不来
    //  - cwd 放在 meta 里；不给的话会话落在 _no-cwd，而起床包那类插件是从 cwd 找家目录的
    //  - setup 负责把 agentPreset 挂上去 —— 这一步才让这个会话带上预设的系统提示
    const sel = ctx.agentDefaultModel.currentSelection();
    const agentOptions = { provider: sel.provider, model: sel.model };
    const presets = ctx.get("agentPresets");
    let presetId;
    let setup;
    if (presets !== undefined) {
      presetId = (await presets.resolve(opts.agentPreset)).id;
      setup = async (agentCtx) => { await presets.mount(agentCtx, presetId); };
    } else {
      log("no agentPresets service, session will not carry the wakeup pack");
    }
    const meta = { cwd: opts.cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) };
    let handle;
    try {
      handle = await ctx.agents.create({ sessionId, agentOptions, meta, setup });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/already exists/i.test(msg)) throw e;
      log("session exists, opening a fresh one instead");
      handle = await ctx.agents.create({ sessionId: `${sessionId}-${Date.now()}`, agentOptions, meta, setup });
    }
    // 会话真名要从 agent 身上取：撞名时我在后面加了时间戳，实际 id 跟 sessionId
    // 已经不是一个东西了。记错这个名字，回话的事件回来就对不上号，
    // 会被当成别人的话丢掉 —— 它明明说了，是我没接。
    const realId = handle?.agent?.session?.id ?? sessionId;
    // 会话开出来了，还得把它挂进 cwd 对应的那个工作区。
    // 宿主只在“从工作区里新建会话”那条路上替人挂（workspace.attachSession），
    // 插件自己 ctx.agents.create 开的会话不经过那儿 —— 不补这一下，
    // 它只会在侧栏「未分组」里躺着。
    try {
      const registry = ctx.get("workspaceRegistry");
      const ws = registry === undefined ? undefined : await registry.resolveByPath(meta.cwd);
      if (ws === undefined) {
        log("no workspace owns", meta.cwd, "- session stays ungrouped");
      } else {
        await ws.attachSession(realId);
        log("attached", realId, "->", ws.path);
      }
    } catch (e) {
      log("attach to workspace failed", realId, String((e && e.message) || e));
    }
    const entry = {
      userId,
      sessionId: realId,
      handle,
      agent: handle?.agent,
      chunks: [],
      timer: null,
    };
    convs.set(key, entry);
    log("opened session", realId, "agent?", !!entry.agent);
    return entry;
  }

  /** 攒够一段安静时间，就把这段回答发出去。 */
  function flush(entry) {
    entry.timer = null;
    const text = entry.chunks.join("\n\n").trim();
    entry.chunks = [];
    if (!text) return;
    try {
      sendToQq(entry.userId, text);
    } catch (e) {
      log("flush failed:", e?.message ?? e);
    }
  }

  async function onIncoming(userId, text, media) {
    const key = String(userId);
    // 正在等审批：先看他这条是不是答复。是就当场回填，不注入会话 ——
    // 会话这会儿正卡在那次工具调用上，注进去只会排队。
    for (const [sid, rec] of pendingApprovals) {
      if (rec.settled || rec.userId !== userId) continue;
      const verdict = approvalAnswer(text);
      if (verdict === null) break;             // 说的不是批/不批，照常往下走
      rec.settle(verdict);
      sendToQq(userId, verdict === "allowed-once" ? "批了，干。" : "行，不干。");
      log(`approval ${verdict} by ${userId} (${sid})`);
      return;
    }
    // 文字 + 收下来的媒体一起交给我：图那半用 "[图片] <本地路径>" 的形式缀在后面，
    // 我拿 path 去 read 就行。原来这里只有 text，图根本进不来。
    const mediaLines = Array.isArray(media?.lines) ? media.lines : [];
    const full = [String(text || "").trim(), ...mediaLines].filter(Boolean).join("\n");
    const lowered = String(text || "").trim().toLowerCase();

    // 明说换新的
    if (NEW_CHAT_CUES.has(lowered)) {
      const had = dropConv(key);
      log(`new chat by cue from ${userId}, dropped=${had}`);
      sendToQq(userId, "行，换新的。");
      return;
    }
    // 隔太久了，当下一条是新话题
    if (idleExpired(key)) {
      const had = dropConv(key);
      log(`new chat by idle from ${userId}, dropped=${had}`);
    }
    lastSeen.set(key, Date.now());

    const entry = await convFor(userId);
    const agent = entry.agent;
    if (!agent) throw new Error("handle has no agent");
    const say =
      typeof agent.followup === "function"
        ? agent.followup.bind(agent)
        : typeof agent.inject === "function"
          ? agent.inject.bind(agent)
          : null;
    if (!say) throw new Error("agent has neither followup nor inject");
    say({
      id: crypto.randomUUID(),
      role: "user",
      content: [{ type: "text", text: full }],
      source: { kind: "user" },
    });
    log(`in <- ${userId}: ${full.slice(0, 60)}`);
  }

  /**
   * 审批搬到 QQ 来。
   *
   * 批准这件事在宿主里是一条 waterfall（`approval/request`）：谁先给出结论
   * 谁说了算，不接就 `next()` 交给下一个。GUI 那张卡也是这条链上的一个应答者，
   * 所以这里必须 prepend 抢在它前面 —— 不然用户人在手机上，卡片还在电脑上晾着，
   * 这条问答根本轮不到 QQ。
   *
   * 只接 `qq-<userId>` 打头的会话，别的会话一律 next()，两条线不打架。
   */
  ctx.on("approval/request", (request, next) => {
    try {
      const sid = String(request?.agent?.session?.id ?? "");
      const m = /^qq-(\d+)/.exec(sid);
      if (!m) return next();
      const userId = Number(m[1]);
      if (!ownerId || userId !== ownerId) return next();
      if (pendingApprovals.has(sid)) return next();          // 一条会话同时只等一个
      return new Promise((resolve) => {
        let settled = false;
        const clear = () => {
          if (rec.timer) clearTimeout(rec.timer);
          if (rec.remind) clearTimeout(rec.remind);
          try {
            if (rec.onAbort) request?.signal?.removeEventListener("abort", rec.onAbort);
          } catch (e) { /* 没挂上就算了 */ }
          pendingApprovals.delete(sid);
        };
        const rec = {
          userId: userId,
          settled: false,
          timer: null,
          remind: null,
          onAbort: null,
          settle: (outcome) => {
            if (settled) return;
            settled = true;
            rec.settled = true;
            clear();
            resolve(outcome);
          },
        };
        // 用户一直不回：先催一句，再等一阵还没动静就还给下一个应答者 ——
        // GUI 那张卡还在，用户回到电脑前照样能批。
        const give = () => {
          if (settled) return;
          settled = true;
          rec.settled = true;
          clear();
          log("approval timed out, handing on:", sid);
          resolve(next());
        };
        rec.timer = setTimeout(give, approvalTimeoutMs);
        if (approvalRemindMs > 0) {
          rec.remind = setTimeout(() => {
            if (!rec.settled) sendToQq(userId, "还等着你批/不批");
          }, approvalRemindMs);
        }
        rec.onAbort = () => rec.settle("cancelled");
        try {
          if (request?.signal) {
            request.signal.addEventListener("abort", rec.onAbort, { once: true });
            if (request.signal.aborted) {
              rec.settle("cancelled");
              return;
            }
          }
        } catch (e) { /* 信号挂不上不影响问答 */ }
        pendingApprovals.set(sid, rec);
        const reason = String(request?.reason || request?.displayReason || "").replace(/\s+/g, " ").slice(0, 200);
        sendToQq(userId, `要提权：${request?.toolName ?? "?"}${reason ? "\n" + reason : ""}\n回 1 批，回 0 不批`);
        log(`approval asked -> ${userId}: ${request?.toolName}`);
      });
    } catch (e) {
      log("approval handler failed:", (e && e.message) || e);
      return next();
    }
  }, { prepend: true });

  // 会话里说出来的话，攒起来等它说完。
  ctx.on("session/event", (session, event) => {
    try {
      if (!event || event.type !== "assistant/message") return;
      const sid = session?.id;
      if (!sid) return;
      let hit = null;
      for (const entry of convs.values()) {
        if (entry.sessionId === sid) {
          hit = entry;
          break;
        }
      }
      // 名字对不上时的兜底：
      // 会话名一定是 `qq-<userId>` 起头（撞名时缀 `-<时间戳>`，前缀不变）。
      // 只按 `convs` 里的旧名字找，DSH 一重启就会漏 —— 上一个生命周期开的会话
      // 名字还留在插件手上，新壳的 session.id 已经换了，于是回答在这里被静默丢掉，
      // 一条日志都不留（用户那头只看到"它不理我"）。这一处栽过不止一回。
      // 从 sid 反抠 userId：**认的是这条线，不会把别人的话发错人**。
      if (!hit) {
        const m = /^qq-(\d+)/.exec(String(sid));
        if (m) {
          hit = convs.get(m[1]) ?? null;
          if (hit) {
            log("session id drift:", sid, "-> conv", m[1]);
            // 顺手把名字更新掉，省得每条都走一遍兜底
            if (hit.sessionId !== sid) hit.previousSessionId = hit.sessionId;
            hit.sessionId = sid;
          }
        }
      }
      if (!hit) {
        log("no conv owns session", sid, "- answer dropped");
        return;
      }
      const text = textOf(messageOf(event));
      if (!text) return;
      hit.chunks.push(text);
      if (hit.timer) clearTimeout(hit.timer);
      hit.timer = setTimeout(() => {
        try {
          flush(hit);
        } catch (e) {
          log("flush threw:", e?.message ?? e);
        }
      }, opts.settleMs);
    } catch (e) {
      log("session event failed:", e?.message ?? e);
    }
  });

  function scheduleReconnect() {
    if (disposed) return;
    attempts += 1;
    const delay = Math.min(opts.reconnectMaxMs, 1000 * 2 ** Math.min(attempts, 5));
    setTimeout(connect, delay);
  }

  function connect() {
    if (disposed) return;
    try {
      ws = new WebSocket(opts.wsUrl);
    } catch (e) {
      log("ws create failed:", e?.message ?? e);
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      attempts = 0;
      log("connected", opts.wsUrl);
    };
    ws.onmessage = (ev) => {
      try {
        const raw =
          typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
        const j = JSON.parse(raw);

        // 先看是不是我发出去那几问的回包（get_image / get_record / get_file）。
        // 回包也带 echo，跟消息事件混在一条流里，不放前面会被当噪音丢掉。
        if (j?.echo && pending.has(j.echo)) {
          const settle = pending.get(j.echo);
          settle(j);
          return;
        }

        if (j?.post_type !== "message") return;
        if (j.message_type !== "private") return;
        const uid = Number(j.user_id);
        if (!uid) return;
        if (!ownerId || uid !== ownerId) return;
        const text = oneBotText(j.message);
        const hasMedia = mediaSegments(j.message).length > 0;
        // 以前这里是 `if (!text) return;` —— 纯图消息就被这一句吃掉了。
        if (!text && !hasMedia) return;
        const go = async () => {
          const media = hasMedia ? await collectMedia(j.message) : { lines: [], paths: [] };
          await onIncoming(uid, text, media);
        };
        go().catch((e) => log("incoming failed:", (e && e.stack) || (e && e.message) || String(e)));
      } catch (e) {
        log("event parse failed:", e?.message ?? e);
      }
    };
    ws.onclose = () => {
      if (disposed) return;
      log("closed, will retry");
      scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  connect();

  ctx.on("dispose", () => {
    disposed = true;
    try {
      ws?.close();
    } catch {
      /* 关不掉就算了 */
    }
  });
}