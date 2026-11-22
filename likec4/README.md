# LikeC4 architecture model (CI-enforced)

POC: the architecture model is checked against the real project on every PR.

| Source of truth (`kubernetes-manifests/`) | Model |
|---|---|
| `Deployment` | `container` / `database` element (id or `metadata.deployment`) |
| `*_ADDR` env var (`host:port`) | relationship between elements |

Model follows the C4 levels: L1 system context (`index`), L2 containers, L3 checkout components.

`npm run check:drift` exports the model to JSON and diffs it against the manifests;
CI (`.github/workflows/likec4-model-ci.yaml`) fails on any difference, so changing a
service's dependencies requires updating the model in the same PR.
Tag an element/relationship `#optional` to exempt it (e.g. kustomize-only components).

    npm ci && npm run dev          # live preview
    npm run validate               # syntax
    npm run check:drift            # model vs. code
    npm run build                  # static site -> dist/
