import { useState, useMemo, useRef, useEffect } from "react";
import Papa from "papaparse";
import { upload } from "@vercel/blob/client";
import { Plus, Trash2, TrendingUp, ShieldCheck, UploadCloud, CheckCircle2, AlertCircle, Info, Loader2, Settings, ArrowLeft, Download, Sun, Moon } from "lucide-react";

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
#root { max-width: none !important; margin: 0 !important; padding: 0 !important; text-align: left !important; width: 100%; }
body { margin: 0; }
[data-theme="dark"] {
  --bg: #0F1420; --surface: #161D2E; --border: #232C42; --border-light: #2A3450;
  --text: #E9ECF3; --text-heading: #F4F1EA; --muted: #8992A9; --muted2: #5B6579;
  --accent: #E8A33D; --accent-text: #161006; --accent-border: #E8A33D40;
  --green: #3FBF7F; --red: #E5484D; --red-border: #E5484D40;
  --row-border: #1C2438; --warning-bg: #2A1F12; --benefit-bg: #123024;
}
[data-theme="light"] {
  --bg: #F4F5F8; --surface: #FFFFFF; --border: #E1E4EA; --border-light: #D5D9E0;
  --text: #1A2233; --text-heading: #0F1420; --muted: #5B6579; --muted2: #8992A9;
  --accent: #E4711E; --accent-text: #FFFFFF; --accent-border: #E4711E40;
  --green: #1E9D5C; --red: #D6373D; --red-border: #D6373D40;
  --row-border: #EDEFF3; --warning-bg: #FDF0DC; --benefit-bg: #E3F6EC;
}`;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const fmtExpiryIso = (iso) => {
  const [y, m, d] = (iso || "").split("-");
  if (!y || !m || !d) return iso || "";
  return `${d}-${MONTHS[parseInt(m, 10) - 1]}-${y}`;
};
const fmtExpiryYyyymmdd = (s) => {
  if (!s || s.length !== 8) return s || "";
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  return `${d}-${MONTHS[parseInt(m, 10) - 1]}-${y}`;
};
// accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD-MMM-YYYY, DD-MMM-YY, DDMMMYYYY -> canonical DD-MMM-YYYY
const normalizeExpiry = (raw) => {
  const s = (raw || "").trim().toUpperCase();
  if (/^\d{1,2}-[A-Z]{3}-\d{2}$/.test(s)) {
    const [d, mon, yy] = s.split("-");
    return `${d.padStart(2, "0")}-${mon}-20${yy}`;
  }
  if (/^\d{1,2}-[A-Z]{3}-\d{4}$/.test(s)) {
    const [d, mon, y] = s.split("-");
    return `${d.padStart(2, "0")}-${mon}-${y}`;
  }
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return fmtExpiryIso(`${m[1]}-${m[2]}-${m[3]}`);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return fmtExpiryIso(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  m = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/);
  if (m) return `${m[1].padStart(2, "0")}-${m[2]}-${m[3]}`;
  return s;
};
const parseExpiryDate = (disp) => {
  const [d, mon, y] = (disp || "").split("-");
  return new Date(`${mon} ${d}, ${y}`);
};

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const findVal = (row, needle) => {
  const key = Object.keys(row).find((k) => norm(k).includes(needle));
  return key ? row[key] : undefined;
};

// BSE F&O (Sensex, Bankex) trades through the same NSE Bhavcopy/SPAN/ELM
// files — so those symbols are just regular NFO symbols, no separate
// exchange option is needed for them.

// ---- persistence: IndexedDB so uploaded files survive a page refresh ----
// (this runs in your own browser tab, not inside a Claude.ai preview, so
// normal browser storage is safe to use here)
const DB_NAME = "vasus_calculator_db";
const STORE = "kv";
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbClearAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =====================================================================
// NSE parsing
// =====================================================================

function parseBhavcopy(rows) {
  return rows
    .map((row) => {
      const symbol = (findVal(row, "tckrsymb") || "").toUpperCase().trim();
      const expiryIso = findVal(row, "xprydt") || "";
      const instrTp = (findVal(row, "fininstrmtp") || "").toUpperCase();
      const strikeRaw = findVal(row, "strkpric");
      const optnTp = (findVal(row, "optntp") || "").toUpperCase().trim();
      const lotSize = Number(findVal(row, "newbrdlotqty") || 0);
      const settlePrice = Number(findVal(row, "sttlmpric") || 0);
      const closePrice = Number(findVal(row, "clspric") || 0);
      const underlyingPrice = Number(findVal(row, "undrlygpric") || 0);
      if (!symbol || !expiryIso || !instrTp) return null;
      const instrument = instrTp.endsWith("F") ? "FUT" : "OPT";
      const strike = instrument === "OPT" && strikeRaw ? String(parseFloat(strikeRaw)) : "";
      const optionType = instrument === "OPT" ? optnTp : "";
      const price = settlePrice > 0 ? settlePrice : closePrice; // instrument's own price — premium for options
      return { symbol, expiry: fmtExpiryIso(expiryIso), instrument, strike, optionType, lotSize, price, underlyingPrice: underlyingPrice > 0 ? underlyingPrice : price };
    })
    .filter(Boolean);
}

function parseElm(rows) {
  const map = {};
  rows.forEach((row) => {
    const symbol = (findVal(row, "symbol") || "").toUpperCase().trim();
    const instType = (findVal(row, "instrumenttype") || "").toUpperCase().trim();
    const totalPct = Number(findVal(row, "totalapplicableelm") || 0);
    if (!symbol) return;
    map[symbol] = map[symbol] || { fut: 0, opt: 0 };
    if (instType === "OTH") map[symbol].fut = totalPct;
    else if (instType === "OTM") map[symbol].opt = totalPct;
  });
  return map;
}

// Contract-level ELM file (no header row): InstrumentType, Symbol, Expiry,
// Strike, OptionType, unused, ELM%. This is more precise than the aggregate
// ELM file above — the same symbol+expiry can carry different ELM% per
// strike (e.g. one specific strike flagged with a higher rate) — so it's
// preferred wherever a row exists, falling back to the aggregate file
// otherwise.
function parseElmContracts(rows) {
  const map = {};
  rows.forEach((r) => {
    if (!Array.isArray(r) || r.length < 7) return;
    const instrTypeRaw = (r[0] || "").toUpperCase().trim();
    const symbol = (r[1] || "").toUpperCase().trim();
    const expiryRaw = r[2] || "";
    const strikeRaw = r[3];
    const optTypeRaw = (r[4] || "").toUpperCase().trim();
    const elmPct = Number(r[6] || 0);
    if (!symbol || !expiryRaw) return;
    const expiry = normalizeExpiry(expiryRaw);
    const instrument = instrTypeRaw.startsWith("FUT") ? "FUT" : "OPT";
    if (instrument === "FUT") {
      map[`${symbol}|${expiry}|FUT`] = elmPct;
    } else {
      const strike = String(parseFloat(strikeRaw));
      map[`${symbol}|${expiry}|${strike}|${optTypeRaw}`] = elmPct;
    }
  });
  return map;
}

function getContractElmPct(map, leg) {
  const key = leg.instrument === "FUT" ? `${leg.symbol}|${leg.expiry}|FUT` : `${leg.symbol}|${leg.expiry}|${leg.strike}|${leg.optionType}`;
  return map[key];
}

// BSE contract-specification file (no header row) — supplies BFO contracts
// (Sensex, Bankex) that NSE's Bhavcopy never includes, since those trade on
// BSE. Column positions confirmed against real data: field 3 = instrument
// type (SF/SO = stock fut/opt, IF/IO = index fut/opt), field 5 = symbol,
// field 7 = expiry, field 8 = strike×100 (0 for futures), field 9 = option
// type, field 31 = lot size. This file has no settlement/underlying price —
// that's backfilled separately from the .spn file's live spot price.
function parseBseContractMaster(rows) {
  return rows
    .map((r) => {
      if (!Array.isArray(r) || r.length < 31) return null;
      const instrTypeRaw = (r[2] || "").toUpperCase().trim();
      const symbol = (r[4] || "").toUpperCase().trim();
      const expiryRaw = r[6] || "";
      const strikeRaw = r[7];
      const optionType = (r[8] || "").toUpperCase().trim();
      const lotSize = Number(r[30] || 0);
      if (!symbol || !expiryRaw || !instrTypeRaw) return null;
      const instrument = instrTypeRaw.endsWith("F") ? "FUT" : "OPT";
      const strike = instrument === "OPT" && strikeRaw ? String(parseFloat(strikeRaw) / 100) : "";
      return { symbol, expiry: normalizeExpiry(expiryRaw), instrument, strike, optionType: instrument === "OPT" ? optionType : "", lotSize };
    })
    .filter(Boolean);
}

// =====================================================================
// .spn SPAN file — shared by NSE and MCX (same PC-SPAN 4.00 XML format)
// =====================================================================
// Futures live under <futPf>. Options live under <oopPf> (options-on-
// physical/index) OR <oofPf> (options-on-futures — how MCX represents
// commodity options). Each contract carries a <ra> risk array of 16
// values: P&L per unit for one long contract under NSE/MCX's 16 combined
// price/volatility scan scenarios. Calendar spread charges live in
// per-commodity <ccDef><dSpread> blocks, referencing two legs either by
// exact expiry (<pLeg><pe>, as NSE does) or by tier number (<tLeg><tn>,
// as MCX does). We only resolve the expiry-keyed (NSE-style) form here —
// MCX's tier-based spread tables aren't mapped to actual expiries yet.
function parseSpanFile(text) {
  const futures = {};
  const options = {};
  const spreads = {};
  const deltas = {};
  const underlyingPrices = {}; // symbol -> live spot/underlying price, from the <phyPf><phy><p> block

  const readArray = (block) => {
    const raMatch = block.match(/<ra>[\s\S]*?<\/ra>/);
    if (!raMatch) return null;
    const vals = [...raMatch[0].matchAll(/<a>(-?[\d.]+)<\/a>/g)].map((m) => parseFloat(m[1]));
    return vals.length >= 16 ? vals : null;
  };

  const phyBlocks = text.split("<phyPf>").slice(1);
  for (const raw of phyBlocks) {
    const chunk = raw.slice(0, 2000); // the phy block itself is short, no need to scan the whole rest of the file
    const code = chunk.match(/<pfCode>([^<]+)<\/pfCode>/);
    const price = chunk.match(/<p>([^<]+)<\/p>/);
    if (code && price) {
      const symbol = code[1].trim().toUpperCase();
      const p = parseFloat(price[1]);
      if (p > 0 && !underlyingPrices[symbol]) underlyingPrices[symbol] = p;
    }
  }

  const futBlocks = text.split("<futPf>").slice(1);
  for (const raw of futBlocks) {
    const block = raw.split("</futPf>")[0];
    const codeMatch = block.match(/<pfCode>([^<]+)<\/pfCode>/);
    if (!codeMatch) continue;
    const symbol = codeMatch[1].trim().toUpperCase();
    const entries = block.split("<fut>").slice(1);
    for (const e of entries) {
      const eb = e.split("</fut>")[0];
      const pe = eb.match(/<pe>(\d{8})<\/pe>/);
      const arr = readArray(eb);
      if (!pe || !arr) continue;
      const expiry = fmtExpiryYyyymmdd(pe[1]);
      futures[`${symbol}|${expiry}`] = arr;
      const dMatch = eb.match(/<d>(-?[\d.]+)<\/d>/);
      if (dMatch) deltas[`${symbol}|${expiry}`] = parseFloat(dMatch[1]);
    }
  }

  const parseOptionContainer = (tagName) => {
    const blocks = text.split(`<${tagName}>`).slice(1);
    for (const raw of blocks) {
      const block = raw.split(`</${tagName}>`)[0];
      const codeMatch = block.match(/<pfCode>([^<]+)<\/pfCode>/);
      if (!codeMatch) continue;
      const symbol = codeMatch[1].trim().toUpperCase();
      const seriesBlocks = block.split("<series>").slice(1);
      for (const sraw of seriesBlocks) {
        const sb = sraw.split("</series>")[0];
        const pe = sb.match(/<pe>(\d{8})<\/pe>/);
        if (!pe) continue;
        const expiry = fmtExpiryYyyymmdd(pe[1]);
        const optEntries = sb.split("<opt>").slice(1);
        for (const oe of optEntries) {
          const ob = oe.split("</opt>")[0];
          const o = ob.match(/<o>([CP])<\/o>/);
          const k = ob.match(/<k>([\d.]+)<\/k>/);
          const arr = readArray(ob);
          if (!o || !k || !arr) continue;
          const optionType = o[1] === "C" ? "CE" : "PE";
          const strike = String(parseFloat(k[1]));
          const key = `${symbol}|${expiry}|${strike}|${optionType}`;
          options[key] = arr;
          const dMatch = ob.match(/<d>(-?[\d.]+)<\/d>/);
          if (dMatch) deltas[key] = parseFloat(dMatch[1]);
        }
      }
    }
  };
  parseOptionContainer("oopPf");
  parseOptionContainer("oofPf");

  const ccBlocks = text.split("<ccDef>").slice(1);
  const somRates = {}; // symbol -> ₹ per short-option-lot floor charge
  const tierSpreads = {}; // symbol|tierNumber -> ₹ per unit spread charge (MCX-style, tier-based)
  for (const raw of ccBlocks) {
    const block = raw.split("</ccDef>")[0];
    const ccMatch = block.match(/<cc>([^<]+)<\/cc>/);
    if (!ccMatch) continue;
    const symbol = ccMatch[1].trim().toUpperCase();
    const spreadBlocks = block.split("<dSpread>").slice(1);
    for (const sraw of spreadBlocks) {
      const sb = sraw.split("</dSpread>")[0];
      const rateMatch = sb.match(/<val>([\d.]+)<\/val>/);
      const peMatches = [...sb.matchAll(/<pe>(\d{8})<\/pe>/g)].map((m) => m[1]);
      if (rateMatch && peMatches.length >= 2) {
        const [peA, peB] = peMatches;
        const expA = fmtExpiryYyyymmdd(peA);
        const expB = fmtExpiryYyyymmdd(peB);
        const rate = parseFloat(rateMatch[1]);
        spreads[`${symbol}|${expA}|${expB}`] = rate;
        spreads[`${symbol}|${expB}|${expA}`] = rate;
      } else if (rateMatch) {
        // MCX-style: legs reference a tier number instead of an exact expiry
        const tnMatches = [...sb.matchAll(/<tLeg>[\s\S]*?<tn>(\d+)<\/tn>[\s\S]*?<\/tLeg>/g)].map((m) => m[1]);
        if (tnMatches.length >= 2 && tnMatches[0] === tnMatches[1]) {
          tierSpreads[`${symbol}|${tnMatches[0]}`] = parseFloat(rateMatch[1]);
        }
      }
    }
    // Short Option Minimum: a per-lot floor charge on short options, layered
    // on top of scan risk when the scan risk alone comes out too low. Real
    // NSE files checked so far all carry a rate of 0 for every symbol
    // tested, so this currently has no effect in practice — implemented so
    // it's correct if NSE ever sets a non-zero rate.
    const somMatch = block.match(/<somTiers>[\s\S]*?<val>([\d.]+)<\/val>/);
    if (somMatch) somRates[symbol] = parseFloat(somMatch[1]);
  }

  return { futures, options, spreads, somRates, deltas, underlyingPrices, tierSpreads };
}

function getArray(spanData, leg) {
  const key = leg.instrument === "FUT" ? `${leg.symbol}|${leg.expiry}` : `${leg.symbol}|${leg.expiry}|${leg.strike}|${leg.optionType}`;
  return (leg.instrument === "FUT" ? spanData.futures : spanData.options)[key] || null;
}

function getCompositeDelta(spanData, leg) {
  const key = leg.instrument === "FUT" ? `${leg.symbol}|${leg.expiry}` : `${leg.symbol}|${leg.expiry}|${leg.strike}|${leg.optionType}`;
  const d = spanData.deltas?.[key];
  return Number.isFinite(d) ? d : null;
}

// NSE calendar-spread matching is done on the portfolio's net delta in each
// expiry month. Opposite-signed expiry deltas form calendar spreads; the
// matched amount is the smaller absolute delta, and the dSpread table supplies
// the charge per matched delta. This deliberately uses the uploaded SPAN data
// only — no broker/file-specific constants.
// Resolves a calendar-spread rate between two expiries of the same symbol.
// NFO/BFO store rates keyed by exact expiry pair (spanData.spreads). MCX's
// .spn file instead keys rates by *tier number* — a documented SPAN
// convention where each tier represents one adjacent-month gap (tier 1 =
// nearest-to-next-nearest expiry, tier 2 = next pair, and so on). We derive
// the tier number from the ordinal position of the two expiries among all
// of that symbol's known futures expiries, and only resolve it when the
// two legs are genuinely adjacent months — MCX's tier system isn't
// documented well enough to be confident about non-adjacent combinations,
// so those fall back to full independent margin instead of guessing.
function getSpreadRate(spanData, symbol, expA, expB) {
  const direct = spanData.spreads?.[`${symbol}|${expA}|${expB}`];
  if (direct !== undefined) return direct;
  if (spanData.tierSpreads && Object.keys(spanData.tierSpreads).length) {
    const allExpiries = [...new Set(Object.keys(spanData.futures || {}).filter((k) => k.startsWith(`${symbol}|`)).map((k) => k.split("|")[1]))].sort(
      (a, b) => parseExpiryDate(a) - parseExpiryDate(b)
    );
    const idxA = allExpiries.indexOf(expA);
    const idxB = allExpiries.indexOf(expB);
    if (idxA === -1 || idxB === -1) return undefined;
    const nearIdx = Math.min(idxA, idxB);
    const farIdx = Math.max(idxA, idxB);
    if (farIdx - nearIdx !== 1) return undefined; // only adjacent months map to a single tier cleanly
    return spanData.tierSpreads[`${symbol}|${nearIdx + 1}`];
  }
  return undefined;
}

function calculateCalendarSpreadCharge(groupRows, spanData) {
  const byExpiry = {};
  groupRows.forEach((r) => {
    const delta = getCompositeDelta(spanData, r);
    if (delta === null) return;
    const signedDelta = (r.side === "Buy" ? 1 : -1) * r.qty * delta;
    byExpiry[r.expiry] = (byExpiry[r.expiry] || 0) + signedDelta;
  });

  const expiries = Object.keys(byExpiry)
    .filter((e) => Math.abs(byExpiry[e]) > 1e-12)
    .sort((a, b) => parseExpiryDate(a) - parseExpiryDate(b));

  let charge = 0;
  const work = expiries.map((expiry) => ({ expiry, delta: byExpiry[expiry] }));

  // Match the nearest opposite-signed expiry buckets first, then continue with
  // any residual delta. This handles more than two expiries without hardcoding
  // a particular pair or file.
  for (let i = 0; i < work.length - 1; i++) {
    for (let j = i + 1; j < work.length; j++) {
      const a = work[i];
      const b = work[j];
      if (!a.delta || !b.delta || Math.sign(a.delta) === Math.sign(b.delta)) continue;

      const rate = getSpreadRate(spanData, groupRows[0].symbol, a.expiry, b.expiry);
      if (rate === undefined) continue;

      const matchedDelta = Math.min(Math.abs(a.delta), Math.abs(b.delta));
      if (!matchedDelta) continue;

      charge += matchedDelta * rate;
      a.delta += a.delta > 0 ? -matchedDelta : matchedDelta;
      b.delta += b.delta > 0 ? -matchedDelta : matchedDelta;
      if (Math.abs(a.delta) < 1e-12) a.delta = 0;
      if (Math.abs(b.delta) < 1e-12) b.delta = 0;
    }
  }

  return charge;
}

function calculateNetOptionValue(groupRows) {
  // Contract price is the uploaded previous-close/settlement price supplied
  // by the user's Bhavcopy. Long option value is positive; short option value
  // is negative. Futures do not contribute.
  return groupRows.reduce((sum, r) => {
    if (r.instrument !== "OPT") return sum;
    const value = (r.price || 0) * r.qty;
    return sum + (r.side === "Buy" ? value : -value);
  }, 0);
}

// The .spn risk array stores LOSS for one long unit under each of the 16
// scan scenarios (positive = the long side loses money), not P&L. A long
// position's scan risk is therefore the largest value in the array; a
// short position's is the largest loss on the *other* side, i.e. the
// negative of the array's smallest (most negative = biggest long gain =
// biggest short loss) value.
function scanRisk(spanData, leg) {
  const arr = getArray(spanData, leg);
  if (!arr) return null;
  const longRisk = Math.max(0, Math.max(...arr));
  const shortRisk = Math.max(0, -Math.min(...arr));
  return leg.side === "Buy" ? longRisk : shortRisk;
}

// =====================================================================
// MCX parsing
// =====================================================================
// MCX's Bhavcopy has no lot-size column, so it's derived from the file
// itself: Volume(In 000's) is the day's traded quantity in the contract's
// physical unit (KGS/GMS/BBL...) expressed in thousands, and Volume(Lots)
// is the same volume in lots — so unit-per-lot = (Volume(In 000's)*1000)
// / Volume(Lots). We take the row with the highest lot volume per symbol
// as the most reliable signal; symbols with zero traded volume that day
// won't get a derived lot size.
function deriveMcxLotSizes(rows) {
  const best = {};
  rows.forEach((row) => {
    const symbol = (findVal(row, "symbol") || "").trim().toUpperCase();
    const lots = Number(findVal(row, "volumelots") || 0);
    const volKRaw = findVal(row, "volumein000") || "";
    const match = String(volKRaw).match(/([\d.]+)/);
    const volK = match ? parseFloat(match[1]) : 0;
    if (!symbol || !lots || !volK) return;
    if (!best[symbol] || lots > best[symbol].lots) best[symbol] = { lots, unit: volK * 1000 };
  });
  const map = {};
  Object.entries(best).forEach(([s, v]) => (map[s] = Math.round(v.unit / v.lots)));
  return map;
}

function parseMcxBhavcopy(rows) {
  const lotSizeMap = deriveMcxLotSizes(rows);
  return rows
    .map((row) => {
      const instrName = (findVal(row, "instrumentname") || "").toUpperCase().trim();
      const symbol = (findVal(row, "symbol") || "").trim().toUpperCase();
      const expiryRaw = findVal(row, "expirydate") || "";
      const optionType = (findVal(row, "optiontype") || "").toUpperCase().trim();
      const strikeRaw = findVal(row, "strikeprice");
      const close = Number(findVal(row, "close") || 0);
      const prevClose = Number(findVal(row, "previousclose") || 0);
      if (!symbol || !expiryRaw || !instrName) return null;
      const instrument = instrName.startsWith("FUT") ? "FUT" : "OPT";
      const strike = instrument === "OPT" && strikeRaw && strikeRaw !== "0" ? String(parseFloat(strikeRaw)) : "";
      const optType = instrument === "OPT" && optionType !== "-" ? optionType : "";
      return { symbol, expiry: normalizeExpiry(expiryRaw), instrument, strike, optionType: optType, lotSize: lotSizeMap[symbol] || 0, price: close > 0 ? close : prevClose };
    })
    .filter(Boolean);
}

// MCX Margin Detail Report gives ready percentages per symbol+expiry —
// futures only (options aren't covered, so options fall back to the .spn
// scan-risk method below). Total Margin% already combines Initial+Tender;
// Additional/Special/ELM are one-sided (Long vs Short) on top of that.
function parseMcxMarginFile(rows) {
  const map = {};
  rows.forEach((row) => {
    const symbol = (findVal(row, "symbol") || "").trim().toUpperCase();
    const expiryRaw = findVal(row, "expiry") || "";
    if (!symbol || !expiryRaw) return;
    const expiry = normalizeExpiry(expiryRaw);
    map[`${symbol}|${expiry}`] = {
      totalPct: Number(findVal(row, "totalmargin") || 0),
      addLongPct: Number(findVal(row, "additionallongmargin") || 0),
      addShortPct: Number(findVal(row, "additionalshortmargin") || 0),
      specialLongPct: Number(findVal(row, "speciallongmargin") || 0),
      specialShortPct: Number(findVal(row, "specialshortmargin") || 0),
      elmLongPct: Number(findVal(row, "elmlong") || 0),
      elmShortPct: Number(findVal(row, "elmshort") || 0),
      deliveryPct: Number(findVal(row, "deliverymargin") || 0),
    };
  });
  return map;
}

// =====================================================================
// bulk positions CSV
// =====================================================================
function parsePositionsCsv(rows) {
  return rows
    .map((row) => {
      const instrTypeRaw = (findVal(row, "instrumenttype") || "").toUpperCase().trim();
      const symbol = (findVal(row, "symbol") || "").toUpperCase().trim();
      const expiry = normalizeExpiry(findVal(row, "expiry"));
      const strikeRaw = findVal(row, "strike");
      const optTypeRaw = (findVal(row, "optiontype") || "").toUpperCase().trim();
      const qtyRaw = Number(findVal(row, "qty") || 0);
      const marketRaw = (findVal(row, "market") || "NFO").toUpperCase().trim();
      if (!symbol || !expiry || !qtyRaw) return null;
      const instrument = instrTypeRaw.startsWith("FUT") ? "FUT" : "OPT";
      const optionType = optTypeRaw === "CE" || optTypeRaw === "PE" ? optTypeRaw : "";
      const strike = instrument === "OPT" && strikeRaw ? String(parseFloat(strikeRaw)) : "";
      const side = qtyRaw >= 0 ? "Buy" : "Sell";
      const qty = Math.abs(qtyRaw);
      const market = marketRaw === "MCX" ? "MCX" : marketRaw === "BFO" ? "BFO" : "NFO";
      return { id: crypto.randomUUID(), market, symbol, expiry, instrument, strike, optionType, side, qty };
    })
    .filter(Boolean);
}

function downloadCsv(filename, headers, sampleRows) {
  const csv = [headers.join(","), ...sampleRows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const emptyDraft = () => ({ market: "NFO", symbol: "", expiry: "", instrument: "FUT", strike: "", optionType: "CE", side: "Buy", qty: 0 });
const fileBtnStyle = { display: "flex", alignItems: "center", gap: 8, background: "var(--bg)", border: "1px dashed var(--border-light)", borderRadius: 8, padding: "10px 12px", cursor: "pointer", fontSize: 12.5, color: "var(--muted)" };
const selStyle = { background: "var(--surface)", border: "1px solid var(--border-light)", borderRadius: 6, color: "var(--text)", fontSize: 12.5, padding: "7px 8px", outline: "none", width: "100%" };
const topBtnStyle = { display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 14px", fontSize: 12.5, color: "var(--text)", cursor: "pointer" };

export default function VasusCalculator() {
  const [view, setView] = useState("calculator");
  const [theme, setTheme] = useState(() => localStorage.getItem("vc_theme") || "dark");
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("vc_theme", next);
  };

  const [contracts, setContracts] = useState([]);
  const [bseContracts, setBseContracts] = useState([]);
  const [bseFileStatus, setBseFileStatus] = useState(null);
  const [spanData, setSpanData] = useState({ futures: {}, options: {}, spreads: {}, somRates: {}, deltas: {}, underlyingPrices: {}, tierSpreads: {} });
  const [elmMap, setElmMap] = useState({});
  const [elmContractMap, setElmContractMap] = useState({});
  const [fileStatus, setFileStatus] = useState({ contracts: null, span: null, elm: null, elmContracts: null });
  const [spanLoading, setSpanLoading] = useState(false);

  const [mcxContracts, setMcxContracts] = useState([]);
  const [mcxSpanData, setMcxSpanData] = useState({ futures: {}, options: {}, spreads: {}, somRates: {}, deltas: {}, underlyingPrices: {}, tierSpreads: {} });
  const [mcxMarginMap, setMcxMarginMap] = useState({});
  const [mcxFileStatus, setMcxFileStatus] = useState({ contracts: null, span: null, margin: null });
  const [mcxSpanLoading, setMcxSpanLoading] = useState(false);

  const [legs, setLegs] = useState([]);
  const [draft, setDraft] = useState(emptyDraft());
  const [csvError, setCsvError] = useState("");
  const [restored, setRestored] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedSyncStatus, setSharedSyncStatus] = useState({ contracts: null, span: null, elm: null, elmContracts: null, bseContracts: null });
  const inputs = {
    contracts: useRef(), span: useRef(), elm: useRef(), elmContracts: useRef(), positions: useRef(), bseContracts: useRef(),
    mcxContracts: useRef(), mcxSpan: useRef(), mcxMargin: useRef(),
  };

  useEffect(() => {
    (async () => {
      try {
        const [c, sd, el, ec, fs, lg, mc, msd, mm, mfs, bc, bfs] = await Promise.all([
          idbGet("contracts"), idbGet("spanData"), idbGet("elmMap"), idbGet("elmContractMap"), idbGet("fileStatus"), idbGet("legs"),
          idbGet("mcxContracts"), idbGet("mcxSpanData"), idbGet("mcxMarginMap"), idbGet("mcxFileStatus"),
          idbGet("bseContracts"), idbGet("bseFileStatus"),
        ]);
        if (c) setContracts(c);
        if (sd) setSpanData(sd);
        if (el) setElmMap(el);
        if (ec) setElmContractMap(ec);
        if (fs) setFileStatus(fs);
        if (lg) setLegs(lg);
        if (mc) setMcxContracts(mc);
        if (msd) setMcxSpanData(msd);
        if (mm) setMcxMarginMap(mm);
        if (mfs) setMcxFileStatus(mfs);
        if (bc) setBseContracts(bc);
        if (bfs) setBseFileStatus(bfs);
      } catch (e) {
        console.warn("Could not restore saved data", e);
      } finally {
        setRestored(true);
      }
    })();
  }, []);

  // Shared data: fetched from the backend (Vercel Blob + KV) so whatever any
  // one person uploads is visible to every visitor automatically — this
  // overrides the local IndexedDB restore above once it's available, since
  // the shared copy is the source of truth once someone has uploaded one.
  useEffect(() => {
    (async () => {
      try {
        setSharedLoading(true);
        const res = await fetch("/api/files");
        if (!res.ok) return;
        const data = await res.json();
        if (data.bhavcopy?.url) {
          const text = await (await fetch(data.bhavcopy.url)).text();
          const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
          const parsed = parseBhavcopy(rows);
          setContracts(parsed);
          setFileStatus((s) => ({ ...s, contracts: `${parsed.length} contracts (Bhavcopy, shared)` }));
        }
        if (data.span?.url) {
          const text = await (await fetch(data.span.url)).text();
          const parsed = parseSpanFile(text);
          setSpanData(parsed);
          setFileStatus((s) => ({ ...s, span: `${Object.keys(parsed.futures).length} fut + ${Object.keys(parsed.options).length} opt (shared)` }));
        }
        if (data.elm?.url) {
          const text = await (await fetch(data.elm.url)).text();
          const rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
          const map = parseElm(rows);
          setElmMap(map);
          setFileStatus((s) => ({ ...s, elm: `${Object.keys(map).length} symbols (shared)` }));
        }
        if (data.elmContracts?.url) {
          const text = await (await fetch(data.elmContracts.url)).text();
          const rows = Papa.parse(text, { header: false, skipEmptyLines: true }).data;
          const map = parseElmContracts(rows);
          setElmContractMap(map);
          setFileStatus((s) => ({ ...s, elmContracts: `${Object.keys(map).length} contracts (shared)` }));
        }
        if (data.bseContracts?.url) {
          const text = await (await fetch(data.bseContracts.url)).text();
          const withHeader = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
          let parsed = parseBhavcopy(withHeader);
          let source = "Bhavcopy";
          if (parsed.length === 0) {
            const noHeader = Papa.parse(text, { header: false, skipEmptyLines: true }).data;
            parsed = parseBseContractMaster(noHeader);
            source = "contract specs";
          }
          setBseContracts(parsed);
          setBseFileStatus(`${parsed.length} BSE contracts (${source}, shared)`);
        }
      } catch (e) {
        console.warn("Could not load shared data", e);
      } finally {
        setSharedLoading(false);
      }
    })();
  }, []);

  useEffect(() => { if (restored && contracts.length) idbSet("contracts", contracts); }, [restored, contracts]);
  useEffect(() => { if (restored && (Object.keys(spanData.futures).length || Object.keys(spanData.options).length)) idbSet("spanData", spanData); }, [restored, spanData]);
  useEffect(() => { if (restored && Object.keys(elmMap).length) idbSet("elmMap", elmMap); }, [restored, elmMap]);
  useEffect(() => { if (restored && Object.keys(elmContractMap).length) idbSet("elmContractMap", elmContractMap); }, [restored, elmContractMap]);
  useEffect(() => { if (restored && bseContracts.length) idbSet("bseContracts", bseContracts); }, [restored, bseContracts]);
  useEffect(() => { if (restored && bseFileStatus) idbSet("bseFileStatus", bseFileStatus); }, [restored, bseFileStatus]);
  useEffect(() => { if (restored) idbSet("fileStatus", fileStatus); }, [restored, fileStatus]);
  useEffect(() => { if (restored) idbSet("legs", legs); }, [restored, legs]);
  useEffect(() => { if (restored && mcxContracts.length) idbSet("mcxContracts", mcxContracts); }, [restored, mcxContracts]);
  useEffect(() => { if (restored && (Object.keys(mcxSpanData.futures).length || Object.keys(mcxSpanData.options).length)) idbSet("mcxSpanData", mcxSpanData); }, [restored, mcxSpanData]);
  useEffect(() => { if (restored && Object.keys(mcxMarginMap).length) idbSet("mcxMarginMap", mcxMarginMap); }, [restored, mcxMarginMap]);
  useEffect(() => { if (restored) idbSet("mcxFileStatus", mcxFileStatus); }, [restored, mcxFileStatus]);

  const clearSavedData = async () => {
    await idbClearAll();
    setContracts([]); setSpanData({ futures: {}, options: {}, spreads: {}, somRates: {}, deltas: {}, underlyingPrices: {}, tierSpreads: {} }); setElmMap({}); setElmContractMap({});
    setFileStatus({ contracts: null, span: null, elm: null, elmContracts: null }); setLegs([]);
    setMcxContracts([]); setMcxSpanData({ futures: {}, options: {}, spreads: {}, somRates: {}, deltas: {}, underlyingPrices: {}, tierSpreads: {} }); setMcxMarginMap({});
    setMcxFileStatus({ contracts: null, span: null, margin: null });
    setBseContracts([]); setBseFileStatus(null);
  };

  // Pushes the raw file to the shared backend (Vercel Blob) so every visitor
  // sees it, not just this browser. Fire-and-forget from the UI's point of
  // view — local parsing/state already happened, this just syncs it out.
  const pushToShared = async (file, kind) => {
    setSharedSyncStatus((s) => ({ ...s, [kind]: "syncing" }));
    try {
      await upload(file.name, file, { access: "public", handleUploadUrl: "/api/upload", clientPayload: kind });
      setSharedSyncStatus((s) => ({ ...s, [kind]: "synced" }));
    } catch (e) {
      console.warn("Shared sync failed", e);
      setSharedSyncStatus((s) => ({ ...s, [kind]: "error" }));
    }
  };

  const handleCsvUpload = (kind) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (kind === "contracts") {
          const parsed = parseBhavcopy(res.data);
          setContracts(parsed);
          setFileStatus((s) => ({ ...s, contracts: `${parsed.length} contracts (Bhavcopy)` }));
        } else if (kind === "elm") {
          const map = parseElm(res.data);
          setElmMap(map);
          setFileStatus((s) => ({ ...s, elm: `${Object.keys(map).length} symbols` }));
        }
      },
    });
    pushToShared(file, kind === "contracts" ? "bhavcopy" : kind);
  };

  const handleElmContractsUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (res) => {
        const map = parseElmContracts(res.data);
        setElmContractMap(map);
        setFileStatus((s) => ({ ...s, elmContracts: `${Object.keys(map).length} contracts` }));
      },
    });
    pushToShared(file, "elmContracts");
  };

  const handleBseContractsUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      // Auto-detect format: try the real Bhavcopy layout first (header row,
      // same columns as NSE's — gives real settlement + underlying price).
      // If that yields nothing (e.g. this is the no-header, positional
      // contract-specs file instead), fall back to the positional parser.
      const withHeader = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
      let parsed = parseBhavcopy(withHeader);
      let source = "Bhavcopy";
      if (parsed.length === 0) {
        const noHeader = Papa.parse(text, { header: false, skipEmptyLines: true }).data;
        parsed = parseBseContractMaster(noHeader);
        source = "contract specs";
      }
      setBseContracts(parsed);
      setBseFileStatus(`${parsed.length} BSE contracts (${source})`);
    };
    reader.readAsText(file);
    pushToShared(file, "bseContracts");
  };

  const handleSpanUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSpanLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setTimeout(() => {
        const data = parseSpanFile(reader.result);
        setSpanData(data);
        setFileStatus((s) => ({ ...s, span: `${Object.keys(data.futures).length} fut + ${Object.keys(data.options).length} opt contracts + ${Object.keys(data.deltas).length} deltas` }));
        setSpanLoading(false);
      }, 30);
    };
    reader.readAsText(file);
    pushToShared(file, "span");
  };

  const handleMcxCsvUpload = (kind) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        if (kind === "contracts") {
          // MCX switched its Bhavcopy to the same column layout as NSE/BSE —
          // try that parser first (real price data). Its lot-size column
          // isn't populated in this new format (always "1"), unlike the old
          // MCX-specific layout, which derives lot size from volume ratios.
          // Fall back to the old parser if the new-style one finds nothing.
          let parsed = parseBhavcopy(res.data);
          let note = "";
          if (parsed.length > 0) {
            const hasRealLotSize = parsed.some((c) => c.lotSize > 1);
            if (!hasRealLotSize) note = " — lot size not available in this file";
          } else {
            parsed = parseMcxBhavcopy(res.data);
          }
          setMcxContracts(parsed);
          setMcxFileStatus((s) => ({ ...s, contracts: `${parsed.length} contracts (Bhavcopy)${note}` }));
        } else if (kind === "margin") {
          const map = parseMcxMarginFile(res.data);
          setMcxMarginMap(map);
          setMcxFileStatus((s) => ({ ...s, margin: `${Object.keys(map).length} symbol/expiry rows` }));
        }
      },
    });
  };

  const handleMcxSpanUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMcxSpanLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      setTimeout(() => {
        const data = parseSpanFile(reader.result);
        setMcxSpanData(data);
        setMcxFileStatus((s) => ({ ...s, span: `${Object.keys(data.futures).length} fut + ${Object.keys(data.options).length} opt contracts + ${Object.keys(data.deltas).length} deltas` }));
        setMcxSpanLoading(false);
      }, 30);
    };
    reader.readAsText(file);
  };

  const handlePositionsUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError("");
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const parsed = parsePositionsCsv(res.data);
        if (parsed.length === 0) {
          setCsvError("No valid rows found — check the file matches the expected headers.");
          return;
        }
        setLegs((l) => [...l, ...parsed]);
      },
    });
    e.target.value = "";
  };

  // Merges NSE Bhavcopy contracts with BSE-specific ones (Sensex, Bankex —
  // not present in NSE's Bhavcopy at all). BSE contracts have no price of
  // their own, so we backfill underlying price from the .spn file's live
  // spot price, using it as the futures price too (a reasonable stand-in,
  // same convention used for NSE futures already).
  const nfoContracts = useMemo(() => {
    if (!bseContracts.length) return contracts;
    const underlyingPrices = spanData.underlyingPrices || {};
    const existingKeys = new Set(contracts.map((c) => `${c.symbol}|${c.expiry}|${c.instrument}|${c.strike}|${c.optionType}`));
    const enrichedBse = bseContracts
      .map((c) => {
        // Bhavcopy-format uploads already carry real price/underlyingPrice —
        // only fall back to the .spn spot price for the simpler positional
        // contract-specs file, which has no price data of its own.
        const underlyingPrice = c.underlyingPrice > 0 ? c.underlyingPrice : underlyingPrices[c.symbol] || 0;
        const price = c.price > 0 ? c.price : c.instrument === "FUT" ? underlyingPrice : 0;
        return { ...c, underlyingPrice, price };
      })
      .filter((c) => !existingKeys.has(`${c.symbol}|${c.expiry}|${c.instrument}|${c.strike}|${c.optionType}`));
    return [...contracts, ...enrichedBse];
  }, [contracts, bseContracts, spanData.underlyingPrices]);

  const activeContracts = useMemo(() => {
    if (draft.market === "MCX") return mcxContracts;
    return nfoContracts;
  }, [draft.market, nfoContracts, mcxContracts]);
  const symbols = useMemo(() => [...new Set(activeContracts.map((c) => c.symbol))].sort(), [activeContracts]);
  const expiries = useMemo(() => (!draft.symbol ? [] : [...new Set(activeContracts.filter((c) => c.symbol === draft.symbol).map((c) => c.expiry))]), [activeContracts, draft.symbol]);
  const strikes = useMemo(
    () =>
      !draft.symbol || !draft.expiry
        ? []
        : [...new Set(activeContracts.filter((c) => c.symbol === draft.symbol && c.expiry === draft.expiry && c.instrument === "OPT" && c.optionType === draft.optionType).map((c) => c.strike))],
    [activeContracts, draft.symbol, draft.expiry, draft.optionType]
  );

  const matchContract = (leg) => {
    const pool = leg.market === "MCX" ? mcxContracts : nfoContracts;
    return pool.find((c) => c.symbol === leg.symbol && c.expiry === leg.expiry && c.instrument === leg.instrument && (leg.instrument === "FUT" || (c.strike === leg.strike && c.optionType === leg.optionType)));
  };

  const draftContract = draft.instrument === "FUT" || draft.strike ? matchContract(draft) : null;
  const draftLotSize = draftContract?.lotSize || 0;

  // once a contract resolves and qty hasn't been touched yet, default to one lot
  useEffect(() => {
    if (draftLotSize && !draft.qty) setDraft((d) => ({ ...d, qty: draftLotSize }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftLotSize]);

  const addLeg = () => {
    if (!draft.symbol || !draft.expiry) return;
    const c = matchContract(draft);
    const qty = Number(draft.qty || 0);
    setLegs((l) => [...l, { id: crypto.randomUUID(), market: draft.market, symbol: draft.symbol, expiry: draft.expiry, instrument: draft.instrument, strike: draft.strike, optionType: draft.optionType, side: draft.side, qty }]);
    // keep market/symbol/expiry/instrument/type/side so adding several legs
    // of the same kind in a row doesn't require reselecting every field —
    // only strike and qty reset, since those usually change per leg
    setDraft((d) => ({ ...d, strike: "", qty: 0 }));
  };
  const removeLeg = (id) => setLegs((l) => l.filter((x) => x.id !== id));
  const clearLegs = () => setLegs([]);

  const rows = useMemo(() => {
    // MCX quotes some commodities in a pricing unit different from the lot
    // size's natural unit — most notably gold, which is universally quoted
    // in India as ₹ per 10 grams even though lot sizes are stated in grams
    // (e.g. GOLDM's 100g lot = 10 pricing units, not 100). Verified this
    // directly: without the /10 correction, GOLDM calendar-spread and
    // single-leg margin both came out ~10x too high against a real Zerodha
    // MCX screenshot. Only applying this to GOLD/GOLDM, which are the two
    // variants actually checked — other gold contracts (GOLDPETAL,
    // GOLDGUINEA, GOLDTEN, GOLDHNI, GOLDGLOBAL, GOLDPTLDEL) may have their
    // own denomination quirks that haven't been verified the same way.
    const mcxPricingUnits = (symbol) => (["GOLD", "GOLDM"].includes(symbol) ? 10 : 1);

    let built = legs.map((leg) => {
      const c = matchContract(leg);
      const lotSize = c?.lotSize || 0;
      const price = c?.price || 0;
      const pricingUnits = leg.market === "MCX" ? mcxPricingUnits(leg.symbol) : 1;
      const notional = price * (leg.qty / pricingUnits);
      const isLongOption = leg.instrument === "OPT" && leg.side === "Buy";

      if (leg.market === "MCX") {
        if (leg.instrument === "FUT") {
          const m = mcxMarginMap[`${leg.symbol}|${leg.expiry}`];
          const marginFound = !!m;
          const isBuy = leg.side === "Buy";
          const span = m ? notional * (m.totalPct / 100) : 0;
          const sideExtra = m ? (isBuy ? m.addLongPct + m.specialLongPct + m.elmLongPct : m.addShortPct + m.specialShortPct + m.elmShortPct) + m.deliveryPct : 0;
          const exposure = m ? notional * (sideExtra / 100) : 0;
          return { ...leg, found: !!c, spanFound: marginFound, lotSize, price, span, exposure, premium: 0, premiumReceivable: 0, spreadPair: false, total: span + exposure };
        }
        // MCX options: margin file doesn't cover these — use the .spn scan-risk array
        const perUnitRisk = isLongOption ? 0 : scanRisk(mcxSpanData, leg);
        const spanFound = isLongOption ? true : perUnitRisk !== null;
        let span = isLongOption ? 0 : (perUnitRisk || 0) * (leg.qty / pricingUnits);
        if (!isLongOption && lotSize) {
          const somRate = mcxSpanData.somRates?.[leg.symbol] || 0;
          span = Math.max(span, somRate * (leg.qty / lotSize));
        }
        const premium = isLongOption ? notional : 0;
        const premiumReceivable = leg.instrument === "OPT" && leg.side === "Sell" ? notional : 0;
        return { ...leg, found: !!c, spanFound, lotSize, price, span, exposure: 0, premium, premiumReceivable, spreadPair: false, total: span + premium };
      }

      // NFO — SPAN + ELM data from the Bhavcopy/SPAN/ELM files (Sensex and Bankex trade under NFO too, same data)
      const perUnitRisk = isLongOption ? 0 : scanRisk(spanData, leg);
      const spanFound = isLongOption ? true : perUnitRisk !== null;
      let span = isLongOption ? 0 : (perUnitRisk || 0) * leg.qty;
      if (!isLongOption && leg.instrument === "OPT" && leg.side === "Sell" && lotSize) {
        const somRate = spanData.somRates?.[leg.symbol] || 0;
        span = Math.max(span, somRate * (leg.qty / lotSize));
      }
      const contractElmPct = getContractElmPct(elmContractMap, leg);
      const elmPct = (contractElmPct !== undefined ? contractElmPct : (leg.instrument === "FUT" ? elmMap[leg.symbol]?.fut : elmMap[leg.symbol]?.opt)) / 100 || 0;
      // Exposure margin is levied on the underlying's value, not the option's
      // own (tiny) premium — e.g. a RELIANCE option settling at ₹4.94 still
      // carries exposure margin sized off RELIANCE's ₹1,313 spot price.
      const exposureNotional = leg.instrument === "OPT" ? (c?.underlyingPrice || 0) * leg.qty : notional;
      const exposure = isLongOption ? 0 : exposureNotional * elmPct;
      const premium = isLongOption ? notional : 0;
      const premiumReceivable = leg.instrument === "OPT" && leg.side === "Sell" ? notional : 0;
      return { ...leg, found: !!c, spanFound, lotSize, price, span, exposure, premium, premiumReceivable, spreadPair: false, total: span + exposure + premium };
    });

    // MCX calendar spread: MCX futures margin is percentage-based (from the
    // Margin Detail Report), not scan-risk-array-based, so it can't go
    // through the NFO/BFO combo logic below. Same-symbol, opposite-side,
    // equal-quantity, adjacent-month futures pairs get MCX's own per-unit
    // spread charge (from the .spn file's tier-based rates) in place of
    // their independent percentage-based span.
    const mcxFutBySymbol = {};
    built.forEach((r, idx) => { if (r.market === "MCX" && r.instrument === "FUT") (mcxFutBySymbol[r.symbol] ||= []).push(idx); });
    Object.values(mcxFutBySymbol).forEach((idxs) => {
      const used = new Set();
      idxs.forEach((i) => {
        if (used.has(i) || built[i].side !== "Buy") return;
        const j = idxs.find((jj) => !used.has(jj) && jj !== i && built[jj].side === "Sell" && built[jj].expiry !== built[i].expiry && built[jj].qty === built[i].qty);
        if (j === undefined) return;
        const legA = built[i], legB = built[j];
        const rate = getSpreadRate(mcxSpanData, legA.symbol, legA.expiry, legB.expiry);
        if (rate === undefined) return; // non-adjacent months, or no matching tier rate found — leave as independent margin
        const matchedQty = legA.qty / mcxPricingUnits(legA.symbol);
        const spreadCharge = rate * matchedQty;
        built[i] = { ...legA, span: spreadCharge / 2, calendarSpread: true, total: spreadCharge / 2 + legA.exposure };
        built[j] = { ...legB, span: spreadCharge / 2, calendarSpread: true, total: spreadCharge / 2 + legB.exposure };
        used.add(i); used.add(j);
      });
    });

    const grossIndependent = built.reduce((s, r) => s + r.span + r.exposure, 0);

    // NSE ELM on futures calendar spreads: the matched (spread) quantity is
    // charged only 1/3rd of the far-month leg's ELM; the near-month leg of the
    // spread carries no ELM. Unmatched quantity keeps full ELM.
    {
      const futBySym = {};
      built.forEach((r, i) => {
        if ((r.market === "NFO" || r.market === "BFO") && r.instrument === "FUT" && r.qty > 0) {
          (futBySym[`${r.market}:${r.symbol}`] ||= []).push(i);
        }
      });
      Object.values(futBySym).forEach((idxs) => {
        const rem = {};
        idxs.forEach((i) => { rem[i] = built[i].qty; });
        const order = [...idxs].sort((a, b) => parseExpiryDate(built[a].expiry) - parseExpiryDate(built[b].expiry));
        const matchedQty = {};
        for (let x = 0; x < order.length; x++) {
          for (let y = x + 1; y < order.length; y++) {
            const a = order[x], b = order[y]; // a = near, b = far
            if (built[a].side === built[b].side) continue;
            const m = Math.min(rem[a], rem[b]);
            if (m <= 0) continue;
            rem[a] -= m; rem[b] -= m;
            matchedQty[a] = (matchedQty[a] || 0) + m;
            matchedQty[b] = (matchedQty[b] || 0) + m;
            matchedQty[`far${b}`] = (matchedQty[`far${b}`] || 0) + m;
          }
        }
        idxs.forEach((i) => {
          const r = built[i];
          if (!r.exposure || !matchedQty[i]) return;
          const perUnit = r.exposure / r.qty;
          const farMatched = matchedQty[`far${i}`] || 0;
          const newExposure = perUnit * (r.qty - matchedQty[i]) + perUnit * farMatched / 3;
          built[i] = { ...r, exposure: newExposure, total: r.span + newExposure + r.premium };
        });
      });
    }

    // Portfolio-level SPAN for NFO. The 16 risk arrays are combined across
    // every expiry of the same underlying. Calendar-spread charge is then added
    // from the portfolio's composite delta by expiry. Net option value is
    // applied once at the portfolio level, so it is never double-counted in the
    // per-leg rows.
    const comboGroups = {};
    built.forEach((r, idx) => {
      if (r.market !== "NFO" && r.market !== "BFO") return;
      if (r.instrument !== "FUT" && r.instrument !== "OPT") return;
      const key = `${r.market}:${r.symbol}`;
      (comboGroups[key] ||= []).push(idx);
    });

    const comboGroupSpan = {};
    const legComboKey = {};
    Object.entries(comboGroups).forEach(([key, idxs]) => {
      const legsInGroup = idxs.map((idx) => built[idx]);
      const hasMarginNeed = legsInGroup.some((r) => r.instrument === "FUT" || r.side === "Sell");
      if (!hasMarginNeed) return;

      const combined = new Array(16).fill(0);
      let allFound = true;
      idxs.forEach((idx) => {
        const r = built[idx];
        const arr = getArray(spanData, r);
        if (!arr) { allFound = false; return; }
        const signedQty = r.side === "Buy" ? r.qty : -r.qty;
        for (let i = 0; i < 16; i++) combined[i] += signedQty * arr[i];
      });
      if (!allFound) return;

      const netScanRisk = Math.max(0, Math.max(...combined));
      const calendarCharge = calculateCalendarSpreadCharge(legsInGroup, spanData);
      const netOptionValue = calculateNetOptionValue(legsInGroup);
      const somRate = spanData.somRates?.[legsInGroup[0].symbol] || 0;
      const shortOptionLots = legsInGroup.reduce((s, r) => (r.instrument === "OPT" && r.side === "Sell" && r.lotSize ? s + r.qty / r.lotSize : s), 0);

      // SPAN risk requirement = scanning risk + calendar/intracommodity
      // spread charge. Net option value is then deducted per NSE's formula.
      const spanRiskBeforeNOV = netScanRisk + calendarCharge;
      const spanAfterNOV = spanRiskBeforeNOV - netOptionValue;
      comboGroupSpan[key] = Math.max(0, spanAfterNOV, somRate * shortOptionLots);

      idxs.forEach((idx) => {
        legComboKey[idx] = key;
        built[idx] = {
          ...built[idx],
          comboGroup: true,
          calendarSpread: calendarCharge > 0,
          netOptionValue,
          portfolioScanRisk: netScanRisk,
          calendarCharge,
        };
      });
    });

    // MCX same-expiry option combo netting (straddles/strangles/etc.) —
    // same combined-array idea as NFO/BFO above, but scoped to one expiry
    // only (no cross-expiry delta-matching validated for MCX), no calendar
    // charge or Net Option Value component (unconfirmed for MCX options —
    // that's only built for MCX futures spreads, above), and applies the
    // same gold pricing-unit correction used elsewhere. Checked against a
    // real GOLDM options combo from a live broker: combined span landed
    // within ~16% of the real figure — same ballpark as ordinary day-to-
    // day data differences seen elsewhere in this build.
    const mcxComboGroups = {};
    built.forEach((r, idx) => {
      if (r.market !== "MCX" || r.instrument !== "OPT") return;
      const key = `MCX:${r.symbol}:${r.expiry}`;
      (mcxComboGroups[key] ||= []).push(idx);
    });
    Object.entries(mcxComboGroups).forEach(([key, idxs]) => {
      if (idxs.length < 2) return;
      const legsInGroup = idxs.map((idx) => built[idx]);
      const hasMarginNeed = legsInGroup.some((r) => r.side === "Sell");
      if (!hasMarginNeed) return;

      const units = mcxPricingUnits(legsInGroup[0].symbol);
      const combined = new Array(16).fill(0);
      let allFound = true;
      idxs.forEach((idx) => {
        const r = built[idx];
        const arr = getArray(mcxSpanData, r);
        if (!arr) { allFound = false; return; }
        const signedQty = (r.side === "Buy" ? r.qty : -r.qty) / units;
        for (let i = 0; i < 16; i++) combined[i] += signedQty * arr[i];
      });
      if (!allFound) return;

      // Short Option Minimum floor — verified non-zero for MCX gold family
      // (unlike NIFTY/BANKNIFTY/RELIANCE, which all showed 0). Doesn't move
      // this particular example since the netted scan risk is already well
      // above the floor, but matters when netting brings scan risk very low.
      const somRate = mcxSpanData.somRates?.[legsInGroup[0].symbol] || 0;
      const shortOptionLots = legsInGroup.reduce((s, r) => (r.side === "Sell" && r.lotSize ? s + r.qty / r.lotSize : s), 0);
      comboGroupSpan[key] = Math.max(0, Math.max(...combined), somRate * shortOptionLots);
      idxs.forEach((idx) => {
        legComboKey[idx] = key;
        built[idx] = { ...built[idx], comboGroup: true };
      });
    });

    // Final span: each same-symbol portfolio group is counted once.
    const finalSpanForLegs = (idxs) => {
      let total = 0;
      const counted = new Set();
      idxs.forEach((idx) => {
        const gKey = legComboKey[idx];
        if (gKey) {
          if (!counted.has(gKey)) { total += comboGroupSpan[gKey]; counted.add(gKey); }
        } else {
          total += built[idx].span;
        }
      });
      return total;
    };

    const bySymbol = {};
    built.forEach((r, idx) => {
      const key = `${r.market}:${r.symbol}`;
      bySymbol[key] = bySymbol[key] || { legIdx: [], exposure: 0, premium: 0, premiumReceivable: 0, hasSpread: false, market: r.market, symbol: r.symbol };
      const g = bySymbol[key];
      g.legIdx.push(idx);
      g.exposure += r.exposure; g.premium += r.premium; g.premiumReceivable += r.premiumReceivable;
      if (r.calendarSpread) g.hasSpread = true;
    });
    Object.values(bySymbol).forEach((g) => {
      g.span = finalSpanForLegs(g.legIdx);
      g.total = g.span + g.exposure + g.premium;
    });

    const spanTotal = finalSpanForLegs(built.map((_, idx) => idx));
    const exposureTotal = built.reduce((s, r) => s + r.exposure, 0);
    const premiumTotal = built.reduce((s, r) => s + r.premium, 0);
    const premiumReceivableTotal = built.reduce((s, r) => s + r.premiumReceivable, 0);
    const marginBenefit = Math.max(0, grossIndependent - (spanTotal + exposureTotal));
    // Total margin required = Span + Exposure only. Premium payable/
    // receivable are cash-flow items (you pay/receive the actual premium),
    // not part of the blocked margin — matches how Zerodha's own "Total
    // margin" figure excludes premium entirely, confirmed against a
    // butterfly spread where the premium legs were too large to ignore.
    const net = spanTotal + exposureTotal;

    const order = [];
    built.forEach((r) => { const key = `${r.market}:${r.symbol}`; if (!order.includes(key)) order.push(key); });
    const grouped = order.map((key) => ({ key, legs: built.filter((r) => `${r.market}:${r.symbol}` === key), summary: bySymbol[key] }));

    // One row per real underlying (combining across exchange labels, e.g. a
    // symbol appearing under both NFO and BFO), using the same post-benefit
    // span/exposure already computed above — so this table's totals sum to
    // exactly the same "Total margin required" figure shown in the panel.
    const byUnderlying = {};
    const underlyingOrder = [];
    Object.values(bySymbol).forEach((g) => {
      if (!byUnderlying[g.symbol]) { byUnderlying[g.symbol] = { underlying: g.symbol, span: 0, exposure: 0 }; underlyingOrder.push(g.symbol); }
      byUnderlying[g.symbol].span += g.span;
      byUnderlying[g.symbol].exposure += g.exposure;
    });
    const underlyingSummary = underlyingOrder.map((sym) => ({ ...byUnderlying[sym], total: byUnderlying[sym].span + byUnderlying[sym].exposure }));

    return { grouped, spanTotal, exposureTotal, marginBenefit, premiumTotal, premiumReceivableTotal, net, underlyingSummary };
  }, [legs, contracts, bseContracts, spanData, elmMap, elmContractMap, mcxContracts, mcxSpanData, mcxMarginMap]);

  const fmt = (n) => "₹" + Math.round(n || 0).toLocaleString("en-IN");
  const ready = draft.market === "MCX" ? mcxContracts.length > 0 : nfoContracts.length > 0;
  const anyReady = nfoContracts.length > 0 || mcxContracts.length > 0;

  // ---------------- Uploader page ----------------
  if (view === "uploader") {
    return (
      <div data-theme={theme} style={{ background: "var(--bg)", color: "var(--text)", fontFamily: "'Inter', sans-serif", minHeight: "100vh", padding: "28px 20px" }}>
        <style>{FONT_IMPORT}</style>
        <div style={{ width: "100%", margin: "0 0 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 26, margin: 0, color: "var(--text-heading)" }}>Data files</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>NSE F&O and MCX commodity data — refresh these daily</p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={toggleTheme} style={topBtnStyle}>{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}</button>
            <button onClick={clearSavedData} style={{ ...topBtnStyle, color: "var(--red)", borderColor: "var(--red-border)" }}><Trash2 size={14} /> Clear saved data</button>
            <button onClick={() => setView("calculator")} style={topBtnStyle}><ArrowLeft size={14} /> Calculator</button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11.5, color: "var(--muted2)", margin: "0 0 18px" }}>
          <CheckCircle2 size={13} color="var(--green)" />
          Files are saved in this browser (IndexedDB) and reload automatically — no need to re-upload after a refresh, until you replace or clear them.
        </div>

        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "var(--text-heading)", marginBottom: 4 }}>NSE F&O</div>
        <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 12px" }}>This data also covers BFO (Sensex, Bankex) — the same symbol list shows under either NFO or BFO, so pick whichever label you want the position tagged with.</p>
        <div style={{ width: "100%", margin: "0 0 26px", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14 }} className="vc-grid4">
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>Bhavcopy (contract master)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>NSE F&O Bhavcopy CSV — symbol, expiry, strike, lot size, settlement price.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{fileStatus.contracts ? "Replace file" : "Upload Bhavcopy CSV"}</span>
              <input ref={inputs.contracts} type="file" accept=".csv" onChange={handleCsvUpload("contracts")} style={{ display: "none" }} />
            </label>
            {fileStatus.contracts && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {fileStatus.contracts} loaded</div>}
            {sharedSyncStatus.contracts === "syncing" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Syncing to shared storage…</div>}
            {sharedSyncStatus.contracts === "synced" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>✓ Visible to all visitors</div>}
            {sharedSyncStatus.contracts === "error" && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>Shared sync failed — only saved locally</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>SPAN file (.spn)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>NSCCL SPAN risk file — 16-scenario scan risk, plus calendar spread charge tables.</p>
            <label style={fileBtnStyle}>
              {spanLoading ? <Loader2 size={15} className="vc-spin" /> : <UploadCloud size={15} />}
              <span>{spanLoading ? "Parsing…" : fileStatus.span ? "Replace file" : "Upload .spn file"}</span>
              <input ref={inputs.span} type="file" accept=".spn,.xml,.txt" onChange={handleSpanUpload} style={{ display: "none" }} disabled={spanLoading} />
            </label>
            {fileStatus.span && !spanLoading && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {fileStatus.span} loaded</div>}
            {sharedSyncStatus.span === "syncing" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Syncing to shared storage…</div>}
            {sharedSyncStatus.span === "synced" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>✓ Visible to all visitors</div>}
            {sharedSyncStatus.span === "error" && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>Shared sync failed — only saved locally</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>ELM file (aggregate)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Extreme loss margin % by symbol only — used as a fallback when no contract-level rate is loaded.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{fileStatus.elm ? "Replace file" : "Upload ELM CSV"}</span>
              <input ref={inputs.elm} type="file" accept=".csv" onChange={handleCsvUpload("elm")} style={{ display: "none" }} />
            </label>
            {fileStatus.elm && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {fileStatus.elm} loaded</div>}
            {sharedSyncStatus.elm === "syncing" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Syncing to shared storage…</div>}
            {sharedSyncStatus.elm === "synced" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>✓ Visible to all visitors</div>}
            {sharedSyncStatus.elm === "error" && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>Shared sync failed — only saved locally</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>ELM by contract</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Per symbol+expiry+strike ELM% — more precise than the aggregate file, used first whenever a matching row exists. No header row expected.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{fileStatus.elmContracts ? "Replace file" : "Upload contract-level CSV"}</span>
              <input ref={inputs.elmContracts} type="file" accept=".csv" onChange={handleElmContractsUpload} style={{ display: "none" }} />
            </label>
            {fileStatus.elmContracts && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {fileStatus.elmContracts} loaded</div>}
            {sharedSyncStatus.elmContracts === "syncing" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Syncing to shared storage…</div>}
            {sharedSyncStatus.elmContracts === "synced" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>✓ Visible to all visitors</div>}
            {sharedSyncStatus.elmContracts === "error" && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>Shared sync failed — only saved locally</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>BSE contract specs (BFO)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Sensex/Bankex — NSE's Bhavcopy doesn't include these since they trade on BSE. Accepts either a real BSE Bhavcopy (same column layout as NSE's — best, has real prices) or the positional contract-specs file (lot sizes only, underlying price filled in from the SPAN file above). Auto-detected.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{bseFileStatus ? "Replace file" : "Upload BSE contract CSV"}</span>
              <input ref={inputs.bseContracts} type="file" accept=".csv" onChange={handleBseContractsUpload} style={{ display: "none" }} />
            </label>
            {bseFileStatus && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {bseFileStatus} loaded</div>}
            {sharedSyncStatus.bseContracts === "syncing" && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Syncing to shared storage…</div>}
            {sharedSyncStatus.bseContracts === "synced" && <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>✓ Visible to all visitors</div>}
            {sharedSyncStatus.bseContracts === "error" && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>Shared sync failed — only saved locally</div>}
          </div>
        </div>

        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 18, fontWeight: 600, color: "var(--text-heading)", marginBottom: 4 }}>Commodities (MCX)</div>
        <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 12px" }}>
          Futures margin uses MCX's Margin Detail Report percentages directly (Initial + Tender as span, Additional/Special/ELM/Delivery as exposure). Options margin falls back to the .spn scan-risk array, since the margin report doesn't cover options. Calendar spread charges aren't applied for MCX yet — MCX's dSpread tables reference tier numbers rather than exact expiries, and that mapping isn't confirmed.
        </p>
        <div style={{ width: "100%", margin: "0", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }} className="vc-grid3">
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>MCX Bhavcopy (contract master)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Lot size is derived from the day's traded volume, so illiquid contracts may show no lot size.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{mcxFileStatus.contracts ? "Replace file" : "Upload Bhavcopy CSV"}</span>
              <input ref={inputs.mcxContracts} type="file" accept=".csv" onChange={handleMcxCsvUpload("contracts")} style={{ display: "none" }} />
            </label>
            {mcxFileStatus.contracts && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {mcxFileStatus.contracts} loaded</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>MCX SPAN file (.spn)</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Used for options scan risk (margin report doesn't cover options).</p>
            <label style={fileBtnStyle}>
              {mcxSpanLoading ? <Loader2 size={15} className="vc-spin" /> : <UploadCloud size={15} />}
              <span>{mcxSpanLoading ? "Parsing…" : mcxFileStatus.span ? "Replace file" : "Upload .spn file"}</span>
              <input ref={inputs.mcxSpan} type="file" accept=".spn,.xml,.txt" onChange={handleMcxSpanUpload} style={{ display: "none" }} disabled={mcxSpanLoading} />
            </label>
            {mcxFileStatus.span && !mcxSpanLoading && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {mcxFileStatus.span} loaded</div>}
          </div>

          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-heading)", marginBottom: 8 }}>Margin detail report</div>
            <p style={{ fontSize: 12, color: "var(--muted2)", margin: "0 0 10px" }}>Initial/Tender/Additional/Special/ELM/Delivery % by symbol and expiry — futures only.</p>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>{mcxFileStatus.margin ? "Replace file" : "Upload margin CSV"}</span>
              <input ref={inputs.mcxMargin} type="file" accept=".csv" onChange={handleMcxCsvUpload("margin")} style={{ display: "none" }} />
            </label>
            {mcxFileStatus.margin && <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--green)", marginTop: 8 }}><CheckCircle2 size={12} /> {mcxFileStatus.margin} loaded</div>}
          </div>
        </div>

        <style>{`.vc-spin { animation: vc-spin 1s linear infinite; } @keyframes vc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } } @media (max-width: 900px) { .vc-grid4 { grid-template-columns: 1fr 1fr !important; } } @media (max-width: 560px) { .vc-grid4 { grid-template-columns: 1fr !important; } }`}</style>
      </div>
    );
  }

  // ---------------- Calculator page ----------------
  return (
    <div data-theme={theme} style={{ background: "var(--bg)", color: "var(--text)", fontFamily: "'Inter', sans-serif", minHeight: "100vh", padding: "28px 20px" }}>
      <style>{FONT_IMPORT}</style>

      <div style={{ width: "100%", margin: "0 0 20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <svg width="40" height="40" viewBox="0 0 40 40" style={{ flexShrink: 0 }}>
            <rect x="0" y="0" width="40" height="40" rx="10" fill="var(--accent)" />
            <path d="M12 10 H28 V16 H18 V18 H26 V24 H18 V30 H12 Z" fill="var(--accent-text)" />
          </svg>
          <div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontWeight: 600, fontSize: 30, margin: 0, color: "var(--text-heading)" }}>Findoc</h1>
            <p style={{ margin: "4px 0 0", fontSize: 13.5, color: "var(--muted)" }}>Margin Calculator</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={toggleTheme} style={topBtnStyle}>{theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}</button>
          <button onClick={() => setView("uploader")} style={topBtnStyle}><Settings size={14} /> Uploader</button>
        </div>
      </div>

      {sharedLoading && (
        <div style={{ width: "100%", margin: "0 0 18px", display: "flex", gap: 8, alignItems: "center", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: "var(--muted)" }}>
          <Loader2 size={14} className="vc-spin" /> Checking for shared data uploaded by others…
        </div>
      )}

      {!anyReady && !sharedLoading && (
        <div style={{ width: "100%", margin: "0 0 18px", display: "flex", gap: 8, alignItems: "center", background: "var(--warning-bg)", border: "1px solid var(--accent-border)", borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: "var(--accent)" }}>
          <AlertCircle size={14} /> No data loaded yet — open <b style={{ margin: "0 4px" }}>Uploader</b> to add Bhavcopy, SPAN and margin files first.
        </div>
      )}

      <div style={{ width: "100%", margin: "0", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 20 }} className="vc-grid">
        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, marginBottom: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-heading)" }}>Upload positions CSV</span>
              <button
                onClick={() =>
                  downloadCsv(
                    "positions_template.csv",
                    ["Market", "Instrument Type", "Symbol", "Expiry", "Strike", "Option Type", "Qty"],
                    [["NFO", "FUTSTK", "RELIANCE", "29-SEP-2026", "", "FF", "500"], ["NFO", "FUTIDX", "SENSEX", "29-SEP-2026", "", "FF", "10"], ["MCX", "FUTCOM", "COPPER", "23-SEP-2026", "", "FF", "-1"]]
                  )
                }
                style={{ background: "none", border: "none", color: "var(--muted2)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}
              >
                <Download size={12} /> template
              </button>
            </div>
            <label style={fileBtnStyle}>
              <UploadCloud size={15} /><span>Upload positions CSV</span>
              <input ref={inputs.positions} type="file" accept=".csv" onChange={handlePositionsUpload} style={{ display: "none" }} />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11, color: "var(--muted2)", marginTop: 8 }}>
              <Info size={12} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>Columns: Market (NFO/BFO/MCX, defaults to NFO), Instrument Type (FUTSTK/OPTSTK/FUTIDX/OPTIDX for NFO/BFO, FUTCOM/OPTFUT/FUTIDX/OPTIDX for MCX), Symbol, Expiry, Strike (blank for futures), Option Type (FF/CE/PE), Qty. Qty sign sets side: positive = Buy, negative = Sell.</span>
            </div>
            {csvError && <div style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "var(--red)", marginTop: 8 }}><AlertCircle size={12} /> {csvError}</div>}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-heading)" }}>Add position manually</h2>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Exchange</div>
            <select value={draft.market} onChange={(e) => setDraft((d) => ({ ...emptyDraft(), market: e.target.value }))} style={selStyle}>
              <option value="NFO">NFO — NSE F&O</option>
              <option value="BFO">BFO — BSE F&O</option>
              <option value="MCX">MCX — commodities</option>
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Symbol</div>
              <select disabled={!ready} value={draft.symbol} onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value, expiry: "", strike: "" }))} style={selStyle}>
                <option value="">Select</option>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Expiry</div>
              <select disabled={!draft.symbol} value={draft.expiry} onChange={(e) => setDraft((d) => ({ ...d, expiry: e.target.value }))} style={selStyle}>
                <option value="">Select</option>
                {expiries.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Instrument</div>
              <select value={draft.instrument} onChange={(e) => setDraft((d) => ({ ...d, instrument: e.target.value, strike: "" }))} style={selStyle}>
                <option value="FUT">Futures</option>
                <option value="OPT">Options</option>
              </select>
            </div>
            {draft.instrument === "OPT" && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Type</div>
                  <select value={draft.optionType} onChange={(e) => setDraft((d) => ({ ...d, optionType: e.target.value, strike: "" }))} style={selStyle}>
                    <option value="CE">Call</option>
                    <option value="PE">Put</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Strike</div>
                  <select value={draft.strike} onChange={(e) => setDraft((d) => ({ ...d, strike: e.target.value }))} style={selStyle}>
                    <option value="">Select</option>
                    {strikes.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>Side</div>
              <select value={draft.side} onChange={(e) => setDraft((d) => ({ ...d, side: e.target.value }))} style={{ ...selStyle, color: draft.side === "Buy" ? "var(--green)" : "var(--red)", fontWeight: 600 }}>
                <option value="Buy">Buy</option>
                <option value="Sell">Sell</option>
              </select>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 4 }}>
                Net Quantity{draftLotSize ? <span style={{ color: "var(--muted2)", fontWeight: 400 }}> (Lot size: {draftLotSize})</span> : null}
              </div>
              <input
                type="number"
                step={draftLotSize || 1}
                min={0}
                value={draft.qty}
                onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))}
                onBlur={() => {
                  if (!draftLotSize) return;
                  setDraft((d) => {
                    const raw = Number(d.qty || 0);
                    const snapped = Math.round(raw / draftLotSize) * draftLotSize;
                    return { ...d, qty: snapped };
                  });
                }}
                style={{ ...selStyle, fontFamily: "'IBM Plex Mono', monospace" }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <button onClick={addLeg} disabled={!draft.symbol || !draft.expiry} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, background: "var(--accent)", color: "var(--accent-text)", border: "none", borderRadius: 7, padding: "8px 12px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                <Plus size={14} /> Add
              </button>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-heading)" }}>Positions — margin by symbol</h2>
            {legs.length > 0 && (
              <button onClick={clearLegs} style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--surface)", border: "1px solid var(--red-border)", borderRadius: 7, padding: "6px 12px", fontSize: 12, color: "var(--red)", cursor: "pointer" }}>
                <Trash2 size={13} /> Reset positions
              </button>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5, minWidth: 720 }}>
              <thead>
                <tr style={{ color: "var(--muted2)", textAlign: "left" }}>
                  {["Market", "Contract", "Expiry", "Side", "Qty", "Span", "Exposure", "Premium", "Total (incl. premium)", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 8px", fontWeight: 500, borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
                {rows.grouped.map((g) => (
                  <>
                    {g.legs.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid var(--row-border)" }}>
                        <td style={{ padding: "12px 8px", color: "var(--muted)" }}>{r.market}</td>
                        <td style={{ padding: "12px 8px" }}>
                          {r.symbol}{r.instrument === "OPT" ? ` ${r.strike}${r.optionType}` : " FUT"}
                          {!r.found && <span style={{ color: "var(--red)", marginLeft: 6, fontFamily: "'Inter', sans-serif" }}>no contract match</span>}
                          {r.found && !r.spanFound && <span style={{ color: "var(--accent)", marginLeft: 6, fontFamily: "'Inter', sans-serif" }}>no margin data</span>}
                          {r.calendarSpread && <span style={{ color: "var(--accent)", marginLeft: 6, fontFamily: "'Inter', sans-serif" }}>calendar</span>}
                          {r.comboGroup && <span style={{ color: "var(--accent)", marginLeft: 6, fontFamily: "'Inter', sans-serif" }}>combo</span>}
                        </td>
                        <td style={{ padding: "12px 8px", color: "var(--muted)" }}>{r.expiry}</td>
                        <td style={{ padding: "12px 8px", color: r.side === "Buy" ? "var(--green)" : "var(--red)" }}>{r.side}</td>
                        <td style={{ padding: "12px 8px" }}>{r.qty}</td>
                        <td style={{ padding: "12px 8px" }}>{fmt(r.span)}</td>
                        <td style={{ padding: "12px 8px" }}>{fmt(r.exposure)}</td>
                        <td style={{ padding: "12px 8px", color: "var(--muted)" }}>{r.premium ? fmt(r.premium) : "—"}</td>
                        <td style={{ padding: "12px 8px" }}>{fmt(r.total)}</td>
                        <td style={{ padding: "12px 8px" }}>
                          <button onClick={() => removeLeg(r.id)} style={{ background: "none", border: "none", color: "var(--muted2)", cursor: "pointer" }}><Trash2 size={13} /></button>
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)" }}>
                      <td colSpan={5} style={{ padding: "12px 8px", fontFamily: "'Inter', sans-serif", fontWeight: 600, color: "var(--text-heading)" }}>
                        {g.summary.symbol} subtotal {g.summary.hasSpread && <span style={{ color: "var(--accent)", fontWeight: 400 }}>(calendar spread applied)</span>}
                      </td>
                      <td style={{ padding: "12px 8px", color: "var(--text)" }}>{fmt(g.summary.span)}</td>
                      <td style={{ padding: "12px 8px", color: "var(--text)" }}>{fmt(g.summary.exposure)}</td>
                      <td style={{ padding: "12px 8px", color: "var(--muted)" }}>{g.summary.premium ? fmt(g.summary.premium) : "—"}</td>
                      <td style={{ padding: "12px 8px", color: "var(--accent)", fontWeight: 600 }}>{fmt(g.summary.total)}</td>
                      <td></td>
                    </tr>
                    <tr aria-hidden="true"><td colSpan={10} style={{ height: 14, padding: 0, border: "none" }}></td></tr>
                  </>
                ))}
                {rows.grouped.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: "14px 8px", color: "var(--muted2)", fontFamily: "'Inter', sans-serif" }}>No positions added yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, height: "fit-content" }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 14px", color: "var(--text-heading)" }}>Margin required</h2>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text)", marginBottom: 6 }}><span>Span margin</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(rows.spanTotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text)", marginBottom: 6 }}><span>Exposure margin</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(rows.exposureTotal)}</span></div>
          {rows.marginBenefit > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--green)", marginBottom: 6, background: "var(--benefit-bg)", borderRadius: 6, padding: "4px 8px", margin: "0 -8px 6px" }}>
              <span>Margin benefit</span><span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 }}>{fmt(rows.marginBenefit)}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--muted)", marginBottom: 12 }}><span>Option premium payable</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(rows.premiumTotal)}</span></div>
          {rows.premiumReceivableTotal > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--muted)", marginBottom: 12 }}><span>Premium receivable</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(rows.premiumReceivableTotal)}</span></div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--text-heading)", fontWeight: 600, marginBottom: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}><span>Total margin</span><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{fmt(rows.net)}</span></div>

          <div style={{ background: "var(--bg)", border: "1px solid var(--accent-border)", borderRadius: 10, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><TrendingUp size={16} color="var(--accent)" /><span style={{ fontSize: 13, color: "var(--text-heading)" }}>Net required</span></div>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 18, fontWeight: 600, color: "var(--accent)" }}>{fmt(rows.net)}</span>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, color: "var(--muted2)", marginTop: 14 }}>
            <ShieldCheck size={13} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>Span combines the real 16-scenario risk arrays for all legs of the same underlying, then applies the uploaded SPAN calendar-spread charge to matched composite delta by expiry and deducts net option value. No broker-specific constants are used. Exposure remains separate.</span>
          </div>
        </div>
      </div>

      {rows.underlyingSummary.length > 0 && (
        <div style={{ width: "100%", margin: "20px 0 0", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-heading)" }}>Margin by underlying</h2>
            <button
              onClick={() =>
                downloadCsv(
                  "margin_by_underlying.csv",
                  ["Underlying", "Span", "ELM", "Total Margin"],
                  rows.underlyingSummary.map((u) => [u.underlying, Math.round(u.span), Math.round(u.exposure), Math.round(u.total)])
                )
              }
              style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, padding: "6px 12px", fontSize: 12, color: "var(--muted)", cursor: "pointer" }}
            >
              <Download size={13} /> Export CSV
            </button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: "var(--muted)", textAlign: "left" }}>
                  {["Underlying", "Span", "ELM", "Total Margin"].map((h) => (
                    <th key={h} style={{ padding: "8px 10px", fontWeight: 500, borderBottom: "1px solid var(--border)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody style={{ fontFamily: "'IBM Plex Mono', monospace" }}>
                {rows.underlyingSummary.map((u) => (
                  <tr key={u.underlying} style={{ borderBottom: "1px solid var(--row-border)" }}>
                    <td style={{ padding: "10px", fontFamily: "'Inter', sans-serif", color: "var(--text-heading)" }}>{u.underlying}</td>
                    <td style={{ padding: "10px" }}>{fmt(u.span)}</td>
                    <td style={{ padding: "10px" }}>{fmt(u.exposure)}</td>
                    <td style={{ padding: "10px", color: "var(--accent)", fontWeight: 600 }}>{fmt(u.total)}</td>
                  </tr>
                ))}
                <tr style={{ background: "var(--bg)" }}>
                  <td style={{ padding: "10px", fontFamily: "'Inter', sans-serif", fontWeight: 600, color: "var(--text-heading)" }}>Total</td>
                  <td style={{ padding: "10px", fontWeight: 600 }}>{fmt(rows.spanTotal)}</td>
                  <td style={{ padding: "10px", fontWeight: 600 }}>{fmt(rows.exposureTotal)}</td>
                  <td style={{ padding: "10px", color: "var(--accent)", fontWeight: 600 }}>{fmt(rows.net)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 10 }}>The Total row above matches "Total margin required" exactly — these are the same post-benefit figures, just grouped by underlying instead of by position.</div>
        </div>
      )}

      <style>{`
        @media (max-width: 760px) { .vc-grid { grid-template-columns: 1fr !important; } }
        .vc-spin { animation: vc-spin 1s linear infinite; }
        @keyframes vc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
