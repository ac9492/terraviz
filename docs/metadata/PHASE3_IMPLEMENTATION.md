# Phase 3: Atomic History

**Status:** Implementation in progress
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