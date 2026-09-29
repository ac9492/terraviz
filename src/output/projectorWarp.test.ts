// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DEFAULT_BLEND_GAMMA,
  MAX_WARP_GRID,
  SOS_QUADRANT_VIEWPORTS,
  WIDE_TRIANGLE_FACTOR,
  blendFactor,
  buildWarpGeometry,
  directionToWarpUv,
  meshToClip,
  nodeDirection,
  parseWarpMesh,
  sampleWarpGeometry,
  sosQuadrantLayout,
  type WarpGeometry,
  type WarpMesh,
  type WarpRefusal,
  type WarpViewport,
} from './projectorWarp'
import { latLonToDirection, type Vec3 } from './equirectRtt'

const FIXTURES = resolve(__dirname, 'fixtures/projectorWarp')
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, name), 'utf8')
const FULL: WarpViewport = { x: 0, y: 0, w: 1, h: 1 }

/**
 * A regular mesh laid out as sphere-sim writes one: nodes corner to
 * corner, rows top first, `x` over ±aspect. `node` returns `[u, v, i]`,
 * or `null` for a node that reaches nothing.
 */
function gridText(
  cols: number,
  rows: number,
  node: (i: number, j: number) => [number, number, number] | null,
  aspect = 16 / 9,
): string {
  const lines = ['2', `${cols} ${rows}`]
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = ((2 * i) / (cols - 1) - 1) * aspect
      const y = 1 - (2 * j) / (rows - 1)
      const n = node(i, j)
      lines.push(n === null ? `${x} ${y} -1 -1 -1` : `${x} ${y} ${n[0]} ${n[1]} ${n[2]}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** A small, smooth patch of texture — the shape every real cell has. */
const smooth = (i: number, j: number): [number, number, number] => [0.45 + 0.02 * i, 0.55 - 0.02 * j, 1]

function parsed(text: string): WarpMesh {
  const result = parseWarpMesh(text)
  if (!result.ok) throw new Error(`refused: ${result.refusal.code} — ${result.refusal.detail}`)
  return result.mesh
}

function refusalOf(text: string): WarpRefusal {
  const result = parseWarpMesh(text)
  if (result.ok) throw new Error('parsed; a refusal was expected')
  return result.refusal
}

function angleRad(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y
  const cy = a.z * b.x - a.x * b.z
  const cz = a.x * b.y - a.y * b.x
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z)
}

/** Signed area of each drawn triangle, in clip space. */
function triangleAreas(g: WarpGeometry): number[] {
  const p = g.positions
  const areas: number[] = []
  for (let t = 0; t < g.vertexCount; t += 3) {
    const [x0, y0, x1, y1, x2, y2] = [p[t * 3], p[t * 3 + 1], p[t * 3 + 3], p[t * 3 + 4], p[t * 3 + 6], p[t * 3 + 7]]
    areas.push((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))
  }
  return areas
}

describe('parseWarpMesh', () => {
  it("reads sphere-sim's own export as written", () => {
    const mesh = parsed(fixture('boulder-P3.data'))
    expect(mesh.cols).toBe(41)
    expect(mesh.rows).toBe(41)
    // x spans ±the aspect, not ±1 — the format's asymmetry, and 16:9 here.
    expect(mesh.aspect).toBeCloseTo(16 / 9, 5)
    expect(mesh.nodes).toHaveLength(41 * 41)
    // The plan's count: 681 of 1,681 nodes land on the sphere.
    expect(mesh.nodes.filter((n) => n.drawable)).toHaveLength(681)
    // Row-major, top row first, as the file runs.
    expect(mesh.nodes[0]).toMatchObject({ x: -1.777778, y: 1, drawable: false })
    expect(mesh.nodes[40]).toMatchObject({ x: 1.777778, y: 1 })
    expect(mesh.nodes[41].y).toBeCloseTo(0.95, 6)
  })

  it("carries P3's seam into the nodes rather than smoothing it away", () => {
    // Two neighbours on the equator row: the texture wraps between them.
    const mesh = parsed(fixture('boulder-P3.data'))
    const k = mesh.nodes.findIndex((n, idx) => n.drawable && n.u === 1 && mesh.nodes[idx + 1].u < 0.02)
    expect(k).toBeGreaterThan(0)
    expect(mesh.nodes[k + 1].drawable).toBe(true)
  })

  it('treats either of the format’s no-data markers as enough on its own', () => {
    const mesh = parsed(
      ['2', '2 2', '-1 1 -1 -1 -1', '1 1 0 0 -1', '-1 -1 1.5 0.5 1', '1 -1 0.5 0.5 0.5'].join('\n'),
    )
    // Both markers; a valid texel with a negative weight; a texel off the texture.
    expect(mesh.nodes.map((n) => n.drawable)).toEqual([false, false, false, true])
    // A node that draws nothing carries nothing a caller could draw by mistake.
    expect(mesh.nodes[1]).toMatchObject({ weight: 0 })
    expect(mesh.nodes[1].u).toBeNaN()
    expect(mesh.nodes[3]).toMatchObject({ u: 0.5, v: 0.5, weight: 0.5 })
  })

  it('reads CRLF, a byte-order mark and blank lines the same as clean text', () => {
    const clean = gridText(3, 3, smooth)
    const messy = `\uFEFF${clean.replace(/\n/g, '\r\n').replace('\r\n', '\r\n\r\n')}\r\n  \r\n`
    expect(parseWarpMesh(messy)).toEqual(parseWarpMesh(clean))
  })

  it('reads a mesh written bottom row first, or mirrored', () => {
    // The file's positions decide where each node draws, so a writer's
    // row order or a rear-projection mirror is its own business.
    const lines = gridText(3, 3, smooth).trimEnd().split('\n')
    const bottomFirst = [lines[0], lines[1], ...lines.slice(8, 11), ...lines.slice(5, 8), ...lines.slice(2, 5)]
    expect(parseWarpMesh(bottomFirst.join('\n')).ok).toBe(true)
    const mirrored = lines.map((l, i) => (i < 2 ? l : l.replace(/^(\S+)/, (x) => String(-Number(x)))))
    expect(parseWarpMesh(mirrored.join('\n')).ok).toBe(true)
  })

  it('clamps a weight a rounding past 1 and refuses one plainly above it', () => {
    const almost = gridText(2, 2, () => [0.5, 0.5, 1.0000005])
    expect(parsed(almost).nodes.every((n) => n.weight === 1)).toBe(true)
    const over = refusalOf(gridText(2, 2, (i) => [0.5, 0.5, i === 1 ? 1.01 : 1]))
    expect(over).toMatchObject({ code: 'weight-out-of-range', line: 4 })
  })

  describe('refuses, with a code and the line to blame', () => {
    const good = gridText(3, 2, smooth).trimEnd().split('\n')
    const edited = (edit: (lines: string[]) => string[]): string => edit([...good]).join('\n')

    it('an empty file', () => {
      expect(refusalOf('').code).toBe('empty')
      expect(refusalOf(' \n\n\t\n').code).toBe('empty')
    })

    it('a mesh type other than rectangular', () => {
      expect(refusalOf(edited((l) => ['1', ...l.slice(1)]))).toMatchObject({ code: 'not-rectangular', line: 1 })
      expect(refusalOf(edited((l) => ['2.0', ...l.slice(1)])).code).toBe('not-rectangular')
    })

    it('dimensions that are not two whole numbers in range', () => {
      for (const dims of ['3', '3 x', '3 2 1', '2.5 2', '-3 2', '1 2', '3 0', `${MAX_WARP_GRID + 1} 2`]) {
        const refusal = refusalOf(edited((l) => [l[0], dims, ...l.slice(2)]))
        expect(refusal, dims).toMatchObject({ code: 'bad-dimensions', line: 2 })
      }
      expect(refusalOf('2\n').code).toBe('bad-dimensions')
    })

    it('a node line that is not five finite numbers', () => {
      for (const node of ['0 0 0.5 0.5', '0 0 0.5 0.5 1 1', '0 0 NaN 0.5 1', '0 0 0x1f 0.5 1', '0 0 .5. 0.5 1']) {
        const refusal = refusalOf(edited((l) => [...l.slice(0, 4), node, ...l.slice(5)]))
        expect(refusal, node).toMatchObject({ code: 'bad-node', line: 5 })
      }
      const huge = refusalOf(edited((l) => [...l.slice(0, 4), '0 0 1e999 0.5 1', ...l.slice(5)]))
      expect(huge).toMatchObject({ code: 'bad-node', line: 5 })
    })

    it('more or fewer nodes than the header states', () => {
      expect(refusalOf(edited((l) => l.slice(0, -1)))).toMatchObject({ code: 'node-count', line: 7 })
      expect(refusalOf(edited((l) => [...l, l[2]]))).toMatchObject({ code: 'node-count', line: 9 })
    })

    it('positions that do not form a grid', () => {
      // Two nodes of the top row swapped: x runs backwards once.
      const swapped = refusalOf(edited((l) => [l[0], l[1], l[3], l[2], ...l.slice(4)]))
      expect(swapped.code).toBe('not-a-grid')
      // The header's cols and rows exchanged, as a writer that transposed would.
      const transposed = refusalOf(gridText(3, 2, smooth).replace('3 2', '2 3'))
      expect(transposed.code).toBe('not-a-grid')
    })

    it('a raster span other than ±aspect by ±1', () => {
      // Normalized to [0, 1] instead: this mesh would land in a quarter of its viewport.
      const unit = gridText(3, 3, smooth)
        .trimEnd()
        .split('\n')
        .map((line, k) => {
          if (k < 2) return line
          const [x, y, ...rest] = line.split(' ')
          return [(Number(x) / (16 / 9) + 1) / 2, (Number(y) + 1) / 2, ...rest].join(' ')
        })
        .join('\n')
      expect(refusalOf(unit).code).toBe('bad-extent')
      expect(refusalOf(gridText(3, 3, smooth, 10)).code).toBe('bad-extent')
    })

    it('a mesh in which nothing reaches the surface', () => {
      expect(refusalOf(gridText(3, 3, () => null)).code).toBe('nothing-drawable')
    })
  })
})

describe('buildWarpGeometry', () => {
  it('draws two non-indexed triangles per cell, each vertex carrying all three attributes', () => {
    const g = buildWarpGeometry([{ mesh: parsed(gridText(3, 2, smooth)), viewport: FULL }])
    expect(g.meshes).toEqual([{ triangles: 4, droppedNoData: 0, droppedWide: 0, medianWidthRad: expect.any(Number) }])
    expect(g.vertexCount).toBe(12)
    expect(g.positions).toHaveLength(36)
    expect(g.directions).toHaveLength(36)
    expect(g.weights).toHaveLength(12)
    for (let k = 0; k < g.vertexCount; k++) {
      const [x, y, z] = g.directions.subarray(k * 3, k * 3 + 3)
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6)
      expect(g.positions[k * 3 + 2]).toBe(0)
    }
  })

  it("drops the triangle touching a no-data node, and not its cell's other one", () => {
    const g = buildWarpGeometry([{ mesh: parsed(gridText(3, 3, (i, j) => (i === 0 && j === 0 ? null : smooth(i, j)))), viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 7, droppedNoData: 1, droppedWide: 0 })
  })

  it("turns each node's texel into a direction through equirectRtt's frame", () => {
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.8], [1, 0.3], [0, 0.3]]) {
      const expected = latLonToDirection((v - 0.5) * 180, (u - 0.5) * 360)
      const d = nodeDirection(u, v)
      expect([d.x, d.y, d.z]).toEqual([expected.x, expected.y, expected.z])
      const back = directionToWarpUv(d)
      // u = 0 and u = 1 are one meridian; the recovery picks one of them.
      expect(Math.min(Math.abs(back.u - u), 1 - Math.abs(back.u - u))).toBeLessThan(1e-12)
      expect(back.v).toBeCloseTo(v, 12)
    }
  })

  it('interpolates across the seam instead of sweeping back through the texture', () => {
    // One cell straddling ±180°: u ≈ 0.99 on the left, ≈ 0.01 on the right.
    const mesh = parsed(gridText(2, 2, (i, j) => [i === 0 ? 0.99 : 0.01, 0.49 + 0.02 * j, 1], 1))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 2, droppedWide: 0 })
    // Interpolated as written, the cell's centre would read u = 0.5 — the far side of the world.
    const centre = sampleWarpGeometry(g, 0, 0)!
    expect(Math.min(centre.u, 1 - centre.u)).toBeLessThan(1e-6)
    expect(centre.v).toBeCloseTo(0.5, 6)
  })

  it('interpolates through a pole that no unwrap of u can reach', () => {
    // Four corners at 88°N, a quarter-turn apart: the cell encloses the pole.
    const lon = [[135, 45], [-135, -45]]
    const mesh = parsed(gridText(2, 2, (i, j) => [lon[j][i] / 360 + 0.5, 88 / 180 + 0.5, 1], 1))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 2, droppedWide: 0 })
    // Unwrapped (u, v) puts the centre at 88°N, two degrees off the pole it holds.
    expect(sampleWarpGeometry(g, 0, 0)!.v).toBeCloseTo(1, 6)
  })

  it(`drops and counts a triangle wider than ${WIDE_TRIANGLE_FACTOR}× the median`, () => {
    // One corner node sent to the far side of the texture: a UV-island straddle.
    const mesh = parsed(gridText(4, 4, (i, j) => (i === 3 && j === 3 ? [0.95, 0.55, 1] : smooth(i, j))))
    const g = buildWarpGeometry([{ mesh, viewport: FULL }])
    expect(g.meshes[0]).toMatchObject({ triangles: 17, droppedNoData: 0, droppedWide: 1 })
  })

  it('winds every triangle counter-clockwise, whichever way the file runs', () => {
    const lines = gridText(3, 3, smooth).trimEnd().split('\n')
    const bottomFirst = [lines[0], lines[1], ...lines.slice(8, 11), ...lines.slice(5, 8), ...lines.slice(2, 5)]
    const mirrored = lines.map((l, i) => (i < 2 ? l : l.replace(/^(\S+)/, (x) => String(-Number(x)))))
    for (const text of [lines.join('\n'), bottomFirst.join('\n'), mirrored.join('\n')]) {
      const areas = triangleAreas(buildWarpGeometry([{ mesh: parsed(text), viewport: FULL }]))
      expect(areas).toHaveLength(8)
      expect(areas.every((a) => a > 0)).toBe(true)
    }
  })

  it("places a mesh in its viewport, x over the file's own aspect", () => {
    const aspect = 16 / 9
    // P3 is SOS's top-left quadrant; P1 its bottom-left. GL's y is up, so no flip.
    expect(meshToClip(-aspect, 1, aspect, SOS_QUADRANT_VIEWPORTS.P3)).toEqual({ x: -1, y: 1 })
    expect(meshToClip(aspect, -1, aspect, SOS_QUADRANT_VIEWPORTS.P3)).toEqual({ x: 0, y: 0 })
    expect(meshToClip(-aspect, -1, aspect, SOS_QUADRANT_VIEWPORTS.P1)).toEqual({ x: -1, y: -1 })
    expect(meshToClip(0, 0, aspect, SOS_QUADRANT_VIEWPORTS.P4)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('concatenates a set and reports each mesh on its own', () => {
    const a = parsed(gridText(3, 2, smooth))
    const b = parsed(gridText(3, 3, (i, j) => (i === 0 && j === 0 ? null : smooth(i, j))))
    const g = buildWarpGeometry([
      { mesh: a, viewport: SOS_QUADRANT_VIEWPORTS.P1 },
      { mesh: b, viewport: SOS_QUADRANT_VIEWPORTS.P4 },
    ])
    expect(g.meshes.map((m) => m.triangles)).toEqual([4, 7])
    expect(g.vertexCount).toBe(33)
    // The first mesh's vertices are all in P1's quadrant, the second's in P4's.
    for (let k = 0; k < g.vertexCount; k++) {
      const [x, y] = [g.positions[k * 3], g.positions[k * 3 + 1]]
      if (k < 12) expect(x <= 0 && y <= 0).toBe(true)
      else expect(x >= 0 && y >= 0).toBe(true)
    }
  })

  it('refuses a viewport outside the framebuffer', () => {
    const mesh = parsed(gridText(2, 2, smooth))
    for (const viewport of [
      { x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { x: 0, y: 0, w: 0, h: 1 },
      { x: -0.1, y: 0, w: 0.5, h: 0.5 },
      { x: Number.NaN, y: 0, w: 0.5, h: 0.5 },
    ]) {
      expect(() => buildWarpGeometry([{ mesh, viewport }]), JSON.stringify(viewport)).toThrow(RangeError)
    }
  })
})

describe('sampleWarpGeometry', () => {
  const mesh = parsed(gridText(3, 3, (i, j) => [0.45 + 0.02 * i, 0.55 - 0.02 * j, 0.25 * i]))
  const g = buildWarpGeometry([{ mesh, viewport: SOS_QUADRANT_VIEWPORTS.P1 }])

  it('returns nothing where no triangle is drawn', () => {
    expect(sampleWarpGeometry(g, 0.5, 0.5)).toBeNull()
  })

  it("returns a node's own texel and weight at the node", () => {
    const node = mesh.nodes[4]
    const at = meshToClip(node.x, node.y, mesh.aspect, SOS_QUADRANT_VIEWPORTS.P1)
    const s = sampleWarpGeometry(g, at.x, at.y)!
    expect(s.u).toBeCloseTo(node.u, 6)
    expect(s.v).toBeCloseTo(node.v, 6)
    expect(s.weight).toBeCloseTo(node.weight, 6)
  })

  it('interpolates the weight linearly, where it is linear light', () => {
    const left = mesh.nodes[3]
    const right = mesh.nodes[4]
    const mid = meshToClip((left.x + right.x) / 2, left.y, mesh.aspect, SOS_QUADRANT_VIEWPORTS.P1)
    expect(sampleWarpGeometry(g, mid.x, mid.y)!.weight).toBeCloseTo((left.weight + right.weight) / 2, 6)
  })
})

describe('blendFactor', () => {
  it('passes full weight and blacks out none', () => {
    expect(blendFactor(1, 2.2)).toBe(1)
    expect(blendFactor(0, 2.2)).toBe(0)
    expect(blendFactor(-1, 2.2)).toBe(0)
    expect(blendFactor(Number.NaN, 2.2)).toBe(0)
    expect(blendFactor(1.5, 2.2)).toBe(1)
  })

  it('is decode, multiply, encode — the weight applied in linear light', () => {
    for (const c of [0.2, 0.5, 0.9]) {
      for (const w of [0.1, 0.5, 0.75]) {
        for (const gamma of [1.8, 2.2, 2.4]) {
          expect(c * blendFactor(w, gamma)).toBeCloseTo(Math.pow(Math.pow(c, gamma) * w, 1 / gamma), 12)
        }
      }
    }
  })

  it('makes two half-weight projectors sum to the target, where an encoded multiply leaves 44%', () => {
    const gamma = DEFAULT_BLEND_GAMMA
    const c = 0.8
    const target = Math.pow(c, gamma)
    const linear = 2 * Math.pow(c * blendFactor(0.5, gamma), gamma)
    expect(linear / target).toBeCloseTo(1, 12)
    const encodedMultiply = 2 * Math.pow(c * 0.5, gamma)
    expect(encodedMultiply / target).toBeCloseTo(0.435, 3)
  })

  it('falls back to the default for a gamma no field could hold', () => {
    const expected = blendFactor(0.5, DEFAULT_BLEND_GAMMA)
    for (const gamma of [0, -2.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(blendFactor(0.5, gamma), String(gamma)).toBe(expected)
    }
  })
})

describe('sosQuadrantLayout', () => {
  it('places P1–P4 in any order, and a subset keeps its slots', () => {
    expect(sosQuadrantLayout(['P3', 'P1'])).toEqual({
      ok: true,
      viewports: [SOS_QUADRANT_VIEWPORTS.P3, SOS_QUADRANT_VIEWPORTS.P1],
    })
  })

  it('refuses an id the quadrants cannot place rather than guessing', () => {
    expect(sosQuadrantLayout(['P1', 'P5', 'p3'])).toEqual({ ok: false, code: 'unplaceable', ids: ['P5', 'p3'] })
    // Nothing inherited counts as a quadrant.
    expect(sosQuadrantLayout(['constructor', '__proto__'])).toMatchObject({ ok: false, code: 'unplaceable' })
  })

  it('refuses two meshes for one quadrant, and an empty set', () => {
    expect(sosQuadrantLayout(['P1', 'P2', 'P1'])).toEqual({ ok: false, code: 'duplicate', ids: ['P1'] })
    expect(sosQuadrantLayout([])).toEqual({ ok: false, code: 'empty', ids: [] })
  })
})

describe("parity with sphere-sim's own tracer", () => {
  interface Rig {
    name: string
    file: string
    projectorId: string
    resX: number
    resY: number
    samples: [number, number, number, number][]
  }
  const parity = JSON.parse(fixture('parity.json')) as {
    provenance: { sphereSimCommit: string }
    sosQuadrantViewports: ({ id: string } & WarpViewport)[]
    rigs: Rig[]
  }

  it('was generated from a named sphere-sim commit', () => {
    expect(parity.provenance.sphereSimCommit).toMatch(/^[0-9a-f]{40}$/)
  })

  it("holds SOS's quadrant table to sphere-sim's", () => {
    for (const { id, ...viewport } of parity.sosQuadrantViewports) {
      expect(SOS_QUADRANT_VIEWPORTS[id as keyof typeof SOS_QUADRANT_VIEWPORTS], id).toEqual(viewport)
    }
    expect(parity.sosQuadrantViewports.map((v) => v.id)).toEqual(Object.keys(SOS_QUADRANT_VIEWPORTS))
  })

  /**
   * Everything a sample needs to be judged: where the module puts it, and
   * where the mesh's own cell says it should be to within the grid's error.
   * The error is an angle in units of the cell's own pixel scale — the
   * measure the plan's numbers were taken in — and the tolerance steps by
   * the cell's distance from the silhouette, because the 41×41 grid is
   * least accurate in the ring beside it: measured over every triangle by
   * `scripts/generate-warp-parity-fixtures.ts`, independently of this
   * module, the worst is 28.4 px there, 5.2 px one ring in and 2.8 px
   * in the interior.
   */
  function judge(rig: Rig) {
    const mesh = parsed(fixture(rig.file))
    const layout = rig.name === 'boulder' ? sosQuadrantLayout([rig.projectorId]) : null
    const viewport = layout?.ok ? layout.viewports[0] : FULL
    const g = buildWarpGeometry([{ mesh, viewport }])
    const { cols, rows, nodes } = mesh
    const dirOf = (i: number, j: number): Vec3 => nodeDirection(nodes[j * cols + i].u, nodes[j * cols + i].v)
    const pxOf = (i: number, j: number): [number, number] => [(i / (cols - 1)) * rig.resX, (j / (rows - 1)) * rig.resY]
    const noData: [number, number][] = []
    nodes.forEach((n, k) => {
      if (!n.drawable) noData.push([k % cols, Math.floor(k / cols)])
    })

    return rig.samples.map(([px, py, u, v]) => {
      const x = ((px / rig.resX) * 2 - 1) * mesh.aspect
      const y = 1 - (py / rig.resY) * 2
      const clip = meshToClip(x, y, mesh.aspect, viewport)
      const s = sampleWarpGeometry(g, clip.x, clip.y)

      const fx = (px / rig.resX) * (cols - 1)
      const fy = (py / rig.resY) * (rows - 1)
      // A sample on a cell's edge is rounded to three decimals in the
      // fixture, so floor() alone can hand it to the neighbour — possibly a
      // cell the silhouette dropped, whose no-data corner would make every
      // figure below NaN. Take whichever adjacent cell is drawn.
      const drawnCell = (ci: number, cj: number): boolean =>
        [cj * cols + ci, cj * cols + ci + 1, (cj + 1) * cols + ci, (cj + 1) * cols + ci + 1].every((k) => nodes[k].drawable)
      const cellI = (f: number): number => Math.max(0, Math.min(cols - 2, Math.floor(f)))
      const cellJ = (f: number): number => Math.max(0, Math.min(rows - 2, Math.floor(f)))
      const EDGE = 1e-4
      const candidates = [-EDGE, EDGE].flatMap((dx) => [-EDGE, EDGE].map((dy) => [cellI(fx + dx), cellJ(fy + dy)]))
      const [i, j] = candidates.find(([ci, cj]) => drawnCell(ci, cj)) ?? [cellI(fx), cellJ(fy)]
      const corners: [number, number][] =
        fx - i + (fy - j) <= 1 ? [[i, j], [i + 1, j], [i, j + 1]] : [[i + 1, j], [i + 1, j + 1], [i, j + 1]]
      const edgeScale = (a: number, b: number): number => {
        const [pa, pb] = [pxOf(...corners[a]), pxOf(...corners[b])]
        return angleRad(dirOf(...corners[a]), dirOf(...corners[b])) / Math.hypot(pb[0] - pa[0], pb[1] - pa[1])
      }
      const radPerPx = (edgeScale(0, 1) + edgeScale(1, 2) + edgeScale(0, 2)) / 3
      let ring = Infinity
      for (const [ii, jj] of noData) {
        ring = Math.min(ring, Math.max(Math.abs(ii - i), Math.abs(jj - j), Math.abs(ii - i - 1), Math.abs(jj - j - 1)))
      }
      const truth = nodeDirection(u, v)
      const errorPx = s === null ? Infinity : angleRad(nodeDirection(s.u, s.v), truth) / radPerPx

      // The same point under a stock Bourke player's arithmetic, for the contrasts below.
      const cu = corners.map(([ci, cj]) => nodes[cj * cols + ci].u)
      const cv = corners.map(([ci, cj]) => nodes[cj * cols + ci].v)
      const cp = corners.map(([ci, cj]) => pxOf(ci, cj))
      const det = (cp[1][1] - cp[2][1]) * (cp[0][0] - cp[2][0]) + (cp[2][0] - cp[1][0]) * (cp[0][1] - cp[2][1])
      const l0 = ((cp[1][1] - cp[2][1]) * (px - cp[2][0]) + (cp[2][0] - cp[1][0]) * (py - cp[2][1])) / det
      const l1 = ((cp[2][1] - cp[0][1]) * (px - cp[2][0]) + (cp[0][0] - cp[2][0]) * (py - cp[2][1])) / det
      const l = [l0, l1, 1 - l0 - l1]
      const asWritten = nodeDirection(l[0] * cu[0] + l[1] * cu[1] + l[2] * cu[2], l[0] * cv[0] + l[1] * cv[1] + l[2] * cv[2])
      const unwrappedU = cu.map((c) => c - Math.round(c - cu[0]))
      const unwrapped = nodeDirection(
        l[0] * unwrappedU[0] + l[1] * unwrappedU[1] + l[2] * unwrappedU[2],
        l[0] * cv[0] + l[1] * cv[1] + l[2] * cv[2],
      )
      let wind = 0
      for (let k = 0; k < 3; k++) {
        const du = cu[(k + 1) % 3] - cu[k]
        wind += du - Math.round(du)
      }
      return {
        drawn: s !== null,
        ring,
        errorPx,
        seam: Math.max(...cu) - Math.min(...cu) > 0.5,
        pole: Math.abs(wind) > 0.5,
        asWrittenPx: angleRad(asWritten, truth) / radPerPx,
        unwrappedPx: angleRad(unwrapped, truth) / radPerPx,
      }
    })
  }

  const tolerancePx = (ring: number): number => (ring <= 2 ? 30 : ring === 3 ? 6 : 3)

  for (const rig of parity.rigs) {
    it(`${rig.name} ${rig.projectorId}: every sample within the grid's own error, by ring`, () => {
      const judged = judge(rig)
      expect(judged.length).toBeGreaterThan(200)
      expect(judged.every((j) => j.drawn)).toBe(true)
      // Written as "not within" so a NaN — a sample judged against a cell it
      // is not in — fails rather than slipping past a greater-than.
      const outside = judged.filter((j) => !(j.errorPx <= tolerancePx(j.ring)))
      expect(outside).toEqual([])
    })
  }

  it('boulder P3 crosses the seam in 38 of its 620 cells, as the plan counts them', () => {
    const { cols, rows, nodes } = parsed(fixture('boulder-P3.data'))
    let drawn = 0
    let seam = 0
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const corners = [nodes[j * cols + i], nodes[j * cols + i + 1], nodes[(j + 1) * cols + i], nodes[(j + 1) * cols + i + 1]]
        if (!corners.every((n) => n.drawable)) continue
        drawn++
        const us = corners.map((n) => n.u)
        if (Math.max(...us) - Math.min(...us) > 0.5) seam++
      }
    }
    expect([drawn, seam]).toEqual([620, 38])
  })

  it('boulder P3: the seam, which (u, v) as written sweeps across the whole world', () => {
    const seam = judge(parity.rigs.find((r) => r.name === 'boulder')!).filter((j) => j.seam)
    // Five points in each of the 76 seam triangles, less the few on a
    // diagonal that land in the neighbouring triangle once rounded.
    expect(seam.length).toBeGreaterThan(300)
    expect(Math.max(...seam.map((j) => j.errorPx))).toBeLessThan(tolerancePx(2))
    expect(Math.max(...seam.map((j) => j.asWrittenPx))).toBeGreaterThan(1000)
  })

  it('placed rig: the pole, where directions hold and unwrapped (u, v) cannot', () => {
    const pole = judge(parity.rigs.find((r) => r.name === 'placed-pole')!).filter((j) => j.pole)
    expect(pole.length).toBeGreaterThan(0)
    const worstDirection = Math.max(...pole.map((j) => j.errorPx))
    const worstUnwrapped = Math.max(...pole.map((j) => j.unwrappedPx))
    // The plan's measurement: within 2 px under directions, tens of px under (u, v).
    expect(worstDirection).toBeLessThanOrEqual(2)
    expect(worstUnwrapped).toBeGreaterThan(19)
    expect(worstUnwrapped).toBeGreaterThan(10 * worstDirection)
  })

  it('drops nothing as too wide on a sphere: the widest real triangle is far inside the bound', () => {
    for (const rig of parity.rigs) {
      const mesh = parsed(fixture(rig.file))
      const g = buildWarpGeometry([{ mesh, viewport: FULL }])
      expect(g.meshes[0].droppedWide, rig.name).toBe(0)
      let widest = 0
      for (let t = 0; t < g.vertexCount; t += 3) {
        const d = [0, 1, 2].map((k): Vec3 => {
          const [x, y, z] = g.directions.subarray((t + k) * 3, (t + k) * 3 + 3)
          return { x, y, z }
        })
        widest = Math.max(widest, angleRad(d[0], d[1]), angleRad(d[1], d[2]), angleRad(d[0], d[2]))
      }
      // The plan's figure is 3.6× on Boulder and both placed rigs; the bound is 8×.
      expect(widest / g.meshes[0].medianWidthRad, rig.name).toBeLessThan(4)
    }
  })
})
