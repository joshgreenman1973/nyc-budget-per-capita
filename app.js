/* The New York City ledger — charts.
   Vanilla SVG. Series colours come from the validated categorical palette in
   styles.css. Every series carries an explicit palette slot, so filtering the
   chart never repaints the categories that survive. */

(function () {
  "use strict";

  var SLOT = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--s8"];

  // Display groups. Each maps one or more published lines onto one palette
  // slot, so nothing is dropped: the residual groups are an explicit
  // "all other" and every underlying line is named in the downloadable data.
  var OPERATING = [
    ["Education", ["education", "city_university"]],
    ["Social services", ["social_services"]],
    ["Police, fire, courts and jails", ["public_safety"]],
    ["Pension contributions", ["pensions"]],
    ["Health insurance and other benefits", ["fringe_benefits"]],
    ["Debt service", ["debt_service"]],
    ["Health and hospitals", ["health"]],
    ["All other city services", ["general_government", "environmental",
      "housing", "transportation", "parks", "libraries", "judgments",
      "lease_payments", "other_misc"]]
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

  var state = {
    perCapita: false, real: true, mode: "operating",
    share: { c2: false, c4: false },
    sel: { operating: [], capital: [], revenue: [] }
  };
  var chartUid = 0;
  var DATA = null, cache = {}, tip = document.getElementById("tooltip");

  /* ---------- helpers ---------- */

  function css(v) {
    return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  }
  function scale(row, thousands) {
    var v = thousands * 1000;
    if (state.real) v *= row.deflator;
    if (state.perCapita) v /= row.population;
    return v;
  }
  function fmt(v, unit) {
    if (unit === "pct") return (Math.round(v * 10) / 10).toFixed(1) + "%";
    if (state.perCapita) return "$" + Math.round(v).toLocaleString("en-US");
    if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    if (Math.abs(v) >= 1e6) return "$" + Math.round(v / 1e6).toLocaleString("en-US") + "M";
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  function fmtAxis(v, step, unit) {
    if (unit === "pct") return (step && step < 1 ? v.toFixed(1) : Math.round(v)) + "%";
    if (v === 0) return "$0";
    if (state.perCapita) return "$" + Math.round(v).toLocaleString("en-US");
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
  function colorOf(s, i) {
    return css(SLOT[(s.slots ? s.slots[i] : i) % SLOT.length]);
  }

  /* ---------- data shaping ---------- */

  function groupsFor(kind) {
    return kind === "operating" ? OPERATING : kind === "capital" ? CAPITAL : REVENUE;
  }

  function seriesFor(kind, share) {
    var groups = groupsFor(kind), rows = DATA.years;
    var out = {
      years: rows.map(function (r) { return r.fy; }),
      names: groups.map(function (g) { return g[0]; }),
      slots: groups.map(function (_g, i) { return i; }),
      budget: rows.map(function () { return false; }),
      values: groups.map(function () { return []; }),
      unit: share ? "pct" : "usd"
    };
    rows.forEach(function (r) {
      var bucket = kind === "revenue" ? r.revenue
        : kind === "capital" ? r.capital : r.operating;
      var raw = groups.map(function (g) {
        var sum = 0;
        g[1].forEach(function (key) {
          if (key === "debt_service") sum += r.debt_service;
          else if (bucket[key] !== undefined) sum += bucket[key];
        });
        return sum;
      });
      var total = raw.reduce(function (a, b) { return a + b; }, 0);
      raw.forEach(function (v, gi) {
        out.values[gi].push(share ? (total ? (v / total) * 100 : 0) : scale(r, v));
      });
    });
    out.blabels = out.years.map(function () { return null; });

    // The adopted-budget document details FY2026 and FY2027 by agency, and the
    // Comptroller's schedule says which function each agency code belongs to,
    // so the operating chart can carry the two unaudited years. The budget
    // basis nets out intra-city purchases and pools citywide costs (fringe
    // benefits, transit subsidies, judgments, reserves) in the Miscellaneous
    // budget, so the hatched bars are close but not line-for-line comparable.
    if (kind === "operating") {
      var lastDef = DATA.years[DATA.years.length - 1].deflator;
      out.note = "Unaudited, on the budget basis: intra-city purchases are " +
        "netted out, and citywide costs such as transit subsidies, judgments " +
        "and reserves sit in the benefits band.";
      (DATA.budget_years || []).forEach(function (b) {
        if (!b.categories) return;
        var pseudo = { deflator: lastDef, population: b.population };
        var raw = groups.map(function (g) {
          var sum = 0;
          g[1].forEach(function (key) {
            if (b.categories[key] !== undefined) sum += b.categories[key];
          });
          return sum;
        });
        var total = raw.reduce(function (a, x) { return a + x; }, 0);
        out.years.push(b.fy);
        out.budget.push(true);
        out.blabels.push(/as modified/i.test(b.basis) ? "unaudited estimate"
                                                      : "adopted budget");
        raw.forEach(function (v, gi) {
          out.values[gi].push(share ? (total ? (v / total) * 100 : 0)
                                    : scale(pseudo, v));
        });
      });
    }
    return out;
  }

  /** Keep only the chosen categories, preserving each one's palette slot. */
  function subset(s, picked) {
    if (!picked.length) return s;
    var keep = [];
    s.names.forEach(function (n, i) { if (picked.indexOf(n) >= 0) keep.push(i); });
    return {
      years: s.years, budget: s.budget, unit: s.unit, note: s.note,
      blabels: s.blabels,
      names: keep.map(function (i) { return s.names[i]; }),
      slots: keep.map(function (i) { return s.slots[i]; }),
      values: keep.map(function (i) { return s.values[i]; })
    };
  }

  function totalsSeries() {
    var rows = DATA.years, out = {
      years: [], names: ["Day-to-day operations", "Debt service",
                         "Capital construction"],
      slots: [0, 1, 2], budget: [], values: [[], [], []], unit: "usd"
    };
    rows.forEach(function (r) {
      out.years.push(r.fy); out.budget.push(false);
      out.values[0].push(scale(r, r.operating_total));
      out.values[1].push(scale(r, r.debt_service));
      out.values[2].push(scale(r, r.capital_total));
    });
    // The budget documents cover the expense budget only: operations plus debt
    // service, with no capital. Those bars are shorter by construction.
    out.note = "Budget figures cover the expense budget only. Capital is not " +
      "included, so these bars are not comparable with the audited years.";
    out.blabels = out.years.map(function () { return null; });
    (DATA.budget_years || []).forEach(function (b) {
      var def = DATA.years[DATA.years.length - 1].deflator;
      var f = function (dollars) {
        var v = dollars;
        if (state.real) v *= def;
        if (state.perCapita) v /= b.population;
        return v;
      };
      out.years.push(b.fy); out.budget.push(true);
      // A closed-but-unaudited year is not the same thing as a plan: FY2026
      // ended before the audit, so its figure is the city's own year-end
      // estimate; FY2027 is the adopted budget for the year under way.
      out.blabels.push(/as modified/i.test(b.basis) ? "unaudited estimate"
                                                    : "adopted budget");
      out.values[0].push(f(b.total_expense - b.debt_service));
      out.values[1].push(f(b.debt_service));
      out.values[2].push(0);
    });
    return out;
  }

  /** Spending as a share of measured city GDP. Both sides are current dollars. */
  function gdpSeries() {
    var rows = DATA.years.filter(function (r) { return r.gdp; });
    var out = {
      years: rows.map(function (r) { return r.fy; }),
      names: ["Day-to-day operations", "Debt service", "Capital construction"],
      slots: [0, 1, 2], budget: rows.map(function () { return false; }),
      values: [[], [], []], unit: "pct"
    };
    rows.forEach(function (r) {
      out.values[0].push(100 * r.operating_total * 1000 / r.gdp);
      out.values[1].push(100 * r.debt_service * 1000 / r.gdp);
      out.values[2].push(100 * r.capital_total * 1000 / r.gdp);
    });
    return out;
  }

  /* ---------- stacked bars ---------- */

  function stacked(mount, s, opts) {
    opts = opts || {};
    mount.textContent = "";
    var W = 1060, H = opts.height || 420;
    var m = { t: 16, r: 16, b: 34, l: 62 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;

    var n = s.years.length;
    var totals = s.years.map(function (_, i) {
      return s.values.reduce(function (a, v) { return a + Math.max(0, v[i]); }, 0);
    });
    var max, ticks;
    if (opts.shareCap) {
      // A share stack sums to 100 by construction; headroom would just draw
      // dead space and a 150% tick.
      max = 100; ticks = [0, 25, 50, 75, 100];
    } else {
      max = Math.max.apply(null, totals) * 1.04;
      ticks = niceTicks(max, 5);
      max = ticks[ticks.length - 1];
    }
    var tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : max;

    var band = iw / n, bw = Math.max(6, band - Math.max(2, band * 0.22));
    var y = function (v) { return m.t + ih - (v / max) * ih; };
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": opts.aria || "" });

    // One hatch pattern per series: pattern content does not inherit
    // currentColor from the element referencing it, so the colour is baked in.
    var defs = el("defs"), uid = "h" + (chartUid++);
    s.values.forEach(function (_v, si) {
      var p = el("pattern", { id: uid + "-" + si, width: 6, height: 6,
        patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
      p.appendChild(el("rect", { width: 6, height: 6, fill: css("--surface-1") }));
      p.appendChild(el("rect", { width: 2.6, height: 6, fill: colorOf(s, si) }));
      defs.appendChild(p);
    });
    svg.appendChild(defs);

    ticks.forEach(function (t) {
      svg.appendChild(el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t),
        class: t === 0 ? "ax-line" : "ax-grid" }));
      var lab = el("text", { x: m.l - 9, y: y(t) + 4, "text-anchor": "end",
        class: "ax-text tab" });
      lab.textContent = fmtAxis(t, tickStep, s.unit);
      svg.appendChild(lab);
    });

    s.years.forEach(function (fy, i) {
      var x = m.l + i * band + (band - bw) / 2, acc = 0, topIndex = -1;
      for (var k = s.values.length - 1; k >= 0; k--) {
        if (s.values[k][i] > 0) { topIndex = k; break; }
      }
      s.values.forEach(function (vals, si) {
        var v = Math.max(0, vals[i]);
        if (v <= 0) return;
        var y0 = y(acc), y1 = y(acc + v);
        var h = Math.max(0.5, y0 - y1 - 2);   // 2px surface gap between fills
        var col = colorOf(s, si), isTop = si === topIndex;
        var r = isTop ? 3 : null;
        if (s.budget[i]) {
          svg.appendChild(el("rect", { x: x, y: y1, width: bw, height: h,
            fill: "url(#" + uid + "-" + si + ")", rx: r, ry: r }));
          svg.appendChild(el("rect", { x: x, y: y1, width: bw, height: h,
            fill: "none", stroke: col, "stroke-width": 1, rx: r, ry: r }));
        } else {
          svg.appendChild(el("rect", { x: x, y: y1, width: bw, height: h,
            fill: col, rx: r, ry: r }));
        }
        acc += v;
      });
    });

    var firstBudget = s.budget.indexOf(true);
    if (firstBudget > 0) {
      var bx = m.l + firstBudget * band;
      svg.appendChild(el("line", { x1: bx, x2: bx, y1: m.t, y2: m.t + ih,
        stroke: css("--ink"), "stroke-width": 1, "stroke-dasharray": "2 3",
        opacity: 0.45 }));
      var bl = el("text", { x: bx + 5, y: m.t + 11, class: "ax-text" });
      bl.textContent = "not yet audited";
      svg.appendChild(bl);
    }

    xAxis(svg, s, n, function (i) { return m.l + i * band + band / 2; }, H);
    hoverLayer(svg, s, m, ih, band, function (i) { return m.l + i * band; },
      function (i) { return m.l + i * band + band / 2; }, totals, y);
    mount.appendChild(svg);
  }

  /* ---------- lines ---------- */

  function lines(mount, s, opts) {
    opts = opts || {};
    mount.textContent = "";
    var W = 1060, H = opts.height || 380;
    var m = { t: 16, r: opts.labelRoom || 205, b: 34, l: 62 };
    var iw = W - m.l - m.r, ih = H - m.t - m.b;
    var n = s.years.length, max = 0;
    s.values.forEach(function (v) {
      v.forEach(function (x) { if (x > max) max = x; });
    });
    var ticks = niceTicks(max * 1.06, 5);
    max = ticks[ticks.length - 1];
    var tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : max;
    var x = function (i) { return m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); };
    var y = function (v) { return m.t + ih - (v / max) * ih; };

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": opts.aria || "" });
    ticks.forEach(function (t) {
      svg.appendChild(el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t),
        class: t === 0 ? "ax-line" : "ax-grid" }));
      var lab = el("text", { x: m.l - 9, y: y(t) + 4, "text-anchor": "end",
        class: "ax-text tab" });
      lab.textContent = fmtAxis(t, tickStep, s.unit);
      svg.appendChild(lab);
    });

    s.values.forEach(function (vals, si) {
      // Solid through the audited years; dashed across any budget years.
      var solid = "", dash = "";
      vals.forEach(function (v, i) {
        var pt = x(i).toFixed(1) + " " + y(v).toFixed(1);
        if (i === 0) { solid = "M" + pt; return; }
        if (s.budget[i] || s.budget[i - 1]) {
          dash += (dash ? " L" : "M" + x(i - 1).toFixed(1) + " " +
            y(vals[i - 1]).toFixed(1) + " L") + pt;
        } else {
          solid += " L" + pt;
        }
      });
      svg.appendChild(el("path", { d: solid, fill: "none",
        stroke: colorOf(s, si), "stroke-width": 2,
        "stroke-linejoin": "round", "stroke-linecap": "round" }));
      if (dash) {
        svg.appendChild(el("path", { d: dash, fill: "none",
          stroke: colorOf(s, si), "stroke-width": 2, "stroke-dasharray": "4 4",
          "stroke-linejoin": "round", "stroke-linecap": "round" }));
      }
    });

    // Right-edge labels, nudged apart where lines finish close together.
    var ends = s.values.map(function (vals, si) {
      return { si: si, y: y(vals[vals.length - 1]) };
    }).sort(function (a, b) { return a.y - b.y; });
    ends.forEach(function (e, k) {
      if (k && e.y - ends[k - 1].y < 15) e.y = ends[k - 1].y + 15;
    });
    ends.forEach(function (e) {
      var t = el("text", { x: m.l + iw + 10, y: e.y + 4, class: "mark-label",
        "font-size": 10.5, fill: colorOf(s, e.si) });
      t.textContent = s.names[e.si];
      svg.appendChild(t);
    });

    xAxis(svg, s, n, x, H);
    var band = iw / Math.max(1, n - 1);
    hoverLayer(svg, s, m, ih, band, function (i) { return x(i) - band / 2; },
      x, null, y);
    mount.appendChild(svg);
  }

  /* ---------- shared chrome ---------- */

  function xAxis(svg, s, n, xAt, H) {
    s.years.forEach(function (fy, i) {
      if (fy % 4 !== 0 && i !== n - 1) return;
      var t = el("text", { x: xAt(i), y: H - 12, "text-anchor": "middle",
        class: "ax-text tab" });
      t.textContent = "'" + String(fy).slice(2);
      svg.appendChild(t);
    });
    var fyl = el("text", { x: 4, y: H - 12, class: "ax-text" });
    fyl.textContent = "FY";
    svg.appendChild(fyl);
  }

  function hoverLayer(svg, s, m, ih, band, hitAt, lineAt, totals, y) {
    var cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih,
      x1: 0, x2: 0, opacity: 0 });
    svg.appendChild(cross);
    var dots = totals ? [] : s.values.map(function (_v, si) {
      var c = el("circle", { r: 5, fill: colorOf(s, si),
        stroke: css("--surface-1"), "stroke-width": 2, opacity: 0 });
      svg.appendChild(c); return c;
    });
    s.years.forEach(function (fy, i) {
      var hit = el("rect", { x: hitAt(i), y: m.t, width: band, height: ih,
        fill: "transparent" });
      hit.addEventListener("pointerenter", function (ev) {
        cross.setAttribute("x1", lineAt(i));
        cross.setAttribute("x2", lineAt(i));
        cross.setAttribute("opacity", 0.5);
        dots.forEach(function (c, si) {
          c.setAttribute("cx", lineAt(i));
          c.setAttribute("cy", y(s.values[si][i]));
          c.setAttribute("opacity", 1);
        });
        showTip(ev, fy, s, i, totals ? totals[i] : null);
      });
      hit.addEventListener("pointermove", moveTip);
      hit.addEventListener("pointerleave", function () {
        cross.setAttribute("opacity", 0);
        dots.forEach(function (c) { c.setAttribute("opacity", 0); });
        tip.hidden = true;
      });
      svg.appendChild(hit);
    });
  }

  function drawLegend(mount, full, onToggle, picked) {
    mount.textContent = "";
    full.names.forEach(function (nm, i) {
      var on = !picked.length || picked.indexOf(nm) >= 0;
      var b = document.createElement(onToggle ? "button" : "span");
      b.className = "legend-item" + (on ? "" : " is-off");
      if (onToggle) {
        b.type = "button";
        b.setAttribute("aria-pressed", picked.indexOf(nm) >= 0 ? "true" : "false");
        b.addEventListener("click", function () { onToggle(nm); });
      }
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = css(SLOT[full.slots[i] % SLOT.length]);
      b.appendChild(sw);
      b.appendChild(document.createTextNode(nm));
      mount.appendChild(b);
    });
    if (onToggle && picked.length) {
      var clr = document.createElement("button");
      clr.type = "button";
      clr.className = "legend-clear";
      clr.textContent = "show all";
      clr.addEventListener("click", function () { onToggle(null); });
      mount.appendChild(clr);
    }
  }

  function showTip(ev, fy, s, i, total) {
    var html = '<div class="tt-head"><span>Fiscal ' + fy + "</span>" +
      (s.budget[i] ? "<span>" + ((s.blabels && s.blabels[i]) || "budgeted") +
        "</span>" : "") + "</div>";
    for (var k = s.values.length - 1; k >= 0; k--) {
      var v = s.values[k][i];
      if (!v) continue;
      html += '<div class="tt-row"><span class="swatch" style="background:' +
        colorOf(s, k) + '"></span><span class="tt-name">' + s.names[k] +
        '</span><span class="tt-val">' + fmt(v, s.unit) + "</span></div>";
    }
    if (total) {
      html += '<div class="tt-row tt-total"><span class="tt-name">Total</span>' +
        '<span class="tt-val">' + fmt(total, s.unit) + "</span></div>";
    }
    if (s.budget[i] && s.note) html += '<div class="tt-note">' + s.note + "</div>";
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
    var multi = s.values.length > 1;
    var h = "<table><thead><tr><th>Fiscal year</th>";
    s.names.forEach(function (nm) { h += "<th>" + nm + "</th>"; });
    if (multi) h += "<th>Total</th>";
    h += "</tr></thead><tbody>";
    s.years.forEach(function (fy, i) {
      var tot = 0;
      h += "<tr><td>" + fy + (s.budget[i] ? " (" +
        ((s.blabels && s.blabels[i]) || "budgeted") + ")" : "") + "</td>";
      s.values.forEach(function (vals) {
        tot += vals[i];
        h += "<td>" + fmt(vals[i], s.unit) + "</td>";
      });
      if (multi) h += "<td>" + fmt(tot, s.unit) + "</td>";
      h += "</tr>";
    });
    mount.innerHTML = h + "</tbody></table>";
  }

  /* ---------- headline figures ---------- */

  function heroStats() {
    var rows = DATA.years, first = rows[0], last = rows[rows.length - 1];
    var tot = function (r) {
      return scale(r, r.operating_total + r.debt_service + r.capital_total);
    };
    var a = tot(first), b = tot(last);
    var gdpRows = rows.filter(function (r) { return r.gdp; });
    var g = gdpRows[gdpRows.length - 1];
    var items = [
      ["Total spending, FY2025", fmt(b),
       state.perCapita ? "per New Yorker" : "operations, debt and capital"],
      ["Change since FY2000", (b >= a ? "+" : "") +
        Math.round((b / a - 1) * 100) + "%",
       state.real ? "after inflation" : "not adjusted for inflation"],
      ["Share of city GDP, FY" + g.fy,
       (100 * (g.operating_total + g.debt_service + g.capital_total) * 1000 /
         g.gdp).toFixed(1) + "%",
       "latest year with measured GDP"],
      ["FY2027 expense budget", (function () {
        var by = (DATA.budget_years || [])[1];
        if (!by) return "n/a";
        var v = by.total_expense;
        if (state.real) v *= last.deflator;
        if (state.perCapita) v /= by.population;
        return fmt(v);
      })(), "adopted; excludes capital"]
    ];
    document.getElementById("heroStats").innerHTML = items.map(function (it) {
      return '<div class="stat"><p class="stat-label">' + it[0] +
        '</p><p class="stat-value">' + it[1] +
        '</p><p class="stat-sub">' + it[2] + "</p></div>";
    }).join("");
  }


  /* ---------- growth calculator ---------- */

  var G_MEASURES = [
    ["total", "Total spending (operations, debt and capital)"],
    ["operating", "Operating spending"],
    ["capital", "Capital spending"],
    ["revenue", "Revenue"]
  ];

  function growthValue(measure, catName, r) {
    // Returns $ thousands for one audited year.
    if (measure === "total") {
      return r.operating_total + r.debt_service + r.capital_total;
    }
    var bucket = measure === "revenue" ? r.revenue
      : measure === "capital" ? r.capital : r.operating;
    if (catName === "__all") {
      return measure === "revenue" ? r.revenue_total
        : measure === "capital" ? r.capital_total
        : r.operating_total + r.debt_service;
    }
    var group = null;
    groupsFor(measure).forEach(function (g) {
      if (g[0] === catName) group = g;
    });
    if (!group) return 0;
    var sum = 0;
    group[1].forEach(function (key) {
      if (key === "debt_service") sum += r.debt_service;
      else if (bucket[key] !== undefined) sum += bucket[key];
    });
    return sum;
  }

  function growthCategories() {
    var m = document.getElementById("gMeasure").value;
    var sel = document.getElementById("gCategory");
    var keep = sel.value;
    sel.textContent = "";
    var all = document.createElement("option");
    all.value = "__all";
    all.textContent = m === "total" ? "Everything" : "All categories";
    sel.appendChild(all);
    if (m !== "total") {
      groupsFor(m).forEach(function (g) {
        var o = document.createElement("option");
        o.value = g[0]; o.textContent = g[0];
        sel.appendChild(o);
      });
    }
    sel.value = "__all";
    if (keep) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === keep) { sel.value = keep; break; }
      }
    }
    sel.disabled = m === "total";
  }

  function updateGrowth() {
    var box = document.getElementById("gResult");
    if (!box) return;
    var m = document.getElementById("gMeasure").value;
    var cat = document.getElementById("gCategory").value;
    var y0 = +document.getElementById("gFrom").value;
    var y1 = +document.getElementById("gTo").value;
    if (y0 > y1) { var t_ = y0; y0 = y1; y1 = t_; }
    if (y0 === y1) {
      box.innerHTML = '<p class="g-note">Pick two different fiscal years.</p>';
      return;
    }
    var rows = {};
    DATA.years.forEach(function (r) { rows[r.fy] = r; });
    var r0 = rows[y0], r1 = rows[y1];
    var v0 = scale(r0, growthValue(m, cat, r0));
    var v1 = scale(r1, growthValue(m, cat, r1));
    if (!(v0 > 0)) {
      box.innerHTML = '<p class="g-note">No spending recorded in the ' +
        "starting year for that pick.</p>";
      return;
    }
    var pct = (v1 / v0 - 1) * 100;
    var yrs = y1 - y0;
    var ann = (Math.pow(v1 / v0, 1 / yrs) - 1) * 100;
    var what = m === "total" ? "Total spending"
      : cat === "__all"
        ? { operating: "Operating spending", capital: "Capital spending",
            revenue: "Revenue" }[m]
        : cat;
    box.innerHTML =
      '<p class="g-big">' + (pct >= 0 ? "+" : "\u2212") +
        Math.abs(pct) .toFixed(1) + "%</p>" +
      '<p class="g-line">' + what + ", fiscal " + y0 + " to " + y1 + "</p>" +
      '<p class="g-line">' + fmt(v0) + " \u2192 " + fmt(v1) +
        " \u00b7 " + (ann >= 0 ? "+" : "\u2212") + Math.abs(ann).toFixed(1) +
        "% a year over " + yrs + " years</p>" +
      '<p class="g-basis">' +
        (state.real ? "Adjusted for inflation, fiscal " +
          DATA.meta.dollar_base_fy + " dollars" : "Not adjusted for inflation") +
        (state.perCapita ? " \u00b7 per resident" : "") +
        " \u00b7 audited years only</p>";
  }

  function growthInit() {
    if (!document.getElementById("gMeasure")) return;
    var mSel = document.getElementById("gMeasure");
    G_MEASURES.forEach(function (mm) {
      var o = document.createElement("option");
      o.value = mm[0]; o.textContent = mm[1];
      mSel.appendChild(o);
    });
    var years = DATA.years.map(function (r) { return r.fy; });
    [["gFrom", years[0]], ["gTo", years[years.length - 1]]].forEach(function (p) {
      var sel = document.getElementById(p[0]);
      years.forEach(function (y) {
        var o = document.createElement("option");
        o.value = y; o.textContent = "FY" + y;
        sel.appendChild(o);
      });
      sel.value = p[1];
    });
    growthCategories();
    mSel.addEventListener("change", function () {
      growthCategories(); updateGrowth();
    });
    ["gCategory", "gFrom", "gTo"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", updateGrowth);
    });
    updateGrowth();
  }

  /* ---------- render ---------- */

  function drawCategoryChart(id, kind, selKey) {
    var share = state.share[id];
    var full = seriesFor(kind, share);
    var picked = state.sel[selKey];
    var shown = subset(full, picked);
    var isolated = picked.length > 0;

    cache[id] = shown;
    var mount = document.getElementById(id);
    if (isolated) lines(mount, shown, { aria: "Selected categories over time" });
    else stacked(mount, shown, { aria: "Breakdown by category", shareCap: share });

    drawLegend(document.getElementById(id + "Legend"), full, function (nm) {
      var arr = state.sel[selKey];
      if (nm === null) state.sel[selKey] = [];
      else if (arr.indexOf(nm) >= 0) {
        state.sel[selKey] = arr.filter(function (x) { return x !== nm; });
      } else state.sel[selKey] = arr.concat([nm]);
      render();
    }, picked);
    return { isolated: isolated, count: picked.length, share: share };
  }

  function render() {
    var last = DATA.years[DATA.years.length - 1];
    document.getElementById("basisNote").textContent =
      (state.real ? "In fiscal " + DATA.meta.dollar_base_fy + " dollars"
                  : "In each year's own dollars") +
      (state.perCapita ? " · per resident" : "");

    heroStats();

    cache.c1 = totalsSeries();
    stacked(document.getElementById("c1"), cache.c1,
      { aria: "Total New York City spending by fiscal year" });
    drawLegend(document.getElementById("c1Legend"), cache.c1, null, []);
    document.getElementById("c1Title").textContent =
      (state.perCapita ? "Total spending per resident" : "Total spending") +
      ", fiscal 2000 to 2027";

    var c2 = drawCategoryChart("c2", state.mode, state.mode);
    document.getElementById("c2Title").textContent =
      (state.mode === "operating" ? "Operating spending" : "Capital spending") +
      (c2.share ? ", share of the total" : " by category") +
      (c2.isolated ? ", isolated" : "") +
      (state.perCapita && !c2.share ? ", per resident" : "") +
      (state.mode === "operating" ? ", fiscal 2000 to 2027"
                                  : ", fiscal 2000 to 2025");
    document.getElementById("c2Hint").textContent = c2.isolated
      ? "Showing " + c2.count + " of 8 categories as trend lines. Click others " +
        "in the legend to add them, or use \u201cshow all\u201d to reset."
      : "Click any category in the legend to isolate its trend line. " +
        "Click more to compare.";
    document.getElementById("c2Note").textContent = state.mode === "operating"
      ? "Operating spending is the General Fund plus its transfers for debt " +
        "service. The hatched fiscal 2026 and 2027 columns are the Office of " +
        "Management and Budget's agency-level expense budget, grouped using " +
        "the Comptroller's own agency-to-function classification. They are " +
        "close but not line-for-line comparable: the budget basis nets out " +
        "intra-city purchases, and citywide costs such as transit subsidies, " +
        "judgments and reserves sit in the Miscellaneous budget, which " +
        "appears here in the benefits band."
      : "Capital spending is the Capital Projects Fund. City University " +
        "capital runs through the education line. The adopted budget does " +
        "not restate the capital program on this basis, so the hatched " +
        "years are omitted.";

    cache.c3 = (function () {
      var rows = DATA.years;
      return {
        years: rows.map(function (r) { return r.fy; }),
        names: ["New bonds issued", "Capital spending",
                "Federal and state capital aid"],
        slots: [0, 1, 2], unit: "usd",
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
    lines(document.getElementById("c3"), cache.c3,
      { aria: "Borrowing against capital spending" });
    drawLegend(document.getElementById("c3Legend"), cache.c3, null, []);
    document.getElementById("c3Title").textContent =
      "Borrowing and building" + (state.perCapita ? ", per resident" : "");

    var c4 = drawCategoryChart("c4", "revenue", "revenue");
    document.getElementById("c4Title").textContent =
      "Revenue by source" + (c4.share ? ", share of the total" : "") +
      (c4.isolated ? ", isolated" : "") +
      (state.perCapita && !c4.share ? ", per resident" : "");
    document.getElementById("c4Hint").textContent = c4.isolated
      ? "Showing " + c4.count + " of 8 sources as trend lines. Click others " +
        "in the legend to add them, or use \u201cshow all\u201d to reset."
      : "Click any source in the legend to isolate its trend line. " +
        "Click more to compare.";

    cache.c5 = gdpSeries();
    stacked(document.getElementById("c5"), cache.c5,
      { aria: "City spending as a share of gross domestic product", height: 380 });
    drawLegend(document.getElementById("c5Legend"), cache.c5, null, []);
    document.getElementById("c5Title").textContent =
      "Spending as a share of city GDP, fiscal " + cache.c5.years[0] +
      " to " + cache.c5.years[cache.c5.years.length - 1];

    updateGrowth();

    ["c1", "c2", "c3", "c4", "c5"].forEach(function (id) {
      var t = document.getElementById(id + "Table");
      if (t && !t.hidden) drawTable(t, cache[id]);
    });
  }

  /* ---------- wiring ---------- */

  function setOn(btn, sel) {
    document.querySelectorAll(sel).forEach(function (o) {
      o.classList.toggle("is-on", o === btn);
    });
  }

  function bind() {
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
        state.sel.operating = []; state.sel.capital = [];
        setOn(b, "[data-mode]"); render();
      });
    });
    document.querySelectorAll("[data-share]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.shareFor;
        state.share[id] = b.dataset.share === "1";
        setOn(b, '[data-share-for="' + id + '"]'); render();
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

  fetch("data.json?v=20260809c")
    .then(function (r) {
      if (!r.ok) throw new Error("data.json " + r.status);
      return r.json();
    })
    .then(function (d) {
      DATA = d;
      bind();
      growthInit();
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
