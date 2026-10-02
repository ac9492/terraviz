// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacItem } from './stac-types'

export interface StacQuery {
  limit: number
  cursor?: string
  bbox?: number[]
  interval?: [number, number]
}

export function parseStacQuery(params: URLSearchParams): StacQuery {
  for (const key of params.keys()) {
    if (!['limit', 'cursor', 'bbox', 'datetime'].includes(key) || params.getAll(key).length !== 1) throw new Error('invalid_query')
  }
  const text = params.get('limit') ?? '50'
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('invalid_limit')
  const query: StacQuery = { limit: Math.min(Number(text), 100) }
  if (params.has('cursor')) query.cursor = params.get('cursor')!
  if (params.has('bbox')) {
    const parts = params.get('bbox')!.split(',')
    if (parts.some(value => !value.trim())) throw new Error('invalid_bbox')
    const bbox = parts.map(Number)
    const dimensions = bbox.length / 2
    if (![4, 6].includes(bbox.length) || bbox.some(value => !Number.isFinite(value))
      || Math.abs(bbox[0]) > 180 || Math.abs(bbox[dimensions]) > 180
      || Math.abs(bbox[1]) > 90 || Math.abs(bbox[dimensions + 1]) > 90 || bbox[1] > bbox[dimensions + 1]
      || (dimensions === 3 && bbox[2] > bbox[5])) throw new Error('invalid_bbox')
    query.bbox = bbox
  }
  if (params.has('datetime')) {
    const datetime = params.get('datetime')!
    const parts = datetime.split('/')
    if (parts.length > 2) throw new Error('invalid_datetime')
    const instant = (value: string, open: number): number => {
      if (parts.length === 2 && (value === '..' || value === '')) return open
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('invalid_datetime')
      const parsed = Date.parse(value)
      if (!Number.isFinite(parsed)) throw new Error('invalid_datetime')
      return parsed
    }
    query.interval = [instant(parts[0], -Infinity), instant(parts.at(-1)!, Infinity)]
    if (query.interval[0] > query.interval[1] || (query.interval[0] === -Infinity && query.interval[1] === Infinity)) throw new Error('invalid_datetime')
  }
  return query
}

export function matchesStacQuery(item: StacItem, query: StacQuery): boolean {
  if (query.interval) {
    const start = Date.parse(item.properties.datetime ?? item.properties.start_datetime!)
    const end = Date.parse(item.properties.datetime ?? item.properties.end_datetime!)
    if (start > query.interval[1] || end < query.interval[0]) return false
  }
  if (query.bbox) {
    if (!item.bbox) return false
    const dimensions = query.bbox.length / 2
    if (dimensions === 3 && (query.bbox[2] > 0 || query.bbox[5] < 0)) return false
    const [west, south, east, north] = item.bbox
    if (south > query.bbox[dimensions + 1] || north < query.bbox[1]) return false
    const segments = (left: number, right: number): number[][] => left <= right ? [[left, right]] : [[left, 180], [-180, right]]
    if (!segments(west, east).some(first => segments(query.bbox![0], query.bbox![dimensions])
      .some(second => first[0] <= second[1] && first[1] >= second[0]))) return false
  }
  return true
}