#!/usr/bin/env node
/**
 * portal-server.mjs — 股票分析平台门户服务（产品级首页）
 * 替代静态文件服务：默认首页 = 产品门户（导航 + 模拟账户 + 真实账户 + 自选 + 分析）
 * 用法: node portal-server.mjs [--port 8799]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = process.argv.includes("--port") ? parseInt(process.argv[process.argv.indexOf("--port") + 1]) : 8799;
const DSH_API = "http://127.0.0.1:3080";
import { run as localFetchRun } from "./fetch.mjs";
import { run as localAnalyzeRun } from "./analyze.mjs";
import { advisorSim, advisorReal } from "./advisor.mjs";
import { fetchQuotes } from "./quotes.mjs";
import { fetchQuoteOne } from "./quotes.mjs";
import { fetchIndex } from "./quotes.mjs";

// 产品门户 HTML（单页应用）
function portalHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>📈 股票分析平台</title>
<style>
:root{--bg:#0b0f1d;--panel:#121829;--panel2:#0e1424;--line:#232c47;--txt:#e6eaf5;--dim:#8a93b2;--up:#f0483e;--down:#2ebd85;--gold:#f5b942;--blue:#3b82f6;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}
.topbar{display:flex;align-items:center;gap:18px;padding:14px 24px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
.topbar .logo{font-size:18px;font-weight:700}
.topbar nav{display:flex;gap:4px;flex:1}
.topbar nav button{padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer;background:none;border:none;color:var(--dim);border-radius:8px}
.topbar nav button:hover{color:var(--txt);background:var(--panel2)}
.topbar nav button.active{color:var(--blue);background:rgba(59,130,246,.12)}
.wrap{max-width:1100px;margin:0 auto;padding:24px}
.view{display:none} .view.active{display:block}
h1{font-size:22px;margin-bottom:6px} .sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.card .k{color:var(--dim);font-size:12px;margin-bottom:6px} .card .v{font-size:22px;font-weight:700}
.up{color:var(--up)} .down{color:var(--down)}
table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--panel);border-radius:12px;overflow:hidden}
th{color:var(--dim);font-size:12px;text-align:left;padding:10px 14px;background:var(--panel2);border-bottom:1px solid var(--line)}
td{padding:12px 14px;border-bottom:1px solid var(--line)}
.badge{display:inline-block;padding:2px 10px;border-radius:6px;font-size:11.5px;font-weight:600}
.b-buy{background:rgba(240,72,62,.15);color:var(--up)} .b-sell{background:rgba(46,189,133,.15);color:var(--down)}
.b-watch{background:rgba(245,185,66,.14);color:var(--gold)} .b-caution{background:rgba(59,130,246,.14);color:var(--blue)} .b-neutral{background:rgba(138,147,178,.14);color:var(--dim)}
.search-row{display:flex;gap:10px;margin-bottom:20px}
.search-row input{flex:1;max-width:400px;padding:12px 16px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--txt);font-size:15px;outline:none}
.search-row input:focus{border-color:var(--blue)}
.search-row button{padding:12px 24px;border:none;border-radius:8px;background:var(--blue);color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.loading{color:var(--dim);font-size:13px;padding:20px;text-align:center}
.err{background:rgba(240,72,62,.1);border:1px solid rgba(240,72,62,.4);color:var(--up);padding:12px;border-radius:8px;margin-bottom:12px;font-size:13px}
.lcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:16px}
.lcard{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;cursor:pointer;transition:border-color .15s,transform .15s}
.lcard:hover{border-color:var(--blue);transform:translateY(-2px)}
.lcard .lc-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.lcard .lc-name{font-size:14px;font-weight:700}
.lcard .lc-code{color:var(--dim);font-size:11px;margin-bottom:6px}
.lcard .lc-ind{color:var(--dim);font-size:11px;background:var(--panel2);padding:2px 8px;border-radius:6px}
.lcard .lc-price{font-size:16px;font-weight:700;margin-bottom:2px}
.lcard .lc-pct{font-size:12px;margin-bottom:8px}
.lcard .lc-row{display:flex;justify-content:space-between;font-size:11.5px;color:var(--dim);margin-bottom:4px}
.lcard .lc-row b{color:var(--txt)}
.lcard .lc-signal{margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.empty{color:var(--dim);font-size:13px;padding:20px;text-align:center}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">📈 股票分析平台</div>
  <nav>
    <button data-view="analyze" class="active">🔍 分析</button>
    <button data-view="sim">💰 模拟账户</button>
    <button data-view="real">💼 真实账户</button>
    <button data-view="watchlist">⭐ 自选股</button>
    <button data-view="daily">📊 每日汇总</button>
  </nav>
</div>
<div class="wrap">
  <div class="view active" id="view-analyze">
    <h1>🔍 股票分析</h1>
    <div class="sub">输入代码或名称，实时生成完整分析（信号/位置/情绪/增长/支撑压力）</div>
    <div class="search-row">
      <input id="q" placeholder="如 600519 / 贵州茅台 / 002594" onkeydown="if(event.key==='Enter')doAnalyze()"/>
      <button onclick="doAnalyze()">分析</button>
    </div>
    <div id="analyzeResult"></div>
    <div style="margin-top:28px;display:flex;align-items:center;gap:8px">
      <h2 style="font-size:16px;color:var(--gold);margin:0">🏆 行业龙头速览</h2>
      <span style="color:var(--dim);font-size:12px">点击卡片查看详细分析</span>
    </div>
    <div id="leadersCards" class="lcards"><div class="loading">龙头分析加载中…</div></div>
  </div>
  <div class="view" id="view-sim"><div class="loading" id="simLoading">加载中…</div><div id="simContent"></div></div>
  <div class="view" id="view-real"><div class="loading" id="realLoading">加载中…</div><div id="realContent"></div></div>
  <div class="view" id="view-watchlist"><div class="loading" id="wlLoading">加载中…</div><div id="wlContent"></div></div>
  <div class="view" id="view-daily"><div class="loading" id="dailyLoading">加载中…</div><div id="dailyContent"></div></div>
</div>
<script>
const fmt=(v,d=2)=>v===null||v===undefined||isNaN(v)?"-":Number(v).toFixed(d);
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const DSH="";
const clsMap={buy:"b-buy",sell:"b-sell",watch:"b-watch",caution:"b-caution",neutral:"b-neutral"};

document.querySelectorAll(".topbar nav button").forEach(b=>{
  b.addEventListener("click",()=>{
    document.querySelectorAll(".topbar nav button").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    b.classList.add("active");
    const v=b.dataset.view;
    document.getElementById("view-"+v).classList.add("active");
    if(v==="sim")loadSim(); if(v==="real")loadReal(); if(v==="watchlist")loadWatchlist(); if(v==="daily")loadDaily();
});
loadLeadersCards();
  });
});

function timing(res){
  const s=res.signals,p=res.positionAnalysis,g=res.growth,q=res.quote;
  if(s.verdict==="买入"&&p&&p.buyScore>=40&&g&&g.score>=30&&q.pct<5)return{label:"可买入",cls:"buy"};
  if(p&&p.sellScore>=55)return{label:"注意止盈",cls:"sell"};
  if(s.verdict==="买入"||s.verdict==="关注")return{label:"可关注",cls:"watch"};
  if(s.verdict==="回避"||s.verdict==="谨慎")return{label:"回避/谨慎",cls:"caution"};
  return{label:"观望",cls:"neutral"};
}

// 点击股票 → 切到分析 tab 并自动分析
// 龙头股票卡片（简洁分析报告）
async function loadLeadersCards(){
  const el=document.getElementById("leadersCards");
  try{
    const j=await fetch('/api/leaders-cards').then(r=>r.json());
    if(!j.results||!j.results.length){el.innerHTML='<div class="empty">龙头数据暂不可用（可能限流）</div>';return;}
    const cards=j.results.map(c=>{
      const t=c.timing||{label:'观望',cls:'neutral'};
      const sup=(c.supports||[]).slice(-2).join("/")||"-";
      const res=(c.resistances||[]).slice(0,2).join("/")||"-";
      return '<div class="lcard" onclick="openAnalyze(''+c.code+'')" title="点击查看 '+esc(c.name)+' 详细分析">'+
        '<div class="lc-head"><span class="lc-name">'+esc(c.name)+'</span><span class="lc-ind">'+esc(c.industry||'')+'</span></div>'+
        '<div class="lc-code">'+c.code+'</div>'+
        '<div class="lc-price">'+fmt(c.price)+' <span class="lc-pct '+(c.pct>=0?'up':'down')+'">'+(c.pct>=0?'+':'')+fmt(c.pct,2)+'%</span></div>'+
        '<div class="lc-row"><span>信号</span><b>'+esc(c.verdict)+' '+c.score+'</b></div>'+
        '<div class="lc-row"><span>位置</span><b>'+esc(c.zone)+'</b></div>'+
        '<div class="lc-row"><span>情绪/增长</span><b>'+esc(c.sentiment)+' / '+esc(c.growth)+'</b></div>'+
        '<div class="lc-row"><span>支撑</span><b style="color:var(--down)">'+sup+'</b></div>'+
        '<div class="lc-row"><span>压力</span><b style="color:var(--up)">'+res+'</b></div>'+
        '<div class="lc-signal"><span class="badge '+clsMap[t.cls]+'">'+esc(t.label)+'</span></div>'+
        '</div>';
    }).join('');
    el.innerHTML=cards+(j.cached?'<div style="grid-column:1/-1;color:var(--dim);font-size:11px">已缓存 · 60秒自动刷新</div>':'');
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}

function openAnalyze(code){
  document.querySelectorAll(".topbar nav button").forEach(function(x){x.classList.remove("active");});
  document.querySelectorAll(".view").forEach(function(v){v.classList.remove("active");});
  var b=document.querySelector('.topbar nav button[data-view="analyze"]');
  if(b)b.classList.add("active");
  var vv=document.getElementById("view-analyze");
  if(vv)vv.classList.add("active");
  var q=document.getElementById("q");
  if(q)q.value=code;
  doAnalyze();
}

async function doAnalyze(){
  const v=document.getElementById("q").value.trim();
  if(!v)return;
  const el=document.getElementById("analyzeResult");
  el.innerHTML='<div class="loading">分析中…</div>';
  try{
    const r=await fetch('/api/analyze',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:v})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||"分析失败");
    const q=j.quote,s=j.signals,p=j.positionAnalysis,se=j.sentiment,g=j.growth,t=timing(j);
    const factors=(s.factors||[]).filter(f=>f.score!==0).map(f=>f.name+"("+(f.score>0?"+":"")+f.score+")").join(" ");
    el.innerHTML='<div class="cards">'+
      '<div class="card"><div class="k">'+esc(j.meta.name)+' '+j.meta.code+'</div><div class="v">'+fmt(q.price)+' <span class="'+(q.pct>=0?"up":"down")+'" style="font-size:14px">'+(q.pct>=0?"+":"")+fmt(q.pct,2)+'%</span></div></div>'+
      '<div class="card"><div class="k">买卖时机</div><div class="v"><span class="badge '+clsMap[t.cls]+'">'+t.label+'</span></div></div>'+
      '<div class="card"><div class="k">信号</div><div class="v">'+esc(s.verdict)+' '+s.score+'</div></div>'+
      '<div class="card"><div class="k">位置</div><div class="v">'+esc(p.zone)+' <span style="font-size:12px;color:var(--dim)">买'+p.buyScore+'/卖'+p.sellScore+'</span></div></div></div>'+
      '<table><tr><th>情绪</th><th>增长</th><th>支撑</th><th>压力</th><th>关键因子</th></tr>'+
      '<tr><td>'+esc(se.label)+' '+fmt(se.score)+'</td><td>'+esc(g.label)+' '+g.score+'</td><td style="color:var(--down)">'+(j.levels.supports||[]).map(x=>fmt(x.price)).join(" / ")+'</td><td style="color:var(--up)">'+(j.levels.resistances||[]).map(x=>fmt(x.price)).join(" / ")+'</td><td style="font-size:12px">'+esc(factors)+'</td></tr></table>';
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}

async function loadSim(){
  const el=document.getElementById("simContent");
  el.innerHTML='<div class="loading">加载中…</div>';
  try{
    const j=await fetch('/api/account/detail').then(r=>r.json());
    const acc={cash:j.sim.cash, capital:j.sim.capital, holdings:j.sim.items, daily:[{totalValue:j.sim.totalValue}], rules:{maxHoldings:3}};
    if(!acc){el.innerHTML='<div class="empty">模拟账户未初始化</div>';return;}
    const last=acc.daily&&acc.daily.length?acc.daily[acc.daily.length-1]:null;
    let advice='';
    try{
      const ar=await fetch('/api/advisor/sim').then(r=>r.json());
      advice='<div style="background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:12px;padding:14px;margin-bottom:16px">'
        +'<div style="font-size:13px;font-weight:700;color:#3b82f6;margin-bottom:6px">🧑‍💼 理财师建议</div>'
        +'<div style="font-size:13px;margin-bottom:4px"><b>风险等级：</b>'+esc(ar.riskLevel||"-")+' ｜ <b>仓位：</b>'+esc(ar.positionRisk.level)+' '+ar.positionRisk.pct+'%</div>'
        +'<div style="font-size:12px;color:var(--dim);margin-bottom:4px">'+esc(ar.concentration.note)+'</div>'
        +'<div style="font-size:13px">'+esc(ar.overall)+'</div></div>';
    }catch(e){}
    const simTotal2=j.sim.totalValue>0?j.sim.totalValue:1;
    const rows=(acc.holdings||[]).map(h=>{
      const pl=(h.pl||0);
      const plPct=h.plPct||0;
      const todayPl=h.todayPl||0;
      const todayPlPct=h.todayPlPct||0;
      const sharePct=h.mv&&simTotal2>0?(h.mv/simTotal2*100):0;
      return '<tr style="cursor:pointer" onclick="openAnalyze(\''+h.code+'\')"><td><b>'+esc(h.name)+'</b><br><span style="color:var(--dim);font-size:11px">'+h.code+'</span></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(h.price)+'</td>'
        +'<td style="color:'+(pl>=0?"var(--up)":"var(--down)")+'">'+(pl>=0?"+":"")+fmt(pl,0)+'<br><span style="font-size:11px">'+(plPct>=0?"+":"")+fmt(plPct,2)+'%</span></td>'
        +'<td style="color:'+(todayPl>=0?"var(--up)":"var(--down)")+'">'+(todayPl>=0?"+":"")+fmt(todayPl,0)+'<br><span style="font-size:11px">'+(todayPlPct>=0?"+":"")+fmt(todayPlPct,2)+'%</span></td>'
        +'<td style="font-size:12px">'+fmt(sharePct,1)+'%</td>'
        +'<td style="color:var(--down);font-size:12px">'+(h.stopLoss?fmt(h.stopLoss):"-")+'</td>'
        +'<td style="color:var(--up);font-size:12px">'+(h.takeProfit?fmt(h.takeProfit):"-")+'</td>'
        +'<td style="font-size:12px">'+esc(h.verdict||"-")+' '+fmt(h.score)+'</td>'+'<td style="font-size:11px;color:var(--dim)">'+(h.source||'-')+'</td></tr>';
    }).join("");
    el.innerHTML=advice
      +'<div class="cards">'
      +'<div class="card"><div class="k">总资产</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?fmt(last.totalValue,0):"-")+'</div></div>'
      +'<div class="card"><div class="k">累计盈亏</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?(last.pnl>=0?"+":"")+fmt(last.pnl,0)+"（"+(last.pnlPct>=0?"+":"")+fmt(last.pnlPct,2)+"%）":"-")+'</div></div>'
      +'<div class="card"><div class="k">现金</div><div class="v">'+fmt(acc.cash,0)+'</div></div>'
      +'<div class="card"><div class="k">持仓数</div><div class="v">'+(acc.holdings||[]).length+'/'+(acc.rules?acc.rules.maxHoldings:3)+'</div></div></div>'
      +'<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>持仓盈亏</th><th>今日盈亏</th><th>占比</th><th>止损</th><th>止盈</th><th>信号</th><th>来源</th></tr>'+(rows||'<tr><td colspan="8" class="empty">空仓</td></tr>')+'</table>';
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}

async function loadReal(){
  const el=document.getElementById("realContent");
  el.innerHTML='<div class="loading">加载中…</div>';
  try{
    const j=await fetch(DSH+"/api/stock/accounts").then(r=>r.json());
    const acc=j.real;
    if(!acc||!(acc.holdings||[]).length){el.innerHTML='<div class="empty">暂无真实持仓</div>';return;}
    const last=acc.daily&&acc.daily.length?acc.daily[acc.daily.length-1]:null;
    let advice='';
    try{
      const ar=await fetch('/api/advisor/real').then(r=>r.json());
      advice='<div style="background:rgba(46,189,133,.08);border:1px solid rgba(46,189,133,.3);border-radius:12px;padding:14px;margin-bottom:16px">'
        +'<div style="font-size:13px;font-weight:700;color:#2ebd85;margin-bottom:6px">🧑‍💼 理财师建议</div>'
        +'<div style="font-size:13px;margin-bottom:4px"><b>风险等级：</b>'+esc(ar.riskLevel||"-")+'</div>'
        +'<div style="font-size:13px">'+esc(ar.overall)+'</div></div>';
    }catch(e){}
    const rows=(acc.holdings||[]).map(h=>{
      return '<tr style="cursor:pointer" onclick="openAnalyze(\''+h.code+'\')"><td><b>'+esc(h.name)+'</b><br><span style="color:var(--dim);font-size:11px">'+h.code+'</span></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+(h.buyDate||"-")+'</td></tr>';
    }).join("");
    el.innerHTML=advice
      +'<div class="cards">'
      +'<div class="card"><div class="k">持仓市值</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?fmt(last.holdingsValue,0):"-")+'</div></div>'
      +'<div class="card"><div class="k">浮动盈亏</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?(last.pnl>=0?"+":"")+fmt(last.pnl,0)+"（"+(last.pnlPct>=0?"+":"")+fmt(last.pnlPct,2)+"%）":"-")+'</div></div>'
      +'<div class="card"><div class="k">持仓成本</div><div class="v">'+(last?fmt(last.costValue,0):"-")+'</div></div>'
      +'<div class="card"><div class="k">沪深300</div><div class="v">'+(last&&last.benchPct!=null?(last.benchPct>=0?"+":"")+fmt(last.benchPct,2)+"%":"—")+'</div></div></div>'
      +'<table><tr><th>股票</th><th>股数</th><th>成本</th><th>买入日</th></tr>'+(rows||'<tr><td colspan="4" class="empty">暂无持仓</td></tr>')+'</table>';
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}

async function loadWatchlist(){
  const el=document.getElementById('wlContent');
  el.innerHTML='<div class="loading">加载中…</div>';
  try{
    const j=await fetch('/api/watchlist-analysis').then(r=>r.json());
    if(!j.results){el.innerHTML='<div class="empty">'+(j.error||'暂无数据')+'</div>';return;}
    const rows=j.results.map(w=>{const t=w.timing||{label:'观望',cls:'neutral'};return '<tr style="cursor:pointer" onclick="openAnalyze(\''+w.code+'\')"><td><b>'+esc(w.name)+'</b><br><span style="color:var(--dim);font-size:11px">'+w.code+'</span></td><td>'+fmt(w.price)+'<br><span style="color:'+(w.pct>=0?'var(--up)':'var(--down)')+';font-size:11px">'+(w.pct>=0?'+':'')+fmt(w.pct,2)+'%</span></td><td><span class="badge '+clsMap[t.cls]+'">'+t.label+'</span></td><td>'+esc(w.verdict)+' '+w.score+'</td><td>'+esc(w.zone)+'</td><td>'+esc(w.sentiment)+'</td><td>'+esc(w.growth)+'</td><td style="font-size:12px;color:var(--dim)">'+esc(w.comment||'')+'</td></tr>';}).join('');
    el.innerHTML='<table><tr><th>股票</th><th>现价</th><th>买卖时机</th><th>信号</th><th>位置</th><th>情绪</th><th>增长</th><th>理财师点评</th></tr>'+rows+'</table>';
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}


async function loadDaily(){
  const el=document.getElementById("dailyContent");
  el.innerHTML='<div class="loading">汇总加载中…（含模拟/真实/自选实时分析）</div>';
  try{
    const j=await fetch('/api/daily-summary').then(r=>r.json());
    if(j.error){el.innerHTML='<div class="err">'+esc(j.error)+'</div>';return;}
    const sim=j.sim, real=j.real, wl=j.watchlist;
    let html='';
    if(j.index){html+='<div style="background:rgba(245,185,66,.08);border:1px solid rgba(245,185,66,.3);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px">📊 沪深300：<b>'+fmt(j.index.price)+'</b>（'+(j.index.pct>=0?'+':'')+fmt(j.index.pct,2)+'%）· 来源:'+esc(j.index.source)+'</div>';}
    html+='<h2 style="font-size:16px;color:#3b82f6;margin:16px 0 8px">💰 模拟账户</h2>';
    if(sim){
      const last=sim.last;
      html+='<div class="cards">'+
        '<div class="card"><div class="k">总资产</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?fmt(last.totalValue,0):"-")+'</div></div>'+
        '<div class="card"><div class="k">累计盈亏</div><div class="v '+(last&&last.pnl>=0?"up":"down")+'">'+(last?(last.pnl>=0?"+":"")+fmt(last.pnl,0)+"（"+(last.pnlPct>=0?"+":"")+fmt(last.pnlPct,2)+"%）":"-")+'</div></div>'+
        '<div class="card"><div class="k">沪深300</div><div class="v">'+(last&&last.benchPct!=null?(last.benchPct>=0?"+":"")+fmt(last.benchPct,2)+"%":"—")+'</div></div></div>';
      if(sim.holdings&&sim.holdings.length){
        html+='<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th><th>时机</th></tr>';
        for(const h of sim.holdings){
          html+='<tr style="cursor:pointer" onclick="openAnalyze(\''+h.code+'\')"><td><b>'+esc(h.name)+'</b> '+h.code+'</td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(h.price)+'</td><td style="color:'+(h.pl>=0?"var(--up)":"var(--down)")+'">'+(h.pl>=0?"+":"")+fmt(h.pl,0)+'（'+(h.plPct>=0?"+":"")+fmt(h.plPct,2)+'%）</td><td>'+(h.timing?esc(h.timing.label):"-")+'</td></tr>';
        }
        html+='</table>';
      } else html+='<div class="empty">空仓</div>';
    } else html+='<div class="empty">模拟账户未初始化</div>';
    html+='<h2 style="font-size:16px;color:#2ebd85;margin:16px 0 8px">💼 真实账户</h2>';
    if(real&&real.holdings&&real.holdings.length){
      html+='<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th><th>时机</th></tr>';
      for(const h of real.holdings){
        html+='<tr style="cursor:pointer" onclick="openAnalyze(\''+h.code+'\')"><td><b>'+esc(h.name)+'</b> '+h.code+'</td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(h.price)+'</td><td style="color:'+(h.pl>=0?"var(--up)":"var(--down)")+'">'+(h.pl>=0?"+":"")+fmt(h.pl,0)+'（'+(h.plPct>=0?"+":"")+fmt(h.plPct,2)+'%）</td><td>'+(h.timing?esc(h.timing.label):"-")+'</td></tr>';
      }
      html+='</table>';
    } else html+='<div class="empty">暂无真实持仓</div>';
    html+='<h2 style="font-size:16px;color:#f5b942;margin:16px 0 8px">⭐ 自选股票</h2>';
    if(wl&&wl.length){
      html+='<table><tr><th>股票</th><th>现价</th><th>买卖时机</th><th>信号</th><th>位置</th><th>情绪</th><th>增长</th></tr>';
      for(const w of wl){
        html+='<tr style="cursor:pointer" onclick="openAnalyze(\''+w.code+'\')"><td><b>'+esc(w.name)+'</b> '+w.code+'</td><td>'+fmt(w.price)+'</td><td><span class="badge '+(w.timing?clsMap[w.timing.cls]||"b-neutral":"b-neutral")+'">'+(w.timing?esc(w.timing.label):"-")+'</span></td><td>'+esc(w.verdict)+' '+w.score+'</td><td>'+esc(w.zone)+'</td><td>'+esc(w.sentiment)+'</td><td>'+esc(w.growth)+'</td></tr>';
      }
      html+='</table>';
    } else html+='<div class="empty">暂无自选</div>';
    el.innerHTML=html;
  }catch(e){el.innerHTML='<div class="err">'+esc(e.message)+'</div>';}
}

</script>
</body>
</html>`;
}

let leadersCache = null; // 龙头卡片缓存

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(portalHTML());
    return;
  }
  // 真实账户理财建议
  if (url.pathname === '/api/advisor/real') {
    try {
      const a = advisorReal([]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(a));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 每日汇总（三部分，实时组合）
  if (url.pathname === '/api/daily-summary') {
    try {
      const fsx = await import('node:fs');
      const osx = await import('node:os');
      const pathx = await import('node:path');
      const dir = pathx.join(process.env.DSH_HOME || (osx.homedir() + '/.dsh'), 'storages', 'stock-sim');
      const readJson = (f) => { try { return JSON.parse(fsx.readFileSync(pathx.join(dir, f), 'utf8')); } catch (e) { return null; } };
      const sim = readJson('account.json');
      const real = readJson('real-account.json');
      const simCodes = (sim && sim.holdings || []).map(h => h.code);
      const simQ = simCodes.length ? await fetchQuotes(simCodes) : {};
      const simHoldings = (sim && sim.holdings || []).map(h => {
        const q = simQ[String(h.code).replace(/^(sh|sz)/, '')];
        const price = q ? q.price : h.costPrice;
        const pl = (price - h.costPrice) * h.shares;
        const plPct = h.costPrice > 0 ? (price - h.costPrice) / h.costPrice * 100 : 0;
        let label = '持有', cls = 'neutral';
        if (q && q.pct >= 5) { label = '注意止盈'; cls = 'sell'; }
        else if (q && q.pct <= -3) { label = '观察'; cls = 'watch'; }
        return { code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice, price, pl, plPct, timing: { label, cls } };
      });
      const simMv = simHoldings.reduce((s2, h) => s2 + h.price * h.shares, 0);
      const simTotal = (sim ? sim.cash : 0) + simMv;
      const simPnl = simTotal - (sim ? sim.capital : simTotal);
      const simPnlPct = sim && sim.capital > 0 ? simPnl / sim.capital * 100 : 0;
      const simLast = sim && sim.daily && sim.daily.length ? sim.daily[sim.daily.length - 1] : null;
      let hs300 = null;
      try {
        const idx = await fetchIndex('000300');
        if (idx) hs300 = { price: idx.price, pct: idx.pct, prevClose: idx.prevClose, source: idx.source };
      } catch (e) {}
      const realCodes = (real && real.holdings || []).map(h => h.code);
      const realQ = realCodes.length ? await fetchQuotes(realCodes) : {};
      const realHoldings = (real && real.holdings || []).map(h => {
        const q = realQ[String(h.code).replace(/^(sh|sz)/, '')];
        const price = q ? q.price : h.costPrice;
        const pl = (price - h.costPrice) * h.shares;
        const plPct = h.costPrice > 0 ? (price - h.costPrice) / h.costPrice * 100 : 0;
        return { code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice, price, pl, plPct };
      });
      let watchlist = [];
      try {
        const wlFile = pathx.join(dir, '..', 'stock-watchlist.json');
        const wlRaw = fsx.existsSync(wlFile) ? JSON.parse(fsx.readFileSync(wlFile, 'utf8')) : [];
        const codes = (wlRaw || []).map(it => it.code);
        const wQ = codes.length ? await fetchQuotes(codes) : {};
        // 完整五维分析（东财K线 → 腾讯/新浪兜底），失败时退回涨跌幅规则
        const wlAnalyzeOne = async (it) => {
          try {
            const tmp = '/tmp/portal-sum-' + it.code + '-' + Date.now() + '.json';
            await localFetchRun([it.code, '--days', '90', '--out', tmp]);
            const a = await localAnalyzeRun([tmp]);
            const s = a.signals, p = a.positionAnalysis, se = a.sentiment, g = a.growth, q = a.quote;
            let label = '观望', cls = 'neutral';
            if (s.verdict === '买入' && p && p.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) { label = '可买入'; cls = 'buy'; }
            else if (p && p.sellScore >= 55) { label = '注意止盈'; cls = 'sell'; }
            else if (s.verdict === '买入' || s.verdict === '关注') { label = '可关注'; cls = 'watch'; }
            else if (s.verdict === '回避' || s.verdict === '谨慎') { label = '回避/谨慎'; cls = 'caution'; }
            return { code: it.code, name: a.meta.name, industry: it.industry, price: q.price, pct: q.pct, timing: { label, cls }, verdict: s.verdict, score: s.score, zone: p.zone, sentiment: se.label, growth: g.label, supports: (a.levels.supports || []).map(x => x.price), resistances: (a.levels.resistances || []).map(x => x.price) };
          } catch (e) {
            const q = wQ[String(it.code).replace(/^(sh|sz)/, '')];
            if (!q) return null;
            let label = '观望', cls = 'neutral';
            if (q.pct >= 5) { label = '追高风险'; cls = 'caution'; }
            else if (q.pct >= 2) { label = '可关注'; cls = 'watch'; }
            else if (q.pct <= -3) { label = '回调关注'; cls = 'watch'; }
            return { code: it.code, name: q.name, industry: it.industry, price: q.price, pct: q.pct, timing: { label, cls }, verdict: '-', score: 0, zone: '-', sentiment: '-', growth: '-' };
          }
        };
        const wlResults = await Promise.all((wlRaw || []).map(wlAnalyzeOne));
        watchlist = wlResults.filter(Boolean);
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        sim: { capital: sim ? sim.capital : 0, cash: sim ? sim.cash : 0, holdings: simHoldings, last: simLast, totalValue: simTotal, pnl: simPnl, pnlPct: simPnlPct },
        real: { holdings: realHoldings },
        watchlist,
        index: hs300
      }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 账户明细（成本/现价/持仓盈亏/今日盈亏/持仓占比）
  if (url.pathname === '/api/account/detail') {
    try {
      const fsx = await import('node:fs');
      const osx = await import('node:os');
      const pathx = await import('node:path');
      const dir = pathx.join(process.env.DSH_HOME || (osx.homedir() + '/.dsh'), 'storages', 'stock-sim');
      const readJson = (f) => { try { return JSON.parse(fsx.readFileSync(pathx.join(dir, f), 'utf8')); } catch (e) { return null; } };
      const sim = readJson('account.json');
      const real = readJson('real-account.json');
      const detail = async (holdings) => {
        const out = [];
        let totalValue = 0;
        const codes = (holdings || []).map(h => h.code);
        const quotes = codes.length ? await fetchQuotes(codes) : {};
        for (const h of holdings || []) {
          let price = h.costPrice, prevClose = null, verdict = '-', score = 0, zone = '-';
          const q = quotes[String(h.code).replace(/^(sh|sz)/, '')];
          if (q) {
            price = q.price;
            prevClose = q.prevClose;
          } else {
            try {
              const cached = '/tmp/an-' + h.code + '.json';
              if (fsx.existsSync(cached)) {
                const res = JSON.parse(fsx.readFileSync(cached, 'utf8'));
                price = res.quote.price;
                prevClose = res.quote.prevClose;
                verdict = res.signals.verdict;
                score = res.signals.score;
                zone = res.positionAnalysis.zone;
              }
            } catch (e) {}
          }
          const mv = price * h.shares;
          const pl = (price - h.costPrice) * h.shares;
          const plPct = h.costPrice > 0 ? (price - h.costPrice) / h.costPrice * 100 : 0;
          const todayPl = prevClose ? (price - prevClose) * h.shares : 0;
          const todayPlPct = prevClose ? (price - prevClose) / prevClose * 100 : 0;
          totalValue += mv;
          out.push({ code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice, price, prevClose, mv, pl, plPct, todayPl, todayPlPct, stopLoss: h.stopLoss, takeProfit: h.takeProfit, verdict, score, zone, source: q ? q.source : (prevClose ? 'cache' : 'cost') });
        }
        return { items: out, totalValue };
      };
      const simDetail = await detail(sim && sim.holdings);
      const realDetail = await detail(real && real.holdings);
      const simTotal = (sim ? sim.cash : 0) + simDetail.totalValue;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        sim: { cash: sim ? sim.cash : 0, totalValue: simTotal, items: simDetail.items, capital: sim ? sim.capital : 0 },
        real: { items: realDetail.items, totalValue: realDetail.totalValue }
      }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 理财师建议
  if (url.pathname === '/api/advisor/sim') {
    try {
      const a = advisorSim([]);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(a));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 本地完整分析（信号+位置+情绪+增长）
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const args = JSON.parse(body || '{}');
      if (!args.input) throw new Error('缺少 input');
      let analysis = null;
      // 完整管线：东财K线 → 腾讯/新浪K线兜底（fetch.mjs 已多源）
      try {
        const tmp = '/tmp/portal-az-' + String(args.input).replace(/[^a-zA-Z0-9]/g, '') + '-' + Date.now() + '.json';
        await localFetchRun([args.input, '--days', '90', '--out', tmp]);
        analysis = await localAnalyzeRun([tmp]);
      } catch (e) { /* fallthrough */ }
      if (!analysis) {
        // 完全降级：仅实时行情
        const q0 = await fetchQuoteOne(args.input);
        if (!q0) throw new Error('无法获取行情（多源均失败）');
        analysis = {
          meta: { code: q0.code, name: q0.name },
          quote: { price: q0.price, pct: q0.pct, prevClose: q0.prevClose, high: q0.high, low: q0.low, open: q0.open },
          signals: { score: 0, verdict: '观望', factors: [] },
          positionAnalysis: { zone: '-', buyScore: 0, sellScore: 0, bias: '-' },
          sentiment: { label: '-', score: 0 },
          growth: { label: '-', score: 0 },
          levels: { supports: [], resistances: [] },
          degraded: true, source: q0.source,
        };
      }
      const s2 = analysis.signals, p2 = analysis.positionAnalysis, se = analysis.sentiment, g = analysis.growth, q = analysis.quote;
      let label = '观望', cls = 'neutral';
      if (s2.verdict === '买入' && p2 && p2.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) { label = '可买入'; cls = 'buy'; }
      else if (p2 && p2.sellScore >= 55) { label = '注意止盈'; cls = 'sell'; }
      else if (s2.verdict === '买入' || s2.verdict === '关注') { label = '可关注'; cls = 'watch'; }
      else if (s2.verdict === '回避' || s2.verdict === '谨慎') { label = '回避/谨慎'; cls = 'caution'; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        meta: analysis.meta, quote: q, signals: s2, positionAnalysis: p2, sentiment: se, growth: g,
        levels: analysis.levels, timing: { label, cls }
      }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 自选聚合分析（本地引擎）
  if (url.pathname === '/api/watchlist-analysis') {
    try {
      const w = await fetch(DSH_API + '/api/stock/watchlist').then(r => r.json());
      const list = w.watchlist || [];
      const results = [];
      const analyzeOne = async (it) => {
        try {
          let analysis = null;
          // 完整管线：东财K线 → 腾讯/新浪K线兜底（fetch.mjs 已多源）
          try {
            const tmp = '/tmp/portal-wl-' + it.code + '-' + Date.now() + '.json';
            await localFetchRun([it.code, '--days', '90', '--out', tmp]);
            analysis = await localAnalyzeRun([tmp]);
          } catch (e) { /* fallthrough */ }
          if (!analysis) {
            // 完全降级：仅实时行情
            const q0 = await fetchQuoteOne(it.code);
            if (!q0) return null;
            analysis = {
              meta: { code: it.code, name: q0.name },
              quote: { price: q0.price, pct: q0.pct, prevClose: q0.prevClose },
              signals: { score: 0, verdict: '观望', factors: [] },
              positionAnalysis: { zone: '-', buyScore: 0, sellScore: 0 },
              sentiment: { label: '-', score: 0 },
              growth: { label: '-', score: 0 },
              degraded: true, source: q0.source,
            };
          }
          const s2 = analysis.signals, p2 = analysis.positionAnalysis, se = analysis.sentiment, g = analysis.growth, q = analysis.quote;
          let label = '观望', cls = 'neutral';
          if (s2.verdict === '买入' && p2 && p2.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) { label = '可买入'; cls = 'buy'; }
          else if (p2 && p2.sellScore >= 55) { label = '注意止盈'; cls = 'sell'; }
          else if (s2.verdict === '买入' || s2.verdict === '关注') { label = '可关注'; cls = 'watch'; }
          else if (s2.verdict === '回避' || s2.verdict === '谨慎') { label = '回避/谨慎'; cls = 'caution'; }
          let comment = '';
          if (s2.verdict === '买入' && p2 && p2.buyScore >= 40) comment = '低位+强信号，可重点关注';
          else if (p2 && p2.sellScore >= 55) comment = '位置偏高，注意止盈风险';
          else if (g && g.score >= 60) comment = '基本面高增长，可跟踪';
          else if (s2.verdict === '回避') comment = '技术面弱，建议回避';
          else comment = '信号中性，观望为主';
          return { code: it.code, name: analysis.meta.name, industry: it.industry, price: q.price, pct: q.pct, timing: { label, cls }, verdict: s2.verdict, score: s2.score, zone: p2.zone, sentiment: se.label, growth: g.label, comment, degraded: analysis.degraded || false, source: analysis.source || 'eastmoney' };
        } catch (e) { return null; }
      };
      const CONC = 6; // 全并发，东财限流时快速降级
      for (let i = 0; i < list.length; i += CONC) {
        const batch = list.slice(i, i + CONC);
        const done = await Promise.all(batch.map(analyzeOne));
        results.push(...done.filter(Boolean));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ results }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 龙头股票卡片（简洁分析，60秒缓存）
  if (url.pathname === '/api/leaders-cards') {
    try {
      const now = Date.now();
      if (leadersCache && now - leadersCache.ts < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ results: leadersCache.results, cached: true }));
        return;
      }
      const w = await fetch(DSH_API + '/api/stock/leaders').then(r => r.json());
      const list = (w.leaders || []).slice(0, 16); // 代表性龙头
      const results = [];
      const analyzeOne = async (it) => {
        try {
          let analysis = null;
          try {
            const tmp = '/tmp/portal-ld-' + it.code + '-' + Date.now() + '.json';
            await localFetchRun([it.code, '--days', '90', '--out', tmp]);
            analysis = await localAnalyzeRun([tmp]);
          } catch (e) { /* fallthrough */ }
          if (!analysis) {
            const q0 = await fetchQuoteOne(it.code);
            if (!q0) return null;
            analysis = {
              meta: { code: it.code, name: q0.name },
              quote: { price: q0.price, pct: q0.pct, prevClose: q0.prevClose },
              signals: { score: 0, verdict: '观望', factors: [] },
              positionAnalysis: { zone: '-', buyScore: 0, sellScore: 0 },
              sentiment: { label: '-', score: 0 },
              growth: { label: '-', score: 0 },
              levels: { supports: [], resistances: [] },
              degraded: true, source: q0.source,
            };
          }
          const s2 = analysis.signals, p2 = analysis.positionAnalysis, se = analysis.sentiment, g = analysis.growth, q = analysis.quote;
          let label = '观望', cls = 'neutral';
          if (s2.verdict === '买入' && p2 && p2.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) { label = '可买入'; cls = 'buy'; }
          else if (p2 && p2.sellScore >= 55) { label = '注意止盈'; cls = 'sell'; }
          else if (s2.verdict === '买入' || s2.verdict === '关注') { label = '可关注'; cls = 'watch'; }
          else if (s2.verdict === '回避' || s2.verdict === '谨慎') { label = '回避/谨慎'; cls = 'caution'; }
          return {
            code: it.code, name: analysis.meta.name, industry: it.industry,
            price: q.price, pct: q.pct,
            timing: { label, cls }, verdict: s2.verdict, score: s2.score,
            zone: p2.zone, buyScore: p2.buyScore, sellScore: p2.sellScore,
            sentiment: se.label, sentimentScore: se.score,
            growth: g.label, growthScore: g.score,
            supports: (analysis.levels && analysis.levels.supports || []).map(x => x.price),
            resistances: (analysis.levels && analysis.levels.resistances || []).map(x => x.price),
            summary: (s2.summary || '').slice(0, 80),
            degraded: analysis.degraded || false, source: analysis.source || 'eastmoney'
          };
        } catch (e) { return null; }
      };
      const CONC = 4;
      for (let i = 0; i < list.length; i += CONC) {
        const batch = list.slice(i, i + CONC);
        const done = await Promise.all(batch.map(analyzeOne));
        results.push(...done.filter(Boolean));
      }
      leadersCache = { ts: Date.now(), results };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ results, cached: false }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  // 代理 DSH API（避免跨域）
  if (url.pathname.startsWith("/api/")) {
    try {
      const target = DSH_API + url.pathname + url.search;
      const opts = { method: req.method, headers: {} };
      if (req.method === "POST" || req.method === "PUT") {
        let body = "";
        for await (const chunk of req) body += chunk;
        opts.body = body;
        opts.headers["Content-Type"] = "application/json";
      }
      const r = await fetch(target, opts);
      const text = await r.text();
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8" });
      res.end(text);
      return;
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "代理失败: " + e.message }));
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log("📈 股票分析平台已启动: http://127.0.0.1:" + PORT + "/");
});
