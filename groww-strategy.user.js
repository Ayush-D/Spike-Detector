// ==UserScript==
// @name         Groww Strategy View
// @namespace    local.groww-strategy
// @version      1.8.1
// @description  Current one-minute rises among 15-minute gainers, strict results exclusion, and Groww OTM call comparisons. Read-only research.
// @match        https://groww.in/futures-and-options/top-gainers*
// @connect      groww.in
// @connect      www.nseindia.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
"use strict";
// Pure calculation and provider-normalization code. No browser or account access.
const MINUTE = 60_000;
const PRICE_SOURCE = "groww-quotes-v2";
const IST_DAY_FORMATTER=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"});
function quoteTime(value) {
  const n=numeric(value);
  return n>0?n<100_000_000_000?n*1000:n:null;
}
function quoteFresh(quote,time,age=30_000) {
  if(quote?.priceError)return false;
  const t=quote?.quoteAt;
  return Number.isFinite(t) && t<=time+10_000 && time-t<=age &&
    t>=Date.parse(`${istDay(time)}T09:15:00+05:30`) && istDay(t)===istDay(time);
}
const DEFAULTS = Object.freeze({
  mode: "strategy", eligibleOnly: false, minDay: 0.2, minDistance: 10,
  nearTarget: true,
});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function numeric(v) {
  if (v === null || v === undefined || v === "" || !["number","string"].includes(typeof v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function above(a, b) { return a - b > 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); }
function atLeast(a, b) { return Number.isFinite(a) && Number.isFinite(b) && !above(b, a); }
function istDay(time) {
  const p = IST_DAY_FORMATTER.formatToParts(time);
  const get = type => p.find(x => x.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function addDays(day, n) {
  const [y,m,d] = day.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);
}
function validDay(day) {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && addDays(day, 0) === day;
}
function nseDate(value) {
  if (validDay(value)) return value;
  const m = String(value || "").match(/^(\d{1,2})-([A-Za-z]{3}|\d{2})-(\d{4})$/);
  if (!m) return null;
  const month = /^\d/.test(m[2]) ? Number(m[2]) : MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) + 1;
  const day = `${m[3]}-${String(month).padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return validDay(day) ? day : null;
}
function toNseDate(day) {
  if (!validDay(day)) throw new Error("Invalid expiry date");
  const [y,m,d] = day.split("-");
  return `${d}-${MONTHS[Number(m)-1]}-${y}`;
}
function nseTimestamp(value) {
  const m = String(value || "").match(/^(\d{1,2}-[A-Za-z]{3}-\d{4}) (\d{2}:\d{2}:\d{2})$/);
  const day = m && nseDate(m[1]);
  return day ? Date.parse(`${day}T${m[2]}+05:30`) : null;
}
function normalizeHolidays(payload, time = Date.now()) {
  if (!Array.isArray(payload?.FO)) throw new Error("NSE F&O holiday calendar unavailable");
  const dates = payload.FO.map(x => nseDate(x.tradingDate));
  if (dates.some(x => !x) || !dates.length) throw new Error("Invalid NSE holiday calendar");
  const years = [...new Set(dates.map(x => x.slice(0,4)))];
  if (!years.includes(istDay(time).slice(0,4))) throw new Error("Holiday calendar does not cover this year");
  return { dates, years, fetchedAt: time };
}
function isSession(day, calendar) {
  if (!calendar?.years?.includes(day.slice(0,4))) throw new Error(`Holiday coverage unavailable for ${day.slice(0,4)}`);
  const weekDay = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekDay !== 0 && weekDay !== 6 && !calendar.dates.includes(day);
}
function sessionWindow(day, calendar) {
  let previous = day, next = day;
  for (let i=0;i<20;i++) { previous = addDays(previous,-1); if (isSession(previous,calendar)) break; if (i===19) throw new Error("Previous trading session unavailable"); }
  for (let i=0;i<20;i++) { next = addDays(next,1); if (isSession(next,calendar)) break; if (i===19) throw new Error("Next trading session unavailable"); }
  return { day, previous, next, from: previous, to: next };
}
function marketState(time, holidays) {
  const day = istDay(time);
  try {
    if (!isSession(day,holidays)) return {open:false, known:true, label:"Market closed", day};
    const parts = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(time);
    const mins = Number(parts.find(p=>p.type==="hour").value)*60 + Number(parts.find(p=>p.type==="minute").value);
    const open = mins >= 555 && mins < 930;
    return {open, known:true, label:open ? "Market open" : mins<555 ? "Opens at 09:15 IST" : "Market closed", day};
  } catch { return {open:false, known:false, label:"Trading calendar unavailable", day}; }
}
function nextPollDelay(started, now, holidays) {
  const market=marketState(now,holidays);
  let delay=Math.max(1000,(market.open?10_000:60_000)-(now-started));
  // A pre-open poll must not leave the collector asleep across the opening bell.
  const opening=Date.parse(`${market.day}T09:15:00+05:30`);
  // Also wake while the first holiday lookup is in flight. Observation itself
  // remains gated on a verified open session in the collector.
  if (now<opening && (!market.known || isSession(market.day,holidays))) delay=Math.min(delay,opening-now);
  return delay;
}
function stockKey(stock) { return stock.gsin || stock.searchId || stock.symbol; }
function normalizeMovers(payload) {
  if (!Array.isArray(payload?.companyDetailsList)) throw new Error("Groww gainers response changed or is unavailable");
  const seen = new Set();
  return payload.companyDetailsList.flatMap((r,i) => {
    const p = r.livePriceDetailsDto;
    if (!r.identifier || seen.has(r.identifier)) return [];
    seen.add(r.identifier);
    return [{symbol:r.identifier, name:r.companyShortName || r.companyName || r.identifier,
      gsin:r.gsin || null, searchId:r.searchId || null, rank:i+1,
      spot:numeric(p?.ltp), dayPct:numeric(p?.dayChangePerc), volume:numeric(p?.volume),priceSource:"ranking-feed",quoteAt:null}];
  });
}
function normalizeGrowwQuote(point,symbol,fetchedAt) {
  if (!point || typeof point!=="object" || point.symbol!==symbol) throw new Error("Groww quote identity unavailable or mismatched");
  const spot=numeric(point.ltp),previousClose=numeric(point.close),quoteAt=quoteTime(point.tsInMillis);
  if (!(spot>0) || !(previousClose>0) || !quoteAt) throw new Error("Groww price, previous close or source time unavailable");
  const dayPct=(spot/previousClose-1)*100,reported=numeric(point.dayChangePerc);
  if (reported!==null && Math.abs(reported-dayPct)>0.02) throw new Error("Groww price and daily change disagree");
  return {spot,previousClose,dayPct,volume:numeric(point.volume),quoteAt,fetchedAt,priceSource:PRICE_SOURCE,priceError:null};
}
function normalizeGrowwPrices(payload,stocks,fetchedAt) {
  const points=payload?.exchangeAggRespMap?.NSE?.priceLivePointsMap;
  if (!points || typeof points!=="object" || (payload.segment && payload.segment!=="CASH")) throw new Error("Groww NSE stock quotes unavailable");
  return stocks.map(stock=>{
    const base={...stock,feedSpot:stock.feedSpot ?? stock.spot,feedDayPct:stock.feedDayPct ?? stock.dayPct};
    try {return {...base,...normalizeGrowwQuote(points[stock.symbol],stock.symbol,fetchedAt)};}
    catch(e) {return {...base,spot:null,dayPct:null,quoteAt:null,priceSource:PRICE_SOURCE,priceError:e.message};}
  });
}
function normalizeCalendar(payload, window, time) {
  if (!Array.isArray(payload?.exdateEvents) || !Array.isArray(payload?.announcementEvents) ||
      payload.from !== window.from || payload.to !== window.to) throw new Error("Groww results calendar coverage unavailable");
  const events = [], seen = new Set();
  for (const r of [...payload.exdateEvents,...payload.announcementEvents]) {
    if (r.type !== "RESULTS" && r.corporateEventFilter !== "RESULTS") continue;
    const date = r.corporateEventPillDto?.primaryDate;
    if (!validDay(date) || (!r.gsin && !r.searchId)) throw new Error("Unrecognized results-calendar record");
    if (date < window.from || date > window.to) continue;
    const key = `${r.gsin || r.searchId}:${date}`;
    if (seen.has(key)) continue;
    seen.add(key); events.push({gsin:r.gsin || null,searchId:r.searchId || null,date});
  }
  return {...window, fetchedAt:time, events};
}
function resultsCheck(stock, calendar, window, time) {
  if (!stock || !calendar || !window || window.day !== istDay(time) || calendar.day !== istDay(time) ||
      !validDay(window.from) || !validDay(window.to) || window.from>window.day || window.to<window.day ||
      !validDay(calendar.from) || !validDay(calendar.to) || calendar.from > window.from || calendar.to < window.to ||
      !Array.isArray(calendar.events) || calendar.events.some(e=>!validDay(e?.date) || (!e.gsin && !e.searchId)) ||
      !Number.isFinite(calendar.fetchedAt) || istDay(calendar.fetchedAt)!==istDay(time) || calendar.fetchedAt > time+10_000 || (!stock.gsin && !stock.searchId)) {
    return {pass:false, unknown:true, label:"Results check unavailable", events:[]};
  }
  const seen=new Set();
  const matches = calendar.events.filter(e => {
    const hit=e.date>=window.from && e.date<=window.to && ((stock.gsin && e.gsin === stock.gsin) ||
      (stock.searchId && e.searchId === stock.searchId));
    if (!hit || seen.has(e.date))return false;
    seen.add(e.date);return true;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  const labels = matches.map(e=>e.date===window.day ? "Results today" : e.date===window.next ? "Results next session" : `Results ${e.date}`);
  return {pass:matches.length===0, unknown:false, label:labels.join(" · ") || "No results in window", events:matches};
}
function resultsAllowed(stock, calendar, window, time) {return resultsCheck(stock,calendar,window,time).pass;}
function stockCheck(stock, calendar, window, time, settings = DEFAULTS, checkedResults = null) {
  const results = checkedResults || resultsCheck(stock,calendar,window,time);
  const dayPass = stock.dayPct !== null && above(stock.dayPct,settings.minDay);
  const dayLabel = stock.dayPct === null ? "Day change unavailable" : stock.dayPct < 0 ? "Negative today" :
    stock.dayPct === 0 ? "Flat today" : !dayPass ? `Below +${settings.minDay}%` : null;
  const reasons = [...(dayLabel ? [dayLabel] : []), ...(!results.pass ? [results.label] : []), ...(!(stock.spot>0)?["Price unavailable"]:[])];
  const fresh=!stock.priceSource || quoteFresh(stock,time);
  if (!fresh) reasons.push(stock.priceError || "Groww quote stale or unavailable");
  return {pass:dayPass && results.pass && stock.spot > 0 && fresh, results, reasons};
}
const SIGNAL_VERSION = 4;
const SPIKE_THRESHOLDS = Object.freeze({one:1,five:2,confirmationMs:10_000,maxGapMs:30_000,rearmMs:MINUTE,retentionMs:15*MINUTE});
const unreadyReturn = (reason="warming",extra={}) => ({ready:false,pct:null,reason,coverageReason:reason,anchorOffsetSeconds:null,...extra});
function windowStart(samples,windowMs,end) {
  if (!samples.length || samples[0].t>end-windowMs) return -1;
  const index=samples.findIndex(p=>p.t>=end-windowMs);
  return index>=0 && samples[index].t<=end-windowMs+10_000 ? index : -1;
}
function rollingChange(samples, windowMs, now, interval = 10_000) {
  if (!samples.length || samples[0].t>now-windowMs) return unreadyReturn();
  if (samples.at(-1).t!==now) return unreadyReturn("unavailable");
  const index=samples.findIndex(p=>p.t>=now-windowMs);
  if (index<0 || samples[index].t>now-windowMs+interval || !(samples[index].p>0)) return unreadyReturn("missing-anchor");
  for (let i=index+1;i<samples.length;i++) if (samples[i].t-samples[i-1].t>30_000) return unreadyReturn("gap");
  const start=samples[index],end=samples.at(-1);
  return {ready:true,pct:(end.p/start.p-1)*100,seconds:(end.t-start.t)/1000,
    startAt:start.t,endAt:end.t,startPrice:start.p,endPrice:end.p,
    anchorOffsetSeconds:(start.t-(now-windowMs))/1000,reason:"complete",coverageReason:"complete"};
}
// Use real source observations on either side of the one-minute boundary. A full
// minute must already have been collected, even when the closest anchor is newer.
// rollingChange remains the strict historical policy for longer context/baseline.
function oneMinuteChange(samples, now, interval = 10_000) {
  const target=now-MINUTE;
  if (!samples.length || samples[0].t>target) return unreadyReturn();
  if (samples.at(-1).t!==now) return unreadyReturn("unavailable");
  let index=-1,distance=Infinity;
  for(let i=0;i<samples.length;i++) {
    const offset=Math.abs(samples[i].t-target);
    if(offset<=interval && (offset<distance || (offset===distance && samples[i].t<samples[index]?.t))) {index=i;distance=offset;}
  }
  if(index<0 || !(samples[index].p>0))return unreadyReturn("missing-anchor");
  for(let i=index+1;i<samples.length;i++)if(samples[i].t-samples[i-1].t>30_000)return unreadyReturn("gap");
  const anchor=samples[index],end=samples.at(-1);
  if(!(end.p>0))return unreadyReturn("unavailable");
  return {ready:true,pct:(end.p/anchor.p-1)*100,seconds:(end.t-anchor.t)/1000,
    startAt:anchor.t,endAt:end.t,startPrice:anchor.p,endPrice:end.p,
    anchorOffsetSeconds:(anchor.t-target)/1000,reason:"complete",coverageReason:"complete"};
}
function accelerationPattern(samples,now) {
  if (!rollingChange(samples,3*MINUTE,now).ready) return {ready:false,hit:false,returns:[]};
  const boundaries=[3,2,1].map(m=>samples[windowStart(samples,m*MINUTE,now)]);
  if (boundaries.some(p=>!p)) return {ready:false,hit:false,returns:[]};
  boundaries.push(samples.at(-1));
  const returns=boundaries.slice(1).map((end,i)=>({ready:true,pct:(end.p/boundaries[i].p-1)*100,
    seconds:(end.t-boundaries[i].t)/1000,startAt:boundaries[i].t,endAt:end.t,startPrice:boundaries[i].p,endPrice:end.p}));
  return {ready:true,hit:above(returns[0].pct,0) && above(returns[1].pct,returns[0].pct) && above(returns[2].pct,returns[1].pct),returns};
}
function burstPeak(event,one,five,observed) {
  event.lastSeen=observed;
  for (const [key,change,threshold] of [["one",one,1],["five",five,2]]) {
    if (change.ready && atLeast(change.pct,threshold) && (event[key]===null || above(change.pct,event[key]))) {
      event[key]=change.pct;event[key+"Window"]={...change};
    }
  }
}
// A contemporaneous baseline preserves v1.5's count-first, single-hit behavior for research comparison only.
function observeBaseline(state,key,one,five,observed,now,gap) {
  const b=state.baseline ||= {events:[],activeId:null,falseSince:null};
  if (gap) {b.activeId=null;b.falseSince=null;}
  b.events=b.events.filter(e=>now-e.lastSeen<15*MINUTE);
  if ((one.ready && atLeast(one.pct,1)) || (five.ready && atLeast(five.pct,2))) {
    let event=b.events.find(e=>e.id===b.activeId);
    if (!event) {event={id:`baseline:${key}:${observed}`,firstSeen:observed,lastSeen:observed,one:null,five:null};b.events.push(event);b.activeId=event.id;}
    burstPeak(event,one,five,observed);b.falseSince=null;
  } else if (one.ready && five.ready) {
    b.falseSince ??= observed;
    if (observed-b.falseSince>=MINUTE)b.activeId=null;
  }
}
class SpikeEngine {
  constructor(saved) {
    this.day=saved?.day || null;this.states={};this.transitions=[];
    for (const [key,state] of Object.entries(saved?.states || {})) {
      if (!Array.isArray(state?.samples) || state.samples.some(p=>!Number.isFinite(p.t) || !Number.isFinite(p.p) || !(p.p>0)))continue;
      if (state.samples.some((p,i)=>i && p.t<=state.samples[i-1].t))continue;
      this.states[key]=saved.signalVersion===SIGNAL_VERSION ? state : {
        samples:state.samples,events:[],activeId:null,falseSince:null,run:null,interruptions:0,
        identity:state.identity || null,since:state.samples[0]?.t || null,lastGap:null,baseline:{events:[],activeId:null,falseSince:null}};
      const current=this.states[key];
      current.oneReadings=Array.isArray(current.oneReadings)?current.oneReadings.filter(p=>p?.ready && Number.isFinite(p.pct) && Number.isFinite(p.observedAt)):[];
    }
  }
  transition(stock,kind,at,extra={}) {this.transitions.push({symbol:stock.symbol,kind,at,...extra});}
  observe(stocks,now) {
    this.transitions=[];
    const day=istDay(now);
    if (day!==this.day) {this.day=day;this.states={};}
    for (const stock of stocks) {
      if (!(stock.spot>0) || !Number.isFinite(stock.spot) || (stock.priceSource && !quoteFresh(stock,now))) {
        const old=this.states[stockKey(stock)];
        if(old) {
          if(old.run && !old.run.confirmedAt)this.transition(stock,"rejected",now,{runId:old.run.id,reason:"Unusable source quote"});
          old.run=null;old.falseSince=null;
        }
        continue;
      }
      const observed=stock.priceSource?stock.quoteAt:now,key=stockKey(stock);
      const s=this.states[key] ||= {samples:[],events:[],activeId:null,falseSince:null,run:null,interruptions:0,since:observed,lastGap:null};
      s.identity={symbol:stock.symbol,gsin:stock.gsin || null,searchId:stock.searchId || null};
      const last=s.samples.at(-1);
      if (last && observed<=last.t) {
        if(observed===last.t && stock.spot!==last.p) {
          if(s.run && !s.run.confirmedAt)this.transition(stock,"rejected",now,{runId:s.run.id,reason:"Conflicting prices at the same source time"});
          s.run=null;s.falseSince=null;s.quoteConflict=true;
        }
        continue;
      }
      s.quoteConflict=false;
      const gap=!!last && observed-last.t>30_000;
      if (gap) {
        if (s.run && !s.run.confirmedAt)this.transition(stock,"rejected",observed,{runId:s.run.id,reason:"Source gap"});
        s.lastGap={from:last.t,to:observed,seconds:(observed-last.t)/1000};s.interruptions=(s.interruptions || 0)+1;
        s.samples=[];s.run=null;s.falseSince=null;s.since=observed;
        // Preserve burst identity. An unobserved interval cannot establish a distinct new burst.
        this.transition(stock,"gap",observed,{...s.lastGap});
      }
      s.samples.push({t:observed,p:stock.spot});
      s.samples=s.samples.filter(p=>p.t>=observed-910_000);
      const one=oneMinuteChange(s.samples,observed),five=rollingChange(s.samples,5*MINUTE,observed);
      const oneHit=one.ready && atLeast(one.pct,1);
      const active=oneHit;
      s.oneReadings=(s.oneReadings || []).filter(p=>p.observedAt>=observed-MINUTE);
      if(one.ready)s.oneReadings.push({...one,observedAt:observed});
      s.events=s.events.filter(e=>now-e.lastSeen<15*MINUTE);
      observeBaseline(s,key,rollingChange(s.samples,MINUTE,observed),five,observed,now,gap);
      if (active) {
        if(s.run && !s.run.confirmedAt && observed-s.run.firstSeen>30_000) {
          this.transition(stock,"rejected",observed,{runId:s.run.id,reason:"Confirmation window elapsed"});s.run=null;
        }
        if (!s.run) {
          s.run={id:`run:${key}:${observed}`,firstSeen:observed,lastAt:observed,confirmedAt:null};
          this.transition(stock,"verifying",observed,{runId:s.run.id});
        } else {
          s.run.lastAt=observed;
          if (!s.run.confirmedAt && observed-s.run.firstSeen>=10_000 && observed-s.run.firstSeen<=30_000) {
            let event=s.events.find(e=>e.id===s.activeId);
            const newBurst=!event;
            if (!event) {
              event={id:s.activeId || `burst:${key}:${s.run.firstSeen}`,firstSeen:s.run.firstSeen,confirmedAt:observed,lastSeen:observed,one:null,five:null};
              s.events.push(event);s.activeId=event.id;
            }
            s.run.confirmedAt=observed;
            this.transition(stock,"confirmed",observed,{runId:s.run.id,eventId:event.id,newBurst,delayMs:observed-s.run.firstSeen});
          }
        }
      } else if (s.run) {
        this.transition(stock,s.run.confirmedAt?"inactive":"rejected",observed,{runId:s.run.id,reason:"No longer actively qualifying"});s.run=null;
      }
      // Remember first-hit prices too, but only publish/count events after confirmation.
      if (s.run) {
        s.run.peaks ||= {one:null,five:null};burstPeak(s.run.peaks,one,five,observed);
      }
      const event=s.events.find(e=>e.id===s.activeId);
      if (event && oneHit) {
        if (s.run?.peaks)for (const key of ["one","five"])if (s.run.peaks[key]!==null && (event[key]===null || above(s.run.peaks[key],event[key]))) {
          event[key]=s.run.peaks[key];event[key+"Window"]=s.run.peaks[key+"Window"];
        }
        burstPeak(event,one,five,observed);
      }
      if (!oneHit && one.ready) {
        s.falseSince ??= observed;
        if (s.activeId && observed-s.falseSince>=MINUTE) {
          this.transition(stock,"rearmed",observed,{eventId:s.activeId});s.activeId=null;
        }
      } else s.falseSince=null;
    }
    for (const [key,s] of Object.entries(this.states)) {
      s.events=s.events.filter(e=>now-e.lastSeen<15*MINUTE);
      if (s.samples.at(-1)?.t<now-15*MINUTE && !s.events.length)delete this.states[key];
    }
    return this.transitions;
  }
  view(stock,now) {
    const s=this.day===istDay(now)?this.states[stockKey(stock)]:null,recent=s?.samples.at(-1)?.t;
    const valid=!!recent && !s.quoteConflict && now-recent<=30_000 && recent<=now+10_000 && (!stock.priceSource || (quoteFresh(stock,now) && stock.quoteAt===recent && stock.spot===s.samples.at(-1).p));
    const invalidInput=stock.priceSource && !quoteFresh(stock,now);
    const invalidReason=s?.quoteConflict || stock.quoteConflictAt?"inconsistent":invalidInput?
      (Number.isFinite(stock.quoteAt) && now-stock.quoteAt>30_000?"stale":"unavailable"):
      !recent?"warming":now-recent>30_000?"stale":"inconsistent";
    const one=valid?oneMinuteChange(s.samples,recent):unreadyReturn(invalidReason);
    if(valid && one.reason==="warming" && s.lastGap) {one.reason="gap";one.coverageReason="gap";}
    const five=valid?rollingChange(s.samples,5*MINUTE,recent):unreadyReturn(invalidReason);
    const fifteen=valid?rollingChange(s.samples,15*MINUTE,recent):unreadyReturn(invalidReason);
    const acceleration=valid?accelerationPattern(s.samples,recent):{ready:false,hit:false,returns:[]};
    const events=(s?.events || []).filter(e=>now-e.lastSeen<15*MINUTE);
    const fast=one.ready && atLeast(one.pct,1),strongFive=five.ready && atLeast(five.pct,2);
    const active=fast;
    const confirmed=active && !!s?.run?.confirmedAt,verifying=active && !!s?.run && !confirmed;
    const patterns={fast,strongFive,accelerating:acceleration.hit,repeated:events.length>=2,
      newHigh:fifteen.ready && above(s.samples.at(-1).p,Math.max(...s.samples.slice(windowStart(s.samples,15*MINUTE,recent),-1).map(p=>p.p))),
      cooling:valid && events.length>0 && one.ready && !above(one.pct,0)};
    const previous=valid?s.samples.at(-2):null,last=valid?s.samples.at(-1):null;
    const latestChange=previous && last.t>previous.t && last.t-previous.t<=30_000 ? {
      ready:true,pct:(last.p/previous.p-1)*100,seconds:(last.t-previous.t)/1000,
      startAt:previous.t,endAt:last.t,startPrice:previous.p,endPrice:last.p}:unreadyReturn();
    const peakOne=valid?(s.oneReadings || []).filter(p=>p.observedAt>=now-MINUTE && p.observedAt<=now+10_000)
      .reduce((peak,p)=>!peak || p.pct>peak.pct || (p.pct===peak.pct && p.observedAt>peak.observedAt)?p:peak,null):null;
    const status=confirmed?"Confirmed active":verifying?"Spike detected · verifying":patterns.cooling?"Cooling":
      !one.ready?({warming:"Warming up",stale:"Quote stale",gap:"Interrupted coverage","missing-anchor":"Missing anchor",inconsistent:"Inconsistent quote",unavailable:"Price unavailable"}[one.reason] || "Data unavailable"):
      above(one.pct,0)?"Rising in 1m":events.length?"Recent spike":"No active spike";
    return {events,one,five,fifteen,latestChange,peakOne:peakOne || unreadyReturn(),acceleration,patterns,active,confirmed,verifying,status,tier:confirmed?2:verifying?1:0,
      strength:one.ready?Math.max(0,one.pct):0,confirmation:s?.run || null,
      baselineEvents:(s?.baseline?.events || []).filter(e=>now-e.lastSeen<15*MINUTE),
      coverage:{valid,reason:one.reason,oneReason:one.reason,lastQuoteAt:recent || null,since:s?.since || null,interruptions:s?.interruptions || 0,lastGap:s?.lastGap || null}};
  }
  snapshot() {return {day:this.day,states:this.states,source:PRICE_SOURCE,signalVersion:SIGNAL_VERSION};}
}
function spikeStrength(events) {return events.reduce((peak,e)=>Math.max(peak,(e.one || 0)/1,(e.five || 0)/2),0);}
function rankStocks(stocks,engine,now,context=null,baseline=false) {
  return stocks.filter(stock=>!context || resultsAllowed(stock,context.calendar,context.window,now)).map(stock=>{
    const view=engine.view(stock,now),events=baseline?(view.baselineEvents || []):view.events;
    const check=context?stockCheck(stock,context.calendar,context.window,now,context.settings || DEFAULTS):null;
    return {stock,events,view,check,latest:Math.max(0,...events.map(e=>e.lastSeen || 0))};
  }).sort((a,b)=>Number(b.check?.pass || false)-Number(a.check?.pass || false) ||
    (baseline ? b.events.length-a.events.length || spikeStrength(b.events)-spikeStrength(a.events) || b.latest-a.latest :
      Number(!!b.view.one?.ready && Number.isFinite(b.view.one.pct))-Number(!!a.view.one?.ready && Number.isFinite(a.view.one.pct)) ||
      (a.view.one?.ready && Number.isFinite(a.view.one.pct) && b.view.one?.ready && Number.isFinite(b.view.one.pct) ? b.view.one.pct-a.view.one.pct : 0) ||
      (a.view.one?.ready && Number.isFinite(a.view.one.pct) && b.view.one?.ready && Number.isFinite(b.view.one.pct) ?
        (b.view.coverage?.lastQuoteAt || b.stock.quoteAt || 0)-(a.view.coverage?.lastQuoteAt || a.stock.quoteAt || 0) : 0)) ||
    a.stock.rank-b.stock.rank).map(x=>x.stock);
}
function parseNextData(html) {
  const tag = String(html).match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!tag) throw new Error("Groww contract metadata unavailable");
  return JSON.parse(tag[1]);
}
function normalizeMetadata(html, symbol, fetchedAt=Date.now()) {
  const data=parseNextData(html)?.props?.pageProps?.data;
  if (data?.company?.symbol!==symbol && data?.company?.scripCode!==symbol) throw new Error("Groww contract symbol mismatch");
  const chain=data.optionChain;
  if (!Array.isArray(chain?.optionContracts)) throw new Error("Groww option metadata response changed");
  const expiry=chain.aggregatedDetails?.currentExpiry;
  if (!validDay(expiry)) throw new Error("Groww option expiry unavailable");
  const [year,month]=expiry.split("-");
  const prefix=`${symbol}${year.slice(2)}${MONTHS[Number(month)-1].toUpperCase()}`;
  const contracts={};
  for (const row of chain.optionContracts) {
    const strike=numeric(row.strikePrice), ce=row.ce;
    if (!ce || !(strike>0)) continue;
    const lot=numeric(ce.marketLot ?? chain.aggregatedDetails?.lotSize);
    const contract=ce.growwContractId || null;
    if (contract) {
      const contractStrike=contract.startsWith(prefix)&&contract.endsWith("CE")?numeric(contract.slice(prefix.length,-2)):null;
      if (contractStrike===null || above(Math.abs(contractStrike-strike/100),0)) throw new Error(`Groww contract identity mismatch at strike ${strike/100}`);
    }
    const markers=Array.isArray(ce.markers)&&ce.markers.every(x=>typeof x==="string")?ce.markers:null;
    contracts[String(strike/100)]={lot,contract,token:ce.token || null,greeks:ce.greeks || null,growwLtp:numeric(ce.liveData?.ltp),oi:numeric(ce.liveData?.oi),
      growwIlliquid:markers===null?null:markers.includes("ILLIQUID"),growwMarkers:markers};
  }
  const expiries=[...new Set((chain.aggregatedDetails?.expiryDates || [expiry]).filter(validDay))].sort();
  return {symbol,expiry,expiries,fetchedAt,contracts};
}
function normalizeExpiries(payload, day) {
  if (!Array.isArray(payload?.expiryDates)) throw new Error("NSE expiry list unavailable");
  const dates=[...new Set(payload.expiryDates.map(nseDate).filter(d=>d && d>=day))].sort();
  if (!dates.length) throw new Error("No listed expiry available");
  return dates;
}
function normalizeGrowwOptions(meta,stockQuote,prices,booksMap,fetchedAt) {
  if (!meta || !meta.symbol || !validDay(meta.expiry) || !meta.contracts || typeof meta.contracts!=="object") throw new Error("Groww call metadata unavailable");
  if (stockQuote?.symbol!==meta.symbol || !(stockQuote.spot>0) || !Number.isFinite(stockQuote.quoteAt)) throw new Error("Groww underlying quote unavailable or mismatched");
  if (!prices || typeof prices!=="object" || Array.isArray(prices)) throw new Error("Groww option quotes unavailable");
  if (!booksMap || typeof booksMap!=="object" || Array.isArray(booksMap)) throw new Error("Groww option depth unavailable");
  const known=new Set(Object.values(meta.contracts).map(item=>item.contract).filter(Boolean));
  for (const contract of [...Object.keys(prices),...Object.keys(booksMap)]) if (!known.has(contract)) throw new Error("Groww returned an unrequested call contract");
  const items=Object.entries(meta.contracts).map(([strikeText,m])=>{
    const strike=numeric(strikeText),contract=m.contract,token=m.token===null||m.token===undefined?null:String(m.token);
    if (!(strike>0) || typeof contract!=="string" || !token || !/^\d+$/.test(token)) throw new Error("Groww call contract identity unavailable");
    const point=prices[contract],book=booksMap[contract];
    let ltp=null,ltpAt=null,oi=null,volume=null;
    if (point!==undefined) {
      if (!point || typeof point!=="object" || Array.isArray(point) || String(point.symbol)!==token || (point.type && point.type!=="LIVE_PRICE")) throw new Error(`Groww option quote identity mismatch: ${contract}`);
      ltpAt=quoteTime(point.tsInMillis);
      if (!ltpAt) throw new Error(`Groww option trade time unavailable: ${contract}`);
      ltp=numeric(point.ltp);oi=numeric(point.openInterest);volume=numeric(point.volume);
    }
    let bid=null,ask=null,bidQty=null,askQty=null,bookAt=null;
    const bookError=book?.error?String(book.error):null;
    if (book!==undefined && !bookError) {
      if (!book || typeof book!=="object" || Array.isArray(book) || String(book.symbol)!==token || (book.type && book.type!=="MARKET_DEPTH")) throw new Error(`Groww depth identity mismatch: ${contract}`);
      bookAt=quoteTime(book.tsInMillis);
      if (!bookAt || !book.buyBook || typeof book.buyBook!=="object" || Array.isArray(book.buyBook) || !book.sellBook || typeof book.sellBook!=="object" || Array.isArray(book.sellBook)) throw new Error(`Groww depth response malformed: ${contract}`);
      const best=(levels,label)=>{
        const level=levels["1"];
        if (level===undefined || level?.empty===true) return {price:null,qty:null};
        if (!level || typeof level!=="object" || Array.isArray(level)) throw new Error(`Groww ${label} depth malformed: ${contract}`);
        const qty=numeric(level.qty);
        return {price:qty>0?numeric(level.price):null,qty};
      };
      const buy=best(book.buyBook,"buy"),sell=best(book.sellBook,"sell");
      bid=buy.price;bidQty=buy.qty;ask=sell.price;askQty=sell.qty;
    }
    return {source:"Groww",strike,expiry:meta.expiry,spot:stockQuote.spot,bid,ask,bidQty,askQty,oi,volume,ltp,
      lot:numeric(m.lot),contract,token,greeks:m.greeks || null,iv:numeric(m.greeks?.iv),
      growwLtp:ltp,ltpAt,bookAt,bookLoaded:book!==undefined,bookError,growwIlliquid:m.growwIlliquid ?? null,
      growwMarkers:m.growwMarkers ?? null,growwFetchedAt:meta.fetchedAt,nseIdentifier:null};
  }).sort((a,b)=>a.strike-b.strike);
  return {sourceSchema:3,source:"Groww",symbol:meta.symbol,expiry:meta.expiry,spot:stockQuote.spot,spotQuoteAt:stockQuote.quoteAt,
    asOf:stockQuote.quoteAt,fetchedAt,growwFetchedAt:meta.fetchedAt,expiries:meta.expiries || [meta.expiry],items};
}
function normalizeOptions(payload, meta, symbol, expiry, fetchedAt) {
  const r=payload?.records;
  if (!Array.isArray(r?.data) || !(numeric(r.underlyingValue)>0)) throw new Error("NSE option quotes unavailable");
  const asOf=nseTimestamp(r.timestamp), spot=numeric(r.underlyingValue);
  if (!asOf) throw new Error("NSE quote timestamp unavailable");
  const items=[];
  for (const row of r.data) {
    const ce=row.CE;
    if (!ce || ce.underlying!==symbol || nseDate(ce.expiryDate)!==expiry) continue;
    const strike=numeric(ce.strikePrice);
    if (!(strike>0)) continue;
    if (numeric(row.strikePrice)!==null && above(Math.abs(Number(row.strikePrice)-strike),0)) throw new Error("NSE row and call strike mismatch");
    if (typeof row.expiryDates==="string" && nseDate(row.expiryDates)!==expiry) throw new Error("NSE row and call expiry mismatch");
    const expectedId=`OPTSTK${symbol}${expiry.split("-").reverse().join("-")}CE${strike.toFixed(2)}`;
    if (ce.identifier && ce.identifier!==expectedId) throw new Error(`NSE contract identity mismatch at strike ${strike}`);
    // Metadata is expiry-specific; never reuse a different expiry's lot or Greeks.
    const m=meta?.symbol===symbol && meta.expiry===expiry ? meta.contracts[String(strike)] : null;
    items.push({strike,expiry,spot,bid:numeric(ce.buyPrice1),ask:numeric(ce.sellPrice1),
      bidQty:numeric(ce.buyQuantity1),askQty:numeric(ce.sellQuantity1),oi:numeric(ce.openInterest),
      volume:numeric(ce.totalTradedVolume),ltp:numeric(ce.lastPrice),lot:m?.lot ?? null,
      contract:m?.contract || null,greeks:m?.greeks || null,iv:numeric(ce.impliedVolatility),nseIdentifier:ce.identifier || null,
      growwLtp:m?.growwLtp ?? null,growwIlliquid:m?.growwIlliquid ?? null,growwMarkers:m?.growwMarkers ?? null,
      growwFetchedAt:m?meta.fetchedAt:null});
  }
  return {symbol,expiry,spot,asOf,fetchedAt,growwFetchedAt:meta?.fetchedAt || null,sourceSchema:2,items};
}
function shortCallPayoff(item, premium=item.bid) {
  const price=numeric(premium),lot=numeric(item.lot),strike=numeric(item.strike),spot=numeric(item.spot);
  if (!(price>0) || !(lot>0) || !Number.isInteger(lot) || !(strike>0)) return {premium:price,maxProfit:null,breakeven:null,breakevenDistance:null};
  const breakeven=strike+price;
  return {premium:price,maxProfit:price*lot,breakeven,breakevenDistance:spot>0?(breakeven/spot-1)*100:null};
}
function nearTargetFloor(settings=DEFAULTS) {return Math.max(0,settings.minDistance-0.5);}
function callsInRange(items,settings=DEFAULTS) {
  const measured=items.map(item=>({...item,distance:(item.strike/item.spot-1)*100}));
  const near=settings.nearTarget?measured.filter(item=>item.spot>0 && above(item.distance,nearTargetFloor(settings)) && !above(item.distance,settings.minDistance))
    .sort((a,b)=>b.distance-a.distance)[0]:null;
  return measured.filter(item=>above(item.distance,settings.minDistance) || item===near)
    .map(item=>({...item,rangeException:item===near})).sort((a,b)=>a.strike-b.strike);
}
function evaluateCall(item, settings=DEFAULTS, rangeException=false) {
  const distance=(item.strike/item.spot-1)*100;
  const spread=item.bid>0 && item.ask>0 ? 200*(item.ask-item.bid)/(item.ask+item.bid) : null;
  const reasons=[],failures=[],metric=v=>numeric(v)===null?"unavailable":String(v);
  const reject=(reason,detail)=>{reasons.push(reason);failures.push(detail);};
  const liquidity={pass:item.growwIlliquid===false,unknown:typeof item.growwIlliquid!=="boolean",
    label:item.growwIlliquid===false?"Groww liquidity passed":item.growwIlliquid===true?"Groww: illiquid":"Liquidity unavailable"};
  const permittedException=rangeException && settings.nearTarget && above(distance,nearTargetFloor(settings)) && !above(distance,settings.minDistance);
  if (!(item.spot>0) || !(above(distance,settings.minDistance)||permittedException)) reject(`Distance must exceed ${settings.minDistance}%`,"Strike outside the permitted distance range");
  if (!liquidity.pass) reject(liquidity.label,liquidity.unknown?"Groww’s droplet status is unavailable for this contract":"Groww marks this call ILLIQUID (crossed-droplet icon)");
  // Quote availability is separate from Groww's sole liquidity signal.
  const quoteFailures=[];
  if (!(item.bid>0) || !(item.ask>0) || above(item.bid,item.ask)) quoteFailures.push(`Invalid selling bid/ask: ${metric(item.bid)} / ${metric(item.ask)}`);
  if (!(item.lot>0) || !Number.isInteger(item.lot)) quoteFailures.push("Valid lot size unavailable");
  for (const detail of quoteFailures) reject("Quote unavailable",detail);
  const payoff=shortCallPayoff(item),ltpPayoff=shortCallPayoff(item,item.ltp ?? null),growwPayoff=shortCallPayoff(item,item.growwLtp ?? null);
  const referenceMismatch=numeric(item.ltp)!==null && numeric(item.growwLtp)!==null && above(Math.abs(item.ltp-item.growwLtp),0);
  return {...item,distance,spread,credit:payoff.maxProfit,payoff,ltpPayoff,growwPayoff,referenceMismatch,liquidity,
    quoteReady:quoteFailures.length===0,quoteFailures,rangeException:!!permittedException,pass:reasons.length===0,reasons,failures};
}
function optionRefreshPolicy(snapshot, time, market) {
  const observedAt=snapshot?.fetchedAt || snapshot?.requestedAt || 0;
  const opening=Date.parse(`${istDay(time)}T09:15:00+05:30`);
  const force=!!snapshot && ((market.open && observedAt<opening) || (Array.isArray(snapshot.items) && snapshot.sourceSchema!==3));
  return {due:!snapshot || force || time-observedAt>=(market.open?30_000:900_000),force};
}
function optionStatus(snapshot, settings, time, market) {
  if (!snapshot) return {pass:false,label:"Options unchecked",items:[],qualifying:[]};
  if (snapshot.error) return {pass:false,label:snapshot.error,items:[],qualifying:[]};
  if (!Array.isArray(snapshot.items)) return {pass:false,label:snapshot.loading?"Checking quotes…":"Option quotes unavailable",items:[],qualifying:[]};
  const items=callsInRange(snapshot.items,settings).map(x=>({...evaluateCall(x,settings,x.rangeException),
    bookFresh:snapshot.sourceSchema===3?quoteFresh({quoteAt:x.bookAt},time,60_000):true}));
  const opening=Date.parse(`${istDay(time)}T09:15:00+05:30`);
  const fresh=market.open && (snapshot.sourceSchema!==3 || quoteFresh({quoteAt:snapshot.spotQuoteAt},time)) && snapshot.asOf>=opening && snapshot.asOf<=time+10_000 && time-snapshot.asOf<=120_000 &&
    snapshot.fetchedAt>=opening && snapshot.fetchedAt<=time+10_000 && time-snapshot.fetchedAt<=120_000 && istDay(snapshot.asOf)===istDay(time);
  const qualifying=fresh ? items.filter(x=>x.pass && x.bookFresh) : [];
  return {pass:qualifying.length>0,items,qualifying,fresh,
    label:!market.open ? market.label : !fresh ? "Option quotes stale" : !qualifying.length ? "No qualifying calls" : `${qualifying.length} qualifying call${qualifying.length===1?"":"s"}`};
}


const FEED_URL = "https://groww.in/v1/api/stocks_fo_data/v1/live-aggregations/explore/market_trends/instrument/STOCKS?exchange=NSE&interval=FIFTEEN_MINUTES&limit=500&marketTrendFactor=PRICE&type=GAINERS";
function cancelledRequest(reason) {if(reason?.name==="TimeoutError")return reason;const error=new Error("Option request cancelled: stock no longer allowed");error.name="AbortError";return error;}
function requestTimeout() {const error=new Error("Call request unavailable: 15-second request deadline exceeded; try again");error.name="TimeoutError";return error;}
function requestAllowed(control) {
  try {return !control?.signal?.aborted && (!control?.allow || control.allow());} catch {return false;}
}
function requireAllowed(control) {if(!requestAllowed(control))throw cancelledRequest(control?.signal?.reason);}
function awaitAllowed(promise,control) {
  if(!requestAllowed(control)){Promise.resolve(promise).catch(()=>{});return Promise.reject(cancelledRequest(control?.signal?.reason));}
  const signal=control?.signal;
  if(!signal)return Promise.resolve(promise).then(value=>{requireAllowed(control);return value;});
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener("abort",abort);reject(cancelledRequest(signal.reason));};
    signal.addEventListener("abort",abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener("abort",abort);try{requireAllowed(control);resolve(value);}catch(error){reject(error);}},error=>{signal.removeEventListener("abort",abort);reject(error);});
    if(signal.aborted)abort();
  });
}
const CACHE_PREFIX = "gsv.v1.";
const QUOTE_URL = "https://groww.in/v1/api/stocks_data/v1/tr_live/segment/CASH/latest_aggregated";
const FO_QUOTE_URL = "https://groww.in/v1/api/stocks_fo_data/v1/tr_live_prices/exchange/NSE/segment/FNO/latest_prices_batch";
function allowedRequest(url) {
  const u=new URL(url);
  if (u.protocol!=="https:" || u.username || u.password || u.port) return false;
  const rawPath=String(url).match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1];
  const publicCallQuote=rawPath===u.pathname && !u.search && !u.hash &&
    /^\/v1\/api\/stocks_fo_data\/v1\/tr_live_(?:prices|book)\/exchange\/NSE\/segment\/FNO\/(?:[A-Z0-9&_.-]|%26)+CE\/latest$/.test(u.pathname);
  if (u.hostname==="groww.in") return u.pathname.startsWith("/v1/api/stocks_fo_data/v1/live-aggregations/explore/market_trends/") ||
    u.pathname==="/v1/api/stocks_data/equity_feature/v2/corporate_action/event" || u.pathname===new URL(QUOTE_URL).pathname || u.pathname===new URL(FO_QUOTE_URL).pathname ||
    /^\/v1\/api\/stocks_data\/v1\/tr_live_prices\/exchange\/NSE\/segment\/CASH\/[A-Z0-9&_.-]+\/latest$/.test(u.pathname) ||
    publicCallQuote || /^\/options\/[^/]+$/.test(u.pathname);
  return u.hostname==="www.nseindia.com" && u.pathname==="/api/holiday-master";
}
function retryDelay(headers, now) {
  const value=String(headers || "").match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
  if (!value) return 30_000;
  const ms=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value)-now;
  // Retry-After is a server minimum, not a suggestion that can be capped locally.
  return Math.max(10_000,Number.isFinite(ms)?ms:30_000);
}
function serviceFamily(url) {
  const path=new URL(url).pathname;
  if(url===QUOTE_URL)return "stock-quotes";
  if(url===FO_QUOTE_URL)return "call-quotes";
  if(path.includes("/tr_live_book/"))return "call-depth";
  if(path.startsWith("/options/"))return "call-metadata";
  if(path.includes("/market_trends/"))return "membership";
  if(path.endsWith("/corporate_action/event"))return "results-calendar";
  return path;
}
function notifyRequest(task,state,extra={}) {try{task.onState?.({state,url:task.url,...extra});}catch{}}
class PublicTransport {
  constructor(request,clock=()=>Date.now()) {this.request=request;this.clock=clock;this.queue=[];this.active=0;this.activeCash=0;this.activeOther=0;this.backoff=new Map();}
  get(url,{priority=1,text=false,signal,allow,onState,deadlineAt}={}) {
    if ([QUOTE_URL,FO_QUOTE_URL].includes(url)) return Promise.reject(new Error("Public quote batches require POST"));
    return this.enqueue(url,{priority,text,method:"GET",signal,allow,onState,deadlineAt});
  }
  post(url,data,{priority=url===QUOTE_URL?0:2,signal,allow,onState,deadlineAt}={}) {
    if (![QUOTE_URL,FO_QUOTE_URL].includes(url)) return Promise.reject(new Error("Only public Groww quote batches accept POST"));
    const exactKeys=(value,keys)=>value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).sort().join("|")===keys.slice().sort().join("|");
    const validList=(list,pattern)=>Array.isArray(list) && list.length>0 && list.length<=100 && new Set(list).size===list.length && list.every(s=>typeof s==="string" && s.length<=120 && pattern.test(s));
    let valid;
    if (url===FO_QUOTE_URL) valid=validList(data,/^[A-Z0-9&_.-]+CE$/);
    else {
      const map=data?.exchangeAggReqMap;
      valid=exactKeys(data,["exchangeAggReqMap"]) && exactKeys(map,["NSE","BSE"]) &&
        exactKeys(map.NSE,["priceSymbolList","indexSymbolList"]) && exactKeys(map.BSE,["priceSymbolList","indexSymbolList"]) &&
        validList(map.NSE.priceSymbolList,/^[A-Z0-9&_.-]+$/) &&
        [map.NSE.indexSymbolList,map.BSE.priceSymbolList,map.BSE.indexSymbolList].every(list=>Array.isArray(list)&&list.length===0);
    }
    if (!valid) return Promise.reject(new Error("Invalid public quote batch"));
    return this.enqueue(url,{priority,text:false,method:"POST",data:JSON.stringify(data),signal,allow,onState,deadlineAt});
  }
  cooldownState(url=QUOTE_URL) {
    const host=new URL(url).hostname,now=this.clock();
    const candidates=[this.backoff.get(`host:${host}`),this.backoff.get(`service:${host}:${serviceFamily(url)}`)].filter(value=>value?.retryAt>now);
    const current=candidates.sort((a,b)=>b.retryAt-a.retryAt)[0];
    return current?{paused:true,...current,remainingMs:current.retryAt-now}:{paused:false,retryAt:null,remainingMs:0,scope:null,status:null};
  }
  cooldownError(url) {
    const cooldown=this.cooldownState(url),host=new URL(url).hostname;
    if(!cooldown.paused)return null;
    const error=new Error(`${host}: retry after ${Math.ceil(cooldown.remainingMs/1000)}s (${cooldown.scope} cooldown)`);
    Object.assign(error,{name:"CooldownError",...cooldown});return error;
  }
  enqueue(url,{priority,text,method,data,signal,allow,onState,deadlineAt}) {
    if (!allowedRequest(url)) return Promise.reject(new Error("Request outside the public-data allowlist"));
    if (!requestAllowed({signal,allow}))return Promise.reject(cancelledRequest(signal?.reason));
    const cooldown=this.cooldownError(url);
    if(cooldown){notifyRequest({url,onState},"cooldown",cooldown);return Promise.reject(cooldown);}
    if(Number.isFinite(deadlineAt)&&deadlineAt<=this.clock())return Promise.reject(requestTimeout());
    return new Promise((resolve,reject)=>{
      const task={url,priority,text,method,data,signal,allow,onState,deadlineAt,started:false,settled:false,cash:url===QUOTE_URL};
      const finish=(callback,value)=>{if(task.settled)return;task.settled=true;clearTimeout(task.deadlineTimer);signal?.removeEventListener("abort",task.cancel);callback(value);};
      task.resolve=value=>finish(resolve,value);task.reject=error=>finish(reject,error);
      task.cancel=()=>{
        const index=this.queue.indexOf(task);if(index>=0)this.queue.splice(index,1);
        task.cancelRun?.();
        try {task.handle?.abort?.();} catch {}
        task.reject(cancelledRequest(signal?.reason));this.drain();
      };
      signal?.addEventListener("abort",task.cancel,{once:true});
      if(Number.isFinite(deadlineAt))task.deadlineTimer=setTimeout(()=>{
        const index=this.queue.indexOf(task);if(index>=0)this.queue.splice(index,1);
        task.cancelRun?.(requestTimeout());try{task.handle?.abort?.();}catch{}
        task.reject(requestTimeout());this.drain();
      },Math.max(0,deadlineAt-this.clock()));
      notifyRequest(task,"queued");
      this.queue.push(task);this.queue.sort((a,b)=>a.priority-b.priority);this.drain();
    });
  }
  drain() {
    while (this.active<2 && this.queue.length) {
      const index=this.queue.findIndex(task=>task.cash?this.activeCash===0:this.activeOther===0);
      if (index<0)break;
      const [task]=this.queue.splice(index,1), host=new URL(task.url).hostname;
      if (!requestAllowed(task)) {task.reject(cancelledRequest(task.signal?.reason));continue;}
      const cooldown=this.cooldownError(task.url);
      if(cooldown){notifyRequest(task,"cooldown",cooldown);task.reject(cooldown);continue;}
      if(Number.isFinite(task.deadlineAt)&&task.deadlineAt<=this.clock()){task.reject(requestTimeout());continue;}
      task.started=true;this.active++;
      if(task.cash)this.activeCash++;else this.activeOther++;
      notifyRequest(task,"requesting");
      this.run(task,host).then(task.resolve,task.reject).finally(()=>{this.active--;if(task.cash)this.activeCash--;else this.activeOther--;this.drain();});
    }
  }
  run(task,host) {
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(callback,value)=>{if(finished)return;finished=true;task.cancelRun=null;callback(value);};
      const fail=()=>finish(reject,new Error(`${host}: request failed or blocked; retry later`));
      task.cancelRun=reason=>finish(reject,reason?.name==="TimeoutError"?reason:cancelledRequest(task.signal?.reason));
      if (!requestAllowed(task)) {task.cancelRun();return;}
      try {task.handle=this.request({method:task.method,url:task.url,data:task.data,anonymous:true,timeout:12_000,
        headers:{Accept:task.text?"text/html":"application/json",...(task.method==="POST"?{"Content-Type":"application/json"}:{})},
        ontimeout:()=>finish(reject,new Error(`${host}: request timed out`)),onerror:fail,onabort:()=>finish(reject,cancelledRequest()),
        onload:r=>{
          if (finished)return;
          if (!requestAllowed(task)) {task.cancelRun();return;}
          if (r.finalUrl && !allowedRequest(r.finalUrl)) {finish(reject,new Error(`${host}: unexpected redirect`));return;}
          if ([429,503].includes(r.status)) {
            const scope=r.status===429?"host":"service",family=serviceFamily(task.url),key=scope==="host"?`host:${host}`:`service:${host}:${family}`;
            const retryAt=Math.max(this.backoff.get(key)?.retryAt || 0,this.clock()+retryDelay(r.responseHeaders,this.clock()));
            this.backoff.set(key,{retryAt,scope,status:r.status,family});
            notifyRequest(task,"cooldown",this.cooldownState(task.url));
            finish(reject,new Error(`${host}: temporarily unavailable (${r.status}); backing off`));return;
          }
          if (r.status<200 || r.status>=300) {finish(reject,new Error(`${host}: public data unavailable (${r.status})`));return;}
          try {finish(resolve,task.text?r.responseText:JSON.parse(r.responseText));}
          catch {finish(reject,new Error(`${host}: unexpected response format`));}
        }});}catch(error){finish(reject,error);}
    });
  }
}

class Providers {
  constructor(transport,storage,clock=()=>Date.now()) {this.transport=transport;this.storage=storage;this.clock=clock;this.memo=new Map();this.holidayData=null;this.optionTasks=new Map();this.optionMemoKeys=new Map();this.lastMembership=null;this.membershipFetchedAt=0;this.membershipAttemptAt=0;this.membershipError=null;this.membershipPending=null;}
  async cached(key,ttl,load,force=false) {
    const old=this.memo.get(key);
    if (old && !force && (old.promise || this.clock()-old.time<ttl)) return old.promise || old.value;
    const promise=load();this.memo.set(key,{promise});
    try {const value=await promise;if(this.memo.get(key)?.promise===promise)this.memo.set(key,{time:this.clock(),value});return value;}
    catch(e) {if(this.memo.get(key)?.promise===promise)this.memo.delete(key);throw e;}
  }
  async quotes(stocks,priority=0,control={}) {
    requireAllowed(control);
    if (!stocks.length)return [];
    const unique=[...new Map(stocks.map(stock=>[stock.symbol,stock])).values()],parts=[];
    for(let index=0;index<unique.length;index+=100)parts.push(unique.slice(index,index+100));
    const values=await awaitAllowed(Promise.all(parts.map(async batch=>{
      requireAllowed(control);
      const payload=await awaitAllowed(this.transport.post(QUOTE_URL,{exchangeAggReqMap:{NSE:{priceSymbolList:batch.map(s=>s.symbol),indexSymbolList:[]},BSE:{priceSymbolList:[],indexSymbolList:[]}}},{priority,...control}),control);
      return normalizeGrowwPrices(payload,batch,this.clock());
    })),control);
    const bySymbol=new Map(values.flat().map(stock=>[stock.symbol,stock]));
    return stocks.map(stock=>bySymbol.get(stock.symbol));
  }
  async membership(force=false) {
    if(this.membershipPending)return this.membershipPending;
    const snapshot=()=>({stocks:this.lastMembership || [],membershipFetchedAt:this.membershipFetchedAt,membershipError:this.membershipError,
      stale:!!this.membershipError,ageMs:this.membershipFetchedAt?Math.max(0,this.clock()-this.membershipFetchedAt):null});
    if(!force && this.lastMembership && this.clock()-this.membershipAttemptAt<60_000)return snapshot();
    this.membershipAttemptAt=this.clock();
    const load=async()=>{
      try {
        const candidates=normalizeMovers(await this.transport.get(FEED_URL,{priority:1}));
        this.lastMembership=candidates;this.membershipFetchedAt=this.clock();this.membershipError=null;
        return snapshot();
      } catch(error) {
        this.membershipError=error.message;
        if(this.lastMembership)return snapshot();
        throw error;
      }
    };
    const pending=load();this.membershipPending=pending;
    try{return await pending;}finally{if(this.membershipPending===pending)this.membershipPending=null;}
  }
  async movers(allow=()=>true) {
    const {stocks}=await this.membership();
    return (await this.quotes(stocks.filter(allow))).filter(allow);
  }
  async holidays() {
    const now=this.clock();
    const saved=this.holidayData || await this.storage.get("holidays",null);
    if (saved?.years?.includes(istDay(now).slice(0,4)) && istDay(saved.fetchedAt)===istDay(now)) {this.holidayData=saved;return saved;}
    const result=normalizeHolidays(await this.transport.get("https://www.nseindia.com/api/holiday-master?type=trading"),now);
    await this.storage.set("holidays",result);this.holidayData=result;return result;
  }
  async calendar(force=false) {
    const now=this.clock(), holidays=await this.holidays(), window=sessionWindow(istDay(now),holidays);
    const saved=await this.storage.get("calendar",null);
    if (!force && saved?.day===window.day && saved.from===window.from && saved.to===window.to && now-saved.fetchedAt<3_600_000) return {calendar:saved,window,holidays};
    const url=new URL("https://groww.in/v1/api/stocks_data/equity_feature/v2/corporate_action/event");
    url.searchParams.set("from",window.from);url.searchParams.set("to",window.to);
    const calendar=normalizeCalendar(await this.transport.get(url.href),window,now);
    await this.storage.set("calendar",calendar);
    return {calendar,window,holidays};
  }
  cancelOptions(stockOrSymbol) {
    const symbol=typeof stockOrSymbol==="string"?stockOrSymbol:stockOrSymbol?.symbol;
    if(!symbol)return;
    for(const controller of this.optionTasks.get(symbol)||[])controller.abort();
    this.optionTasks.delete(symbol);
    for(const key of this.optionMemoKeys.get(symbol)||[])this.memo.delete(key);
    this.optionMemoKeys.delete(symbol);
  }
  cancelAllOptions() {for(const symbol of new Set([...this.optionTasks.keys(),...this.optionMemoKeys.keys()]))this.cancelOptions(symbol);}
  async options(stock,requestedExpiry=null,force=false,limit=3,settings=DEFAULTS,priority=2,guard=()=>true) {
    if (!stock.searchId || !stock.symbol) throw new Error("Stock contract identifiers unavailable");
    const external=typeof guard==="function"?{allow:guard}:guard||{},controller=new AbortController();
    const externalAbort=()=>controller.abort(external.signal?.reason);
    external.signal?.addEventListener("abort",externalAbort,{once:true});
    if(external.signal?.aborted)controller.abort(external.signal.reason);
    const timeoutMs=Number.isFinite(external.deadlineMs)&&external.deadlineMs>0?external.deadlineMs:priority===1?15_000:null;
    const deadlineAt=timeoutMs===null?undefined:this.clock()+timeoutMs;
    const deadlineTimer=timeoutMs===null?null:setTimeout(()=>controller.abort(requestTimeout()),timeoutMs);
    const control={signal:controller.signal,allow:external.allow,onState:external.onState,deadlineAt},tasks=this.optionTasks.get(stock.symbol)||new Set();
    tasks.add(controller);this.optionTasks.set(stock.symbol,tasks);
    const stage=promise=>awaitAllowed(promise,control);
    const cached=async(key,ttl,load)=>{
      requireAllowed(control);
      const keys=this.optionMemoKeys.get(stock.symbol)||new Set();keys.add(key);this.optionMemoKeys.set(stock.symbol,keys);
      return stage(this.cached(key,ttl,async()=>{requireAllowed(control);const result=await stage(load());requireAllowed(control);return result;},force));
    };
    try {
      requireAllowed(control);
      const day=istDay(this.clock());
      if (requestedExpiry!==null && !validDay(requestedExpiry)) throw new Error("Invalid selected expiry");
      const loadMeta=expiry=>cached(`metadata:${stock.symbol}:${expiry || "nearest"}`,60_000,async()=>{
        const url=`https://groww.in/options/${encodeURIComponent(stock.searchId)}${expiry?`?expiry=${expiry}`:""}`;
        const response=await stage(this.transport.get(url,{text:true,priority,...control}));
        requireAllowed(control);return normalizeMetadata(response,stock.symbol,this.clock());
      });
      let meta=await loadMeta(requestedExpiry);
      const expiries=meta.expiries.filter(expiry=>expiry>=day);
      if (!expiries.length) throw new Error("No Groww expiry is currently listed");
      const expiry=requestedExpiry || expiries[0];
      if (!expiries.includes(expiry)) throw new Error("Selected expiry is no longer listed");
      if (meta.expiry!==expiry) meta=await loadMeta(expiry);
      if (meta.expiry!==expiry) throw new Error("Groww did not return metadata for the selected expiry");
      const depthLimit=Math.max(1,Math.min(100,Number.isFinite(Number(limit))?Math.floor(Number(limit)):3));
      const current=external.stockQuote || stock;
      const reusable=current?.symbol===stock.symbol && current.priceSource===PRICE_SOURCE && !current.priceError && current.spot>0 && current.previousClose>0 &&
        Number.isFinite(current.dayPct) && Math.abs((current.spot/current.previousClose-1)*100-current.dayPct)<=0.000001 && quoteFresh(current,this.clock());
      const stockQuote=reusable?current:await cached(`option-spot:${stock.symbol}`,10_000,async()=>(await this.quotes([stock],priority,control))[0]);
      requireAllowed(control);
      const initial=normalizeGrowwOptions(meta,stockQuote,{}, {},this.clock());
      const requested=callsInRange(initial.items,settings).slice(0,depthLimit);
      const contracts=requested.map(item=>item.contract).filter(Boolean);
      const key=`groww-options:${stock.symbol}:${expiry}:${depthLimit}:${settings.minDistance}:${settings.nearTarget}`;
      const oldResult=this.memo.get(key);
      if(oldResult?.value && (oldResult.value.spotQuoteAt!==stockQuote.quoteAt || oldResult.value.spot!==stockQuote.spot))this.memo.delete(key);
      const result=await cached(key,10_000,async()=>{
        requireAllowed(control);
        const prices={},missing=[];
        for(const contract of contracts){
          const tradeKey=`option-trade:${contract}`,old=this.memo.get(tradeKey);
          const keys=this.optionMemoKeys.get(stock.symbol)||new Set();keys.add(tradeKey);this.optionMemoKeys.set(stock.symbol,keys);
          if(!force && old && !old.promise && this.clock()-old.time<10_000)Object.assign(prices,old.value);
          else missing.push(contract);
        }
        for(let index=0;index<missing.length;index+=100){
          requireAllowed(control);
          const ids=missing.slice(index,index+100),part=await stage(this.transport.post(FO_QUOTE_URL,ids,{priority,...control}));
          if(!part || typeof part!=="object" || Array.isArray(part))throw new Error("Groww option quote batch unavailable");
          const expected=new Set(ids);
          if(Object.keys(part).some(contract=>!expected.has(contract)))throw new Error("Groww returned an unrequested call contract");
          // Validate contract identities and source times before anything enters the cache.
          normalizeGrowwOptions(meta,stockQuote,part,{},this.clock());requireAllowed(control);
          for(const contract of ids){const value=Object.hasOwn(part,contract)?{[contract]:part[contract]}:{};Object.assign(prices,value);this.memo.set(`option-trade:${contract}`,{time:this.clock(),value});}
        }
        requireAllowed(control);
        const books=await stage(Promise.all(requested.map(async item=>{
          requireAllowed(control);
          try {
            const book=await cached(`option-book:${item.contract}`,10_000,()=>this.transport.get(`https://groww.in/v1/api/stocks_fo_data/v1/tr_live_book/exchange/NSE/segment/FNO/${encodeURIComponent(item.contract)}/latest`,{priority,...control}));
            requireAllowed(control);return [item.contract,book];
          } catch(e) {requireAllowed(control);if(e.name==="AbortError")throw e;return [item.contract,{error:e.message}];}
        })));
        requireAllowed(control);
        return {...normalizeGrowwOptions(meta,stockQuote,prices,Object.fromEntries(books),this.clock()),expiries,loadedLimit:depthLimit};
      });
      requireAllowed(control);return {...result,stockQuote};
    } finally {
      clearTimeout(deadlineTimer);
      external.signal?.removeEventListener("abort",externalAbort);tasks.delete(controller);
      if(!tasks.size&&this.optionTasks.get(stock.symbol)===tasks)this.optionTasks.delete(stock.symbol);
    }
  }
}


