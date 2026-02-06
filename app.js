// Schedule Parser (multi-page PDF) using PDF.js
// Reads all pages, extracts employee rows and day codes, groups by shift,
// and provides copy buttons + employee off-day calendar.

const OFF_CODES = new Set(["FG","FA","FC","FE","FF","FAN","COVE"]);
const ABSENT_CODES = new Set(["DM","EMT","AJ","X"]);

let parsed = null; // {month, year, daysInMonth, employees:[{name,shift,codes:{day:code}}], shifts:Set}

const $ = (id) => document.getElementById(id);

function setStatus(msg){ $("status").textContent = msg || ""; }
function pad2(n){ return String(n).padStart(2,"0"); }
function classify(code){
  const c = (code || "").trim().toUpperCase();
  if (!c) return "working";               // blank cell -> working
  if (OFF_CODES.has(c)) return "off";
  if (ABSENT_CODES.has(c)) return "absent";
  return "working";                       // any other code -> working
}

async function copyText(text){
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function monthNameToNumber(name){
  const map = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  return map[String(name||"").toLowerCase()] || null;
}

function groupByLine(items){
  const m = new Map();
  for (const it of items){
    const yKey = Math.round(it.y / 2) * 2; // 2pt bins
    if (!m.has(yKey)) m.set(yKey, []);
    m.get(yKey).push(it);
  }
  return m;
}

function pickBestDayHeaderLine(lines){
  let best=null, bestCount=0;
  for (const line of lines.values()){
    const count = line.filter(t => /^\d{1,2}$/.test(t.str)).length;
    if (count > bestCount){ bestCount=count; best=line; }
  }
  return bestCount >= 20 ? best : null;
}

function nearestDay(x, anchors){
  let best=null, bestDist=Infinity;
  for (const a of anchors){
    const d = Math.abs(x - a.x);
    if (d < bestDist){ bestDist=d; best=a.day; }
  }
  return bestDist < 12 ? best : null; // tolerance
}

function detectShiftLabel(text){
  const t = text.replace(/\s+/g," ").trim();
  const m = t.match(/^SHIFT\s+(.+)$/i);
  if (m) return m[1].trim().replace(/\s+/g," ");
  // Some sections can appear without "SHIFT" word
  const direct = ["GSE","TOOLING","ADMINIST.","ADMINIST","SUPERVISORS","SHIFT B2","SHIFT C","SHIFT B"];
  for (const k of direct){
    if (t.toUpperCase() === k.toUpperCase()) return k;
  }
  return null;
}

function isNonEmployeeLine(text){
  const t = text.toUpperCase().trim();
  if (!t) return true;
  return (
    t.includes("MONTHLY SCHEDULE") ||
    t.startsWith("TOTAL") ||
    t.includes("HEAD COUNT") ||
    t.includes("FERIADO") ||
    t.includes("LAST REV") ||
    t.startsWith("SUN ") ||
    /^\d(\s+\d){5,}/.test(t)
  );
}

function looksLikeEmployeeName(leftText){
  const t = leftText.trim();
  if (!t || t.length < 3) return false;
  if (/^TOTAL\b/i.test(t)) return false;
  if (/^HEAD\b/i.test(t)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t);
}

function cleanEmployeeName(leftText){
  let t = leftText.replace(/\s+/g," ").trim();
  t = t.replace(/\s+(\d{1,2}|fe)\s*$/i, "").trim(); // remove trailing "2" or "fe"
  return t;
}

function normalizeCode(s){
  const t = String(s||"").trim();
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) return null;
  if (/^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)$/i.test(t)) return null;
  if (/^[A-Za-z]{1,6}\d{0,3}$/.test(t) || /^[A-Za-z]{2,6}$/.test(t)) return t.toUpperCase();
  return null;
}

