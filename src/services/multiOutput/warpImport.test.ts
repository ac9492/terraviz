// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAX_WARP_MESHES, SOS_QUADRANT_VIEWPORTS, type SosQuadrantId, type WarpSetEntry } from '../../output/projectorWarp'
import { crc32 } from './storedZip'
import {
  MAX_WARP_IMPORT_BYTES,
  assembleWarpSet,
  readWarpSources,
  warpSetId,
  type WarpImportFile,
  type WarpImportRefusal,
  type WarpSource,
} from './warpImport'

const enc = new TextEncoder()

/** sphere-sim's own bundle: four 5×5 meshes, and an older 4×4 `P1` under `restore/`. */
const BUNDLE: WarpImportFile = {
  name: 'sphere-sim-files.zip',
  bytes: new Uint8Array(readFileSync(resolve(__dirname, '../../output/fixtures/projectorWarp/sphere-sim-bundle.zip'))),
}

/** The smallest mesh the parser accepts: 2×2, 16:9, every node drawn. */
const MESH = ['2', '2 2', '-1.777778 1 0.25 0.75 1', '1.777778 1 0.75 0.75 1', '-1.777778 -1 0.25 0.25 1', '1.777778 -1 0.75 0.25 1', ''].join('\n')

function push16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff)
}
function push32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
}

/** Stored entries, UTF-8 names — sphere-sim's shape — with an optional method per entry. */
function zipOf(entries: readonly { name: string; text: string; method?: number }[]): Uint8Array {
  const local: number[] = []
  const central: number[] = []
  for (const e of entries) {
    const name = enc.encode(e.name)
    const body = enc.encode(e.text)
    const offset = local.length
    // Flags (UTF-8 names), method, the DOS epoch, CRC, sizes, name and extra lengths.
    const shared = (out: number[]): void => {
      push16(out, 0x800)
      push16(out, e.method ?? 0)
      push16(out, 0)
      push16(out, 0x21)
      push32(out, crc32(body))
      push32(out, body.length)
      push32(out, body.length)
      push16(out, name.length)
      push16(out, 0)
    }
    push32(local, 0x04034b50)
    push16(local, 20)
    shared(local)
    local.push(...name, ...body)
    push32(central, 0x02014b50)
    push16(central, 20)
    push16(central, 20)
    shared(central)
    push16(central, 0)
    push16(central, 0)
    push16(central, 0)
    push32(central, 0)
    push32(central, offset)
    central.push(...name)
  }
  const end: number[] = []
  push32(end, 0x06054b50)
  push16(end, 0)
  push16(end, 0)
  push16(end, entries.length)
  push16(end, entries.length)
  push32(end, central.length)
  push32(end, local.length)
  push16(end, 0)
  return Uint8Array.from([...local, ...central, ...end])
}

const file = (name: string, text: string): WarpImportFile => ({ name, bytes: enc.encode(text) })
const archive = (entries: readonly { name: string; text: string; method?: number }[]): WarpImportFile => ({
  name: 'rig.zip',
  bytes: zipOf(entries),
})

function sources(files: readonly WarpImportFile[]): readonly WarpSource[] {
  const read = readWarpSources(files)
  if (!read.ok) throw new Error(`expected sources, got ${JSON.stringify(read.refusal)}`)
  return read.sources
}

function refusalOf(files: readonly WarpImportFile[]): WarpImportRefusal {
  const read = readWarpSources(files)
  if (read.ok) throw new Error('expected a refusal')
  return read.refusal
}

