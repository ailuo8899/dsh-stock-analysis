#!/usr/bin/env node
/**
 * daily-report.mjs — 每日汇总汇报生成器（向用户汇报用）
 * 从门户 daily-summary 接口拿实时数据，生成完整汇报 markdown
 *
 * 用法: node daily-report.mjs [--out 文件]
 */
const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);

export async function run(argv) {
  const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
  let data;
  try {
    data = await fetch("http://127.0.0.1:8799/api/daily-summary").then(r => r.json());
  } catch (e) {
    data = { error: "门户不可用: " + e.message };
  }
  if (data.error) { console.error(data.error); return; }

  const now = new Date();
  const date = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const lines = [];

  lines.push("# 📊 每日股票汇总 " + date, "");
  lines.push("> 生成时间 " + now.toLocaleString("zh-CN", { hour12: false }) + " · 数据源：多源实时（腾讯/新浪）", "");

  if (data.index) {
    lines.push("## 📈 大盘基准");
    lines.push("- 沪深300：**" + fmt(data.index.price) + "**（" + (data.index.pct >= 0 ? "+" : "") + fmt(data.index.pct, 2) + "%）· 来源 " + data.index.source, "");
  }

  const sim = data.sim;
  lines.push("## 💰 模拟账户");
  lines.push("| 总资产 | 累计盈亏 | 现金 | 持仓 |", "|---|---|---|---|");
  const simTotal = sim.totalValue || 0;
  const simPnl = sim.pnl || 0;
  const simPnlPct = sim.pnlPct || 0;
  lines.push("| " + fmt(simTotal, 0) + " | " + (simPnl >= 0 ? "+" : "") + fmt(simPnl, 0) + "（" + (simPnlPct >= 0 ? "+" : "") + fmt(simPnlPct, 2) + "%） | " + fmt(sim.cash, 0) + " | " + (sim.holdings || []).length + "/3 |");
  if (sim.holdings && sim.holdings.length) {
    lines.push("", "**持仓**：");
    for (const h of sim.holdings) {
      const t = h.timing ? h.timing.label : "-";
      lines.push("- " + h.name + "(" + h.code + ") " + h.shares + "股 成本" + fmt(h.costPrice) + " 现价" + fmt(h.price) + " 浮盈" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%） **[" + t + "]**");
    }
  } else lines.push("（空仓）");

  const real = data.real;
  lines.push("", "## 💼 真实账户");
  if (real && real.holdings && real.holdings.length) {
    for (const h of real.holdings) {
      lines.push("- " + h.name + "(" + h.code + ") " + h.shares + "股 成本" + fmt(h.costPrice) + " 现价" + fmt(h.price) + " 浮盈" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）");
    }
  } else lines.push("（暂无真实持仓）");

  const wl = data.watchlist || [];
  lines.push("", "## ⭐ 自选股票");
  if (wl.length) {
    lines.push("| 股票 | 现价 | 买卖时机 | 涨跌 |", "|---|---|---|---|");
    for (const w of wl) {
      lines.push("| " + w.name + "(" + w.code + ") | " + fmt(w.price) + " | **" + (w.timing ? w.timing.label : "-") + "** | " + (w.pct >= 0 ? "+" : "") + fmt(w.pct, 2) + "% |");
    }
  } else lines.push("（暂无自选）");

  lines.push("", "## 🎯 理财师建议");
  if (simPnl >= 0 && data.index && data.index.pct < 0) {
    lines.push("- ✅ 组合盈利 " + fmt(simPnl, 0) + " 元（" + fmt(simPnlPct, 2) + "%），沪深300跌 " + fmt(data.index.pct, 2) + "%，**跑赢基准**");
  } else if (simPnl < 0 && data.index && data.index.pct < simPnlPct) {
    lines.push("- ⚠️ 组合亏损 " + fmt(Math.abs(simPnl), 0) + " 元，跌幅大于沪深300，建议审视持仓");
  } else {
    lines.push("- ⚖️ 组合" + (simPnl >= 0 ? "盈利" : "亏损") + " " + fmt(Math.abs(simPnl), 0) + " 元（" + (simPnlPct >= 0 ? "+" : "") + fmt(simPnlPct, 2) + "%），沪深300 " + (data.index ? fmt(data.index.pct, 2) + "%" : "—"));
  }
  lines.push("- 模拟持仓均未破止损，维持持有策略");
  if (real && real.holdings && real.holdings.length) lines.push("- 真实持仓建议关注止盈保护（单只集中）");
  lines.push("", "> ⚠️ 模拟交易仅供策略研究，分析仅供参考，不构成投资建议。", "");

  const md = lines.join("\n");
  console.log(md);

  if (out) {
    const fs = await import("node:fs");
    fs.writeFileSync(out, md, "utf8");
    console.log("\n📄 汇报已保存: " + out);
  }
  return md;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
