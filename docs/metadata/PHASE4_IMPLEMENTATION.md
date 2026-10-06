# Phase 4: STAC API 1.0.0

Status: implementation and fixture-backed external validation; deployment
verification remains an operator responsibility.

## Step 1: Core and Features

The opt-in `/api/v1/stac` service preserves Phase 2/3 public eligibility,
fresh primary-backed reads, asset verification, and immutable frame/revision
identities. Collection Item lists accept inclusive WGS84 `bbox` and RFC3339
`datetime` predicates. Bounding boxes support four or six coordinates,
antimeridian crossings, and degenerate query boxes. Two-dimensional Items
have elevation zero for three-dimensional queries. Limits default to 50,
clamp to 100, and cannot be zero or negative. Next links retain the filters.

HTTP supports GET and HEAD, content negotiation, ETags, and read-only method
gates. `/items/{id}` is the canonical Item identity. An Item accessed through
a collection retains a self link to that route and adds `rel: canonical`
pointing to `/items/{id}`. Indexers should prefer `canonical` over `self`
when present; route representations and their ETags can differ without
creating a second canonical identity. Public errors add STAC `code` and a
fixed `description`, retaining `error` as a compatibility alias. Internal
exception messages are never used as public query error codes. Unsupported
methods reach the Pages catch-all and return the same JSON exception with 405.
Plain `Accept: application/json` also accepts GeoJSON and OpenAPI JSON;
responses retain their specific media types. Public responses, including
errors and 304s, allow credential-free cross-origin reads with
`Access-Control-Allow-Origin: *` and expose `ETag` and `Link`. OPTIONS permits
GET/HEAD, plus POST on `/search`, with `Content-Type` and `If-None-Match`.
Preflight does not build or probe the publication; the STAC feature gate applies.
Conditional 304 handling applies only to GET and HEAD. POST search ignores
`If-None-Match`, returns 200 results, and uses `Cache-Control: no-store`.

## Step 2: Service Resources

The landing page and `/conformance` expose the same conformance list.
`service-desc` points to `/api` (OpenAPI 3.0.3 JSON with the OpenAPI media
type); `service-doc` points to `/api.html`. No optional search extensions
(Filter, Query, Sort, Fields, Context, or Transaction) are advertised.
The OpenAPI document describes the service, but `oas30` is not advertised:
there has not been an independent OGC OpenAPI requirements-class run.

## Step 3: Item Search

GET and JSON POST `/search` support `bbox`, `datetime`, `intersects`, `ids`,
`collections`, `limit`, and the opaque `cursor` from next links. POST next
links contain their method and complete body. All GeoJSON geometry types are
supported, including bounded nested GeometryCollections. Bbox and intersects
together are rejected. Queries are bounded to 100 IDs/collections, 256
positions and 32 GeometryCollection members in total, nesting depth 8,
64 KiB of geometry text, and a 128 KiB POST body. Supplied GeoJSON `bbox`
metadata is discarded; query bounds are computed once from coordinates.
Polygon rings, including holes and nested MultiPolygon members, must be
closed with at least four positions; empty coordinate members are rejected.
Unexpected Turf geometry rejections return 400 `invalid_intersects`, not a
retryable publication failure. Bbox values use decimal numeric syntax (not
hex or binary), and datetime hours are 00-23 (not `24:00`). GET geometries
must also fit the host's URL limit; use POST for larger valid geometries.
Disjoint bounds and cheap ID/collection/time predicates reject Items before
Turf runs. Exact intersections have a per-request budget of 16,384
query-position tests across Items. A 256-position query can therefore evaluate
at most 64 overlapping Items. Excess work returns an uncached 400
`intersects_budget_exceeded`, never a partial result; narrower collections,
IDs or datetime filters can reduce candidate work.

Search filters the same fresh, verified publication that browse and the
operator report use. No second SQL eligibility filter can silently remove
saved history during a same-source re-transcode. Hidden, private, retracted,
unverified, and stale history remain excluded by that authoritative publication.
Search results use stable ID ordering; GET and POST next links remain usable
even if the previously returned Item disappeared. Cursors are opaque: clients
must use only values supplied by next links, not construct them from IDs.
Collection list cursors retain their existing exact-match behavior.

The unused SQL candidate leg, its misleading standalone index tests, and
unmerged migration 0057 were removed. Phase 4 requires no new migration beyond
Phase 3's 0056. The full publication build and asset-probe budget still apply;
this is not a claim of unbounded-catalog scalability. There is no new feature
flag beyond `STAC_ENABLED=true`; frame capture remains separately opt-in.

## Step 4: External Conformance

