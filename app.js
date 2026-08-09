/* The New York City ledger — charts.
   Vanilla SVG. Series colours come from the validated categorical palette in
   styles.css; slots are assigned to entities in fixed order and never cycled. */

(function () {
  "use strict";

  var SLOT = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

  // Display groups. Each maps one or more published categories onto one slot,
  // so nothing is ever dropped: the residual groups are explicit "all other".
  var OPERATING = [
    ["Education", ["education", "city_university"]],
    ["Social services", ["social_services"]],
    ["Police, fire, courts and jails", ["public_safety"]],
    ["Pensions and employee benefits", ["pensions", "fringe_benefits"]],
    ["Health and hospitals", ["health"]],
    ["Sanitation, water and sewers", ["environmental"]],
    ["Debt service", ["debt_service"]],
    ["All other city services", ["general_government", "housing",
      "transportation", "parks", "libraries", "judgments", "lease_payments",
      "other_misc"]]
  ];

  var CAPITAL = [
    ["Schools and colleges", ["education"]],
    ["Sanitation, water and sewers", ["environmental"]],
    ["Streets, bridges and transit", ["transportation"]],
    ["Housing and buildings", ["housing"]],
    ["General government", ["general_government"]],
    ["Police, fire, courts and jails", ["public_safety"]],
    ["Parks and culture", ["parks"]],
    ["All other capital", ["health", "social_services", "libraries",
      "other_capital"]]
  ];

  var REVENUE = [
    ["Property tax", ["property_tax"]],
    ["Personal income tax", ["personal_income_tax"]],
    ["Business income taxes", ["business_taxes"]],
    ["Sales tax", ["sales_tax"]],
    ["Other taxes", ["other_taxes", "tax_penalties"]],
    ["State aid", ["state_aid"]],
    ["Federal aid", ["federal_aid"]],
    ["All other revenue", ["charges_for_services", "fines_forfeitures",
      "licenses_permits", "investment_income", "tobacco_settlement",
      "other_revenues", "other_grants", "unrestricted_aid", "disallowances",
      "other_financing"]]
  ];

  var TOTALS = [
    ["Day-to-day operations", "operating"],
    ["Debt service", "debt"],
    ["Capital construction", "capital"]
  ];

  var state = { perCapita: false, real: true, mode: "operating" };
  var chartUid = 0;
  var DATA = null, tip = document.getElementById("tooltip");

  /* ---------- helpers ---------- */

  function css(v) {
    return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  }
  function scale(row, thousands) {
    // Stored in $ thousands. Returns dollars, adjusted per the toggles.
    var v = thousands * 1000;
    if (state.real) v *= row.deflator;
    if (state.perCapita) v /= row.population;
    return v;
  }
  function fmt(v) {
    if (state.perCapita) {
      return "$" + Math.round(v).toLocaleString("en-US");
    }
    if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    if (Math.abs(v) >= 1e6) return "$" + Math.round(v / 1e6).toLocaleString("en-US") + "M";
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  function fmtAxis(v, step) {
    if (v === 0) return "$0";
    if (state.perCapita) return "$" + Math.round(v).toLocaleString("en-US");
    // Decimals follow the tick step, so an axis never mixes $0.0B with $100B.
    var dec = step && step >= 1e9 ? 0 : 1;
    return "$" + (v / 1e9).toFixed(dec) + "B";
  }
  function el(tag, attrs, kids) {
    var n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) {
      n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  function niceTicks(max, count) {
    if (!(max > 0)) return [0, 1];
    var raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag, step;
    step = norm >= 5 ? 10 * mag : norm >= 2 ? 5 * mag : norm >= 1 ? 2 * mag : mag;
    // The last tick must sit at or above the data maximum, or the top of the
    // stack renders outside the plot area.
    var out = [], v = 0;
    while (v < max - step * 1e-9) { out.push(v); v += step; }
    out.push(v);
    return out;
  }

  /* ---------- data shaping ---------- */

  function groupsFor(kind) {
    return kind === "operating" ? OPERATING : kind === "capital" ? CAPITAL : REVENUE;
  }

  function seriesFor(kind) {
    // Returns {years:[], names:[], values:[[perYear] per series], budget:bool[]}
    var groups = groupsFor(kind), rows = DATA.years;
    var out = {
      years: rows.map(function (r) { return r.fy; }),
      names: groups.map(function (g) { return g[0]; }),
      budget: rows.map(function () { return false; }),
      values: groups.map(function () { return []; })
    };
    rows.forEach(function (r) {
      var bucket = kind === "revenue" ? r.revenue
        : kind === "capital" ? r.capital : r.operating;
      groups.forEach(function (g, gi) {
        var sum = 0;
        g[1].forEach(function (key) {
          if (key === "debt_service") sum += r.debt_service;
          else if (bucket[key] !== undefined) sum += bucket[key];
        });
        out.values[gi].push(scale(r, sum));
      });
    });
    return out;
  }

  function totalsSeries() {
    var rows = DATA.years.slice(), out = {
      years: [], names: TOTALS.map(function (t) { return t[0]; }),
      budget: [], values: [[], [], []]
    };
    rows.forEach(function (r) {
      out.years.push(r.fy); out.budget.push(false);
      out.values[0].push(scale(r, r.operating_total));
      out.values[1].push(scale(r, r.debt_service));
      out.values[2].push(scale(r, r.capital_total));
    });
    // The budget documents cover the expense budget only: operations plus debt
    // service, with no capital. Those bars are therefore shorter by
    // construction than the audited bars beside them, and both the note under
    // the chart and the tooltip say so.
    out.note = "Budget figures cover the expense budget only. Capital is not " +
      "included, so these bars are not comparable with the audited years.";
    (DATA.budget_years || []).forEach(function (b) {
      // OMB reports the budget in dollars, not thousands.
      var row = { deflator: DATA.years[DATA.years.length - 1].deflator,
                  population: b.population };
      var f = function (dollars) {
        var v = dollars;
        if (state.real) v *= row.deflator;
        if (state.perCapita) v /= row.population;
        return v;
      };
      out.years.push(b.fy); out.budget.push(true);
      out.values[0].push(f(b.total_expense - b.debt_service));
      out.values[1].push(f(b.debt_service));
      out.values[2].push(0);
    });
    return out;
  }

  /* ---------- stacked bar chart ---------- */

  function stacked(mount, legendMount, s, opts) {
    opts = opts || {};
    mount.textContent = "";
    var W = 1060, H = opts.height || 420;
    var m = { t: 16, r: 16, b: 34, l: 62 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var n = s.years.length;
    var totals = s.years.map(function (_, i) {
      return s.values.reduce(function (a, v) { return a + Math.max(0, v[i]); }, 0);
    });
    var max = Math.max.apply(null, totals) * 1.04;
    var ticks = niceTicks(max, 5);
    max = ticks[ticks.length - 1];
    var tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : max;

    var band = iw / n, bw = Math.max(6, band - Math.max(2, band * 0.22));
    var y = function (v) { return m.t + ih - (v / max) * ih; };

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H,
      role: "img", "aria-label": opts.aria || "" });

    // One hatch pattern per series: pattern content does not inherit
    // currentColor from the element that references it, so the colour has to
    // be baked into each pattern or every budget bar comes out grey.
    var defs = el("defs");
    var uid = "h" + (chartUid++);
    s.values.forEach(function (_v, si) {
      var col = css(SLOT[si % SLOT.length]);
      var p = el("pattern", { id: uid + "-" + si, width: 6, height: 6,
        patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
      p.appendChild(el("rect", { width: 6, height: 6, fill: css("--surface-1") }));
      p.appendChild(el("rect", { width: 2.6, height: 6, fill: col }));
      defs.appendChild(p);
    });
    svg.appendChild(defs);

    ticks.forEach(function (t) {
      svg.appendChild(el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t),
        class: t === 0 ? "ax-line" : "ax-grid" }));
      var lab = el("text", { x: m.l - 9, y: y(t) + 4, "text-anchor": "end",
        class: "ax-text tab" });
      lab.textContent = fmtAxis(t, tickStep);
      svg.appendChild(lab);
    });

    // bars
    s.years.forEach(function (fy, i) {
      var x = m.l + i * band + (band - bw) / 2, acc = 0;
      var topIndex = -1;
      for (var k = s.values.length - 1; k >= 0; k--) {
        if (s.values[k][i] > 0) { topIndex = k; break; }
      }
      s.values.forEach(function (vals, si) {
        var v = Math.max(0, vals[i]);
        if (v <= 0) return;
        var y0 = y(acc), y1 = y(acc + v);
        var h = Math.max(0.5, y0 - y1 - 2);   // 2px surface gap between fills
        var col = css(SLOT[si % SLOT.length]);
        var isTop = si === topIndex;
        var attrs = { x: x, y: y1, width: bw, height: h, fill: col };
        if (isTop) { attrs.rx = 3; attrs.ry = 3; }
        if (s.budget[i]) {
          svg.appendChild(el("rect", { x: x, y: y1, width: bw, height: h,
            fill: "url(#" + uid + "-" + si + ")",
            rx: isTop ? 3 : null, ry: isTop ? 3 : null }));
          svg.appendChild(el("rect", { x: x, y: y1, width: bw, height: h,
            fill: "none", stroke: col, "stroke-width": 1,
            rx: isTop ? 3 : null, ry: isTop ? 3 : null }));
        } else {
          svg.appendChild(el("rect", attrs));
        }
        acc += v;
      });
    });

    // Divider between audited actuals and budget figures
    var firstBudget = s.budget.indexOf(true);
    if (firstBudget > 0) {
      var bx = m.l + firstBudget * band;
      svg.appendChild(el("line", { x1: bx, x2: bx, y1: m.t, y2: m.t + ih,
        stroke: css("--ink"), "stroke-width": 1, "stroke-dasharray": "2 3",
        opacity: 0.45 }));
      var bl = el("text", { x: bx + 5, y: m.t + 11, class: "ax-text" });
      bl.textContent = "budgeted";
      svg.appendChild(bl);
    }

    // x labels — every other year, plus the last
    s.years.forEach(function (fy, i) {
      var show = (fy % 4 === 0) || i === n - 1;
      if (!show) return;
      var t = el("text", { x: m.l + i * band + band / 2, y: H - 12,
        "text-anchor": "middle", class: "ax-text tab" });
      t.textContent = "'" + String(fy).slice(2);
      svg.appendChild(t);
    });
    var fyl = el("text", { x: m.l, y: H - 12, "text-anchor": "start",
      class: "ax-text" });
    fyl.textContent = "FY";
    if (n > 0) { fyl.setAttribute("x", 4); svg.appendChild(fyl); }

    // hover layer
    var cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih,
      x1: 0, x2: 0, opacity: 0 });
    svg.appendChild(cross);
    s.years.forEach(function (fy, i) {
      var hit = el("rect", { x: m.l + i * band, y: m.t, width: band, height: ih,
        fill: "transparent" });
      hit.addEventListener("pointerenter", function (ev) {
        cross.setAttribute("x1", m.l + i * band + band / 2);
        cross.setAttribute("x2", m.l + i * band + band / 2);
        cross.setAttribute("opacity", 0.5);
        showTip(ev, fy, s, i, totals[i]);
      });
      hit.addEventListener("pointermove", function (ev) { moveTip(ev); });
      hit.addEventListener("pointerleave", function () {
        cross.setAttribute("opacity", 0); tip.hidden = true;
      });
      svg.appendChild(hit);
    });

    mount.appendChild(svg);
    if (legendMount) drawLegend(legendMount, s.names);
  }

  /* ---------- line chart ---------- */

  function lines(mount, legendMount, s, opts) {
    mount.textContent = "";
    var W = 1060, H = (opts && opts.height) || 360;
    var m = { t: 16, r: 205, b: 34, l: 62 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = s.years.length;
    var max = 0;
    s.values.forEach(function (v) {
      v.forEach(function (x) { if (x > max) max = x; });
    });
    var ticks = niceTicks(max * 1.06, 5);
    max = ticks[ticks.length - 1];
    var tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : max;
    var x = function (i) { return m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); };
    var y = function (v) { return m.t + ih - (v / max) * ih; };

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": (opts && opts.aria) || "" });

    ticks.forEach(function (t) {
      svg.appendChild(el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t),
        class: t === 0 ? "ax-line" : "ax-grid" }));
      var lab = el("text", { x: m.l - 9, y: y(t) + 4, "text-anchor": "end",
        class: "ax-text tab" });
      lab.textContent = fmtAxis(t, tickStep);
      svg.appendChild(lab);
    });

    s.values.forEach(function (vals, si) {
      var d = vals.map(function (v, i) {
        return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
      }).join(" ");
      svg.appendChild(el("path", { d: d, fill: "none",
        stroke: css(SLOT[si % SLOT.length]), "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });

    // Direct labels at the right edge, nudged apart where lines end close
    // together so they never overlap.
    var ends = s.values.map(function (vals, si) {
      return { si: si, y: y(vals[vals.length - 1]) };
    }).sort(function (a, b) { return a.y - b.y; });
    var minGap = 15;
    ends.forEach(function (e, k) {
      if (k && e.y - ends[k - 1].y < minGap) e.y = ends[k - 1].y + minGap;
    });
    ends.forEach(function (e) {
      var t = el("text", { x: m.l + iw + 10, y: e.y + 4, class: "mark-label",
        "font-size": 11 });
      t.setAttribute("fill", css(SLOT[e.si % SLOT.length]));
      t.textContent = s.names[e.si];
      svg.appendChild(t);
    });

    s.years.forEach(function (fy, i) {
      if (fy % 4 !== 0 && i !== n - 1) return;
      var t = el("text", { x: x(i), y: H - 12, "text-anchor": "middle",
        class: "ax-text tab" });
      t.textContent = "'" + String(fy).slice(2);
      svg.appendChild(t);
    });

    var cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih,
      x1: 0, x2: 0, opacity: 0 });
    svg.appendChild(cross);
    var dots = s.values.map(function (_, si) {
      var c = el("circle", { r: 5, fill: css(SLOT[si % SLOT.length]),
        stroke: css("--surface-1"), "stroke-width": 2, opacity: 0 });
      svg.appendChild(c); return c;
    });
    var band = iw / Math.max(1, n - 1);
    s.years.forEach(function (fy, i) {
      var hit = el("rect", { x: x(i) - band / 2, y: m.t, width: band, height: ih,
        fill: "transparent" });
      hit.addEventListener("pointerenter", function (ev) {
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
        cross.setAttribute("opacity", 0.5);
        dots.forEach(function (c, si) {
          c.setAttribute("cx", x(i)); c.setAttribute("cy", y(s.values[si][i]));
          c.setAttribute("opacity", 1);
        });
        showTip(ev, fy, s, i, null);
      });
      hit.addEventListener("pointermove", moveTip);
      hit.addEventListener("pointerleave", function () {
        cross.setAttribute("opacity", 0);
        dots.forEach(function (c) { c.setAttribute("opacity", 0); });
        tip.hidden = true;
      });
      svg.appendChild(hit);
    });

    mount.appendChild(svg);
    if (legendMount) drawLegend(legendMount, s.names);
  }

  /* ---------- shared chrome ---------- */

  function drawLegend(mount, names) {
    mount.textContent = "";
    names.forEach(function (nm, i) {
      var d = document.createElement("span");
      d.className = "legend-item";
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = css(SLOT[i % SLOT.length]);
      d.appendChild(sw);
      d.appendChild(document.createTextNode(nm));
      mount.appendChild(d);
    });
  }

  function showTip(ev, fy, s, i, total) {
    var html = '<div class="tt-head"><span>Fiscal ' + fy + '</span>' +
      (s.budget[i] ? "<span>budgeted</span>" : "") + "</div>";
    for (var k = s.values.length - 1; k >= 0; k--) {
      var v = s.values[k][i];
      if (!v) continue;
      html += '<div class="tt-row"><span class="swatch" style="background:' +
        css(SLOT[k % SLOT.length]) + '"></span><span class="tt-name">' +
        s.names[k] + '</span><span class="tt-val">' + fmt(v) + "</span></div>";
    }
    if (total) {
      html += '<div class="tt-row tt-total"><span class="tt-name">Total</span>' +
        '<span class="tt-val">' + fmt(total) + "</span></div>";
    }
    if (s.budget[i] && s.note) {
      html += '<div class="tt-note">' + s.note + "</div>";
    }
    tip.innerHTML = html;
    tip.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = ev.clientX + pad, yy = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (yy + h > window.innerHeight - 8) yy = ev.clientY - h - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, yy) + "px";
  }

  function drawTable(mount, s) {
    var h = "<table><thead><tr><th>Fiscal year</th>";
    s.names.forEach(function (nm) { h += "<th>" + nm + "</th>"; });
    h += "<th>Total</th></tr></thead><tbody>";
    s.years.forEach(function (fy, i) {
      var tot = 0;
      h += "<tr><td>" + fy + (s.budget[i] ? " (budgeted)" : "") + "</td>";
      s.values.forEach(function (vals) {
        tot += vals[i];
        h += "<td>" + fmt(vals[i]) + "</td>";
      });
      h += "<td>" + fmt(tot) + "</td></tr>";
    });
    mount.innerHTML = h + "</tbody></table>";
  }

  /* ---------- headline stats ---------- */

  function heroStats() {
    var rows = DATA.years, first = rows[0], last = rows[rows.length - 1];
    var box = document.getElementById("heroStats");
    var tot = function (r) {
      return scale(r, r.operating_total + r.debt_service + r.capital_total);
    };
    var a = tot(first), b = tot(last);
    var pop0 = first.population, pop1 = last.population;
    var items = [
      ["Total spending, FY2025",
       fmt(b),
       state.perCapita ? "per New Yorker" : "operations, debt and capital"],
      ["Change since FY2000",
       (b >= a ? "+" : "") + Math.round((b / a - 1) * 100) + "%",
       state.real ? "after inflation" : "not adjusted for inflation"],
      ["Population, 2025",
       (pop1 / 1e6).toFixed(2) + "M",
       (pop1 >= pop0 ? "+" : "") + Math.round((pop1 / pop0 - 1) * 100) +
         "% since 2000"],
      ["FY2027 expense budget",
       (function () {
         var by = (DATA.budget_years || [])[1];
         if (!by) return "n/a";
         var v = by.total_expense;
         if (state.real) v *= last.deflator;
         if (state.perCapita) v /= by.population;
         return fmt(v);
       })(),
       "adopted; excludes capital"]
    ];
    box.innerHTML = items.map(function (it) {
      return '<div class="stat"><p class="stat-label">' + it[0] +
        '</p><p class="stat-value">' + it[1] +
        '</p><p class="stat-sub">' + it[2] + "</p></div>";
    }).join("");
  }

  /* ---------- render ---------- */

  var cache = {};

  function render() {
    var lastRow = DATA.years[DATA.years.length - 1];
    document.getElementById("basisNote").textContent =
      (state.real ? "In fiscal " + DATA.meta.dollar_base_fy + " dollars" :
        "In each year's own dollars") +
      (state.perCapita ? " · per resident" : "");

    heroStats();

    cache.c1 = totalsSeries();
    stacked(document.getElementById("c1"), document.getElementById("c1Legend"),
      cache.c1, { aria: "Total New York City spending by fiscal year" });
    document.getElementById("c1Title").textContent =
      (state.perCapita ? "Total spending per resident" : "Total spending") +
      ", fiscal 2000 to 2027";

    cache.c2 = seriesFor(state.mode);
    stacked(document.getElementById("c2"), document.getElementById("c2Legend"),
      cache.c2, { aria: "Spending by category" });
    document.getElementById("c2Title").textContent =
      (state.mode === "operating" ? "Operating spending" : "Capital spending") +
      " by category" + (state.perCapita ? ", per resident" : "");
    document.getElementById("c2Note").textContent = state.mode === "operating"
      ? "Operating spending is the General Fund plus its transfers for debt service. Fiscal years 2026 and 2027 are omitted here because the budget documents do not break spending down on this basis."
      : "Capital spending is the Capital Projects Fund. City University capital runs through the education line. Fiscal years 2026 and 2027 are omitted here because the budget documents do not break spending down on this basis.";

    cache.c3 = (function () {
      var rows = DATA.years;
      return {
        years: rows.map(function (r) { return r.fy; }),
        names: ["New bonds issued", "Capital spending",
                "Federal and state capital aid"],
        budget: rows.map(function () { return false; }),
        values: [
          rows.map(function (r) {
            return scale(r, r.borrowing.bonds_issued + r.borrowing.bond_premium);
          }),
          rows.map(function (r) { return scale(r, r.capital_total); }),
          rows.map(function (r) { return scale(r, r.capital_aid); })
        ]
      };
    })();
    lines(document.getElementById("c3"), document.getElementById("c3Legend"),
      cache.c3, { aria: "Borrowing against capital spending" });
    document.getElementById("c3Title").textContent =
      "Borrowing and building" + (state.perCapita ? ", per resident" : "");

    cache.c4 = seriesFor("revenue");
    stacked(document.getElementById("c4"), document.getElementById("c4Legend"),
      cache.c4, { aria: "Revenue by source" });
    document.getElementById("c4Title").textContent =
      "Revenue by source" + (state.perCapita ? ", per resident" : "") +
      ", fiscal 2000 to 2025";

    // refresh any open tables
    ["c1", "c2", "c3", "c4"].forEach(function (id) {
      var t = document.getElementById(id + "Table");
      if (t && !t.hidden) drawTable(t, cache[id]);
    });
  }

  /* ---------- wiring ---------- */

  function bindSegs() {
    document.querySelectorAll("[data-percap]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.perCapita = b.dataset.percap === "1";
        setOn(b, "[data-percap]"); render();
      });
    });
    document.querySelectorAll("[data-real]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.real = b.dataset.real === "1";
        setOn(b, "[data-real]"); render();
      });
    });
    document.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.mode = b.dataset.mode;
        setOn(b, "[data-mode]"); render();
      });
    });
    document.querySelectorAll("[data-table]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.table, t = document.getElementById(id + "Table");
        t.hidden = !t.hidden;
        b.classList.toggle("is-on", !t.hidden);
        b.textContent = t.hidden ? "Table" : "Hide table";
        if (!t.hidden) drawTable(t, cache[id]);
      });
    });
  }
  function setOn(btn, sel) {
    document.querySelectorAll(sel).forEach(function (o) {
      o.classList.toggle("is-on", o === btn);
    });
  }

  fetch("data.json")
    .then(function (r) {
      if (!r.ok) throw new Error("data.json " + r.status);
      return r.json();
    })
    .then(function (d) {
      DATA = d;
      bindSegs();
      render();
      var t;
      window.addEventListener("resize", function () {
        clearTimeout(t); t = setTimeout(render, 150);
      });
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", render);
    })
    .catch(function (e) {
      document.getElementById("heroStats").innerHTML =
        '<div class="stat"><p class="stat-label">Error</p><p class="stat-sub">' +
        "Could not load the data file: " + e.message + "</p></div>";
    });
})();
