#!/usr/bin/env node
/**
 * sim-daily.mjs — 模拟交易每日流程
 * 1. 分析每只持仓 → 卖出/持有
 * 2. 持仓 < 3 时从候选池（screen 结果或自选）补仓
 * 3. 更新账户 + 每日快照
 * 4. 生成日报（markdown 摘要 + HTML 报告）
 *
 * 用法: node sim-daily.mjs [--out 日报目录] [--candidates "600519,000858,..."]
 */
import { loadAccount, saveAccount, analyzeStock, shouldSell, shouldBuy, executeBuy, executeSell, accountValue, fetchBenchmark, SIM_DIR, fmt, today } from "./sim.mjs";
import { run as screenRun } from "./screen.mjs";
import { fetchQuoteOne } from "./quotes.mjs";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { out: null, candidates: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--candidates") args.candidates = argv[++i];
    else if (argv[i] === "--force") args.force = true;
  }
  return args;
}

// 获取候选池：--candidates 优先，否则 screen 选股结果
async function getCandidates(acc, explicit) {
  if (explicit) {
    return explicit.split(",").map(s => s.trim()).filter(Boolean);
  }
  // 用成交额榜选股（不追高），取前 8 作为候选
  try {
    const out = await screenRun(["--strategy", "amount", "--top", "8", "--days", "90"]);
    return (out.picks || []).map(p => p.code);
  } catch (e) {
    console.warn("[sim] 选股失败，跳过补仓:", e.message);
    return [];
  }
}

