#!/usr/bin/env python3
"""
Extract ten-year-trend tables from NYC Comptroller ACFR/CAFR PDFs.

The statistical section of each ACFR carries "Ten Year Trend" schedules. Three
reports (FY2005, FY2015, FY2025) therefore cover FY1996-FY2025 with no gaps.

The tables are laid out as right-aligned numeric columns, one per fiscal year,
with row labels at the left that frequently wrap across two or three lines.
Reading the PDF text stream in order scrambles this, so we work from word
coordinates instead: cluster numeric tokens by their right edge into year
columns, group tokens into rows by baseline, and accumulate wrapped labels.

Output: data/out/acfr_raw.csv with columns
    source, table, page, row_order, label, fiscal_year, value_thousands
"""

import csv
import os
import re
import sys
from collections import defaultdict

import fitz  # PyMuPDF

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "out")

# Page ranges are 1-indexed PDF pages, inclusive, located by table title scan.
SOURCES = [
    # file,        table key,   first page, last page, years (left -> right)
    ("acfr2025", "fund_balances", 424, 424, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "fund_balances", 426, 426, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "fund_balances", 428, 428, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "fund_balances", 425, 425, [2019, 2018, 2017, 2016]),
    ("acfr2025", "fund_balances", 427, 427, [2019, 2018, 2017, 2016]),
    ("acfr2025", "fund_balances", 429, 429, [2019, 2018, 2017, 2016]),
    ("acfr2025", "gf_revenues", 430, 430, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "gf_revenues", 432, 432, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "gf_revenues", 434, 434, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "gf_revenues", 436, 436, [2025, 2024, 2023, 2022, 2021, 2020]),
    ("acfr2025", "gf_revenues", 431, 431, [2019, 2018, 2017, 2016]),
    ("acfr2025", "gf_revenues", 433, 433, [2019, 2018, 2017, 2016]),
    ("acfr2025", "gf_revenues", 435, 435, [2019, 2018, 2017, 2016]),
    ("acfr2025", "gf_revenues", 437, 437, [2019, 2018, 2017, 2016]),
    ("acfr2015", "fund_balances", 358, 360, list(range(2015, 2005, -1))),
    ("acfr2015", "gf_revenues", 361, 365, list(range(2015, 2005, -1))),
    ("acfr2005", "fund_balances", 276, 278, list(range(2005, 1995, -1))),
    ("acfr2005", "gf_revenues", 279, 283, list(range(2005, 1995, -1))),
]

# Schedules that run over many pages, one row per agency. Year columns are
# read off each page's own header rather than assumed.
MULTIPAGE = [
    ("acfr2025", "gf_expenditures", 438, 457, range(2016, 2026)),
    ("acfr2015", "gf_expenditures", 366, 376, range(2006, 2016)),
    ("acfr2005", "gf_expenditures", 284, 294, range(1996, 2006)),
    ("acfr2025", "capital_expenditures", 462, 465, range(2016, 2026)),
    ("acfr2015", "capital_expenditures", 379, 380, range(2006, 2016)),
    ("acfr2005", "capital_expenditures", 297, 298, range(1996, 2006)),
    ("acfr2025", "capital_aid", 459, 461, range(2016, 2026)),
    ("acfr2015", "capital_aid", 377, 378, range(2006, 2016)),
    ("acfr2005", "capital_aid", 295, 296, range(1996, 2006)),
]

NUM_RE = re.compile(r"^\(?\$?-?[\d,]+\)?$")
DASH = {"—", "–", "-", "—)", "$"}


def is_number(tok):
    if tok in DASH:
        return False
    if not NUM_RE.match(tok):
        return False
    return any(c.isdigit() for c in tok)


def parse_number(tok):
    # Amounts are often typeset with the dollar sign kerned onto the digits
    # ("$11,615,939"), so it arrives as part of the same token.
    neg = tok.startswith("(")
    tok = tok.strip("()").lstrip("$").replace(",", "")
    if not tok or not tok.lstrip("-").isdigit():
        return None
    v = int(tok)
    return -v if neg else v


def grid_columns(rights, ncols, tol=3.0):
    """Fit a uniform column grid to the right edges of numeric tokens.

    These schedules are set on a fixed grid, so evenly spaced columns are a
    much stronger prior than free clustering: on pages where a year column
    happens to hold only dashes, k-means collapses two centres onto the same
    position and silently shifts every value one year over.
    """
    if len(rights) < ncols:
        return None
    # Collapse near-identical edges into distinct column positions.
    pos = []
    for r in sorted(rights):
        if pos and r - pos[-1][-1] <= tol:
            pos[-1].append(r)
        else:
            pos.append([r])
    distinct = [sum(g) / len(g) for g in pos]
    if len(distinct) < 2:
        return None

    diffs = [b - a for a, b in zip(distinct, distinct[1:])]
    step = min(diffs)
    if step <= 0:
        return None
    # Every observed gap must be a whole number of column widths.
    for d in diffs:
        if abs(d / step - round(d / step)) > 0.12:
            return None
    anchor = distinct[-1]
    centers = [anchor - step * (ncols - 1 - i) for i in range(ncols)]
    # Every observed column must land on the grid.
    for p in distinct:
        if min(abs(p - c) for c in centers) > tol + 1:
            return None
    return centers


