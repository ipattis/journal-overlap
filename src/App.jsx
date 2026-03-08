import { useState, useCallback, useRef, useMemo } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const BASE = "https://api.openalex.org";
const PER_PAGE = 200;
const FROM_YEAR = 2023;
const CAP_OPTIONS = [500, 1000, 2000, 5000];

// ─── API Helpers ─────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${txt.slice(0, 120)}`);
  }
  return res.json();
}

async function searchSources(query) {
  const data = await apiFetch(
    `${BASE}/sources?search=${encodeURIComponent(query)}&per_page=8` +
    `&select=id,display_name,issn_l,works_count,type,host_organization_name`
  );
  return data.results || [];
}

async function resolveJournalNames(names) {
  const resolved = [], failed = [];
  for (const name of names) {
    const q = name.trim();
    if (!q) continue;
    try {
      const results = await searchSources(q);
      if (results.length > 0) resolved.push({ ...results[0], _query: q });
      else failed.push(q);
    } catch { failed.push(q); }
    await sleep(120);
  }
  return { resolved, failed };
}

async function fetchWorksForSources(sourceIds, onProgress, signal) {
  const authorMap = new Map();
  for (const sourceId of sourceIds) {
    if (signal?.aborted) throw new Error("Cancelled");
    const sid = sourceId.replace("https://openalex.org/", "");
    const meta = await apiFetch(
      `${BASE}/works?filter=primary_location.source.id:${sid}` +
      `,from_publication_date:${FROM_YEAR}-01-01,type:article&per_page=1&select=id`
    );
    const total = meta.meta?.count || 0;
    onProgress?.({ phase: "count", sourceId: sid, total });
    if (total === 0) continue;
    const pages = Math.min(Math.ceil(total / PER_PAGE), 50);
    for (let page = 1; page <= pages; page++) {
      if (signal?.aborted) throw new Error("Cancelled");
      const data = await apiFetch(
        `${BASE}/works?filter=primary_location.source.id:${sid}` +
        `,from_publication_date:${FROM_YEAR}-01-01,type:article` +
        `&per_page=${PER_PAGE}&page=${page}` +
        `&select=id,title,doi,authorships,publication_year,primary_location,primary_topic`
      );
      const works = data.results || [];
      if (!works.length) break;
      for (const work of works) {
        const journal = work.primary_location?.source?.display_name || null;
        const pt = work.primary_topic || null;
        const articleMeta = {
          id: work.id, title: work.title || null, doi: work.doi || null,
          journal, year: work.publication_year || null,
          topic:    pt ? { id: pt.id, name: pt.display_name } : null,
          subfield: pt?.subfield ? { id: pt.subfield.id, name: pt.subfield.display_name } : null,
          field:    pt?.field    ? { id: pt.field.id,    name: pt.field.display_name }    : null,
          domain:   pt?.domain   ? { id: pt.domain.id,   name: pt.domain.display_name }   : null,
        };
        for (const authorship of (work.authorships || [])) {
          const aid = authorship.author?.id;
          if (!aid) continue;
          if (!authorMap.has(aid)) authorMap.set(aid, { id: aid, works: new Map(), institutions: new Set() });
          const entry = authorMap.get(aid);
          entry.works.set(work.id, articleMeta);
          for (const inst of (authorship.institutions || [])) {
            if (inst.display_name) entry.institutions.add(inst.display_name);
          }
        }
      }
      onProgress?.({ phase: "works", sourceId: sid, page, pages, total });
      await sleep(60);
    }
  }
  return authorMap;
}

// ─── Analytics helpers ────────────────────────────────────────────────────────

// Build journal-pair counts from overlap results
function computeJournalPairs(results) {
  const pairMap = new Map(); // "JournalA|||JournalB" → { journalA, journalB, authors, authorNames }
  for (const author of results) {
    const journalsA = [...new Set(author.articlesInA.map(a => a.journal).filter(Boolean))];
    const journalsB = [...new Set(author.articlesInB.map(a => a.journal).filter(Boolean))];
    const name = author.enriched?.display_name || shortId(author.id);
    for (const ja of journalsA) {
      for (const jb of journalsB) {
        const key = `${ja}|||${jb}`;
        if (!pairMap.has(key)) pairMap.set(key, { journalA: ja, journalB: jb, authors: 0, worksA: 0, worksB: 0 });
        const p = pairMap.get(key);
        p.authors++;
        p.worksA += author.articlesInA.filter(a => a.journal === ja).length;
        p.worksB += author.articlesInB.filter(a => a.journal === jb).length;
      }
    }
  }
  return [...pairMap.values()].sort((a, b) => b.authors - a.authors);
}

// Build institution overlap counts
function computeInstitutionOverlap(results) {
  const instMap = new Map(); // instName → { name, authors, totalOverlap, totalCitations }
  for (const author of results) {
    const overlap = author.worksInA + author.worksInB;
    const citations = author.enriched?.cited_by_count || 0;
    // Use enriched last_known_institutions first, fall back to collected institutions
    const insts = author.enriched?.last_known_institutions?.map(i => i.display_name).filter(Boolean)
      || [...author.institutions];
    const seen = new Set();
    for (const inst of insts) {
      if (!inst || seen.has(inst)) continue;
      seen.add(inst);
      if (!instMap.has(inst)) instMap.set(inst, { name: inst, authors: 0, totalOverlap: 0, totalCitations: 0 });
      const e = instMap.get(inst);
      e.authors++;
      e.totalOverlap += overlap;
      e.totalCitations += citations;
    }
  }
  return [...instMap.values()].sort((a, b) => b.authors - a.authors);
}

// Build topic overlap at topic / subfield / field / domain level
function computeTopicOverlap(results) {
  // We count an author toward a topic if they have ≥1 article in Set A AND ≥1 article in Set B
  // both tagged with that topic (at whatever level). We use unique authors as the metric.
  const levels = ["topic", "subfield", "field", "domain"];
  const maps = Object.fromEntries(levels.map(l => [l, new Map()]));
  // maps[level]: id → { id, name, level, authorsA, authorsB, authorsOverlap, worksA, worksB }

  for (const author of results) {
    for (const level of levels) {
      // Collect distinct topic-level entities seen in Set A and Set B articles
      const seenA = new Map(); // entityId → name
      const seenB = new Map();
      for (const art of author.articlesInA) {
        const e = art[level]; if (e) seenA.set(e.id, e.name);
      }
      for (const art of author.articlesInB) {
        const e = art[level]; if (e) seenB.set(e.id, e.name);
      }
      // Count works per entity in each set
      const worksAByEntity = new Map();
      const worksBByEntity = new Map();
      for (const art of author.articlesInA) {
        const e = art[level]; if (!e) continue;
        worksAByEntity.set(e.id, (worksAByEntity.get(e.id) || 0) + 1);
      }
      for (const art of author.articlesInB) {
        const e = art[level]; if (!e) continue;
        worksBByEntity.set(e.id, (worksBByEntity.get(e.id) || 0) + 1);
      }
      // All unique entities across both sets for this author
      const allIds = new Set([...seenA.keys(), ...seenB.keys()]);
      for (const eid of allIds) {
        const name = seenA.get(eid) || seenB.get(eid);
        if (!maps[level].has(eid)) {
          maps[level].set(eid, { id: eid, name, level, authorsA: 0, authorsB: 0, authorsOverlap: 0, worksA: 0, worksB: 0 });
        }
        const e = maps[level].get(eid);
        if (seenA.has(eid)) { e.authorsA++; e.worksA += worksAByEntity.get(eid) || 0; }
        if (seenB.has(eid)) { e.authorsB++; e.worksB += worksBByEntity.get(eid) || 0; }
        if (seenA.has(eid) && seenB.has(eid)) e.authorsOverlap++;
      }
    }
  }
  // Sort each level by authorsOverlap desc
  return Object.fromEntries(
    levels.map(l => [l, [...maps[l].values()].sort((a, b) => b.authorsOverlap - a.authorsOverlap)])
  );
}


