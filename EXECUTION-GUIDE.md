# Execution Guide: run everything locally on minikube (free)

This guide does the whole assignment on your own computer with **minikube**. No cloud account and no cost.
Follow it top to bottom. Every step tells you **what to run**, **what it does**, and **what you should see**
(✅ = checkpoint). Don't continue until the checkpoint passes.

Where a command differs between **macOS / Linux** and **Windows (PowerShell)**, both versions are shown. Everything
else is identical on all three.

---

## Step 0: What you're building

One Pulumi program creates all of this inside a local Kubernetes cluster:

| Namespace | What gets created | Why |
|---|---|---|
| `guestbook` | Redis leader, Redis replica, 3 frontend pods (the original Pulumi Guestbook app) | The application being monitored |
| `guestbook` | One **exporter sidecar** in every pod (apache-exporter / redis-exporter) | The app has no metrics endpoint; exporters turn Apache/Redis stats into Prometheus metrics |
| `guestbook` | 2 **ServiceMonitors** (`guestbook-frontend`, `guestbook-backend`) | They tell Prometheus what to scrape |
| `monitoring` | **kube-prometheus-stack** Helm chart (Prometheus + Grafana + helpers) | Collects and displays the metrics |
| `monitoring` | ConfigMap `guestbook-dashboard` | Grafana loads it automatically as the "Guestbook Application" dashboard |

**Why you'll use `port-forward`:** minikube has no cloud load balancer, so Grafana is a `NodePort` service. You reach it
(and the Guestbook) with `kubectl port-forward`, which connects a port on your computer (for example `localhost:3000`) to
the service inside the cluster. Pulumi prints the exact commands for you.

**You'll use 5 terminal windows by the end.** Open them as the guide asks:

| Terminal | Used for |
|---|---|
| T1 | All the main commands (install, deploy, checks) |
| T2 | Grafana port-forward: stays running |
| T3 | Guestbook port-forward: stays running |
| T4 | Prometheus port-forward: stays running |
| T5 | Traffic generator: stays running |

---

## Step 1: Install the tools (one time, ~15 min)

You need: **Docker Desktop** (minikube runs inside it), **minikube**, **kubectl**, **Node.js LTS**, **Pulumi CLI** and **Git**.

### macOS (Homebrew, https://brew.sh)
```bash
brew install --cask docker
brew install minikube kubectl pulumi/tap/pulumi git node@22
brew link --overwrite --force node@22
```

### Windows (PowerShell)
```powershell
winget install -e --id Docker.DockerDesktop
winget install -e --id Kubernetes.minikube
winget install -e --id Kubernetes.kubectl
winget install -e --id Pulumi.Pulumi
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
```
Docker Desktop may ask you to enable WSL2 and restart. Say yes.

### Linux (Ubuntu)
```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and back in
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64 && sudo install minikube-linux-amd64 /usr/local/bin/minikube
sudo snap install kubectl --classic
curl -fsSL https://get.pulumi.com | sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs git
```
⚠️ Don't install Node with a plain `apt install nodejs`. Ubuntu's version (Node 12) is too old, and `pulumi preview`
fails with `SyntaxError: Unexpected token '.'`. If you already did that, run `sudo apt-get remove -y nodejs libnode-dev libnode72`,
then the NodeSource line above, then delete `node_modules` and run `npm install` again.
If you work as `root` (common in WSL), add `--force` to the `minikube start` command in Step 2.

