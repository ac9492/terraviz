// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The Outputs panel's warp controls for one `projector-warp` output
 * (`docs/MULTI_MONITOR_PLAN.md` §"Rung 16") — what it is drawing, the
 * import of a sphere-sim bundle, the layout question, the blend gamma,
 * and a way to clear it.
 *
 * Its own module because `outputUI` is long enough already and this is
 * one self-contained flow with its own wrong answers, the same reason
 * the monitor diagram's arithmetic is exported rather than inline.
 *
 * **The layout is asked, never assumed.** A bundle does not yet say
 * where its meshes go (zyra-project/sphere-sim#49), and a placed rig's
 * `P1`…`P4` are not SOS's quadrants, so after a bundle is read the panel
 * shows what arrived, draws SOS's quadrants with each mesh in the place
 * it would take, and waits for the operator to choose them — or not.
 * Declining imports nothing; there is no silent default.
 *
 * **The raster's shape is checked, not enforced.** A mesh's `x` span
 * states the aspect it was solved for, and a quadrant of this display
 * has one of its own. A mismatch stretches the picture, but the
 * operator may know the lens compensates, so it is a warning shown
 * before the choice rather than a refusal.
 *
 * **Every refusal is worded.** The import is fail-closed from end to
 * end, so each code the manager can return has a sentence here — the
 * category translated, the specific code carried raw beside it, since
 * that is what an operator with the file open in an editor can act on.
 *
 * Every `multiOutput/` import is **type-only**, for `outputUI`'s reason:
 * the panel is loaded eagerly by `main.ts`, and a runtime import would
 * pull the contract into the web entry chunk.
 */

import { plural, t } from '../i18n'
import type { OutputMonitor, OutputRecord, WarpAssignRefusal, WarpAssignment, WarpFileLike } from '../services/multiOutput/manager'
import type { OutputRenderConfig } from '../services/multiOutput/protocol'
import type { WarpLayoutSource, WarpSource, WarpSourcesResult } from '../services/multiOutput/warpImport'
import { logger } from '../utils/logger'

/** The slice of the manager the warp controls call. */
export interface OutputWarpManager {
  readWarpFiles(files: readonly WarpFileLike[]): Promise<WarpSourcesResult>
  importWarpSet(label: string, sources: readonly WarpSource[], layout: WarpLayoutSource): Promise<WarpAssignment>
  clearOutputWarp(label: string): Promise<void>
  setOutputRenderConfig(label: string, render: Partial<Omit<OutputRenderConfig, 'warp'>>): Promise<void>
}

/**
 * SOS's quadrants, restated for the diagram — P1 bottom-left, P2
 * bottom-right, P3 top-left, P4 top-right, as sphere-sim and SOS's own
 * `projectorInfo` have them. Restated rather than imported for the
 * type-only rule above; the viewports themselves are applied by the
 * manager from the one table in `projectorWarp`, never from this.
 */
const QUADRANT_ROWS: readonly (readonly string[])[] = [
  ['P3', 'P4'],
  ['P1', 'P2'],
]

/** The quadrant a mesh takes: half the display each way. */
const QUADRANT = { w: 0.5, h: 0.5 }

/**
 * How far a mesh's picture is stretched in its viewport, as a percentage,
 * or `null` when the two agree to within 1%.
 *
 * The mesh states the aspect it was solved for (`x` spans ±aspect); the
 * viewport's is its share of the display's own pixels. A 16:9 mesh in a
 * 2048×1080 quadrant is 7% too wide for it.
 */
export function rasterStretchPercent(
  meshAspect: number,
  viewport: { w: number; h: number },
  display: { width: number; height: number },
): number | null {
  const viewportAspect = (viewport.w * display.width) / (viewport.h * display.height)
  if (!(meshAspect > 0) || !(viewportAspect > 0)) return null
  const stretch = Math.abs(viewportAspect / meshAspect - 1) * 100
  return stretch < 1 ? null : Math.round(stretch)
}

/** A refusal from any step of the import, as the sentence the panel shows. */
export function describeWarpRefusal(refusal: WarpAssignRefusal): string {
  switch (refusal.code) {
    case 'nothing-picked':
      return t('outputs.warp.refusal.nothingPicked')
    case 'too-large':
      return t('outputs.warp.refusal.tooLarge', { megabytes: Math.ceil(refusal.bytes / (1024 * 1024)) })
    case 'mixed-selection':
      return t('outputs.warp.refusal.mixedSelection')
    case 'unsupported-file':
      return t('outputs.warp.refusal.unsupportedFile', { file: refusal.file })
    case 'archive':
      // The two an operator can act on differently get sentences of their
      // own; the rest say which structural problem it was.
      if (refusal.zip.code === 'compressed') return t('outputs.warp.refusal.archiveCompressed', { file: refusal.file })
      if (refusal.zip.code === 'checksum') {
        return t('outputs.warp.refusal.archiveChecksum', { file: refusal.file, entry: refusal.zip.entry ?? refusal.file })
      }
      return t('outputs.warp.refusal.archive', { file: refusal.file, reason: refusal.zip.code })
    case 'no-meshes':
      return t('outputs.warp.refusal.noMeshes', { file: refusal.file })
    case 'too-many':
      return t('outputs.warp.refusal.tooMany', { count: refusal.count })
    case 'bad-name':
      return t('outputs.warp.refusal.badName', { file: refusal.file })
    case 'duplicate-id':
      return t('outputs.warp.refusal.duplicateId', { ids: refusal.ids.join(', ') })
    case 'not-text':
      return t('outputs.warp.refusal.notText', { file: refusal.file })
    case 'mesh':
      return refusal.mesh.line === undefined
        ? t('outputs.warp.refusal.mesh', { file: refusal.file, reason: refusal.mesh.code })
        : t('outputs.warp.refusal.meshAtLine', { file: refusal.file, reason: refusal.mesh.code, line: refusal.mesh.line })
    case 'layout':
      return refusal.reason === 'duplicate'
        ? t('outputs.warp.refusal.layoutDuplicate', { ids: refusal.ids.join(', ') })
        : t('outputs.warp.refusal.layoutUnplaceable', { ids: refusal.ids.join(', ') })
    case 'set':
      return t('outputs.warp.refusal.set', { reason: refusal.set.code })
    case 'no-output':
      return t('outputs.warp.refusal.noOutput')
    case 'not-a-warp-output':
      return t('outputs.warp.refusal.notAWarpOutput')
    case 'storage':
      return refusal.reason === 'no-room' ? t('outputs.warp.refusal.noRoom') : t('outputs.warp.refusal.unavailable')
    default: {
      // A code added to the manager's refusals has to be worded here
      // before it compiles, rather than reaching the operator as nothing.
      const unreachable: never = refusal
      return unreachable
    }
  }
}

function paragraph(text: string, className: string): HTMLElement {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

function button(text: string, className: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = className
  el.textContent = text
  return el
}

/** What the output is drawing, in one line — the panel's half of "says why". */
function statusLine(record: OutputRecord): HTMLElement {
  const warp = record.render.warp
  if (warp) {
    const ids = warp.meshes.map(m => m.id).join(', ')
    return paragraph(
      plural(warp.meshes.length, { one: 'outputs.warp.loaded.one', other: 'outputs.warp.loaded.other' }, { ids }),
      'output-warp-status',
    )
  }
  // A reference with nothing loaded is a stored set that could not be
  // read — a different message from "nothing imported", because the
  // action is different: import the same bundle again.
  return paragraph(
    record.warpRef !== null ? t('outputs.warp.unreadable') : t('outputs.warp.none'),
    'output-warp-status output-warning',
  )
}

/**
 * SOS's quadrants with each arrived mesh in the one it would take.
 * Presentational and `aria-hidden`: the key sentence beside it carries
 * the same mapping as text, and a grid of four unlabelled boxes is noise
 * to a screen reader. A picture of the physical display, so it never
 * mirrors under `dir="rtl"` — see `.output-warp-quadrants`.
 */
function quadrantDiagram(ids: readonly string[]): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'output-warp-quadrants'
  grid.setAttribute('aria-hidden', 'true')
  for (const row of QUADRANT_ROWS) {
    for (const quadrant of row) {
      const cell = document.createElement('div')
      cell.className = ids.includes(quadrant) ? 'output-warp-quadrant is-filled' : 'output-warp-quadrant'
      cell.textContent = quadrant
      grid.appendChild(cell)
    }
  }
  return grid
}

/**
 * The warp controls for one `projector-warp` output. `repaint` redraws
 * the panel after an import or a clear, since both change the status
 * line and the row's other controls read the same record.
 */
export function buildWarpSection(
  mgr: OutputWarpManager,
  record: OutputRecord,
  monitor: OutputMonitor,
  displayName: string,
  repaint: () => void,
): HTMLElement {
  const section = document.createElement('div')
  section.className = 'output-warp'

  const title = document.createElement('p')
  title.className = 'output-field-label'
  title.textContent = t('outputs.warp.title')
  section.append(title, statusLine(record))

  const actions = document.createElement('div')
  actions.className = 'output-warp-actions'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,.data'
  input.multiple = true
  input.hidden = true
  const importBtn = button(t('outputs.warp.import'), 'output-warp-import')
  importBtn.setAttribute('aria-label', t('outputs.warp.importAria', { monitor: displayName }))
  const clearBtn = button(t('outputs.warp.clear'), 'output-warp-clear')
  clearBtn.setAttribute('aria-label', t('outputs.warp.clearAria', { monitor: displayName }))
  clearBtn.disabled = record.warpRef === null && record.render.warp === null
  actions.append(importBtn, clearBtn, input)
  section.appendChild(actions)

  /** Where a refusal or the layout question goes — replaced, never stacked. */
  const pending = document.createElement('div')
  pending.className = 'output-warp-pending'
  section.appendChild(pending)
  const show = (...children: HTMLElement[]): void => pending.replaceChildren(...children)

  importBtn.addEventListener('click', () => input.click())
  input.addEventListener('change', () => {
    const files = input.files ? [...input.files] : []
    // Cleared at once so choosing the same file again still fires `change`.
    input.value = ''
    if (files.length === 0) return
    importBtn.disabled = true
    const restore = importBtn.textContent
    importBtn.textContent = t('outputs.warp.reading')
    void mgr
      .readWarpFiles(files)
      .then(read => {
        if (!read.ok) show(paragraph(describeWarpRefusal(read.refusal), 'output-error'))
        else show(...askLayout(read.sources))
      })
      .catch(err => {
        // A file that went away between the pick and the read, or one the
        // platform would not hand over — not a refusal, so not worded as one.
        logger.warn('[outputUI] reading a warp bundle failed:', err)
        show(paragraph(t('outputs.warp.readFailed'), 'output-error'))
      })
      .finally(() => {
        importBtn.textContent = restore
        importBtn.disabled = false
      })
  })

  /** What arrived, where SOS's quadrants would put it, and the question. */
  const askLayout = (sources: readonly WarpSource[]): HTMLElement[] => {
    const ids = sources.map(s => s.id)
    const parts: HTMLElement[] = [
      paragraph(
        plural(sources.length, { one: 'outputs.warp.arrived.one', other: 'outputs.warp.arrived.other' }, { ids: ids.join(', ') }),
        'output-note',
      ),
      paragraph(t('outputs.warp.askQuadrants'), 'output-note'),
      quadrantDiagram(ids),
      paragraph(t('outputs.warp.quadrantsKey'), 'output-note'),
    ]
    for (const source of sources) {
      const stretch = rasterStretchPercent(source.mesh.aspect, QUADRANT, monitor.size)
      if (stretch === null) continue
      parts.push(
        paragraph(
          t('outputs.warp.aspectMismatch', {
            id: source.id,
            mesh: source.mesh.aspect.toFixed(3),
            viewport: ((QUADRANT.w * monitor.size.width) / (QUADRANT.h * monitor.size.height)).toFixed(3),
            percent: stretch,
          }),
          'output-warning',
        ),
      )
    }
    const choose = button(t('outputs.warp.useQuadrants'), 'output-warp-choose')
    const cancel = button(t('outputs.warp.cancel'), 'output-warp-cancel')
    cancel.addEventListener('click', () => show())
    choose.addEventListener('click', () => {
      choose.disabled = true
      cancel.disabled = true
      void mgr
        .importWarpSet(record.label, sources, 'sos-quadrants')
        .then(result => {
          if (result.ok) repaint()
          else show(paragraph(describeWarpRefusal(result.refusal), 'output-error'))
        })
        .catch(err => {
          logger.warn('[outputUI] importing a warp set failed:', err)
          choose.disabled = false
          cancel.disabled = false
        })
    })
    const row = document.createElement('div')
    row.className = 'output-warp-actions'
    row.append(choose, cancel)
    parts.push(row)
    return parts
  }

  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true
    void mgr
      .clearOutputWarp(record.label)
      .then(repaint)
      .catch(err => {
        logger.warn('[outputUI] clearing a warp failed:', err)
        clearBtn.disabled = false
      })
  })

  section.appendChild(buildBlendGamma(mgr, record))
  return section
}

