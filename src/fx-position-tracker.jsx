import { useState, useEffect, useMemo } from "react";

// ---------- FIFO engine ----------
// Trade: { id, date, pair, side: 'BUY'|'SELL', qty (base ccy units), rate }
// BUY = long base (buy USD, sell quote). Signed qty: BUY +, SELL -.
// Realized P&L computed in quote ccy, converted to USD at the closing rate
// (valid for USD-base pairs like USD.SEK; for X.USD pairs quote IS USD).

function computePair(trades, pair, spot) {
  const sorted = [...trades]
    .filter((t) => t.pair === pair)
    .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1));

  const lots = []; // open lots: { qty signed, rate, date }
  const realized = []; // closed lots

  for (const t of sorted) {
    let q = t.side === "BUY" ? t.qty : -t.qty;
    // close against opposite-sign lots, FIFO
    while (Math.abs(q) > 1e-9 && lots.length && Math.sign(lots[0].qty) !== Math.sign(q)) {
      const lot = lots[0];
      const closeQty = Math.min(Math.abs(q), Math.abs(lot.qty));
      const dir = Math.sign(lot.qty); // +1 closing a long, -1 closing a short
      const pnlQuote = closeQty * (t.rate - lot.rate) * dir;
      const pnlUSD = quoteToUSD(pnlQuote, pair, t.rate);
      realized.push({
        pair,
        openDate: lot.date,
        closeDate: t.date,
        qty: closeQty * dir,
        openRate: lot.rate,
        closeRate: t.rate,
        pnlQuote,
        pnlUSD,
      });
      lot.qty -= closeQty * dir;
      q += closeQty * dir;
      if (Math.abs(lot.qty) < 1e-9) lots.shift();
    }
    if (Math.abs(q) > 1e-9) lots.push({ qty: q, rate: t.rate, date: t.date });
  }

  const netQty = lots.reduce((s, l) => s + l.qty, 0);
  const avgCost =
    Math.abs(netQty) > 1e-9
      ? lots.reduce((s, l) => s + l.qty * l.rate, 0) / netQty
      : null;

  let unrealQuote = null;
  let unrealUSD = null;
  if (avgCost !== null && spot > 0) {
    unrealQuote = netQty * (spot - avgCost);
    unrealUSD = quoteToUSD(unrealQuote, pair, spot);
  }

  const realizedQuote = realized.reduce((s, r) => s + r.pnlQuote, 0);
  const realizedUSD = realized.reduce((s, r) => s + (r.pnlUSD ?? 0), 0);

  // Net cash in the quote currency: the other leg of the position, signed.
  // BUY base pays quote (−), SELL base receives quote (+). This is the actual
  // broker balance for the quote ccy (realized quote P&L stays parked here,
  // offsetting the short), unlike the open lots which carry at original cost.
  const netQuoteCash = sorted.reduce((s, t) => s + (t.side === "SELL" ? 1 : -1) * t.qty * t.rate, 0);

  return { netQty, avgCost, unrealQuote, unrealUSD, realizedQuote, realizedUSD, netQuoteCash, realized, tradeCount: sorted.length };
}

function quoteCcy(pair) {
  const parts = pair.split(".");
  return parts.length === 2 ? parts[1] : "?";
}
function baseCcy(pair) {
  return pair.split(".")[0] || "?";
}
function quoteToUSD(amtQuote, pair, rate) {
  if (quoteCcy(pair) === "USD") return amtQuote;
  if (baseCcy(pair) === "USD" && rate > 0) return amtQuote / rate;
  return null; // cross pair, no USD leg — shown in quote ccy only
}

// ---------- formatting ----------
const fmt = (n, d = 0) =>
  n === null || n === undefined || isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSigned = (n, d = 0) => (n === null || n === undefined || isNaN(n) ? "—" : (n > 0 ? "+" : "") + fmt(n, d));

const C = {
  bg: "#0B0E13",
  panel: "#10141B",
  panelUp: "#151A23",
  border: "#1E2530",
  text: "#C9D1D9",
  dim: "#6B7480",
  faint: "#3D4450",
  green: "#4ADE80",
  red: "#F87171",
  amber: "#E5B45B",
};

const pnlColor = (n) => (n === null || n === undefined || isNaN(n) ? C.dim : n >= 0 ? C.green : C.red);

