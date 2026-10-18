# Strategy View

An installable Tampermonkey research view for stocks F&O gainers pages. **v1.7.0 ranks the largest current one-minute rise first**, after the daily-gain grouping, and completely removes stocks in the results window. The installed script needs no server, API key or broker credentials and never places orders.

## Install or update

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome or Edge. In its extension settings, enable **Allow user scripts** if required; see [the permission guide](https://www.tampermonkey.net/faq.php#Q209).
2. In Tampermonkey’s dashboard, use **Utilities → Import from file** and choose **[dist/groww-strategy.user.js](dist/groww-strategy.user.js)**. Replace the existing Groww Strategy View with **v1.7.0**; keep one enabled copy.
3. Refresh all open Groww gainers tabs after updating: [15-minute gainers](https://groww.in/futures-and-options/top-gainers?interval=FIFTEEN_MINUTES) or [1-day gainers](https://groww.in/futures-and-options/top-gainers?interval=ONE_DAY). Both have the remembered **Strategy view** toggle. Strategy view always uses the current 15-minute gainers for membership.

## Strict results exclusion

F&O universe’s bulk calendar combines both event arrays, selects financial-results records, and reads their date from `corporateEventPillDto.primaryDate`. Stocks match by `gsin`, with `searchId` fallback.

The inclusive window runs **from the previous NSE trading session through the next session**, including all intervening weekends and holidays. For example, a Monday scan excludes Friday’s results as well as results over the weekend, on Monday and on the next session. NSE’s F&O holiday calendar determines those session dates. Missing year coverage, including at a year boundary, cannot be assumed clear.

A results stock has **no scanner row, calls panel, option-chain link, manual call request or automatic call check within Strategy view**. Its one-minute rise and the **Eligible only** setting cannot override this rule. The page reports only the aggregate number excluded; it does not list their names. The original F&O universe view remains available through the toggle.

The shared gate runs before display, selection, option-request stages and publication. If a calendar update newly excludes a stock, its panel closes, selection clears, cached calls and spike history are removed, queued/in-flight option tasks are cancelled, and late responses are discarded. The same checks apply to restored snapshots and cross-tab updates.

**Valid same-day calendar coverage is required.** Without it, affected stocks are withheld and the dashboard shows **Results check unavailable**. The first activation each Indian calendar day scans the calendar, with hourly refreshes while active and a **Refresh calendar** button for changed schedules. A failed refresh may retain valid same-day coverage; yesterday’s scan cannot substitute for today’s coverage.

## Candidate coverage and fresh prices

The 15-minute gainers feed supplies **candidate membership and original rank only**, refreshed about once a minute. The script requests a limit of 500 rather than truncating the response locally. Checks of F&O universe’s current endpoint still returned **at most 100 candidates**, with no exposed pagination mechanism. It may return fewer. This is the available feed’s coverage, not a promise to monitor the entire F&O universe. If F&O universe returns a larger list, the scanner can process it using quote batches of at most 100 symbols.

The membership feed can be cached for minutes, delaying entrants. Its LTP and day-change fields are never substituted for current quotes. A new entrant begins collecting history when observed; earlier moves are unseen.

During a normal open session, the scanner targets **fresh F&O universe NSE CASH quotes every 10 seconds** for the allowed candidates. Price and daily percentage come from the same quote’s LTP and previous close:

`day change % = (LTP / previous close − 1) × 100`

The source quote time appears below each stock price. Missing, inconsistent, duplicate, backwards or stale observations cannot create new samples or confirm a spike. Quotes older than 30 seconds cannot qualify. Fetch time does not make an old quote fresh. The linked stock page also uses NSE by default; prices checked at different times can still differ as trades arrive. F&O universe’s own refresh speed may be slower than the sampling target.

## One-minute rise and priority

The prominent **Rise in ~1m** uses source-timestamped observations:

`1m rise % = (current price / sampled price approximately 60 seconds earlier − 1) × 100`

**Every positive return is shown, including values below 1%.** Tiny positive values display as **<0.01% rise**, rather than rounding to zero. Valid flat and negative returns remain visible too.

After removing results stocks:

1. Stocks passing fresh-price checks and with daily change **strictly above +0.2%** come first. Other allowed stocks remain below them.
2. Within each group, valid **current one-minute returns sort descending immediately**.
3. Equal returns use the newest source observation, then F&O universe’s original 15-minute rank.
4. Warming or unavailable one-minute windows appear last within their group.

A new **+1.8%/1m** first hit therefore outranks a confirmed **+1.2%/1m** when both pass the daily rule. Confirmation, old burst count, five-minute return and IV never boost rank. The top row is not necessarily F&O universe’s largest 15-minute gainer: F&O universe’s list defines the monitored candidates, while the current one-minute percentage determines their order.

The latest sample-to-sample change and highest one-minute return **observed in the last 60 seconds** appear as secondary context with timestamps. Neither changes ranking. A historical peak does not describe the current return. Expand details for five-minute/15-minute context, acceleration, sampled highs and retained burst peaks.

**Eligible only** additionally requires a fresh qualifying selling quote. The highest-ranked fully eligible stock is highlighted. Eligibility does not require a strong-rise badge and does not establish reversal probability.

## Strong one-minute badges

**≥1%/1m is a provisional strong-rise badge, not a visibility cutoff.** The first qualifying source quote shows amber **Spike detected · verifying**. A second qualifying quote **10–30 seconds later**, with no intervening observed failure, promotes it to green **Confirmed active**. This checks persistence across observations; it does not independently verify F&O universe’s price. A failed first hit never increases the confirmed burst count.

One continuous confirmed strong episode counts once. Another distinct burst requires the **complete one-minute return to remain below 1% for 60 observed seconds**. Five-minute history is not required to rearm. Warming/unknown windows cannot prove a reset. Confirmed events remain for 15 minutes after their last qualifying one-minute observation. Two retained distinct bursts can show **Repeated surges**; a recent confirmed burst with current one-minute return at/below zero can show **Cooling**.

Five-minute returns, including a rise of 2% or more, are **context only**. They cannot create, confirm or extend a strong-burst count on their own. Acceleration and a new sampled 15-minute high also create no extra bursts.

The engine retains **15 minutes plus 10 seconds** of source observations. A lookback requires complete history, an anchor inside the window within ten seconds of its boundary, and no source gap exceeding 30 seconds. Actual one-minute comparisons can span 50–60 seconds; clickable explanations show prices, source times and elapsed seconds. Prices are never interpolated. Gaps rebuild affected windows and require reconfirmation without assuming a distinct burst merely because collection stopped. Conflicting prices at one timestamp interrupt confirmation.

Leave Strategy view visible. Collection runs **09:15–15:30 IST** during verified normal NSE sessions. With uninterrupted observations from the opening, one-minute detection warms around 09:16, five-minute context around 09:20 and 15-minute context around 09:30. Each new trading session resets history; overnight gaps are excluded. Special sessions are not inferred. Inactive tabs, browser sleep, provider delays and source gaps can interrupt coverage. The dashboard shows monitored count, last successful update and interruptions.

## Controls and interaction

- Click the **stock name** to open its normal F&O universe `/stocks/{searchId}` page in a new tab.
- Click **elsewhere on the row**, or press Enter/Space on a focused row, for its calls on the right.
- Click **tags or return explanations** for the calculation, prices, source times, actual elapsed window and confirmation details.
- Up to two pattern badges are shown; expand additional context and historical peaks beneath them.
- **Open chain ↗** opens the native option chain directly. Its column scrolls with the table.
- **Thresholds** changes daily gain, call distance and the near-target exception. The one-minute strong threshold does not auto-adjust.
- **F&O universe view** restores the original page and pauses collection. One visible Strategy tab collects for the open copies.
- **Export diagnostics** prepares the archive, then shows **Download diagnostic archive (.jsonl)** to save it.

Updates preserve scrolling, pointer clicks, focus, explanations and expanded details, and avoid unchanged DOM redraws.

## Calls and quoted credit

**All stock and option pricing comes from F&O universe.** NSE is used only for its holiday calendar.

F&O universe’s chain supplies listed expiries, lot sizes, contract IDs, exchange tokens, Greeks and droplet markers. The nearest available listed monthly expiry is selected initially. Timestamped F&O universe option quotes supply LTP/OI/volume; a separate F&O universe order book supplies selling bid, ask and quantities. Tokens, stock, expiry and fractional strikes are checked before joining records. Missing live values never fall back to embedded HTML or NSE prices.

The first ten allowed stocks passing daily/fresh-price checks are checked automatically under the **new one-minute order**. Background calls refresh about every 30 seconds; an open panel targets updates about every ten seconds while visible. **Refresh calls** forces an update. Metadata normally refreshes every 60 seconds. Source limits can delay requests. Results gating is checked throughout the request, even if a stock becomes excluded after loading starts.

The panel shows ascending strikes, initially the first three in range; **Show next 3 strikes** loads later rows. The main range is strictly above **10%** from the underlying option-snapshot quote. The enabled near-target exception adds at most one closest strike at/below target but strictly within 0.5 percentage points below it, preferring an exact target. At 10%, this permits **strictly above 9.5%**. Later strikes follow their listed intervals, not another 10% increment. At ₹96.25, ₹105 is only 9.09% away and remains outside the range.

**Liquidity follows F&O universe’s crossed-droplet flag only:** a valid record without `ILLIQUID` passes, a flagged record fails, and missing/malformed markers remain unknown. OI, volume, spread and depth are informational; no numerical liquidity cutoffs apply. Empty book levels supply no selling price. Quote availability and freshness are separate from this classification.

**Gross quoted credit per lot = F&O universe selling bid × lot size.** It is the conditional maximum gross profit assuming a fill at that bid and expiry at/below strike, before costs. LTP is a separate reference with its own source time; an old LTP can coexist with a newer book. Live eligibility requires an underlying quote no older than **30 seconds** and a book no older than **60 seconds**, in the current open session. Closed/stale snapshots remain labelled. An uncovered short call has unlimited potential loss; distance does not cap it.

Reported option IV is shown separately, with the available metadata/freshness information. A stock spike is never used to infer IV, and IV does not affect scanner order.

## Local research archive

Public observations, allowed candidate membership, source timestamps, current returns, latest interval/peak context, signal transitions, ranks and coverage are stored locally in IndexedDB. The v1.5 single-hit/count-first baseline sees the same source observations for research comparison. Nothing is uploaded. One collector batches/compresses records about once a minute and flushes on pause/export; an abrupt browser exit may lose the last buffered minute.

The combined archive retains the newest **20 recorded sessions or 50 MiB of payload/metadata budget**, whichever fits first, deleting oldest chunks first. Old and new signal versions share that cap. Storage can be unavailable or evicted; logging failure is shown but never stops monitoring.

New frames use **schema 2 / signal version 3**. Existing column positions remain stable, and the export includes column definitions for both schemas. **Version 2 and version 3 signal summaries remain separate**, including confirmation rates, burst counts, readiness and forward price paths. Old five-minute-created events never inflate the new one-minute count. Newly excluded stocks are omitted from current records and transitions; previously recorded historical frames remain historical.

The `.jsonl` export begins with schemas, definitions and review summaries. These include first-hit rejection rate, confirmation delay, ranking changes, quote age, interruptions and subsequent one-, five- and 15-minute source-price paths with maximum upward/downward excursions. Unresolved first hits do not enter rejection-rate denominators. Missing membership or source coverage makes forward paths incomplete. No missing prices are reconstructed; these outcomes are stock-price changes, not trade profits.

The initial review minimum for the **new signal definition** is **20 sessions and 100 confirmed bursts across at least ten sessions**, reporting incomplete coverage separately. This is not statistical proof. Record every threshold variation and reserve later sessions for evaluation. There are no automatic threshold changes, volatility-adjusted triggers, reversal probabilities or trade execution.

## Data access

Only settings, public calendars, public quotes, sampled history and public diagnostics are stored locally. Public requests are scoped to F&O universe’s ranking/calendar/option/quote/book endpoints and NSE’s holiday endpoint. Quote-batch POSTs request only public symbols; other requests are public GETs. Requests omit cookies and credentials. There are no account, order, holdings, external-library or telemetry calls. HTTP 429/503 has bounded backoff, and a reserved lane prevents background option work from filling both quote-request slots.

## Verification and remaining live acceptance

The bundled build passes **106 regression tests**, its syntax check, and the **42-minute controlled replay (253 frames)**. Detailed test output and the replay summary accompany `verification-v1.7.json`.

The regression suite covers exact thresholds, small rises, immediate one-minute ordering, ties, one-minute-only confirmation/rearming, migration, peaks, missing/duplicate/backwards quotes, suspension and session reset. It also covers results dates and coverage, changed calendars, cancellation/late-response races, allowed-stock pricing, contract identity, droplet classification, retention and separate archive summaries. See `verification-v1.7.json` for recorded results.

A **42-minute controlled replay passed: 253 polling steps at ten-second spacing**. It verifies a larger first hit above a smaller confirmed move, tiny positive rises, five-minute-only moves producing no strong burst, distinct strong bursts, snapback rejection, new entrants and source gaps. Synthetic in-app browser checks exercise the production bundle through a development-only GM adapter. These checks do not establish live signal quality.

**Opening-period and a separate uninterrupted ≥20-minute live test in actual Tampermonkey remain required.** At this update on **Sunday, 18 October 2026**, the connected in-app browser does not expose an installed Tampermonkey environment. Verify extension permissions, quote/day-change consistency, call books, collector handover and smooth interaction in Chrome/Edge during a normal session before calling this live-accepted. The in-app browser can prepare the diagnostic export link but does not verify a completed blob download; saving in Chrome/Edge remains unverified. The multi-session signal review remains pending.

Earlier public-data checks on 16 October 2026 established why ranking-feed prices cannot be treated as fresh: 13 polls over two minutes produced only three cached feed versions while the stock quote source moved. A separate v1.5 public-data observation showed changing stock and option books, including bid × lot credit matching F&O universe’s native chain. Those historical checks support the pricing-source choice; they do not validate v1.7 signals or replace the required live acceptance.

## Development

Node.js 20+; no package dependencies:

```sh
npm run build
npm test
node scripts/replay.mjs
npm run preview
```

Local preview: `http://127.0.0.1:8765/futures-and-options/top-gainers`.

- `?scenario=live&reset=1`: actual public sources and clock, without fabricated history.
- `?scenario=normal&reset=1`: labelled synthetic quotes/history.
- `calendar-failure`, `results-change`, `options-failure`, `closed`, `preopen`, `near-target`: focused replay scenarios.
- `vmm-audit`: historical captured metadata, with historical books explicitly unavailable.

Public fixtures, preview server and development helpers are excluded from the installable bundle.
