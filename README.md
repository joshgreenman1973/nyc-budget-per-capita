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
| Expense budget | 2026–2027 | Office of Management and Budget, adopted budget for fiscal 2027 |

Fiscal years 2026 and 2027 are budgeted rather than audited and sit on the budget
basis, which covers operations and debt service but not capital. They are drawn
hatched, behind a divider, and are never blended into the audited series.

## How it is built

    ./scripts/fetch_sources.sh          # ~60 MB of source documents, not committed
    python3 scripts/extract_acfr.py     # PDF tables  -> data/out/acfr_raw.csv
    python3 scripts/extract_omb.py      # budget      -> data/out/omb_budget.json
    python3 scripts/build_series.py     # reconcile   -> data.json + the CSV

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