describe('readWarpSources — a sphere-sim bundle', () => {
  it('takes the four meshes at the root, in rig order, and names where each came from', () => {
    const read = sources([BUNDLE])
    expect(read.map((s) => s.id)).toEqual(['P1', 'P2', 'P3', 'P4'])
    expect(read.map((s) => s.sourceName)).toEqual([
      'sphere-sim-files.zip/warp/P1.data',
      'sphere-sim-files.zip/warp/P2.data',
      'sphere-sim-files.zip/warp/P3.data',
      'sphere-sim-files.zip/warp/P4.data',
    ])
    expect(read.every((s) => s.mesh.cols === 5 && s.mesh.rows === 5)).toBe(true)
  })

  it('never takes the previous calibration a restore point keeps beside it', () => {
    // The bundle's `restore/warp/P1.data` is a 4×4 export under the same name.
    expect(sources([BUNDLE])[0].text.startsWith('2\n5 5\n')).toBe(true)
    const onlyTheOld = archive([{ name: 'restore/warp/P1.data', text: MESH }])
    expect(refusalOf([onlyTheOld])).toEqual({ code: 'no-meshes', file: 'rig.zip' })
    const nested = archive([
      { name: 'warp/old/P1.data', text: MESH },
      { name: 'warp/P2.data', text: MESH },
    ])
    expect(sources([nested]).map((s) => s.id)).toEqual(['P2'])
  })

  it('reads nothing but the meshes — a compressed README beside them costs nothing', () => {
    const rig = archive([
      { name: 'README.txt', text: 'recompressed', method: 8 },
      { name: 'warp/P1.data', text: MESH },
    ])
    expect(sources([rig]).map((s) => s.id)).toEqual(['P1'])
  })

  it('refuses a mesh entry it cannot read, naming the archive and the entry', () => {
    const recompressed = archive([{ name: 'warp/P1.data', text: MESH, method: 8 }])
    expect(refusalOf([recompressed])).toMatchObject({
      code: 'archive',
      file: 'rig.zip',
      zip: { code: 'compressed', entry: 'warp/P1.data' },
    })
    expect(refusalOf([{ name: 'rig.zip', bytes: enc.encode(MESH) }])).toMatchObject({
      code: 'archive',
      zip: { code: 'not-a-zip' },
    })
  })

  it('refuses two entries for one projector, whichever case they are in', () => {
    const twice = archive([
      { name: 'warp/P1.data', text: MESH },
      { name: 'warp/P1.data', text: MESH },
    ])
    expect(refusalOf([twice])).toEqual({ code: 'duplicate-id', ids: ['P1'] })
    const cased = archive([
      { name: 'warp/P1.data', text: MESH },
      { name: 'warp/p1.data', text: MESH },
    ])
    expect(refusalOf([cased])).toEqual({ code: 'duplicate-id', ids: ['p1'] })
  })

  it('refuses an entry name that cannot be a projector id', () => {
    expect(refusalOf([archive([{ name: 'warp/\u0001.data', text: MESH }])])).toEqual({
      code: 'bad-name',
      file: 'rig.zip/warp/\u0001.data',
    })
  })
})

describe('readWarpSources — picked mesh files', () => {
  it('takes the id from each file name, in the order picked', () => {
    const read = sources([file('P3.data', MESH), file('P1.DATA', MESH), file('Projector 2.data', MESH)])
    expect(read.map((s) => s.id)).toEqual(['P3', 'P1', 'Projector 2'])
    expect(read.map((s) => s.sourceName)).toEqual(['P3.data', 'P1.DATA', 'Projector 2.data'])
    expect(read[0].text).toBe(MESH)
  })

  it('refuses a mesh that does not parse, naming the file and the line', () => {
    const broken = MESH.replace('0.75 0.25 1', '0.75 0.25')
    expect(refusalOf([file('P1.data', MESH), file('P2.data', broken)])).toMatchObject({
      code: 'mesh',
      file: 'P2.data',
      mesh: { code: 'bad-node', line: 6 },
    })
  })

  it('refuses a file that is not text', () => {
    expect(refusalOf([{ name: 'P1.data', bytes: Uint8Array.of(0x32, 0x0a, 0xff, 0xfe) }])).toEqual({
      code: 'not-text',
      file: 'P1.data',
    })
  })

  it('refuses names that cannot be ids, and ids that collide', () => {
    expect(refusalOf([file('.data', MESH)])).toEqual({ code: 'bad-name', file: '.data' })
    expect(refusalOf([file(' P1.data', MESH)])).toEqual({ code: 'bad-name', file: ' P1.data' })
    expect(refusalOf([file('P1.data', MESH), file('p1.data', MESH)])).toEqual({ code: 'duplicate-id', ids: ['p1'] })
  })
})

