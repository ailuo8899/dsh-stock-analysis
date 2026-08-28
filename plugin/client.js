// dsh-stock-panel — Client 半端 bundle
// 注册侧边栏底部按钮 → 展开股票分析面板（K线图/新闻/情绪/盈亏）
window.__ModuleLoader__.load({
  id: "dsh-stock-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let React = require("react");
    let jsxRuntime = require("react/jsx-runtime");

    // ---------- 小工具 ----------
    const fmt = (v, d = 2) =>
      v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);
    const esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    // ---------- SVG K线图（内联，无外部依赖） ----------
    function KlineSVG({ data, analysis }) {
      const kline = data;
      const n = kline.length;
      if (n < 5)
        return jsxRuntime.jsx("div", {
          style: { color: "#8a93b2", padding: 20 },
          children: "K线数据不足",
        });
      const W = 560,
        H = 320;
      const left = 46,
        right = 10,
        top = 8,
        bottom = 24;
      const mainTop = top,
        mainH = 208;
      const volTop = mainTop + mainH + 8,
        volH = 60;
      const plotW = W - left - right;
      const step = plotW / Math.max(n - 1, 1);
      const highs = kline.map((k) => k.high),
        lows = kline.map((k) => k.low);
      const closes = kline.map((k) => k.close),
        opens = kline.map((k) => k.open);
      const vols = kline.map((k) => k.volume);
      let maxP = Math.max(...highs),
        minP = Math.min(...lows);
      const pad = (maxP - minP) * 0.04 || 1;
      maxP += pad;
      minP -= pad;
      const maxV = Math.max(...vols, 1);
      const x = (i) => left + i * step + step / 2;
      const y = (p) => mainTop + ((maxP - p) / (maxP - minP)) * mainH;
      const vy = (v) => volTop + volH - (v / maxV) * volH;

      let candles = "";
      const cw = Math.max(1.5, step * 0.62);
      for (let i = 0; i < n; i++) {
        const up = closes[i] >= opens[i];
        const color = up ? "#f0483e" : "#2ebd85";
        const cx = x(i).toFixed(1);
        const yTop = y(Math.max(opens[i], closes[i])).toFixed(1);
        const yBot = y(Math.min(opens[i], closes[i])).toFixed(1);
        const bodyH = Math.max(1, parseFloat(yBot) - parseFloat(yTop));
        candles +=
          '<line x1="' +
          cx +
          '" y1="' +
          y(highs[i]).toFixed(1) +
          '" x2="' +
          cx +
          '" y2="' +
          y(lows[i]).toFixed(1) +
          '" stroke="' +
          color +
          '" stroke-width="1"/>';
        candles +=
          '<rect x="' +
          (parseFloat(cx) - cw / 2).toFixed(1) +
          '" y="' +
          yTop +
          '" width="' +
          cw.toFixed(1) +
          '" height="' +
          bodyH.toFixed(1) +
          '" fill="' +
          color +
          '"/>';
        const vY1 = vy(vols[i]).toFixed(1);
        candles +=
          '<rect x="' +
          (parseFloat(cx) - cw / 2).toFixed(1) +
          '" y="' +
          vY1 +
          '" width="' +
          cw.toFixed(1) +
          '" height="' +
          (volTop + volH - parseFloat(vY1)).toFixed(1) +
          '" fill="' +
          color +
          '" opacity="0.5"/>';
      }
      // MA 线
      const series = analysis && analysis.series;
      const maLine = (arr, color) => {
        if (!arr) return "";
        const pts = [];
        const offset = Math.max(0, n - arr.length);
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] === null) continue;
          pts.push(x(i + offset).toFixed(1) + "," + y(arr[i]).toFixed(1));
        }
        return pts.length > 1
          ? '<polyline fill="none" stroke="' +
              color +
              '" stroke-width="1.2" points="' +
              pts.join(" ") +
              '"/>'
          : "";
      };
      // 网格 + 价格标签
      let grid = "",
        labels = "";
      for (let g = 0; g <= 4; g++) {
        const p = maxP - ((maxP - minP) * g) / 4;
        const gy = y(p).toFixed(1);
        grid +=
          '<line x1="' +
          left +
          '" y1="' +
          gy +
          '" x2="' +
          (W - right) +
          '" y2="' +
          gy +
          '" stroke="#2a3350" stroke-width="0.5"/>';
        labels +=
          '<text x="' +
          (left - 6) +
          '" y="' +
          (parseFloat(gy) + 4) +
          '" text-anchor="end" font-size="9" fill="#8a93b2">' +
          fmt(p, 2) +
          "</text>";
      }
      const idxs = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor((3 * n) / 4), n - 1];
      for (const i of idxs) {
        labels +=
          '<text x="' +
          x(i).toFixed(1) +
          '" y="' +
          (H - 6) +
          '" text-anchor="middle" font-size="9" fill="#8a93b2">' +
          kline[i].date.slice(5) +
          "</text>";
      }
      // 支撑压力虚线
      let lv = "";
      if (analysis && analysis.levels) {
        for (const s of analysis.levels.supports) {
          const ly = y(s.price).toFixed(1);
          lv +=
            '<line x1="' +
            left +
            '" y1="' +
            ly +
            '" x2="' +
            (W - right) +
            '" y2="' +
            ly +
            '" stroke="#2ebd85" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>';
        }
        for (const r of analysis.levels.resistances) {
          const ly = y(r.price).toFixed(1);
          lv +=
            '<line x1="' +
            left +
            '" y1="' +
            ly +
            '" x2="' +
            (W - right) +
            '" y2="' +
            ly +
            '" stroke="#f0483e" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/>';
        }
      }
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
        W +
        " " +
        H +
        '" style="width:100%;height:auto;display:block" font-family="inherit">' +
        '<rect width="' +
        W +
        '" height="' +
        H +
        '" fill="#0f1424"/>' +
        grid +
        labels +
        candles +
        maLine(series && series.ma5, "#f5b942") +
        maLine(series && series.ma10, "#3b82f6") +
        maLine(series && series.ma20, "#a855f7") +
        maLine(series && series.ma60, "#f97316") +
        lv +
        "</svg>";
      return jsxRuntime.jsx("div", { dangerouslySetInnerHTML: { __html: svg } });
    }

    // ---------- 折叠区块 ----------
    function CollapseHead({ title, open, onToggle, count, color }) {
      return jsxRuntime.jsxs("div", {
        onClick: onToggle,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          userSelect: "none",
          color: color || "#8a93b2",
          fontSize: 12,
          fontWeight: 600,
          marginBottom: 6,
          padding: "4px 0",
        },
        children: [
          jsxRuntime.jsx("span", {
            style: { fontSize: 10, width: 12, textAlign: "center", color: "#6b7290" },
            children: open ? "▼" : "▶",
          }),
          jsxRuntime.jsx("span", { children: title }),
          typeof count === "number" &&
            jsxRuntime.jsx("span", {
              style: { color: "#6b7290", fontWeight: 400 },
              children: "(" + count + ")",
            }),
        ],
      });
    }

    // ---------- 账户渲染（tab 切换用） ----------
    function renderSimAccount(acc) {
      if (!acc) return jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 13 }, children: "模拟账户未初始化（运行 sim.mjs init）" });
      var last = acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
      return jsxRuntime.jsxs("div", { children: [
        jsxRuntime.jsx("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 10 }, children: "💰 模拟账户 · 初始 " + fmt(acc.capital, 0) + " 元" }),
        last && jsxRuntime.jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }, children: [
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "10px 12px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 11 }, children: "总资产" }),
            jsxRuntime.jsx("div", { style: { fontSize: 18, fontWeight: 700, color: last.pnl >= 0 ? "#f0483e" : "#2ebd85" }, children: fmt(last.totalValue, 0) })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "10px 12px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 11 }, children: "累计盈亏" }),
            jsxRuntime.jsx("div", { style: { fontSize: 18, fontWeight: 700, color: last.pnl >= 0 ? "#f0483e" : "#2ebd85" }, children: (last.pnl >= 0 ? "+" : "") + fmt(last.pnl, 0) + "（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）" })
          ]}) })
        ]}),
        last && jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 12, marginBottom: 8 }, children: "沪深300 " + (last.benchPct == null ? "—" : (last.benchPct >= 0 ? "+" : "") + fmt(last.benchPct, 2) + "%") + " · 超额 " + (last.excessPct == null ? "—" : (last.excessPct >= 0 ? "+" : "") + fmt(last.excessPct, 2) + "%") }),
        jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 11, marginBottom: 6 }, children: "持仓 " + (acc.holdings || []).length + "/" + acc.rules.maxHoldings + " · 现金 " + fmt(acc.cash, 0) }),
        (acc.holdings || []).length === 0 && jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 12 }, children: "空仓" }),
        (acc.holdings || []).map(function (h) {
          return jsxRuntime.jsx("div", { onClick: () => window.open("/api/stock/report?input=" + encodeURIComponent(h.code), "_blank"), title: "点击查看 " + h.name + " 分析详情", style: { display: "flex", alignItems: "center", gap: 8, background: "#0e1424", border: "1px solid #2a3350", borderRadius: 8, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }, children: [
            jsxRuntime.jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: h.name }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290", fontSize: 11 }, children: h.code }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290", fontSize: 11 }, children: h.shares + "股" }),
            jsxRuntime.jsx("span", { style: { marginLeft: "auto", fontSize: 12, color: "#8a93b2" }, children: "成本 " + fmt(h.costPrice) })
          ]}, h.code);
        }),
        (acc.trades || []).length > 0 && jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 11, marginTop: 8 }, children: "交易 " + acc.trades.length + " 笔 · 快照 " + (acc.daily || []).length + " 日" })
      ] });
    }

    function renderRealAccount(acc) {
      if (!acc) return jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 13 }, children: "真实账户未创建（运行 real-trade.mjs add）" });
      var last = acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
      return jsxRuntime.jsxs("div", { children: [
        jsxRuntime.jsx("div", { style: { fontSize: 14, fontWeight: 700, marginBottom: 10 }, children: "💼 真实账户" }),
        last && jsxRuntime.jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }, children: [
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "10px 12px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 11 }, children: "持仓市值" }),
            jsxRuntime.jsx("div", { style: { fontSize: 18, fontWeight: 700 }, children: fmt(last.holdingsValue, 0) })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "10px 12px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 11 }, children: "浮动盈亏" }),
            jsxRuntime.jsx("div", { style: { fontSize: 18, fontWeight: 700, color: last.pnl >= 0 ? "#f0483e" : "#2ebd85" }, children: (last.pnl >= 0 ? "+" : "") + fmt(last.pnl, 0) + "（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）" })
          ]}) })
        ]}),
        (acc.holdings || []).length === 0 && jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 12 }, children: "暂无真实持仓" }),
        (acc.holdings || []).map(function (h) {
          return jsxRuntime.jsx("div", { onClick: () => window.open("/api/stock/report?input=" + encodeURIComponent(h.code), "_blank"), title: "点击查看 " + h.name + " 分析详情", style: { display: "flex", alignItems: "center", gap: 8, background: "#0e1424", border: "1px solid #2a3350", borderRadius: 8, padding: "8px 10px", marginBottom: 6, cursor: "pointer" }, children: [
            jsxRuntime.jsx("span", { style: { fontWeight: 600, fontSize: 13 }, children: h.name }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290", fontSize: 11 }, children: h.code }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290", fontSize: 11 }, children: h.shares + "股" }),
            jsxRuntime.jsx("span", { style: { marginLeft: "auto", fontSize: 12, color: "#8a93b2" }, children: "成本 " + fmt(h.costPrice) })
          ]}, h.code);
        }),
        (acc.trades || []).length > 0 && jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 11, marginTop: 8 }, children: "交易 " + acc.trades.length + " 笔" })
      ] });
    }

    // ---------- 每日汇总渲染（顶部导航 tab） ----------
    function renderDailySummary(s) {
      if (!s) return jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 13 }, children: "汇总加载中…" });
      var idx = s.index;
      var sim = s.sim;
      var real = s.real;
      var wl = s.watchlist || [];
      var simLast = sim && sim.last;
      var realLast = real && real.last;
      return jsxRuntime.jsxs("div", { children: [
        idx && jsxRuntime.jsx("div", { style: { background: "rgba(245,185,66,.08)", border: "1px solid rgba(245,185,66,.3)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, fontSize: 12 }, children: "📊 沪深300：<b>" + fmt(idx.price) + "</b>（" + (idx.pct >= 0 ? "+" : "") + fmt(idx.pct, 2) + "%）· " + (idx.source || "") }),
        jsxRuntime.jsx("div", { style: { fontSize: 14, fontWeight: 700, margin: "10px 0 6px" }, children: "💰 模拟账户" }),
        simLast ? jsxRuntime.jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }, children: [
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "总资产" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700 }, children: fmt(simLast.totalValue, 0) })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "累计盈亏" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700, color: simLast.pnl >= 0 ? "#f0483e" : "#2ebd85" }, children: (simLast.pnl >= 0 ? "+" : "") + fmt(simLast.pnl, 0) + "（" + (simLast.pnlPct >= 0 ? "+" : "") + fmt(simLast.pnlPct, 2) + "%）" })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "沪深300" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700 }, children: simLast.benchPct == null ? "—" : (simLast.benchPct >= 0 ? "+" : "") + fmt(simLast.benchPct, 2) + "%" })
          ]}) })
        ]}) : jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 12 }, children: "模拟账户未初始化" }),
        (sim && sim.holdings || []).map(function (h) {
          return jsxRuntime.jsx("div", { onClick: () => window.open("/api/stock/report?input=" + encodeURIComponent(h.code), "_blank"), title: "点击查看 " + h.name + " 分析详情", style: { display: "flex", alignItems: "center", gap: 8, background: "#0e1424", border: "1px solid #2a3350", borderRadius: 8, padding: "7px 10px", marginBottom: 5, fontSize: 12, cursor: "pointer" }, children: [
            jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: h.name }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290" }, children: h.code + " " + h.shares + "股" }),
            jsxRuntime.jsx("span", { style: { marginLeft: "auto", color: h.pl >= 0 ? "#f0483e" : "#2ebd85" }, children: (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）" })
          ]}, h.code);
        }),
        jsxRuntime.jsx("div", { style: { fontSize: 14, fontWeight: 700, margin: "12px 0 6px" }, children: "💼 真实账户" }),
        realLast ? jsxRuntime.jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }, children: [
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "持仓市值" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700 }, children: fmt(realLast.holdingsValue, 0) })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "浮动盈亏" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700, color: realLast.pnl >= 0 ? "#f0483e" : "#2ebd85" }, children: (realLast.pnl >= 0 ? "+" : "") + fmt(realLast.pnl, 0) + "（" + (realLast.pnlPct >= 0 ? "+" : "") + fmt(realLast.pnlPct, 2) + "%）" })
          ]}) }),
          jsxRuntime.jsx("div", { style: { background: "#0e1424", borderRadius: 8, padding: "8px" }, children: jsxRuntime.jsxs("div", { children: [
            jsxRuntime.jsx("div", { style: { color: "#8a93b2", fontSize: 10 }, children: "沪深300" }),
            jsxRuntime.jsx("div", { style: { fontSize: 15, fontWeight: 700 }, children: realLast.benchPct == null ? "—" : (realLast.benchPct >= 0 ? "+" : "") + fmt(realLast.benchPct, 2) + "%" })
          ]}) })
        ]}) : jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 12 }, children: "真实账户未创建" }),
        (real && real.holdings || []).map(function (h) {
          return jsxRuntime.jsx("div", { onClick: () => window.open("/api/stock/report?input=" + encodeURIComponent(h.code), "_blank"), title: "点击查看 " + h.name + " 分析详情", style: { display: "flex", alignItems: "center", gap: 8, background: "#0e1424", border: "1px solid #2a3350", borderRadius: 8, padding: "7px 10px", marginBottom: 5, fontSize: 12, cursor: "pointer" }, children: [
            jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: h.name }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290" }, children: h.code + " " + h.shares + "股" }),
            jsxRuntime.jsx("span", { style: { marginLeft: "auto", color: h.pl >= 0 ? "#f0483e" : "#2ebd85" }, children: (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）" })
          ]}, h.code);
        }),
        jsxRuntime.jsx("div", { style: { fontSize: 14, fontWeight: 700, margin: "12px 0 6px" }, children: "⭐ 自选股票（" + wl.length + "）" }),
        wl.length === 0 && jsxRuntime.jsx("div", { style: { color: "#6b7290", fontSize: 12 }, children: "暂无自选" }),
        wl.map(function (w) {
          var t = w.timing || { label: "观望", cls: "neutral" };
          var clsMap = { buy: "#f0483e", sell: "#2ebd85", watch: "#f5b942", caution: "#3b82f6", neutral: "#8a93b2" };
          return jsxRuntime.jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, background: "#0e1424", border: "1px solid #2a3350", borderRadius: 8, padding: "7px 10px", marginBottom: 5, fontSize: 12 }, children: [
            jsxRuntime.jsx("span", { style: { fontWeight: 600 }, children: w.name }),
            jsxRuntime.jsx("span", { style: { color: "#6b7290" }, children: w.code }),
            jsxRuntime.jsx("span", { style: { color: w.pct >= 0 ? "#f0483e" : "#2ebd85" }, children: (w.pct >= 0 ? "+" : "") + fmt(w.pct, 2) + "%" }),
            jsxRuntime.jsx("span", { style: { marginLeft: "auto", color: clsMap[t.cls] || "#8a93b2", fontWeight: 600 }, children: t.label })
          ]}, w.code);
        })
      ] });
    }

    // ---------- 面板组件 ----------
    function StockPanel({ analyze, onClose }) {
      const [query, setQuery] = React.useState("");
      const [shares, setShares] = React.useState("");
      const [cost, setCost] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState("");
      const [result, setResult] = React.useState(null);
      const [leaders, setLeaders] = React.useState(null);
      const [watchlist, setWatchlist] = React.useState(null);
      const [picks, setPicks] = React.useState(null);
      const [picking, setPicking] = React.useState(false);
      const [pkOpen, setPkOpen] = React.useState(true);
      const [wlOpen, setWlOpen] = React.useState(true);
      const [ldOpen, setLdOpen] = React.useState(false);
      const [accounts, setAccounts] = React.useState(null);
      const [summary, setSummary] = React.useState(null);
      const [tab, setTab] = React.useState("analyze");
      const rootRef = React.useRef(null);

      // 加载龙头清单、自选列表、每日推荐
      React.useEffect(() => {
        (async () => {
          try {
            const [l, w, p] = await Promise.all([
              fetch("/api/stock/leaders").then((r) => r.json()),
              fetch("/api/stock/watchlist").then((r) => r.json()),
              fetch("/api/stock/picks").then((r) => r.json()),
            ]);
            setLeaders(l.leaders || []);
            setWatchlist(w.watchlist || []);
            setPicks(p.picks || null);
          } catch (e) {
            /* 静默失败 */
          }
        })();
        (async () => {
          try {
            const a = await fetch("/api/stock/accounts").then((r) => r.json());
            setAccounts(a);
          } catch (e) {
            /* 静默失败 */
          }
        })();
        (async () => {
          try {
            const s2 = await fetch("/api/stock/summary").then((r) => r.json());
            setSummary(s2);
          } catch (e) {
            /* 静默失败 */
          }
        })();
      }, []);

      // 手动触发选股（force=true 强制重选一批，排除历史已选，避免重复）
      const runPicks = async (slot) => {
        if (picking) return;
        setPicking(true);
        setError("");
        try {
          const r = await fetch("/api/stock/picks/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slot, force: true }),
          });
          const j = await r.json();
          if (j.error) {
            setError(j.error);
            return;
          }
          // skipped（并发/繁忙）或返回非完整结构时不覆盖已有数据
          if (j.skipped) {
            setError(j.reason || "选股繁忙，请稍后再试");
            return;
          }
          if (!j || !Array.isArray(j.picks)) {
            setError("选股结果异常，请重试");
            return;
          }
          setPicks((prev) => ({ ...(prev || {}), [slot]: j }));
        } catch (e) {
          setError(String(e));
        } finally {
          setPicking(false);
        }
      };

      // 在新标签页打开完整 HTML 报告
      const openReportTab = (code) => {
        if (!code) {
          setError("缺少股票代码");
          return;
        }
        window.open("/api/stock/report?input=" + encodeURIComponent(code), "_blank");
      };

      const pick = async (code, name) => {
        setQuery(code);
        setLoading(true);
        setError("");
        try {
          const opts = {};
          const sh = parseFloat(shares);
          const co = parseFloat(cost);
          if (!isNaN(sh) && sh > 0 && !isNaN(co) && co > 0) {
            opts.shares = sh;
            opts.cost = co;
          }
          const data = await analyze(code, opts);
          setResult(data);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      const toggleWatch = async (code, name, industry) => {
        try {
          const inList = (watchlist || []).some((x) => x.code === code);
          const r = await fetch(
            inList ? "/api/stock/watchlist/remove" : "/api/stock/watchlist/add",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(inList ? { code } : { code, name, industry }),
            },
          );
          const j = await r.json();
          setWatchlist(j.watchlist || []);
        } catch (e) {
          /* 静默 */
        }
      };

      const run = async () => {
        const input = query.trim();
        if (!input) {
          setError("请输入股票代码或名称");
          return;
        }
        setLoading(true);
        setError("");
        try {
          const opts = {};
          const sh = parseFloat(shares);
          const co = parseFloat(cost);
          if (!isNaN(sh) && sh > 0 && !isNaN(co) && co > 0) {
            opts.shares = sh;
            opts.cost = co;
          }
          const data = await analyze(input, opts);
          setResult(data);
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      };

      // 外部点击关闭
      React.useEffect(() => {
        const onDown = (ev) => {
          if (rootRef.current && !rootRef.current.contains(ev.target)) onClose();
        };
        const onKey = (ev) => {
          if (ev.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [onClose]);

      const q = result && result.quote;
      const a = result && result.analysis;
      const s = a && a.signals;
      const se = result && result.sentiment;
      const pos = result && result.position;
      const up = q && q.pct >= 0;
      const badgeCls = s
        ? { 买入: "buy", 关注: "watch", 观望: "neutral", 谨慎: "caution", 回避: "sell" }[
            s.verdict
          ] || "neutral"
        : "";

      return jsxRuntime.jsxs("div", {
        ref: rootRef,
        style: {
          position: "fixed",
          top: 72,
          right: 16,
          width: 620,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 100px)",
          overflowY: "auto",
          background: "#121829",
          border: "1px solid #2a3350",
          borderRadius: 14,
          boxShadow: "0 12px 40px rgba(0,0,0,.5)",
          color: "#e6eaf5",
          zIndex: 9999,
          fontFamily:
            "-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif",
          fontSize: 14,
          lineHeight: 1.55,
        },
        children: [
          jsxRuntime.jsxs("div", {
            style: {
              display: "flex",
              alignItems: "center",
              padding: "12px 16px",
              borderBottom: "1px solid #2a3350",
            },
            children: [
              jsxRuntime.jsx("span", {
                style: { fontSize: 15, fontWeight: 600 },
                children: "📈 股票分析",
              }),
              result &&
                result.meta &&
                jsxRuntime.jsx("button", {
                  onClick: () => openReportTab(result.meta.code),
                  title: "在新标签页打开完整报告",
                  style: {
                    marginLeft: "auto",
                    marginRight: 8,
                    background: "none",
                    border: "1px solid #3b82f6",
                    color: "#3b82f6",
                    borderRadius: 6,
                    padding: "3px 10px",
                    fontSize: 12,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  },
                  children: "↗ 新标签打开",
                }),
              jsxRuntime.jsx("button", {
                onClick: onClose,
                style: {
                  marginLeft: result && result.meta ? 0 : "auto",
                  background: "none",
                  border: "none",
                  color: "#8a93b2",
                  cursor: "pointer",
                  fontSize: 18,
                  padding: "0 4px",
                },
                children: "✕",
              }),
            ],
          }),
          // 顶部 tab 切换：分析 / 模拟账户 / 真实账户
          jsxRuntime.jsxs("div", {
            children: [
              // 顶部 tab 按钮行（横向）
              jsxRuntime.jsxs("div", {
                style: {
                  display: "flex",
                  gap: 4,
                  padding: "8px 14px 0",
                  borderBottom: "1px solid #2a3350",
                },
                children: [
                  [
                    ["analyze", "📊 分析"],
                ["sim", "💰 模拟账户"],
                ["real", "💼 真实账户"],
                ["daily", "📊 每日汇总"],
              ].map(function (pair) {
                var k = pair[0],
                  label = pair[1];
                return jsxRuntime.jsx(
                  "button",
                  {
                    onClick: function () {
                      setTab(k);
                    },
                    style: {
                      padding: "7px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: "pointer",
                      borderRadius: "8px 8px 0 0",
                      background: tab === k ? "#0e1424" : "none",
                      border: "none",
                      borderBottom: tab === k ? "2px solid #3b82f6" : "2px solid transparent",
                      color: tab === k ? "#e6eaf5" : "#8a93b2",
                    },
                    children: label,
                  },
                  k,
                );
              }),
                ],
              }),
              tab === "sim" &&
                jsxRuntime.jsx("div", {
                  style: { padding: "12px 14px" },
                  children: renderSimAccount(accounts && accounts.sim),
                }),
              tab === "real" &&
                jsxRuntime.jsx("div", {
                  style: { padding: "12px 14px" },
                  children: renderRealAccount(accounts && accounts.real),
                }),
              tab === "daily" &&
                jsxRuntime.jsx("div", {
                  style: { padding: "12px 14px" },
                  children: renderDailySummary(summary),
                }),
              tab === "analyze" &&
                jsxRuntime.jsxs("div", {
                  children: [
                    // 每日推荐（情绪选股，9:30 / 14:30 自动更新）
                    jsxRuntime.jsxs("div", {
                      style: { padding: "0 14px 4px" },
                      children: [
                        jsxRuntime.jsxs("div", {
                          style: { display: "flex", alignItems: "center", gap: 8 },
                          children: [
                            jsxRuntime.jsx(CollapseHead, {
                              title: "🎯 今日推荐（情绪选股）",
                              open: pkOpen,
                              onToggle: () => setPkOpen((v) => !v),
                              color: "#3b82f6",
                            }),
                            jsxRuntime.jsx("button", {
                              onClick: () => runPicks("morning"),
                              disabled: picking,
                              style: {
                                background: "none",
                                border: "1px solid #2a3350",
                                color: picking ? "#4a5470" : "#8a93b2",
                                borderRadius: 6,
                                padding: "2px 8px",
                                fontSize: 11,
                                cursor: picking ? "wait" : "pointer",
                              },
                              children: picking ? "选股中…" : "↻ 重新选股",
                            }),
                          ],
                        }),
                        pkOpen &&
                          jsxRuntime.jsx("div", {
                            style: { paddingBottom: 8 },
                            children:
                              picks && (picks.morning || picks.afternoon)
                                ? (function () {
                                    const m = picks.morning,
                                      a = picks.afternoon;
                                    const show = m || a;
                                    const slotLabel = a ? "下午" : "上午";
                                    const src = a || m;
                                    return jsxRuntime.jsxs("div", {
                                      children: [
                                        jsxRuntime.jsx("div", {
                                          style: {
                                            color: "#6b7290",
                                            fontSize: 11,
                                            marginBottom: 6,
                                          },
                                          children:
                                            (src.date || "—") +
                                            " " +
                                            slotLabel +
                                            " · 扫描 " +
                                            (src.market && src.market.scanned != null
                                              ? src.market.scanned
                                              : "-") +
                                            " 只" +
                                            (src.excluded
                                              ? " · 已排除 " + src.excluded + " 只"
                                              : "") +
                                            " · 点击即分析",
                                        }),
                                        (src.picks || []).map((p) =>
                                          jsxRuntime.jsxs(
                                            "div",
                                            {
                                              style: {
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 8,
                                                background: "#0e1424",
                                                border: "1px solid #2a3350",
                                                borderRadius: 8,
                                                padding: "7px 10px",
                                                marginBottom: 6,
                                                cursor: "pointer",
                                              },
                                              onClick: () => pick(p.code, p.name),
                                              children: [
                                                jsxRuntime.jsx("span", {
                                                  style: { fontWeight: 600, fontSize: 13 },
                                                  children: p.name || "—",
                                                }),
                                                jsxRuntime.jsx("span", {
                                                  style: { color: "#6b7290", fontSize: 11 },
                                                  children: p.code || "",
                                                }),
                                                jsxRuntime.jsx("span", {
                                                  style: { color: "#6b7290", fontSize: 11 },
                                                  children: p.industry || "",
                                                }),
                                                jsxRuntime.jsx("span", {
                                                  style: {
                                                    marginLeft: "auto",
                                                    fontSize: 12,
                                                    fontWeight: 600,
                                                    color:
                                                      (p.pct || 0) >= 0 ? "#f0483e" : "#2ebd85",
                                                  },
                                                  children:
                                                    (p.pct > 0 ? "+" : "") +
                                                    (p.pct != null ? p.pct + "%" : "-"),
                                                }),
                                                jsxRuntime.jsx("span", {
                                                  style: {
                                                    fontSize: 11,
                                                    color: "#3b82f6",
                                                    fontWeight: 600,
                                                  },
                                                  children:
                                                    "情绪分 " + (p.score != null ? p.score : "-"),
                                                }),
                                              ],
                                            },
                                            p.code,
                                          ),
                                        ),
                                        (src.picks || []).length === 0 &&
                                          jsxRuntime.jsx("div", {
                                            style: { color: "#6b7290", fontSize: 12 },
                                            children:
                                              "暂无推荐（9:30 / 14:30 自动更新，或点上方重新选股）",
                                          }),
                                      ],
                                    });
                                  })()
                                : jsxRuntime.jsx("div", {
                                    style: { color: "#6b7290", fontSize: 12 },
                                    children: "暂无推荐（9:30 / 14:30 自动更新，或点上方重新选股）",
                                  }),
                          }),
                      ],
                    }),
                    jsxRuntime.jsx("div", {
                      style: { padding: 14 },
                      children: jsxRuntime.jsxs("div", {
                        style: { display: "flex", gap: 8, flexWrap: "wrap" },
                        children: [
                          jsxRuntime.jsx("input", {
                            value: query,
                            onChange: (e) => setQuery(e.target.value),
                            placeholder: "股票代码或名称（如 600519 / 茅台）",
                            onKeyDown: (e) => {
                              if (e.key === "Enter") run();
                            },
                            style: {
                              flex: "1 1 200px",
                              background: "#0e1424",
                              border: "1px solid #2a3350",
                              borderRadius: 8,
                              color: "#e6eaf5",
                              padding: "8px 10px",
                              fontSize: 14,
                              outline: "none",
                            },
                          }),
                          jsxRuntime.jsx("input", {
                            value: shares,
                            onChange: (e) => setShares(e.target.value),
                            placeholder: "股数（可选）",
                            type: "number",
                            min: 0,
                            style: {
                              width: 100,
                              background: "#0e1424",
                              border: "1px solid #2a3350",
                              borderRadius: 8,
                              color: "#e6eaf5",
                              padding: "8px 10px",
                              fontSize: 14,
                              outline: "none",
                            },
                          }),
                          jsxRuntime.jsx("input", {
                            value: cost,
                            onChange: (e) => setCost(e.target.value),
                            placeholder: "成本价（可选）",
                            type: "number",
                            min: 0,
                            step: 0.01,
                            style: {
                              width: 100,
                              background: "#0e1424",
                              border: "1px solid #2a3350",
                              borderRadius: 8,
                              color: "#e6eaf5",
                              padding: "8px 10px",
                              fontSize: 14,
                              outline: "none",
                            },
                          }),
                          jsxRuntime.jsx("button", {
                            onClick: run,
                            disabled: loading,
                            style: {
                              background: "#3b82f6",
                              border: "none",
                              color: "#fff",
                              borderRadius: 8,
                              padding: "8px 18px",
                              fontSize: 14,
                              fontWeight: 600,
                              cursor: loading ? "wait" : "pointer",
                            },
                            children: loading ? "分析中…" : "分析",
                          }),
                        ],
                      }),
                    }),
                    error &&
                      jsxRuntime.jsx("div", {
                        style: {
                          margin: "0 14px 10px",
                          padding: "8px 12px",
                          background: "rgba(240,72,62,.12)",
                          border: "1px solid rgba(240,72,62,.4)",
                          borderRadius: 8,
                          color: "#f0483e",
                          fontSize: 13,
                        },
                        children: error,
                      }),
                    jsxRuntime.jsxs("div", {
                      style: { padding: "0 14px 12px" },
                      children: [
                        // 我的自选（可折叠）
                        jsxRuntime.jsx(CollapseHead, {
                          title: "⭐ 我的自选",
                          open: wlOpen,
                          onToggle: () => setWlOpen((v) => !v),
                          count: (watchlist || []).length,
                          color: "#f5b942",
                        }),
                        wlOpen &&
                          (watchlist && watchlist.length > 0
                            ? jsxRuntime.jsx("div", {
                                style: {
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 6,
                                  marginBottom: 10,
                                },
                                children: watchlist.map((w) =>
                                  jsxRuntime.jsxs(
                                    "span",
                                    {
                                      style: {
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                        background: "rgba(245,185,66,.12)",
                                        border: "1px solid rgba(245,185,66,.35)",
                                        borderRadius: 6,
                                        padding: "3px 8px",
                                        fontSize: 12,
                                        cursor: "pointer",
                                        color: "#f5b942",
                                      },
                                      onClick: () => pick(w.code, w.name),
                                      title: w.industry ? w.industry + " · 点击分析" : "点击分析",
                                      children: [
                                        jsxRuntime.jsx("span", { children: w.name + " " + w.code }),
                                        jsxRuntime.jsx("span", {
                                          onClick: (e) => {
                                            e.stopPropagation();
                                            toggleWatch(w.code, w.name, w.industry);
                                          },
                                          style: { opacity: 0.6, marginLeft: 2 },
                                          children: "✕",
                                        }),
                                      ],
                                    },
                                    w.code,
                                  ),
                                ),
                              })
                            : jsxRuntime.jsx("div", {
                                style: { color: "#6b7290", fontSize: 12, marginBottom: 10 },
                                children: "（空）点下方龙头 + 号添加",
                              })),
                        // 行业龙头（可折叠，默认收起）
                        jsxRuntime.jsx(CollapseHead, {
                          title: "🏆 A股行业龙头",
                          open: ldOpen,
                          onToggle: () => setLdOpen((v) => !v),
                          count: leaders ? leaders.length : undefined,
                        }),
                        ldOpen &&
                          (leaders
                            ? jsxRuntime.jsx("div", {
                                style: { display: "flex", flexWrap: "wrap", gap: 6 },
                                children: leaders.map((l) => {
                                  const inList = (watchlist || []).some((x) => x.code === l.code);
                                  return jsxRuntime.jsxs(
                                    "span",
                                    {
                                      style: {
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 4,
                                        background: "#0e1424",
                                        border: "1px solid #2a3350",
                                        borderRadius: 6,
                                        padding: "3px 8px",
                                        fontSize: 12,
                                        cursor: "pointer",
                                        color: "#c7cede",
                                      },
                                      onClick: () => pick(l.code, l.name),
                                      title: l.industry + "龙头 · 点击分析",
                                      children: [
                                        jsxRuntime.jsx("span", {
                                          style: { color: "#6b7290", fontSize: 10, marginRight: 2 },
                                          children: l.industry,
                                        }),
                                        jsxRuntime.jsx("span", { children: l.name }),
                                        jsxRuntime.jsx("span", {
                                          onClick: (e) => {
                                            e.stopPropagation();
                                            toggleWatch(l.code, l.name, l.industry);
                                          },
                                          style: {
                                            color: inList ? "#f5b942" : "#6b7290",
                                            marginLeft: 2,
                                          },
                                          children: inList ? "★" : "+",
                                        }),
                                      ],
                                    },
                                    l.code,
                                  );
                                }),
                              })
                            : jsxRuntime.jsx("div", {
                                style: { color: "#6b7290", fontSize: 12 },
                                children: "加载中…",
                              })),
                      ],
                    }),
                    result &&
                      q &&
                      jsxRuntime.jsxs("div", {
                        style: { padding: "0 14px 14px" },
                        children: [
                          jsxRuntime.jsxs("div", {
                            style: {
                              display: "flex",
                              alignItems: "baseline",
                              gap: 10,
                              marginBottom: 8,
                            },
                            children: [
                              jsxRuntime.jsx("span", {
                                style: { fontSize: 20, fontWeight: 700 },
                                children: result.meta.name + " " + result.meta.code,
                              }),
                              jsxRuntime.jsx("span", {
                                style: { fontSize: 24, fontWeight: 700 },
                                children: fmt(q.price),
                              }),
                              jsxRuntime.jsx("span", {
                                style: {
                                  fontSize: 15,
                                  fontWeight: 600,
                                  color: up ? "#f0483e" : "#2ebd85",
                                },
                                children: (q.pct > 0 ? "+" : "") + fmt(q.pct, 2) + "%",
                              }),
                              jsxRuntime.jsx("span", {
                                style: { color: "#8a93b2", fontSize: 12 },
                                children: result.meta.market,
                              }),
                            ],
                          }),
                          s &&
                            jsxRuntime.jsxs("div", {
                              style: {
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                marginBottom: 10,
                              },
                              children: [
                                jsxRuntime.jsx("span", {
                                  style: {
                                    fontSize: 16,
                                    fontWeight: 700,
                                    padding: "4px 14px",
                                    borderRadius: 8,
                                    background: "rgba(138,147,178,.14)",
                                    border: "1px solid #8a93b2",
                                  },
                                  children: s.verdict + "（" + s.score + "）",
                                }),
                                jsxRuntime.jsx("span", {
                                  style: { color: "#8a93b2", fontSize: 13 },
                                  children: s.summary,
                                }),
                              ],
                            }),
                          jsxRuntime.jsx(KlineSVG, { data: result.kline, analysis: a }),
                          jsxRuntime.jsxs("div", {
                            style: {
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: 8,
                              marginTop: 10,
                            },
                            children: [
                              jsxRuntime.jsxs("div", {
                                style: {
                                  background: "#0e1424",
                                  border: "1px solid #2a3350",
                                  borderRadius: 8,
                                  padding: 8,
                                },
                                children: [
                                  jsxRuntime.jsx("div", {
                                    style: { color: "#8a93b2", fontSize: 11, marginBottom: 4 },
                                    children: "技术指标",
                                  }),
                                  a &&
                                    jsxRuntime.jsxs("div", {
                                      style: { fontSize: 12 },
                                      children: [
                                        "MA " +
                                          fmt(a.indicators.ma5) +
                                          "/" +
                                          fmt(a.indicators.ma10) +
                                          "/" +
                                          fmt(a.indicators.ma20) +
                                          "/" +
                                          fmt(a.indicators.ma60),
                                        jsxRuntime.jsx("br", {}),
                                        "MACD " +
                                          fmt(a.indicators.macd.dif) +
                                          "/" +
                                          fmt(a.indicators.macd.dea),
                                        jsxRuntime.jsx("br", {}),
                                        "RSI14 " +
                                          fmt(a.indicators.rsi14, 1) +
                                          " · KDJ " +
                                          fmt(a.indicators.kdj.k, 1) +
                                          "/" +
                                          fmt(a.indicators.kdj.d, 1) +
                                          "/" +
                                          fmt(a.indicators.kdj.j, 1),
                                        jsxRuntime.jsx("br", {}),
                                        "BOLL " +
                                          fmt(a.indicators.boll.upper) +
                                          " / " +
                                          fmt(a.indicators.boll.mid) +
                                          " / " +
                                          fmt(a.indicators.boll.lower),
                                      ],
                                    }),
                                ],
                              }),
                              jsxRuntime.jsxs("div", {
                                style: {
                                  background: "#0e1424",
                                  border: "1px solid #2a3350",
                                  borderRadius: 8,
                                  padding: 8,
                                },
                                children: [
                                  jsxRuntime.jsx("div", {
                                    style: { color: "#8a93b2", fontSize: 11, marginBottom: 4 },
                                    children: "支撑 / 压力",
                                  }),
                                  a &&
                                    jsxRuntime.jsxs("div", {
                                      style: { fontSize: 12 },
                                      children: [
                                        "支撑 " +
                                          (a.levels.supports || [])
                                            .map((x) => fmt(x.price))
                                            .join(" / "),
                                        jsxRuntime.jsx("br", {}),
                                        "压力 " +
                                          (a.levels.resistances || [])
                                            .map((x) => fmt(x.price))
                                            .join(" / "),
                                      ],
                                    }),
                                ],
                              }),
                            ],
                          }),
                          se &&
                            jsxRuntime.jsxs("div", {
                              style: {
                                marginTop: 10,
                                background: "#0e1424",
                                border: "1px solid #2a3350",
                                borderRadius: 8,
                                padding: 10,
                              },
                              children: [
                                jsxRuntime.jsx("div", {
                                  style: { color: "#8a93b2", fontSize: 11, marginBottom: 6 },
                                  children:
                                    "🧠 市场情绪 " +
                                    se.label +
                                    "（" +
                                    (se.score >= 0 ? "+" : "") +
                                    fmt(se.score, 2) +
                                    "）",
                                }),
                                (se.news || [])
                                  .slice(0, 4)
                                  .map((n, idx) =>
                                    jsxRuntime.jsxs(
                                      "div",
                                      {
                                        style: { fontSize: 12, marginBottom: 4, color: "#c7cede" },
                                        children: [
                                          jsxRuntime.jsx("span", {
                                            style: {
                                              color:
                                                n.senti.label === "利好"
                                                  ? "#f0483e"
                                                  : n.senti.label === "利空"
                                                    ? "#2ebd85"
                                                    : "#8a93b2",
                                              marginRight: 6,
                                            },
                                            children: "[" + n.senti.label + "]",
                                          }),
                                          n.title.length > 60
                                            ? n.title.slice(0, 60) + "…"
                                            : n.title,
                                        ],
                                      },
                                      idx,
                                    ),
                                  ),
                              ],
                            }),
                          pos &&
                            jsxRuntime.jsxs("div", {
                              style: {
                                marginTop: 10,
                                background: "#0e1424",
                                border: "1px solid #2a3350",
                                borderRadius: 8,
                                padding: 10,
                              },
                              children: [
                                jsxRuntime.jsx("div", {
                                  style: { color: "#8a93b2", fontSize: 11, marginBottom: 6 },
                                  children: "💰 持仓盈亏",
                                }),
                                jsxRuntime.jsxs("div", {
                                  style: {
                                    fontSize: 15,
                                    fontWeight: 600,
                                    color: pos.pl >= 0 ? "#f0483e" : "#2ebd85",
                                  },
                                  children: [
                                    (pos.pl >= 0 ? "+" : "") +
                                      fmt(pos.pl) +
                                      " 元（" +
                                      (pos.plPct >= 0 ? "+" : "") +
                                      fmt(pos.plPct, 2) +
                                      "%）",
                                  ],
                                }),
                                jsxRuntime.jsx("div", {
                                  style: { fontSize: 12, color: "#8a93b2", marginTop: 4 },
                                  children:
                                    "市值 " +
                                    fmt(pos.value) +
                                    " · 参考止损 " +
                                    fmt(pos.stopLoss) +
                                    " · 参考止盈 " +
                                    fmt(pos.takeProfit),
                                }),
                              ],
                            }),
                          jsxRuntime.jsx("div", {
                            style: { marginTop: 10, color: "#6b7290", fontSize: 11 },
                            children: "⚠️ 数据来自公开接口，仅供参考，不构成投资建议。",
                          }),
                        ],
                      }),
                  ],
                }),
            ],
          }),
        ],
      });
    }

    // ---------- Cordis 插件 ----------
    const inject = ["slots"];
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("sidebar.footer.action", () =>
        slots.register(
          {
            name: "sidebar.footer.action",
            id: "dsh-stock-panel",
            inject: () => ({
              analyze: async (input, opts) => {
                const r = await fetch("/api/stock/analyze", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ input, opts }),
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(j.error || "stock.analyze HTTP " + r.status);
                return j;
              },
            }),
          },
          StockButton,
        ),
      );
      function StockButton({ analyze, wide }) {
        const [open, setOpen] = React.useState(false);
        return jsxRuntime.jsxs(React.Fragment, {
          children: [
            jsxRuntime.jsxs("div", {
              style: { display: "flex", alignItems: "center", width: "100%" },
              children: [
                jsxRuntime.jsx("button", {
                  onClick: () => setOpen((v) => !v),
                  title: "股票分析",
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flex: 1,
                    padding: "8px 12px",
                    background: "none",
                    border: "none",
                    color: "#e6eaf5",
                    cursor: "pointer",
                    borderRadius: 8,
                    fontSize: 13,
                  },
                  onMouseEnter: (e) => {
                    e.currentTarget.style.background = "rgba(138,147,178,.12)";
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.background = "none";
                  },
                  children: [
                    jsxRuntime.jsx("span", { style: { fontSize: 15 }, children: "📈" }),
                    wide && jsxRuntime.jsx("span", { children: "股票分析" }),
                  ],
                }),
                jsxRuntime.jsx("button", {
                  onClick: () => window.open("http://127.0.0.1:8799/", "_blank"),
                  title: "在新标签页打开股票分析报告（输入代码生成）",
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 32,
                    height: 32,
                    marginRight: 6,
                    flex: "none",
                    background: "none",
                    border: "1px solid #2a3350",
                    color: "#8a93b2",
                    cursor: "pointer",
                    borderRadius: 8,
                    fontSize: 14,
                  },
                  onMouseEnter: (e) => {
                    e.currentTarget.style.color = "#3b82f6";
                    e.currentTarget.style.borderColor = "#3b82f6";
                  },
                  onMouseLeave: (e) => {
                    e.currentTarget.style.color = "#8a93b2";
                    e.currentTarget.style.borderColor = "#2a3350";
                  },
                  children: "↗",
                }),
              ],
            }),
            open && jsxRuntime.jsx(StockPanel, { analyze, onClose: () => setOpen(false) }),
          ],
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
