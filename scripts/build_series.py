#!/usr/bin/env python3
"""
Turn raw ACFR cells into canonical series, refusing to emit anything that does
not reconcile to the totals printed in the reports, then join population and
inflation and write the site's data file.

Every budget category is a line the Comptroller publishes. Nothing is
estimated, interpolated or allocated here: the only arithmetic is addition,
and each sum is checked against the report's own printed total for that year.
A mismatch is a hard failure, not a warning.

Sources
  Budget      NYC Comptroller ACFR statistical sections (FY2005/FY2015/FY2025)
  Population  Census Bureau county estimates, decennial-anchored
  Prices      BLS CPI-U, New York-Newark-Jersey City (CUURS12ASA0)
"""

import collections
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "data", "out")
SITE = os.path.join(HERE, "..")

# The first fiscal year on a fully consistent basis. Before FY2000 the
# governmental-funds schedules report capital spending on a separate line
# rather than inside each function, and Census no longer publishes the 1990s
# county estimates needed for a seamless per-capita denominator.
FIRST_FY = 2000
LAST_FY = 2025

# ACFR printed totals occasionally disagree with their own components by a
# single $1,000 unit from internal rounding. Anything larger is a real error.
TOLERANCE = 2

NYC_COUNTIES = {"Bronx County", "Kings County", "New York County",
                "Queens County", "Richmond County"}

OPERATING = [
    ("education", "Education", ["department of education", "board of education"]),
    ("social_services", "Social services", ["total social services"]),
    ("public_safety", "Police, fire, courts and jails",
     ["total public safety and judicial"]),
    ("pensions", "Pension contributions", ["pension contributions"]),
    ("fringe_benefits", "Health insurance and other benefits",
     ["fringe benefits and other benefit payments", "benefit payments"]),
    ("health", "Health and hospitals", ["total health"]),
    ("environmental", "Sanitation, water and sewers",
     ["total environmental protection"]),
    ("general_government", "General government", ["total general government"]),
    ("housing", "Housing and buildings", ["total housing"]),
    ("transportation", "Transportation", ["total transportation services"]),
    ("city_university", "City University", ["total city university"]),
    ("parks", "Parks, recreation and culture",
     ["total parks recreation and cultural activities"]),
    ("libraries", "Libraries", ["total libraries"]),
    ("judgments", "Judgments and claims", ["judgments and claims"]),
    ("lease_payments", "Lease payments", ["lease payments"]),
    ("other_misc", "Miscellaneous", ["miscellaneous"]),
]

CAPITAL = [
    ("education", "Education (incl. CUNY)", ["total education"]),
    ("environmental", "Sanitation, water and sewers",
     ["total environmental protection"]),
    ("transportation", "Transportation", ["total transportation services"]),
    ("general_government", "General government", ["total general government"]),
    ("public_safety", "Police, fire, courts and jails",
     ["total public safety and judicial"]),
    ("parks", "Parks, recreation and culture",
     ["total parks recreation and cultural activities"]),
    # Housing capital runs through HPD alone, so the schedule prints no subtotal.
    ("housing", "Housing and buildings",
     ["total housing", "department of housing preservation and development"]),
    ("health", "Health and hospitals", ["total health"]),
    ("social_services", "Social services", ["total social services"]),
    ("libraries", "Libraries", ["total libraries"]),
    ("other_capital", "Other", ["other"]),
]

TAXES = [
    ("property_tax", "Property tax", ["real estate taxes"], r"penalt"),
    ("personal_income_tax", "Personal income tax",
     ["personal income taxes net of refunds"], None),
    ("sales_tax", "Sales tax", ["total sales and use taxes"], None),
    ("business_taxes", "Business income taxes",
     ["total other income taxes", "total income taxes other"], None),
    ("other_taxes", "Other taxes", ["total other taxes"], None),
    ("tax_penalties", "Penalties and interest",
     ["total penalties and interest on delinquent taxes"], None),
]