def cluster_columns(rights, ncols):
    """1-D k-means-ish clustering of right edges into ncols groups."""
    rights = sorted(rights)
    if len(rights) < ncols:
        return None
    # Seed with quantiles, then Lloyd iterations.
    centers = [rights[int((i + 0.5) * len(rights) / ncols)] for i in range(ncols)]
    for _ in range(60):
        buckets = defaultdict(list)
        for r in rights:
            k = min(range(ncols), key=lambda i: abs(r - centers[i]))
            buckets[k].append(r)
        new = [sum(buckets[i]) / len(buckets[i]) if buckets[i] else centers[i]
               for i in range(ncols)]
        if all(abs(a - b) < 0.01 for a, b in zip(new, centers)):
            break
        centers = new
    return sorted(centers)


def reading_space(page):
    """Normalize word boxes into reading coordinates.

    Statistical-section pages in the FY2005 and FY2015 reports are typeset
    sideways: the page rotation flag is 0, but every line is drawn with a
    (0,-1) direction matrix, so bounding boxes come back tall and narrow and
    columns run down the page instead of across it. Detect the dominant line
    direction and rotate the boxes so downstream logic always sees a normal
    left-to-right, top-to-bottom table.
    """
    words = page.get_text("words")  # x0,y0,x1,y1,word,block,line,word_no
    dirs = defaultdict(int)
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            dirs[l.get("dir", (1.0, 0.0))] += 1
    dominant = max(dirs, key=dirs.get) if dirs else (1.0, 0.0)

    if dominant == (0.0, -1.0):
        # Reading-x runs along decreasing page-y; reading-y along page-x.
        return [(-w[3], w[0], -w[1], w[2]) + tuple(w[4:]) for w in words]
    if dominant == (0.0, 1.0):
        return [(w[1], -w[2], w[3], -w[0]) + tuple(w[4:]) for w in words]
    return words


FRAG_RE = re.compile(r"^\(?\$?-?[\d,]+\)?$")


def merge_fragments(words, max_gap=2.5):
    """Rejoin amounts that the PDF split across tokens.

    Several pages typeset figures with a stray space inside the digits
    ("16,102,46 2", "$ 80,315,46 5"). Left alone these parse as a number an
    order of magnitude too small, which no downstream check other than the
    printed totals would catch. Column gaps are tens of points wide, so any
    numeric pair separated by a hair is a split amount.
    """
    if not words:
        return words
    rows = defaultdict(list)
    for w in words:
        rows[round(((w[1] + w[3]) / 2) / 2.0)].append(w)

    out = []
    for key in rows:
        toks = sorted(rows[key], key=lambda w: w[0])
        merged = []
        for w in toks:
            if (merged and FRAG_RE.match(w[4]) and FRAG_RE.match(merged[-1][4])
                    and any(c.isdigit() for c in w[4])
                    and any(c.isdigit() for c in merged[-1][4])
                    and w[0] - merged[-1][2] < max_gap):
                p = merged[-1]
                merged[-1] = (p[0], min(p[1], w[1]), w[2], max(p[3], w[3]),
                              p[4] + w[4]) + tuple(p[5:])
            else:
                merged.append(w)
        out.extend(merged)
    return out


def detect_years(page, valid):
    """Read the fiscal-year column headers off the page.

    Safer than assuming how a schedule paginates: the FY2025 report splits its
    ten-year tables into a six-year page and a four-year page, and the split
    point is not the same for every schedule.
    """
    words = merge_fragments(reading_space(page))
    cut = 0.0
    for w in words:
        if w[4].startswith("thousands"):
            cut = max(cut, w[3])
    head = [w for w in words if w[3] <= cut + 1]
    years = []
    for w in sorted(head, key=lambda w: w[0]):
        tok = w[4].strip().replace(" ", "")
        if re.fullmatch(r"(19|20)\d{2}", tok) and int(tok) in valid:
            years.append((w[0], int(tok)))
    # Keep the last contiguous run of headers, deduplicated left-to-right.
    seen, ordered = set(), []
    for _, y in years:
        if y not in seen:
            seen.add(y)
            ordered.append(y)
    return ordered