export async function run(argv) {
  const args = parseArgs(argv);
  const acc = loadAccount();
  if (!acc) { console.error("账户未初始化，先运行: node sim.mjs init"); process.exit(1); }
  const date = today();
  if (acc.lastRunDate === date && !args.force) {
    console.log("今天已运行过（" + date + "），使用 --force 可盘中重跑（午盘/尾盘）。");
    return acc;
  }
  if (acc.lastRunDate === date && args.force) {
    console.log("⚠ 盘中重跑（--force）: " + date + "，将追加本时段分析快照。");
  }

  const actions = [];   // 今日操作记录
  const quotes = {};    // 代码 → 现价
  const soldCodes = new Set(); // 本run已卖出代码，禁止同run回补

  // ---------- 1. 分析持仓，决定卖出/持有 ----------
  for (const h of [...acc.holdings]) {
    try {
      const { res } = await analyzeStock(h.code);
      quotes[h.code] = res.quote;
      const sellReasons = shouldSell(h, res);
      if (sellReasons.length) {
        const reason = sellReasons.join("；");
        const r = executeSell(acc, h, res.quote.price, date, reason);
        soldCodes.add(h.code);
        actions.push({ type: "SELL", code: h.code, name: h.name, price: res.quote.price, shares: h.shares, pnl: r.pnl, pnlPct: r.pnlPct, reason });
        console.log("  🔴 卖出 " + h.name + "(" + h.code + ") " + fmt(res.quote.price) + " 盈亏 " + (r.pnl >= 0 ? "+" : "") + fmt(r.pnl) + " (" + (r.pnlPct >= 0 ? "+" : "") + fmt(r.pnlPct, 2) + "%) — " + reason);
      } else {
        actions.push({ type: "HOLD", code: h.code, name: h.name, price: res.quote.price, shares: h.shares, reason: "信号未触发卖出" });
        console.log("  🟡 持有 " + h.name + "(" + h.code + ") " + fmt(res.quote.price) + " 信号" + res.signals.score + "(" + res.signals.verdict + ")");
      }
    } catch (e) {
      console.warn("[sim] 分析持仓失败 " + h.code + ":", e.message);
      try { const q = await fetchQuoteOne(h.code); if (q) { quotes[h.code] = q; continue; } } catch (e2) { /* fallthrough */ }
      quotes[h.code] = { price: h.costPrice };
    }
  }

  // ---------- 2. 空位补仓 ----------
  const slots = acc.rules.maxHoldings - acc.holdings.length;
  if (slots > 0) {
    const candidates = await getCandidates(acc, args.candidates);
    console.log("  📋 空位 " + slots + " 个，候选 " + candidates.length + " 只");
    for (const code of candidates) {
      if (acc.holdings.length >= acc.rules.maxHoldings) break;
      if (acc.holdings.some(h => h.code === code)) continue;
      if (soldCodes.has(code)) { console.log("  ⚪ 跳过回补 " + code + "（本run已卖出）"); continue; }
      try {
        const { res } = await analyzeStock(code);
        quotes[code] = res.quote;
        const b = shouldBuy(res);
        if (b.ok) {
          const r = executeBuy(acc, { code, name: res.meta.name || code }, res, date);
          if (r.done) {
            actions.push({ type: "BUY", code, name: res.meta.name || code, price: r.price, shares: r.shares, reason: b.reasons.length ? "" : "信号通过", buyInfo: true });
            console.log("  🟢 买入 " + (res.meta.name || code) + "(" + code + ") " + fmt(r.price) + " × " + r.shares + "股 — 信号" + b.score + "(" + b.verdict + ") 位置" + b.pos);
          } else {
            console.log("  ⚪ 跳过买入 " + code + ": " + r.reason);
          }
        } else {
          console.log("  ⚪ 不买 " + code + ": " + b.reasons.slice(0, 2).join(", "));
        }
      } catch (e) {
        console.warn("[sim] 候选分析失败 " + code + ":", e.message);
      }
    }
  }

  // ---------- 3. 账户快照 ----------
  // 补充未获取到报价的持仓
  for (const h of acc.holdings) if (!quotes[h.code]) {
    try { const q = await fetchQuoteOne(h.code); if (q) quotes[h.code] = q; else quotes[h.code] = { price: h.costPrice }; } catch (e) { quotes[h.code] = { price: h.costPrice }; }
  }
  const { totalValue, holdingsValue, cash } = accountValue(acc, quotes);
  const totalPnl = totalValue - acc.capital;
  const totalPnlPct = totalPnl / acc.capital * 100;

  // 沪深300 基准：起始日=今日用当日涨跌，否则用累计
  const bench = await fetchBenchmark();
  let benchPct = null;
  const startIsToday = !acc.startDate || acc.startDate === (bench && bench.today ? bench.today.date : "") || (bench && bench.today && acc.startDate >= bench.today.date);
  if (startIsToday && bench && bench.today && typeof bench.today.pct === "number") {
    benchPct = bench.today.pct; // 起始日=今日：用当日指数涨跌对比
  } else if (bench && bench.history.length) {
    const startDate = acc.startDate;
    const startBar = bench.history.find(h => h.date >= startDate) || bench.history[0];
    const nowBar = bench.today;
    if (startBar && nowBar && startBar.close > 0) {
      benchPct = (nowBar.close - startBar.close) / startBar.close * 100;
    }
  }
  if (benchPct === null && bench && bench.today && typeof bench.today.pct === "number") benchPct = bench.today.pct; // 兜底：当日指数涨跌

  acc.daily.push({
    date,
    time: new Date().toTimeString().slice(0, 5),
    session: args.force ? "intraday" : "open",
    totalValue: Number(totalValue.toFixed(2)),
    cash: Number(cash.toFixed(2)),
    holdingsValue: Number(holdingsValue.toFixed(2)),
    pnl: Number(totalPnl.toFixed(2)),
    pnlPct: Number(totalPnlPct.toFixed(2)),
    benchPct: benchPct === null ? null : Number(benchPct.toFixed(2)),
    excessPct: benchPct === null ? null : Number((totalPnlPct - benchPct).toFixed(2)),
    actions: actions.map(a => ({ type: a.type, code: a.code, name: a.name, price: a.price, shares: a.shares, pnl: a.pnl, pnlPct: a.pnlPct, reason: a.reason })),
  });
  acc.lastRunDate = date;
  saveAccount(acc);

  // ---------- 4. 日报 ----------
  const report = buildReport(acc, actions, quotes);
  if (args.out) {
    const dir = args.out;
    fs.mkdirSync(dir, { recursive: true });
    const htmlPath = path.join(dir, date + "-sim-report.html");
    fs.writeFileSync(htmlPath, report.html, "utf8");
    const mdPath = path.join(dir, date + "-sim-report.md");
    fs.writeFileSync(mdPath, report.md, "utf8");
    console.log("\n📄 日报已保存: " + htmlPath);
    console.log("📄 Markdown: " + mdPath);
  } else {
    console.log("\n" + report.md);
  }
  return acc;
}