describe('readWarpSources — what was picked', () => {
  it('refuses nothing, too much, or an archive with company', () => {
    expect(refusalOf([])).toEqual({ code: 'nothing-picked' })
    const huge = { name: 'P1.data', bytes: new Uint8Array(MAX_WARP_IMPORT_BYTES + 1) }
    expect(refusalOf([huge])).toEqual({ code: 'too-large', bytes: MAX_WARP_IMPORT_BYTES + 1 })
    expect(refusalOf([BUNDLE, file('P1.data', MESH)])).toEqual({ code: 'mixed-selection' })
    expect(refusalOf([BUNDLE, { ...BUNDLE, name: 'again.zip' }])).toEqual({ code: 'mixed-selection' })
  })

  it('refuses a file that is neither a bundle nor a mesh', () => {
    expect(refusalOf([file('P1.data', MESH), file('notes.txt', MESH)])).toEqual({
      code: 'unsupported-file',
      file: 'notes.txt',
    })
  })

  it('refuses more meshes than an output carries, before reading any', () => {
    const many = Array.from({ length: MAX_WARP_MESHES + 1 }, (_, i) => file(`P${i + 1}.data`, 'not a mesh'))
    expect(refusalOf(many)).toEqual({ code: 'too-many', count: MAX_WARP_MESHES + 1 })
  })
})

describe('assembleWarpSet', () => {
  it('places a bundle in SOS\'s quadrants when the operator says so, and checks it whole', () => {
    const assembled = assembleWarpSet(sources([BUNDLE]), 'sos-quadrants')
    if (!assembled.ok) throw new Error(JSON.stringify(assembled.refusal))
    expect(assembled.set.layoutFrom).toBe('sos-quadrants')
    for (const mesh of assembled.set.meshes) {
      expect(mesh.viewport).toEqual(SOS_QUADRANT_VIEWPORTS[mesh.id as SosQuadrantId])
    }
    expect(assembled.placed).toHaveLength(4)
    expect(assembled.placed[2].viewport).toEqual(SOS_QUADRANT_VIEWPORTS.P3)
    expect(assembled.placed[2].mesh.cols).toBe(5)
    expect(assembled.id).toBe(warpSetId(assembled.set.meshes))
    expect(assembled.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('refuses ids the quadrants have no place for, rather than guessing one', () => {
    const placedRig = sources([file('P1.data', MESH), file('P5.data', MESH)])
    expect(assembleWarpSet(placedRig, 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'layout', reason: 'unplaceable', ids: ['P5'] },
    })
    const named = sources([file('Projector 1.data', MESH)])
    expect(assembleWarpSet(named, 'sos-quadrants')).toMatchObject({ refusal: { code: 'layout', ids: ['Projector 1'] } })
  })

  it('refuses two meshes for one quadrant, and an empty set', () => {
    const one = sources([file('P1.data', MESH)])[0]
    expect(assembleWarpSet([one, one], 'sos-quadrants')).toEqual({
      ok: false,
      refusal: { code: 'layout', reason: 'duplicate', ids: ['P1'] },
    })
    expect(assembleWarpSet([], 'sos-quadrants')).toEqual({ ok: false, refusal: { code: 'set', set: { code: 'no-meshes' } } })
  })
})

describe('warpSetId', () => {
  const entries: WarpSetEntry[] = [
    { id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS.P1, text: MESH },
    { id: 'P2', viewport: SOS_QUADRANT_VIEWPORTS.P2, text: MESH.replace('0.25 0.75', '0.26 0.75') },
  ]

  it('is the content and placement, whatever order the files were picked in', () => {
    expect(warpSetId([...entries].reverse())).toBe(warpSetId(entries))
  })

  it('changes with a byte of any mesh, a swapped placement, or a renamed projector', () => {
    const base = warpSetId(entries)
    expect(warpSetId([entries[0], { ...entries[1], text: `${entries[1].text} ` }])).not.toBe(base)
    expect(
      warpSetId([
        { ...entries[0], viewport: entries[1].viewport },
        { ...entries[1], viewport: entries[0].viewport },
      ]),
    ).not.toBe(base)
    expect(warpSetId([{ ...entries[0], id: 'P3' }, entries[1]])).not.toBe(base)
  })

  it('ignores where a mesh came from, which is not part of what it draws', () => {
    const named = entries.map((e) => ({ ...e, sourceName: `elsewhere/${e.id}.data` }))
    expect(warpSetId(named)).toBe(warpSetId(entries))
  })

  it('holds its canonical form: a change here re-keys every stored set', () => {
    // Pinned, not derived from this module: computed independently from the
    // canonical form with Python's zlib.crc32 and a textbook FNV-1a, whose
    // own check values ('a' → e40c292c, 'foobar' → bf9cf968) it reproduces.
    expect(warpSetId([{ id: 'P1', viewport: SOS_QUADRANT_VIEWPORTS.P1, text: MESH }])).toBe('c8e6838378a11cac')
  })
})