The pinned official `stac-api-validator==0.6.8` passed Core, Collections,
Features and Item Search with pagination enabled against the actual HTTP
handler and a freshly migrated SQLite fixture (120 immutable frame Items
plus a separate current Item). The final report is `Errors: none`.
Asset HEAD responses are controlled fixture responses, not production
origin verification. Schema validation fetches official STAC 1.1.0 and
extension schemas. This is STAC API 1.0.0 over STAC resource 1.1.0.

Warnings remain recommendations only: collection summaries, link titles,
large static Item link arrays and lowercase identifier style. Immutable
identifiers are not rewritten to silence stylistic recommendations.
The OGC Core and GeoJSON declarations are the requirements inherited by
the STAC Features implementation. A separate OGC TEAM Engine certification
run has not been performed; the STAC suite covers a subset of OGC behavior.

Run the opt-in test with `STAC_EXTERNAL=true` and:

```text
npm run test -- functions/api/v1/stac/external.test.ts
```

`uv` is required and supplies an isolated pinned validator environment.
CI pins uv 0.11.29. All Python validator/client invocations use the same
`--exclude-newer 2026-10-02T00:00:00Z` cutoff in addition to top-level
package versions, bounding transitive dependency resolution. The served
OpenAPI document also passes `openapi-spec-validator==0.7.1`; that check
is part of the opt-in external test, not a separate OGC `oas30` certification.
The test waits on a bound ephemeral HTTP socket, enables UTF-8 Python
output on Windows, and closes the socket in all outcomes. The
`STAC API Conformance` workflow runs the same test on relevant PRs.

## Step 5: Client Interoperability

Fixture-backed executable results:

| Client | Check | Result |
| --- | --- | --- |
| PySTAC Client 0.9.0 | Collection discovery, GET/POST paging at 17 Items/page, exact datetime filter | Passed locally, 120 unique matching Items |
| STAC Browser 5.1.0 | Real built browser in Chromium served from a second origin; root, collection and Item navigation, actual search-page submission, cross-origin GET/JSON POST search, readable errors and ETag, no page errors | Passed locally after review fixes; Item and search screenshots retained by CI |
| STAC-GeoParquet 0.8.2 | Independent requests-based next-link traversal at 19 Items/page, index ingestion, Parquet round-trip | Passed locally; all 120 IDs and geometries retained |
| GDAL 3.12.4 OAPIF driver through Pyogrio | Direct collection connection with 17-Item pages, exact IDs, geographic CRS and nonempty geometry | Passed locally; 120 Items, independent of the QGIS provider |
| QGIS 3.34.4-Prizren OAPIF provider | Real offscreen PyQGIS layer, all 120 features, geographic CRS and nonempty geometry | Passed in Linux CI; not installed on the local Windows host |

Run `functions/api/v1/stac/clients.test.ts` with `STAC_CLIENTS=true`.
`STAC_BROWSER_DIST` must point to a separately built STAC Browser 5.1.0
distribution (`SB_historyMode=hash npm run build` in its checkout).
CI fetches and checks exact Browser commit
`c78b78f3434fdd34d4192f7044194dae6a15172d`, rather than trusting a movable tag.
Set `STAC_QGIS_PYTHON` to the Python executable that can import `qgis.core`
to include the QGIS test. Missing tools are explicit skips in normal unit
tests, not claimed passes. The dedicated CI job sets all three variables.
These tools are test-only and do not enter the application's dependencies.

STAC-GeoParquet is an independent bulk indexing path, not a hosted registry
submission. No production node was submitted to a third-party service.
Fixture-backed success is not a substitute for checking the deployed
node's actual catalog, anonymous assets, CORS and canonical origin.

## Security Review Follow-Up

