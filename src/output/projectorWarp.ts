// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The geometry build for a `projector-warp` output
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16 — a sphere-sim warp bundle on
 * one output"): sphere-sim's warp meshes in, triangles an output can
 * draw out.
 *
 * A sphere-sim export carries one Paul Bourke type-2 mesh per lit
 * projector — `2`, then `cols rows`, then one `x y u v i` line per node,
 * row by row. `x` spans ±the projector's aspect and `y` ±1, y up;
 * `(u, v)` is the equirect texel that belongs at the node, v up; `i` is
 * its blend weight. The output's quad is already the degenerate case of
 * that file — a 2×2 mesh with the identity mapping — so a warp replaces
 * the geometry and one line of the fragment's contract, and nearly all
 * of the rung's correctness lives in the build below. It needs no GL, no
 * DOM and no Three, which is why every rule is a unit test.
 *
 * **The parse is fail-closed.** A mesh in the wrong place, the wrong
 * orientation or the wrong units still draws a plausible picture, so
 * anything this module cannot read with certainty is refused whole,
 * with a code the panel words and a line to point at. It is also the
 * *only* parse: a set is persisted as the files' own text and re-read
 * through this function on restore, so there is one set of refusals.
 *
 * **Directions are interpolated, not texels.** `u` is wrapped to [0, 1)
 * at every node, so a cell straddling the ±180° meridian has corners at
 * u ≈ 1 and u ≈ 0 and, interpolated as written, sweeps backwards through
 * the whole texture — 38 of 620 cells on the Boulder rig's P3. Unwrapping
 * `u` per triangle mends that and fails at a pole, whose triangles go all
 * the way round in longitude. Each node therefore becomes a unit
 * direction in the shader's own frame, through `equirectRtt`'s
 * `latLonToDirection` rather than a restatement of it, and the fragment
 * normalizes the interpolated vector and recovers `(u, v)`. Neighbours
 * on the sphere are neighbours in direction whichever side of the seam
 * or pole they sit, so both cases are one rule. Measured against
 * sphere-sim's own tracer the two interpolations are a wash where
 * `(u, v)` works, and around a pole directions stay within 2 px where
 * unwrapped `(u, v)` lands tens of pixels out — up to 66 in the fixture
 * generator's survey. The parity test pins both sides.
 *
 * **Two drops, one expected and one counted.** A triangle touching a
 * node that reaches nothing is dropped, not clamped: a `-1` node
 * interpolated towards its neighbours smears texel (0, 0) across the
 * cell. That is the silhouette and happens on every mesh. A triangle
 * wider than `WIDE_TRIANGLE_FACTOR` times the mesh's own median width is
 * dropped too, and counted for the HUD, because nothing on a sphere
 * reaches it — the widest measured on Boulder or on either placed rig is
 * 3.6 times the median — so a drop means a cell straddling two UV islands
 * of a mesh surface, whose corners are neighbours on the model and
 * strangers in the texture.
 *
 * **The weight is linear light.** sphere-sim's `i` multiplies radiance
 * and is encoded afterwards (its conventions.ts §B, clause 4). A player
 * that multiplies the encoded pixel instead leaves two half-weight
 * projectors emitting about 22% each: a band at 44% of target along
 * every seam. `blendFactor` is the multiplier that applies it correctly
 * to an encoded colour, per fragment, after `i` is interpolated.
 *
 * **Placement is never inferred from a projector id.** `nominalRig`
 * names a projector after its SOS slot, `placedRig` after its placement
 * order, and the two reuse the same names for different places. So this
 * module takes each mesh's viewport as an input, and the one table it
 * holds — SOS's quadrants — is applied only when the operator chose it,
 * with an id it cannot place refused rather than guessed at.
 */

import {
  directionToLatLon,
  latLonToDirection,
  latLonToSphereUv,
  outputUvToLatLon,
  type Vec3,
} from './equirectRtt'
import { DEFAULT_BLEND_GAMMA } from '../services/multiOutput/protocol'