### Then (all systems)
1. **Start Docker Desktop** (macOS/Windows) and wait until it says *running*.
2. In Docker Desktop, go to **Settings → Resources** and give it **at least 4 CPUs and 8 GB memory**, if your laptop allows.
   (On Windows with the WSL2 backend there's no slider; it uses up to half your RAM, which is fine.)
3. **Close the terminal and open a new one**, so the newly installed tools are found.

✅ **Checkpoint:** each of these prints a version and no "command not found":
```bash
docker version
minikube version
kubectl version --client
node --version        # v22.x (v20 also fine)
npm --version
pulumi version        # v3.x
git --version
```

---

## Step 2: Start the minikube cluster (~3–5 min) [T1]

```bash
minikube start --driver=docker --cpus=4 --memory=6144
```
**What it does:** creates a single-node Kubernetes cluster inside Docker and points `kubectl` at it (context name: `minikube`).
The monitoring stack needs real resources, which is why it gets 4 CPUs and 6 GB.

> If you get an error saying Docker doesn't have enough memory or CPUs, use
> `minikube start --driver=docker --cpus=2 --memory=4096`. It's slower but works.

✅ **Checkpoint:**
```bash
kubectl config current-context   # minikube
kubectl get nodes                # minikube   Ready
```
⚠️ Pulumi deploys to whatever cluster `kubectl` points at, so this **must** say `minikube`.

---

## Step 3: Get the code (~2 min) [T1]

```bash
git clone https://github.com/SuyashKadam/pulumi-guestbook-monitoring.git
cd pulumi-guestbook-monitoring
npm install
```
**What it does:** downloads the project, enters its folder, and installs the Pulumi libraries
(`@pulumi/pulumi`, `@pulumi/kubernetes`, `@pulumi/random`) into `node_modules/`.

✅ **Checkpoint:** `npm install` finishes without `ERR!`. Then `npx tsc --noEmit` prints **nothing**, which means
the code compiles.

**What's in the folder (for understanding):**
- `index.ts`: creates the 2 namespaces, calls the two files below, and defines the outputs (URLs, credentials).
- `guestbook.ts`: the Guestbook app, the exporter sidecars and the internal metrics Services.
- `monitoring.ts`: installs Prometheus + Grafana (Helm chart), the ServiceMonitors and the dashboard.
- `dashboards/guestbook.json`: the Grafana dashboard.
- `Pulumi.yaml`: project settings. `isMinikube` defaults to `true`, so **you don't need to configure anything for minikube.**

---

## Step 4: Set up Pulumi (~2 min) [T1]

**macOS / Linux:**
```bash
pulumi login --local
export PULUMI_CONFIG_PASSPHRASE="guestbook123"
pulumi stack init dev
```
**Windows (PowerShell):**
```powershell
pulumi login --local
$env:PULUMI_CONFIG_PASSPHRASE="guestbook123"
pulumi stack init dev
```
**What it does:**
- `pulumi login --local` saves Pulumi's state on your computer (`~/.pulumi`). The state is Pulumi's record of what it created. No Pulumi account is needed.
- `PULUMI_CONFIG_PASSPHRASE` is the key that encrypts secrets in that state, such as the Grafana password. Use any value,
  but **use the same one every time**. If you open a new terminal for a `pulumi` command, set it again there.
- `pulumi stack init dev` creates a *stack* named `dev`, which is one deployed copy of this project.

✅ **Checkpoint:** `pulumi stack ls` shows `dev*`.

---

## Step 5: Preview and deploy (~5–10 min) [T1]

```bash
pulumi preview
```
**What it does:** a dry run that shows what *would* be created, without changing anything. The first time, Pulumi also downloads
its Kubernetes and Random plugins, which takes about a minute. You should see roughly these resources marked `+ create`:

```
Namespace          guestbook, monitoring
RandomPassword     grafana-admin-password
Release            kube-prometheus-stack          (Prometheus + Grafana Helm chart)
Deployment         redis-leader, redis-replica, frontend
Service            redis-leader, redis-replica, frontend, frontend-metrics
ConfigMap          frontend-apache-status, guestbook-dashboard
ServiceMonitor     guestbook-frontend, guestbook-backend
```
(Also one `read` of the Grafana service. That's normal; Pulumi looks it up after Helm creates it.)

Now deploy:
```bash
pulumi up
```
Use the arrow keys to pick **yes** and press Enter.

**What happens while it runs:**
1. The namespaces and the random Grafana password are created.
2. The Guestbook pods start; images download from Docker Hub and quay.io.
3. The Helm chart installs Prometheus, Grafana and the operator, and Pulumi **waits until every pod is ready**.
   This is the slow part (3–8 minutes on the first run, because images are being downloaded).
4. The ServiceMonitors and the dashboard are created. They wait for the chart, because the chart installs the `ServiceMonitor` type.

✅ **Checkpoint:** it ends with something like `Resources: + 16 created` and prints:
```
Outputs:
    frontendPortForward : "kubectl -n guestbook port-forward svc/frontend 8080:80"
    frontendUrl         : "http://localhost:8080"
    grafanaAdminPassword: [secret]
    grafanaAdminUser    : "admin"
    grafanaPortForward  : "kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80"
    grafanaUrl          : "http://localhost:3000"
    prometheusService   : "monitoring/monitoring-kube-prometheus-prometheus"
```
If it fails partway (for example a timeout or an image download problem), look at the **Troubleshooting** section,
fix the cause, and simply run `pulumi up` again. It only creates what's missing.

---

## Step 6: Check that everything is running (~2 min) [T1]

```bash
kubectl get pods -n guestbook
```
✅ 5 pods, **all `2/2` and `Running`**. The `2/2` means app container + exporter sidecar.
```
frontend-xxxxxxxxx-aaaaa        2/2   Running
frontend-xxxxxxxxx-bbbbb        2/2   Running
frontend-xxxxxxxxx-ccccc        2/2   Running
redis-leader-xxxxxxxxx-ddddd    2/2   Running
redis-replica-xxxxxxxxx-eeeee   2/2   Running
```

```bash
kubectl get pods -n monitoring
```
✅ All `Running`:
- `monitoring-grafana-…` **3/3** (Grafana + dashboard loader + datasource loader)
- `prometheus-monitoring-kube-prometheus-prometheus-0` **2/2**
- `monitoring-kube-prometheus-operator-…` 1/1
- `monitoring-kube-state-metrics-…` 1/1
- `monitoring-prometheus-node-exporter-…` 1/1

```bash
kubectl get servicemonitors -n guestbook
kubectl get svc -n guestbook
```
✅ `guestbook-backend` and `guestbook-frontend` are listed. `frontend-metrics` shows port `9117`, and `redis-leader` and
`redis-replica` show `6379` and `9121`.

> Pods still `ContainerCreating` or `Init`? Wait a minute and check again; images may still be downloading.

---

## Step 7: Get the Grafana URL and credentials [T1]

```bash
pulumi stack output grafanaUrl                            # http://localhost:3000
pulumi stack output grafanaAdminUser                      # admin
pulumi stack output grafanaAdminPassword --show-secrets   # your generated password, copy it
```
**What it does:** reads the outputs Pulumi saved. The password was randomly generated by Pulumi and given to Grafana.
It's stored encrypted, which is why `--show-secrets` (and your passphrase) are needed to see it.

---

## Step 8: Open Grafana and the Guestbook [T2, T3]

**T2: Grafana** (copy the command from the `grafanaPortForward` output):
```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```
It prints `Forwarding from 127.0.0.1:3000 -> 3000` and then **keeps running. Leave this window open.**
Open **http://localhost:3000** in your browser and log in with **admin** and the password from Step 7.

**T3: Guestbook** (from the `frontendPortForward` output):
```bash
kubectl -n guestbook port-forward svc/frontend 8080:80
```
Open **http://localhost:8080** and submit a couple of messages.

✅ **Checkpoint:** the Grafana login works, and your messages appear in the Guestbook.

> If a port-forward window shows an error or the page stops loading, press Ctrl+C in it and run the same command again.

---

## Step 9: Generate traffic [T5]

```bash
kubectl -n guestbook run load-generator --rm -it --restart=Never --image=curlimages/curl -- sh -c "while true; do curl -s -o /dev/null -G http://frontend/guestbook.php -d cmd=get -d key=messages; sleep 0.2; done"
```
**What it does:** starts a temporary pod inside the cluster that calls the Guestbook API about 5 times per second. Each
call is one Apache request on a frontend pod plus one Redis read. That gives the graphs something to show.
It prints nothing while it runs, which is normal. **Leave it running.** Ctrl+C stops it, and the pod deletes itself.
(The same command works in PowerShell.)

---

## Step 10: Verify that Prometheus scrapes the Guestbook (the key requirement) [T4]

```bash
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```
Leave it running and open **http://localhost:9090**.

### 10a. Targets page
Open **http://localhost:9090/targets** and type `guestbook` in the filter box.

✅ You must see:
- `serviceMonitor/guestbook/guestbook-frontend/0`: **3/3 up** (one per frontend pod)
- `serviceMonitor/guestbook/guestbook-backend/0`: **2/2 up** (redis-leader + redis-replica)

This is the proof that Prometheus is scraping the frontend and the backend.

### 10b. Run queries
Open **http://localhost:9090/query** (on older versions it's called *Graph*: `/graph`). Paste each query, click **Execute**, and use the
**Graph** tab for the rates:

| Query | What you should see |
|---|---|
| `up{namespace="guestbook"}` | 5 results, all with value **1** (1 = target healthy) |
| `sum(rate(apache_accesses_total{namespace="guestbook"}[1m]))` | About **5** requests/sec while the load generator runs |
| `sum by (service) (rate(redis_commands_processed_total{namespace="guestbook"}[1m]))` | Redis commands/sec for `redis-leader` and `redis-replica` |
| `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!=""}[2m]))` | CPU used by each Guestbook pod |
| `sum by (pod) (container_memory_working_set_bytes{namespace="guestbook",container!=""})` | Memory used by each Guestbook pod |

Stop the load generator (Ctrl+C in T5) for a minute and run the request-rate query again: it drops. Start it again
and it rises. That shows the metrics are live.

### 10c. (Optional) Same check from the command line, in T1
macOS / Linux (needs `jq`: `brew install jq` / `sudo apt install jq`):
```bash
curl -s localhost:9090/api/v1/targets | jq -r '.data.activeTargets[] | select(.labels.namespace=="guestbook") | "\(.labels.service) \(.labels.pod) \(.health)"'
```
Windows (PowerShell):
```powershell
(Invoke-RestMethod http://localhost:9090/api/v1/targets).data.activeTargets | Where-Object { $_.labels.namespace -eq "guestbook" } | ForEach-Object { "$($_.labels.service) $($_.labels.pod) $($_.health)" }
```
✅ 5 lines, all ending in `up`.

**How this works:** each exporter listens on a port named `metrics`. Internal Services labelled `monitoring=enabled`
publish those ports. The ServiceMonitors select those Services, the Prometheus Operator turns them into scrape config, and
Prometheus calls `/metrics` on each pod every 15 seconds. Pod CPU and memory come from the kubelet (cAdvisor), which the chart scrapes out of the box.

---

## Step 11: The Grafana dashboard (stretch goal)

In Grafana (http://localhost:3000), open **☰ menu → Dashboards → Guestbook Application**.

✅ With the load generator running you'll see:
- **Health:** each Guestbook metrics service shows its number of UP targets (green), and a total-requests counter that keeps rising.
- **Frontend (Apache):** request rate per frontend pod (about 1.5–2 req/s each; traffic is spread over 3 pods) and busy workers.
- **Backend (Redis):** commands/sec for leader and replica, and connected clients.
- **Pod resource usage:** CPU and memory per Guestbook pod.

You can also go to **Explore** in Grafana and run any query from Step 10b.

---

## Step 12: Capture evidence (screenshots)

1. T1: the end of `pulumi up`, showing the **Outputs**.
2. T1: `kubectl get pods -n guestbook` (all 2/2) and `kubectl get pods -n monitoring`.
3. Prometheus **Targets** filtered on `guestbook` (3/3 up and 2/2 up).
4. Prometheus graph of `sum(rate(apache_accesses_total{namespace="guestbook"}[1m]))`.
5. The Grafana **Guestbook Application** dashboard with data.

---

## Step 13: Clean up when you're done

1. Press **Ctrl+C** in T2, T3, T4 and T5.
2. In T1 (with the passphrase still set):
```bash
pulumi destroy          # choose "yes": removes everything the project created
pulumi stack rm dev     # removes the stack record
minikube stop           # pauses the cluster (start it again later with: minikube start)
minikube delete         # OR: delete the cluster completely and free the disk space
```
Nothing costs money; this only frees your computer's CPU, RAM and disk.

---

## Troubleshooting

| Problem | What it means | Fix |
|---|---|---|
| `minikube start` says Docker isn't running | Docker Desktop is closed | Start Docker Desktop, wait for "running", then retry |
| `minikube start` says there isn't enough memory or CPUs | Docker has fewer resources than requested | Use `--cpus=2 --memory=4096`, or raise the limits in Docker Desktop → Settings → Resources |
| `passphrase must be set` / `incorrect passphrase` | This terminal doesn't have the passphrase, or it's a different one | Set `PULUMI_CONFIG_PASSPHRASE` again, **the same value as in Step 4** |
| Pods show `ImagePullBackOff` and `kubectl describe pod <name> -n guestbook` mentions `429 Too Many Requests` | Docker Hub limits anonymous downloads | Wait 15–30 min and run `pulumi up` again. Or run `docker login` (free Docker account), then e.g. `docker pull redis` and `minikube image load redis`, and do the same for `pulumi/guestbook-php-redis` and `pulumi/guestbook-redis-replica` |
| Pods stay `Pending` | The cluster is out of CPU/memory | `kubectl describe pod <name> -n <namespace>` shows why; restart minikube with more resources (`minikube delete`, then Step 2 with bigger numbers, then `pulumi up`) |
| `pulumi up` fails with a timeout on `kube-prometheus-stack` | Images took too long to download, or a pod can't start | `kubectl get pods -n monitoring` to see which pod; once they're Running, run `pulumi up` again |
| A target is **down** on the Prometheus Targets page | The exporter can't read the app | `kubectl -n guestbook logs <pod-name> -c apache-exporter` (or `-c redis-exporter`) |
| Grafana dashboard panels say "No data" | No traffic yet, or targets are down | Check Step 10a first, then make sure the load generator (Step 9) is running and wait a minute |
| Browser can't open localhost:3000 / 8080 / 9090 | The port-forward window was closed or broke | Run the port-forward command again in its terminal |
| `port-forward` says `address already in use` | Something else uses that port | Use another local port, e.g. `... port-forward svc/monitoring-grafana 3001:80`, then open localhost:3001 |