/**
 * The blend gamma (convention 2): the display gamma the projectors' blend
 * weights are applied through, 2.2 unless a calibration says otherwise.
 * Committed on `change` — a typed "2.4" must not pass through "2" on the
 * way — and put back if the value is not one the output would use.
 */
function buildBlendGamma(mgr: OutputWarpManager, record: OutputRecord): HTMLElement {
  const field = document.createElement('label')
  field.className = 'output-field'
  const text = document.createElement('span')
  text.className = 'output-field-label'
  text.textContent = t('outputs.warp.blendGamma')
  const number = document.createElement('input')
  number.type = 'number'
  number.className = 'output-field-number output-warp-gamma'
  number.min = '0.5'
  number.max = '4'
  number.step = '0.05'
  let applied = record.render.blendGamma
  number.value = String(applied)
  number.title = t('outputs.warp.blendGammaHint')
  number.addEventListener('change', () => {
    const raw = number.value.trim()
    const next = Number(raw)
    // `Number('')` is 0, not NaN — the empty check is the one that
    // keeps a field cleared for retyping from committing a gamma of 0.
    if (raw === '' || !Number.isFinite(next) || next <= 0 || next > 10) {
      number.value = String(applied)
      return
    }
    number.disabled = true
    void mgr
      .setOutputRenderConfig(record.label, { blendGamma: next })
      .then(() => {
        applied = next
      })
      .catch(err => {
        logger.warn('[outputUI] blend gamma change failed:', err)
        number.value = String(applied)
      })
      .finally(() => {
        number.disabled = false
      })
  })
  field.append(text, number)
  return field
}