/** One node as the file states it. */
export interface WarpNode {
  /** Raster position: `x` across ±the file's aspect, `y` up across ±1. */
  readonly x: number
  readonly y: number
  /** The equirect texel that belongs here, v up. `NaN` when not drawable. */
  readonly u: number
  readonly v: number
  /** Blend weight in linear light, [0, 1]. `0` when not drawable. */
  readonly weight: number
  /**
   * False for a node whose ray reached nothing. The format marks that two
   * ways — texture coordinates outside [0, 1], or a negative intensity —
   * and sphere-sim writes both (`-1 -1 -1`), but a reader that honoured
   * only one would draw a node written `0 0 -1` at texel (0, 0), so
   * either marker is enough.
   */
  readonly drawable: boolean
}

export interface WarpMesh {
  readonly cols: number
  readonly rows: number
  /**
   * The raster's aspect ratio, read from the file's own `x` span, which
   * the format defines as ±aspect: ±1.778 is 16:9. A writer that places
   * nodes at pixel centres rather than corners understates it by a cell;
   * sphere-sim spans corner to corner.
   */
  readonly aspect: number
  /** Row-major, in file order. */
  readonly nodes: readonly WarpNode[]
}

/**
 * Why a file was refused. The panel words its own message from `code`,
 * which is why this is a closed set rather than a string.
 */
export type WarpRefusalCode =
  /** Nothing but whitespace. */
  | 'empty'
  /** The first line is not `2`: a polar or unknown mesh type. */
  | 'not-rectangular'
  /** The second line is not two whole numbers in [2, `MAX_WARP_GRID`]. */
  | 'bad-dimensions'
  /** A node line that is not five finite numbers. */
  | 'bad-node'
  /** More or fewer node lines than `cols × rows` — truncated, or not this format. */
  | 'node-count'
  /** A drawable node's weight above 1, which no blend of shares produces. */
  | 'weight-out-of-range'
  /** Positions that do not run monotonically along rows and down columns. */
  | 'not-a-grid'
  /** A raster span other than the format's ±aspect by ±1. */
  | 'bad-extent'
  /** Every node reaches nothing: the file would draw a black projector. */
  | 'nothing-drawable'

export interface WarpRefusal {
  readonly code: WarpRefusalCode
  /** 1-based line of the file, where one line is to blame. */
  readonly line?: number
  /** For a developer reading a log. */
  readonly detail: string
}

export type WarpParseResult =
  | { readonly ok: true; readonly mesh: WarpMesh }
  | { readonly ok: false; readonly refusal: WarpRefusal }

/**
 * The largest grid read, per axis. sphere-sim's default is 41; a finer
 * export is legitimate, and 1,024 is two orders past it — the bound is
 * against a file that is not a mesh at all claiming a grid that would
 * exhaust memory before the node count could refuse it.
 */
export const MAX_WARP_GRID = 1024

/**
 * How far the `y` extent may fall short of ±1. Wide enough for a writer
 * that places nodes at pixel centres down to ~20 rows, and far too
 * narrow for the failure it exists to catch: a file normalized to
 * [0, 1], whose mesh would otherwise land in a quarter of its viewport.
 */
const Y_EXTENT_TOLERANCE = 0.05
/** An `x` span centred to within rounding, as ±aspect must be. */
const X_CENTRE_TOLERANCE = 1e-3
/** Portrait projectors reach 0.5; nothing real is a sliver or a strip. */
const MIN_ASPECT = 0.2
const MAX_ASPECT = 5
/** Weights are written to six decimals; a sum of shares may round just past 1. */
const WEIGHT_EPSILON = 1e-6

/** A decimal number, exponent allowed. `Number()` alone accepts `''`, `'0x1f'` and `' '`. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const WHOLE = /^\d+$/

function refuse(code: WarpRefusalCode, detail: string, line?: number): WarpParseResult {
  return { ok: false, refusal: line === undefined ? { code, detail } : { code, line, detail } }
}

/**
 * Read one Bourke type-2 mesh, or say exactly why not.
 *
 * Tolerated because they cannot move a node: CRLF line endings, a
 * leading byte-order mark, and blank lines — the format is positional in
 * nodes, and a blank line holds none. Everything else that is not the
 * format is refused, including trailing lines past the last node, since
 * a file with more nodes than its header states was written for a
 * different grid.
 */