async function parseSchedulePDF(file){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data: buf}).promise;

  const employees = [];
  const shifts = new Set();
  let detectedMonth=null, detectedYear=null;

  for (let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent({includeMarkedContent:false});

    const items = tc.items.map(it => {
      const [a,b,c,d,e,f] = it.transform;
      return { str:(it.str||"").trim(), x:e, y:f, w:it.width||0, h:it.height||0 };
    }).filter(o => o.str.length);

    const fullText = items.map(i=>i.str).join(" ");
    const m = fullText.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
    if (m && !detectedYear){
      detectedYear = Number(m[2]);
      detectedMonth = monthNameToNumber(m[1]);
    }

    const lines = groupByLine(items);
    const headerLine = pickBestDayHeaderLine(lines);
    if (!headerLine) continue;

    const dayCols = headerLine
      .filter(t => /^\d{1,2}$/.test(t.str))
      .sort((a,b)=>a.x-b.x);

    const dayAnchors = dayCols.map(t => ({day:Number(t.str), x:t.x}));
    const minDayX = Math.min(...dayAnchors.map(d=>d.x));

    const yKeys = Array.from(lines.keys()).sort((a,b)=>Number(b)-Number(a));
    let currentShift = "Unknown";

    for (const yKey of yKeys){
      const line = lines.get(yKey).sort((a,b)=>a.x-b.x);
      const text = line.map(t=>t.str).join(" ").trim();

      const sLabel = detectShiftLabel(text);
      if (sLabel){
        currentShift = sLabel;
        shifts.add(currentShift);
        continue;
      }

      if (isNonEmployeeLine(text)) continue;

      const left = line.filter(t => t.x < (minDayX - 12));
      const right = line.filter(t => t.x >= (minDayX - 12));

      const leftText = left.map(t=>t.str).join(" ").trim();
      if (!looksLikeEmployeeName(leftText)) continue;

      const name = cleanEmployeeName(leftText);
      const codes = {};

      for (const t of right){
        const code = normalizeCode(t.str);
        if (!code) continue;
        const day = nearestDay(t.x, dayAnchors);
        if (!day) continue;
        if (day >= 1 && day <= 31) codes[String(day)] = code;
      }

      employees.push({name, shift: currentShift, codes});
      shifts.add(currentShift);
    }
  }

  const year = detectedYear || new Date().getFullYear();
  const month = detectedMonth || (new Date().getMonth()+1);
  const daysInMonth = new Date(year, month, 0).getDate();

  return {month, year, daysInMonth, employees, shifts};
}

function renderResults(day, month, year){
  const byShift = new Map(); // shift -> {working:[], off:[], absent:[]}
  let workingNames = [];
  let offCount = 0, absentCount = 0;

  for (const emp of parsed.employees){
    const shift = emp.shift || "Unknown";
    if (!byShift.has(shift)) byShift.set(shift, {working:[], off:[], absent:[]});
    const code = emp.codes[String(day)] || "";
    const cat = classify(code);
    byShift.get(shift)[cat].push({emp, code});
    if (cat==="working") workingNames.push(emp.name);
    if (cat==="off") offCount++;
    if (cat==="absent") absentCount++;
  }

  $("countWorking").textContent = String(workingNames.length);
  $("countOff").textContent = String(offCount);
  $("countAbsent").textContent = String(absentCount);
  window.__workingNames = workingNames;

  const root = $("byShift");
  root.innerHTML = "";

  const shifts = Array.from(byShift.keys()).sort((a,b)=>a.localeCompare(b));
  for (const s of shifts){
    const grp = byShift.get(s);
    const card = document.createElement("div");
    card.className = "shiftCard";
    card.innerHTML = `
      <div class="shiftTitle">
        <div>Shift: ${escapeHtml(s)}</div>
        <div class="shiftMeta">${grp.working.length+grp.off.length+grp.absent.length} staff</div>
      </div>
      <div class="cols3">
        <div class="list"><div class="listTitle">✔️ Working (${grp.working.length})</div><div class="listBody" id=""></div></div>
        <div class="list"><div class="listTitle">🟡 Off (${grp.off.length})</div><div class="listBody"></div></div>
        <div class="list"><div class="listTitle">🔴 Medical/Absent (${grp.absent.length})</div><div class="listBody"></div></div>
      </div>
    `;
    const bodies = card.querySelectorAll(".listBody");
    const buckets = [grp.working, grp.off, grp.absent];

    buckets.forEach((items, idx) => {
      const body = bodies[idx];
      if (items.length === 0){ body.innerHTML = `<div class="muted">—</div>`; return; }
      for (const {emp, code} of items){
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pill";
        btn.innerHTML = `<span>${escapeHtml(emp.name)}</span><small>${escapeHtml(code||"—")}</small>`;
        btn.onclick = () => openEmployee(emp, s, day, month, year, code);
        body.appendChild(btn);
      }
    });

    root.appendChild(card);
  }

  $("results").classList.remove("hidden");
  setStatus(`Showing ${year}-${pad2(month)}-${pad2(day)}.`);
}