const ARCHIVE_LIMITS=Object.freeze({sessions:20,bytes:50*1024*1024});
const LEGACY_OBSERVATION_COLUMNS=["symbol","gsin","growwRank","price","previousClose","sourceAt","volume","status","onePct","fivePct","fifteenPct","rank","baselineRank","exclusions","interruptions","oneSeconds","fiveSeconds","fifteenSeconds"];
const V3_OBSERVATION_COLUMNS=[...LEGACY_OBSERVATION_COLUMNS,"sampleChangePct","sampleSeconds","sampleAt","recentPeakOnePct","recentPeakOneAt","dayPct","confirmationState"];
const OBSERVATION_COLUMNS=[...V3_OBSERVATION_COLUMNS,"oneAnchorOffsetSeconds","oneCoverageReason"];
const SIGNAL_DEFINITIONS=Object.freeze({
  2:"One-minute or five-minute strong bursts; confirmed-active and trigger strength ranking.",
  3:"Current one-minute return ranking; only one-minute rises of at least 1% create strong bursts. Five-minute returns are context only.",
  4:"Current one-minute return ranking using the closest real sample within 10 seconds of the boundary, older on ties, after 60 seconds of history. Only one-minute rises of at least 1% create strong bursts; five-minute returns are context only."
});
function diagnosticFrame(stocks,engine,at,context,transitions=[],extra={}) {
  // Results exclusion applies before any current membership, rank, or transition is archived.
  // Older stored frames remain historical; a changed calendar never rewrites their observations.
  const allowed=stocks.filter(s=>resultsCheck(s,context.calendar,context.window,at).pass),symbols=new Set(allowed.map(s=>s.symbol));
  const ranks=new Map(rankStocks(allowed,engine,at,context).map((s,i)=>[s.symbol,i+1]));
  const baseline=new Map(rankStocks(allowed,engine,at,context,true).map((s,i)=>[s.symbol,i+1]));
  return {...extra,schema:3,day:istDay(at),at,signalVersion:SIGNAL_VERSION,thresholds:{one:1,fiveContextOnly:true,oneAnchor:"closest-real-sample-10s-older-tie"},
    observations:allowed.map(s=>{
      const v=engine.view(s,at),check=stockCheck(s,context.calendar,context.window,at,context.settings || DEFAULTS);
      return [s.symbol,s.gsin,s.rank,s.spot,s.previousClose,s.quoteAt,s.volume,v.status,v.one.pct,v.five.pct,v.fifteen.pct,
        ranks.get(s.symbol),baseline.get(s.symbol),check.reasons,v.coverage.interruptions,v.one.seconds ?? null,v.five.seconds ?? null,v.fifteen.seconds ?? null,
        v.latestChange?.pct ?? null,v.latestChange?.seconds ?? null,v.latestChange?.endAt ?? null,v.peakOne?.pct ?? null,v.peakOne?.observedAt ?? null,s.dayPct ?? null,
        v.confirmed?"confirmed":v.verifying?"verifying":"none",v.one.anchorOffsetSeconds ?? null,v.one.reason ?? v.coverage.reason ?? null];
    }),transitions:transitions.filter(t=>symbols.has(t.symbol))};
}
function mean(values) {return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;}
// Streaming analysis uses source-time future observations; gaps/absent membership are explicitly incomplete.
class SignalDiagnosticReview {
  constructor() {
    this.sessions=new Set();this.eventIds=new Set();this.eventDays=new Set();this.runs=new Map();this.pending=[];
    this.confirmationDelays=[];this.confirmedRuns=0;this.unmatchedConfirmations=0;this.rejected=0;this.frames=0;this.changedRanks=0;this.top3Changed=0;
    this.interruptions=0;this.missingQuotes=0;this.observations=0;this.sourceAgeTotal=0;this.sourceAgeCount=0;this.archiveGaps=0;this.lastFrameAt=0;
    this.outcomes={1:[],5:[],15:[]};this.incomplete={1:0,5:0,15:0};this.periods={opening:0,later:0};this.thresholdVariations=new Set();
  }
  consume(frame) {
    if(frame.error || !Array.isArray(frame.observations)) {this.interruptions++;for(const p of this.pending)p.broken=true;return;}
    if(this.lastFrameAt && istDay(this.lastFrameAt)===frame.day && frame.at-this.lastFrameAt>30_000)this.archiveGaps++;
    this.frames++;this.sessions.add(frame.day);this.lastFrameAt=Math.max(this.lastFrameAt,frame.at);
    this.thresholdVariations.add(JSON.stringify(frame.thresholds));
    const bySymbol=new Map(frame.observations.map(r=>[r[0],r]));
    const top=(index)=>frame.observations.filter(r=>!r[13]?.length).sort((a,b)=>a[index]-b[index]).slice(0,3).map(r=>r[0]).join(",");
    if(frame.observations.some(r=>r[11]!==r[12]))this.changedRanks++;
    if(top(11)!==top(12))this.top3Changed++;
    for(const row of frame.observations) {
      this.observations++;if(Number.isFinite(row[5])) {this.sourceAgeTotal+=frame.at-row[5];this.sourceAgeCount++;}
      if(!Number.isFinite(row[5]) || !(row[3]>0) || frame.at-row[5]>30_000)this.missingQuotes++;
    }
    for(const p of this.pending) {
      const row=bySymbol.get(p.symbol),source=row?.[5];
      if(!row || !(row[3]>0) || !Number.isFinite(source) || istDay(source)!==p.day || frame.at-source>30_000)p.broken=true;
      if(row && source>p.lastAt) {
        if(source-p.lastAt>30_000)p.broken=true;
        p.lastAt=source;
        const change=(row[3]/p.price-1)*100;
        p.maxUp=Math.max(p.maxUp,change);p.maxDown=Math.min(p.maxDown,change);
        if(source>=p.at+p.minutes*MINUTE) {
          if(!p.broken && source<=p.at+p.minutes*MINUTE+10_000)this.outcomes[p.minutes].push({eventId:p.id,symbol:p.symbol,at:p.at,observedAt:source,returnPct:change,maxUpPct:p.maxUp,maxDownPct:p.maxDown});
          else this.incomplete[p.minutes]++;
          p.done=true;
        }
      }
      if(!p.done && frame.at>p.at+p.minutes*MINUTE+30_000) {this.incomplete[p.minutes]++;p.done=true;}
    }
    this.pending=this.pending.filter(p=>!p.done);
    for(const t of frame.transitions || []) {
      if(t.kind==="verifying" && !this.runs.has(t.runId))this.runs.set(t.runId,"pending");
      if(t.kind==="rejected" && this.runs.get(t.runId)==="pending") {this.runs.set(t.runId,"rejected");this.rejected++;}
      if(t.kind==="gap")this.interruptions++;
      if(t.kind==="confirmed") {
        const prior=this.runs.get(t.runId);
        if(prior==="confirmed")continue;
        if(prior==="pending")this.confirmedRuns++;else this.unmatchedConfirmations++;
        this.runs.set(t.runId,"confirmed");if(Number.isFinite(t.delayMs))this.confirmationDelays.push(t.delayMs);
        if(!this.eventIds.has(t.eventId) && t.newBurst) {
          this.eventIds.add(t.eventId);this.eventDays.add(frame.day);
          const opening=Date.parse(`${frame.day}T09:15:00+05:30`);
          this.periods[t.at-opening<30*MINUTE?"opening":"later"]++;
          const row=bySymbol.get(t.symbol);
          if(row && row[3]>0)for(const minutes of [1,5,15])this.pending.push({id:t.eventId,symbol:t.symbol,day:frame.day,at:t.at,lastAt:t.at,price:row[3],minutes,maxUp:0,maxDown:0,broken:false});
        }
      }
    }
  }
  report() {
    const unresolved=[...this.runs.values()].filter(x=>x==="pending").length;
    return {schema:1,thresholdsProvisional:true,archivedSessions:this.sessions.size,confirmedBursts:this.eventIds.size,burstSessions:this.eventDays.size,
      initialReviewReady:this.sessions.size>=20 && this.eventIds.size>=100 && this.eventDays.size>=10,
      nextStep:"Reserve later sessions for evaluation; no automatic threshold changes. Review readiness is not statistical proof.",
      thresholdVariations:[...this.thresholdVariations].map(JSON.parse),frames:this.frames,
      provisional:{confirmed:this.confirmedRuns,rejected:this.rejected,unresolved,rejectionRate:this.confirmedRuns+this.rejected?this.rejected/(this.confirmedRuns+this.rejected):null},
      meanConfirmationDelayMs:mean(this.confirmationDelays),ranking:{framesChanged:this.changedRanks,top3Changed:this.top3Changed,comparedFrames:this.frames,baseline:"v1.5 single-hit burst-count ranking on the same recorded observations"},
      coverage:{interruptions:this.interruptions,archiveGaps:this.archiveGaps,missingOrStaleQuotes:this.missingQuotes,totalQuotes:this.observations,meanSourceAgeMs:this.sourceAgeCount?this.sourceAgeTotal/this.sourceAgeCount:null,confirmationsWithoutArchivedFirstHit:this.unmatchedConfirmations},periods:this.periods,
      outcomes:Object.fromEntries([1,5,15].map(m=>[m,{complete:this.outcomes[m].length,incomplete:this.incomplete[m],pending:this.pending.filter(p=>p.minutes===m).length,
        meanReturnPct:mean(this.outcomes[m].map(p=>p.returnPct)),observations:this.outcomes[m]}]))};
  }
}
// Definitions changed at versions 3 and 4. Never mix trigger or anchor definitions
// in confirmation rates or forward paths, even in a shared session/archive.
class DiagnosticReview {
  constructor() {this.versions=new Map();this.sessions=new Set();this.frames=0;}
  consume(frame) {
    const version=Number.isInteger(frame.signalVersion)?frame.signalVersion:2;
    if(!this.versions.has(version))this.versions.set(version,new SignalDiagnosticReview());
    this.versions.get(version).consume(frame);
    if(Array.isArray(frame.observations) && !frame.error) {this.frames++;this.sessions.add(frame.day);}
  }
  report() {
    const summaries=Object.fromEntries([...this.versions].sort(([a],[b])=>a-b).map(([version,review])=>[version,{...review.report(),signalVersion:version,definition:SIGNAL_DEFINITIONS[version] || "Unknown historical signal definition"}]));
    const selected=summaries[SIGNAL_VERSION] || {...new SignalDiagnosticReview().report(),signalVersion:SIGNAL_VERSION,definition:SIGNAL_DEFINITIONS[SIGNAL_VERSION]};
    return {...selected,schema:2,currentSignalVersion:SIGNAL_VERSION,summariesByVersion:summaries,combinedArchive:{sessions:this.sessions.size,frames:this.frames},
      comparisonNote:"Signal definitions are reviewed separately. Retention limits apply to their combined archive."};
  }
}
function retentionSelection(entries,limits=ARCHIVE_LIMITS) {
  const sorted=[...entries].sort((a,b)=>a.day.localeCompare(b.day) || a.at-b.at || a.id.localeCompare(b.id));
  const days=[...new Set(sorted.map(e=>e.day))],keepDays=new Set(days.slice(-limits.sessions));
  let bytes=sorted.reduce((sum,e)=>sum+e.bytes,0),remove=[];
  for(const e of sorted)if(!keepDays.has(e.day) || bytes>limits.bytes) {remove.push(e.id);bytes-=e.bytes;}
  const removed=new Set(remove);
  return {remove,bytes,sessions:new Set(sorted.filter(e=>!removed.has(e.id)).map(e=>e.day)).size};
}
const idbRequest=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error || new Error("Local archive request failed"));});
const idbDone=tx=>new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error || new Error("Local archive transaction aborted"));tx.onerror=()=>{};});
class DiagnosticArchive {
  constructor({indexedDB=globalThis.indexedDB,name="groww-strategy-diagnostics-v2",onStatus=()=>{}}={}) {
    this.indexedDB=indexedDB;this.name=name;this.onStatus=onStatus;this.tail=Promise.resolve();this.buffer=[];this.error=null;this.sequence=0;
  }
  async open() {
    if(this.db)return this.db;
    if(!this.indexedDB)throw new Error("Local diagnostic storage unavailable");
    if(!this.opening)this.opening=new Promise((resolve,reject)=>{
      const req=this.indexedDB.open(this.name,1);
      req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore("chunks",{keyPath:"id"});db.createObjectStore("index",{keyPath:"id"});};
      req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error("Local diagnostic storage is blocked by another tab"));
      req.onsuccess=()=>{this.db=req.result;this.db.onversionchange=()=>{this.db.close();this.db=null;this.opening=null;};resolve(this.db);};
    }).catch(e=>{this.opening=null;throw e;});
    return this.opening;
  }
  append(frame) {
    // At most one minute is buffered; compression amortizes repeated symbols across polls.
    this.buffer.push(frame);
    if(this.buffer.length>=6 || this.buffer[0].day!==frame.day || frame.at-this.buffer[0].at>=60_000)return this.flush();
    return Promise.resolve();
  }
  flush() {
    if(!this.buffer.length)return this.tail;
    const frames=this.buffer.splice(0);
    this.tail=this.tail.then(()=>this.write(frames)).then(()=>{this.error=null;this.onStatus(null);}).catch(e=>{
      this.error=e.message || "Local diagnostic archive unavailable";this.onStatus(this.error);
    });
    return this.tail;
  }
  async write(frames) {
    const groups=Object.groupBy?Object.groupBy(frames,f=>f.day):frames.reduce((o,f)=>{(o[f.day] ||= []).push(f);return o;},{});
    for(const [day,group] of Object.entries(groups)) {
      const text=group.map(f=>JSON.stringify(f)).join("\n")+"\n";
      const compressed=typeof CompressionStream==="function";
      const blob=new Blob([text]),payload=compressed?await new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob():blob;
      const entry={id:`${day}:${group[0].at}:${crypto.randomUUID()}`,day,at:group[0].at,bytes:payload.size+256,frames:group.length};
      const db=await this.open(),tx=db.transaction(["chunks","index"],"readwrite"),done=idbDone(tx);
      tx.objectStore("chunks").put({...entry,encoding:compressed?"gzip":"text",payload});tx.objectStore("index").put(entry);
      await done;
    }
    await this.prune();
  }
  async prune() {
    const db=await this.open(),tx=db.transaction(["chunks","index"],"readwrite"),done=idbDone(tx);
    try {
      const entries=await idbRequest(tx.objectStore("index").getAll()),selection=retentionSelection(entries);
      for(const id of selection.remove) {tx.objectStore("chunks").delete(id);tx.objectStore("index").delete(id);}
      await done;
    } catch(e) {await done.catch(()=>{});throw e;}
  }
  async export() {
    await this.flush();
    const db=await this.open(),tx=db.transaction("chunks","readonly"),done=idbDone(tx);
    const chunks=await idbRequest(tx.objectStore("chunks").getAll());await done;
    chunks.sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id));
    const review=new DiagnosticReview(),parts=[];
    for(const chunk of chunks) {
      const text=chunk.encoding==="gzip"?await new Response(chunk.payload.stream().pipeThrough(new DecompressionStream("gzip"))).text():await chunk.payload.text();
      for(const line of text.trim().split("\n"))if(line) {const frame=JSON.parse(line);review.consume(frame);parts.push(line+"\n");}
    }
    const report=review.report();
    const header={type:"groww-strategy-diagnostics",schema:3,signalVersion:SIGNAL_VERSION,exportedAt:Date.now(),columns:OBSERVATION_COLUMNS,
      columnsBySchema:{1:LEGACY_OBSERVATION_COLUMNS,2:V3_OBSERVATION_COLUMNS,3:OBSERVATION_COLUMNS},signalDefinitions:SIGNAL_DEFINITIONS,limits:ARCHIVE_LIMITS,
      thresholds:SPIKE_THRESHOLDS,report,archiveError:this.error,notes:"Public observations only. Coverage is limited to the visible monitored list. Historical peaks and outcomes are not trade profits."};
    return {blob:new Blob([JSON.stringify(header)+"\n",...parts],{type:"application/x-ndjson"}),report};
  }
}

