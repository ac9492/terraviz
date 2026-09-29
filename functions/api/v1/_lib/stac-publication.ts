// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { buildStacCatalog, buildStacProduct, isPublicStacUrl, type StacProduct, type StacResolvers, type StacResolvedAsset } from './stac-builders'
import { type StacDatasetReadModel, type StacNodeContext } from './stac-read-model'
import { readStacPublicationInput } from './stac-publication-store'
import { verifyStacAssets } from './stac-assets'
import { computeEtag } from './snapshot'
import type { StacCatalog } from './stac-types'
import { historyModels, mergeHistoryCollections } from './stac-history'

export interface StacPublication {
  catalog: StacCatalog
  products: StacProduct[]
  publicationIssues: string[]
  report: { id: string; included: boolean; reasons: string[] }[]
}

export function stacBaseUrl(base: string): string {
  if (!isPublicStacUrl(base)) throw new Error('Invalid public node base URL')
  return `${base.replace(/\/$/, '')}/api/v1/stac`
}

export function stacResolvers(node: StacNodeContext, assets: Map<string, StacResolvedAsset>, dataset?: StacDatasetReadModel): StacResolvers {
  const base = stacBaseUrl(node.identity.base_url)
  return {
    resource: (kind, id) => kind === 'catalog' ? base
      : kind === 'manifest' ? `${node.identity.base_url.replace(/\/$/, '')}/api/v1/datasets/${encodeURIComponent(id)}/manifest`
        : `${base}/${kind === 'collection' ? 'collections' : 'items'}/${encodeURIComponent(id)}`,
    listing: (kind, collectionId) => collectionId ? `${base}/collections/${encodeURIComponent(collectionId)}/items` : `${base}/${kind}`,
    asset: (ref, purpose) => {
      const asset = assets.get(ref)
      if (!asset) return null
      if (purpose === 'data' && dataset) {
        const format = dataset.row.format.toLowerCase()
        if (!dataset.row.data_ref.startsWith('url:') && !dataset.row.data_ref.startsWith('r2:')) return null
        if (!(format.startsWith('image/') && asset.type.startsWith('image/'))
          && !(format.startsWith('video/') && (asset.type === 'video/mp4' || /mpegurl$/.test(asset.type)))) return null
      }
      return asset
    },
  }
}

export async function readStacPublication(env: CatalogEnv, options: { operatorReport?: boolean } = {}): Promise<StacPublication> {
  if (!env.CATALOG_DB) throw new Error('Missing catalog database')
  const model = await readStacPublicationInput(env.CATALOG_DB, options.operatorReport === true)
  if (!model.node) throw new Error('Missing node identity')
  const branding = model.branding
  if (branding) model.node.publicOrgName = branding.org_name
  const seed = JSON.stringify({ version: 5, operatorReport: options.operatorReport === true, model, r2: env.R2_PUBLIC_BASE ?? null, origins: env.STAC_ASSET_ORIGINS ?? null })
  const key = `stac:publication:v1:${(await computeEtag(seed)).replace(/"/g, '')}`
  if (env.CATALOG_KV && !options.operatorReport) {
    try {
      const cached = await env.CATALOG_KV.get(key, 'json') as StacPublication | null
      if (cached?.catalog && Array.isArray(cached.products) && Array.isArray(cached.report)) return cached
    } catch { /* Cache failures do not bypass fresh D1 eligibility reads. */ }
  }
  const products: StacProduct[] = []
  const report: StacPublication['report'] = []
  const datasets = model.datasets.flatMap(dataset => {
    const publications = model.history.filter(publication => publication.dataset_id === dataset.row.id)
    return publications.length ? publications.flatMap(publication => historyModels(publication, dataset.row)) : [dataset]
  })
  const { assets, issues, budgetExhausted } = await verifyStacAssets(env, { ...model, datasets })
  if (budgetExhausted && !options.operatorReport) throw new Error('STAC asset probe budget exceeded')
  const logo = branding?.logo_ref ? assets.get(branding.logo_ref) : undefined
  if (logo?.type.startsWith('image/')) {
    model.node.publicLogo = { href: logo.href, type: logo.type }
    assets.set(logo.href, { ...logo, sourceRef: logo.href })
  }
  const resolvers = stacResolvers(model.node, assets)
  for (const dataset of datasets) {
    const result = buildStacProduct(dataset, model.node, stacResolvers(model.node, assets, dataset))
    const detail = result.reasons.includes('data_asset_unresolved') ? issues.get(dataset.row.data_ref) : undefined
    const existing = report.find(entry => entry.id === dataset.row.id)
    const reasons = [...result.reasons, ...(detail ? [detail] : [])]
    if (existing) { existing.included ||= result.ok; existing.reasons = [...new Set([...existing.reasons, ...reasons])] }
    else report.push({ id: dataset.row.id, included: result.ok, reasons })
    if (result.ok) products.push(result.value)
  }
  mergeHistoryCollections(products)
  const roots = [...new Map(products.map(product => [product.collection?.id ?? product.item!.id, product])).values()]
  const catalog = buildStacCatalog(model.node, resolvers, roots)
  if (!catalog.ok) throw new Error(`Invalid STAC catalog: ${catalog.reasons.join(',')}`)
  const publication = { catalog: catalog.value, products, report,
    publicationIssues: budgetExhausted ? ['asset_probe_budget_exceeded'] : [] }
  if (env.CATALOG_KV && !options.operatorReport) {
    try { await env.CATALOG_KV.put(key, JSON.stringify(publication), { expirationTtl: 300 }) } catch { /* Best-effort cache. */ }
  }
  return publication
}