export function parseWarpMesh(text: string): WarpParseResult {
  const lines: { n: number; s: string }[] = []
  // `trim` strips a byte-order mark too \u2014 ECMAScript counts U+FEFF as
  // whitespace \u2014 so the first line needs no special case.
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim()
    if (s !== '') lines.push({ n: i + 1, s })
  })
  if (lines.length === 0) return refuse('empty', 'the file holds nothing')

  const type = lines[0]
  if (type.s !== '2') {
    return refuse('not-rectangular', `mesh type "${type.s}"; only a rectangular mesh (type 2) is read`, type.n)
  }

  const dims = lines[1]
  const dimTokens = dims?.s.split(/\s+/) ?? []
  if (dims === undefined || dimTokens.length !== 2 || !dimTokens.every((t) => WHOLE.test(t))) {
    return refuse('bad-dimensions', 'the second line must be "<cols> <rows>"', dims?.n)
  }
  const cols = Number(dimTokens[0])
  const rows = Number(dimTokens[1])
  if (cols < 2 || rows < 2 || cols > MAX_WARP_GRID || rows > MAX_WARP_GRID) {
    return refuse('bad-dimensions', `a ${cols}×${rows} grid; each side must be 2 to ${MAX_WARP_GRID}`, dims.n)
  }

  const nodeLines = lines.slice(2)
  const expected = cols * rows
  if (nodeLines.length !== expected) {
    const last = nodeLines[nodeLines.length - 1]
    const blame = nodeLines.length > expected ? nodeLines[expected].n : (last?.n ?? dims.n)
    return refuse('node-count', `${nodeLines.length} node lines for a ${cols}×${rows} grid of ${expected}`, blame)
  }

  const nodes: WarpNode[] = new Array<WarpNode>(expected)
  let drawableCount = 0
  for (let k = 0; k < expected; k++) {
    const { n, s } = nodeLines[k]
    const tokens = s.split(/\s+/)
    if (tokens.length !== 5 || !tokens.every((t) => NUMBER.test(t))) {
      return refuse('bad-node', `expected "x y u v i", found "${s}"`, n)
    }
    const [x, y, u, v, i] = tokens.map(Number)
    if (![x, y, u, v, i].every(Number.isFinite)) {
      return refuse('bad-node', `a value too large to be a coordinate in "${s}"`, n)
    }
    const drawable = u >= 0 && u <= 1 && v >= 0 && v <= 1 && i >= 0
    if (drawable && i > 1 + WEIGHT_EPSILON) {
      return refuse('weight-out-of-range', `weight ${i} above 1`, n)
    }
    if (drawable) drawableCount++
    nodes[k] = drawable
      ? { x, y, u, v, weight: Math.min(i, 1), drawable }
      : { x, y, u: Number.NaN, v: Number.NaN, weight: 0, drawable }
  }

  // A grid that folds, or a file whose rows and columns were swapped by
  // its writer, still parses as numbers. Positions must run the same way
  // along every row and down every column; which way is the file's own,
  // since the triangles are built from its positions either way.
  const lineOf = (i: number, j: number): number => nodeLines[j * cols + i].n
  const at = (i: number, j: number): WarpNode => nodes[j * cols + i]
  const xStep = Math.sign(at(1, 0).x - at(0, 0).x)
  const yStep = Math.sign(at(0, 1).y - at(0, 0).y)
  if (xStep === 0 || yStep === 0) {
    return refuse('not-a-grid', 'the first row or column does not move', lineOf(1, 1))
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (i > 0 && Math.sign(at(i, j).x - at(i - 1, j).x) !== xStep) {
        return refuse('not-a-grid', `x does not run one way along row ${j}`, lineOf(i, j))
      }
      if (j > 0 && Math.sign(at(i, j).y - at(i, j - 1).y) !== yStep) {
        return refuse('not-a-grid', `y does not run one way down column ${i}`, lineOf(i, j))
      }
    }
  }

  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const { x, y } of nodes) {
    xMin = Math.min(xMin, x)
    xMax = Math.max(xMax, x)
    yMin = Math.min(yMin, y)
    yMax = Math.max(yMax, y)
  }
  if (Math.abs(yMax - 1) > Y_EXTENT_TOLERANCE || Math.abs(yMin + 1) > Y_EXTENT_TOLERANCE) {
    return refuse('bad-extent', `y spans [${yMin}, ${yMax}]; the format's vertical range is ±1`)
  }
  const aspect = (xMax - xMin) / 2
  if (Math.abs(xMax + xMin) > X_CENTRE_TOLERANCE * aspect || aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    return refuse('bad-extent', `x spans [${xMin}, ${xMax}]; the format's horizontal range is ±the aspect ratio`)
  }
  if (drawableCount === 0) {
    return refuse('nothing-drawable', 'no node reaches the surface')
  }

  return { ok: true, mesh: { cols, rows, aspect, nodes } }
}