NONTAX = [
    ("state_aid", "State aid", ["total state grants"]),
    ("federal_aid", "Federal aid", ["total federal grants"]),
    ("unrestricted_aid", "Unrestricted federal and state aid",
     ["total unrestricted federal and state aid"]),
    ("other_grants", "Other grants", ["total non governmental grants",
                                      "total other grants",
                                      "total other categorical aid"]),
    ("charges_for_services", "Charges for services",
     ["total charges for services"]),
    ("fines_forfeitures", "Fines and forfeitures", ["total fines and forfeitures"]),
    ("licenses_permits", "Licenses, permits and franchises",
     ["total licenses permits privileges and franchises"]),
    ("investment_income", "Investment income", ["investment income",
                                                "interest income"]),
    ("tobacco_settlement", "Tobacco settlement", ["tobacco settlement"]),
    ("other_revenues", "Other revenues", ["miscellaneous"]),
    ("disallowances", "Provision for disallowances",
     ["provision for disallowances of federal state and other aid",
      "provision for disallowances of federal state and other aid receivables"]),
]

# Rows below "Miscellaneous" in the revenue schedule. This is a "Revenues and
# Other Financing Sources" table and its printed total includes them.
OTHER_FINANCING = [
    "pollution remediation bond sales",
    "transfer from general debt service fund",
    "transfer from nonmajor debt service fund",
    "transfer from nonmajor capital projects fund",
    "transfer from nonmajor capital projects funds",
]

BORROWING = [
    ("bonds_issued", "Principal amount of bonds issued",
     ["principal amount of bonds issued", "proceeds from sale of bonds"]),
    ("bond_premium", "Bond premium", ["bond premium"]),
    ("refunding_debt", "Refunding debt issued",
     ["other financing sources refunding debt issued:",
      "other financing sources refunding debt issued",
      "issuance of refunding debt", "refunding bond proceeds"]),
]


def norm(label):
    s = label.lower().replace("—", " ").replace("–", " ").replace("-", " ")
    if ":" in s:
        s = s.rsplit(":", 1)[1]
    s = s.replace("(cont.)", " ").replace("(continued)", " ")
    s = re.sub(r"[(),.$]", " ", s)
    s = re.sub(r"\b\d{2,4}\b", " ", s)      # agency codes, stray page numbers
    s = re.sub(r"\s+", " ", s).strip()
    return s


def load_cells():
    cells = collections.defaultdict(dict)
    with open(os.path.join(OUT, "acfr_raw.csv")) as f:
        for r in csv.DictReader(f):
            key = (r["table"], r["source"], int(r["row_order"]), r["label"])
            cells[key][int(r["fiscal_year"])] = int(r["value_thousands"])
    return cells


def transfer_cutoffs(cells):
    """Row order at which each report's expenditure schedule stops.

    "Lease Payments" appears twice: once as an operating expenditure and again
    inside the Transfers-to-debt-service section below the total. Only rows
    above the Transfers heading are components of Total Expenditures.
    """
    cutoff = {}
    for (t, src, order, label), vals in cells.items():
        if t != "gf_expenditures" or not re.search(r"\btransfers?\b", label, re.I):
            continue
        # Keyed by year as well as report: the FY2025 report interleaves its
        # six-year and four-year pages, so a single per-report cutoff would
        # slice through the middle of the four-year columns.
        for y in vals:
            key = (src, y)
            cutoff[key] = min(cutoff.get(key, order), order)
    return cutoff


def matches(cells, table, names, year, exclude=None, before=None):
    hits = []
    for (t, src, order, label), vals in cells.items():
        if t != table or year not in vals or norm(label) not in names:
            continue
        if exclude and re.search(exclude, label, re.I):
            continue
        if before and (src, year) in before and order >= before[(src, year)]:
            continue
        hits.append((vals[year], label, src))
    return hits


def pick(cells, table, names, year, exclude=None, before=None):
    """Single-row lookup; duplicate rows across paginated halves must agree."""
    hits = matches(cells, table, names, year, exclude, before)
    if not hits:
        return None
    distinct = {h[0] for h in hits}
    if len(distinct) > 1:
        sys.exit(f"FATAL: conflicting values for {names[0]!r} in {table} FY{year}: "
                 + ", ".join(f"{v:,} ({l!r} in {s})" for v, l, s in hits))
    return hits[0][0]


def pick_sum(cells, table, names, year):
    seen, total = set(), 0
    for v, label, _src in matches(cells, table, names, year):
        key = (norm(label), v)
        if key not in seen:
            seen.add(key)
            total += v
    return total


