# Mako Workflows: infrastructure for Mako's cloud

How to use and set up workflows: `docs/src/content/docs/workflows.md`.

This folder holds what Mako's own cloud adds: a Hatchet we operate, and one
sandboxed worker pod per workspace (the `gke` worker provider). It reuses the
notebook-kernels GKE cluster and its gVisor node pool. A self-hosted
installation needs none of it.

| Path                  | What                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision.sh`        | One-time, idempotent setup per project: the Cloud SQL database, Hatchet (Helm), its internal load balancer, the `mako-workflows` namespace                                            |
| `hatchet-values.yaml` | Helm values for `hatchet/hatchet-stack` 0.19.0: Cloud SQL Postgres, Postgres queue, nothing exposed                                                                                   |
| `k8s/`                | Namespace, quota and network policy for worker pods                                                                                                                                   |
| `runtime/`            | The worker image: follow the commit Mako names, typecheck it, run a Hatchet worker. `runtime/defaults/` are the shared files (`hatchet.ts`, `lib/mako.ts`) it supplies to every repo. |

## Environments

Each environment has its own Hatchet and its own database.

| Environment          | GCP project    | Hatchet database                                |
| -------------------- | -------------- | ----------------------------------------------- |
| Production           | `mako-ai-prod` | Cloud SQL `mako-hatchet` in `mako-ai-prod`      |
| PR previews (shared) | `mako-ai-dev`  | Cloud SQL `mako-hatchet` in `mako-ai-dev`       |
| Local                | —              | Postgres in `docker-compose.yml` (Hatchet Lite) |

Previews share one Hatchet. Each PR prefixes its tenants and worker
Deployments with `pr-<n>-` (`WORKFLOWS_NAME_PREFIX`). When the PR closes,
`cleanup-preview.yml` deletes its Deployments and Secrets; the idle Hatchet
tenants stay.

**Do not put Hatchet's database on Neon.** Hatchet's outbox migrations choose
their schema with the `search_path` connection parameter. Neon drops it, also
on the direct endpoint, so the tables are created in `public`, the engine logs
`relation "outbox.messages" does not exist`, and runs stay `QUEUED`.

## Per-workspace objects (created by the Mako API, not by hand)

- a Hatchet tenant and API token, saved on the workspace
- Secret `wf-<prefix><workspaceId>`: the worker's Mako API key
- Deployment `wf-<prefix><workspaceId>`: one replica of the runtime image.
  Created once, replaced only for a new image.

## Sandboxes: a public address for the engine

A person's sandbox runs their workflows as a Hatchet worker of its own
(`runtime/dev.mjs`, started by `api/src/workflows/sandbox.ts`), so a box
must reach the engine's gRPC port. Nothing in the cluster is public, so a
Cloudflare tunnel publishes two hostnames and nothing else
(`k8s/cloudflared.yaml`):

| Hostname                     | Service               | For                         |
| ---------------------------- | --------------------- | --------------------------- |
| `hatchet-<env>.mako.ai`      | `caddy:8080`          | the API, the dashboard      |
| `hatchet-grpc-<env>.mako.ai` | `hatchet-engine:7070` | workers outside the cluster |

Once per cluster, with a cloudflared login for the `mako.ai` zone:

```bash
cloudflared tunnel create hatchet-<env>
cloudflared tunnel route dns hatchet-<env> hatchet-<env>.mako.ai
cloudflared tunnel route dns hatchet-<env> hatchet-grpc-<env>.mako.ai
# ingress: hatchet-<env> → http://caddy.hatchet.svc.cluster.local:8080,
#          hatchet-grpc-<env> → http://hatchet-engine.hatchet.svc.cluster.local:7070 (http2Origin)
kubectl -n hatchet create secret generic cloudflared --from-literal=token=$(cloudflared tunnel token hatchet-<env>)
kubectl apply -f k8s/cloudflared.yaml
```

Then the Helm values: `serverUrl: https://hatchet-<env>.mako.ai`,
`grpcBroadcastAddress: hatchet-grpc-<env>.mako.ai:443`. Tokens Hatchet
mints from then on name the public addresses; TLS ends at Cloudflare and
the engine stays plaintext inside. The shared worker keeps the private
service through `HATCHET_WORKER_HOST_PORT`, and the Mako API keeps the
internal load balancer. Hatchet's own auth (tenant tokens, the admin
password) is the wall, as on Hatchet Cloud.

Local development: Hatchet Lite's gRPC port is on `localhost:7077`, which
the `local` sandbox provider reaches directly with
`HATCHET_SANDBOX_TLS_STRATEGY=none`; an E2B box from a laptop would need the
named tunnel to carry it.

## PR previews

A preview runs several API instances with ephemeral disks and never pushes
to the workspace's mirror, so a commit exists only on the instance that took
the push. The worker's source fetch for it answers `That commit is not on
this instance` from the others and is retried on every poll, so a deploy on
a PR preview may not land. Production pushes to the mirror, which every
instance can fetch from.