/** A mesh's share of the framebuffer, as fractions with the origin at bottom-left. */
export interface WarpViewport {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface PlacedWarpMesh {
  readonly mesh: WarpMesh
  readonly viewport: WarpViewport
}

export interface WarpMeshStats {
  /** Triangles drawn. */
  readonly triangles: number
  /** Dropped for touching a node that reaches nothing: the silhouette, on every mesh. */
  readonly droppedNoData: number
  /** Dropped for exceeding `WIDE_TRIANGLE_FACTOR` × the median width — never on a sphere. */
  readonly droppedWide: number
  /** The median triangle width that bound is relative to, in radians. */
  readonly medianWidthRad: number
}

/**
 * Everything a draw needs, flat and non-indexed: three vertices per
 * triangle, each carrying a clip-space position, a unit direction in
 * the shader's frame, and a blend weight. Non-indexed because a vertex
 * is shared only by triangles that agree on it — a dropped neighbour
 * changes nothing — and indexing would buy a few kilobytes on a mesh
 * this size.
 */
export interface WarpGeometry {
  /** Clip space, three components per vertex, `z = 0`. */
  readonly positions: Float32Array
  /** Unit direction per vertex, three components. */
  readonly directions: Float32Array
  /** Blend weight per vertex, linear light. */
  readonly weights: Float32Array
  readonly vertexCount: number
  /** One entry per placed mesh, in input order. */
  readonly meshes: readonly WarpMeshStats[]
}

/**
 * How many times the median width a triangle may span before it is
 * treated as straddling UV islands. The widest measured on a sphere is
 * 3.6 times the median, so 8 leaves margin that no sphere reaches.
 */
export const WIDE_TRIANGLE_FACTOR = 8

/** A node's texel as a unit direction in the shader's frame. */
export function nodeDirection(u: number, v: number): Vec3 {
  const { lat, lon } = outputUvToLatLon(u, v)
  return latLonToDirection(lat, lon)
}

/**
 * The fragment's first step under a warp, as TypeScript: an interpolated
 * direction back to `(u, v)`. Normalizes, so it takes the interpolant as
 * the rasterizer hands it over.
 */
export function directionToWarpUv(d: Vec3): { u: number; v: number } {
  const { lat, lon } = directionToLatLon(d)
  return latLonToSphereUv(lat, lon)
}

/**
 * A node's raster position → clip space in its viewport: `x` divided by
 * the file's own aspect, then both axes scaled into the rect. No axis
 * flips — the format's `y` is up and so is GL's, which is the one
 * convention that lines up for free.
 */
export function meshToClip(x: number, y: number, aspect: number, viewport: WarpViewport): { x: number; y: number } {
  return {
    x: (viewport.x + ((x / aspect + 1) / 2) * viewport.w) * 2 - 1,
    y: (viewport.y + ((y + 1) / 2) * viewport.h) * 2 - 1,
  }
}

/** The angle between two directions — `atan2`, which keeps its precision at the tiny angles a cell spans. */
function angleBetween(a: Vec3, b: Vec3): number {
  const cx = a.y * b.z - a.z * b.y
  const cy = a.z * b.x - a.x * b.z
  const cz = a.x * b.y - a.y * b.x
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z)
}

/** Rounding slack for a viewport edge: SOS's quadrants meet at exactly 0.5. */
const VIEWPORT_EPSILON = 1e-9

function viewportInside({ x, y, w, h }: WarpViewport): boolean {
  return (
    [x, y, w, h].every(Number.isFinite) &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1 + VIEWPORT_EPSILON &&
    y + h <= 1 + VIEWPORT_EPSILON
  )
}

/** Two rects sharing area, not merely an edge. */
function viewportsOverlap(a: WarpViewport, b: WarpViewport): boolean {
  return (
    a.x < b.x + b.w - VIEWPORT_EPSILON &&
    b.x < a.x + a.w - VIEWPORT_EPSILON &&
    a.y < b.y + b.h - VIEWPORT_EPSILON &&
    b.y < a.y + a.h - VIEWPORT_EPSILON
  )
}

