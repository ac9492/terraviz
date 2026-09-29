// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { until } from '../test-utils'
import type { OutputMonitor, OutputRecord, WarpAssignRefusal } from '../services/multiOutput/manager'
import { defaultRenderConfig } from '../services/multiOutput/protocol'
import type { WarpSource } from '../services/multiOutput/warpImport'
import type { WarpMesh } from '../output/projectorWarp'
import {
  buildWarpSection,
  describeWarpRefusal,
  rasterStretchPercent,
  type OutputWarpManager,
} from './outputWarpUI'

const MONITOR: OutputMonitor = {
  name: 'PROJECTORS',
  position: { x: 0, y: 0 },
  size: { width: 3840, height: 2160 },
  scaleFactor: 1,
}

function record(over: Partial<OutputRecord> = {}): OutputRecord {
  return {
    label: 'output-1',
    mode: 'projector-warp',
    view: { trackCamera: true, split: false, rotationOffsetDeg: 0 },
    render: defaultRenderConfig(),
    monitor: MONITOR,
    ready: true,
    lastHealthCheckAtMs: null,
    gpuLost: false,
    health: 'live',
    lastEvent: null,
    departing: false,
    announcedClosing: false,
    warpRef: null,
    ...over,
  }
}

function source(id: string, aspect = 16 / 9): WarpSource {
  return { id, sourceName: `${id}.data`, text: '2\n…', mesh: { cols: 41, rows: 41, aspect, nodes: [] } as WarpMesh }
}

function fakeManager() {
  const mgr = {
    readWarpFiles: vi.fn(async () => ({ ok: true as const, sources: [source('P1'), source('P3')] as readonly WarpSource[] })),
    importWarpSet: vi.fn(async () => ({ ok: true as const, id: '0123456789abcdef', meshes: 2 })),
    clearOutputWarp: vi.fn(async () => {}),
    setOutputRenderConfig: vi.fn(async () => {}),
  }
  return { mgr: mgr as unknown as OutputWarpManager, raw: mgr }
}

/** Pick files the way the browser does: `files` set, then `change`. */
function pick(section: HTMLElement, names: string[]): void {
  const input = section.querySelector<HTMLInputElement>('input[type="file"]')!
  const files = names.map((name) => new File(['2'], name))
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  input.dispatchEvent(new Event('change'))
}

