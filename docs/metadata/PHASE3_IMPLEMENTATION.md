# Phase 3: Atomic History

**Status:** Implemented; deployment and operator backfill pending
**Last reviewed:** 2026-09-29
**Revisit when:** Persisted verification replaces the request probe budget, or history retention/deletion policy changes.

One DCO-signed commit corresponds to each numbered step in the
[metadata plan](README.md#phase-3-atomic-history).

## Step 1: Frame Items

Migration 0055 adds publication snapshots and atomic Items. Both tables reject
updates. Dataset deletion cascades through them; they are not an independent
public archive after the parent dataset is removed.

Native publication captures frame sequences whose manifest, represented-time
evidence, positive cadence and extent are valid. Frame assets use the existing
content-addressed R2 keys. Publication persists IDs and timestamps rather than
deriving them during public reads. Identical repeated publication is idempotent;
changed scientific metadata or frame content creates a new snapshot.

The insert and native publication update share one D1 transaction. A comparison
against the captured dataset columns rejects changes made while the manifest is
being read. A failed transaction cannot leave some frames published. Invalid or
untimestamped sequences remain native-only. Missing promised manifests fail
publication instead of fabricating history.

The public projection reads snapshots with current parent visibility in its
primary-backed transaction. Private, restricted, hidden, draft and retracted
parents cannot expose historical Items, even with a warm cache. Snapshot title,
represented time and assets do not change when current metadata changes. A
Collection combines all eligible Items' spatial and temporal extents, with
conservative antimeridian bounds; listing and root links do not duplicate it.

Existing sequences are not silently backfilled. Republishing captures current
evidenced state, not historical states that the node never retained. The Phase 2
40-distinct-URL verification cap still applies to the entire public snapshot;
large histories fail closed rather than silently truncating. Supporting assets
are verified as before and are not independently archived by this step.

Apply migration 0055 before deploying these readers. STAC remains opt-in through
`STAC_ENABLED`; no production settings or data are changed by this PR.

## Step 2: Workflow Revisions

Workflow-owned datasets capture a revision when explicit publication succeeds,
or when a verified transcode callback replaces an already published output.
Only public, non-hidden publications are captured. The history insert and the
guarded transcode update run in the same D1 transaction. Draft transcodes do not
publish history; their later explicit publication captures it.

Capture accepts upload-specific HLS bundle paths or content-addressed R2 assets
with matching content digests. Mutable external URLs stay excluded. The stored
snapshot fixes represented time, metadata and the primary asset. HLS receives
no invented whole-bundle checksum. Frame-producing workflows use the immutable
run bundle as their revision Item; non-workflow sequences use per-frame Items.

Run success alone is not publication: the runner can finish while transcoding
continues, and a no-data soft pass can succeed without an upload. Neither event
creates history. Repeated publication of identical content and metadata reuses
the saved identity; a new upload or changed metadata creates a new revision.
No history is inferred from old workflow-run logs. Operators must retain the
upload-specific bundles and content-addressed assets for historical Items to
remain reachable. The existing reachability and count-budget checks still apply.

## Step 3: Revision Links

Workflow revisions of the same dataset expose `predecessor-version`,
`successor-version`, and `latest-version` links using their persisted capture
times, not represented scientific time. Equal or invalid capture timestamps
leave the chain unlinked rather than inventing an order. Frames are not versions
of their neighbors. Links target only Items included in the current public
projection; an unavailable immediate neighbor is not silently skipped.

These registered link relations do not claim the STAC Versioning extension.
Links are a live projection and can change as revisions arrive, while the saved
metadata and primary asset remain immutable. History is a cache dependency, so
new revisions update prior Items' ETags and links without changing their IDs.

## Step 4: Source-Lineage Backfill

Migration 0056 adds an immutable evidence record for each saved publication.
`GET /api/v1/publish/stac-lineage` inventories all publications, including those
with missing lineage, in 50-row pages. Follow `next_cursor` using `?cursor=`.
`POST` at the same path records the reviewed source set. Both methods require
an active admin or service publisher and always return `private, no-store`.
The endpoint works while public STAC is disabled so backfill can precede rollout.

The POST body has exactly these fields:

```json
{
	"publication_id": "revision-<saved-22-character-id>",
	"reviewed": true,
	"sources": [{
		"href": "https://data.example/inputs/model.nc",
		"content_digest": "sha256:<64-lowercase-hex>",
		"evidence_href": "https://data.example/evidence/run.json",
		"evidence_digest": "sha256:<64-lowercase-hex>"
	}]
}
```

Use the actual `publication_id` from the inventory, not an Item ID. For a frame
publication the evidence must describe the source set for the entire captured
sequence. Inspect retained source files and acquisition/execution records;
compute their digests and review their relationship to this precise saved
publication before submitting. A workflow template, successful run status,
rendered upload digest, or matching title alone does not establish the original
scientific source. Leave the record missing when evidence is unavailable.

Sources must use canonical public HTTPS URLs without credentials, query strings
or fragments; signed/private locators must not be submitted. The request is
limited to 64 KiB and 1-32 distinct sources. A first insert returns 201, an
identical retry (independent of source order) returns 200, and a changed source
set returns 409 without replacing evidence. Unknown publications return 404;
invalid input returns 400 and oversized input 413. The inventory includes the
reviewer's publisher ID and server timestamp. Dataset deletion cascades through
the history and lineage records.

`operator_attested` means a privileged curator supplied reviewed evidence, not
that the server fetched and scientifically verified it. No remote requests are
made, no source evidence enters public STAC, and **Processing remains disabled**
even after backfill. Enabling it requires separately reviewed processing facts,
extension registration/schema validation, public-source permissions, and tests;
source lineage is necessary but not sufficient. This PR provides the backfill
mechanism, not a claim that production records have already been reviewed.

## Rollout

Apply 0055 and 0056 before deploying. Retain historical source assets and bundles;
the tables alone do not preserve R2 objects. Exercise sequence publish, workflow
completion and retry, access withdrawal, revision traversal, and the lineage
inventory on a staging node. Backfill only evidenced sources. Run the existing
STAC inclusion report and reachability audit before enabling `STAC_ENABLED`.
The request-time 40-URL cap is unchanged and remains a rollout constraint for
large sequences or histories. No STAC API, Processing, or Versioning extension
conformance is advertised by this change.