function openEmployee(emp, shift, day, month, year, code){
  const cat = classify(code);
  const label = (cat==="working" ? "Working" : (cat==="off" ? "Off" : "Medical/Absent"));

  $("empName").textContent = emp.name;
  $("empMeta").textContent = `Shift: ${shift} • Selected day: ${label}${code?` (${code})`:""}`;

  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month-1, 1).getDay(); // Sun=0

  const offDays = [];
  for (let d=1; d<=daysInMonth; d++){
    const c = (emp.codes[String(d)]||"").trim().toUpperCase();
    if (OFF_CODES.has(c)) offDays.push(d);
  }
  window.__offDays = offDays;

  $("calLabel").textContent = new Date(year, month-1, 1).toLocaleString(undefined, {month:"long", year:"numeric"});
  const grid = $("calGrid");
  grid.innerHTML = "";

  for (let i=0; i<firstDow; i++){
    const cell = document.createElement("div");
    cell.className = "day empty";
    cell.textContent = " ";
    grid.appendChild(cell);
  }

  for (let d=1; d<=daysInMonth; d++){
    const cell = document.createElement("div");
    const isOff = offDays.includes(d);
    const isSel = d === Number(day);
    cell.className = "day" + (isOff ? " off" : "") + (isSel ? " sel" : "");
    cell.textContent = String(d);
    grid.appendChild(cell);
  }

  $("offDaysText").textContent = offDays.length ? offDays.map(d=>pad2(d)).join(", ") : "—";
  $("offFormat").checked = false;

  $("empDialog").showModal();
}

// ---------- Wire UI ----------
window.addEventListener("load", () => {
  $("pdfInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("fileName").textContent = file.name;
    setStatus("Reading PDF…");
    $("runBtn").disabled = true;
    $("results").classList.add("hidden");

    try{
      parsed = await parseSchedulePDF(file);
      $("monthSel").value = String(parsed.month);
      $("yearInput").value = String(parsed.year);
      $("dayInput").max = String(parsed.daysInMonth);
      $("runBtn").disabled = false;
      setStatus(`Parsed ${parsed.employees.length} employees across ${parsed.shifts.size} shifts.`);
    }catch(err){
      console.error(err);
      setStatus("Could not parse this PDF.");
    }
  });

  $("runBtn").addEventListener("click", () => {
    if (!parsed) return;
    const day = Math.max(1, Math.min(Number($("dayInput").value)||1, parsed.daysInMonth||31));
    const month = Number($("monthSel").value);
    const year = Number($("yearInput").value);
    $("dayInput").value = String(day);
    renderResults(day, month, year);
  });

  $("copyWorkingAll").addEventListener("click", async () => {
    const names = window.__workingNames || [];
    if (!names.length) return;
    await copyText(names.join("\\n"));
    setStatus("Copied working names ✅");
    setTimeout(()=>setStatus(""), 1500);
  });

  $("copyOffDays").addEventListener("click", async () => {
    const off = window.__offDays || [];
    const onePerLine = $("offFormat").checked;
    const text = onePerLine ? off.map(d=>pad2(d)).join("\\n") : off.map(d=>pad2(d)).join(", ");
    await copyText(text);
    setStatus("Copied off days ✅");
    setTimeout(()=>setStatus(""), 1500);
  });
});