function assertViewport(viewport: WarpViewport, index: number): void {
  if (!viewportInside(viewport)) {
    throw new RangeError(`mesh ${index}: viewport ${JSON.stringify(viewport)} is not inside the framebuffer`)
  }
}

/**
 * Build one output's geometry from its placed meshes: two triangles per
 * cell, split along the same diagonal the plan's measurements used, and
 * every triangle wound counter-clockwise in clip space whichever way the
 * file runs, so a mirrored or bottom-first mesh draws under the default
 * face culling rather than vanishing.
 *
 * Throws on a viewport outside the framebuffer: viewports come from a
 * layout that has already been validated, so reaching here with one is a
 * bug upstream rather than something an operator did.
 */
export function buildWarpGeometry(placed: readonly PlacedWarpMesh[]): WarpGeometry {
  type Tri = [number, number, number]
  const perMesh = placed.map(({ mesh, viewport }, index) => {
    assertViewport(viewport, index)
    const { cols, rows, nodes } = mesh
    const dirs = nodes.map((n) => (n.drawable ? nodeDirection(n.u, n.v) : null))
    const candidates: { tri: Tri; width: number }[] = []
    let droppedNoData = 0
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i
        const b = a + 1
        const c = a + cols
        const d = c + 1
        for (const tri of [[a, b, c], [b, d, c]] as Tri[]) {
          const [p, q, r] = tri.map((k) => dirs[k])
          if (p === null || q === null || r === null) {
            droppedNoData++
            continue
          }
          candidates.push({ tri, width: Math.max(angleBetween(p, q), angleBetween(q, r), angleBetween(p, r)) })
        }
      }
    }
    const widths = candidates.map((t) => t.width).sort((p, q) => p - q)
    const medianWidthRad = widths.length === 0 ? 0 : widths[widths.length >> 1]
    // A zero median means most triangles name one texel — a degenerate file
    // with no scale to judge width against, so nothing is dropped for it.
    const bound = medianWidthRad > 0 ? WIDE_TRIANGLE_FACTOR * medianWidthRad : Infinity
    const kept = candidates.filter((t) => t.width <= bound).map((t) => t.tri)
    return {
      mesh,
      viewport,
      dirs,
      kept,
      stats: {
        triangles: kept.length,
        droppedNoData,
        droppedWide: candidates.length - kept.length,
        medianWidthRad,
      },
    }
  })

  const vertexCount = perMesh.reduce((sum, m) => sum + m.kept.length * 3, 0)
  const positions = new Float32Array(vertexCount * 3)
  const directions = new Float32Array(vertexCount * 3)
  const weights = new Float32Array(vertexCount)
  let vertex = 0
  for (const { mesh, viewport, dirs, kept } of perMesh) {
    for (const tri of kept) {
      const clip = tri.map((k) => meshToClip(mesh.nodes[k].x, mesh.nodes[k].y, mesh.aspect, viewport))
      const area =
        (clip[1].x - clip[0].x) * (clip[2].y - clip[0].y) - (clip[2].x - clip[0].x) * (clip[1].y - clip[0].y)
      const order = area < 0 ? [0, 2, 1] : [0, 1, 2]
      for (const o of order) {
        const k = tri[o]
        const dir = dirs[k] as Vec3
        positions.set([clip[o].x, clip[o].y, 0], vertex * 3)
        directions.set([dir.x, dir.y, dir.z], vertex * 3)
        weights[vertex] = mesh.nodes[k].weight
        vertex++
      }
    }
  }

  return { positions, directions, weights, vertexCount, meshes: perMesh.map((m) => m.stats) }
}

export interface WarpSample {
  readonly u: number
  readonly v: number
  readonly weight: number
}

/**
 * What the GPU draws at one clip-space point, as TypeScript: the
 * triangle that covers it, the direction and weight interpolated
 * linearly in screen space — which is what the rasterizer does with
 * `w = 1` — and the direction turned back into `(u, v)`. `null` where no
 * triangle covers the point: black in that projector's raster.
 *
 * The parity fixture's instrument, and a reference for anything that
 * later needs to ask which texel a projector pixel shows. A linear scan,
 * which is fine for a mesh of a few thousand triangles and a handful of
 * questions; not for a per-pixel loop.
 */
