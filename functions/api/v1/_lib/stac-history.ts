// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import type { DatasetRow } from './catalog-store'
import type { StacDatasetReadModel } from './stac-read-model'
import { loadFrameManifest, frameTimestamp } from './frames-manifest'
import { evaluateTemporal } from './metadata-readiness'
import { parseIsoDuration } from './iso-duration'
import type { StacProduct } from './stac-builders'
import { buildContentAddressedFrameKey } from './r2-store'
import type { StacCollection } from './stac-types'
import { computeEtag } from './snapshot'
import { readStacPublicationInput } from './stac-publication-store'

export interface StacHistoryItem {
  id: string
  ordinal: number
  data_ref: string
  content_digest: string
  format: string
  start_time: string
  end_time: string
}

export interface StacHistoryPublication {
  id: string
  dataset_id: string
  kind: 'frame' | 'revision'
  source_key: string
  model_json: string
  captured_at: string
  items: StacHistoryItem[]
}

export function historyModels(publication: StacHistoryPublication, parent: DatasetRow): StacDatasetReadModel[] {
  const model = JSON.parse(publication.model_json) as StacDatasetReadModel
  return publication.items.map(item => ({ ...model,
    row: { ...model.row, data_ref: item.data_ref, content_digest: item.content_digest,
      format: item.format, start_time: item.start_time, end_time: item.end_time,
      visibility: parent.visibility, is_hidden: parent.is_hidden, published_at: parent.published_at,
      retracted_at: parent.retracted_at, transcoding: 0 },
    publicationKind: publication.kind === 'frame' ? 'sequence' : 'workflow',
    itemIdentity: { kind: publication.kind, persisted_id: item.id },
  }))
}

export async function prepareFrameHistory(env: CatalogEnv, row: DatasetRow, capturedAt: string): Promise<StacHistoryPublication | null> {
  if (!row.frame_count || !row.frame_extension || !row.frame_source_filenames_ref || !env.CATALOG_R2
    || !evaluateTemporal(row).ready || !row.period) return null
  if (!['png', 'jpg', 'webp'].includes(row.frame_extension) || (parseIsoDuration(row.period) ?? 0) <= 0) return null
  const input = await readStacPublicationInput(env.CATALOG_DB!, true)
  const model = input.datasets.find(dataset => dataset.row.id === row.id)
  if (!model || model.publicationKind === 'workflow') return null
  const manifest = await loadFrameManifest(env.CATALOG_R2, row.frame_source_filenames_ref.replace(/^r2:/, ''))
  if (!manifest || manifest.length !== row.frame_count) throw new Error('STAC frame manifest is missing or inconsistent')
  const frames: Omit<StacHistoryItem, 'id'>[] = []
  for (const entry of manifest) {
    const timestamp = frameTimestamp(row, entry.index)
    if (!timestamp || !evaluateTemporal({ ...row, start_time: timestamp, end_time: timestamp }).ready
      || Date.parse(timestamp) > Date.parse(row.end_time!)) return null
    frames.push({ ordinal: entry.index, data_ref: `r2:${buildContentAddressedFrameKey(row.id, entry.digest, row.frame_extension)}`,
      content_digest: entry.digest, format: row.frame_extension === 'jpg' ? 'image/jpeg' : `image/${row.frame_extension}`,
      start_time: timestamp, end_time: timestamp })
  }
  const snapshot = { ...model, row: { ...model.row, ...row }, renditions: [] }
  const sourceKey = (await computeEtag(JSON.stringify({ snapshot: { ...snapshot,
    row: { ...snapshot.row, updated_at: null, published_at: null, retracted_at: null } }, frames }))).replace(/"/g, '')
  const id = `frames-${sourceKey}`
  return { id, dataset_id: row.id, kind: 'frame', source_key: sourceKey,
    model_json: JSON.stringify(snapshot), captured_at: capturedAt,
    items: frames.map(frame => ({ ...frame, id: `${sourceKey}-${frame.ordinal}` })) }
}

export function historyInsertStatements(db: D1Database, publication: StacHistoryPublication): D1PreparedStatement[] {
  const expected = (JSON.parse(publication.model_json) as StacDatasetReadModel).row
  const columns = Object.keys(expected).filter(key => /^[a-z_]+$/.test(key))
  const matches = `EXISTS(SELECT 1 FROM datasets WHERE id = ? AND NOT EXISTS
    (SELECT 1 FROM json_each(?) expected WHERE (CASE expected.key
      ${columns.map(key => `WHEN '${key}' THEN datasets.${key}`).join(' ')} END) IS NOT expected.value))`
  const statements = [db.prepare(`INSERT INTO stac_history_publications
    (id, dataset_id, kind, source_key, model_json, captured_at)
    VALUES (?, ?, ?, ?, CASE WHEN ${matches} THEN ? ELSE '' END, ?)
    ON CONFLICT(dataset_id, kind, source_key) DO NOTHING`)
    .bind(publication.id, publication.dataset_id, publication.kind, publication.source_key,
      publication.dataset_id, JSON.stringify(expected), publication.model_json, publication.captured_at)]
  for (let offset = 0; offset < publication.items.length; offset += 100) {
    statements.push(db.prepare(`INSERT INTO stac_history_items
      (id, publication_id, ordinal, data_ref, content_digest, format, start_time, end_time)
      SELECT json_extract(value,'$.id'), ?, json_extract(value,'$.ordinal'), json_extract(value,'$.data_ref'),
        json_extract(value,'$.content_digest'), json_extract(value,'$.format'), json_extract(value,'$.start_time'),
        json_extract(value,'$.end_time') FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING`)
      .bind(publication.id, JSON.stringify(publication.items.slice(offset, offset + 100))))
  }
  return statements
}

export function mergeHistoryCollections(products: StacProduct[]): void {
  const groups = new Map<string, StacProduct[]>()
  for (const product of products) {
    if (!product.collection) continue
    const group = groups.get(product.collection.id) ?? []
    group.push(product)
    groups.set(product.collection.id, group)
  }
  for (const group of groups.values()) {
    const latest = group[group.length - 1].collection!
    const boxes = group.flatMap(product => product.collection!.extent.spatial.bbox)
    const crossing = boxes.some(box => box[0] > box[2])
    const intervals = group.flatMap(product => product.collection!.extent.temporal.interval)
    const starts = intervals.map(interval => interval[0])
    const ends = intervals.map(interval => interval[1])
    const collection: StacCollection = { ...latest, extent: {
      spatial: { bbox: [[crossing ? -180 : Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        crossing ? 180 : Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))]] },
      temporal: { interval: [[starts.includes(null) ? null : starts.sort()[0], ends.includes(null) ? null : ends.sort().at(-1)!]] },
    }, links: [...latest.links.filter(link => link.rel !== 'item'),
      ...group.flatMap(product => product.collection!.links.filter(link => link.rel === 'item'))] }
    for (const product of group) product.collection = collection
  }
}