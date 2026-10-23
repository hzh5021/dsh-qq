/**
 * dsh-qq 的浏览器那半：在设置里「插件」那页放一块 QQ 面板。
 *
 * 它怎么拿数据：宿主那半（lib/index.js）在本机开了个只读的小口子
 * （http://127.0.0.1:3002），这儿直接 fetch。不走 DSH 正规的 ctx.remote ——
 * 那条路的 /remote 产物是 tsdown 构建出来的，为这点东西搭一条构建链不划算。
 *
 * 形状照抄 @deepseek-ai/dsh-client-ui-settings-plugin-inventory：
 * window.__ModuleLoader__.load({ id, factory }) 注册，require 拿 react。
 */
window.__ModuleLoader__.load({
  id: "dsh-qq",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");
    let jsx = require("react/jsx-runtime");

    const BASE = "http://127.0.0.1:3002";

    const S = {
      wrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 760 },
      row: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, flexWrap: "wrap" },
      muted: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13, margin: 0 },
      dot: (on) => ({ width: 8, height: 8, borderRadius: 4, background: on ? "#3ecf6a" : "#c04a4a", flex: "0 0 auto" }),
      pre: {
        margin: 0, padding: 10, maxHeight: 240, overflow: "auto", fontSize: 12, lineHeight: 1.5,
        background: "rgba(127,127,127,.08)", borderRadius: 8, whiteSpace: "pre-wrap",
      },
      img: { width: 220, height: 220, imageRendering: "pixelated", background: "#fff", borderRadius: 8, padding: 6 },
    };

    /** QQ 通道面板：一个连接状态、一张登录码、一段最近的来往。 */
    function QqPanel() {
      const [st, setSt] = react.useState(null);
      const [err, setErr] = react.useState("");

      react.useEffect(() => {
        let alive = true;
        const tick = () => {
          fetch(BASE + "/status")
            .then((r) => r.json())
            .then((j) => { if (alive) { setSt(j); setErr(""); } })
            .catch((e) => { if (alive) setErr(String((e && e.message) || e)); });
        };
        tick();
        const id = setInterval(tick, 4000);
        return () => { alive = false; clearInterval(id); };
      }, []);

      if (err) {
        return jsx.jsxs("div", { style: S.wrap, children: [
          jsx.jsx("p", { style: S.muted, children: "宿主那半没接上（" + BASE + "）：" + err }),
          jsx.jsx("p", { style: S.muted, children: "多半是 DSH 还没重启，或者插件没起来。" }),
        ] });
      }
      if (!st) return jsx.jsx("p", { style: S.muted, children: "读状态中…" });

      const qrSrc = st.qr ? BASE + "/qr?t=" + Math.round(st.qr.mtime) : null;
      const log = Array.isArray(st.log) ? st.log.slice(-14).join("\n") : "";

      return jsx.jsxs("div", { style: S.wrap, children: [
        jsx.jsxs("div", { style: S.row, children: [
          jsx.jsx("span", { style: S.dot(st.connected) }),
          jsx.jsx("span", { children: st.connected ? "通道连着" : "通道断了" }),
          jsx.jsx("span", { style: S.muted, children: st.wsUrl }),
        ] }),
        jsx.jsxs("div", { style: S.row, children: [
          jsx.jsx("span", { style: S.muted, children: "ownerId " + st.ownerId }),
          jsx.jsx("span", { style: S.muted, children: "· 会话 " + (st.sessions || []).length + " 条" }),
          jsx.jsx("span", { style: S.muted, children: "· 工作目录 " + (st.cwd || "?") }),
        ] }),
        st.qr
          ? jsx.jsxs("div", { style: S.row, children: [
              jsx.jsx("img", { src: qrSrc, style: S.img, alt: "QQ 登录二维码" }),
              jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
                jsx.jsx("span", { style: S.muted, children: "已经登录着就不用管这张。" }),
                jsx.jsx("span", { style: S.muted, children: "要重新登录时，拿手机扫它。" }),
                st.qr.url
                  ? jsx.jsx("code", { style: { fontSize: 11, wordBreak: "break-all" }, children: st.qr.url })
                  : null,
              ] }),
            ] })
          : jsx.jsx("p", { style: S.muted, children: "没找到二维码文件（可能已经登录过了）。" }),
        jsx.jsx("pre", { style: S.pre, children: log }),
      ] });
    }

    exports.apply = function (ctx) {
      ctx.slots.inject("settings.plugins.tab", () =>
        ctx.slots.register({
          name: "settings.plugins.tab",
          id: "qq",
          order: 20,
          label: () => "QQ",
        }, QqPanel));
    };

    return exports;
  },
});