# --------------------------------------------------------------------------
# population
# --------------------------------------------------------------------------

def load_population():
    """NYC resident population, July 1, from decennial-anchored Census series.

    2000-2009  intercensal county estimates (2000-2010)
    2010-2019  intercensal county estimates (2010-2020)
    2020-2025  Vintage 2025 county estimates
    The joins fall on census years, where the series agree by construction.
    """
    pop = {}

    with open(os.path.join(RAW, "co-est00int-tot.csv"), encoding="latin-1") as f:
        for row in csv.DictReader(f):
            if row["STNAME"] != "New York" or row["CTYNAME"] not in NYC_COUNTIES:
                continue
            for y in range(2000, 2010):
                pop[y] = pop.get(y, 0) + int(row[f"POPESTIMATE{y}"])

    import openpyxl
    wb = openpyxl.load_workbook(os.path.join(RAW, "co-est2020int-pop-36.xlsx"))
    ws = wb.active
    header_years = list(range(2010, 2021))
    for row in ws.iter_rows(values_only=True):
        if not row or not isinstance(row[0], str):
            continue
        name = row[0].lstrip(".").split(",")[0].strip()
        if name not in NYC_COUNTIES:
            continue
        nums = [c for c in row[1:] if isinstance(c, (int, float))]
        # Columns are: April 1 2010 census, then July 1 2010..2019, April 1 2020.
        if len(nums) < 12:
            sys.exit(f"FATAL: unexpected intercensal row shape for {name}: {nums}")
        for i, y in enumerate(header_years):
            if y == 2020:
                continue
            pop[y] = pop.get(y, 0) + int(nums[i + 1])

    with open(os.path.join(RAW, "co-est2025-alldata.csv"), encoding="latin-1") as f:
        for row in csv.DictReader(f):
            if row["STNAME"] != "New York" or row["CTYNAME"] not in NYC_COUNTIES:
                continue
            for y in range(2020, 2026):
                col = f"POPESTIMATE{y}"
                if col in row and row[col]:
                    pop[y] = pop.get(y, 0) + int(row[col])

    missing = [y for y in range(FIRST_FY, LAST_FY + 1) if y not in pop]
    if missing:
        sys.exit(f"FATAL: missing population for {missing}")
    return pop


def fiscal_population(pop):
    """Population at the close of each fiscal year.

    City fiscal years end 30 June, and the Census estimates are dated 1 July,
    so the estimate for year Y is the population one day after FY Y closed.
    """
    return {y: pop[y] for y in range(FIRST_FY, LAST_FY + 1)}


# --------------------------------------------------------------------------
# prices
# --------------------------------------------------------------------------

def load_cpi():
    """Fiscal-year average CPI-U for the New York metro area."""
    monthly = {}
    with open(os.path.join(RAW, "cu.data.1.AllItems.txt")) as f:
        for line in f:
            p = line.split("\t")
            if len(p) < 4 or p[0].strip() != "CUURS12ASA0":
                continue
            period = p[2].strip()
            if not period.startswith("M") or period == "M13":
                continue
            try:
                monthly[(int(p[1]), int(period[1:]))] = float(p[3])
            except ValueError:
                continue

    fy = {}
    for y in range(FIRST_FY, LAST_FY + 1):
        months = [(y - 1, m) for m in range(7, 13)] + [(y, m) for m in range(1, 7)]
        vals = [monthly[m] for m in months if m in monthly]
        if len(vals) != 12:
            sys.exit(f"FATAL: FY{y} has {len(vals)}/12 CPI months")
        fy[y] = sum(vals) / 12
    return fy


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