// ---------- component ----------
export default function FXPositionTracker() {
  const [trades, setTrades] = useState([]);
  const [spots, setSpots] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMsg, setImportMsg] = useState("");
  const [form, setForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    pair: "USD.SEK",
    side: "BUY",
    qty: "",
    rate: "",
  });

  // load
  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("fx-tracker-v1");
        if (res && res.value) {
          const data = JSON.parse(res.value);
          setTrades(data.trades || []);
          setSpots(data.spots || {});
        }
      } catch (e) {
        // key missing or storage unavailable — start fresh
        if (!window.storage) setStorageOk(false);
      }
      setLoaded(true);
    })();
  }, []);

  // save
  useEffect(() => {
    if (!loaded) return;
    (async () => {
      try {
        await window.storage.set("fx-tracker-v1", JSON.stringify({ trades, spots }));
      } catch (e) {
        setStorageOk(false);
      }
    })();
  }, [trades, spots, loaded]);

  const pairs = useMemo(() => {
    const set = new Set(trades.map((t) => t.pair));
    return [...set].sort();
  }, [trades]);

  const results = useMemo(() => {
    const out = {};
    for (const p of pairs) out[p] = computePair(trades, p, parseFloat(spots[p]) || 0);
    return out;
  }, [trades, pairs, spots]);

  const totals = useMemo(() => {
    let realized = 0, unreal = 0, unrealKnown = true;
    for (const p of pairs) {
      realized += results[p].realizedUSD ?? 0;
      if (results[p].avgCost !== null) {
        if (results[p].unrealUSD === null || isNaN(results[p].unrealUSD)) unrealKnown = false;
        else unreal += results[p].unrealUSD;
      }
    }
    return { realized, unreal, unrealKnown };
  }, [results, pairs]);

  const allRealized = useMemo(
    () => pairs.flatMap((p) => results[p].realized).sort((a, b) => (a.closeDate < b.closeDate ? -1 : 1)),
    [results, pairs]
  );

  // ---------- actions ----------
  const addTrade = () => {
    const qty = parseFloat(String(form.qty).replace(/,/g, ""));
    const rate = parseFloat(form.rate);
    if (!form.date || !form.pair || !qty || qty <= 0 || !rate || rate <= 0) return;
    setTrades((ts) => [
      ...ts,
      { id: Date.now() + Math.random(), seq: ts.length, date: form.date, pair: form.pair.toUpperCase().trim(), side: form.side, qty, rate },
    ]);
    setForm((f) => ({ ...f, qty: "", rate: "" }));
  };

  const deleteTrade = (id) => setTrades((ts) => ts.filter((t) => t.id !== id));

  const runImport = () => {
    const lines = importText.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = [];
    const errors = [];
    lines.forEach((line, i) => {
      const parts = line.split(/[,\t]+|\s{1,}/).map((s) => s.trim()).filter(Boolean);
      if (parts.length < 5) return errors.push(i + 1);
      const [date, pair, side, qtyS, rateS] = parts;
      const qty = parseFloat(qtyS.replace(/,/g, ""));
      const rate = parseFloat(rateS);
      const sideN = side.toUpperCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !pair.includes(".") || !["BUY", "SELL"].includes(sideN) || !qty || !rate) {
        return errors.push(i + 1);
      }
      parsed.push({ date, pair: pair.toUpperCase(), side: sideN, qty, rate });
    });
    if (parsed.length) {
      setTrades((ts) => [
        ...ts,
        ...parsed.map((p, j) => ({ ...p, id: Date.now() + j + Math.random(), seq: ts.length + j })),
      ]);
    }
    setImportMsg(
      `${parsed.length} trade${parsed.length === 1 ? "" : "s"} imported` +
        (errors.length ? ` · skipped line${errors.length === 1 ? "" : "s"} ${errors.join(", ")}` : "")
    );
    if (parsed.length) setImportText("");
  };

  const exportCSV = () => {
    const header = "pair,open_date,close_date,qty_base,open_rate,close_rate,pnl_quote_ccy,pnl_usd";
    const rows = allRealized.map((r) =>
      [r.pair, r.openDate, r.closeDate, r.qty, r.openRate, r.closeRate, r.pnlQuote.toFixed(2), r.pnlUSD === null ? "" : r.pnlUSD.toFixed(2)].join(",")
    );
    const blob = new Blob([header + "\n" + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fx-988-realized-ledger.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportJournal = () => {
    const rows = [...trades]
      .sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date < b.date ? -1 : 1))
      .map((t) => [t.date, t.pair, t.side, t.qty, t.rate].join(", "));
    const blob = new Blob([rows.join("\n") + (rows.length ? "\n" : "")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fx-trade-journal.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const sortedTrades = useMemo(
    () => [...trades].sort((a, b) => (a.date === b.date ? b.seq - a.seq : a.date < b.date ? 1 : -1)),
    [trades]
  );

  const inputStyle = {
    background: C.panelUp,
    border: `1px solid ${C.border}`,
    color: C.text,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    padding: "7px 10px",
    borderRadius: 4,
    outline: "none",
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'JetBrains Mono', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;700&display=swap');
        input:focus, select:focus, textarea:focus { border-color: ${C.amber} !important; }
        button { cursor: pointer; }
        ::placeholder { color: ${C.faint}; }
      `}</style>

      <div style={{ maxWidth: 1060, margin: "0 auto", padding: "32px 24px 64px" }}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `1px solid ${C.border}`, paddingBottom: 18 }}>
          <div>
            <h1 style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, fontSize: 34, margin: 0, color: "#E8EDF2" }}>
              FX Positions
            </h1>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 4, letterSpacing: "0.08em" }}>
              FIFO LOTS · §988 LEDGER · {trades.length} TRADE{trades.length === 1 ? "" : "S"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 36, textAlign: "right" }}>
            <div>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.1em" }}>REALIZED (USD)</div>
              <div style={{ fontSize: 20, color: pnlColor(totals.realized) }}>{fmtSigned(totals.realized, 0)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.1em" }}>UNREALIZED (USD)</div>
              <div style={{ fontSize: 20, color: pnlColor(totals.unreal) }}>
                {totals.unrealKnown ? fmtSigned(totals.unreal, 0) : "set spots"}
              </div>
            </div>
          </div>
        </div>

        {!storageOk && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.amber }}>
            Persistent storage unavailable — data lives in this session only. Export CSV before closing.
          </div>
        )}

        {/* position cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))", gap: 14, marginTop: 22 }}>
          {pairs.length === 0 && (
            <div style={{ gridColumn: "1/-1", border: `1px dashed ${C.border}`, borderRadius: 6, padding: 28, color: C.dim, fontSize: 13 }}>
              No trades yet. Add one below, or paste your journal via Import.
            </div>
          )}
          {pairs.map((p) => {
            const r = results[p];
            const open = r.avgCost !== null;
            const qc = quoteCcy(p);
            return (
              <div key={p} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "16px 18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.04em" }}>{p}</span>
                  <span style={{ fontSize: 10, color: open ? C.amber : C.dim, letterSpacing: "0.1em" }}>
                    {open ? (r.netQty > 0 ? "LONG" : "SHORT") : "FLAT"}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px", marginTop: 14, fontSize: 13 }}>
                  <div>
                    <div style={{ fontSize: 10, color: C.dim }}>POSITION ({baseCcy(p)})</div>
                    <div>{open ? fmt(r.netQty, 0) : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: C.dim }}>BALANCE ({qc})</div>
                    <div>{open ? fmtSigned(r.netQuoteCash, 0) : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: C.dim }}>AVG COST</div>
                    <div>{open ? fmt(r.avgCost, 4) : "—"}</div>
                  </div>
                  <div />
                  <div>
                    <div style={{ fontSize: 10, color: C.dim }}>SPOT</div>
                    <input
                      style={{ ...inputStyle, width: "100%", padding: "4px 8px", marginTop: 2 }}
                      placeholder="0.0000"
                      value={spots[p] ?? ""}
                      onChange={(e) => setSpots((s) => ({ ...s, [p]: e.target.value }))}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: C.dim }}>UNREALIZED</div>
                    <div style={{ color: pnlColor(r.unrealUSD ?? r.unrealQuote) }}>
                      {open
                        ? r.unrealUSD !== null && !isNaN(r.unrealUSD)
                          ? `${fmtSigned(r.unrealUSD, 0)} USD`
                          : r.unrealQuote !== null
                          ? `${fmtSigned(r.unrealQuote, 0)} ${qc}`
                          : "—"
                        : "—"}
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 10, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: C.dim }}>Realized</span>
                  <span style={{ color: pnlColor(r.realizedUSD) }}>
                    {r.realized.length ? `${fmtSigned(r.realizedUSD, 0)} USD` : "—"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* add trade */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 18px", marginTop: 24 }}>
          <div style={{ fontSize: 10, color: C.dim, letterSpacing: "0.1em", marginBottom: 10 }}>ADD TRADE</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input type="date" style={{ ...inputStyle, width: 150 }} value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            <input style={{ ...inputStyle, width: 110 }} placeholder="USD.SEK" value={form.pair} onChange={(e) => setForm((f) => ({ ...f, pair: e.target.value }))} />
            <select style={{ ...inputStyle, width: 90 }} value={form.side} onChange={(e) => setForm((f) => ({ ...f, side: e.target.value }))}>
              <option>BUY</option>
              <option>SELL</option>
            </select>
            <input style={{ ...inputStyle, width: 130 }} placeholder="qty (base)" value={form.qty} onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))} />
            <input style={{ ...inputStyle, width: 110 }} placeholder="rate" value={form.rate} onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))} />
            <button
              onClick={addTrade}
              style={{ ...inputStyle, background: C.amber, color: "#14110A", border: "none", fontWeight: 700, padding: "8px 18px" }}
            >
              Add
            </button>
            <button
              onClick={() => { setShowImport((s) => !s); setImportMsg(""); }}
              style={{ ...inputStyle, background: "transparent", color: C.dim, padding: "8px 14px" }}
            >
              {showImport ? "Close import" : "Import from journal"}
            </button>
          </div>

          {showImport && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>
                One trade per line: <span style={{ color: C.text }}>YYYY-MM-DD, PAIR, BUY|SELL, qty, rate</span> — e.g.{" "}
                <span style={{ color: C.text }}>2026-05-12, USD.SEK, BUY, 50000, 9.4210</span>
              </div>
              <textarea
                style={{ ...inputStyle, width: "100%", minHeight: 110, resize: "vertical", boxSizing: "border-box" }}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
                <button onClick={runImport} style={{ ...inputStyle, background: C.panelUp, color: C.text, padding: "7px 16px" }}>
                  Parse & add
                </button>
                <span style={{ fontSize: 12, color: C.dim }}>{importMsg}</span>
              </div>
            </div>
          )}
        </div>

        {/* ledger */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 32, marginBottom: 10 }}>
          <h2 style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, fontSize: 22, margin: 0, color: "#E8EDF2" }}>
            Trade ledger
          </h2>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button onClick={exportJournal} disabled={!trades.length} style={{ ...inputStyle, background: "transparent", color: trades.length ? C.amber : C.faint, padding: "6px 14px" }}>
              Export journal
            </button>
            <button onClick={exportCSV} disabled={!allRealized.length} style={{ ...inputStyle, background: "transparent", color: allRealized.length ? C.amber : C.faint, padding: "6px 14px" }}>
              Export realized lots (§988 CSV)
            </button>
          </div>
        </div>
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em", textAlign: "right" }}>
                {["DATE", "PAIR", "SIDE", "QTY (BASE)", "RATE", ""].map((h, i) => (
                  <th key={h + i} style={{ padding: "10px 14px", textAlign: i < 3 ? "left" : "right", borderBottom: `1px solid ${C.border}`, fontWeight: 500 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedTrades.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 18, color: C.dim }}>Empty.</td></tr>
              )}
              {sortedTrades.map((t) => (
                <tr key={t.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "8px 14px" }}>{t.date}</td>
                  <td style={{ padding: "8px 14px" }}>{t.pair}</td>
                  <td style={{ padding: "8px 14px", color: t.side === "BUY" ? C.green : C.red }}>{t.side}</td>
                  <td style={{ padding: "8px 14px", textAlign: "right" }}>{fmt(t.qty, 0)}</td>
                  <td style={{ padding: "8px 14px", textAlign: "right" }}>{fmt(t.rate, 4)}</td>
                  <td style={{ padding: "8px 14px", textAlign: "right" }}>
                    <button onClick={() => deleteTrade(t.id)} style={{ background: "none", border: "none", color: C.faint, fontSize: 12 }} title="Delete">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* realized detail */}
        {allRealized.length > 0 && (
          <>
            <h2 style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, fontSize: 22, margin: "32px 0 10px", color: "#E8EDF2" }}>
              Realized lots <span style={{ fontSize: 13, color: C.dim, fontStyle: "normal", fontFamily: "'JetBrains Mono', monospace" }}>(FIFO)</span>
            </h2>
            <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: C.dim, fontSize: 10, letterSpacing: "0.1em" }}>
                    {["PAIR", "OPENED", "CLOSED", "QTY", "OPEN RATE", "CLOSE RATE", "P&L (QUOTE)", "P&L (USD)"].map((h, i) => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: i < 3 ? "left" : "right", borderBottom: `1px solid ${C.border}`, fontWeight: 500 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allRealized.map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: "8px 14px" }}>{r.pair}</td>
                      <td style={{ padding: "8px 14px" }}>{r.openDate}</td>
                      <td style={{ padding: "8px 14px" }}>{r.closeDate}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right" }}>{fmt(r.qty, 0)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right" }}>{fmt(r.openRate, 4)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right" }}>{fmt(r.closeRate, 4)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right", color: pnlColor(r.pnlQuote) }}>{fmtSigned(r.pnlQuote, 0)}</td>
                      <td style={{ padding: "8px 14px", textAlign: "right", color: pnlColor(r.pnlUSD) }}>
                        {r.pnlUSD === null ? "—" : fmtSigned(r.pnlUSD, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div style={{ marginTop: 26, fontSize: 11, color: C.faint, lineHeight: 1.7 }}>
          Quantities are base-currency notional (e.g. USD for USD.SEK). BUY = long base / short quote. Realized P&L is computed
          per FIFO lot in the quote currency and converted to USD at the closing rate. Interest accruals are not positions and
          are intentionally excluded — track those from the IBKR statement of funds.
        </div>
      </div>
    </div>
  );
}