let repaint: ReturnType<typeof vi.fn>
beforeEach(() => {
  // The app-wide announcer lives outside the panel in the real page, so
  // it survives the repaint that follows an import or a clear.
  document.body.innerHTML = '<div id="a11y-announcer" aria-live="polite" aria-atomic="true"></div>'
  repaint = vi.fn()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

/** Unmount what a test mounted, keeping the announcer. */
function resetBody(): void {
  for (const el of [...document.body.children]) if (el.id !== 'a11y-announcer') el.remove()
}

const announced = (): string => document.getElementById('a11y-announcer')!.textContent ?? ''

function mountSection(over: Partial<OutputRecord> = {}, mgr = fakeManager()) {
  const section = buildWarpSection(mgr.mgr, record(over), MONITOR, 'PROJECTORS', repaint as () => void)
  document.body.appendChild(section)
  return { section, ...mgr }
}

describe('rasterStretchPercent', () => {
  it('is silent when a mesh fits its quadrant, and says how far off when it does not', () => {
    const quadrant = { w: 0.5, h: 0.5 }
    expect(rasterStretchPercent(16 / 9, quadrant, { width: 3840, height: 2160 })).toBeNull()
    // The plan's example: 2048×1080 quadrants under a 16:9 mesh.
    expect(rasterStretchPercent(16 / 9, quadrant, { width: 4096, height: 2160 })).toBe(7)
    expect(rasterStretchPercent(4 / 3, quadrant, { width: 3840, height: 2160 })).toBe(33)
    expect(rasterStretchPercent(0, quadrant, { width: 3840, height: 2160 })).toBeNull()
  })
})

describe('describeWarpRefusal', () => {
  it('words every refusal, naming what the operator has to find', () => {
    const cases: [WarpAssignRefusal, string[]][] = [
      [{ code: 'nothing-picked' }, ['No file']],
      [{ code: 'too-large', bytes: 40 * 1024 * 1024 }, ['40 MB']],
      [{ code: 'mixed-selection' }, ['not both']],
      [{ code: 'unsupported-file', file: 'notes.txt' }, ['notes.txt']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'zip64', detail: '' } }, ['rig.zip', 'zip64']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'compressed', detail: '', entry: 'warp/P1.data' } }, ['rig.zip', '.data files']],
      [{ code: 'archive', file: 'rig.zip', zip: { code: 'checksum', detail: '', entry: 'warp/P1.data' } }, ['warp/P1.data', 'checksum']],
      [{ code: 'no-meshes', file: 'rig.zip' }, ['rig.zip', 'warp/<id>.data']],
      [{ code: 'too-many', count: 65 }, ['65']],
      [{ code: 'bad-name', file: '.data' }, ['.data']],
      [{ code: 'duplicate-id', ids: ['P1', 'p1'] }, ['P1, p1']],
      [{ code: 'not-text', file: 'P1.data' }, ['P1.data']],
      [{ code: 'mesh', file: 'P2.data', mesh: { code: 'bad-node', line: 1204, detail: '' } }, ['P2.data', 'bad-node', '1204']],
      [{ code: 'mesh', file: 'P2.data', mesh: { code: 'bad-extent', detail: '' } }, ['P2.data', 'bad-extent']],
      [{ code: 'layout', reason: 'unplaceable', ids: ['P5'] }, ['P5']],
      [{ code: 'layout', reason: 'duplicate', ids: ['P1'] }, ['P1', 'one quadrant']],
      [{ code: 'set', set: { code: 'overlap', ids: ['P1', 'P2'] } }, ['overlap']],
      [{ code: 'no-output' }, ['no longer open']],
      [{ code: 'not-a-warp-output' }, ['projector-warp']],
      [{ code: 'storage', reason: 'no-room' }, ['no room']],
      [{ code: 'storage', reason: 'unavailable' }, ['between launches']],
    ]
    for (const [refusal, fragments] of cases) {
      const text = describeWarpRefusal(refusal)
      for (const fragment of fragments) expect(text, refusal.code).toContain(fragment)
    }
  })
})