def extract_page(page, years):
    """Return list of (label, {year: value}) preserving vertical order."""
    words = merge_fragments(reading_space(page))
    if not words:
        return []

    # Drop the header band: everything above the last "(in thousands)" marker,
    # so column-header years are not mistaken for data.
    cut = 0
    for w in words:
        if w[4] in ("thousands)", "thousands"):
            cut = max(cut, w[3])
    body = [w for w in words if w[1] > cut - 1]
    if not body:
        body = words

    nums = [w for w in body if is_number(w[4])]
    if len(nums) < len(years):
        return []

    # Seed the column centers from thousands-separated amounts only. The
    # General Fund expenditure schedules prefix each row with a bare agency
    # code ("002 Mayoralty"), and those codes would otherwise be clustered as
    # if they were a data column.
    # Seed the grid from plain positive amounts only: a parenthesised negative
    # pushes its right edge a few points past the column rule, which is enough
    # to split one column into two apparent ones.
    plain = [w for w in nums if "(" not in w[4] and ")" not in w[4]]
    seeds = [w for w in plain if "," in w[4]]
    if len(seeds) < len(years):
        # Fall back to every plain number, but drop tokens sitting far left of
        # the numeric block: printed page numbers live in the label margin and
        # would otherwise anchor a phantom column.
        seeds = plain or nums
        if seeds:
            rightmost = max(w[2] for w in seeds)
            seeds = [w for w in seeds if rightmost - w[2] < 700]
    edges = [w[2] for w in seeds]
    centers = grid_columns(edges, len(years)) or cluster_columns(edges, len(years))
    if centers is None:
        return []
    # Guard: columns must be reasonably separated.
    gaps = [b - a for a, b in zip(centers, centers[1:])]
    if gaps and min(gaps) < 8:
        return []

    spacing = sorted(gaps)[len(gaps) // 2] if gaps else 75
    left_edge = min(centers) - spacing * 0.9

    # Group tokens into visual rows. Each table cell is its own text line in
    # the content stream, so PDF line structure cannot be used; cluster on the
    # vertical centre instead, with a tolerance scaled to the glyph height.
    heights = sorted(w[3] - w[1] for w in body)
    tol = max(1.5, heights[len(heights) // 2] * 0.6)
    toks = sorted(body, key=lambda w: (w[1] + w[3]) / 2)
    groups, cur, last = [], [], None
    for w in toks:
        c = (w[1] + w[3]) / 2
        if last is not None and c - last > tol:
            groups.append(cur)
            cur = []
        cur.append(w)
        last = c
    if cur:
        groups.append(cur)

    out = []
    pending_label = []
    for grp in groups:
        row = sorted(grp, key=lambda w: w[0])
        cells = [w for w in row
                 if w[0] > left_edge and (is_number(w[4]) or w[4] in ("—", "–"))]
        label_parts = [w[4] for w in row if w[0] <= left_edge]

        vals = {}
        if len(cells) == len(years):
            # Full row: map left-to-right by rank, which is immune to the
            # column drift caused by leading dollar signs.
            for k, w in enumerate(cells):
                vals[years[k]] = 0 if w[4] in ("—", "–") else parse_number(w[4])
        else:
            for w in cells:
                k = min(range(len(centers)), key=lambda i: abs(w[2] - centers[i]))
                v = 0 if w[4] in ("—", "–") else parse_number(w[4])
                if v is not None and years[k] not in vals:
                    vals[years[k]] = v
        vals = {y: v for y, v in vals.items() if v is not None}

        label = " ".join(label_parts)
        label = re.sub(r"[.…]{2,}", " ", label)
        label = re.sub(r"[_]{2,}", " ", label)
        label = re.sub(r"\s+", " ", label).strip(" .$")

        if not vals:
            if label and not re.fullmatch(r"[\d\s.()%$-]*", label):
                pending_label.append(label)
            continue

        full = " ".join(pending_label + ([label] if label else [])).strip()
        full = re.sub(r"\s+", " ", full)
        pending_label = []
        if full:
            out.append((full, vals))
    return out


def run():
    os.makedirs(OUT, exist_ok=True)
    rows = []
    order = 0

    docs = {}
    jobs = list(SOURCES)
    for src, table, p0, p1, valid in MULTIPAGE:
        if src not in docs:
            docs[src] = fitz.open(os.path.join(RAW, src + ".pdf"))
        for p in range(p0, p1 + 1):
            years = detect_years(docs[src][p - 1], set(valid))
            if not years:
                print(f"  warn: no year header found on {src} p{p} ({table})")
                continue
            jobs.append((src, table, p, p, years))

    for src, table, p0, p1, years in jobs:
        if src not in docs:
            docs[src] = fitz.open(os.path.join(RAW, src + ".pdf"))
        doc = docs[src]
        for p in range(p0, p1 + 1):
            page = doc[p - 1]
            for label, vals in extract_page(page, years):
                order += 1
                for y, v in sorted(vals.items()):
                    rows.append({
                        "source": src, "table": table, "page": p,
                        "row_order": order, "label": label,
                        "fiscal_year": y, "value_thousands": v,
                    })

    path = os.path.join(OUT, "acfr_raw.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "source", "table", "page", "row_order", "label",
            "fiscal_year", "value_thousands"])
        w.writeheader()
        w.writerows(rows)

    if not rows:
        sys.exit("FATAL: extractor produced zero rows")
    print(f"wrote {path}: {len(rows)} cells, {len(set(r['row_order'] for r in rows))} rows")
    for t in sorted(set(r["table"] for r in rows)):
        yrs = sorted(set(r["fiscal_year"] for r in rows if r["table"] == t))
        print(f"  {t}: FY{yrs[0]}-FY{yrs[-1]} ({len(yrs)} years)")


if __name__ == "__main__":
    run()
