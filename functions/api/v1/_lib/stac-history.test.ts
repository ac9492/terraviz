// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import { stacRouteFixture } from './stac-test-helpers'
import { historyInsertStatements, historyModels, linkHistoryRevisions, prepareFrameHistory, prepareWorkflowHistory, type StacHistoryPublication } from './stac-history'
import { readStacPublicationInput } from './stac-publication-store'
import { publishDataset } from './dataset-mutations'
import { readStacPublication } from './stac-publication'
import type { CatalogEnv } from './env'
import { serveStac } from './stac-http'
import { clearTranscoding } from './asset-uploads'

describe('immutable STAC history', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sequenceFixture() {
    const fixture = stacRouteFixture()
    fixture.sqlite.exec(`UPDATE datasets SET slug='frame-sequence', frame_count=2, frame_extension='png',
      frame_source_filenames_ref='r2:manifest.json', period='P1D', format='video/mp4'`)
    const manifest = [{ index: 0, filename: 'one.png', digest: `sha256:${'a'.repeat(64)}` },
      { index: 1, filename: 'two.png', digest: `sha256:${'b'.repeat(64)}` }]
    const env: CatalogEnv = { ...fixture.env, R2_PUBLIC_BASE: 'https://data.example',
      CATALOG_R2: { get: vi.fn(async () => ({ text: async () => JSON.stringify(manifest) })) } as unknown as R2Bucket }
    return { ...fixture, env, manifest }
  }

  it('publishes timestamped frame Items with stable IDs, merged extents and current access gates', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'content-type': 'image/png' } })))
    try {
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      const first = await readStacPublication(env)
      expect(first.products).toHaveLength(2)
      const itemIds = first.products.map(product => product.item!.id)
      expect(new Set(itemIds).size).toBe(2)
      expect(first.products.map(product => product.item!.properties.datetime)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'])
      expect(first.products[0].item!.assets.data.href).toContain(`/frames/sha256/${'a'.repeat(64)}.png`)
      expect(first.products[0].collection!.extent.temporal.interval).toEqual([['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']])
      expect(first.catalog.links.filter(link => link.rel === 'child')).toHaveLength(1)
      const collections = await serveStac(new Request('https://node.example/api/v1/stac/collections'), env)
      expect(await collections.json()).toMatchObject({ collections: [expect.objectContaining({ id: first.products[0].collection!.id })] })
      expect((await publishDataset(env, ids[0])).ok).toBe(true)
      expect((await readStacPublication(env)).products.map(product => product.item!.id)).toEqual(itemIds)
      sqlite.exec("UPDATE datasets SET start_time='2020-01-01T00:00:00Z', title='New title', slug='new-slug'")
      const later = await readStacPublication(env)
      expect(later.products).toEqual(first.products)
      sqlite.exec("UPDATE datasets SET visibility='private'")
      expect((await readStacPublication(env)).products).toEqual([])
      expect((await serveStac(new Request(`https://node.example/api/v1/stac/items/${itemIds[0]}`), env)).status).toBe(404)
    } finally { sqlite.close() }
  })

  it('rolls back a snapshot if parent metadata changes while frame assets are read', async () => {
    const { sqlite, ids, env } = sequenceFixture()
    try {
      const row = (await readStacPublicationInput(env.CATALOG_DB!, true)).datasets[0].row
      const publication = (await prepareFrameHistory(env, row, '2026-09-29T00:00:00Z'))!
      sqlite.exec("UPDATE datasets SET title='Concurrent edit'")
      await expect(env.CATALOG_DB!.batch(historyInsertStatements(env.CATALOG_DB!, publication))).rejects.toThrow()
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_publications').get()).toEqual({ total: 0 })
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_items').get()).toEqual({ total: 0 })
      expect(publication.dataset_id).toBe(ids[0])
    } finally { sqlite.close() }
  })

  it.each(["temporal_semantics='unknown'", "period='PT0S'", "end_time='2026-01-01T00:00:00Z'", "visibility='private'", 'is_hidden=1'])(
    'does not invent frame time when %s', async change => {
      const { sqlite, env } = sequenceFixture()
      try {
        sqlite.exec(`UPDATE datasets SET ${change}`)
        const row = (await readStacPublicationInput(env.CATALOG_DB!, true)).datasets[0].row
        expect(await prepareFrameHistory(env, row, '2026-09-29T00:00:00Z')).toBeNull()
      } finally { sqlite.close() }
    })

  it('retains workflow revisions across bundle swaps and makes completion atomic', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    const configured: CatalogEnv = { ...env, R2_PUBLIC_BASE: 'https://data.example' }
    const uploadId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })))
    try {
      sqlite.exec(`INSERT INTO publishers (id,email,display_name,role,status,created_at)
        VALUES ('PUB','publisher@example.test','Publisher','service','active','2026-01-01');
        INSERT INTO workflows (id,publisher_id,name,pipeline_json,metadata_template,schedule,target_dataset_id,created_at,updated_at)
        SELECT 'WF','PUB','Recurring','{}','{}','P1D',id,'2026-01-01','2026-01-01' FROM datasets;
        UPDATE datasets SET slug='workflow-output', format='video/mp4', transcoding=1, active_transcode_upload_id='${uploadId}'`)
      const before = (await readStacPublicationInput(env.CATALOG_DB, true)).datasets[0].row
      const now = '2026-09-29T00:00:00Z'
      const completed = { ...before, data_ref: `r2:videos/${ids[0]}/${uploadId}/master.m3u8`, transcoding: null,
        content_digest: null, active_transcode_upload_id: null, updated_at: now }
      const prepared = (await prepareWorkflowHistory(configured, completed, now))!
      expect(prepared).not.toBeNull()
      expect(await clearTranscoding(env.CATALOG_DB, ids[0], uploadId, completed.data_ref, now, null,
        historyInsertStatements(env.CATALOG_DB, prepared, before))).toBe(1)
      const first = await readStacPublication(configured)
      expect(first.products).toHaveLength(1)
      expect(first.products[0].item!.id).toContain('-revision-')
      expect(first.products[0].item!.assets.data).not.toHaveProperty('file:checksum')
      const secondUpload = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
      sqlite.prepare('UPDATE datasets SET data_ref=?, start_time=?, end_time=?').run(
        `r2:videos/${ids[0]}/${secondUpload}/master.m3u8`, '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z')
      expect((await publishDataset(configured, ids[0])).ok).toBe(true)
      expect((await publishDataset(configured, ids[0])).ok).toBe(true)
      const later = await readStacPublication(configured)
      expect(later.products).toHaveLength(2)
      const oldItem = later.products.find(product => product.item!.id === first.products[0].item!.id)!.item!
      expect({ ...oldItem, links: first.products[0].item!.links }).toEqual(first.products[0].item)
      const newItem = later.products.find(product => product.item!.id !== oldItem.id)!.item!
      expect(oldItem.links).toEqual(expect.arrayContaining([
        expect.objectContaining({ rel: 'successor-version', href: newItem.links.find(link => link.rel === 'self')!.href }),
        expect.objectContaining({ rel: 'latest-version', href: newItem.links.find(link => link.rel === 'self')!.href }),
      ]))
      expect(newItem.links).toContainEqual(expect.objectContaining({ rel: 'predecessor-version', href: oldItem.links.find(link => link.rel === 'self')!.href }))
      const history = (await readStacPublicationInput(env.CATALOG_DB, true)).history
      const unlinked = structuredClone(later.products)
      for (const product of unlinked) product.item!.links = product.item!.links.filter(link => !link.rel.endsWith('-version'))
      linkHistoryRevisions(unlinked, history.map(publication => ({ ...publication, captured_at: now })))
      expect(unlinked.every(product => product.item!.links.every(link => !link.rel.endsWith('-version')))).toBe(true)
      linkHistoryRevisions([unlinked[0]], history)
      expect(unlinked[0].item!.links.every(link => !link.rel.endsWith('-version'))).toBe(true)
      const current = (await readStacPublicationInput(env.CATALOG_DB, true)).datasets[0].row
      expect(await prepareWorkflowHistory(configured, { ...current, data_ref: 'url:https://data.example/latest.mp4' }, now)).toBeNull()
      expect(await prepareWorkflowHistory(configured, { ...current, transcoding: 1 }, now)).toBeNull()
      expect(await prepareWorkflowHistory(configured, { ...current, visibility: 'private' }, now)).toBeNull()
    } finally { sqlite.close() }
  })

  it('persists idempotent Items and prevents historical metadata mutation', async () => {
    const { sqlite, ids, env } = stacRouteFixture()
    try {
      const model = (await readStacPublicationInput(env.CATALOG_DB)).datasets[0]
      const publication: StacHistoryPublication = { id: 'frames-one', dataset_id: ids[0], kind: 'frame', source_key: 'one',
        captured_at: '2026-09-29T00:00:00Z', model_json: JSON.stringify(model), items: [{ id: 'frame-one', ordinal: 0,
          data_ref: 'r2:immutable.png', content_digest: `sha256:${'a'.repeat(64)}`, format: 'image/png',
          start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:00:00Z' }] }
      await env.CATALOG_DB.batch(historyInsertStatements(env.CATALOG_DB, publication))
      await env.CATALOG_DB.batch(historyInsertStatements(env.CATALOG_DB, publication))
      expect(sqlite.prepare('SELECT count(*) AS total FROM stac_history_items').get()).toEqual({ total: 1 })
      expect(() => sqlite.exec("UPDATE stac_history_items SET start_time='2020-01-01'" )).toThrow('immutable')
      expect(() => sqlite.exec("UPDATE stac_history_publications SET model_json='{}'" )).toThrow('immutable')
      const historical = historyModels(publication, { ...model.row, title: 'Changed', visibility: 'private' })[0]
      expect(historical.row.title).toBe(model.row.title)
      expect(historical.row.visibility).toBe('private')
      expect(historical.row.start_time).toBe('2026-01-01T00:00:00Z')
      expect(historical.itemIdentity).toEqual({ kind: 'frame', persisted_id: 'frame-one' })
    } finally { sqlite.close() }
  })
})