const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunkArray = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const shortId = id => id?.replace("https://openalex.org/", "") || id;
function parsePastedNames(text) {
  return text.split(/[\n,;]+/).map(s => s.trim()).filter(s => s.length > 1);
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg: "#0d111c", bgDark: "#0a0e1a", surface: "#131826", surface2: "#161b2a",
  border: "#1e2436", border2: "#2d3449",
  textPrimary: "#e2e8f0", textSecondary: "#718096", textMuted: "#4a5568",
  blue: "#63b3ed", blueLight: "#90cdf4",
  amber: "#f6ad55", amberLight: "#fbd38d",
  green: "#9ae6b4", greenDark: "#68d391",
  red: "#fc8181",
};

// ─── Shared UI ────────────────────────────────────────────────────────────────

function Spinner({ size = 18, color = C.blue }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${color}33`, borderTopColor: color, animation: "spin 0.7s linear infinite", flexShrink: 0 }} />;
}

function ProgressBar({ value, max, color }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ height: 3, background: C.border2, borderRadius: 99, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 99, transition: "width 0.3s ease" }} />
    </div>
  );
}

const ghostBtn = { padding: "8px 18px", borderRadius: 7, border: `1px solid ${C.border2}`, background: "transparent", color: C.textSecondary, cursor: "pointer", fontFamily: "inherit", fontSize: 12, transition: "all 0.15s" };

// ─── Word Cloud ───────────────────────────────────────────────────────────────
function WordCloud({ results }) {
  const words = useMemo(() => {
    const top100 = [...results]
      .sort((a, b) => (b.worksInA + b.worksInB) - (a.worksInA + a.worksInB))
      .slice(0, 100);
    if (!top100.length) return [];
    const maxScore = top100[0].worksInA + top100[0].worksInB;
    const minScore = top100[top100.length - 1].worksInA + top100[top100.length - 1].worksInB;
    return top100.map(a => {
      const score = a.worksInA + a.worksInB;
      const norm = minScore === maxScore ? 1 : (score - minScore) / (maxScore - minScore);
      const size = Math.round(11 + norm * 26); // 11px–37px
      // colour: interpolate blue→green→amber by rank
      const ratio = (a.worksInA) / (score || 1);
      const color = ratio > 0.6 ? C.blueLight : ratio < 0.4 ? C.amberLight : C.green;
      return { name: a.enriched?.display_name || shortId(a.id), score, size, color, id: a.id };
    }).sort(() => Math.random() - 0.5); // shuffle for visual spread
  }, [results]);

  if (!words.length) return null;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
      <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>Top 100 Overlapping Authors</div>
      <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>
        Size = overlap score · <span style={{ color: C.blueLight }}>■</span> Set A dominant · <span style={{ color: C.green }}>■</span> Balanced · <span style={{ color: C.amberLight }}>■</span> Set B dominant
      </div>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: "6px 10px",
        alignItems: "center", lineHeight: 1.5,
      }}>
        {words.map(w => (
          <a key={w.id} href={w.id} target="_blank" rel="noreferrer" style={{
            fontSize: w.size, color: w.color, textDecoration: "none",
            opacity: 0.85, transition: "opacity 0.15s, transform 0.15s",
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontWeight: w.size > 24 ? 700 : w.size > 16 ? 500 : 400,
            display: "inline-block",
          }}
            onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.08)"; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.transform = "scale(1)"; }}
            title={`${w.name} · overlap score: ${w.score}`}
          >
            {w.name}
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── Journal Pairs Page ───────────────────────────────────────────────────────
function JournalPairsPage({ results, journalsA, journalsB }) {
  const pairs = useMemo(() => computeJournalPairs(results), [results]);
  const [sortKey, setSortKey] = useState("authors");
  const maxAuthors = pairs[0]?.authors || 1;

  const sorted = [...pairs].sort((a, b) => {
    if (sortKey === "authors") return b.authors - a.authors;
    if (sortKey === "worksA") return b.worksA - a.worksA;
    if (sortKey === "worksB") return b.worksB - a.worksB;
    return 0;
  });

  if (!pairs.length) return (
    <div style={{ padding: "48px 28px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
      Run a search first to see journal pair analysis.
    </div>
  );

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.textPrimary, fontFamily: "'IBM Plex Sans',sans-serif", marginBottom: 4 }}>
          Journal Community Overlap
        </div>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          Each row is a Set A × Set B journal pair. Authors who published in both are counted once per pair.
          {pairs.length > 1 && ` ${pairs.length} distinct pairs found.`}
        </div>
      </div>

      {/* Bar chart: top 20 pairs */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
          Top {Math.min(20, sorted.length)} Pairs by Shared Authors
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.slice(0, 20).map((p, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 22, fontSize: 10, color: C.textMuted, textAlign: "right", flexShrink: 0 }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>
                  <span style={{ color: C.blueLight }}>{p.journalA}</span>
                  <span style={{ color: C.textMuted }}> × </span>
                  <span style={{ color: C.amberLight }}>{p.journalB}</span>
                </div>
                <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: C.border2 }}>
                  <div style={{ width: `${(p.authors / maxAuthors) * 100}%`, background: `linear-gradient(90deg, ${C.blue}, ${C.green})`, transition: "width 0.5s ease" }} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, width: 36, textAlign: "right", flexShrink: 0 }}>
                {p.authors}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Full table */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, fontSize: 11 }}>
        <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort:</span>
        {[{ key: "authors", label: "Shared Authors" }, { key: "worksA", label: "Set A Works" }, { key: "worksB", label: "Set B Works" }].map(({ key, label }) => (
          <button key={key} onClick={() => setSortKey(key)} style={{
            padding: "4px 12px", borderRadius: 5,
            border: `1px solid ${sortKey === key ? C.border2 : C.border}`,
            background: sortKey === key ? C.surface2 : "transparent",
            color: sortKey === key ? C.textPrimary : C.textMuted,
            cursor: "pointer", fontSize: 11, transition: "all 0.15s",
          }}>{label}</button>
        ))}
        <span style={{ marginLeft: "auto", color: C.textMuted }}>{pairs.length} pairs</span>
      </div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 1fr 80px 72px 72px", gap: 8, padding: "8px 16px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: `1px solid ${C.border}` }}>
          <div>#</div>
          <div style={{ color: C.blueLight }}>Set A Journal</div>
          <div style={{ color: C.amberLight }}>Set B Journal</div>
          <div style={{ textAlign: "center", color: C.green }}>Authors</div>
          <div style={{ textAlign: "center", color: C.blueLight }}>A Works</div>
          <div style={{ textAlign: "center", color: C.amberLight }}>B Works</div>
        </div>
        {sorted.map((p, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "28px 1fr 1fr 80px 72px 72px",
            gap: 8, padding: "9px 16px", alignItems: "center",
            background: i % 2 === 0 ? C.surface2 : C.surface,
            borderBottom: `1px solid ${C.border}`,
            fontSize: 12,
          }}>
            <div style={{ color: C.textMuted, fontSize: 11 }}>{i + 1}</div>
            <div style={{ color: C.blueLight, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.journalA}</div>
            <div style={{ color: C.amberLight, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.journalB}</div>
            <div style={{ textAlign: "center" }}>
              <span style={{ background: "rgba(154,230,180,0.12)", color: C.green, borderRadius: 4, padding: "2px 8px", fontWeight: 700 }}>{p.authors}</span>
            </div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{p.worksA}</div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{p.worksB}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Institution Overlap Page ─────────────────────────────────────────────────
function InstitutionPage({ results }) {
  const institutions = useMemo(() => computeInstitutionOverlap(results), [results]);
  const [sortKey, setSortKey] = useState("authors");
  const maxAuthors = institutions[0]?.authors || 1;

  const sorted = [...institutions].sort((a, b) => {
    if (sortKey === "authors") return b.authors - a.authors;
    if (sortKey === "overlap") return b.totalOverlap - a.totalOverlap;
    if (sortKey === "citations") return b.totalCitations - a.totalCitations;
    return 0;
  });

  if (!institutions.length) return (
    <div style={{ padding: "48px 28px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
      Run a search first to see institution analysis.
    </div>
  );

  const top20 = sorted.slice(0, 20);

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.textPrimary, fontFamily: "'IBM Plex Sans',sans-serif", marginBottom: 4 }}>
          Institution Overlap
        </div>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          Institutions whose researchers bridge both journal sets. One author may count for multiple institutions.
          {institutions.length > 1 && ` ${institutions.length} institutions found.`}
        </div>
      </div>

      {/* Horizontal bar chart */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
        <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
          Top {top20.length} Institutions by Bridging Authors
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {top20.map((inst, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 22, fontSize: 10, color: C.textMuted, textAlign: "right", flexShrink: 0 }}>{i + 1}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>
                  {inst.name}
                </div>
                <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: C.border2, position: "relative" }}>
                  <div style={{
                    width: `${(inst.authors / maxAuthors) * 100}%`,
                    background: `linear-gradient(90deg, ${C.blue}cc, ${C.amber}cc)`,
                    transition: "width 0.5s ease",
                  }} />
                </div>
              </div>
              <div style={{ fontSize: 13, color: C.blueLight, fontWeight: 700, width: 32, textAlign: "right", flexShrink: 0 }}>
                {inst.authors}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Full table */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, fontSize: 11 }}>
        <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort:</span>
        {[
          { key: "authors", label: "Bridging Authors" },
          { key: "overlap", label: "Total Overlap Score" },
          { key: "citations", label: "Total Citations" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setSortKey(key)} style={{
            padding: "4px 12px", borderRadius: 5,
            border: `1px solid ${sortKey === key ? C.border2 : C.border}`,
            background: sortKey === key ? C.surface2 : "transparent",
            color: sortKey === key ? C.textPrimary : C.textMuted,
            cursor: "pointer", fontSize: 11, transition: "all 0.15s",
          }}>{label}</button>
        ))}
        <span style={{ marginLeft: "auto", color: C.textMuted }}>{institutions.length} institutions</span>
      </div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 100px 120px 130px", gap: 8, padding: "8px 16px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: `1px solid ${C.border}` }}>
          <div>#</div>
          <div>Institution</div>
          <div style={{ textAlign: "center", color: C.blueLight }}>Authors</div>
          <div style={{ textAlign: "center" }}>Overlap Score</div>
          <div style={{ textAlign: "center" }}>Total Citations</div>
        </div>
        {sorted.map((inst, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "28px 1fr 100px 120px 130px",
            gap: 8, padding: "9px 16px", alignItems: "center",
            background: i % 2 === 0 ? C.surface2 : C.surface,
            borderBottom: `1px solid ${C.border}`,
            fontSize: 12,
          }}>
            <div style={{ color: C.textMuted, fontSize: 11 }}>{i + 1}</div>
            <div style={{ color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst.name}</div>
            <div style={{ textAlign: "center" }}>
              <span style={{ background: "rgba(99,179,237,0.15)", color: C.blueLight, borderRadius: 4, padding: "2px 8px", fontWeight: 700 }}>{inst.authors}</span>
            </div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{inst.totalOverlap.toLocaleString()}</div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{inst.totalCitations.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Topics Page ──────────────────────────────────────────────────────────────
const LEVEL_LABELS = { domain: "Domain", field: "Field", subfield: "Subfield", topic: "Topic" };
const LEVEL_ORDER = ["domain", "field", "subfield", "topic"];

function TopicsPage({ results }) {
  const topicData = useMemo(() => computeTopicOverlap(results), [results]);
  const [activeLevel, setActiveLevel] = useState("field");
  const [sortKey, setSortKey] = useState("overlap");

  if (!results.length) return (
    <div style={{ padding: "48px 28px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
      Run a search first to see topic analysis.
    </div>
  );

  const rows = topicData[activeLevel] || [];
  const sorted = [...rows].sort((a, b) => {
    if (sortKey === "overlap")  return b.authorsOverlap - a.authorsOverlap;
    if (sortKey === "authorsA") return b.authorsA - a.authorsA;
    if (sortKey === "authorsB") return b.authorsB - a.authorsB;
    if (sortKey === "worksA")   return b.worksA - a.worksA;
    if (sortKey === "worksB")   return b.worksB - a.worksB;
    return 0;
  });

  const maxOverlap = sorted[0]?.authorsOverlap || 1;
  const top20 = sorted.slice(0, 20);

  // Colour gradient per level
  const levelColor = { domain: "#b794f4", field: "#76e4f7", subfield: "#9ae6b4", topic: "#fbd38d" };
  const lc = levelColor[activeLevel];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.textPrimary, fontFamily: "'IBM Plex Sans',sans-serif", marginBottom: 4 }}>
          Topic Community Overlap
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 16 }}>
          Based on <code style={{ color: C.textSecondary, fontSize: 11 }}>primary_topic</code> assigned by OpenAlex to each article.
          An author counts toward a topic if they published in both Set A and Set B under that topic.
        </div>

        {/* Level selector */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginRight: 4 }}>Granularity:</span>
          {LEVEL_ORDER.map(lv => (
            <button key={lv} onClick={() => setActiveLevel(lv)} style={{
              padding: "5px 14px", borderRadius: 6, fontSize: 11,
              border: `1px solid ${activeLevel === lv ? levelColor[lv] + "88" : C.border}`,
              background: activeLevel === lv ? levelColor[lv] + "18" : "transparent",
              color: activeLevel === lv ? levelColor[lv] : C.textMuted,
              cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit",
            }}>
              {LEVEL_LABELS[lv]}
              <span style={{ marginLeft: 6, opacity: 0.6, fontSize: 10 }}>
                ({topicData[lv]?.filter(r => r.authorsOverlap > 0).length || 0})
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Word cloud — subfield and topic levels only */}
      {(activeLevel === "subfield" || activeLevel === "topic") && sorted.length > 0 && (() => {
        const cloudWords = sorted
          .filter(r => r.authorsOverlap > 0)
          .slice(0, activeLevel === "topic" ? 120 : 60);
        if (!cloudWords.length) return null;
        const maxO = cloudWords[0].authorsOverlap;
        const minO = cloudWords[cloudWords.length - 1].authorsOverlap;
        const sizeMin = activeLevel === "topic" ? 10 : 12;
        const sizeMax = activeLevel === "topic" ? 28 : 34;
        const tagged = cloudWords.map(r => {
          const norm = maxO === minO ? 1 : (r.authorsOverlap - minO) / (maxO - minO);
          const size = Math.round(sizeMin + norm * (sizeMax - sizeMin));
          const ratioA = r.authorsA / ((r.authorsA + r.authorsB) || 1);
          const color = ratioA > 0.62 ? C.blueLight : ratioA < 0.38 ? C.amberLight : lc;
          return { ...r, size, color };
        }).sort(() => Math.random() - 0.5);
        return (
          <div style={{ background: C.surface, border: `1px solid ${lc}22`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 4 }}>
              {LEVEL_LABELS[activeLevel]} Word Cloud
              <span style={{ marginLeft: 8, color: lc, opacity: 0.7 }}>— top {tagged.length} by overlap</span>
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 14 }}>
              Size = bridging authors ·{" "}
              <span style={{ color: C.blueLight }}>■</span> Set A dominant ·{" "}
              <span style={{ color: lc }}>■</span> Balanced ·{" "}
              <span style={{ color: C.amberLight }}>■</span> Set B dominant
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px 10px", alignItems: "center", lineHeight: 1.6 }}>
              {tagged.map((w, i) => (
                <span key={w.id || i} title={`${w.name} · ${w.authorsOverlap} bridging authors · ${w.authorsA} Set A · ${w.authorsB} Set B`}
                  style={{
                    fontSize: w.size, color: w.color, opacity: 0.88,
                    fontFamily: "'IBM Plex Sans', sans-serif",
                    fontWeight: w.size > 22 ? 700 : w.size > 15 ? 500 : 400,
                    cursor: "default", display: "inline-block",
                    transition: "opacity 0.15s, transform 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.1)"; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = "0.88"; e.currentTarget.style.transform = "scale(1)"; }}
                >
                  {w.name}
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Bar chart — top 20 */}
      {top20.length > 0 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "20px 24px", marginBottom: 24 }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 16 }}>
            Top {top20.length} {LEVEL_LABELS[activeLevel]}s by Bridging Authors
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {top20.map((row, i) => (
              <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 22, fontSize: 10, color: C.textMuted, textAlign: "right", flexShrink: 0 }}>{i + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>
                    {row.name}
                  </div>
                  {/* Stacked bar: Set A authors (blue) + overlap bonus (green) + Set B authors (amber) */}
                  <div style={{ display: "flex", height: 7, borderRadius: 3, overflow: "hidden", background: C.border2 }}>
                    <div style={{ width: `${(row.authorsA / maxOverlap) * 100}%`, background: `${C.blue}99`, transition: "width 0.5s ease", minWidth: row.authorsA ? 2 : 0 }} />
                    <div style={{ width: `${(row.authorsOverlap / maxOverlap) * 100}%`, background: lc, transition: "width 0.5s ease", minWidth: row.authorsOverlap ? 2 : 0 }} />
                    <div style={{ width: `${(row.authorsB / maxOverlap) * 100}%`, background: `${C.amber}99`, transition: "width 0.5s ease", minWidth: row.authorsB ? 2 : 0 }} />
                  </div>
                </div>
                <div style={{ fontSize: 12, color: lc, fontWeight: 700, width: 36, textAlign: "right", flexShrink: 0 }}>
                  {row.authorsOverlap}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14, fontSize: 10, color: C.textMuted, display: "flex", gap: 16 }}>
            <span><span style={{ color: C.blue }}>■</span> Set A only</span>
            <span><span style={{ color: lc }}>■</span> Both sets (overlap)</span>
            <span><span style={{ color: C.amber }}>■</span> Set B only</span>
          </div>
        </div>
      )}

      {/* Full sortable table */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, fontSize: 11, flexWrap: "wrap" }}>
        <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort:</span>
        {[
          { key: "overlap",  label: "Overlap Authors" },
          { key: "authorsA", label: "Set A Authors" },
          { key: "authorsB", label: "Set B Authors" },
          { key: "worksA",   label: "Set A Works" },
          { key: "worksB",   label: "Set B Works" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setSortKey(key)} style={{
            padding: "4px 12px", borderRadius: 5,
            border: `1px solid ${sortKey === key ? C.border2 : C.border}`,
            background: sortKey === key ? C.surface2 : "transparent",
            color: sortKey === key ? C.textPrimary : C.textMuted,
            cursor: "pointer", fontSize: 11, transition: "all 0.15s",
          }}>{label}</button>
        ))}
        <span style={{ marginLeft: "auto", color: C.textMuted }}>
          {sorted.length} {LEVEL_LABELS[activeLevel].toLowerCase()}s
        </span>
      </div>

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        {/* Header */}
        <div style={{
          display: "grid", gridTemplateColumns: "28px 1fr 100px 90px 90px 72px 72px",
          gap: 8, padding: "8px 16px",
          fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em",
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div>#</div>
          <div>{LEVEL_LABELS[activeLevel]}</div>
          <div style={{ textAlign: "center", color: lc }}>Overlap</div>
          <div style={{ textAlign: "center", color: C.blueLight }}>A Authors</div>
          <div style={{ textAlign: "center", color: C.amberLight }}>B Authors</div>
          <div style={{ textAlign: "center", color: C.blueLight }}>A Works</div>
          <div style={{ textAlign: "center", color: C.amberLight }}>B Works</div>
        </div>
        {sorted.map((row, i) => (
          <div key={row.id} style={{
            display: "grid", gridTemplateColumns: "28px 1fr 100px 90px 90px 72px 72px",
            gap: 8, padding: "9px 16px", alignItems: "center",
            background: i % 2 === 0 ? C.surface2 : C.surface,
            borderBottom: `1px solid ${C.border}`, fontSize: 12,
          }}>
            <div style={{ fontSize: 11, color: C.textMuted }}>{i + 1}</div>
            <div style={{ color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {row.name}
            </div>
            <div style={{ textAlign: "center" }}>
              <span style={{ background: lc + "22", color: lc, borderRadius: 4, padding: "2px 8px", fontWeight: 700 }}>
                {row.authorsOverlap}
              </span>
            </div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{row.authorsA}</div>
            <div style={{ textAlign: "center", color: C.textSecondary }}>{row.authorsB}</div>
            <div style={{ textAlign: "center", color: C.textMuted }}>{row.worksA}</div>
            <div style={{ textAlign: "center", color: C.textMuted }}>{row.worksB}</div>
          </div>
        ))}
      </div>
    </div>
  );
}



function JournalPill({ journal, onRemove, color }) {
  const accent = color === "A" ? C.blue : C.amber;
  const bg = color === "A" ? "rgba(99,179,237,0.12)" : "rgba(246,173,85,0.12)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, background: bg, border: `1px solid ${accent}44`, borderRadius: 6, padding: "4px 10px", fontSize: 12, color: color === "A" ? C.blueLight : C.amberLight }}>
      <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{journal.display_name}</span>
      {journal.works_count != null && <span style={{ opacity: 0.4, fontSize: 11 }}>~{journal.works_count.toLocaleString()}</span>}
      <button onClick={() => onRemove(journal.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.55, fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

function PasteModal({ color, existing, onAdd, onClose }) {
  const accent = color === "A" ? C.blue : C.amber;
  const [text, setText] = useState("");
  const [status, setStatus] = useState("idle");
  const [resolved, setResolved] = useState([]);
  const [failed, setFailed] = useState([]);
  const [selected, setSelected] = useState(new Set());

  const resolve = async () => {
    const names = parsePastedNames(text);
    if (!names.length) return;
    setStatus("resolving");
    const { resolved: r, failed: f } = await resolveJournalNames(names);
    const fresh = r.filter(j => !existing.find(e => e.id === j.id));
    setResolved(fresh); setFailed(f); setSelected(new Set(fresh.map(j => j.id)));
    setStatus("done");
  };
  const confirm = () => { onAdd(resolved.filter(j => selected.has(j.id))); onClose(); };
  const toggle = (id) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: C.surface, border: `1px solid ${accent}33`, borderRadius: 12, padding: 28, width: "100%", maxWidth: 520, boxShadow: "0 24px 64px rgba(0,0,0,0.6)", animation: "fadeIn 0.2s ease" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: accent, marginBottom: 4, letterSpacing: "0.08em" }}>PASTE JOURNAL LIST — SET {color}</div>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 16 }}>One per line, or separated by commas / semicolons.</div>
        {status === "idle" && (
          <>
            <textarea autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={"Nature\nScience\nCell\nPNAS, PLOS ONE"} rows={7}
              style={{ width: "100%", background: C.bg, border: `1px solid ${C.border2}`, borderRadius: 8, padding: "10px 14px", color: C.textPrimary, fontSize: 13, fontFamily: "inherit", resize: "vertical", outline: "none", marginBottom: 16 }}
              onFocus={e => e.target.style.borderColor = accent} onBlur={e => e.target.style.borderColor = C.border2} />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={onClose} style={ghostBtn}>Cancel</button>
              <button onClick={resolve} disabled={!parsePastedNames(text).length} style={{ ...ghostBtn, background: accent + "22", borderColor: accent + "66", color: accent, cursor: parsePastedNames(text).length ? "pointer" : "not-allowed" }}>
                Resolve {parsePastedNames(text).length > 0 ? `(${parsePastedNames(text).length})` : ""}
              </button>
            </div>
          </>
        )}
        {status === "resolving" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "24px 0" }}>
            <Spinner size={28} color={accent} /><div style={{ fontSize: 12, color: C.textMuted }}>Resolving via OpenAlex…</div>
          </div>
        )}
        {status === "done" && (
          <>
            {resolved.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>Resolved — click to toggle</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16, maxHeight: 260, overflowY: "auto" }}>
                  {resolved.map(j => (
                    <div key={j.id} onClick={() => toggle(j.id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 7, cursor: "pointer", background: selected.has(j.id) ? accent + "15" : C.bg, border: `1px solid ${selected.has(j.id) ? accent + "44" : C.border}`, transition: "all 0.15s" }}>
                      <div style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${selected.has(j.id) ? accent : C.textMuted}`, background: selected.has(j.id) ? accent : "transparent", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#000" }}>{selected.has(j.id) ? "✓" : ""}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: C.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.display_name}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1 }}>
                          {j._query !== j.display_name && <span style={{ color: C.textSecondary }}>matched "{j._query}" · </span>}
                          {j.type} · {j.host_organization_name || "—"} · {j.works_count?.toLocaleString()} works
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {failed.length > 0 && <div style={{ fontSize: 11, color: C.red, marginBottom: 16 }}>⚠ No match: {failed.join(", ")}</div>}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.textMuted, marginRight: "auto" }}>{selected.size} of {resolved.length} selected</span>
              <button onClick={onClose} style={ghostBtn}>Cancel</button>
              <button onClick={confirm} disabled={selected.size === 0} style={{ ...ghostBtn, background: accent + "22", borderColor: accent + "66", color: accent, cursor: selected.size ? "pointer" : "not-allowed" }}>
                Add {selected.size} journal{selected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function JournalSearchBox({ label, color, journals, setJournals, disabled }) {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const debounceRef = useRef(null);
  const accent = color === "A" ? C.blue : C.amber;

  const onInput = (val) => {
    setInput(val); clearTimeout(debounceRef.current);
    if (val.length < 2) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try { const r = await searchSources(val); setSuggestions(r.filter(r => !journals.find(j => j.id === r.id))); } catch {}
      setSearching(false);
    }, 380);
  };
  const addJournal = (j) => { setJournals(prev => [...prev, j]); setSuggestions([]); setInput(""); };
  const addMany = (list) => setJournals(prev => { const ids = new Set(prev.map(j => j.id)); return [...prev, ...list.filter(j => !ids.has(j.id))]; });
  const removeJournal = (id) => setJournals(prev => prev.filter(j => j.id !== id));

  return (
    <>
      {showPaste && <PasteModal color={color} existing={journals} onAdd={addMany} onClose={() => setShowPaste(false)} />}
      <div style={{ flex: 1, minWidth: 280, position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: accent }}>Set {label} — Journals</div>
          <button disabled={disabled} onClick={() => setShowPaste(true)} style={{ ...ghostBtn, padding: "3px 10px", fontSize: 10, color: disabled ? C.border2 : accent + "cc", borderColor: disabled ? C.border : accent + "33", textTransform: "uppercase", letterSpacing: "0.06em" }}>⊞ Paste list</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, minHeight: 32 }}>
          {journals.map(j => <JournalPill key={j.id} journal={j} onRemove={removeJournal} color={color} />)}
        </div>
        <div style={{ position: "relative" }}>
          <input disabled={disabled} value={input} onChange={e => onInput(e.target.value)} placeholder="Search and add one journal…"
            style={{ width: "100%", background: "#1a1f2e", border: `1px solid ${journals.length ? accent + "44" : C.border2}`, borderRadius: 8, padding: "9px 14px", color: C.textPrimary, fontSize: 13, outline: "none", transition: "border-color 0.2s" }}
            onFocus={e => e.target.style.borderColor = accent}
            onBlur={e => { e.target.style.borderColor = journals.length ? accent + "44" : C.border2; setTimeout(() => setSuggestions([]), 200); }} />
          {searching && <div style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)" }}><Spinner size={13} color={accent} /></div>}
        </div>
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", zIndex: 50, left: 0, right: 0, background: "#1e2436", border: `1px solid ${accent}22`, borderRadius: 8, marginTop: 4, overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}>
            {suggestions.map(s => (
              <div key={s.id} onMouseDown={() => addJournal(s)} style={{ padding: "9px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}22`, transition: "background 0.1s" }}
                onMouseEnter={e => e.currentTarget.style.background = accent + "15"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <div style={{ fontSize: 13, color: C.textPrimary }}>{s.display_name}</div>
                <div style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>{s.type} · {s.host_organization_name || "—"} · {s.works_count?.toLocaleString()} works</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Article list (expanded row) ──────────────────────────────────────────────
function ArticleList({ works, color }) {
  const accent = color === "A" ? C.blue : C.amber;
  const labelColor = color === "A" ? C.blueLight : C.amberLight;
  const bg = color === "A" ? "rgba(99,179,237,0.07)" : "rgba(246,173,85,0.07)";
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: accent, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6, fontWeight: 700 }}>Set {color} Articles ({works.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {works.map(w => (
          <div key={w.id} style={{ background: bg, border: `1px solid ${accent}22`, borderRadius: 6, padding: "7px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ fontSize: 12, color: "#cbd5e0", lineHeight: 1.4 }}>
              {w.title
                ? (w.doi ? <a href={w.doi} target="_blank" rel="noreferrer" style={{ color: "#cbd5e0", textDecoration: "none" }} onMouseEnter={e => e.currentTarget.style.color = accent} onMouseLeave={e => e.currentTarget.style.color = "#cbd5e0"}>{w.title}</a> : w.title)
                : <span style={{ color: C.textMuted, fontStyle: "italic" }}>No title available</span>}
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {w.journal && <span style={{ color: labelColor, opacity: 0.8 }}>{w.journal}</span>}
              {w.year && <span>{w.year}</span>}
              {w.doi && (
                <a href={w.doi} target="_blank" rel="noreferrer" style={{ color: C.textMuted, textDecoration: "none", fontSize: 10, border: `1px solid ${C.border2}`, borderRadius: 3, padding: "1px 5px", transition: "color 0.1s, border-color 0.1s" }}
                  onMouseEnter={e => { e.currentTarget.style.color = accent; e.currentTarget.style.borderColor = accent; }}
                  onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.borderColor = C.border2; }}>DOI ↗</a>
              )}
              <a href={w.id} target="_blank" rel="noreferrer" style={{ color: C.textMuted, textDecoration: "none", fontSize: 10, border: `1px solid ${C.border2}`, borderRadius: 3, padding: "1px 5px", transition: "color 0.1s, border-color 0.1s" }}
                onMouseEnter={e => { e.currentTarget.style.color = "#a0aec0"; e.currentTarget.style.borderColor = C.textMuted; }}
                onMouseLeave={e => { e.currentTarget.style.color = C.textMuted; e.currentTarget.style.borderColor = C.border2; }}>OA ↗</a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuthorRow({ author, index }) {
  const [expanded, setExpanded] = useState(false);
  const inst = author.enriched?.last_known_institutions?.[0]?.display_name || [...author.institutions].slice(0, 1)[0] || "—";
  const totalCitations = author.enriched?.cited_by_count ?? "—";
  const orcid = author.enriched?.orcid;
  const name = author.enriched?.display_name || shortId(author.id);
  const overlapScore = author.worksInA + author.worksInB;

  return (
    <div style={{ background: index % 2 === 0 ? C.surface2 : C.surface, borderBottom: `1px solid ${C.border}` }}>
      <div onClick={() => setExpanded(e => !e)} style={{ display: "grid", gridTemplateColumns: "36px 1fr 72px 72px 80px 100px 24px", alignItems: "center", gap: 8, padding: "10px 16px", cursor: "pointer" }}
        onMouseEnter={e => e.currentTarget.style.background = C.border} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center" }}>{index + 1}</div>
        <div>
          <div style={{ fontSize: 13, color: C.textPrimary, fontWeight: 500 }}>{name}</div>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inst}</div>
        </div>
        <div style={{ textAlign: "center" }}><span style={{ background: "rgba(99,179,237,0.15)", color: C.blueLight, borderRadius: 4, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>{author.worksInA}</span></div>
        <div style={{ textAlign: "center" }}><span style={{ background: "rgba(246,173,85,0.15)", color: C.amberLight, borderRadius: 4, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>{author.worksInB}</span></div>
        <div style={{ textAlign: "center" }}><span style={{ background: "rgba(154,230,180,0.12)", color: C.green, borderRadius: 4, padding: "2px 8px", fontSize: 13, fontWeight: 700 }}>{overlapScore}</span></div>
        <div style={{ textAlign: "center", fontSize: 12, color: C.textSecondary }}>{typeof totalCitations === "number" ? totalCitations.toLocaleString() : "—"}</div>
        <div style={{ color: C.textMuted, fontSize: 11, textAlign: "center" }}>{expanded ? "▲" : "▼"}</div>
      </div>
      {expanded && (
        <div style={{ padding: "16px 16px 16px 52px", background: "#0f1320", borderTop: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 16, fontSize: 12, color: C.textSecondary }}>
            <div>
              <div style={{ color: C.textMuted, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.1em" }}>OpenAlex</div>
              <a href={author.id} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: "none" }}>{shortId(author.id)}</a>
            </div>
            {orcid && <div>
              <div style={{ color: C.textMuted, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.1em" }}>ORCID</div>
              <a href={orcid} target="_blank" rel="noreferrer" style={{ color: C.blue, textDecoration: "none" }}>{orcid.replace("https://orcid.org/", "")}</a>
            </div>}
            <div>
              <div style={{ color: C.textMuted, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.1em" }}>Institutions (2023–present)</div>
              <div style={{ color: "#a0aec0", marginTop: 2 }}>{[...author.institutions].join(" · ") || "—"}</div>
            </div>
            <div>
              <div style={{ color: C.textMuted, textTransform: "uppercase", fontSize: 10, letterSpacing: "0.1em" }}>Career Works</div>
              <div style={{ marginTop: 2 }}>{author.enriched?.works_count?.toLocaleString() ?? "—"}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}><ArticleList works={author.articlesInA} color="A" /></div>
            <div style={{ flex: 1, minWidth: 260 }}><ArticleList works={author.articlesInB} color="B" /></div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard (main results page) ───────────────────────────────────────────
function DashboardPage({ results, totalOverlap, sortKey, setSortKey, journalsA, journalsB }) {
  const sorted = useMemo(() => [...results].sort((a, b) => {
    if (sortKey === "overlap") return (b.worksInA + b.worksInB) - (a.worksInA + a.worksInB);
    if (sortKey === "citations") return (b.enriched?.cited_by_count ?? 0) - (a.enriched?.cited_by_count ?? 0);
    if (sortKey === "setA") return b.worksInA - a.worksInA;
    if (sortKey === "setB") return b.worksInB - a.worksInB;
    return 0;
  }), [results, sortKey]);

  const isCapped = totalOverlap > results.length && results.length > 0;

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100, margin: "0 auto" }}>
      {/* Word cloud */}
      {results.length > 0 && <WordCloud results={results} />}

      {/* Sort + table */}
      {sorted.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, fontSize: 11, flexWrap: "wrap" }}>
            <span style={{ color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Sort:</span>
            {[{ key: "overlap", label: "Overlap" }, { key: "setA", label: "Set A" }, { key: "setB", label: "Set B" }, { key: "citations", label: "Citations" }].map(({ key, label }) => (
              <button key={key} onClick={() => setSortKey(key)} style={{
                padding: "4px 12px", borderRadius: 5,
                border: `1px solid ${sortKey === key ? C.border2 : C.border}`,
                background: sortKey === key ? C.surface2 : "transparent",
                color: sortKey === key ? C.textPrimary : C.textMuted,
                cursor: "pointer", fontSize: 11, transition: "all 0.15s",
              }}>{label}</button>
            ))}
            <span style={{ marginLeft: "auto", color: C.textMuted }}>{sorted.length.toLocaleString()} authors · click row to expand</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 72px 72px 80px 100px 24px", gap: 8, padding: "8px 16px", fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: `1px solid ${C.border}` }}>
            <div style={{ textAlign: "center" }}>#</div>
            <div>Author · Institution</div>
            <div style={{ textAlign: "center", color: C.blueLight }}>Set A</div>
            <div style={{ textAlign: "center", color: C.amberLight }}>Set B</div>
            <div style={{ textAlign: "center", color: C.green }}>Overlap</div>
            <div style={{ textAlign: "center" }}>Citations</div>
            <div />
          </div>

          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden", marginTop: 4 }}>
            {sorted.map((author, i) => <AuthorRow key={author.id} author={author} index={i} />)}
          </div>

          {isCapped && (
            <div style={{ marginTop: 12, padding: "10px 16px", borderRadius: 8, background: "rgba(246,173,85,0.08)", border: `1px solid ${C.amber}33`, fontSize: 12, color: C.amber }}>
              ⚠ Showing top {results.length.toLocaleString()} of {totalOverlap.toLocaleString()} overlapping authors. Increase the limit and re-run to see more.
            </div>
          )}

          <div style={{ marginTop: 14, fontSize: 11, color: C.textMuted, display: "flex", gap: 20, flexWrap: "wrap" }}>
            <span><span style={{ color: C.blueLight }}>■</span> Set A: {journalsA.map(j => j.display_name).join(", ")}</span>
            <span><span style={{ color: C.amberLight }}>■</span> Set B: {journalsB.map(j => j.display_name).join(", ")}</span>
            <span>Citations = career total · Overlap = A + B article count (2023–present)</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [journalsA, setJournalsA] = useState([]);
  const [journalsB, setJournalsB] = useState([]);
  const [phase, setPhase] = useState("idle");
  const [log, setLog] = useState([]);
  const [progress, setProgress] = useState({ a: 0, aTotal: 0, b: 0, bTotal: 0, enrich: 0, enrichTotal: 0 });
  const [results, setResults] = useState([]);
  const [totalOverlap, setTotalOverlap] = useState(0);
  const [sortKey, setSortKey] = useState("overlap");
  const [resultCap, setResultCap] = useState(500);
  const [errorMsg, setErrorMsg] = useState("");
  const [activePage, setActivePage] = useState("dashboard"); // dashboard | journals | institutions
  const abortRef = useRef(null);

  const addLog = (msg) => setLog(prev => [...prev.slice(-30), msg]);

  const run = useCallback(async () => {
    if (journalsA.length === 0 || journalsB.length === 0) return;
    abortRef.current = new AbortController();
    setPhase("running"); setResults([]); setTotalOverlap(0); setLog([]); setErrorMsg("");
    setProgress({ a: 0, aTotal: 0, b: 0, bTotal: 0, enrich: 0, enrichTotal: 0 });
    setActivePage("dashboard");

    try {
      addLog(`Fetching Set A (${journalsA.length} journal${journalsA.length > 1 ? "s" : ""})…`);
      const mapA = await fetchWorksForSources(journalsA.map(j => j.id), ({ phase: p, sourceId, total }) => {
        if (p === "count") { addLog(`  ${sourceId}: ${total.toLocaleString()} articles`); setProgress(prev => ({ ...prev, aTotal: prev.aTotal + total })); }
        else setProgress(prev => ({ ...prev, a: Math.min(prev.a + PER_PAGE, prev.aTotal) }));
      }, abortRef.current.signal);
      addLog(`Set A: ${mapA.size.toLocaleString()} unique authors`);

      addLog(`Fetching Set B (${journalsB.length} journal${journalsB.length > 1 ? "s" : ""})…`);
      const mapB = await fetchWorksForSources(journalsB.map(j => j.id), ({ phase: p, sourceId, total }) => {
        if (p === "count") { addLog(`  ${sourceId}: ${total.toLocaleString()} articles`); setProgress(prev => ({ ...prev, bTotal: prev.bTotal + total })); }
        else setProgress(prev => ({ ...prev, b: Math.min(prev.b + PER_PAGE, prev.bTotal) }));
      }, abortRef.current.signal);
      addLog(`Set B: ${mapB.size.toLocaleString()} unique authors`);

      addLog("Computing overlap…");
      const overlap = [];
      for (const [aid, entryA] of mapA) {
        if (mapB.has(aid)) {
          const entryB = mapB.get(aid);
          const articlesInA = [...entryA.works.values()].sort((a, b) => (b.year || 0) - (a.year || 0));
          const articlesInB = [...entryB.works.values()].sort((a, b) => (b.year || 0) - (a.year || 0));
          overlap.push({ id: aid, worksInA: articlesInA.length, worksInB: articlesInB.length, articlesInA, articlesInB, institutions: new Set([...entryA.institutions, ...entryB.institutions]), enriched: null });
        }
      }

      const total = overlap.length;
      setTotalOverlap(total);
      addLog(`Overlap: ${total.toLocaleString()} authors in both sets`);
      if (total === 0) { setPhase("done"); setResults([]); return; }

      const toEnrich = overlap.sort((a, b) => (b.worksInA + b.worksInB) - (a.worksInA + a.worksInB)).slice(0, resultCap);
      addLog(`Enriching top ${toEnrich.length} authors…`);
      setProgress(prev => ({ ...prev, enrichTotal: toEnrich.length }));

      const enriched = {};
      let enrichCount = 0;
      for (const chunk of chunkArray(toEnrich.map(a => a.id), 50)) {
        if (abortRef.current.signal.aborted) throw new Error("Cancelled");
        const sids = chunk.map(id => id.replace("https://openalex.org/", ""));
        try {
          const data = await apiFetch(`${BASE}/authors?filter=openalex_id:${sids.join("|")}&per_page=50&select=id,display_name,orcid,cited_by_count,works_count,last_known_institutions`);
          for (const a of (data.results || [])) enriched[a.id] = a;
        } catch {}
        enrichCount += chunk.length;
        setProgress(prev => ({ ...prev, enrich: enrichCount }));
        await sleep(80);
      }

      const finalResults = toEnrich.map(a => ({ ...a, enriched: enriched[a.id] || null }));
      addLog(`Done. Showing ${finalResults.length} of ${total.toLocaleString()} authors.`);
      setResults(finalResults);
      setPhase("done");
    } catch (e) {
      if (e.message === "Cancelled") { setPhase("idle"); addLog("Cancelled."); }
      else { setErrorMsg(e.message); setPhase("error"); }
    }
  }, [journalsA, journalsB, resultCap]);

  const cancel = () => abortRef.current?.abort();
  const canRun = journalsA.length > 0 && journalsB.length > 0 && phase !== "running";
  const isRunning = phase === "running";
  const aProgress = progress.aTotal ? Math.min(1, progress.a / progress.aTotal) : 0;
  const bProgress = progress.bTotal ? Math.min(1, progress.b / progress.bTotal) : 0;
  const enrichProgress = progress.enrichTotal ? Math.min(1, progress.enrich / progress.enrichTotal) : 0;
  const hasResults = results.length > 0;

  const NAV = [
    { key: "dashboard",    label: "Authors" },
    { key: "journals",     label: "Journal Pairs" },
    { key: "institutions", label: "Institutions" },
    { key: "topics",       label: "Topics" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.textPrimary, fontFamily: "'IBM Plex Mono','Fira Code',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:6px; } ::-webkit-scrollbar-track { background:#0d111c; } ::-webkit-scrollbar-thumb { background:#2d3449; border-radius:3px; }
        input::placeholder, textarea::placeholder { color:#2d3449; }
        input, textarea, button, select { font-family:inherit; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "18px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bgDark }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: C.textMuted, marginBottom: 3 }}>OpenAlex · Authorship Analysis</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, fontFamily: "'IBM Plex Sans',sans-serif" }}>Journal Overlap Finder</div>
        </div>
        <div style={{ fontSize: 10, color: C.textMuted, textAlign: "right", lineHeight: 1.8, letterSpacing: "0.05em" }}>
          Articles 2023–present<br />Powered by OpenAlex
        </div>
      </div>

      {/* Controls */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "20px 28px", background: C.bgDark }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
            <JournalSearchBox label="A" color="A" journals={journalsA} setJournals={setJournalsA} disabled={isRunning} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.border2, userSelect: "none", paddingTop: 24 }}>∩</div>
            <JournalSearchBox label="B" color="B" journals={journalsB} setJournals={setJournalsB} disabled={isRunning} />
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button onClick={isRunning ? cancel : run} disabled={!isRunning && !canRun} style={{
              padding: "10px 26px", borderRadius: 8, border: "none", fontWeight: 600, fontSize: 13,
              cursor: canRun || isRunning ? "pointer" : "not-allowed",
              background: isRunning ? "#742a2a" : canRun ? "#2b6cb0" : "#1a1f2e",
              color: canRun || isRunning ? "#fff" : C.textMuted,
              transition: "background 0.2s", letterSpacing: "0.05em",
            }}>
              {isRunning ? "■  Cancel" : "▶  Find Overlap"}
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: C.textMuted }}>
              <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>Show top</span>
              <select value={resultCap} onChange={e => setResultCap(Number(e.target.value))} disabled={isRunning}
                style={{ background: "#1a1f2e", border: `1px solid ${C.border2}`, borderRadius: 6, padding: "5px 10px", color: C.textPrimary, fontSize: 12, cursor: "pointer", outline: "none" }}>
                {CAP_OPTIONS.map(n => <option key={n} value={n}>{n.toLocaleString()}</option>)}
              </select>
              <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>authors</span>
            </div>

            {phase === "done" && hasResults && <div style={{ fontSize: 12, color: C.greenDark }}>✓ {results.length.toLocaleString()} authors · {totalOverlap.toLocaleString()} total overlap</div>}
            {phase === "done" && !hasResults && <div style={{ fontSize: 12, color: C.red }}>No authors found in both sets</div>}
            {phase === "error" && <div style={{ fontSize: 12, color: C.red }}>Error: {errorMsg}</div>}
          </div>

          {/* Progress */}
          {isRunning && (
            <div style={{ background: "#111827", border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginTop: 16, animation: "fadeIn 0.3s ease" }}>
              <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
                {[{ label: "Set A", pct: aProgress, color: C.blue }, { label: "Set B", pct: bProgress, color: C.amber }, { label: "Enriching", pct: enrichProgress, color: C.green }].map(({ label, pct, color }) => (
                  <div key={label} style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>{label} · {Math.round(pct * 100)}%</div>
                    <ProgressBar value={pct * 100} max={100} color={color} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, display: "flex", alignItems: "center", gap: 8 }}>
                <Spinner size={11} color={C.textMuted} />{log[log.length - 1] || "Working…"}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tab nav */}
      {hasResults && (
        <div style={{ borderBottom: `1px solid ${C.border}`, background: C.bgDark, padding: "0 28px" }}>
          <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", gap: 0 }}>
            {NAV.map(({ key, label }) => (
              <button key={key} onClick={() => setActivePage(key)} style={{
                padding: "12px 20px", border: "none", background: "transparent",
                color: activePage === key ? C.textPrimary : C.textMuted,
                borderBottom: `2px solid ${activePage === key ? C.blue : "transparent"}`,
                cursor: "pointer", fontSize: 12, fontWeight: activePage === key ? 600 : 400,
                transition: "all 0.15s", letterSpacing: "0.04em",
              }}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {/* Page content */}
      {activePage === "dashboard" && (
        <DashboardPage results={results} totalOverlap={totalOverlap} sortKey={sortKey} setSortKey={setSortKey} journalsA={journalsA} journalsB={journalsB} />
      )}
      {activePage === "journals" && hasResults && (
        <JournalPairsPage results={results} journalsA={journalsA} journalsB={journalsB} />
      )}
      {activePage === "institutions" && hasResults && (
        <InstitutionPage results={results} />
      )}
      {activePage === "topics" && hasResults && (
        <TopicsPage results={results} />
      )}
      {!hasResults && activePage !== "dashboard" && (
        <div style={{ padding: "48px 28px", textAlign: "center", color: C.textMuted, fontSize: 13 }}>
          Run a search first to see this analysis.
        </div>
      )}

      {/* Footer */}
      <div style={{
        borderTop: `1px solid ${C.border}`, marginTop: 48,
        padding: "18px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 10,
        fontSize: 11, color: C.textMuted,
        background: C.bgDark,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span>
            Created by{" "}
            <a href="https://github.com/teowaits" target="_blank" rel="noreferrer"
              style={{ color: C.blueLight, textDecoration: "none", fontWeight: 600 }}
              onMouseEnter={e => e.currentTarget.style.textDecoration = "underline"}
              onMouseLeave={e => e.currentTarget.style.textDecoration = "none"}
            >teowaits</a>
          </span>
          <span style={{ color: C.border2 }}>·</span>
          <span>
            Data from{" "}
            <a href="https://openalex.org" target="_blank" rel="noreferrer"
              style={{ color: C.textSecondary, textDecoration: "none" }}
              onMouseEnter={e => e.currentTarget.style.color = C.textPrimary}
              onMouseLeave={e => e.currentTarget.style.color = C.textSecondary}
            >OpenAlex API</a>
            {" "}— open scholarly metadata under{" "}
            <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer"
              style={{ color: C.textSecondary, textDecoration: "none" }}
              onMouseEnter={e => e.currentTarget.style.color = C.textPrimary}
              onMouseLeave={e => e.currentTarget.style.color = C.textSecondary}
            >CC0</a>
          </span>
        </div>
        <div>
          <a href="https://github.com/teowaits/journal-overlap" target="_blank" rel="noreferrer"
            style={{ color: C.textMuted, textDecoration: "none" }}
            onMouseEnter={e => e.currentTarget.style.color = C.textPrimary}
            onMouseLeave={e => e.currentTarget.style.color = C.textMuted}
          >MIT License</a>
        </div>
      </div>
    </div>
  );
}