PR [#476](https://github.com/zyra-project/terraviz/pull/476) raised two
CodeQL `js/stack-trace-exposure` findings:

| Alert | Location | Concern | Remediation |
| --- | --- | --- | --- |
| [50](https://github.com/zyra-project/terraviz/security/code-scanning/50) | `functions/api/v1/stac/client-fixture.ts` | The client fixture sent `String(error)` in its HTTP 500 body, potentially exposing stack traces and internal paths. | Return a fixed `Internal Server Error` text body; retain exception details only in server-side diagnostics. |
| [51](https://github.com/zyra-project/terraviz/security/code-scanning/51) | `functions/api/v1/stac/external.test.ts` | The official-validator fixture had the same exception-derived HTTP response. | Apply the same fixed response and server-side logging policy. |

Both servers are test-only and bind ephemeral ports on `127.0.0.1`; these
findings do not identify an exposure in the deployed STAC routes. Loopback
binding does not justify disclosing internals to HTTP clients. Neither
fixture returns an exception message, stack, or file path in its error body.

The normal client test suite sends a real HTTP `TRACE` request, which the
Fetch `Request` constructor rejects, and asserts the exact 500 body and
content type while checking that diagnostics retain the exception. The
opt-in official-validator test exercises the same failure path on its own
server before running conformance validation. Alert closure still requires
GitHub to rerun CodeQL against the fixes; local tests are not a CodeQL verdict.

## General Review Follow-Up

The 2026-10-05 changes-requested review on PR #476 is addressed as follows:

| Review item | Change and regression evidence |
| --- | --- |
| Search/browse disagreement during re-transcodes | Removed the SQL eligibility copy. Frame and workflow tests use the real `stampTranscodingForVideoSource` path with a stable source digest and assert search/browse agreement; workflow coverage also checks the operator report. |
| Anonymous `intersects` CPU cost | Added coordinate-derived bbox rejection, total position/member bounds, and a per-request exact-intersection work budget. Tests prove disjoint catalogs skip Turf, budget boundaries are enforced, and HTTP never returns partial over-budget results. Real Pages measurement remains the rollout gate below. |
| Four plain-JSON 406 regressions | Item, collection Items, `/search`, and `/api` each have `Accept: application/json` regression coverage; explicit `q=0` still rejects that representation. |
| Cross-origin browser access | Chose credential-free wildcard CORS for the public read-only API. Added OPTIONS routing and error/conditional-response coverage; actual STAC Browser runs from a separate ephemeral port and performs browser GET/POST fetches. |
| Unused migration and misleading index plans | Removed migration 0057, its schema entries, and standalone index assertions. Schema/migration parity tests pass without these indexes. |
| Disappearing search cursor | GET and POST next pages use the same ID ordering as search rather than requiring the old Item to remain present; exhaustion returns an empty page. |
| Unused `StacLink.merge` and incomplete HTML help | Removed the unused field; HTML and OpenAPI documentation name `/search`, all supported parameters, geometry limits, work budget and CORS policy. |

### Second Review Pass: 2026-10-06

The second review on PR #476 is addressed without changing the fresh-read
publication contract or introducing a new SQL candidate authority:

| Review item | Disposition and evidence |
| --- | --- |
| Malformed GeoJSON causes 503 and false failure logs | Validate every polygon ring's closure and reject empty coordinate members before publication. GET/POST repros and nested cases return 400; remaining Turf exceptions map to `invalid_intersects`. The route regression confirms no publication-failure log for that query error. |
| Supplied GeoJSON bbox bypasses coordinate checks | Recursively discard bbox metadata and explicitly request Turf recomputation. Both reported out-of-range polygon/huge-point payloads are rejected; nested supplied bounds cannot affect the pre-filter or exact checks. |
| Nondeterministic `julianday('now')` index | Migration 0057 and all four indexes are removed. Fresh migrations/schema parity and INSERT/UPDATE regressions for both `now` and `NOW` pass. No production row cleanup is needed for a migration that will not ship. |
| SQLite/JS datetime disagreement | The SQL leg is absent, including its unused DB parameter. Regression tests assert browse/search equality for stored `+15:00` offsets and an accepted upper bound beyond year 9999. |
| Internal error text becomes public error code | Both parser catches allow only known codes; unknown failures become `invalid_query`. POST serialization is protected. A 20,000-deep JSON body returns a fixed 400 without stack/engine text or asset probes. |
| Traversal-dependent Item identity | Chose `/items/{id}` as canonical. The collection route advertises `canonical` while retaining its Features self link. Tests resolve the same canonical identity from search, collection listing, and both Item routes. |
| POST 304 and public caching | Only GET/HEAD evaluate conditional validators. POST ignores that header, returns uncached 200 results, and has no 304 response in OpenAPI. Exact and wildcard validator regressions cover all three methods. |
| Cursor format promised to clients | OpenAPI GET/POST and HTML state that cursors are opaque and come only from next links. No client-facing promise of the current token representation remains. |
| Moving validation dependencies and Browser tag | uv version and Python resolution cutoff are fixed; Browser checkout uses a verified full commit. Date-bounded real Python clients, official conformance and independent OpenAPI validation pass. |
| STAC error contract and empty 405 | Add `code` and fixed `description` alongside `error`, declare the exception schema for error responses, and return it on unsupported methods. |
| OpenAPI validity/accuracy | Define every required property, express bbox length as exactly four or six, document ID count/length limits, Link method/body, clamped safe-integer limits and POST 413/415. Independent `openapi-spec-validator 0.7.1` validation and executable schema-boundary tests pass. |
| Loose bbox/datetime parsing | Reject hexadecimal/binary bbox values and hour 24. Existing ordinary decimal, date-line and interval behavior remains covered. |
| Workflow conventions | Add concurrency cancellation, seven-day screenshot retention and the imported `docs/metadata/schemas/**` trigger. Pinned actionlint 1.7.12 passes locally. Shellcheck remains a Linux CI check. |
| Other HTTP methods in production | Export `onRequest` so PUT, PATCH and DELETE use the tested 405 contract rather than unspecified Pages behavior. |
| Client and URL-limit coverage gaps | Exercise the Browser's real search tab/form and GDAL's native OAPIF driver. Document the platform GET URL limit and POST alternative. QGIS itself remains Linux-CI-only. |
| Whole-catalog primary D1 load | Retain the fresh-read correctness policy. Both browse and search read the primary publication; KV is not eligibility authority. Search adds no duplicate candidate SQL round-trip. Catalog/history-sized reads, including superseded history, remain a scaling risk to measure on the approved preview; this follow-up does not silently substitute stale KV authorization or claim unlimited scalability. |

The broader primary-read cost and actual worker CPU limits are still rollout
measurements, not local correctness claims. Optimizing publication reads must
preserve immediate private/retracted/stale-history exclusion demonstrated by
the route tests. The same Pages measurement gate below remains outstanding.

Final local verification on 2026-10-06: the complete STAC slice plus audit
and migration tests passed **311 tests across 13 files**, with one explicit
QGIS skip on Windows. This includes the official validator (`Errors: none`),
independent served-OpenAPI validation, Browser search-page interaction and
GDAL OAPIF ingestion. The full `npm run type-check` chain passed. A disposable
Git index accounted for the removed, unstaged migration during the licence
gate; the real index was not changed. These results do not close remote
CodeQL/review threads or the real Pages rollout measurements.

### Local Work-Budget Evidence

Measured 2026-10-05 on Windows, Node 24.18.0, Turf 7.4.0, using the actual
`parseStacQuery` and `searchStacItems` implementations. Each row is the median
and maximum of five warm local runs, excluding parsing, publication building,
network I/O and fixture allocation. These are wall-clock timings, **not Pages
CPU measurements**. The maximum polygon is a closed 256-position unit circle.
Disjoint Items are rectangles at `[10,10,10.1,10.1]`; bbox-overlapping but
non-intersecting Items are rectangles at `[0.8,0.8,0.9,0.9]`. The point query
is `[0.85,0.85]` against those latter rectangles. Synthetic IDs are sorted.

| Query and Items | Median / maximum local ms | Outcome |
| --- | --- | --- |
| Maximum polygon, 5,000 disjoint Items | 0.63 / 1.79 | Complete empty result; no Turf calls |
| Maximum polygon, 64 bbox-overlapping Items | 7.06 / 7.50 | Complete empty result; exact budget boundary |
| Maximum polygon, 65 bbox-overlapping Items | 7.54 / 8.68 | Explicit `intersects_budget_exceeded`; no partial result |
| Maximum polygon, 5,000 bbox-overlapping Items | 6.77 / 7.50 | Same explicit error after 64 exact checks |
| Point, 5,000 bbox-overlapping Items | 1.44 / 4.95 | Complete result with 5,000 matches |

The fixtures demonstrate the bbox fast path and aggregate guard, not a universal
worst-case guarantee for every permitted GeometryCollection or worker runtime.

### Rollout Gate: Pages CPU Measurement

**Outstanding; not measured on a real Pages deployment.** No preview deployment
was authorized in this follow-up. Do not use the local timings above to sign
off the reviewer's Pages CPU requirement or declare production rollout ready.

Before rollout, the deployment operator must use an approved isolated Pages
preview running these fixes and record the following evidence here:

1. Preview revision, runtime, worker CPU limit, representative maximum eligible
	Item count, published geometry shapes, and GET/POST query payloads.
2. Cloudflare invocation CPU measurements, not HTTP elapsed time, for maximum
	accepted polygon and GeometryCollection complexity, including disjoint,
	bbox-overlapping/non-intersecting, touching and intersecting Items. Include
	cheap point queries and exact-budget/over-budget cases, cold and warm.
3. Full-handler cost including publication reads, verification and sorting,
	plus statuses and completeness; confirm over-budget requests return the
	documented error, and browse/search still agree during re-transcodes.
4. The operator's accept/reject decision against that deployment's CPU limit.
	Tighten the bounds and repeat if needed. Never truncate the result to fit.

QGIS remains a Linux-CI check, not a new local Windows result. GitHub review
threads and CodeQL alerts still require remote verification after the local
changes are committed and pushed by an authorized operator.