describe('buildWarpSection', () => {
  it('says what the output is drawing — or why nothing', () => {
    expect(mountSection().section.querySelector('.output-warp-status')!.textContent).toContain('No warp set')
    resetBody()
    // A reference with nothing loaded is a stored set that could not be read.
    expect(mountSection({ warpRef: 'feedfacecafebeef' }).section.querySelector('.output-warp-status')!.textContent).toContain(
      'could not be read',
    )
    resetBody()
    const warp = {
      id: '0123456789abcdef',
      meshes: [
        { id: 'P1', viewport: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: '' },
        { id: 'P2', viewport: { x: 0.5, y: 0, w: 0.5, h: 0.5 }, text: '' },
      ],
    }
    const loaded = mountSection({ warpRef: warp.id, render: { ...defaultRenderConfig(), warp } }).section
    expect(loaded.querySelector('.output-warp-status')!.textContent).toBe('Drawing 2 meshes: P1, P2.')
  })

  it('asks before placing a bundle in SOS\'s quadrants, and imports only on the answer', async () => {
    const { section, raw } = mountSection()
    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(section.textContent).toContain('Read 2 meshes: P1, P3.')
    const cells = [...section.querySelectorAll('.output-warp-quadrant')]
    expect(cells.map((c) => c.textContent)).toEqual(['P3', 'P4', 'P1', 'P2'])
    expect(cells.filter((c) => c.classList.contains('is-filled')).map((c) => c.textContent)).toEqual(['P3', 'P1'])
    expect(section.querySelector('.output-warp-quadrants')!.getAttribute('aria-hidden')).toBe('true')
    expect(raw.importWarpSet).not.toHaveBeenCalled()

    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => repaint.mock.calls.length > 0, 'the repaint')
    expect(raw.importWarpSet).toHaveBeenCalledWith('output-1', expect.any(Array), 'sos-quadrants')
  })

  it('puts what arrives after a read in a polite live region that was there first', async () => {
    const { section } = mountSection()
    const region = section.querySelector('.output-warp-pending')!
    // Registered empty, before anything changes it — a region born with
    // its content is never announced.
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.childElementCount).toBe(0)

    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(region.contains(section.querySelector('.output-warp-choose'))).toBe(true)
    expect(region.textContent).toContain('Place them in Science On a Sphere')
  })

  it('announces an import and a clear, which repaint the region away', async () => {
    const { section } = mountSection()
    pick(section, ['sphere-sim-files.zip'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')
    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => announced() !== '', 'the import announcement')
    expect(announced()).toBe('Drawing 2 meshes: P1, P3.')

    resetBody()
    document.getElementById('a11y-announcer')!.textContent = ''
    const cleared = mountSection({ warpRef: 'feedfacecafebeef' }).section
    cleared.querySelector<HTMLButtonElement>('.output-warp-clear')!.click()
    await until(() => announced() !== '', 'the clear announcement')
    expect(announced()).toContain('No warp set')
  })

  it('imports nothing when the operator declines', async () => {
    const { section, raw } = mountSection()
    pick(section, ['P1.data', 'P3.data'])
    await until(() => section.querySelector('.output-warp-cancel') !== null, 'the layout question')

    section.querySelector<HTMLButtonElement>('.output-warp-cancel')!.click()

    expect(section.querySelector('.output-warp-choose')).toBeNull()
    expect(raw.importWarpSet).not.toHaveBeenCalled()
  })

  it('warns, before the choice, when a mesh is not the shape of its quadrant', async () => {
    const mgr = fakeManager()
    mgr.raw.readWarpFiles.mockResolvedValue({ ok: true, sources: [source('P1', 4 / 3)] })
    const { section } = mountSection({}, mgr)
    pick(section, ['P1.data'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')

    expect(section.querySelector('.output-warp-pending .output-warning')!.textContent).toContain('stretched by 33%')
  })

  it('shows a refusal from reading, and one from importing, without repainting', async () => {
    const mgr = fakeManager()
    mgr.raw.readWarpFiles.mockResolvedValueOnce({ ok: false, refusal: { code: 'no-meshes', file: 'rig.zip' } } as never)
    const { section } = mountSection({}, mgr)
    pick(section, ['rig.zip'])
    await until(() => section.querySelector('.output-error') !== null, 'the read refusal')
    expect(section.querySelector('.output-error')!.textContent).toContain('rig.zip holds no warp meshes')

    mgr.raw.importWarpSet.mockResolvedValueOnce({ ok: false, refusal: { code: 'storage', reason: 'no-room' } } as never)
    pick(section, ['P1.data'])
    await until(() => section.querySelector('.output-warp-choose') !== null, 'the layout question')
    section.querySelector<HTMLButtonElement>('.output-warp-choose')!.click()
    await until(() => section.querySelector('.output-error')?.textContent?.includes('no room') ?? false, 'the import refusal')
    expect(repaint).not.toHaveBeenCalled()
  })

  it('clears the warp, and only offers to when there is one', async () => {
    expect(mountSection().section.querySelector<HTMLButtonElement>('.output-warp-clear')!.disabled).toBe(true)
    resetBody()
    const { section, raw } = mountSection({ warpRef: 'feedfacecafebeef' })
    const clear = section.querySelector<HTMLButtonElement>('.output-warp-clear')!
    expect(clear.disabled).toBe(false)

    clear.click()

    await until(() => repaint.mock.calls.length > 0, 'the repaint')
    expect(raw.clearOutputWarp).toHaveBeenCalledWith('output-1')
  })

  it('commits a blend gamma that is one, and puts back one that is not', async () => {
    const { section, raw } = mountSection()
    const gamma = section.querySelector<HTMLInputElement>('.output-warp-gamma')!
    expect(gamma.value).toBe('2.2')

    for (const bad of ['', '0', '-1', '11']) {
      gamma.value = bad
      gamma.dispatchEvent(new Event('change'))
      expect(gamma.value, bad).toBe('2.2')
    }
    expect(raw.setOutputRenderConfig).not.toHaveBeenCalled()

    gamma.value = '2.4'
    gamma.dispatchEvent(new Event('change'))
    await until(() => raw.setOutputRenderConfig.mock.calls.length === 1, 'the commit')
    expect(raw.setOutputRenderConfig).toHaveBeenCalledWith('output-1', { blendGamma: 2.4 })
  })
})