export function sampleWarpGeometry(geometry: WarpGeometry, clipX: number, clipY: number): WarpSample | null {
  const { positions: p, directions: d, weights: w } = geometry
  // Barycentric slack, scale-free: positions are float32, so a point on the
  // drawn region's edge can sit a rounding outside it, and 1e-5 of a
  // triangle's size covers that without admitting anything the GPU would not.
  const eps = 1e-5
  for (let t = 0; t < geometry.vertexCount; t += 3) {
    const x0 = p[t * 3], y0 = p[t * 3 + 1]
    const x1 = p[t * 3 + 3], y1 = p[t * 3 + 4]
    const x2 = p[t * 3 + 6], y2 = p[t * 3 + 7]
    const det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (det === 0) continue
    const l0 = ((y1 - y2) * (clipX - x2) + (x2 - x1) * (clipY - y2)) / det
    const l1 = ((y2 - y0) * (clipX - x2) + (x0 - x2) * (clipY - y2)) / det
    const l2 = 1 - l0 - l1
    if (l0 < -eps || l1 < -eps || l2 < -eps) continue
    const at = (c: number): number => l0 * d[t * 3 + c] + l1 * d[t * 3 + 3 + c] + l2 * d[t * 3 + 6 + c]
    const { u, v } = directionToWarpUv({ x: at(0), y: at(1), z: at(2) })
    return { u, v, weight: l0 * w[t] + l1 * w[t + 1] + l2 * w[t + 2] }
  }
  return null
}


/**
 * What an encoded colour is multiplied by to apply a linear-light weight:
 * `encode(decode(c) · w)` under a power law is `c · w^(1/γ)`, so the
 * decode and encode collapse into one exponent on the weight. Applied per
 * fragment after `w` is interpolated — the weight is linear, so it is
 * interpolated where it is linear and converted once.
 *
 * A γ that is not a positive number falls back to the default rather
 * than producing `NaN` or black: a corrupt field should cost the operator
 * their calibration of the blend, not the projector.
 */
export function blendFactor(weight: number, gamma: number): number {
  if (!(weight > 0)) return 0
  const g = Number.isFinite(gamma) && gamma > 0 ? gamma : DEFAULT_BLEND_GAMMA
  return Math.pow(Math.min(weight, 1), 1 / g)
}

/** The ids SOS's quadrant layout places, in sphere-sim's `nominalRig` order. */
export type SosQuadrantId = 'P1' | 'P2' | 'P3' | 'P4'

/**
 * SOS's one framebuffer split 2×2, origin bottom-left — sphere-sim's
 * `SOS_QUADRANT_VIEWPORTS` and SOS's own `projectorInfo(viewport)`. The
 * parity fixture carries sphere-sim's table so a test holds this copy to
 * it.
 */
export const SOS_QUADRANT_VIEWPORTS: Readonly<Record<SosQuadrantId, WarpViewport>> = {
  P1: { x: 0, y: 0, w: 0.5, h: 0.5 },
  P2: { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  P3: { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  P4: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
}

export type QuadrantLayoutResult =
  | { readonly ok: true; readonly viewports: readonly WarpViewport[] }
  | {
      readonly ok: false
      /** `unplaceable`: an id outside P1–P4. `duplicate`: two meshes for one quadrant. */
      readonly code: 'empty' | 'unplaceable' | 'duplicate'
      readonly ids: readonly string[]
    }

/**
 * Viewports for a set under SOS's quadrants, aligned with `ids`, or a
 * refusal naming the ids it could not place. For the operator's explicit
 * choice only — an id alone never implies this layout, because a placed
 * rig's `P1`…`P4` are not SOS's quadrants. Ids match exactly: `p3` is not
 * `P3`, since a guess is how a mesh lands in the wrong quadrant.
 */
export function sosQuadrantLayout(ids: readonly string[]): QuadrantLayoutResult {
  if (ids.length === 0) return { ok: false, code: 'empty', ids: [] }
  // Own keys only: `constructor` and `__proto__` are not quadrants.
  const isQuadrant = (id: string): id is SosQuadrantId =>
    Object.prototype.hasOwnProperty.call(SOS_QUADRANT_VIEWPORTS, id)
  const unplaceable = ids.filter((id) => !isQuadrant(id))
  if (unplaceable.length > 0) return { ok: false, code: 'unplaceable', ids: unplaceable }
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (duplicates.length > 0) return { ok: false, code: 'duplicate', ids: [...new Set(duplicates)] }
  return { ok: true, viewports: ids.map((id) => SOS_QUADRANT_VIEWPORTS[id as SosQuadrantId]) }
}

/**
 * The most meshes one output carries. Past any rig one framebuffer can
 * usefully be split for — sixty-four viewports leave each projector a
 * raster smaller than it is — so the bound is against a file that is
 * not a rig at all rather than against a large one.
 */
export const MAX_WARP_MESHES = 64

const MAX_WARP_ID_LENGTH = 64
/** C0 and C1 controls, both path separators, and the replacement character a bad decode leaves. */
const WARP_ID_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f/\\�]/

/**
 * Whether a string can name a projector. sphere-sim writes `P1`…`Pn`, or
 * whatever id a placed projector was given, and it arrives through a file
 * name — so the rule is what survives being one and being shown to an
 * operator: printable, no separators, not blank-edged, not all dots.
 */
export function isWarpId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_WARP_ID_LENGTH &&
    id.trim() === id &&
    !/^\.+$/.test(id) &&
    !WARP_ID_FORBIDDEN.test(id)
  )
}

