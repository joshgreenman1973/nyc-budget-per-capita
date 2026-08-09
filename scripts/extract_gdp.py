#!/usr/bin/env python3
"""
New York City gross domestic product by fiscal year, from the Bureau of
Economic Analysis county series.

BEA publishes measured GDP for every county; the city is the sum of its five.
Table CAGDP1, line code 3, is current-dollar GDP -- the right basis for a ratio
against spending, which is also in current dollars. Line code 1 is chained real
GDP and is deliberately not used: dividing nominal spending by real GDP would
mix bases and drift by the size of cumulative inflation.

City fiscal years run 1 July to 30 June, so a fiscal year straddles two
calendar years and its midpoint is 1 January of the second. Fiscal-year GDP is
therefore the mean of the two calendar years it spans, which centres the
denominator on that midpoint. That costs the most recent fiscal year: FY2025
would need calendar 2025, which BEA has not published.
"""

import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
OUT = os.path.join(HERE, "..", "data", "out")

NYC_FIPS = {
    "36005": "Bronx", "36047": "Brooklyn", "36061": "Manhattan",
    "36081": "Queens", "36085": "Staten Island",
}
CURRENT_DOLLAR_LINE = "3"


def run():
    path = os.path.join(RAW, "cagdp1", "CAGDP1_NY_2001_2024.csv")
    if not os.path.exists(path):
        sys.exit(f"FATAL: {path} missing; run scripts/fetch_sources.sh")

    by_county = {}
    years = []
    with open(path, encoding="latin-1") as f:
        for row in csv.DictReader(f):
            if not row.get("Description"):
                continue
            fips = row["GeoFIPS"].strip().strip('"')
            if fips not in NYC_FIPS or row["LineCode"] != CURRENT_DOLLAR_LINE:
                continue
            if "current" not in row["Description"].lower():
                sys.exit(f"FATAL: line {CURRENT_DOLLAR_LINE} is not current-dollar "
                         f"GDP but {row['Description']!r}")
            vals = {}
            for k, v in row.items():
                if k.isdigit():
                    try:
                        vals[int(k)] = float(v)
                    except (TypeError, ValueError):
                        sys.exit(f"FATAL: {NYC_FIPS[fips]} {k} is not numeric: {v!r}")
            by_county[fips] = vals
            years = sorted(vals)

    missing = set(NYC_FIPS) - set(by_county)
    if missing:
        sys.exit(f"FATAL: no GDP rows for {[NYC_FIPS[m] for m in missing]}")

    # Calendar-year city GDP, in dollars (BEA reports thousands).
    calendar = {}
    for y in years:
        calendar[y] = sum(by_county[f][y] for f in NYC_FIPS) * 1000

    # Fiscal year Y spans calendar Y-1 and Y; its midpoint is 1 January of Y.
    fiscal = {}
    for y in years:
        if y - 1 in calendar:
            fiscal[y] = (calendar[y - 1] + calendar[y]) / 2

    if not fiscal:
        sys.exit("FATAL: no fiscal-year GDP produced")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "gdp.json"), "w") as f:
        json.dump({"calendar": {str(k): v for k, v in calendar.items()},
                   "fiscal": {str(k): v for k, v in fiscal.items()},
                   "source": "BEA CAGDP1 line 3, current-dollar GDP, five counties"},
                  f, indent=1)

    lo, hi = min(fiscal), max(fiscal)
    print(f"NYC GDP: calendar {years[0]}-{years[-1]}, fiscal FY{lo}-FY{hi}")
    print(f"  CY{years[0]} ${calendar[years[0]]/1e12:.3f}T -> "
          f"CY{years[-1]} ${calendar[years[-1]]/1e12:.3f}T")
    print(f"  FY{hi} ${fiscal[hi]/1e12:.3f}T")


if __name__ == "__main__":
    run()
