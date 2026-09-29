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