def build():
    cells = load_cells()
    cutoff = transfer_cutoffs(cells)
    problems, notes = [], []
    years = list(range(FIRST_FY, LAST_FY + 1))
    series = {}

    for y in years:
        # ---- operating spending (General Fund) ----------------------------
        op = {}
        for key, _label, names in OPERATING:
            op[key] = pick(cells, "gf_expenditures", names, y, before=cutoff) or 0

        printed = pick(cells, "gf_expenditures", ["total expenditures"], y)
        transfers = pick(cells, "gf_expenditures", ["total transfers"], y)
        grand = pick(cells, "gf_expenditures",
                     ["total expenditures and other financing uses"], y)
        # The FY2005 report prints only the grand total and the transfers line.
        derived = printed is None and grand is not None and transfers is not None
        if derived:
            printed = grand - transfers

        if printed is None:
            problems.append(f"FY{y} operating: no total to check against")
        else:
            s = sum(op.values())
            if abs(s - printed) > TOLERANCE:
                problems.append(f"FY{y} operating components {s:,} vs total "
                                f"{printed:,} (diff {s - printed:,})")
            elif s != printed:
                notes.append(f"FY{y} operating off by {s - printed} (ACFR rounding)")

        # ---- capital spending ---------------------------------------------
        cap = {}
        for key, _label, names in CAPITAL:
            cap[key] = pick(cells, "capital_expenditures", names, y) or 0
        cap_total = pick(cells, "capital_expenditures",
                         ["total capital projects fund expenditures",
                          "total expenditures"], y)
        if cap_total is None:
            problems.append(f"FY{y} capital: no printed total")
        else:
            s = sum(cap.values())
            if abs(s - cap_total) > TOLERANCE:
                problems.append(f"FY{y} capital components {s:,} vs printed total "
                                f"{cap_total:,} (diff {s - cap_total:,})")
            elif s != cap_total:
                notes.append(f"FY{y} capital off by {s - cap_total} (ACFR rounding)")

        cap_aid = pick(cells, "capital_aid",
                       ["total capital projects fund aid revenues",
                        "total revenues"], y) or 0

        # ---- revenue (General Fund) ---------------------------------------
        rev = {}
        for key, _label, names, exc in TAXES:
            rev[key] = pick(cells, "gf_revenues", names, y, exc) or 0
        tax_total = pick(cells, "gf_revenues", ["total taxes"], y)
        if tax_total is not None:
            s = sum(rev[k] for k, _l, _n, _e in TAXES)
            if abs(s - tax_total) > TOLERANCE:
                problems.append(f"FY{y} tax components {s:,} vs printed Total Taxes "
                                f"{tax_total:,} (diff {s - tax_total:,})")
            elif s != tax_total:
                notes.append(f"FY{y} taxes off by {s - tax_total} (ACFR rounding)")

        for key, _label, names in NONTAX:
            rev[key] = pick(cells, "gf_revenues", names, y) or 0
        rev["other_financing"] = pick_sum(cells, "gf_revenues", OTHER_FINANCING, y)

        rev_total = pick(cells, "gf_revenues", ["total revenues"], y)
        if rev_total is None:
            problems.append(f"FY{y} revenue: no printed total")
        else:
            s = sum(rev.values())
            if abs(s - rev_total) > TOLERANCE:
                problems.append(f"FY{y} revenue components {s:,} vs printed total "
                                f"{rev_total:,} (diff {s - rev_total:,})")
            elif s != rev_total:
                notes.append(f"FY{y} revenue off by {s - rev_total} (ACFR rounding)")

        # ---- borrowing ------------------------------------------------------
        borrow = {}
        for key, _label, names in BORROWING:
            borrow[key] = pick(cells, "fund_balances", names, y) or 0

        series[y] = {
            "operating": op,
            "debt_service": transfers or 0,
            "operating_total": printed,
            "capital": cap,
            "capital_total": cap_total,
            "capital_aid": cap_aid,
            "revenue": rev,
            "revenue_total": rev_total,
            "borrowing": borrow,
        }

    if problems:
        print(f"RECONCILIATION FAILURES ({len(problems)}):")
        for p in problems[:60]:
            print("  " + p)
        sys.exit(1)

    gdp_path = os.path.join(OUT, "gdp.json")
    gdp = {}
    if os.path.exists(gdp_path):
        gdp = {int(k): v for k, v in json.load(open(gdp_path))["fiscal"].items()}

    pop = load_population()
    fpop = fiscal_population(pop)
    cpi = load_cpi()
    base = cpi[LAST_FY]

    payload = {
        "meta": {
            "first_fy": FIRST_FY,
            "last_fy": LAST_FY,
            "dollar_base_fy": LAST_FY,
            "cpi_series": "CUURS12ASA0",
            "gdp_source": "BEA CAGDP1, current-dollar GDP, five counties",
            "gdp_first_fy": min(gdp) if gdp else None,
            "gdp_last_fy": max(gdp) if gdp else None,
            "generated_from": ["ACFR FY2005", "ACFR FY2015", "ACFR FY2025"],
        },
        "labels": {
            "operating": {k: l for k, l, _n in OPERATING},
            "capital": {k: l for k, l, _n in CAPITAL},
            "taxes": {k: l for k, l, _n, _e in TAXES},
            "nontax": {k: l for k, l, _n in NONTAX},
        },
        "years": [],
    }

    for y in years:
        s = series[y]
        payload["years"].append({
            "fy": y,
            "population": round(fpop[y]),
            "cpi": round(cpi[y], 4),
            "gdp": round(gdp[y]) if y in gdp else None,
            "deflator": round(base / cpi[y], 6),
            "operating": s["operating"],
            "debt_service": s["debt_service"],
            "operating_total": s["operating_total"],
            "capital": s["capital"],
            "capital_total": s["capital_total"],
            "capital_aid": s["capital_aid"],
            "revenue": s["revenue"],
            "revenue_total": s["revenue_total"],
            "borrowing": s["borrowing"],
        })

    # Budget years: OMB basis, deliberately kept out of the audited series.
    omb_path = os.path.join(OUT, "omb_budget.json")
    if os.path.exists(omb_path):
        omb = json.load(open(omb_path))
        payload["budget_years"] = [
            {"fy": 2026, "basis": "OMB FY2026 budget as modified, June 2026",
             "col": "fy2026_modified"},
            {"fy": 2027, "basis": "OMB FY2027 adopted budget, June 2026",
             "col": "fy2027_adopted"},
        ]
        for b in payload["budget_years"]:
            c = b.pop("col")
            b["total_expense"] = omb["net_total_expense"][c]
            b["city_funds"] = omb["city_funds_and_capital_transfers"][c]
            b["state_aid"] = omb["state_categorical"][c]
            b["federal_aid"] = omb["federal_categorical"][c]
            b["other_grants"] = omb["other_categorical"][c]
            b["debt_service"] = omb["debt_service"][c]
            # No Census estimate exists past 1 July 2025, so per-capita views
            # for these years reuse the latest published population and say so.
            b["population"] = round(fpop[LAST_FY])
            b["population_note"] = f"population held at the {LAST_FY} estimate"

    with open(os.path.join(SITE, "data.json"), "w") as f:
        json.dump(payload, f, separators=(",", ":"), sort_keys=True)

    # A tidy long-format CSV so the numbers can be checked without the site.
    with open(os.path.join(SITE, "nyc-budget-fy2000-fy2025.csv"), "w",
              newline="") as f:
        w = csv.writer(f)
        w.writerow(["fiscal_year", "measure", "category", "amount_thousands",
                    "population", "cpi_ny_metro", "deflator_to_fy%d" % LAST_FY])
        for y in years:
            s_ = series[y]
            row_meta = [round(fpop[y]), round(cpi[y], 4),
                        round(base / cpi[y], 6)]
            for k, v in sorted(s_["operating"].items()):
                w.writerow([y, "operating", k, v] + row_meta)
            w.writerow([y, "operating", "debt_service", s_["debt_service"]] + row_meta)
            for k, v in sorted(s_["capital"].items()):
                w.writerow([y, "capital", k, v] + row_meta)
            w.writerow([y, "capital", "capital_aid_revenue", s_["capital_aid"]] + row_meta)
            for k, v in sorted(s_["revenue"].items()):
                w.writerow([y, "revenue", k, v] + row_meta)
            for k, v in sorted(s_["borrowing"].items()):
                w.writerow([y, "borrowing", k, v] + row_meta)

    for n in notes:
        print("note: " + n)
    print(f"reconciled and wrote data.json for FY{FIRST_FY}-FY{LAST_FY}")
    a, b = years[0], years[-1]
    print(f"  population FY{a} {fpop[a]:,.0f} -> FY{b} {fpop[b]:,.0f}")
    print(f"  CPI FY{a} {cpi[a]:.1f} -> FY{b} {cpi[b]:.1f} "
          f"({cpi[b]/cpi[a]:.2f}x)")
    return payload


if __name__ == "__main__":
    build()
