// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import booleanIntersects from '@turf/boolean-intersects'
import { matchesStacQuery, parseStacQuery, MAX_INTERSECTS_POSITIONS, MAX_INTERSECTS_MEMBERS, MAX_INTERSECTS_POSITION_TESTS } from './stac-query'
import { searchStacItems } from './stac-search'
import type { StacItem } from './stac-types'

vi.mock('@turf/boolean-intersects', async importOriginal => {
  const actual = await importOriginal<typeof import('@turf/boolean-intersects')>()
  return { ...actual, default: vi.fn(actual.default) }
})

describe('STAC query contract', () => {
  it('clamps limits and accepts open intervals', () => {
    expect(parseStacQuery(new URLSearchParams('limit=1000')).limit).toBe(100)
    expect(parseStacQuery(new URLSearchParams('datetime=../2026-01-01T00:00:00Z')).interval?.[0]).toBe(-Infinity)
  })
  it.each(['limit=0', 'limit=-1', 'limit=abc', 'limit=1&limit=2', 'bbox=1,2,3', 'bbox=0,91,1,92',
    'bbox=0x0,0,1,1', 'bbox=0b0,0,1,1', 'datetime=2026-01-01T24:00:00Z',
    'datetime=2026', 'datetime=../..', 'datetime=2026-02-01T00:00:00Z/2026-01-01T00:00:00Z'])('rejects %s', text => {
    expect(() => parseStacQuery(new URLSearchParams(text))).toThrow()
  })
  it('handles crossing boxes, null geometry and inclusive interval overlap', () => {
    const item = { bbox: [170, -10, -170, 10], properties: { datetime: null,
      start_datetime: '2026-01-01T00:00:00Z', end_datetime: '2026-01-02T00:00:00Z' } } as StacItem
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('bbox=175,0,179,5')))).toBe(true)
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('bbox=-1,0,1,5')))).toBe(false)
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('datetime=2026-01-02T00:00:00Z')))).toBe(true)
    expect(matchesStacQuery({ ...item, bbox: undefined } as StacItem, parseStacQuery(new URLSearchParams('bbox=0,0,1,1')))).toBe(false)
  })
  it('bounds total positions and collection members, including nested collections', () => {
    const parse = (geometry: unknown) => parseStacQuery(new URLSearchParams({ intersects: JSON.stringify(geometry) }), true)
    const line = (positions: number) => ({ type: 'LineString', coordinates: Array.from({ length: positions }, () => [0, 0]) })
    expect(parse(line(MAX_INTERSECTS_POSITIONS)).intersectsBbox).toEqual([0, 0, 0, 0])
    expect(() => parse(line(MAX_INTERSECTS_POSITIONS + 1))).toThrow('invalid_intersects')
    const collection = (members: number) => ({ type: 'GeometryCollection', geometries: Array.from({ length: members }, () => ({ type: 'Point', coordinates: [0, 0] })) })
    expect(parse(collection(MAX_INTERSECTS_MEMBERS)).intersects).toBeTruthy()
    expect(() => parse(collection(MAX_INTERSECTS_MEMBERS + 1))).toThrow('invalid_intersects')
    expect(() => parse({ type: 'GeometryCollection', geometries: [line(128), line(129)] })).toThrow('invalid_intersects')
    expect(() => parse({ type: 'GeometryCollection', geometries: [collection(16), collection(16)] })).toThrow('invalid_intersects')
    expect(() => parse({ type: 'Point', coordinates: [181, 0] })).toThrow('invalid_intersects')
  })
  it('rejects disjoint bounds before Turf and retains inclusive boundary intersections', () => {
    const item = { bbox: [0, 0, 1, 1], properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } } as StacItem
    const query = (coordinates: number[]) => parseStacQuery(new URLSearchParams({ intersects: JSON.stringify({ type: 'Point', coordinates }) }), true)
    vi.mocked(booleanIntersects).mockClear()
    for (const coordinates of [[2, 0], [-1, 0], [0, 2], [0, -1]]) expect(matchesStacQuery(item, query(coordinates))).toBe(false)
    expect(booleanIntersects).not.toHaveBeenCalled()
    expect(matchesStacQuery(item, query([1, 1]))).toBe(true)
    expect(booleanIntersects).toHaveBeenCalledTimes(1)
  })
  it('derives bounds from coordinates rather than caller-supplied GeoJSON bbox metadata', () => {
    const query = parseStacQuery(new URLSearchParams({ intersects: JSON.stringify({ type: 'GeometryCollection', bbox: [0, 0, 0, 0],
      geometries: [{ type: 'Point', coordinates: [2, 2], bbox: [0, 0, 0, 0] }] }) }), true)
    expect(query.intersectsBbox).toEqual([2, 2, 2, 2])
    expect(query.intersects).not.toHaveProperty('bbox')
    expect(query.intersects?.type === 'GeometryCollection' && query.intersects.geometries[0]).not.toHaveProperty('bbox')
    expect(() => parseStacQuery(new URLSearchParams({ intersects: JSON.stringify({ type: 'Point', coordinates: [181, 0], bbox: [0, 0, 0, 0] }) }), true)).toThrow('invalid_intersects')
    for (const geometry of [
      { type: 'Polygon', bbox: [0, 0, 1, 1], coordinates: [[[0, 0], [500, 0], [500, 95], [0, 0]]] },
      { type: 'Point', bbox: [0, 0, 0, 0], coordinates: [1e308, -1e308] },
    ]) expect(() => parseStacQuery(new URLSearchParams({ intersects: JSON.stringify(geometry) }), true)).toThrow('invalid_intersects')
  })
  it('bounds aggregate exact-intersection work and never returns a partial search', async () => {
    const ring = Array.from({ length: MAX_INTERSECTS_POSITIONS - 1 }, (_, index) => {
      const angle = index * 2 * Math.PI / (MAX_INTERSECTS_POSITIONS - 1)
      return [Math.cos(angle), Math.sin(angle)]
    })
    ring.push(ring[0])
    const query = parseStacQuery(new URLSearchParams({ intersects: JSON.stringify({ type: 'Polygon', coordinates: [ring] }) }), true)
    const item = { id: 'item', bbox: [0.8, 0.8, 0.9, 0.9], properties: {}, geometry: { type: 'Polygon', coordinates: [[[0.8, 0.8], [0.9, 0.8], [0.9, 0.9], [0.8, 0.9], [0.8, 0.8]]] } } as StacItem
    const count = MAX_INTERSECTS_POSITION_TESTS / MAX_INTERSECTS_POSITIONS
    vi.mocked(booleanIntersects).mockClear()
    await expect(searchStacItems(Array(count).fill(item), query)).resolves.toEqual([])
    expect(booleanIntersects).toHaveBeenCalledTimes(count)
    vi.mocked(booleanIntersects).mockClear()
    await expect(searchStacItems(Array(count + 1).fill(item), query)).rejects.toThrow('intersects_budget_exceeded')
    expect(booleanIntersects).toHaveBeenCalledTimes(count)
    vi.mocked(booleanIntersects).mockClear()
    await expect(searchStacItems(Array(5000).fill({ ...item, bbox: [10, 10, 11, 11] }), query)).resolves.toEqual([])
    expect(booleanIntersects).not.toHaveBeenCalled()
  })
  it('maps remaining Turf exceptions to a stable query error', () => {
    const item = { bbox: [0, 0, 1, 1], properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } as StacItem
    const query = parseStacQuery(new URLSearchParams({ intersects: JSON.stringify({ type: 'Point', coordinates: [0.5, 0.5] }) }), true)
    vi.mocked(booleanIntersects).mockImplementationOnce(() => { throw new Error('private Turf diagnostics') })
    expect(() => matchesStacQuery(item, query)).toThrow('invalid_intersects')
  })
})