// ---------- 日报生成 ----------
function buildReport(acc, actions, quotes) {
  const date = today();
  const last = acc.daily[acc.daily.length - 1];
  const md = [
    "# 📊 模拟交易日报 " + date,
    "",
    "## 账户概览",
    "",
    "| 项目 | 数值 |",
    "|---|---|",
    "| 初始资金 | " + fmt(acc.capital, 0) + " 元 |",
    "| 当前总资产 | **" + fmt(last.totalValue, 0) + " 元** |",
    "| 累计盈亏 | **" + (last.pnl >= 0 ? "+" : "") + fmt(last.pnl, 0) + " 元（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）** |",
    "| 沪深300同期 | " + (last.benchPct === null || last.benchPct === undefined ? "—" : (last.benchPct >= 0 ? "+" : "") + fmt(last.benchPct, 2) + "%") + " |",
    "| **超额收益** | " + (last.excessPct === null || last.excessPct === undefined ? "—" : "**" + (last.excessPct >= 0 ? "+" : "") + fmt(last.excessPct, 2) + "%**") + " |",
    "| 现金 | " + fmt(last.cash, 0) + " 元 |",
    "| 持仓市值 | " + fmt(last.holdingsValue, 0) + " 元 |",
    "| 持仓数 | " + acc.holdings.length + "/" + acc.rules.maxHoldings + " |",
    "",
    "## 今日操作",
    "",
  ];
  const act = actions.length ? actions : [{ type: "NONE", name: "无操作", reason: "" }];
  for (const a of act) {
    if (a.type === "BUY") md.push("- 🟢 **买入** " + a.name + "(" + a.code + ") " + fmt(a.price) + " × " + a.shares + " 股");
    else if (a.type === "SELL") md.push("- 🔴 **卖出** " + a.name + "(" + a.code + ") " + fmt(a.price) + " × " + a.shares + " 股，盈亏 " + (a.pnl >= 0 ? "+" : "") + fmt(a.pnl) + "（" + (a.pnlPct >= 0 ? "+" : "") + fmt(a.pnlPct, 2) + "%）— " + a.reason);
    else if (a.type === "HOLD") md.push("- 🟡 **持有** " + a.name + "(" + a.code + ") " + fmt(a.price) + " — " + a.reason);
    else md.push("- ⚪ 今日无操作");
  }

  md.push("", "## 当前持仓", "", "| 股票 | 股数 | 成本 | 现价 | 市值 | 浮盈亏 |", "|---|---|---|---|---|---|");
  for (const h of acc.holdings) {
    const q = quotes[h.code] || { price: h.costPrice };
    const mv = q.price * h.shares;
    const pl = (q.price - h.costPrice) * h.shares;
    const plPct = (q.price - h.costPrice) / h.costPrice * 100;
    md.push("| " + h.name + "(" + h.code + ") | " + h.shares + " | " + fmt(h.costPrice) + " | " + fmt(q.price) + " | " + fmt(mv, 0) + " | " + (pl >= 0 ? "+" : "") + fmt(pl, 0) + "（" + (plPct >= 0 ? "+" : "") + fmt(plPct, 2) + "%） |");
  }
  if (!acc.holdings.length) md.push("（空仓）");

  md.push("", "## 净值曲线（最近10日）", "", "| 日期 | 总资产 | 组合盈亏% | 沪深300% | 超额% |", "|---|---|---|---|---|");
  const recent = acc.daily.slice(-10);
  for (const d of recent) {
    md.push("| " + d.date + " | " + fmt(d.totalValue, 0) + " | " + (d.pnlPct >= 0 ? "+" : "") + fmt(d.pnlPct, 2) + "% | " +
      (d.benchPct === null || d.benchPct === undefined ? "—" : (d.benchPct >= 0 ? "+" : "") + fmt(d.benchPct, 2) + "%") + " | " +
      (d.excessPct === null || d.excessPct === undefined ? "—" : (d.excessPct >= 0 ? "+" : "") + fmt(d.excessPct, 2) + "%") + " |");
  }

  md.push("", "## 交易规则（当前）", "");
  const rules = acc.rules;
  md.push("- 最多持仓 **" + rules.maxHoldings + " 只**，单只仓位 ≤ " + (rules.perPosition * 100) + "% 资金");
  md.push("- 买入：信号分 ≥ " + rules.buyScoreMin + " 或「买入」+ 位置非高位 + 增长 ≥ " + rules.buyGrowMin + " + 当日涨幅 < " + rules.buyDayPctMax + "%");
  md.push("- 卖出：信号分 ≤ " + rules.sellScoreMax + " | 卖出信号 ≥ " + rules.sellSignalMin + " | 硬止损 " + rules.stopLossPct + "%");
  md.push("", "> ⚠️ 模拟交易仅供参考，不构成投资建议。数据来自公开接口。", "");

  // HTML（简版）
  const rows = acc.holdings.map(h => {
    const q = quotes[h.code] || { price: h.costPrice };
    const pl = (q.price - h.costPrice) * h.shares;
    const plPct = (q.price - h.costPrice) / h.costPrice * 100;
    return "<tr><td>" + h.name + " (" + h.code + ")</td><td>" + h.shares + "</td><td>" + fmt(h.costPrice) + "</td><td>" + fmt(q.price) + "</td><td class='" + (pl >= 0 ? "up" : "down") + "'>" + (pl >= 0 ? "+" : "") + fmt(pl, 0) + " (" + (plPct >= 0 ? "+" : "") + fmt(plPct, 2) + "%)</td></tr>";
  }).join("");
  const actRows = act.map(a => {
    if (a.type === "BUY") return "<tr><td style='color:#f0483e'>🟢 买入</td><td>" + a.name + " (" + a.code + ")</td><td>" + fmt(a.price) + "</td><td>" + a.shares + "</td><td>-</td></tr>";
    if (a.type === "SELL") return "<tr><td style='color:#2ebd85'>🔴 卖出</td><td>" + a.name + " (" + a.code + ")</td><td>" + fmt(a.price) + "</td><td>" + a.shares + "</td><td>" + (a.pnl >= 0 ? "+" : "") + fmt(a.pnl) + " (" + (a.pnlPct >= 0 ? "+" : "") + fmt(a.pnlPct, 2) + "%)</td></tr>";
    if (a.type === "HOLD") return "<tr><td style='color:#f5b942'>🟡 持有</td><td>" + a.name + " (" + a.code + ")</td><td>" + fmt(a.price) + "</td><td>" + a.shares + "</td><td>-</td></tr>";
    return "<tr><td>⚪ 无操作</td><td colspan='4'>今日未触发交易</td></tr>";
  }).join("");
  const curveRows = recent.map(d => "<tr><td>" + d.date + "</td><td>" + fmt(d.totalValue, 0) + "</td><td class='" + (d.pnlPct >= 0 ? "up" : "down") + "'>" + (d.pnlPct >= 0 ? "+" : "") + fmt(d.pnlPct, 2) + "%</td></tr>").join("");

  const html = [
    "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>模拟交易日报 " + date + "</title><style>",
    "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:30px;line-height:1.6}",
    ".wrap{max-width:900px;margin:0 auto}",
    "h1{font-size:24px;margin-bottom:8px} h2{font-size:17px;color:#8a93b2;margin:22px 0 10px}",
    ".big{font-size:32px;font-weight:700} .up{color:#f0483e} .down{color:#2ebd85} .dim{color:#8a93b2}",
    "table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:8px}",
    "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
    "td{padding:10px;border-bottom:1px solid #232c47}",
    ".card{background:#121829;border:1px solid #232c47;border-radius:12px;padding:16px;margin-bottom:12px}",
    "</style></head><body><div class='wrap'>",
    "<h1>📊 模拟交易日报 " + date + "</h1>",
    "<div class='card'><div class='dim'>总资产</div><div class='big " + (last.pnl >= 0 ? "up" : "down") + "'>" + fmt(last.totalValue, 0) + " 元</div>",
    "<div class='dim'>累计盈亏 <span class='" + (last.pnl >= 0 ? "up" : "down") + "'>" + (last.pnl >= 0 ? "+" : "") + fmt(last.pnl, 0) + "（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）</span> · 现金 " + fmt(last.cash, 0) + " · 持仓 " + acc.holdings.length + "/" + acc.rules.maxHoldings + "</div></div>",
    "<h2>今日操作</h2><table><tr><th>方向</th><th>股票</th><th>价格</th><th>数量</th><th>盈亏</th></tr>" + actRows + "</table>",
    "<h2>当前持仓</h2><table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th></tr>" + rows + "</table>",
    "<h2>净值曲线（最近10日）</h2><table><tr><th>日期</th><th>总资产</th><th>盈亏%</th></tr>" + curveRows + "</table>",
    "<div class='dim' style='margin-top:24px'>⚠️ 模拟交易仅供参考，不构成投资建议。</div>",
    "</div></body></html>"
  ].join("");

  return { md: md.join("\n"), html };
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