/** One mesh of a set as it is carried and stored: the file's own text, and where it was placed. */
export interface WarpSetEntry {
  readonly id: string
  readonly viewport: WarpViewport
  readonly text: string
}

/** Why a set was refused. The panel and the output's HUD word their own messages from `code`. */
export type WarpSetRefusal =
  | { readonly code: 'no-meshes' }
  | { readonly code: 'too-many'; readonly count: number }
  | { readonly code: 'bad-id'; readonly id: string }
  /** Compared case-insensitively: `P1` and `p1` are one file on the disks they were extracted to. */
  | { readonly code: 'duplicate-id'; readonly ids: readonly string[] }
  | { readonly code: 'bad-viewport'; readonly id: string }
  /** Two projectors cannot share framebuffer pixels: each pixel reaches one projector. */
  | { readonly code: 'overlap'; readonly ids: readonly [string, string] }
  | { readonly code: 'mesh'; readonly id: string; readonly mesh: WarpRefusal }

export type WarpSetResult =
  | { readonly ok: true; readonly placed: readonly PlacedWarpMesh[] }
  | { readonly ok: false; readonly refusal: WarpSetRefusal }

/**
 * Check a whole set and parse every mesh in it, or refuse it whole.
 *
 * The one check a set passes wherever it is read — the manager on import
 * and again on restore, and the output on receipt — so a set refused in
 * one place is refused in all three, and none of them can hand
 * `buildWarpGeometry` a viewport it would throw on. Whole, never in part:
 * a rig missing one projector draws a picture with a hole where a quarter
 * of the sphere should be, and a hole looks like a lamp failure rather
 * than a refused file.
 *
 * `placed` is aligned with `entries`.
 */
export function placeWarpSet(entries: readonly WarpSetEntry[]): WarpSetResult {
  const refuse = (refusal: WarpSetRefusal): WarpSetResult => ({ ok: false, refusal })
  if (entries.length === 0) return refuse({ code: 'no-meshes' })
  if (entries.length > MAX_WARP_MESHES) return refuse({ code: 'too-many', count: entries.length })
  const bad = entries.find((e) => !isWarpId(e.id))
  if (bad !== undefined) return refuse({ code: 'bad-id', id: bad.id })
  const folded = entries.map((e) => e.id.toLowerCase())
  const duplicates = entries.filter((_, i) => folded.indexOf(folded[i]) !== i).map((e) => e.id)
  if (duplicates.length > 0) return refuse({ code: 'duplicate-id', ids: [...new Set(duplicates)] })
  const outside = entries.find((e) => !viewportInside(e.viewport))
  if (outside !== undefined) return refuse({ code: 'bad-viewport', id: outside.id })
  for (let i = 0; i < entries.length; i++) {
    for (let k = i + 1; k < entries.length; k++) {
      if (viewportsOverlap(entries[i].viewport, entries[k].viewport)) {
        return refuse({ code: 'overlap', ids: [entries[i].id, entries[k].id] })
      }
    }
  }
  const placed: PlacedWarpMesh[] = []
  for (const { id, viewport, text } of entries) {
    const parsed = parseWarpMesh(text)
    if (!parsed.ok) return refuse({ code: 'mesh', id, mesh: parsed.refusal })
    placed.push({ mesh: parsed.mesh, viewport })
  }
  return { ok: true, placed }
}
