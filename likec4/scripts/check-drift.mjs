#!/usr/bin/env node
// Fails (exit 1) when the LikeC4 model and kubernetes-manifests/ disagree.
//   deployments  <->  microservice/database elements
//   *_ADDR env vars (host:port)  <->  relationships between those elements
//   metadata `port` == containerPort, metadata `source` path exists in the repo
// Elements/relationships tagged #optional are exempt (not in the base manifests).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllDocuments } from 'yaml'

const here = dirname(fileURLToPath(import.meta.url))
const manifestsDir = process.argv[3] ?? join(here, '../../kubernetes-manifests')
const modelFile = process.argv[2] ?? join(here, '../model.json')

// ---- actual: from Kubernetes manifests ----
const actualNodes = new Set()
const actualEdges = new Set()
const actualPorts = {}
const files = readdirSync(manifestsDir).filter(f => /\.ya?ml$/.test(f) && f !== 'kustomization.yaml')
for (const f of files) {
  for (const doc of parseAllDocuments(readFileSync(join(manifestsDir, f), 'utf8'))) {
    const d = doc.toJS()
    if (d?.kind !== 'Deployment') continue
    const name = d.metadata.name
    actualNodes.add(name)
    const containers = d.spec.template.spec.containers ?? []
    for (const c of containers) {
      const ports = (c.ports ?? []).map(p => String(p.containerPort))
      if (ports.length) actualPorts[name] = ports
      for (const env of c.env ?? []) {
        if (!/_ADDR$/.test(env.name) || !env.value) continue
        const target = env.value.split(':')[0]
        actualEdges.add(`${name} -> ${target}`)
      }
    }
  }
}
// drop edges whose target is not a Deployment here (e.g. optional components)
const externalTargets = [...actualEdges].filter(e => !actualNodes.has(e.split(' -> ')[1]))

// ---- model ----
let raw = JSON.parse(readFileSync(modelFile, 'utf8'))
const model = Array.isArray(raw) ? raw[0] : raw
const isOptional = x => (x.tags ?? []).includes('optional')
const nameOf = e => e.metadata?.deployment ?? e.id.split('.').pop()
// deployable = C4 containers/databases, plus anything explicitly mapped to a Deployment
const deployable = Object.values(model.elements).filter(
  e => ['microservice', 'database'].includes(e.kind) || e.metadata?.deployment,
)
const byId = Object.fromEntries(deployable.map(e => [e.id, e]))
// lift an element (e.g. an L3 component) to its nearest deployable ancestor-or-self
const lift = id => {
  for (let p = id; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') {
    if (byId[p]) return byId[p]
  }
}

const modelNodes = new Set(deployable.filter(e => !isOptional(e)).map(nameOf))
const modelEdges = new Set()
for (const r of Object.values(model.relations)) {
  const s = lift(r.source.model), t = lift(r.target.model)
  if (!s || !t || s === t || isOptional(r) || isOptional(s) || isOptional(t)) continue
  modelEdges.add(`${nameOf(s)} -> ${nameOf(t)}`)
}

// ---- attribute checks ----
const repoRoot = join(here, '../..')
const attrProblems = []
for (const e of deployable.filter(e => !isOptional(e))) {
  const n = nameOf(e)
  const port = e.metadata?.port
  if (port && actualPorts[n] && !actualPorts[n].includes(port))
    attrProblems.push(`"${n}": model says port ${port}, manifest containerPort is ${actualPorts[n].join('/')}`)
  const src = e.metadata?.source
  if (src && !existsSync(join(repoRoot, src)))
    attrProblems.push(`"${n}": source path "${src}" does not exist`)
}

// ---- diff ----
const diff = (a, b) => [...a].filter(x => !b.has(x)).sort()
const problems = [
  ...diff(actualNodes, modelNodes).map(x => `Deployment "${x}" is in kubernetes-manifests but missing from the model`),
  ...diff(modelNodes, actualNodes).map(x => `Model element "${x}" has no Deployment in kubernetes-manifests`),
  ...diff(new Set([...actualEdges].filter(e => !externalTargets.includes(e))), modelEdges)
    .map(x => `Dependency "${x}" (*_ADDR env var) is missing from the model`),
  ...diff(modelEdges, actualEdges).map(x => `Model relationship "${x}" has no matching *_ADDR env var`),
  ...attrProblems.map(x => `Attribute mismatch: ${x}`),
]

console.log(`manifests: ${actualNodes.size} deployments, ${actualEdges.size} dependencies`)
console.log(`model:     ${modelNodes.size} elements, ${modelEdges.size} relationships (optional excluded)`)
if (externalTargets.length) console.log(`skipped (target not in base manifests): ${externalTargets.join(', ')}`)
if (problems.length) {
  console.error(`\nArchitecture model has drifted from the code (${problems.length}):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('✓ model matches kubernetes-manifests')