// The installed bundle contains this controller, the pure core and public providers.
const STYLE = ":host{display:block;color:#edf3f1;font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Arial,sans-serif;color-scheme:dark;margin:20px 0 32px;--green:#31d3a3;--muted:#8d9e98;--line:#2a3731;--bg:#111915}*{box-sizing:border-box}button,input,select{font:inherit}button,a,input,select{outline-offset:4px}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}button,a{touch-action:manipulation}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}.identity{display:flex;align-items:center;gap:10px}.mark{display:grid;place-items:center;background:#133c2f;color:var(--green);width:36px;height:36px;border-radius:10px;font-size:20px;font-weight:700}.brand{font-size:15px;font-weight:650}.small{font-size:12px;color:var(--muted)}.toggle{display:flex;padding:4px;background:#19241f;border:1px solid var(--line);border-radius:12px}.toggle button{border:0;background:transparent;color:var(--muted);padding:8px 18px;border-radius:8px}.toggle button[aria-pressed=true]{background:#d7f8eb;color:#102b20;font-weight:650}.panel{border:1px solid var(--line);border-radius:16px;background:var(--bg);overflow:hidden}.intro{padding:24px 26px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap}h2{font-size:23px;line-height:1.3;margin:0 0 6px;font-weight:650;letter-spacing:-.5px}p{margin:0}.status{display:flex;gap:8px;align-items:center;color:#b7c7bf;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:#a4afa9}.dot.live{background:var(--green);box-shadow:0 0 0 4px #29d39a16}.stats{display:flex;gap:0;flex-wrap:wrap;padding:18px 26px;border-bottom:1px solid var(--line)}.stat{min-width:160px;padding-right:35px}.stat strong{font-size:25px;line-height:1.3;display:block;letter-spacing:-.8px;font-weight:600}.stat span{color:var(--muted);font-size:12px}.toolbar{padding:14px 26px;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--line)}.toolbar-group{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.btn{border:1px solid #37473e;border-radius:8px;padding:7px 12px;background:#1b2921;color:#e8f0eb}.btn:hover{background:#273c2f}.btn.primary{background:#173d2e;color:#72e7bd;border-color:#2d6850}.check{display:flex;align-items:center;gap:7px;cursor:pointer;white-space:nowrap}input[type=checkbox]{accent-color:var(--green);width:15px;height:15px}.pill{display:inline-flex;gap:5px;align-items:center;border:1px solid var(--line);padding:3px 7px;border-radius:6px;font-size:11px;white-space:nowrap;color:#aabbb1;background:#1b2720}.pill.green{color:#73e6b6;background:#123629;border-color:#235b42}.pill.red{color:#ffaaa2;background:#3b2421;border-color:#6a3833}.pill.amber{color:#edcb8d;background:#352e20;border-color:#5c4b2d}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left;table-layout:auto}th{font-weight:500;color:var(--muted);font-size:12px;padding:12px 18px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:17px 18px;border-bottom:1px solid #243029;vertical-align:top}tbody tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.stock-cell{min-width:180px}.stock-name{font-weight:600;font-size:14px;color:#eef4f0}.stock-meta{font-size:11px;color:var(--muted);margin-top:3px}.rank{color:#71887a;margin-right:7px}.price{font-size:14px;font-weight:500}.positive{color:#54d8a6}.negative{color:#f19489}.spikes{min-width:230px;max-width:350px}.tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:5px}.spike-tag{border-radius:6px;background:#12392a;color:#6fe2ae;border:1px solid #266043;font-size:11px;padding:4px 6px;display:inline-block}.spike-tag time{color:#8cb6a0;margin-left:4px}.reason{margin:0 0 5px}.candidate{background:#15322555}.candidate .stock-name{color:#83edbd}.empty{padding:38px 22px;text-align:center;color:#a5b4ac}.empty strong{color:#edf3f1;display:block;margin-bottom:6px}.note{padding:13px 26px;color:#94a79a;font-size:12px;background:#142019}.notice{padding:12px 26px;background:#342b1e;color:#e8c58a;border-bottom:1px solid #5a492c;font-size:12px}.notice.error{background:#352420;color:#efb1a7}.options-cell{padding:0!important}.options{padding:22px 26px;background:#18251d;border-top:1px solid #35513e}.options-header{display:flex;gap:18px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:14px}.options h3{font-size:17px;margin:0 0 3px}.options table{font-size:12px;min-width:900px}.options td,.options th{padding:9px 10px;border-color:#344336}.options select{padding:7px;background:#111e16;color:#ecf3ee;border:1px solid #435547;border-radius:6px}.fail-reason{font-size:11px;color:#c8ab85;max-width:220px;white-space:normal}.settings{padding:20px 26px;border-bottom:1px solid var(--line);background:#18251e}.settings-grid{display:flex;gap:14px;flex-wrap:wrap;align-items:end}.settings label{display:block;font-size:12px;color:#b8c6bc}.settings input{display:block;width:125px;border:1px solid #435549;border-radius:6px;background:#0e1912;color:white;margin-top:4px;padding:7px}.footer{padding:14px 26px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;color:#839b8b;font-size:11px;border-top:1px solid var(--line)}details summary{cursor:pointer;color:#a6b9ac}.spinner{color:#c5d5cb;font-size:12px}.help{max-width:760px;white-space:normal;line-height:1.8}.inactive{font-size:12px;color:#95a89c;padding:10px 0}.options .num{white-space:nowrap}.loading{padding:32px 26px;color:#b6c7bb}.loading:before{content:\"\";display:inline-block;width:12px;height:12px;border:2px solid #4b7860;border-top-color:#95e4b6;border-radius:50%;margin-right:10px;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.loading:before{animation:none}}@media(max-width:760px){.intro,.toolbar,.stats,.footer,.note,.notice,.settings{padding-left:16px;padding-right:16px}.stat{min-width:105px;padding-right:15px}.stat strong{font-size:21px}.spikes{min-width:190px}th,td{padding:12px}h2{font-size:20px}.bar{gap:10px}.options{padding:16px}} \n\n.explain-tag{text-align:left;line-height:1.5}.explain-tag:hover{filter:brightness(1.2);text-decoration:underline;text-underline-offset:3px}.explain-tag:focus-visible{outline:2px solid #a0edcd}.direct-options{display:block;font-size:11px;margin-top:8px;white-space:nowrap}.tag-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;border:1px solid #456552;border-radius:16px;background:#15241b;color:#e5f0e8;padding:24px;box-shadow:0 24px 90px #0009;font:14px/1.65 -apple-system,BlinkMacSystemFont,\"Segoe UI\",Arial,sans-serif}.tag-dialog::backdrop{background:#000a;backdrop-filter:blur(3px)}.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}.dialog-head h2{font-size:20px;margin:0}.tag-dialog p{margin:12px 0}.tag-dialog dl{margin:18px 0;border-top:1px solid #344a3c}.tag-dialog dl>div{display:flex;justify-content:space-between;gap:24px;padding:8px 0;border-bottom:1px solid #344a3c}.tag-dialog dt{color:#9fb6a6}.tag-dialog dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}.tag-dialog .btn{flex:none}\n\n.stock-row{cursor:pointer;outline-offset:-2px}.stock-row:focus-visible{outline:2px solid #a0edcd}.stock-row:hover{background:#1c302380}.stock-row.selected{box-shadow:inset 3px 0 #6be4b4;background:#1c362880}.stock-open{border:0;background:none;padding:0;text-align:left;line-height:1.5}.stock-open:hover{text-decoration:underline;text-underline-offset:3px}.calls-cell{min-width:132px}.calls-cell .btn{white-space:nowrap}.calls-drawer{position:fixed;z-index:2147483000;top:12px;right:12px;bottom:12px;width:min(510px,calc(100vw - 24px));display:flex;flex-direction:column;background:#101c15;border:1px solid #486d55;border-radius:16px;box-shadow:-14px 0 70px #0009;outline:none}.calls-head{padding:18px 20px 14px;display:flex;gap:16px;align-items:flex-start;justify-content:space-between;border-bottom:1px solid var(--line);flex:none}.calls-head h2{font-size:20px;letter-spacing:-.3px;margin-bottom:5px}.calls-head .btn{padding:4px 9px;flex:none}.calls-body{overflow:auto;overscroll-behavior:contain;flex:1;padding:16px 20px;scrollbar-gutter:stable}.call-controls{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.call-controls select{background:#182c20;border:1px solid #3a5944;border-radius:6px;padding:6px;color:#f1f5f2;margin-left:5px}.call-source{font-size:11px;line-height:1.8;color:#91aa99;margin-bottom:9px}.call-source strong{color:#d9e8de;font-weight:500}.call-state{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:9px 0 14px}.call-state .small{font-size:11px}.snapshot-notice{background:#352f20;border:1px solid #5c4b2e;color:#e2c68e;padding:8px 10px;border-radius:7px;font-size:12px;margin:0 0 12px}.call-cards{display:grid;gap:12px}.call-card{padding:14px;background:#17271c;border:1px solid #344b39;border-radius:12px}.call-card.call-live{border-color:#2c6749}.call-card-head{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px}.call-card h3{display:flex;align-items:center;gap:9px;margin:0;font-size:16px;font-weight:600}.call-index{display:inline-grid;place-items:center;width:23px;height:23px;border-radius:6px;background:#2b4332;color:#a1c9af;font-size:12px;font-weight:500}.distance{font-size:12px;color:#a2c8b2;white-space:nowrap}.call-money{display:grid;grid-template-columns:1fr 1.3fr;gap:8px}.call-money>div{display:flex;flex-direction:column}.call-money strong{font-size:23px;font-weight:600;line-height:1.4;letter-spacing:-.6px;font-variant-numeric:tabular-nums}.call-money .small{font-size:11px}.profit-block{text-align:right}.ltp-reference{margin:7px 0;color:#9bad9e;font-size:11px}.call-bottom{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.call-bottom .small{font-size:11px}.call-bottom strong{color:#c0d5c7;font-weight:500}.call-depth{margin-top:9px;border-top:1px solid #2f4736;padding-top:7px;font-size:11px}.call-depth summary{color:#a0b5a8}.call-depth dl{margin:8px 0 0}.call-depth dl>div{display:flex;gap:16px;justify-content:space-between;padding:5px 0;border-bottom:1px solid #2b3e30}.call-depth dt{color:#819e8a}.call-depth dd{margin:0;text-align:right;color:#c4d6ca;font-variant-numeric:tabular-nums}.failed-checks{margin-top:8px;color:#d5b67d}.calls-foot{padding:12px 20px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;flex:none}.chain-link{font-size:12px;font-weight:500}.calls-foot .small{font-size:10px}.more-calls{width:100%;margin-top:14px}.call-count{margin-top:10px;font-size:11px}.payoff-note{font-size:11px;color:#92a898;line-height:1.7;margin:15px 0 0}.calls-body .notice{padding:12px;border:1px solid #66422f;border-radius:8px}.calls-body .empty{padding:25px 8px}.calls-body .loading{padding:25px 0}@media(max-width:560px){.calls-drawer{top:6px;right:6px;bottom:6px;width:calc(100vw - 12px);border-radius:12px}.calls-head{padding:14px}.calls-body{padding:12px 14px}.calls-foot{padding:10px 14px}.call-money strong{font-size:22px}.call-card{padding:12px}.call-state .small{max-width:100%}}\n\n.calls-head{padding:14px 18px 11px}.calls-head h2{font-size:19px}.calls-head .small{font-size:11px}.calls-body{padding:12px 18px}.call-controls{margin-bottom:8px}.call-controls .btn{padding:5px 10px}.call-controls select{padding:5px}.call-source{line-height:1.6;margin-bottom:6px}.call-state{margin:6px 0 11px}.call-cards{gap:10px}.call-card{padding:11px 12px}.call-card-head{margin-bottom:5px}.call-money strong{font-size:22px;line-height:1.25}.ltp-reference{margin:5px 0;font-size:10px}.call-card-status{float:right;margin-top:4px}.call-depth{margin-top:5px;padding-top:4px}.call-depth summary{line-height:24px;font-size:11px}.call-depth dl{clear:both}.call-card .pill{font-size:10px;padding:2px 6px}.call-count{margin-top:8px}.payoff-note{margin-top:12px}.calls-foot{padding:10px 18px}\n\n.calls-cell .btn{display:inline-flex;white-space:nowrap}.source-checks{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:6px 0}.source-checks .small{font-size:10px}.failed-checks{font-size:11px;line-height:1.5;margin:6px 0;color:#e3c087}.range-exception{margin:3px 0 7px}.call-depth dd{overflow-wrap:anywhere;max-width:64%}.settings label.near-setting{display:flex;align-items:center;gap:8px;margin-top:14px}.settings .near-setting input{display:inline-block;width:15px;height:15px;margin:0}.near-setting input{accent-color:var(--green)}\n\n.coverage-line{padding:10px 26px;border-bottom:1px solid var(--line);line-height:1.6}.current-returns{max-width:300px;font-variant-numeric:tabular-nums;line-height:1.7}.pattern-tags{margin-top:6px}.pattern-details{margin-top:5px;color:#9bac9f;font-size:11px}.pattern-details>summary{cursor:pointer;line-height:1.7}.pattern-details>.tags{margin-top:7px}.pattern-details .spike-tag{font-size:10px}.burst-count{font-size:11px}.spikes{min-width:280px}.spikes .pill{white-space:normal;text-align:left}\n\n.export-ready{padding:12px 26px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)}\n.rise-value{display:block;border:0;background:transparent;color:#c6d6cd;padding:0;margin:0 0 2px;text-align:left;font-size:22px;line-height:1.35;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.5px}.rise-value.positive{color:#54d8a6}.rise-value:hover{text-decoration:underline;text-underline-offset:3px}.spikes>.tags{margin-top:7px}.sample-context{font-size:10px;line-height:1.7}.stats .stat{padding-bottom:5px}\n.table-scroll table{table-layout:fixed;min-width:1120px}.table-scroll th:nth-child(1){width:18%}.table-scroll th:nth-child(2){width:29%}.table-scroll th:nth-child(3){width:13%}.table-scroll th:nth-child(4){width:10%}.table-scroll th:nth-child(5){width:17%}.table-scroll th:nth-child(6){width:13%}.table-scroll td:nth-child(5) .pill{white-space:normal}\n.quote-warning{color:#e2c68e;white-space:normal;max-width:145px}\n\n.scanner-pipeline{list-style:none;margin:0;padding:16px 26px 10px;display:grid;grid-template-columns:repeat(5,minmax(116px,1fr));gap:8px;overflow-x:auto;border-top:0}.scanner-pipeline>li{min-width:0;position:relative}.pipeline-step,.pipeline-source{width:100%;height:100%;min-height:112px;display:flex;flex-direction:column;align-items:flex-start;text-align:left;border:1px solid #32463c;border-radius:10px;padding:10px 12px;background:#14201a;color:#d8e5de;gap:2px}.pipeline-source{background:#111b16;color:#98ada2}.pipeline-step:hover{border-color:#70c9a7;background:#1a2d23}.pipeline-step[aria-pressed=true]{border-color:#53d4a5;background:#173c2b;box-shadow:inset 0 0 0 1px #53d4a5}.pipeline-step strong,.pipeline-source strong{font-size:25px;line-height:1.2;font-variant-numeric:tabular-nums}.pipeline-step>span:not(.step-number),.pipeline-source>span:not(.step-number){font-size:13px;font-weight:600}.pipeline-step small,.pipeline-source small{font-size:10px;color:#91aaa0;line-height:1.4}.step-number{font-size:10px;color:#8aa99a;line-height:1.1}.pipeline-help{padding:0 26px 13px;display:flex;justify-content:space-between;gap:5px 16px;flex-wrap:wrap;color:var(--muted);font-size:11px;border-bottom:1px solid var(--line)}.pipeline-help strong{font-weight:500;color:#bccfc4}.view-label{font-size:12px;color:var(--muted)}.view-label strong{color:#d7eee1}.data-health{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:10px 26px;color:#9fb6a9;font-size:12px;border-bottom:1px solid var(--line)}.data-health strong{color:#d5eadd;font-variant-numeric:tabular-nums}.data-details{padding:9px 26px;border-bottom:1px solid var(--line);font-size:11px;color:#98ada2}.data-details>summary{cursor:pointer}.data-details ul{padding-left:18px;line-height:1.7}.data-details p{margin:8px 0}.filter-summary{padding:10px 26px;background:#1d2a22;border-bottom:1px solid var(--line);font-size:12px;color:#b6cabd;display:flex;gap:10px;align-items:center;flex-wrap:wrap}.filter-summary .btn{margin-left:auto;font-size:11px;padding:5px 9px}.empty p{margin:8px 0 13px}.waiting-value{font-size:15px;letter-spacing:0;color:#d9bf83}.waiting-detail{line-height:1.5;max-width:285px}.quote-warning{font-size:10px}.pipeline-step:focus-visible{outline:2px solid #b1f6d8;outline-offset:2px}@media(max-width:600px){.scanner-pipeline{grid-template-columns:repeat(5,132px);padding:12px 14px 10px}.pipeline-help,.data-health,.data-details,.filter-summary{padding-left:14px;padding-right:14px}}\n.scanner-pipeline>li:not(:last-child)::after{content:'›';position:absolute;right:-7px;top:45px;z-index:1;color:#85a695;font-size:20px;pointer-events:none}\n/* Prevent the browser from moving the page to follow a row as ranks change. */\n:host{overflow-anchor:none}.table-scroll{overflow-anchor:none}\n.status{display:flex;flex-direction:column;align-items:flex-start;gap:3px;max-width:390px;font-variant-numeric:tabular-nums}.monitor-heading{display:flex;align-items:center;gap:9px}.monitor-heading strong{font-size:12px;font-weight:600;color:#d4e9dd}.background-note{font-size:10px;color:#88a195;line-height:1.6}\n";
const HOST_ID = "groww-strategy-view-v1";
const routeMatches = () => location.pathname.replace(/\/$/,"")==="/futures-and-options/top-gainers";
const collectorLockName = () => "groww-strategy-collector-v1"+(location.hostname==="127.0.0.1"?`-preview-${new URLSearchParams(location.search).get("scenario") || "normal"}`:"");
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const moneyFormatter = new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2,minimumFractionDigits:2});
const countFormatter = new Intl.NumberFormat("en-IN",{maximumFractionDigits:0});
const clockFormatter = new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
const money = value => value===null || value===undefined ? "—" : moneyFormatter.format(value);
const count = value => value===null || value===undefined ? "—" : countFormatter.format(value);
const percent = value => value===null || value===undefined ? "—" : `${value>=0?"+":""}${value.toFixed(2)}%`;
const riseText = value => value===null || value===undefined ? "Unavailable" : value>0 && value<0.01 ? "<0.01% rise" : `${percent(value)}${value>0?" rise":""}`;
const clockCache=new Map();
const clockText = value => {
  if(!value)return "—";
  let text=clockCache.get(value);
  if(!text){text=clockFormatter.format(value);clockCache.set(value,text);if(clockCache.size>128)clockCache.delete(clockCache.keys().next().value);}
  return text;
};
const dateTimeText = value => value ? `${istDay(value)} ${clockText(value)} IST` : "Unavailable";
const tagButton = (html,info,className="pill") => `<button type="button" class="${className} explain-tag" data-action="explain" ${info.lazy?`data-explain-kind="${escapeHTML(info.lazy.kind)}" data-explain-symbol="${escapeHTML(info.lazy.symbol || "")}" data-explain-label="${escapeHTML(info.lazy.label || "")}"${info.lazy.event?` data-explain-event="${escapeHTML(info.lazy.event)}"`:""}${info.lazy.strike?` data-explain-strike="${escapeHTML(info.lazy.strike)}"`:""}`:`data-explanation="${escapeHTML(JSON.stringify(info))}"`} aria-label="Explain ${escapeHTML(info.title)}" title="Click for explanation">${html}</button>`;
const pill = (text,tone="",info=null) => info ? tagButton(escapeHTML(text),typeof info==="string"?{title:text,paragraphs:[info]}:{title:text,...info},`pill ${tone}`) : `<span class="pill ${tone}">${escapeHTML(text)}</span>`;
// Keep live rows and their interactive descendants mounted. The next tree is a small
// shell; stock rows are reconciled separately and unchanged cells are never parsed.
const domKey = node => {
  if(node.nodeType!==1)return null;
  const explicit=node.getAttribute("data-ui-key") || node.id;if(explicit)return explicit;
  if(node.tagName==="TR" && node.dataset.symbol)return `stock:${node.dataset.symbol}`;
  if(node.tagName==="DETAILS")return node.dataset.strike?`strike:${node.dataset.strike}`:node.dataset.patterns?`patterns:${node.dataset.patterns}`:null;
  if(node.tagName==="BUTTON" && node.dataset.action)return `button:${node.dataset.action}:${node.dataset.mode || ""}:${node.dataset.symbol || node.dataset.explainSymbol || ""}:${node.dataset.explainKind || ""}:${node.dataset.explainLabel || node.getAttribute("aria-label") || ""}:${node.dataset.explainEvent || ""}`;
  return null;
};
const htmlText = html => [...html.matchAll(/>([^<]+)(?=<)/g)].map(match=>match[1].replace(/&(?:amp|lt|gt|quot|#39);/g,value=>({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&#39;":"'"}[value])));
function patchCellText(node,previousHTML,nextHTML) {
  if(previousHTML.replace(/>[^<]*</g,"><")!==nextHTML.replace(/>[^<]*</g,"><"))return false;
  const previous=htmlText(previousHTML),values=htmlText(nextHTML),nodes=[];
  if(previous.length!==values.length)return false;
  if(node.ownerDocument?.createTreeWalker) {
    const walker=node.ownerDocument.createTreeWalker(node,4);let text;while((text=walker.nextNode()))nodes.push(text);
  } else {
    const visit=element=>{for(const child of element.childNodes)if(child.nodeType===3)nodes.push(child);else visit(child);};visit(node);
  }
  // A mismatch means the browser normalized the markup or an interaction changed
  // its structure. Fall back to the full safe DOM reconciliation in that case.
  if(nodes.length!==values.length || nodes.some((text,i)=>text.nodeValue!==previous[i]))return false;
  for(let i=0;i<nodes.length;i++)if(nodes[i].nodeValue!==values[i])nodes[i].nodeValue=values[i];
  return true;
}
function patchDOMNode(current,next) {
  if(current.isEqualNode?.(next))return current;
  if(current.nodeType!==next.nodeType || current.nodeType===1 && current.tagName!==next.tagName) {current.replaceWith(next);return next;}
  if(current.nodeType!==1) {if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return current;}
  const keepOpen=current.tagName==="DETAILS" && current.open;
  for(const attr of [...current.attributes])if(attr.name!=="open" && !next.hasAttribute(attr.name))current.removeAttribute(attr.name);
  for(const attr of [...next.attributes])if(attr.name!=="open" && current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
  if(current.matches("input[type=checkbox]"))current.checked=next.checked;
  if(current.getAttribute("data-ui-list")!=="stocks")patchDOMChildren(current,next);
  if(keepOpen)current.open=true;
  return current;
}
function patchDOMChildren(current,next) {
  const keyed=new Map([...current.childNodes].map(node=>[domKey(node),node]).filter(([key])=>key));
  let cursor=current.firstChild;
  const retained=new Set();
  for(const nextNode of [...next.childNodes]) {
    const key=domKey(nextNode);
    let node=key?keyed.get(key):cursor && !domKey(cursor)?cursor:null;
    if(node && (node.nodeType!==nextNode.nodeType || node.nodeType===1 && node.tagName!==nextNode.tagName))node=null;
    if(node)node=patchDOMNode(node,nextNode);else node=nextNode;
    if(node!==cursor)current.insertBefore(node,cursor);else cursor=cursor.nextSibling;
    retained.add(node);
  }
  for(const node of [...current.childNodes])if(!retained.has(node))node.remove();
}
const storage = {
  get:(key,fallback)=>Promise.resolve(GM_getValue(CACHE_PREFIX+key,fallback)),
  set:(key,value)=>Promise.resolve(GM_setValue(CACHE_PREFIX+key,value)),
};
function cleanSettings(value) {
  const s={...DEFAULTS,scannerView:"all",filterVersion:1,eligibleOnly:false};
  if (!value || typeof value!=="object") return s;
  s.mode=value.mode==="groww"?"groww":"strategy";
  // The old checkbox mixed stock eligibility with changing option availability.
  // Migrate it to the stable, results-clear watchlist once; focused views are explicit.
  s.scannerView=["all","stock","rising","calls"].includes(value.scannerView)?value.scannerView:"all";
  s.nearTarget=value.nearTarget!==false;
  for (const k of ["minDay","minDistance"]) {
    const v=numeric(value[k]);if (v!==null && v>=0 && v<=100) s[k]=v;
  }
  return s;
}
function scannerPipeline(rows,fresh,open=true) {
  const stock=rows.filter(row=>open && fresh && row.check.pass);
  const rising=stock.filter(row=>row.spikes.one?.ready && row.spikes.one.pct>0);
  return {all:rows,stock,rising,calls:rising.filter(row=>row.option.pass)};
}
function monitoringPresentation({collector,visibility,owner,now,updatedAt,latestSourceAt,freshPrices,total,market,cooldown}) {
  const sourceAgeSeconds=latestSourceAt?Math.max(0,Math.floor((now-latestSourceAt)/1000)):null;
  const sourceFresh=Number.isFinite(latestSourceAt) && latestSourceAt>0 && now-latestSourceAt<=30_000 && latestSourceAt<=now+10_000;
  const live=!!market.open && sourceFresh && freshPrices>0 && now-updatedAt<=30_000 && updatedAt<=now+10_000 && !(cooldown?.until>now);
  let status=!market.open?market.label:collector?(visibility==="hidden"?"Monitoring in background · 10s target":"Monitoring · 10s target"):
    owner && live?"Updated by another Strategy tab":"Connecting to collector";
  if(market.open && total && (!freshPrices || !sourceFresh))status="Monitoring · waiting for fresh source prices";
  if(cooldown?.until>now)status=`Sampling paused · retry ${clockText(cooldown.until)} IST`;
  const detail=latestSourceAt?`Latest source ${clockText(latestSourceAt)} IST · ${sourceAgeSeconds}s old`:"Waiting for the first verified source price";
  return {status,detail,live,sourceAgeSeconds};
}
function momentumPresentation(stock,spikes,now,market) {
  if(!market.open)return {label:"Snapshot only",detail:market.label || "Market closed",tone:"",reason:"closed"};
  const reason=spikes.one?.reason || spikes.coverage?.reason;
  if(!spikes.one?.ready) {
    if(reason==="stale")return {label:"Waiting for fresh price",detail:`Last verified price kept · source ${clockText(stock.quoteAt)} IST. Momentum is paused.`,tone:"amber",reason};
    if(reason==="gap")return {label:"Rebuilding 1m history",detail:"A source gap exceeded 30s. Collecting a continuous minute again.",tone:"amber",reason};
    if(reason==="inconsistent")return {label:"Rechecking quote",detail:"Source values disagree. Last verified price kept; momentum is paused.",tone:"amber",reason};
    if(reason==="missing-anchor")return {label:"Waiting for comparison",detail:"No real sample within 10s of the 60s comparison point. Waiting for the next quote.",tone:"amber",reason};
    if(reason==="warming") {
      const elapsed=spikes.coverage?.since?Math.max(0,Math.floor(((spikes.coverage.lastQuoteAt || now)-spikes.coverage.since)/1000)):0;
      return {label:"Building first minute",detail:`${Math.min(60,elapsed)}s of 60s collected. New arrivals start here.`,tone:"amber",reason};
    }
    return {label:"Waiting for price",detail:"No usable source quote yet. Last verified values stay visible when available.",tone:"amber",reason:reason || "unavailable"};
  }
  return {label:spikes.confirmed?"Strong rise confirmed":spikes.verifying?"Strong rise · verifying":spikes.one.pct>0?"Rising now":spikes.one.pct<0?"Falling now":"Flat now",
    detail:`${spikes.one.seconds}s observed · ${clockText(spikes.one.endAt)} IST`,tone:spikes.confirmed?"green":spikes.verifying?"amber":"",reason:"complete"};
}
function safeEngine(saved) {
  if (saved?.source!==PRICE_SOURCE || !saved?.states || typeof saved.states!=="object") return new SpikeEngine();
  const states={};
  for (const [key,s] of Object.entries(saved.states)) {
    if (!Array.isArray(s.samples) || !Array.isArray(s.events)) continue;
    if (s.samples.some(p=>!Number.isFinite(p.t) || !(p.p>0)) || s.events.some(e=>!Number.isFinite(e.lastSeen) || !Number.isFinite(e.firstSeen))) continue;
    states[key]=s;
  }
  return new SpikeEngine({day:saved.day,states,signalVersion:saved.signalVersion});
}
// Every Strategy entry point uses the same fail-closed calendar rule, including restored/cross-tab snapshots.
function scrubResults(snapshot,now=Date.now(),membership=null,onWithhold=()=>{}) {
  const original=snapshot.stocks || [],all=membership || original;
  const checks=all.map(stock=>({stock,result:resultsCheck(stock,snapshot.calendar,snapshot.window,now)}));
  if (membership || checks.some(x=>!x.result.pass) || snapshot.resultsExcludedCount===undefined) {
    snapshot.resultsExcludedCount=checks.filter(x=>!x.result.pass&&!x.result.unknown).length;
    snapshot.resultsUnavailableCount=checks.filter(x=>x.result.unknown).length;
    snapshot.membershipCount=all.length;
  }
  const bySymbol=new Map(Object.values(snapshot.identities || {}).map(stock=>[stock.symbol,stock]));
  const canonical=value=>value?.priceSource===PRICE_SOURCE && value.spot>0 && value.previousClose>0 && Number.isFinite(value.quoteAt) && value.quoteAt<=now+10_000;
  const retainIdentity=(stock,authoritative=false)=>{
    if(!stock?.symbol)return;
    const previous=bySymbol.get(stock.symbol);
    if(previous && stockKey(previous)!==stockKey(stock)){if(authoritative)bySymbol.set(stock.symbol,stock);return;}
    if(!previous || canonical(stock) && (!canonical(previous) || stock.quoteAt>previous.quoteAt || stock.quoteAt===previous.quoteAt && stock.quoteConflictAt && !previous.quoteConflictAt))bySymbol.set(stock.symbol,stock);
  };
  for(const state of Object.values(snapshot.engine?.states || {}))if(state.identity)retainIdentity(state.identity);
  for(const stock of original)retainIdentity(stock,true);
  for(const option of Object.values(snapshot.options || {}))if(option.stockRef)retainIdentity(option.stockRef);
  const identities=new Map([...bySymbol.values()].map(stock=>[stockKey(stock),stock]));
  snapshot.stocks=original.filter(stock=>{
    const allowed=resultsAllowed(stock,snapshot.calendar,snapshot.window,now);
    if(!allowed)onWithhold(stock);
    return allowed;
  });
  for(const field of ["options","optionSummaries"])snapshot[field]=Object.fromEntries(Object.entries(snapshot[field] || {}).filter(([key,value])=>{
    const symbol=value?.symbol || key.split("|")[0],stock=value?.stockRef || bySymbol.get(symbol);
    const allowed=!!stock && resultsAllowed(stock,snapshot.calendar,snapshot.window,now);
    if(!allowed)onWithhold(stock || {symbol});return allowed;
  }));
  snapshot.identities=Object.fromEntries([...bySymbol].filter(([_symbol,stock])=>resultsAllowed(stock,snapshot.calendar,snapshot.window,now)));
  const currentKeys=new Set(snapshot.stocks.map(stockKey));
  if(snapshot.signals)snapshot.signals=Object.fromEntries(Object.entries(snapshot.signals).filter(([key])=>currentKeys.has(key)));
  if(snapshot.engine?.states)for(const [key,state] of Object.entries(snapshot.engine.states)) {
    const stock=identities.get(key) || state.identity;
    if(!stock || !resultsAllowed(stock,snapshot.calendar,snapshot.window,now)) {
      if(stock)onWithhold(stock);delete snapshot.engine.states[key];
    }
  }
  return snapshot;
}
class StrategyApp {
  constructor() {
    this.id=crypto.randomUUID();this.settings={...DEFAULTS};this.host=null;this.root=null;
    this.snapshot={stocks:[],options:{},updatedAt:0};this.selectedSymbol=null;this.selectedStock=null;this.callLimit=3;this.selectedExpiries={};
    this.nativeNodes=new Map();this.collector=null;this.lockPending=false;this.releaseLock=null;
    this.settingsOpen=false;this.uiError="";this.alive=true;this.explanation=null;this.explanationTrigger=null;
    this.activePointers=new Set();this.renderPending=false;this.pendingRenderForce=false;this.renderFlushTimer=null;
    this.renderedRoot=null;this.renderedHTML=null;this.exporting=false;this.diagnosticError=null;
    this.rowHTMLCache=new Map();this.optionStatusCache=new WeakMap();this.signalCache=new Map();this.pendingRows=[];
    this.renderHistory=[];
    this.archive=new DiagnosticArchive({name:"groww-strategy-diagnostics-v2"+(location.hostname==="127.0.0.1"?"-preview-"+new URLSearchParams(location.search).get("scenario"):""),
      onStatus:error=>{this.diagnosticError=error;this.render();}});
  }
  async start() {
    const savedSettings=await storage.get("settings",DEFAULTS);
    this.filterMigrationNotice=savedSettings?.filterVersion!==1 && savedSettings?.eligibleOnly===true;
    this.settings=cleanSettings(savedSettings);
    if(savedSettings?.filterVersion!==1)await storage.set("settings",this.settings);
    this.snapshot=await storage.get("snapshot",this.snapshot);
    if (!Array.isArray(this.snapshot?.stocks) || typeof this.snapshot?.options!=="object") this.snapshot={stocks:[],options:{},updatedAt:0};
    if (this.snapshot.pricingVersion!==2) {
      this.snapshot={...this.snapshot,stocks:this.snapshot.stocks.map(s=>({...s,priceSource:"legacy",quoteAt:null,priceError:"Updating Groww quote…"})),options:{},engine:null};
    }
    const [cachedCalendar,cachedHolidays]=await Promise.all([storage.get("calendar",null),storage.get("holidays",null)]);
    this.adoptCalendar(cachedCalendar,cachedHolidays);
    this.acceptSnapshot(this.snapshot);
    GM_addValueChangeListener(CACHE_PREFIX+"snapshot",(_key,_old,value)=>{
      if (value && Array.isArray(value.stocks) && !(value.owner===this.id && value.revision===this.snapshot.revision)) {const removed=this.acceptSnapshot(value);this.render(removed);}
    });
    GM_addValueChangeListener(CACHE_PREFIX+"command",(_key,_old,value)=>{
      if(value?.action==="foreground-collector")this.yieldCollector(value);
      else if (this.collector && value) this.collector.command(value);
    });
    GM_addValueChangeListener(CACHE_PREFIX+"calendar",(_key,_old,value)=>{
      if(this.adoptCalendar(value,this.collector?.state.holidays || this.snapshot.holidays))this.render(true);
    });
    GM_addValueChangeListener(CACHE_PREFIX+"settings",(_key,_old,value)=>{
      this.settings=cleanSettings(value);this.applyNativeVisibility();this.render();this.coordinate();
      if (this.collector) this.collector.prefetch();
    });
    const observer=new MutationObserver(()=>this.mount());
    observer.observe(document.body,{childList:true,subtree:true});
    this.mount();
    this.coordinatorTimer=setInterval(()=>{this.mount();this.coordinate();this.render();},2000);
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState!=="visible"){finishPointer({type:"blur"});this.coordinate();}
      else this.resumeMonitoring();
      this.render();
    });
    // A frozen page cannot service timers. Stop synchronously before releasing
    // its lock so callbacks delivered on resume cannot revive an old collector.
    document.addEventListener("freeze",()=>{this.lifecycleSuspended=true;try{this.collector?.stop();}finally{this.releaseLock?.();}});
    document.addEventListener("resume",()=>{this.lifecycleSuspended=false;this.resumeMonitoring();this.render();});
    const finishPointer=event=>{
      if (event?.type==="blur") this.activePointers.clear();
      else this.activePointers.delete(event.pointerId);
      if (this.activePointers.size || !this.renderPending)return;
      clearTimeout(this.renderFlushTimer);
      // Wait until the click following pointerup has used its original target.
      this.renderFlushTimer=setTimeout(()=>{
        this.renderFlushTimer=null;
        if (!this.activePointers.size && this.renderPending)this.render(this.pendingRenderForce);
      },0);
    };
    window.addEventListener("pointerup",finishPointer,true);
    window.addEventListener("pointercancel",finishPointer,true);
    window.addEventListener("blur",finishPointer);
    window.addEventListener("pagehide",()=>{this.activePointers.clear();clearTimeout(this.renderFlushTimer);this.stop();});
    window.addEventListener("pageshow",event=>{
      if (!event.persisted)return;
      this.alive=true;this.lifecycleSuspended=false;
      clearInterval(this.coordinatorTimer);
      this.coordinatorTimer=setInterval(()=>{this.mount();this.coordinate();this.render();},2000);
      this.mount();this.coordinate();this.render(true);
    });
    this.coordinate();
  }
  acceptSnapshot(value) {
    const previous=this.snapshot.stocks || [];
    const staleOwner=(value.ownerStartedAt || 0)<(this.snapshot.ownerStartedAt || 0) ||
      value.owner===this.snapshot.owner && Number.isFinite(value.revision) && Number.isFinite(this.snapshot.revision) && value.revision<this.snapshot.revision;
    if(staleOwner) {
      if((value.calendar?.fetchedAt || 0)<=(this.snapshot.calendar?.fetchedAt || 0))return false;
      value={...this.snapshot,calendar:value.calendar,window:value.window,holidays:value.holidays};
    }
    // A delayed write from another tab cannot replace a newer calendar decision.
    if((this.snapshot.calendar?.fetchedAt || 0)>(value.calendar?.fetchedAt || 0)) {
      value={...value,calendar:this.snapshot.calendar,window:this.snapshot.window,holidays:this.snapshot.holidays};
    }
    this.snapshot=scrubResults(value);
    const cleared=this.pruneSelection();
    if(this.collector && (this.snapshot.calendar?.fetchedAt || 0)>(this.collector.state.calendar?.fetchedAt || 0)) {
      Object.assign(this.collector.state,{calendar:this.snapshot.calendar,window:this.snapshot.window,holidays:this.snapshot.holidays});
      this.collector.enforceResults();
    }
    return cleared || previous.some(stock=>!resultsAllowed(stock,this.snapshot.calendar,this.snapshot.window,Date.now()));
  }
  adoptCalendar(calendar,holidays) {
    if(!calendar || calendar.day!==istDay(Date.now()) || (calendar.fetchedAt || 0)<=(this.snapshot.calendar?.fetchedAt || 0))return false;
    let window=this.snapshot.window;
    try {if(holidays)window=sessionWindow(istDay(Date.now()),holidays);} catch {window=null;}
    this.acceptSnapshot({...this.snapshot,calendar,window,holidays:holidays || this.snapshot.holidays});
    return true;
  }
  pruneSelection() {
    const previousSymbol=this.selectedSymbol,previousExplanation=this.explanation;
    if(this.selectedStock && !resultsAllowed(this.selectedStock,this.snapshot.calendar,this.snapshot.window,Date.now())) {
      delete this.selectedExpiries[this.selectedSymbol];this.selectedSymbol=null;this.selectedStock=null;this.explanation=null;
    }
    // Explanations are current UI too: never leave an excluded stock's details open.
    if(this.explanation?.title) {
      const symbol=this.explanation.title.split(" · ")[0];
      const available=[...this.snapshot.stocks,...(this.selectedStock?[this.selectedStock]:[])];
      if(!available.some(stock=>stock.symbol===symbol || this.explanation.title.startsWith(stock.symbol+" ")) && this.explanation.title.includes(" · "))this.explanation=null;
    }
    return previousSymbol!==this.selectedSymbol || previousExplanation!==this.explanation;
  }
  mount() {
    if (!routeMatches()) {if(this.host)this.host.hidden=true;this.restoreNative(false);this.coordinate();return;}
    if (this.host?.isConnected) {this.host.hidden=false;this.applyNativeVisibility();return;}
    this.restoreNative();
    const heading=[...document.querySelectorAll("h1")].find(el=>/F&O\s*Top Gainers/i.test(el.textContent));
    const table=[...document.querySelectorAll("table")].find(el=>/Stocks/.test(el.textContent) && /Price/.test(el.textContent));
    if (!heading || !table) return;
    let parent=heading.parentElement;
    while (parent && !parent.contains(table)) parent=parent.parentElement;
    if (!parent || parent===document.body) return;
    const headingBranch=[...parent.children].find(el=>el===heading || el.contains(heading));
    const tableBranch=[...parent.children].find(el=>el===table || el.contains(table));
    this.host=document.createElement("section");this.host.id=HOST_ID;
    this.root=this.host.attachShadow({mode:"open"});
    if (headingBranch && headingBranch!==tableBranch) headingBranch.after(this.host);
    else parent.insertBefore(this.host,tableBranch || table);
    // Hide the original data area only. Its React nodes remain intact and restorable.
    let between=false;
    for (const el of [...parent.children]) {
      if (el===headingBranch) {between=true;continue;}
      if (el===this.host || ["STYLE","SCRIPT"].includes(el.tagName)) continue;
      if (el===tableBranch || (between && tableBranch && el.compareDocumentPosition(tableBranch)&Node.DOCUMENT_POSITION_FOLLOWING)) {
        if (!el.contains(heading)) this.nativeNodes.set(el,{value:el.style.getPropertyValue("display"),priority:el.style.getPropertyPriority("display")});
      }
      if (el===tableBranch) break;
    }
    if (!this.nativeNodes.size) this.nativeNodes.set(table,{value:table.style.getPropertyValue("display"),priority:table.style.getPropertyPriority("display")});
    this.root.addEventListener("click",event=>this.click(event));
    this.root.addEventListener("pointerdown",event=>this.activePointers.add(event.pointerId),true);
    this.root.addEventListener("pointermove",event=>{
      if(event.target.closest('tr[data-action="open-calls"]'))this.rowInteractionUntil=Date.now()+500;
    },{passive:true});
    this.root.addEventListener("change",event=>this.change(event));
    this.root.addEventListener("submit",event=>this.submit(event));
    this.root.addEventListener("cancel",event=>{if(event.target.matches("dialog")){event.preventDefault();this.closeExplanation();}},true);
    this.root.addEventListener("keydown",event=>{
      if (event.key==="Escape" && this.selectedSymbol && !this.explanation && !event.target.matches("select,input")) {event.preventDefault();this.closeCalls();}
      if (["Enter"," "].includes(event.key) && event.target.matches('tr[data-action="open-calls"]')) {event.preventDefault();this.click(event);}
    });
    this.applyNativeVisibility();this.render(true);
  }
  restoreNative(clear=true) {
    for (const [node,old] of this.nativeNodes) {
      if (old.value) node.style.setProperty("display",old.value,old.priority);else node.style.removeProperty("display");
    }
    if (clear) this.nativeNodes.clear();
  }
  applyNativeVisibility() {
    for (const [node,old] of this.nativeNodes) {
      if (this.settings.mode==="strategy" && routeMatches()) {if(node.style.getPropertyValue("display")!=="none")node.style.setProperty("display","none","important");}
      else if (old.value) node.style.setProperty("display",old.value,old.priority);else if(node.style.getPropertyValue("display")) node.style.removeProperty("display");
    }
  }
  wantsCollector() {return this.alive && !this.lifecycleSuspended && routeMatches() && this.settings.mode==="strategy";}
  resumeMonitoring() {
    if(!this.wantsCollector() || document.visibilityState!=="visible")return;
    this.coordinate();this.collector?.resume();
  }
  requestForegroundCollector() {
    if(document.visibilityState!=="visible" || !this.wantsCollector() || Date.now()-(this.foregroundRequestAt || 0)<10_000)return;
    this.foregroundRequestAt=Date.now();
    storage.set("command",{id:crypto.randomUUID(),action:"foreground-collector",requester:this.id,at:Date.now()})
      .catch(error=>{this.uiError=`Collector handover: ${error.message}`;});
  }
  async yieldCollector(command) {
    const now=Date.now(),collector=this.collector;
    if(command?.action!=="foreground-collector" || !command.requester || command.requester===this.id ||
        !Number.isFinite(command.at) || now-command.at>15_000 || command.at>now+10_000 ||
        document.visibilityState==="visible" || !collector || this.handingOver)return;
    this.handingOver=true;this.yieldUntil=now+5000;
    let deadline;
    try {
      const writes=[];
      try {
        collector.flushRecord();
        writes.push(collector.checkpoint(),collector.publish(true),this.archive.flush());
      } finally {collector.stop({drainWrites:true});}
      await Promise.race([Promise.allSettled(writes),new Promise(resolve=>{deadline=setTimeout(resolve,1500);})]);
    } catch(error){this.uiError=`Collector handover: ${error.message}`;}
    finally {
      clearTimeout(deadline);try{collector.stop();}finally{this.releaseLock?.();this.handingOver=false;}
    }
  }
  coordinate() {
    if (!this.wantsCollector()) {this.releaseLock?.();return;}
    if(this.handingOver || document.visibilityState!=="visible" && Date.now()<(this.yieldUntil || 0))return;
    if(document.visibilityState==="visible")this.refreshSelectedCalls();
    if (this.collector || this.lockPending) return;
    if (!navigator.locks) {this.uiError="This browser cannot coordinate collectors. Use current Chrome or Edge with Tampermonkey.";return;}
    this.lockPending=true;
    navigator.locks.request(collectorLockName(),{ifAvailable:true},async lock=>{
      this.lockPending=false;
      if (!lock){this.requestForegroundCollector();return;}
      if (!this.wantsCollector() || this.handingOver || document.visibilityState!=="visible" && Date.now()<(this.yieldUntil || 0))return;
      const collector=new Collector(this);this.collector=collector;
      try {
        await new Promise(resolve=>{
          this.releaseLock=resolve;
          collector.start().catch(e=>{this.uiError=e.message;this.render();resolve();});
        });
      } finally {try{collector.stop();}finally{this.collector=null;this.releaseLock=null;this.render();}}
    }).catch(e=>{this.lockPending=false;this.uiError=`Collector unavailable: ${e.message}`;this.render();});
  }
  refreshSelectedCalls() {
    if (!this.selectedStock)return;
    if (!resultsAllowed(this.selectedStock,this.snapshot.calendar,this.snapshot.window,Date.now())) {this.pruneSelection();return;}
    const now=Date.now(),market=marketState(now,this.snapshot.holidays),snapshot=this.getOptions(this.selectedStock);
    if (!market.open || snapshot?.loading || now-(this.selectedPollAt || 0)<10_000)return;
    const refresh=optionRefreshPolicy(snapshot,now,market);
    if (!refresh.due && now-(snapshot?.fetchedAt || 0)<10_000 && (snapshot?.loadedLimit || 0)>=this.callLimit)return;
    this.selectedPollAt=now;
    this.send("options",{symbol:this.selectedSymbol,expiry:this.selectedExpiries[this.selectedSymbol] || null,force:refresh.force,limit:this.callLimit});
  }
  async saveSettings() {await storage.set("settings",this.settings);this.applyNativeVisibility();this.render(true);this.coordinate();}
  async send(action,data={}) {
    if(action==="options") {
      const stock=this.snapshot.stocks.find(stock=>stock.symbol===data.symbol) || (this.selectedStock?.symbol===data.symbol?this.selectedStock:null);
      if(!stock || !resultsAllowed(stock,this.snapshot.calendar,this.snapshot.window,Date.now()))return;
      data={...data,identity:stock,selected:true,requester:this.id};
    }
    this.uiError="";
    const command={id:crypto.randomUUID(),at:Date.now(),action,...data};
    if (this.collector) {const work=this.collector.command(command);if(action==="flush-archive")await work;}
    else {await storage.set("command",command);this.coordinate();}
    this.render(true);return command;
  }
  async exportDiagnostics() {
    if(this.exporting)return;this.exporting=true;this.render(true);
    try {
      const command=await this.send("flush-archive");
      if(!this.collector) {
        const deadline=performance.now()+5000;
        while(this.snapshot.diagnosticsFlushId!==command.id && performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
        if(this.snapshot.diagnosticsFlushId!==command.id)throw new Error("The collector did not respond. Keep a Strategy tab visible and retry export.");
      }
      const result=await this.archive.export();
      if(this.diagnosticDownload)URL.revokeObjectURL(this.diagnosticDownload.url);
      this.diagnosticDownload={url:URL.createObjectURL(result.blob),filename:`groww-spike-diagnostics-${istDay(Date.now())}.jsonl`};
      this.uiError=`Diagnostic export prepared: ${result.report.archivedSessions} sessions, ${result.report.confirmedBursts} confirmed bursts. ${result.report.initialReviewReady?"Initial review minimum reached; thresholds remain provisional.":"Initial review needs 20 sessions, 100 bursts across at least 10 sessions."}`;
    } catch(e) {this.uiError=`Diagnostic export unavailable: ${e.message}`;}
    finally {this.exporting=false;this.render(true);}
  }
  click(event) {
    const button=event.target.closest("button[data-action]") || (!event.target.closest("a,input,select,label,summary,details") && event.target.closest("tr[data-action]"));if (!button)return;
    const action=button.dataset.action;
    if (action==="explain") {
      try {this.explanation=button.dataset.explainKind?this.resolveExplanation(button.dataset):JSON.parse(button.dataset.explanation);if(!this.explanation)return;this.explanationTrigger=button.getAttribute("aria-label");this.render(true);} catch {}
      return;
    }
    if (action==="close-explanation") {this.closeExplanation();return;}
    if (action==="mode") {this.settings.mode=button.dataset.mode;this.saveSettings();}
    if (action==="scanner-view" && ["all","stock","rising","calls"].includes(button.dataset.view)) {
      this.settings.scannerView=button.dataset.view;this.settings.filterVersion=1;this.settings.eligibleOnly=false;this.filterMigrationNotice=false;this.saveSettings();
    }
    if (action==="settings") {this.settingsOpen=!this.settingsOpen;this.render(true);}
    if (action==="calendar") this.send("calendar");
    if (action==="refresh") this.send("refresh");
    if (action==="export-diagnostics")this.exportDiagnostics();
    if (action==="open-calls") {
      const symbol=button.dataset.symbol;
      const stock=this.snapshot.stocks.find(s=>s.symbol===symbol);if(!stock || !resultsAllowed(stock,this.snapshot.calendar,this.snapshot.window,Date.now()))return;
      if(this.selectedSymbol!==symbol){this.callLimit=3;this.resetCallScroll=true;}
      this.selectedSymbol=symbol;this.selectedStock=stock;this.render(true);
      this.selectedPollAt=Date.now();
      this.root.querySelector(".calls-drawer")?.focus({preventScroll:true});
      this.send("options",{symbol,expiry:this.selectedExpiries[symbol] || null,limit:this.callLimit});
    }
    if (action==="close-calls") this.closeCalls();
    if (action==="more-calls") {this.callLimit+=3;this.render(true);this.send("options",{symbol:this.selectedSymbol,expiry:this.selectedExpiries[this.selectedSymbol] || null,limit:this.callLimit});}
    if (action==="options") this.send("options",{symbol:button.dataset.symbol,expiry:this.selectedExpiries[button.dataset.symbol] || null,force:true,limit:this.callLimit});
  }
  closeCalls() {
    const symbol=this.selectedSymbol;this.selectedSymbol=null;this.selectedStock=null;this.render(true);
    [...this.root.querySelectorAll('tr[data-action="open-calls"]')].find(el=>el.dataset.symbol===symbol)?.focus({preventScroll:true});
  }
  closeExplanation() {
    this.root.querySelector("dialog")?.close();this.explanation=null;this.render(true);
    [...this.root.querySelectorAll('[data-action="explain"]')].find(el=>el.getAttribute("aria-label")===this.explanationTrigger)?.focus();
  }
  change(event) {
    if (event.target.name==="expiry") {
      const symbol=event.target.dataset.symbol;
      this.selectedExpiries[symbol]=event.target.value;
      this.callLimit=3;this.resetCallScroll=true;
      this.send("options",{symbol,expiry:event.target.value});
    }
  }
  submit(event) {
    if (event.target.id!=="threshold-form")return;event.preventDefault();
    const data=new FormData(event.target), settings={...this.settings};
    for (const key of ["minDay","minDistance"]) {
      const value=numeric(data.get(key));
      if (value===null || value<0 || value>100) {this.uiError="Enter valid non-negative thresholds.";this.render(true);return;}
      settings[key]=value;
    }
    settings.nearTarget=data.has("nearTarget");
    this.settings=settings;this.callLimit=3;this.settingsOpen=false;this.saveSettings();
  }
  getOptions(stock) {
    if(!this.resultsFor(stock,this.renderTime ?? Date.now()).pass)return null;
    const expiry=this.selectedExpiries[stock.symbol];
    return this.snapshot.options?.[`${stock.symbol}|${expiry || "nearest"}`] ||
      (expiry ? Object.values(this.snapshot.options || {}).find(x=>x.symbol===stock.symbol && x.expiry===expiry && !x.error) : null) ||
      this.snapshot.optionSummaries?.[`${stock.symbol}|${expiry || "nearest"}`] || null;
  }
  resultsFor(stock,now) {
    const state=this.snapshot;
    if(this.resultsClock!==now){this.resultsClock=now;this.resultsDay=istDay(now);}
    const key=`${state.window?.from}|${state.window?.to}|${this.resultsDay}`;
    if(this.resultsCalendar!==state.calendar || this.resultsContext!==key) {this.resultsCalendar=state.calendar;this.resultsContext=key;this.resultsCache=new Map();}
    const stockId=`${stock.gsin || ""}|${stock.searchId || ""}`;
    let check=this.resultsCache.get(stockId);
    if(!check){check=resultsCheck(stock,state.calendar,state.window,now);this.resultsCache.set(stockId,check);}
    return check;
  }
  signalFor(stock,now) {
    let signal=this.snapshot.signals?.[stockKey(stock)];
    if(!signal) {
      if(this.legacySignalSource!==this.snapshot.engine) {this.legacySignalSource=this.snapshot.engine;this.legacySignalEngine=safeEngine(this.snapshot.engine);this.signalCache.clear();}
      const key=`${stockKey(stock)}:${stock.quoteAt || 0}:${quoteFresh(stock,now)}`;
      if(this.signalCache.size>400)this.signalCache.clear();
      if(!this.signalCache.has(key))this.signalCache.set(key,(this.legacySignalEngine || safeEngine(null)).view(stock,now));
      signal=this.signalCache.get(key);
    }
    const events=(signal.events || []).filter(event=>now-event.lastSeen<15*MINUTE);
    if(events.length!==(signal.events || []).length || signal.peakOne?.ready && now-signal.peakOne.observedAt>=MINUTE)
      signal={...signal,events,peakOne:signal.peakOne?.ready&&now-signal.peakOne.observedAt>=MINUTE?{ready:false}:signal.peakOne,patterns:{...signal.patterns,repeated:events.length>=2}};
    if(quoteFresh(stock,now))return signal;
    const reason=stock.quoteConflictAt?"inconsistent":stock.priceError?"unavailable":stock.quoteAt?"stale":"unavailable";
    return {...signal,one:{...signal.one,ready:false,reason},five:{...signal.five,ready:false},fifteen:{...signal.fifteen,ready:false},confirmed:false,verifying:false,active:false,status:reason==="inconsistent"?"Inconsistent quote":reason==="stale"?"Quote stale":"Quote unavailable",coverage:{...signal.coverage,valid:false,reason}};
  }
  optionFor(stock,now,market) {
    const snapshot=this.getOptions(stock);
    if(!snapshot)return optionStatus(null,this.settings,now,market);
    const settingsKey=`${this.settings.minDistance}:${this.settings.nearTarget}:${market.open}`;
    const cached=this.optionStatusCache.get(snapshot);
    if(cached?.key===settingsKey && now>=cached.at && now<cached.until)return cached.value;
    const value=optionStatus(snapshot,this.settings,now,market);
    const expiries=[snapshot.spotQuoteAt+30_001,snapshot.asOf+120_001,snapshot.fetchedAt+120_001,...(snapshot.items || []).map(item=>item.bookAt+60_001)].filter(at=>Number.isFinite(at) && at>now);
    this.optionStatusCache.set(snapshot,{key:settingsKey,at:now,until:Math.min(now+30_000,...expiries),value});
    return value;
  }
  lazyInfo(kind,stock,label,event=null,strike=null) {
    return {title:`${stock.symbol} · ${label}`,lazy:{kind,symbol:stock.symbol,label,event,strike}};
  }
  resolveExplanation(data) {
    const stock=this.snapshot.stocks.find(s=>s.symbol===data.explainSymbol) || (this.selectedStock?.symbol===data.explainSymbol?this.selectedStock:null);
    if(!stock || !resultsAllowed(stock,this.snapshot.calendar,this.snapshot.window,Date.now()))return null;
    const spikes=this.signalFor(stock,Date.now());
    if(data.explainKind==="momentum")return this.momentumInfo(stock,spikes,data.explainLabel);
    if(data.explainKind==="burst")return this.burstInfo(stock,spikes.events,spikes.events.find(e=>String(e.id)===data.explainEvent));
    if(data.explainKind==="check")return this.checkInfo(stock,stockCheck(stock,this.snapshot.calendar,this.snapshot.window,Date.now(),this.settings),data.explainLabel);
    if(data.explainKind==="call")return this.callInfo(stock);
    if(data.explainKind==="reference")return this.referenceInfo(stock,this.getOptions(stock)?.items?.find(item=>String(item.strike)===data.explainStrike) || {});
    return null;
  }
  pipelineHTML(flow,state,view) {
    const steps=[["all","All monitored",flow.all.length,"Results clear"],["stock","Stock eligible",flow.stock.length,`Day > +${this.settings.minDay}% + fresh price`],
      ["rising","Rising now",flow.rising.length,"Positive current 1m return"],["calls","Calls ready",flow.calls.length,"Rising + fresh qualifying call"]];
    return `<ol class="scanner-pipeline" aria-label="Scanner pipeline"><li class="pipeline-source"><span class="step-number">1</span><strong>${state.membershipCount ?? flow.all.length}</strong><span>Groww list</span><small>Current 15-minute gainers</small></li>${steps.map(([key,label,total,detail],index)=>`<li><button type="button" data-action="scanner-view" data-view="${key}" data-ui-key="pipeline-${key}" aria-pressed="${view===key}" aria-label="Show ${label.toLowerCase()}" class="pipeline-step"><span class="step-number">${index+2}</span><strong>${total}</strong><span>${label}</span><small>${detail}</small></button></li>`).join("")}</ol>
      <div class="pipeline-help"><span>${state.resultsExcludedCount || 0} hidden for results${state.resultsUnavailableCount?` · ${state.resultsUnavailableCount} withheld until the calendar is verified`:""}. Click a stage to narrow the view.</span><span><strong>All monitored keeps waiting rows visible.</strong> Calls refreshing cannot empty that view.</span></div>`;
  }
  scannerEmptyHTML(flow,state,view) {
    if(flow.all.length)return `<div class="empty"><strong>No ${view==="calls"?"rising stocks with fresh qualifying calls":view==="rising"?"stocks rising in 1m": "stocks passing the daily and fresh-price checks"} right now</strong><p>${flow.all.length} results-clear stocks are still monitored. This stage is a filter; the price history has not been cleared.</p><button class="btn" data-action="scanner-view" data-view="all">Show all monitored (${flow.all.length})</button></div>`;
    if(state.resultsUnavailableCount)return '<div class="empty"><strong>Waiting for results calendar</strong><p>Stocks are withheld until today’s results coverage is verified. This mandatory check cannot be bypassed.</p><button class="btn" data-action="calendar">Refresh calendar</button></div>';
    if(state.resultsExcludedCount)return '<div class="empty"><strong>Current candidates excluded for results</strong><p>The results gate hides these stocks from every Strategy view. Waiting for the next Groww list.</p></div>';
    return '<div class="empty"><strong>Groww’s current candidate list is empty</strong><p>Waiting for the next 15-minute gainers refresh. Stocks that leave this list are no longer scanner candidates; a selected calls panel can remain open.</p></div>';
  }
  render(force=false) {
    if (!this.root)return;
    const timing=typeof performance!=="undefined"?()=>performance.now():()=>Date.now(),started=timing();
    const removed=(this.snapshot.stocks || []).some(stock=>!this.resultsFor(stock,Date.now()).pass);
    if(removed)scrubResults(this.snapshot);force=this.pruneSelection() || force;
    // Collection and exclusion gates continue off-screen; paint only the latest
    // state on return instead of repeatedly building an invisible table.
    if(!force && typeof document!=="undefined" && document.visibilityState==="hidden" && this.renderedRoot===this.root){this.renderPending=true;return;}
    if (this.activePointers.size && !removed && !force) {this.renderPending=true;this.pendingRenderForce=this.pendingRenderForce || force;return;}
    force=force || removed;
    if (!force && (this.explanation || this.root.activeElement?.closest("form")))return;
    this.renderPending=false;this.pendingRenderForce=false;
    const focusedNode=this.root.activeElement,focusId=focusedNode?.id,focusLabel=focusedNode?.getAttribute("aria-label");
    const priorCallBody=this.root.querySelector(".calls-body"),priorTable=this.root.getElementById("strategy-table-scroll");
    const callScroll=this.resetCallScroll?0:(priorCallBody?.scrollTop || 0);
    const tableScroll=priorTable?.scrollLeft || 0;
    const openDetails=force?[...this.root.querySelectorAll("details[data-strike][open]")].map(el=>el.dataset.strike):[];
    const openPatterns=force?[...this.root.querySelectorAll("details[data-patterns][open]")].map(el=>el.dataset.patterns):[];
    this.resetCallScroll=false;
    const now=Date.now(), state=this.snapshot, market=marketState(now,state.holidays);
    this.renderTime=now;
    const signals=new Map((state.stocks || []).map(stock=>[stockKey(stock),this.signalFor(stock,now)]));
    const opening=Date.parse(`${istDay(now)}T09:15:00+05:30`);
    const fresh=state.updatedAt>=opening && now-state.updatedAt<=30_000 && state.updatedAt<=now+10_000;
    const rowData=(state.stocks || []).map(stock=>{const check=stockCheck(stock,state.calendar,state.window,now,this.settings,this.resultsFor(stock,now));
      return {stock,spikes:signals.get(stockKey(stock)),check,option:this.optionFor(stock,now,market)};}).sort((a,b)=>{
        const av=a.spikes.one?.ready&&Number.isFinite(a.spikes.one.pct),bv=b.spikes.one?.ready&&Number.isFinite(b.spikes.one.pct);
        return Number(b.check.pass)-Number(a.check.pass) || Number(bv)-Number(av) ||
          (av&&bv ? b.spikes.one.pct-a.spikes.one.pct || (b.spikes.coverage.lastQuoteAt || b.stock.quoteAt || 0)-(a.spikes.coverage.lastQuoteAt || a.stock.quoteAt || 0):0) || a.stock.rank-b.stock.rank;
      });
    const flow=scannerPipeline(rowData,fresh,market.open),view=["all","stock","rising","calls"].includes(this.settings.scannerView)?this.settings.scannerView:"all";
    const leader=!state.membershipStale?flow.calls[0]:null;
    const visible=flow[view];
    if(this.selectedStock) this.selectedStock=state.stocks.find(s=>s.symbol===this.selectedSymbol) || state.identities?.[this.selectedSymbol] || this.selectedStock;
    const selected=rowData.find(x=>x.stock.symbol===this.selectedSymbol) || (this.selectedStock&&resultsAllowed(this.selectedStock,state.calendar,state.window,now)?{stock:this.selectedStock,leftMembership:true,
      check:stockCheck(this.selectedStock,state.calendar,state.window,now,this.settings),option:this.optionFor(this.selectedStock,now,market)}:null);
    const priceFreshCount=rowData.filter(x=>quoteFresh(x.stock,now)).length;
    const readyCount=rowData.filter(x=>x.spikes.one.ready).length;
    const tagTotal=rowData.reduce((sum,x)=>sum+x.spikes.events.length,0);
    const monitoring=monitoringPresentation({collector:!!this.collector?.running,visibility:document.visibilityState,owner:state.owner,
      now,updatedAt:state.updatedAt,latestSourceAt:Math.max(0,...rowData.map(row=>row.stock.quoteAt || 0)),freshPrices:priceFreshCount,total:rowData.length,market,cooldown:state.samplingCooldown});
    let status=monitoring.status;
    if (!navigator.locks) status="Collector unsupported";
    const notices=[];
    if (!market.open && (market.known || state.updatedAt || state.calendarError)) notices.push(`${market.label}. Showing available snapshots; no live candidates qualify.`);
    if (market.open && !fresh && state.updatedAt && !rowData.length) notices.push("Waiting for a fresh stock-price batch. Live eligibility is paused.");
    if (state.error && !rowData.length) notices.push(state.error);
    if(state.membershipError)notices.push(`Gainers list refresh: ${state.membershipError}. ${state.membershipStale?"Automatic calls paused until membership is verified.":"Continuing with the last verified list."}`);
    else if(state.membershipStale)notices.push("Gainers membership has not been verified for at least five minutes. Automatic call checks and the Top eligible highlight are paused; fresh daily-change grouping and manual call panels remain available.");
    if(market.open && rowData.length && priceFreshCount<rowData.length)notices.push(`${rowData.length-priceFreshCount} stocks are waiting for a fresh or usable Groww price. Last verified values are kept, but their live momentum and call eligibility are paused. Use All monitored to keep these rows visible.`);
    if(state.samplingCooldown?.until>now)notices.push(`${state.samplingCooldown.label || "Groww rate limit"}. Stock sampling resumes after ${clockText(state.samplingCooldown.until)} IST.`);
    if (state.resultsUnavailableCount) notices.push(`Results check unavailable. ${state.resultsUnavailableCount} stocks withheld until valid coverage is available today.`);
    if (state.calendarError) notices.push(`Calendar refresh: ${state.calendarError}${state.calendar?.day===istDay(now)?". Using the last successful scan from today.":""}`);
    if (this.uiError) notices.push(this.uiError);
    if (this.diagnosticError || state.diagnosticError)notices.push(`Diagnostic archive: ${this.diagnosticError || state.diagnosticError}. Price monitoring continues.`);
    const dataPrepared=timing();
    const intro=`<div class="bar"><div class="identity"><span class="mark" aria-hidden="true">↗</span><div><div class="brand">Strategy view</div><div class="small">F&O research companion</div></div></div><div class="toggle" role="group" aria-label="Page view"><button data-action="mode" data-mode="groww" aria-pressed="${this.settings.mode==="groww"}">Groww</button><button data-action="mode" data-mode="strategy" aria-pressed="${this.settings.mode==="strategy"}">Strategy view</button></div></div>`;
    if (this.settings.mode==="groww") {this.commitHTML(`<style>${STYLE}</style>${intro}<p class="inactive">Strategy collection paused. Switch back to resume; missing history warms up again.</p>`);this.renderTime=null;return;}
    const html=`<style>${STYLE}</style>${intro}<section class="panel" aria-label="Strategy dashboard">
      <div class="intro"><div><h2>One-minute spike scanner</h2><p class="small">Day > +${this.settings.minDay}% first · largest current 1m rise first</p><p class="small">Groww’s 15-minute gainers · stock name → stock page · row → calls here</p></div><div class="status" data-ui-key="monitor-status"><div class="monitor-heading"><span class="dot ${monitoring.live?"live":""}"></span><strong>${escapeHTML(status)}</strong></div><div>${escapeHTML(monitoring.detail)}</div><div class="small">Batch received ${clockText(state.updatedAt)} IST${state.membershipUpdatedAt?` · list verified ${Math.max(0,Math.floor((now-state.membershipUpdatedAt)/1000))}s ago`:""}</div><span class="background-note">Tab switching keeps monitoring enabled · browser sleep can interrupt it</span></div></div>
      ${this.pipelineHTML(flow,state,view)}
      <div class="toolbar"><div class="toolbar-group"><span class="view-label">View: <strong>${{all:"All monitored",stock:"Stock eligible",rising:"Rising now",calls:"Calls ready"}[view]}</strong></span>${pill(`Day > +${this.settings.minDay}%`,"",`The stock must currently be strictly above +${this.settings.minDay}% versus its previous close. A 15-minute gainer can still be negative for the day. Equality does not pass.`)}${pill(`Calls ${this.settings.nearTarget?"around":"above"} ${this.settings.minDistance}%`,"",this.distanceInfo())}${pill("Priority order","",{paragraphs:["Stocks with results from the previous NSE trading session through the next, inclusive, are completely hidden. Missing same-day calendar coverage also withholds stocks. No view can override this rule.",`Fresh stock quotes with daily gain strictly above +${this.settings.minDay}% come first. Within each group, valid current one-minute returns sort from largest to smallest immediately, then newest source quote and original Groww rank. Unavailable windows appear last.`,"Every positive one-minute return is visible, even below 1%. Confirmation, historical burst count, five-minute return, recent peak and option IV never boost the order.","At ≥1%/1m the strong-rise badge starts amber. Another qualifying quote 10–30 seconds later confirms persistence in green. It does not independently verify the price or predict reversal. The highlighted row must also have a positive current one-minute return and a fresh qualifying call. Stock eligibility alone does not mean it is rising now."]})}</div><div class="toolbar-group"><button class="btn" data-action="export-diagnostics" ${this.exporting?"disabled":""}>${this.exporting?"Exporting…":"Export diagnostics"}</button><button class="btn" data-action="calendar">Refresh calendar</button><button class="btn" data-action="refresh">Refresh prices</button><button class="btn" data-action="settings" aria-expanded="${this.settingsOpen}">Thresholds</button></div></div>
      ${this.diagnosticDownload?`<div class="export-ready"><a class="btn" href="${escapeHTML(this.diagnosticDownload.url)}" download="${escapeHTML(this.diagnosticDownload.filename)}">Download diagnostic archive (.jsonl)</a><span class="small">Public observations and review summary · saved locally</span></div>`:""}
      <div class="data-health"><span><strong>${priceFreshCount}</strong> fresh prices · <strong>${rowData.length-priceFreshCount}</strong> waiting for price</span><span><strong>${readyCount}</strong> ready 1m comparisons · <strong>${rowData.length-readyCount}</strong> building or waiting</span></div>
      <details class="data-details" data-ui-key="data-details"><summary>Why a stock is waiting · data details</summary><ul><li><strong>Waiting for fresh price:</strong> the source quote is over 30 seconds old. The displayed price is retained; it cannot create a new signal.</li><li><strong>Building first minute:</strong> the stock has just entered monitoring. At least 60 seconds of observations are needed.</li><li><strong>Rebuilding 1m history:</strong> a source gap exceeded 30 seconds. A continuous minute is collected again.</li><li><strong>Waiting for comparison:</strong> no real sample is close enough to the 60-second comparison point. No prices are invented.</li><li><strong>Rechecking quote:</strong> source values conflicted. Waiting for a newer valid quote.</li></ul><p>${rowData.reduce((n,x)=>n+x.spikes.coverage.interruptions,0)} source gaps this session · ${tagTotal} confirmed strong bursts in the last 15m. These totals do not affect priority. Every positive current 1m return can rank, even below 1%.</p>${state.error?`<p>Latest request detail: ${escapeHTML(state.error)}</p>`:""}</details>
      ${this.filterMigrationNotice?'<div class="notice">Eligible only has been replaced by the stages above. Starting in All monitored keeps the watchlist visible while quotes or calls refresh.</div>':""}
      ${view!=="all"?`<div class="filter-summary">Showing ${visible.length} of ${flow.all.length} monitored stocks in <strong>${{stock:"Stock eligible",rising:"Rising now",calls:"Calls ready"}[view]}</strong>. Waiting stocks are hidden by this selected stage.<button class="btn" data-action="scanner-view" data-view="all">Show all monitored</button></div>`:""}
      ${this.settingsOpen?this.settingsHTML():""}
      ${notices.map(text=>`<div class="notice" role="status">${escapeHTML(text)}</div>`).join("")}
      ${leader?`<div class="note">Highest current rise with calls ready: <strong>${escapeHTML(leader.stock.name)}</strong> · rising now, stock checks passed and fresh qualifying call quotes. Reversal assessment remains manual.</div>`:""}
      ${!state.updatedAt&&!state.error?'<div class="loading" role="status">Loading the public gainers feed and results calendar…</div>':`<div class="table-scroll" id="strategy-table-scroll" role="region" aria-label="Scrollable strategy table" tabindex="0"><table aria-label="One-minute rises among 15-minute gainers"><thead><tr><th>Stock / Groww rank</th><th>Rise in ~1m</th><th class="num">Price · NSE</th><th class="num">Day change · NSE</th><th>Day + results checks</th><th>Call options</th></tr></thead><tbody data-ui-list="stocks">${visible.length?"":`<tr><td colspan="6">${this.scannerEmptyHTML(flow,state,view)}</td></tr>`}</tbody></table></div>`}
      <div class="note">Current one-minute returns set priority. Waiting rows keep their last verified prices; historical peaks are context only. Click any tag for its calculation and source times.</div>
      <div class="footer"><span>Calendar ${state.calendar?.fetchedAt?`checked ${escapeHTML(dateTimeText(state.calendar.fetchedAt))}`:"not verified"}${state.window?` · ${escapeHTML(state.window.from)} to ${escapeHTML(state.window.to)}`:""}</span><span>Strong-rise badge: ≥1% / 1m (provisional) · no minimum rise to rank · 10s sampling target · upstream quotes may lag</span></div>
    </section>${selected?this.optionsPanelHTML(selected,market,fresh):""}${this.explanation?this.explanationHTML():""}`;
    this.pendingRows=visible.map(row=>this.prepareRow(row,leader?.stock.symbol,market,fresh));
    const prepared=timing(),changed=this.commitHTML(html),committed=timing();
    this.lastRenderMetrics={stocks:visible.length,prepareMs:prepared-started,dataMs:dataPrepared-started,markupMs:prepared-dataPrepared,commitMs:committed-prepared,...this.lastCommitMetrics,totalMs:committed-started,changed,at:now};
    const finishMetrics=()=>{
      this.renderTime=null;this.lastRenderMetrics.totalMs=timing()-started;
      if(location.hostname==="127.0.0.1" && this.host) {
        const batchAt=state.updatedAt || 0,freshUpdate=batchAt>0 && batchAt!==this.renderedQuoteBatchAt;
        this.renderedQuoteBatchAt=batchAt;
        const record={...this.lastRenderMetrics,quoteBatchAt:batchAt,freshUpdate,sourceAt:Math.max(0,...(state.stocks || []).map(stock=>stock.quoteAt || 0))};
        this.renderHistory.push(record);if(this.renderHistory.length>100)this.renderHistory.shift();
        this.host.dataset.renderMetrics=JSON.stringify(record);this.host.dataset.renderHistory=JSON.stringify(this.renderHistory);
        if(freshUpdate && typeof requestAnimationFrame==="function")requestAnimationFrame(()=>{
          record.paintLatencyMs=Date.now()-(state.processedAt || batchAt);
          if(this.host){this.host.dataset.renderHistory=JSON.stringify(this.renderHistory);this.host.dataset.paintMetrics=JSON.stringify({batchAt,latencyMs:record.paintLatencyMs});}
        });
      }
    };
    if(!changed){finishMetrics();return;}
    const body=this.root.querySelector(".calls-body");if(body && (body!==priorCallBody || body.scrollTop!==callScroll))body.scrollTop=callScroll;
    const table=this.root.getElementById("strategy-table-scroll");if(table && table!==priorTable)table.scrollLeft=tableScroll;
    if(openDetails.length)for(const el of this.root.querySelectorAll("details[data-strike]"))if(openDetails.includes(el.dataset.strike))el.open=true;
    if(openPatterns.length)for(const el of this.root.querySelectorAll("details[data-patterns]"))if(openPatterns.includes(el.dataset.patterns))el.open=true;
    if (this.explanation) this.root.querySelector("dialog")?.showModal();
    else if(focusedNode!==this.root.activeElement || !focusedNode?.isConnected) {
      if(focusId)this.root.getElementById(focusId)?.focus({preventScroll:true});
      else if(focusLabel)[...this.root.querySelectorAll("button[aria-label],select[aria-label],a[aria-label],tr[aria-label]")].find(el=>el.getAttribute("aria-label")===focusLabel)?.focus({preventScroll:true});
    }
    finishMetrics();
  }
  commitHTML(html) {
    const timing=typeof performance!=="undefined"?()=>performance.now():()=>Date.now(),started=timing();
    let changed=false;
    if(this.renderedRoot!==this.root || this.renderedHTML!==html) {
      if(this.renderedRoot!==this.root) {this.root.innerHTML=html;this.rowDOMCache=new Map();this.emptyRowsHTML=this.root.querySelector('tbody[data-ui-list="stocks"]')?.innerHTML || "";}
      else {
        const template=document.createElement("template");template.innerHTML=html;
        this.emptyRowsHTML=template.content.querySelector('tbody[data-ui-list="stocks"]')?.innerHTML || "";
        patchDOMChildren(this.root,template.content);
      }
      this.renderedRoot=this.root;this.renderedHTML=html;changed=true;
    }
    const shellDone=timing(),body=this.root.querySelector('tbody[data-ui-list="stocks"]');
    if(body)changed=this.reconcileRows(body) || changed;
    this.lastCommitMetrics={shellMs:shellDone-started,rowsMs:timing()-shellDone,...this.lastRowMetrics};
    return changed;
  }
  prepareRow(row,leader,market,fresh) {
    const {stock,spikes,check,option}=row,snapshot=this.getOptions(stock);
    const signature=JSON.stringify([stock.name,stock.searchId,stock.rank,stock.spot,stock.dayPct,stock.quoteAt,stock.priceError,stock.quoteWarning,stock.quoteConflictAt,quoteFresh(stock,Date.now()),
      this.settings.minDay,this.settings.minDistance,this.settings.nearTarget,leader===stock.symbol,this.selectedSymbol===stock.symbol,market.open,fresh,
      check.pass,check.reasons,check.results.label,option.pass,option.label,snapshot?.expiry,snapshot?.loading,snapshot?.error,snapshot?.state,
      spikes.one,spikes.five,spikes.fifteen,spikes.latestChange,spikes.peakOne,spikes.status,spikes.confirmed,spikes.verifying,spikes.patterns,
      spikes.events.map(e=>[e.id,e.one,e.five,e.firstSeen])]);
    let cached=this.rowHTMLCache.get(stock.symbol);
    if(cached?.signature!==signature) {
      const html=this.rowHTML(row,leader,market,fresh);
      cached={symbol:stock.symbol,signature,html,cells:html.match(/<td\b[\s\S]*?<\/td>/g) || []};
      this.rowHTMLCache.set(stock.symbol,cached);
    }
    return cached;
  }
  reconcileRows(body) {
    const timing=typeof performance!=="undefined"?()=>performance.now():()=>Date.now();
    const metrics={updatedRows:0,updatedCells:0,textPatchedCells:0,insertedRows:0,movedRows:0,cellParseMs:0,cellPatchMs:0};this.lastRowMetrics=metrics;
    this.rowDOMCache ||= new Map();
    const wanted=new Set(this.pendingRows.map(row=>row.symbol));
    let changed=false,cursor=body.firstChild;
    if(!this.pendingRows.length) {
      const html=this.emptyRowsHTML || "";
      if(body.innerHTML!==html){body.innerHTML=html;changed=true;}
      this.rowDOMCache.clear();return changed;
    }
    let rows=this.pendingRows;
    if(this.rowInteractionUntil>Date.now()) {
      const bySymbol=new Map(rows.map(row=>[row.symbol,row]));
      const existing=[...body.children].map(node=>bySymbol.get(node.dataset.symbol)).filter(Boolean);
      const mounted=new Set(existing.map(row=>row.symbol));rows=[...existing,...rows.filter(row=>!mounted.has(row.symbol))];
      clearTimeout(this.rowOrderTimer);
      this.rowOrderTimer=setTimeout(()=>{this.rowOrderTimer=null;this.render();},Math.max(1,this.rowInteractionUntil-Date.now()+1));
    }
    for(const row of rows) {
      let cached=this.rowDOMCache.get(row.symbol),node=cached?.node;
      if(!node || node.parentNode!==body) {
        const start=timing();
        const table=document.createElement("table");table.innerHTML=`<tbody>${row.html}</tbody>`;node=table.firstElementChild.firstElementChild;
        metrics.cellParseMs+=timing()-start;metrics.insertedRows++;
        cached={node,cells:row.cells,signature:row.signature};this.rowDOMCache.set(row.symbol,cached);changed=true;
      } else if(cached.signature!==row.signature) {
        metrics.updatedRows++;
        for(let i=0;i<row.cells.length;i++)if(cached.cells[i]!==row.cells[i]) {
          const start=timing();
          if(patchCellText(node.children[i],cached.cells[i],row.cells[i])) {
            metrics.cellPatchMs+=timing()-start;metrics.updatedCells++;metrics.textPatchedCells++;continue;
          }
          const table=document.createElement("table");table.innerHTML=`<tbody><tr>${row.cells[i]}</tr></tbody>`;
          const parsed=timing();metrics.cellParseMs+=parsed-start;
          patchDOMNode(node.children[i],table.firstElementChild.firstElementChild.firstElementChild);
          metrics.cellPatchMs+=timing()-parsed;metrics.updatedCells++;
        }
        const selected=this.selectedSymbol===row.symbol;
        node.classList.toggle("selected",selected);node.classList.toggle("candidate",row.html.includes('class="stock-row candidate'));
        node.setAttribute("aria-expanded",String(selected));cached.cells=row.cells;cached.signature=row.signature;changed=true;
      }
      if(node!==cursor){body.insertBefore(node,cursor);metrics.movedRows++;changed=true;}else cursor=cursor.nextSibling;
    }
    for(const node of [...body.children])if(!wanted.has(node.dataset.symbol)){node.remove();changed=true;}
    for(const symbol of this.rowDOMCache.keys())if(!wanted.has(symbol))this.rowDOMCache.delete(symbol);
    for(const symbol of this.rowHTMLCache.keys())if(!wanted.has(symbol))this.rowHTMLCache.delete(symbol);
    return changed;
  }
  explanationHTML() {
    const info=this.explanation;
    return `<dialog class="tag-dialog" aria-labelledby="tag-title"><div class="dialog-head"><h2 id="tag-title">${escapeHTML(info.title)}</h2><button class="btn" data-action="close-explanation" aria-label="Close explanation" autofocus>Close</button></div>${(info.paragraphs || []).map(text=>`<p>${escapeHTML(text)}</p>`).join("")}${info.details?.length?`<dl>${info.details.map(([label,value])=>`<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd></div>`).join("")}</dl>`:""}<p class="small">Live collection continues while this explanation is open. Close it to see the latest table.</p></dialog>`;
  }
  settingsHTML() {
    const fields=[["minDay","Min day gain (%)"],["minDistance","Call strike above spot (%)"]];
    return `<form id="threshold-form" class="settings"><div class="settings-grid">${fields.map(([key,label])=>`<label>${label}<input name="${key}" aria-label="${label}" type="number" min="0" max="100" step="0.01" required value="${this.settings[key]}"></label>`).join("")}<button class="btn primary" type="submit">Apply thresholds</button></div><label class="check near-setting"><input type="checkbox" name="nearTarget" ${this.settings.nearTarget?"checked":""}>Include one near-target call (strictly above ${nearTargetFloor(this.settings)}%)</label><p class="small" style="margin-top:10px">The main distance rule is strike &gt; spot × (1 + target%). The optional exception chooses one nearest strike at/below target, preferring an exact target; otherwise it must be within 0.5 percentage points below target. At 10%, the floor is strictly &gt;9.5%. Calls then continue in listed strike order. This is strike distance, not premium or profit. Liquidity uses Groww’s crossed-droplet flag only; OI, volume, spread and depth are informational.</p></form>`;
  }
  windowDetails(label,change) {
    return change?.ready ? [[label,percent(change.pct)],["Observed interval",`${change.seconds}s`],...(Number.isFinite(change.anchorOffsetSeconds)?[["Anchor offset from 60s",`${change.anchorOffsetSeconds}s`]]:[]),["Start",`${money(change.startPrice)} · ${dateTimeText(change.startAt)}`],["End",`${money(change.endPrice)} · ${dateTimeText(change.endAt)}`]] : [[label,this.coverageLabel(change?.reason).replace(/^1m /,`${label.match(/\b(?:15m|5m|1m)\b/)?.[0] || "History"} `)]];
  }
  coverageLabel(reason) {
    return ({"warming":"1m warming up","warming-up":"1m warming up","insufficient-history":"1m warming up","stale-quote":"Quote stale","stale":"Quote stale","source-gap":"Coverage interrupted","gap":"Coverage interrupted","missing-anchor":"No sample near 60s","no-anchor":"No sample near 60s","unusable-quote":"Quote unavailable","unavailable":"Quote unavailable","inconsistent":"Observation rejected"})[reason] || "Warming up or unavailable";
  }
  burstInfo(stock,events,event=null) {
    const chosen=event?[event]:[...events].reverse();
    return {title:`${stock.symbol} · ${event?"historical burst peaks":`${events.length} confirmed recent bursts`}`,
      paragraphs:["A confirmed strong burst requires at least 1% in approximately 1 minute, followed by another qualifying source quote 10–30 seconds later without an observed failure. Confirmation checks persistence, not price correctness or reversal probability. Five-minute returns are context only.","Historical peaks can remain after momentum cools and never affect ranking. Separate bursts require the complete one-minute return below 1% for 60 observed seconds. A gap cannot establish that reset. Tags expire 15 minutes after their last one-minute threshold hit."],
      details:chosen.flatMap((e,i)=>[[`Burst ${i+1} · first hit`,dateTimeText(e.firstSeen)],["Confirmed",dateTimeText(e.confirmedAt)],...this.windowDetails("Historical peak 1m",e.oneWindow),...this.windowDetails("Historical peak 5m",e.fiveWindow),["Last threshold hit",dateTimeText(e.lastSeen)],["Expires",dateTimeText(e.lastSeen+15*MINUTE)]])};
  }
  momentumInfo(stock,spikes,label="Current momentum") {
    const definitions={"Fast rise":"Current one-minute return is at least 1%.","Strong five-minute rise":"Current five-minute return is at least 2%.","Accelerating":"Three consecutive non-overlapping one-minute returns are positive and strictly increasing, using shared boundary samples.","Repeated surges":"At least two distinct confirmed bursts remain within 15 minutes of their last threshold hits.","New 15-minute high":"Current sampled price strictly exceeds every earlier sampled price in a fully covered preceding 15-minute window. This is a sampled high, not every exchange trade.","Cooling":"A confirmed recent burst remains, but the current one-minute return is zero or negative."};
    return {title:`${stock.symbol} · ${label}`,paragraphs:[definitions[label] || "Current one-minute rise = (latest price ÷ sampled price approximately 60 seconds earlier − 1) × 100. All positive returns are visible and rank immediately. At ≥1%, the strong-rise badge is amber; another qualifying quote 10–30 seconds later without an observed failure confirms persistence in green.","Returns use actual Groww source times. After at least 60 seconds of history, choose the real sample closest to 60 seconds earlier within ±10 seconds; ties use the older sample. The actual interval is 50–70 seconds and no source gap may exceed 30 seconds. No interpolation, overnight gaps or pre-monitoring history is used. The latest sample change and highest one-minute reading observed in the last 60 seconds are secondary context only.","Confirmation, five-minute context, historical bursts, recent peaks and option IV never change the one-minute ranking. The strong-rise threshold is provisional and does not predict reversal."],
      details:[["Status",spikes.status],...this.windowDetails("Current 1m",spikes.one),...this.windowDetails("Latest sample change",spikes.latestChange),...this.windowDetails("Highest 1m reading in last 60s",spikes.peakOne),["Peak reading observed",dateTimeText(spikes.peakOne?.observedAt)],...this.windowDetails("Current 5m",spikes.five),...this.windowDetails("Current 15m",spikes.fifteen),
      ...spikes.acceleration.returns.flatMap((r,i)=>this.windowDetails(`Acceleration minute ${i+1} (oldest first)`,r)),["First active hit",dateTimeText(spikes.confirmation?.firstSeen)],["Current run confirmed",dateTimeText(spikes.confirmation?.confirmedAt)],["History began / resumed",dateTimeText(spikes.coverage.since)],["Source gaps",String(spikes.coverage.interruptions)],...(spikes.coverage.lastGap?[["Latest source gap",`${spikes.coverage.lastGap.seconds}s · ${dateTimeText(spikes.coverage.lastGap.from)} to ${dateTimeText(spikes.coverage.lastGap.to)}`]]:[])]};
  }
  checkInfo(stock,check,label) {
    const state=this.snapshot, result=label.startsWith("Results ");
    const paragraphs=result ? [check.results.unknown ? "The results check is unavailable because there is no valid scan covering the required dates today. This stock is excluded until coverage is verified. Use Refresh calendar to retry." : "Groww lists financial results inside the exclusion window. This stock remains excluded, regardless of its spike tags. The window includes every calendar date from the previous NSE trading session through the next session, including intervening holidays and weekends."] :
      [label==="Stock checks passed" ? `The daily change is strictly above +${this.settings.minDay}%, the stock price is valid, and today’s Groww calendar scan lists no results in the exclusion window. Fresh price samples and liquid call quotes are required separately for full eligibility.` :
      label==="Gainers membership stale" ? "Groww’s gainers list has not been successfully verified for at least five minutes. Fresh stock quotes continue to update, but automatic call checks and the eligible highlight wait for membership to be verified again." :
      label==="Price unavailable" || label.includes("Groww") || label.includes("quote") ? "The timestamped Groww NSE stock quote is missing, inconsistent or older than 30 seconds. This row cannot qualify or create new spikes until a fresh quote arrives. Price and daily change use the same Groww LTP and previous close; the cached gainers price is never substituted." : `Daily change is measured against the previous close. The current gain must be strictly above +${this.settings.minDay}%; a short upward burst alone does not pass this rule. This label describes the current observation, not every earlier moment in the day.`];
    return {title:`${stock.symbol} · ${label}`,paragraphs,details:[["Daily change now",percent(stock.dayPct)],["Previous close · Groww",money(stock.previousClose)],["Groww source quote",dateTimeText(stock.quoteAt)],["Quote fetched",dateTimeText(state.updatedAt)],["Price source","Groww NSE CASH quote; ranking feed is candidate selection only"],["Results source","Groww results calendar"],["Results scan",dateTimeText(state.calendar?.fetchedAt)],["Covered dates",state.window?`${state.window.from} through ${state.window.to}`:"Unavailable"],...(check.results.events || []).map(e=>["Results date",e.date])]};
  }
  callInfo(stock) {
    return {title:`${stock.symbol} · call eligibility`,paragraphs:[
      `The main strike rule is strictly more than ${this.settings.minDistance}% above the Groww snapshot’s underlying price. ${this.settings.nearTarget?`One labelled exception is enabled: the closest listed strike at or below ${this.settings.minDistance}%, but strictly above ${nearTargetFloor(this.settings)}%. An exact target is preferred when listed. All other checks still apply.`:"The near-target exception is disabled."}`,
      "Liquidity follows Groww’s crossed-droplet icon only, using its ILLIQUID marker for this stock, expiry and call strike. No flag in a valid Groww chain response passes; a flag fails. Missing or unrecognized marker data stays unavailable. OI, daily volume, spread and depth are informational and do not change this check.",
      "A valid Groww bid/ask and lot size are needed separately to show a usable quoted credit. A passed liquidity check alone does not make a missing, stale or closed-market quote live.",
      "The stock must pass day/results checks, with a Groww stock quote no older than 30 seconds and a selling book no older than 60 seconds in an open session. Potential max profit uses the Groww bid × lot size before costs, assuming execution at that bid and expiry at or below the strike. Groww LTP is a reference price, not an executable offer.",
      "Click the stock name for its Groww stock page; click elsewhere on the row to compare calls here. The open panel checks for updates every 10 seconds during trading while Strategy view is visible; Refresh calls requests an update immediately. The Open chain link opens Groww’s option chain directly. Calls remain in ascending strike order, including calls marked illiquid by Groww."
    ]};
  }
  distanceInfo() {
    return {title:"Call strike distance",paragraphs:[`The target is ${this.settings.minDistance}% above the underlying in the Groww snapshot. Distance = (strike ÷ spot − 1) × 100.`,this.settings.nearTarget?`In addition to strikes strictly above the target, show one nearest strike at/below the target but strictly above ${nearTargetFloor(this.settings)}%. An exact target is preferred; otherwise this is labelled Near target. This is an explicit exception, and all liquidity checks still apply.`:"Only strikes strictly above the target are included. Enable the near-target exception in Thresholds to include one nearby strike.","The interval between successive strikes is the listed strike interval, not another 10%. At ₹96.25, ₹105 is only 9.09% away and does not meet a >9.5% floor."]};
  }
  referenceInfo(stock,item) {
    return {title:`${stock.symbol} ${item.strike} CE · Groww quote sources`,paragraphs:["All displayed stock and option prices come from Groww’s NSE quote endpoints. Option LTP and market depth have independent source timestamps. An old last-traded price can coexist with a newer selling bid; the quoted credit uses the bid, never the LTP.","The Groww chain supplies expiry, lot size, contract identity and its droplet flag. Its page fetch time is metadata freshness, not a quote time. A missing or stale selling book does not qualify. NSE’s website is used only for the holiday calendar."],details:[["Groww contract",item.contract || "Unavailable"],["Exchange token",item.token || "Unavailable"],["Groww LTP",money(item.growwLtp)],["LTP source time",dateTimeText(item.ltpAt)],["Selling book source time",dateTimeText(item.bookAt)],["Contract metadata fetched",dateTimeText(item.growwFetchedAt)],["Groww ILLIQUID marker",typeof item.growwIlliquid!=="boolean"?"Unavailable":item.growwIlliquid?"Present":"Absent"]]};
  }
  optionURL(stock) {
    const expiry=this.selectedExpiries[stock.symbol] || this.getOptions(stock)?.expiry;
    return `https://groww.in/options/${encodeURIComponent(stock.searchId || "")}${expiry?`?expiry=${encodeURIComponent(expiry)}`:""}`;
  }
  stockURL(stock) {return `https://groww.in/stocks/${encodeURIComponent(stock.searchId)}`;}
  rowHTML({stock,spikes,check,option},leader,market,fresh) {
    const expanded=this.selectedSymbol===stock.symbol, snapshot=this.getOptions(stock);
    const priceFresh=quoteFresh(stock,Date.now());
    const events=[...spikes.events].reverse();
    const patternLabels=[["fast","Fast rise"],["strongFive","Strong five-minute rise"],["accelerating","Accelerating"],["repeated","Repeated surges"],["newHigh","New 15-minute high"],["cooling","Cooling"]].filter(([key,label])=>spikes.patterns[key] && label!==spikes.status);
    const patternHTML=([key,label])=>pill(label,key==="cooling"?"amber":spikes.confirmed?"green":"",this.lazyInfo("momentum",stock,label));
    const tags=patternLabels.slice(0,2).map(patternHTML).join("");
    const history=events.map(e=>tagButton(`Peak ${e.one!==null?`${percent(e.one)} / 1m`:""}${e.one!==null&&e.five!==null?" · ":""}${e.five!==null?`${percent(e.five)} / 5m`:""}<time>${clockText(e.firstSeen)}</time>`,this.lazyInfo("burst",stock,"Historical burst peaks",e.id),"spike-tag")).join("");
    const context=[['5m',spikes.five],['15m',spikes.fifteen]].map(([label,r])=>r.ready?`${label} ${percent(r.pct)} (${r.seconds}s)`:`${label} ${market.open?"warming up":"unavailable"}`).join(" · ");
    const secondary=[spikes.latestChange?.ready?`Last ${spikes.latestChange.seconds}s: ${percent(spikes.latestChange.pct)} · ${clockText(spikes.latestChange.endAt)}`:"",spikes.peakOne?.ready?`1m high in last 60s: ${riseText(spikes.peakOne.pct)} · ${clockText(spikes.peakOne.observedAt)}`:""].filter(Boolean);
    const presentation=momentumPresentation(stock,spikes,Date.now(),market);
    const shownReasons=new Set();
    const checksHTML=check.reasons.map(reason=>{
      const priceReason=reason===stock.priceError || reason==="Groww quote stale or unavailable" || reason==="Price unavailable";
      const label=priceReason?(stock.quoteConflictAt?"Rechecking quote":"Waiting for price"):reason;
      if(shownReasons.has(label))return "";shownReasons.add(label);
      return `<div class="reason">${pill(label,label==="Negative today"||label.startsWith("Results ")&&!check.results.unknown?"red":"amber",this.lazyInfo("check",stock,reason))}</div>`;
    }).join("");
    return `<tr class="stock-row ${leader===stock.symbol?"candidate":""} ${expanded?"selected":""}" data-action="open-calls" data-symbol="${escapeHTML(stock.symbol)}" tabindex="0" aria-label="View ${escapeHTML(stock.symbol)} calls" aria-expanded="${expanded}" aria-controls="calls-drawer"><td class="stock-cell">${stock.searchId?`<a class="stock-name stock-open" href="${this.stockURL(stock)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHTML(stock.symbol)} stock page" title="Open Groww stock page">${escapeHTML(stock.name)}</a>`:`<span class="stock-name">${escapeHTML(stock.name)}</span>`}<div class="stock-meta"><span class="rank">#${stock.rank}</span>${escapeHTML(stock.symbol)}${leader===stock.symbol?" · Rising + calls ready":""}</div></td>
      <td class="spikes">${tagButton(spikes.one.ready?escapeHTML(riseText(spikes.one.pct)):escapeHTML(presentation.label),this.lazyInfo("momentum",stock,"Rise in ~1m"),`rise-value ${spikes.one.ready&&spikes.one.pct>0?"positive":""} ${spikes.one.ready?"":"waiting-value"}`)}<div class="small waiting-detail">${escapeHTML(presentation.detail)}</div>${spikes.one.ready?`<div class="tags">${pill(presentation.label,presentation.tone,this.lazyInfo("momentum",stock,presentation.label))}</div>`:""}
      <div class="sample-context small">${secondary.map(text=>escapeHTML(text)).join("<br>")}</div><div class="tags pattern-tags">${tags}</div><details class="pattern-details" data-patterns="${escapeHTML(stock.symbol)}"><summary>5m / 15m context · ${events.length} confirmed strong burst${events.length===1?"":"s"}</summary><div class="current-returns small">${escapeHTML(context)}</div><div class="tags">${patternLabels.slice(2).map(patternHTML).join("")}${history}</div></details></td>
      <td class="num price">${money(stock.spot)}<div class="small quote-stamp ${priceFresh?"":"negative"}">${stock.quoteAt?`Groww ${clockText(stock.quoteAt)}${priceFresh?"":stock.priceError?" · unavailable":" · stale · last verified"}`:"Waiting for Groww price"}</div>${stock.quoteWarning?`<div class="small quote-warning">${escapeHTML(stock.quoteWarning)}</div>`:""}</td><td class="num ${stock.dayPct>0?"positive":stock.dayPct<0?"negative":""}">${percent(stock.dayPct)}</td>
      <td>${check.pass?pill("Stock checks passed","green",this.lazyInfo("check",stock,"Stock checks passed")):checksHTML}${check.pass?`<div class="small">${escapeHTML(check.results.label)}</div>`:""}</td>
      <td class="calls-cell">${stock.searchId?`<a class="btn ${option.pass&&check.pass&&fresh&&market.open&&spikes.one.ready&&spikes.one.pct>0?"primary":""}" href="${this.optionURL(stock)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHTML(stock.symbol)} option chain">Open chain ↗</a>`:"Chain unavailable"}<div class="small" style="margin-top:6px">${snapshot?.loading?"Checking quotes…":escapeHTML(snapshot?.error?"Options unavailable":option.label)}</div></td></tr>`;
  }
  optionsPanelHTML({stock,option:status,check,leftMembership=false},market,pricesFresh) {
    if(!resultsAllowed(stock,this.snapshot.calendar,this.snapshot.window,Date.now()))return "";
    const snapshot=this.getOptions(stock),expiry=this.selectedExpiries[stock.symbol] || snapshot?.expiry;
    const qualified=status.qualifying.filter(()=>check.pass&&pricesFresh),shown=status.items.slice(0,this.callLimit);
    const cutoff=snapshot?.spot>0?snapshot.spot*(1+this.settings.minDistance/100):null;
    let content;
    const pending=snapshot?.state==="queued" || snapshot?.requestState==="queued";
    const cooldown=snapshot?.state==="cooldown" || snapshot?.requestState==="cooldown";
    if(cooldown)content=`<div class="notice" role="status">Call service cooldown${snapshot.retryAt?` · retry after ${clockText(snapshot.retryAt)} IST`:""}. ${escapeHTML(snapshot.error || "Waiting for Groww to permit another call quote request.")}</div>`;
    else if (!snapshot || snapshot.loading&&!snapshot.items) content=`<div class="loading" role="status">${pending?"Call request queued · waiting for the quote slot…":"Loading call prices and lot sizes…"}${snapshot?.deadlineAt?`<div class="small">Response deadline ${clockText(snapshot.deadlineAt)} IST</div>`:""}</div>`;
    else if (snapshot.error) content=`<div class="notice error" role="status">${escapeHTML(snapshot.error)}. Call prices and potential profit are unavailable until quotes and lot sizes can be verified.</div>`;
    else content=`<div class="call-source"><div>Groww · NSE stock + option quotes${snapshot.loading?pending?" · refresh queued…":" · refreshing…":""}</div>
      <div>Underlying quote ${escapeHTML(dateTimeText(snapshot.spotQuoteAt))} · contract metadata fetched ${escapeHTML(clockText(snapshot.growwFetchedAt))} IST</div>
      <div>Spot <strong>${money(snapshot.spot)}</strong> · +${this.settings.minDistance}% line <strong>${money(cutoff)}</strong>${this.settings.nearTarget?` · near-target floor &gt;${nearTargetFloor(this.settings)}%`:""}</div></div>
      <div class="call-state">${qualified.length?pill(`${qualified.length} qualifying call${qualified.length===1?"":"s"}`,"green",this.callInfo(stock)):pill("No qualifying calls","amber",this.callInfo(stock))}
      <span class="small">${escapeHTML(!check.pass?`Stock excluded: ${check.reasons.join(" · ")}`:!pricesFresh?"Stock quotes stale; snapshot only":!status.fresh?`${status.label}; snapshot only`:"Ascending strikes · one lot each")}</span></div>
      ${shown.length?`<div class="call-cards">${shown.map((item,index)=>this.callCardHTML(stock,item,index,status,check,pricesFresh,expiry)).join("")}</div>
      ${status.items.length>shown.length?`<button class="btn more-calls" data-action="more-calls">Show next ${Math.min(3,status.items.length-shown.length)} strikes</button>`:""}
      <p class="small call-count">Showing ${shown.length} of ${status.items.length} calls in the configured range${status.items.some(x=>x.rangeException)?" · includes one labelled target exception":""}. Failed liquidity checks stay visible in sequence.</p>`:'<div class="empty"><strong>No listed calls in this range</strong>Try another listed expiry or refresh the snapshot.</div>'}`;
    return `<aside id="calls-drawer" class="calls-drawer" aria-label="${escapeHTML(stock.symbol)} call comparison" tabindex="-1">
      <div class="calls-head"><div><h2>${escapeHTML(stock.name)}</h2><p class="small">Call comparison · target +${this.settings.minDistance}%${this.settings.nearTarget?` · one near-target exception &gt;${nearTargetFloor(this.settings)}%`:""}</p></div><button class="btn" data-action="close-calls" aria-label="Close calls panel">✕</button></div>
      <div class="calls-body"><div class="call-controls">${snapshot?.expiries?`<label class="small">Expiry <select name="expiry" data-symbol="${escapeHTML(stock.symbol)}" aria-label="${escapeHTML(stock.symbol)} expiry">${snapshot.expiries.map(d=>`<option value="${d}" ${d===expiry?"selected":""}>${d}</option>`).join("")}</select></label>`:`<span class="small">${escapeHTML(expiry || "Nearest available monthly expiry")}</span>`}<button class="btn" data-action="options" data-symbol="${escapeHTML(stock.symbol)}">Refresh calls</button></div>
      ${leftMembership?'<p class="snapshot-notice">Left gainers list · this selected call panel continues updating. Automatic checks follow the current list.</p>':""}${!market.open?`<p class="snapshot-notice">${escapeHTML(market.label)} · showing available snapshots for comparison.</p>`:""}${content}
      <p class="payoff-note">Potential max profit = selling premium × lot size, assuming a fill at that price and expiry at or below the strike. Amounts are gross before costs. LTP is a reference, not an executable offer. An uncovered short call has unlimited potential loss; a 10% gap does not cap it.</p></div>
      <div class="calls-foot">${stock.searchId?`<a class="chain-link" href="${this.optionURL(stock)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeHTML(stock.symbol)} option chain on Groww">Open option chain on Groww ↗</a>`:"Option chain link unavailable"}<span class="small">Optional · opens in a new tab</span></div></aside>`;
  }
  callCardHTML(stock,item,index,status,check,pricesFresh,expiry) {
    const live=item.pass&&item.bookFresh&&status.fresh&&check.pass&&pricesFresh;
    const label=item.liquidity.label;
    const availability=!item.quoteReady?"Quote unavailable":!status.fresh || !item.bookFresh?"Snapshot only":!check.pass?"Stock excluded":!pricesFresh?"Stock price stale":live?"Qualifies now":"Excluded";
    const info=this.callInfo(stock);
    info.title=`${stock.symbol} ${item.strike} CE · ${label}`;
    if(item.failures.length)info.paragraphs.unshift(`This strike: ${item.failures.join("; ")}.`);
    return `<article class="call-card ${live?"call-live":""}" aria-label="${escapeHTML(stock.symbol)} ${item.strike} CE comparison">
      <div class="call-card-head"><h3><span class="call-index">${index+1}</span>${money(item.strike)} CE</h3><span class="distance">${percent(item.distance)} away</span></div>
      ${item.rangeException?`<div class="range-exception">${pill(above(this.settings.minDistance,item.distance)?"Near target · exception":"At target · exception","amber",this.distanceInfo())}</div>`:""}
      <div class="call-money"><div><span class="small">Sell premium · Groww bid</span><strong>${money(item.bid)}</strong></div>
      <div class="profit-block"><span class="small">Gross quoted credit / lot</span><strong class="${live?"positive":""}">${money(item.payoff.maxProfit)}</strong></div></div>
      <div class="ltp-reference">Lot ${count(item.lot)} · Groww LTP ${money(item.growwLtp)}${item.growwPayoff.maxProfit!==null?` → ${money(item.growwPayoff.maxProfit)} / lot`:""} (reference)</div>
      <div class="ltp-reference">Book ${dateTimeText(item.bookAt)} · LTP ${dateTimeText(item.ltpAt)}</div>
      <div class="source-checks">${pill("Groww quote details","",this.referenceInfo(stock,item))}<span class="small">${item.growwIlliquid===false?"No crossed-droplet flag":item.growwIlliquid===true?"Crossed-droplet flag present":"Droplet status unavailable"}</span></div>
      ${item.quoteFailures.length?`<p class="failed-checks">${escapeHTML(item.quoteFailures.join(" · "))}</p>`:""}
      <div class="call-card-status">${pill(label,item.liquidity.pass?"green":item.liquidity.unknown?"amber":"red",info)} <span class="small">${escapeHTML(availability)}</span></div>
      <details class="call-depth" data-strike="${escapeHTML(`${stock.symbol}:${expiry}:${item.strike}`)}"><summary>Price, payoff and depth</summary><dl>
        <div><dt>Breakeven at selling bid</dt><dd>${money(item.payoff.breakeven)}</dd></div>
        <div><dt>Breakeven at Groww LTP</dt><dd>${money(item.growwPayoff.breakeven)}</dd></div>
        <div><dt>Max loss · uncovered call</dt><dd>Unlimited</dd></div>
        <div><dt>Bid / ask</dt><dd>${money(item.bid)} / ${money(item.ask)}</dd></div><div><dt>Spread / midpoint</dt><dd>${item.spread===null?"—":`${item.spread.toFixed(2)}%`}</dd></div>
        <div><dt>OI / daily volume</dt><dd>${count(item.oi)} / ${count(item.volume)} contracts</dd></div>
        <div><dt>Best bid / ask depth</dt><dd>${item.lot>0&&numeric(item.bidQty)!==null&&numeric(item.askQty)!==null?`${(item.bidQty/item.lot).toFixed(1)} / ${(item.askQty/item.lot).toFixed(1)} lots`:"Unavailable"}</dd></div>
        <div><dt>Bid / ask quantity</dt><dd>${count(item.bidQty)} / ${count(item.askQty)} units</dd></div>
        <div><dt>Reported IV / delta · Groww</dt><dd>${numeric(item.iv)!==null?`${item.iv.toFixed(2)}%`:"—"} / ${numeric(item.greeks?.delta)!==null?Number(item.greeks.delta).toFixed(3):"—"}</dd></div>
        <div><dt>Greeks metadata fetched</dt><dd>${dateTimeText(item.growwFetchedAt)}<br>IV source quote time unavailable</dd></div>
        <div><dt>Groww call contract</dt><dd>${escapeHTML(item.contract || "Unavailable")}</dd></div><div><dt>Exchange token</dt><dd>${escapeHTML(item.token || "Unavailable")}</dd></div></dl>
      </details></article>`;
  }
  stop() {this.alive=false;clearInterval(this.coordinatorTimer);clearTimeout(this.rowOrderTimer);
    try{this.collector?.stop();}finally{this.releaseLock?.();this.restoreNative(false);}}
}
class Collector {
  constructor(app) {
    this.app=app;this.running=false;this.busy=false;this.starting=false;this.seenCommands=new Set();this.pending=new Map();
    this.optionGeneration=new Map();this.optionControllers=new Map();this.selectedContexts=new Map();this.writes=new Map();
    this.providers=new Providers(new PublicTransport(details=>GM_xmlhttpRequest(details)),storage);
    this.state={...app.snapshot,stocks:app.snapshot.stocks || [],options:{...(app.snapshot.optionSummaries || {}),...(app.snapshot.options || {})},
      identities:{...(app.snapshot.identities || {})},signals:{},owner:app.id,ownerStartedAt:Date.now(),pricingVersion:2};
    this.engine=safeEngine(this.state.engine);delete this.state.engine;
    for(const stock of this.state.stocks)this.state.identities[stock.symbol]=stock;
    this.membership=this.state.stocks;this.nextCalendar=0;this.nextMembership=0;this.calendarBusy=false;this.membershipBusy=false;
    this.publishTail=Promise.resolve();this.revision=0;this.nextQuoteAt=0;this.nextAutoAt=0;
  }
  async start() {
    this.running=true;this.starting=true;
    const [holidays,checkpoint]=await Promise.all([storage.get("holidays",null),storage.get("engineCheckpoint",null)]);
    if(!this.running)return;
    if(holidays && istDay(holidays.fetchedAt)===istDay(Date.now()))this.state.holidays=holidays;
    const saved=checkpoint?.engine || checkpoint;
    if(saved?.source===PRICE_SOURCE && (!this.engine.day || (checkpoint?.updatedAt || 0)>=(this.state.updatedAt || 0)))this.engine=safeEngine(saved);
    for(const entry of Object.values(this.engine.states))if(entry.identity && !this.state.identities[entry.identity.symbol])this.state.identities[entry.identity.symbol]=entry.identity;
    // Membership and calendar are startup prerequisites, but neither controls the quote timer after startup.
    await Promise.allSettled([this.refreshMembership(false),this.refreshCalendar(false)]);
    if(!this.running)return;
    this.starting=false;this.enforceResults();
    // The display rejection can reach another tab before its history checkpoint.
    // A restored pending run must see that failure before any newer quote arrives.
    const rejected=Object.values(this.state.identities).filter(stock=>stock.priceError && this.engine.states[stockKey(stock)]);
    if(rejected.length){this.engine.observe(rejected,Date.now());this.checkpointDirty=true;}
    await this.tick();
    this.maintenanceTimer=setInterval(()=>this.maintain(),1000);
  }
  stop({drainWrites=false}={}) {
    try{if(this.running)this.flushRecord();else this.cancelRecord();}catch(error){this.app.diagnosticError=`History checkpoint: ${error.message}`;}
    this.drainingWrites=drainWrites;
    this.running=false;clearTimeout(this.timer);clearTimeout(this.publishTimer);clearTimeout(this.presentationTimer);clearTimeout(this.autoTimer);clearInterval(this.maintenanceTimer);
    this.providers.cancelAllOptions();for(const job of this.pending.values())job.controller.abort();
    if(!drainWrites)for(const slot of this.writes.values())slot.pending=null;
    this.app.archive.flush();
  }
  deferRecord(callback) {
    this.flushRecord();
    const job={callback,frame:null,timer:null};this.recordJob=job;
    const run=()=>{if(this.recordJob!==job)return;this.recordJob=null;
      clearTimeout(job.timer);if(job.frame!==null && typeof cancelAnimationFrame==="function")cancelAnimationFrame(job.frame);
      if(this.running)callback();};
    // rAF is only a paint optimization, never a dependency for persistence.
    // Its fallback also bounds pending work if a visible tab becomes hidden.
    if(typeof requestAnimationFrame==="function" && (typeof document==="undefined" || document.visibilityState!=="hidden")) {
      job.frame=requestAnimationFrame(()=>{if(this.recordJob===job)setTimeout(run,0);});job.timer=setTimeout(run,100);
    } else job.timer=setTimeout(run,0);
  }
  flushRecord() {
    const job=this.recordJob;if(!job)return;
    this.cancelRecord();if(this.running)job.callback();
  }
  cancelRecord() {
    const job=this.recordJob;this.recordJob=null;if(!job)return;
    clearTimeout(job.timer);if(job.frame!==null && typeof cancelAnimationFrame==="function")cancelAnimationFrame(job.frame);
  }
  resume() {
    if(!this.running || this.starting)return;
    this.maintain();
    const now=Date.now(),period=marketState(now,this.state.holidays).open?10_000:60_000;
    if(!this.busy && (!this.lastQuoteAttemptAt || now-this.lastQuoteAttemptAt>=period)) {
      clearTimeout(this.timer);this.nextQuoteAt=0;this.tick();
    }
  }
  allowed(stock) {return this.running && !!stock && resultsAllowed(stock,this.state.calendar,this.state.window,Date.now());}
  adoptCanonicalQuote(identity,incoming,missingReason="Groww quote unavailable; showing last verified values") {
    const sameIdentity=value=>value?.symbol===identity.symbol && stockKey(value)===stockKey(identity);
    const point=value=>sameIdentity(value) && value.priceSource===PRICE_SOURCE && value.spot>0 && value.previousClose>0 &&
      Number.isFinite(value.dayPct) && Number.isFinite(value.quoteAt);
    const candidates=[this.state.identities[identity.symbol],...this.state.stocks.filter(s=>s.symbol===identity.symbol)]
      .filter(value=>point(value) && value.quoteAt<=Date.now()+10_000);
    const prior=candidates.reduce((best,value)=>!best || value.quoteAt>best.quoteAt || value.quoteAt===best.quoteAt && value.quoteConflictAt?value:best,null);
    const base={...identity,...(prior || {}),symbol:identity.symbol,gsin:identity.gsin,searchId:identity.searchId,rank:identity.rank};
    const rejected=(reason,conflict=false)=>({
      display:{...base,...(!prior?{spot:null,previousClose:null,dayPct:null,quoteAt:null,priceSource:PRICE_SOURCE}:{}),
        priceError:reason,quoteWarning:null,rejectedQuoteAt:incoming?.quoteAt || null,...(conflict?{quoteConflictAt:Math.max(base.quoteConflictAt || 0,incoming?.quoteAt || 0)}:{})},
      observation:{...(sameIdentity(incoming)?incoming:identity),spot:incoming?.spot || null,priceSource:PRICE_SOURCE,priceError:reason},rejected:true,conflict,
    });
    if(Number.isFinite(incoming?.quoteAt) && incoming.quoteAt>Date.now()+10_000)return rejected("Groww source timestamp is in the future; last verified values retained");
    if(!point(incoming) || incoming.priceError)return rejected(incoming?.priceError || missingReason);
    const sameValues=prior && incoming.spot===prior.spot && incoming.previousClose===prior.previousClose && incoming.dayPct===prior.dayPct;
    if(base.quoteConflictAt && incoming.quoteAt<=base.quoteConflictAt)
      return rejected("Conflicting Groww quote; waiting for a strictly newer source timestamp",true);
    if(prior && incoming.quoteAt<prior.quoteAt)return {
      display:{...base,quoteWarning:"Older Groww quote ignored; last verified values retained",rejectedQuoteAt:incoming.quoteAt},
      observation:base,rejected:true,conflict:false,
    };
    if(prior && incoming.quoteAt===prior.quoteAt && !sameValues)
      return rejected("Conflicting Groww quotes at the same source time; last verified values shown",true);
    const canonical=prior && incoming.quoteAt===prior.quoteAt?prior:incoming;
    return {display:{...base,...canonical,symbol:identity.symbol,gsin:identity.gsin,searchId:identity.searchId,rank:identity.rank,
      priceError:null,quoteWarning:null,quoteConflictAt:null,rejectedQuoteAt:null},observation:incoming,rejected:false,conflict:false};
  }
  selected(stock) {
    if(stock?.symbol===this.app.selectedSymbol && this.app.selectedStock)return true;
    for(const value of this.selectedContexts.values())if(value.symbol===stock?.symbol && Date.now()-value.at<45_000)return true;
    return false;
  }
  cancelStock(stock) {
    if(!stock?.symbol)return;
    const symbol=stock.symbol;
    this.optionGeneration.set(symbol,(this.optionGeneration.get(symbol) || 0)+1);this.providers.cancelOptions(symbol);
    for(const [key,job] of this.pending)if(job.stock.symbol===symbol){job.controller.abort();this.pending.delete(key);this.optionControllers.delete(key);}
    for(const [key,item] of Object.entries(this.state.options))if(item.symbol===symbol || key.startsWith(symbol+"|"))delete this.state.options[key];
    for(const [key,value] of this.selectedContexts)if(value.symbol===symbol)this.selectedContexts.delete(key);
    delete this.state.identities[symbol];
    for(const [key,entry] of Object.entries(this.engine.states))if(entry.identity?.symbol===symbol || key===stockKey(stock)){delete this.engine.states[key];this.checkpointDirty=true;}
    delete this.state.signals[stockKey(stock)];
  }
  enforceResults() {
    const membership=this.providers.lastMembership || this.membership;
    scrubResults(this.state,Date.now(),membership,stock=>this.cancelStock(stock));
    for(const [key,entry] of Object.entries(this.engine.states)) {
      const identity=entry.identity || this.state.identities[entry.symbol];
      if(!identity || !this.allowed(identity)){if(identity)this.cancelStock(identity);delete this.engine.states[key];}
    }
  }
  deriveSignals(now=Date.now()) {
    const views={};this.signalViews={};
    for(const stock of this.state.stocks) {
      const view=this.engine.view(stock,now),{baselineEvents,confirmation,...display}=view;
      this.signalViews[stockKey(stock)]=view;
      views[stockKey(stock)]={...display,confirmation:confirmation?{firstSeen:confirmation.firstSeen,confirmedAt:confirmation.confirmedAt,lastSeen:confirmation.lastSeen}:null};
    }
    this.state.signals=views;this.signalAt=now;
  }
  displaySnapshot() {
    const now=Date.now();this.enforceResults();
    this.state.membershipStale=!this.state.membershipUpdatedAt || now-this.state.membershipUpdatedAt>=300_000;
    const cooldown=this.providers.transport?.cooldownState?.();
    this.state.samplingCooldown=cooldown?.paused?{until:cooldown.retryAt,label:cooldown.scope==="host"?"Groww rate limit":"Groww stock quote service",...cooldown}:null;
    const summaries={},options={};
    for(const [key,value] of Object.entries(this.state.options)) {
      // Unloaded metadata is only useful to an expanded panel. Keep hot cross-tab snapshots small.
      summaries[key]={...value,items:(value.items || []).filter(item=>item.bookLoaded)};
      const identity=value.stockRef || this.state.identities[value.symbol];
      if(identity && this.selected(identity))options[key]=value;
    }
    const {engine:unused,options:allOptions,...state}=this.state;
    return {...state,stocks:[...this.state.stocks],signals:{...this.state.signals},identities:{...this.state.identities},options,optionSummaries:summaries,
      diagnosticError:this.app.archive.error,revision:++this.revision};
  }
  present() {
    const snapshot=this.displaySnapshot();
    const removed=this.app.acceptSnapshot(snapshot);this.app.render(removed);
    if(this.checkpointDirty)this.checkpoint();
    this.pendingSnapshot=true;
  }
  publish(immediate=false,urgent=false) {
    if(!this.running)return Promise.resolve();
    // Calendar exclusions and quote batches reach the owner immediately. Repeated
    // option-stage status changes share one ordinary presentation, not one render per request.
    immediate=immediate || (this.state.calendar?.fetchedAt || 0)>(this.app.snapshot.calendar?.fetchedAt || 0);
    if(immediate || urgent){clearTimeout(this.presentationTimer);this.presentationTimer=null;this.present();}
    else if(!this.presentationTimer)this.presentationTimer=setTimeout(()=>{
      this.presentationTimer=null;if(this.running){this.present();this.schedulePublication();}
    },50);
    if(immediate)return this.flushPublication();
    if(urgent)this.schedulePublication();
    return Promise.resolve();
  }
  schedulePublication() {
    if(!this.publishTimer)this.publishTimer=setTimeout(()=>{this.publishTimer=null;this.flushPublication();},100);
  }
  // At most one write and one latest replacement per key; slow storage cannot grow a polling queue.
  writeLatest(key,value) {
    let slot=this.writes.get(key);
    if(!slot){slot={pending:null,promise:null};this.writes.set(key,slot);}
    slot.pending=value;
    if(!slot.promise)slot.promise=(async()=>{
      while(slot.pending && (this.running || this.drainingWrites)) {
        let next=slot.pending;slot.pending=null;
        if(key==="snapshot")next=this.app.snapshot;
        try {await storage.set(key,next);this.state.storageError=null;}
        catch(error){this.state.storageError=`Local storage: ${error.message}`;}
      }
    })().finally(()=>{slot.promise=null;if(slot.pending && (this.running || this.drainingWrites))return this.writeLatest(key,slot.pending);});
    return slot.promise;
  }
  flushPublication() {
    if(this.presentationTimer){clearTimeout(this.presentationTimer);this.presentationTimer=null;if(this.running)this.present();}
    clearTimeout(this.publishTimer);this.publishTimer=null;
    if(!this.running || !this.pendingSnapshot)return this.publishTail;
    this.pendingSnapshot=false;this.publishTail=this.writeLatest("snapshot",this.app.snapshot);return this.publishTail;
  }
  checkpoint() {
    this.enforceResults();
    this.checkpointDirty=false;
    return this.writeLatest("engineCheckpoint",{engine:this.engine.snapshot(),updatedAt:this.state.updatedAt,ownerStartedAt:this.state.ownerStartedAt});
  }
  async refreshMembership(force=false) {
    if(!this.running || this.membershipBusy)return;this.membershipBusy=true;
    try {
      const result=await this.providers.membership(force);if(!this.running)return;
      this.membership=result.stocks;this.state.membershipUpdatedAt=result.membershipFetchedAt || this.state.membershipUpdatedAt || 0;
      this.state.membershipError=result.membershipError || null;
      const previous=new Map(this.state.stocks.map(stock=>[stock.symbol,stock]));
      this.state.stocks=result.stocks.map(identity=>{
        const prior=[this.state.identities[identity.symbol],previous.get(identity.symbol)]
          .filter(value=>value && stockKey(value)===stockKey(identity) && (!Number.isFinite(value.quoteAt) || value.quoteAt<=Date.now()+10_000))
          .sort((a,b)=>(b.quoteAt || 0)-(a.quoteAt || 0) || Number(!!b.quoteConflictAt)-Number(!!a.quoteConflictAt))[0];
        const stock={...identity,...(prior || {}),symbol:identity.symbol,gsin:identity.gsin,searchId:identity.searchId,name:identity.name,rank:identity.rank};
        if(!prior){stock.spot=null;stock.dayPct=null;stock.quoteAt=null;stock.priceSource=PRICE_SOURCE;stock.priceError="Awaiting Groww stock quote";}
        this.state.identities[stock.symbol]=stock;return stock;
      });
      this.enforceResults();this.deriveSignals();this.publish();
    } catch(error){this.state.membershipError=error.message;this.publish();}
    finally {this.membershipBusy=false;this.nextMembership=Date.now()+60_000;}
  }
  async refreshCalendar(force=false) {
    if(this.calendarBusy || !this.running)return;this.calendarBusy=true;let valid=false;
    try {
      const result=await this.providers.calendar(force);if(!this.running)return;
      Object.assign(this.state,result);this.state.calendarError=null;this.nextCalendar=Date.now()+3_600_000;valid=true;
    } catch(error) {
      this.state.calendarError=error.message;this.nextCalendar=Date.now()+300_000;
      if(this.providers.holidayData){this.state.holidays=this.providers.holidayData;try{this.state.window=sessionWindow(istDay(Date.now()),this.state.holidays);}catch{}}
    } finally {
      this.calendarBusy=false;
      if(this.running){this.enforceResults();this.deriveSignals();this.publish(true);}
    }
    // Quote immediately when the calendar unblocks candidates, never wait for an old closed/empty poll slot.
    if(valid && !this.starting){if(this.busy)this.quoteRequested=true;else this.tick();}
    this.prefetch();
  }
  maintain() {
    if(!this.running)return;
    const now=Date.now();
    if(now>=this.nextMembership)this.refreshMembership(false);
    if(now>=this.nextCalendar || this.state.calendar?.day!==istDay(now))this.refreshCalendar(false);
    this.prefetch();
  }
  scheduleQuote(started) {
    if(!this.running)return;
    const now=Date.now(),period=marketState(now,this.state.holidays).open?10_000:60_000;
    if(!this.nextQuoteAt)this.nextQuoteAt=started+period;
    while(this.nextQuoteAt<=now)this.nextQuoteAt+=period;
    const opening=Date.parse(`${istDay(now)}T09:15:00+05:30`);
    const openingDelay=now<opening?opening-now:Infinity;
    const delay=Math.max(1,Math.min(this.nextQuoteAt-now,openingDelay));
    clearTimeout(this.timer);this.timer=setTimeout(()=>this.tick(),delay);
  }
  async tick() {
    if(!this.running)return;
    if(this.busy){this.quoteRequested=true;return;}
    this.busy=true;const started=Date.now();this.lastQuoteAttemptAt=started;
    try {
      const candidates=(this.providers.lastMembership || this.membership || []).filter(stock=>this.allowed(stock));
      if(!candidates.length){this.state.stocks=[];this.enforceResults();this.deriveSignals();this.publish(false,true);return;}
      const stocks=await this.providers.quotes(candidates,0,{allow:()=>this.running});
      if(!this.running)return;
      // Membership can finish refreshing while quotes are in flight. Project the
      // response onto the latest list instead of restoring the request's old list.
      const now=Date.now(),latest=this.providers.lastMembership || this.membership || [];
      const received=new Map(stocks.filter(Boolean).map(stock=>[stockKey(stock),stock])),observations=[];
      this.state.stocks=latest.filter(stock=>this.allowed(stock)).map(identity=>{
        const incoming=received.get(stockKey(identity));
        const adopted=this.adoptCanonicalQuote(identity,incoming,incoming?undefined:"Awaiting the next Groww stock quote; last verified values retained");
        if(incoming)observations.push(adopted.observation);
        return adopted.display;
      });
      this.state.updatedAt=now;this.state.processedAt=now;this.state.error=null;
      for(const stock of this.state.stocks)this.state.identities[stock.symbol]=stock;
      this.enforceResults();const market=marketState(now,this.state.holidays);
      const transitions=market.open?this.engine.observe(observations,now):[];
      this.deriveSignals(now);
      this.publish(false,true);
      const observedStocks=this.state.stocks,views=this.signalViews,context={calendar:this.state.calendar,window:this.state.window,settings:this.app.settings};
      const record=()=>{
        if(!this.running)return;
        if(market.open)try{this.app.archive.append(diagnosticFrame(observedStocks,{view:stock=>views[stockKey(stock)]},now,context,transitions));}catch(error){this.app.diagnosticError=error.message;}
        this.checkpoint();
      };
      // Give the new prices a frame before checkpoint serialization or archive work.
      this.deferRecord(record);
      this.prefetch();
    } catch(error) {
      this.state.error=error.message;this.deriveSignals();this.publish(false,true);
      if(marketState(Date.now(),this.state.holidays).open)try{this.app.archive.append({schema:3,signalVersion:SIGNAL_VERSION,at:Date.now(),day:istDay(Date.now()),error:error.message});}catch{}
    } finally {
      this.busy=false;
      if(this.quoteRequested && this.running){this.quoteRequested=false;clearTimeout(this.timer);this.timer=setTimeout(()=>this.tick(),0);}
      else this.scheduleQuote(started);
    }
  }
  prefetch() {
    if(!this.running || this.starting || Date.now()<this.nextAutoAt)return;
    if(this.pending.size)return;
    const now=Date.now(),market=marketState(now,this.state.holidays);
    if(!market.open || !this.state.membershipUpdatedAt || now-this.state.membershipUpdatedAt>=300_000)return;
    const facade={view:stock=>this.state.signals[stockKey(stock)] || this.engine.view(stock,now)};
    const candidates=rankStocks(this.state.stocks,facade,now,{calendar:this.state.calendar,window:this.state.window,settings:this.app.settings})
      .filter(stock=>stockCheck(stock,this.state.calendar,this.state.window,now,this.app.settings).pass).slice(0,10);
    const stock=candidates.find(stock=>optionRefreshPolicy(this.state.options[`${stock.symbol}|nearest`],now,market).due);
    if(!stock)return;
    const refresh=optionRefreshPolicy(this.state.options[`${stock.symbol}|nearest`],now,market);
    this.nextAutoAt=now+3000;this.loadOptions(stock,null,refresh.force,3,false);
    clearTimeout(this.autoTimer);this.autoTimer=setTimeout(()=>this.prefetch(),3000);
  }
  async loadOptions(stock,expiry=null,force=false,requestedLimit=3,selected=this.selected(stock)) {
    if(!this.allowed(stock)){this.cancelStock(stock);return;}
    stock=this.state.identities[stock.symbol] || stock;
    const key=`${stock.symbol}|${expiry || "nearest"}`,priority=selected?1:2;
    if(selected) {
      // A selected panel preempts background work, including a background request for this same key.
      for(const [otherKey,job] of this.pending)if(job.priority>1 || otherKey!==key || force || requestedLimit>job.limit) {
        job.controller.abort();this.providers.cancelOptions(job.stock.symbol);this.pending.delete(otherKey);this.optionControllers.delete(otherKey);
        if(this.state.options[otherKey]?.loading)this.state.options[otherKey]={...this.state.options[otherKey],loading:false,state:"unavailable",error:"Request superseded by selected calls",fetchedAt:Date.now()};
      }
    }
    const limit=Math.max(3,Math.min(100,Math.max(requestedLimit,this.state.options[key]?.loadedLimit || 0)));
    const oldJob=this.pending.get(key);
    if(oldJob){await oldJob.promise;if((this.state.options[key]?.loadedLimit || 0)<limit && this.allowed(stock) && !this.state.options[key]?.error)return this.loadOptions(stock,expiry,force,limit,selected);return;}
    const generation=this.optionGeneration.get(stock.symbol) || 0,controller=new AbortController(),job={stock,controller,priority,limit,promise:null};
    const allow=()=>this.allowed(stock) && !controller.signal.aborted && (this.optionGeneration.get(stock.symbol) || 0)===generation && this.pending.get(key)===job;
    this.pending.set(key,job);this.optionControllers.set(key,controller);
    const requestedAt=Date.now(),deadlineAt=selected?requestedAt+15_000:null;
    this.state.options[key]={...(this.state.options[key] || {}),symbol:stock.symbol,stockRef:stock,loading:true,state:"queued",requestedAt,deadlineAt};this.publish();
    job.promise=(async()=>{
      // Permit an immediate calendar change to cancel work before provider entry.
      await Promise.resolve();
      try {
        if(!allow())return;
        const result=await this.providers.options(stock,expiry,force,limit,this.app.settings,priority,{signal:controller.signal,allow,stockQuote:stock,deadlineMs:selected?15_000:undefined,
          onState:status=>{if(!allow())return;const value=this.state.options[key];if(value.state!==status.state){this.state.options[key]={...value,state:status.state,retryAt:status.retryAt};this.publish();}}});
        if(allow()) {
          const {stockQuote,...snapshot}=result;
          const identity=this.state.identities[stock.symbol] || stock;
          const adopted=stockQuote?this.adoptCanonicalQuote(identity,stockQuote):null;
          const stockRef=adopted?.display || identity;
          // A selected stock outside membership still receives a fresh canonical
          // underlying quote. It never re-enters the scanner through a call response.
          if(adopted)this.state.identities[stock.symbol]=stockRef;
          if(adopted?.conflict || adopted && !quoteFresh(stockRef,Date.now())) {
            const member=this.state.stocks.findIndex(value=>value.symbol===stock.symbol);
            if(member>=0)this.state.stocks[member]={...stockRef,rank:this.state.stocks[member].rank};
            this.engine.observe([adopted.observation],Date.now());this.checkpointDirty=true;this.deriveSignals();
            throw new Error(stockRef.priceError || "Groww underlying quote is stale or unavailable");
          }
          this.state.options[key]={...snapshot,symbol:stock.symbol,stockRef,loadedLimit:result.loadedLimit || limit,loading:false,state:"ready"};
        }
      } catch(error) {
        if(allow() && error.name!=="AbortError") {
          const retryAt=error.retryAt || this.state.options[key]?.retryAt || this.providers.transport?.cooldownState?.(error.url)?.retryAt;
          this.state.options[key]={...this.state.options[key],symbol:stock.symbol,stockRef:this.state.identities[stock.symbol] || stock,error:error.message,loading:false,state:retryAt>Date.now()?"cooldown":"unavailable",retryAt,fetchedAt:Date.now()};
        }
      } finally {
        if(this.pending.get(key)===job){this.pending.delete(key);this.optionControllers.delete(key);}
        if(!controller.signal.aborted && this.running)this.trimOptions();
        if(this.running)this.publish();
      }
    })();
    return job.promise;
  }
  trimOptions() {
    const entries=Object.entries(this.state.options).sort((a,b)=>Number(this.selected(b[1].stockRef))-Number(this.selected(a[1].stockRef)) ||
      (b[1].fetchedAt || b[1].requestedAt || 0)-(a[1].fetchedAt || a[1].requestedAt || 0));
    this.state.options=Object.fromEntries(entries.slice(0,30));
  }
  async command(command) {
    if(!this.running || !command.id || this.seenCommands.has(command.id) || Date.now()-command.at>30_000)return;
    this.seenCommands.add(command.id);if(this.seenCommands.size>100)this.seenCommands.delete(this.seenCommands.values().next().value);
    if(command.action==="flush-archive"){await this.app.archive.flush();this.state.diagnosticsFlushId=command.id;this.publish();await this.flushPublication();}
    if(command.action==="calendar")await this.refreshCalendar(true);
    if(command.action==="refresh"){this.refreshMembership(true);await this.tick();}
    if(command.action==="options") {
      const stock=this.state.stocks.find(s=>s.symbol===command.symbol) || this.state.identities[command.symbol];
      if(this.allowed(stock)) {
        if(command.selected!==false)this.selectedContexts.set(command.requester || this.app.id,{symbol:stock.symbol,at:Date.now()});
        await this.loadOptions(stock,command.expiry,command.force===true,command.limit || 3,command.selected!==false);
      }
    }
  }
}
if (typeof GM_xmlhttpRequest==="function" && routeMatches() && !document.getElementById(HOST_ID)) {
  const app=new StrategyApp();
  app.start().catch(error=>console.error("Groww Strategy View:",error.message));
}

})();
