# The New York City ledger

What the city spends, what it spends it on and where the money comes from, every
fiscal year since 2000, from the audited books.

Live: https://joshgreenman1973.github.io/nyc-budget-per-capita/

Two toggles run the whole page: totals or per resident, and whether dollars are
adjusted for inflation.

## What is in it

| Series | Fiscal years | Source |
|---|---|---|
| Operating spending by function | 2000–2025 | General Fund expenditure schedule |
| Debt service | 2000–2025 | General Fund transfers to debt service funds |
| Capital spending by function | 2000–2025 | Capital Projects Fund expenditure schedule |
| Revenue by source, including the federal and state split | 2000–2025 | General Fund revenue schedule |
| Bonds issued, premium and refunding | 2000–2025 | Governmental funds statement |
| Expense budget, total and by agency/function | 2026–2027 | Office of Management and Budget, adopted budget for fiscal 2027 |
| City GDP (denominator) | 2002–2024 | Bureau of Economic Analysis county series, five boroughs, current dollars |

The page also has a growth calculator (any year to any year, total or by
category, honoring the per-capita and inflation toggles), amounts/share-of-total
toggles on the category charts, click-to-isolate trend lines from every legend
and a spending-as-share-of-GDP view built on BEA county GDP.

Fiscal years 2026 and 2027 are not audited and sit on the budget basis, which
covers operations and debt service but not capital. Fiscal 2026 has closed but
awaits its autumn audit, so its figure is the city's June 2026 year-end estimate;
fiscal 2027 is the adopted budget for the year under way. Category detail for the
two budget years comes from the document's 141 agency-level tables, each agency
assigned to a function using the Comptroller's own classification of agency
codes, reconciling to the budget's printed total. Both years are drawn hatched,
behind a divider, and are never blended into the audited series.

## How it is built

    ./scripts/fetch_sources.sh          # ~75 MB of source documents, not committed
    python3 scripts/extract_acfr.py     # PDF tables  -> data/out/acfr_raw.csv
    python3 scripts/extract_omb.py      # budget      -> data/out/omb_budget.json
    python3 scripts/extract_gdp.py      # BEA GDP     -> data/out/gdp.json
    python3 scripts/build_series.py     # reconcile   -> data.json + the CSV

When deploying, bump the `?v=` stamp on the asset links in index.html (and the
data.json fetch in app.js) so cached copies of one file are never paired with
fresh copies of another.

Requires `pymupdf` and `openpyxl`.

`extract_acfr.py` reads the ten-year trend schedules out of the Comptroller's
reports by word coordinates rather than text order, because the statistical
section is typeset sideways in the older reports and the columns are right
aligned. It handles the rotation, fits a uniform column grid, rejoins amounts the
PDF splits across tokens, and reads each page's own year headers.

`build_series.py` maps every published line onto a canonical category and then
**checks each sum against the total the report itself prints, for every year**.
A mismatch of more than a thousand dollars fails the build rather than warning.

## What was checked against other sources

* The Comptroller's release on the fiscal 2025 report gives General Fund revenues
  of $117.660 billion and expenditures of $117.690 billion. These figures
  reproduce both exactly, plus the stated year-over-year changes in total revenue
  ($4.845 billion), total expenditure ($4.717 billion), tax revenue ($6.139
  billion) and state categorical grants ($791 million).
* The Independent Budget Office's revenue and spending summary overlaps for 21
  years, fiscal 2000 through 2020. Total taxes, state aid and federal aid agree in
  all 21 within its $1 million rounding; total revenues and total expenditures
  agree in 20, the exception being fiscal 2020, whose final column appears to be a
  pre-audit estimate.
* The fiscal 2016 report, which is not used to build the series, was extracted
  independently and matched on 30 measures across fiscal 2007 to 2016. That also
  confirms the city does not restate these schedules.

Discrepancies found and resolved are written up in the methodology section on the
page, including a memo line in the fiscal 2025 report whose capital outlay figures
for fiscal 2022 and 2023 are two to three times the detailed schedule's.

## Files

    index.html  styles.css  app.js     the site
    data.json                          what the page loads
    nyc-budget-fy2000-fy2025.csv       tidy long-format download
    data/out/acfr_raw.csv              every extracted cell, with page numbers
    scripts/                           fetch, extract, reconcile
