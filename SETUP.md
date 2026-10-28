# Setup from scratch (Ubuntu / WSL2)

These are the steps I followed to get everything running locally on minikube. It doesn't need a cloud account.

Everything below runs in a normal terminal. You'll end up with a few port-forwards running at once, so keep several
terminal tabs open.

## 1. Install the tools

Docker:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER     # log out and back in afterwards
```

On WSL2 without systemd, start the daemon yourself with `sudo service docker start`.

minikube and kubectl:

```bash
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install kubectl /usr/local/bin/kubectl
```

Pulumi:

```bash
curl -fsSL https://get.pulumi.com | sh
```

The installer adds `~/.pulumi/bin` to your PATH, so open a new shell afterwards.

Node.js 22 from NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git jq
```

Don't use plain `apt install nodejs`. Ubuntu ships Node 12, and `pulumi preview` then fails with
`SyntaxError: Unexpected token '.'`. I hit this myself. If you already have the old version installed, remove it first:

```bash
sudo apt-get remove -y nodejs libnode-dev libnode72 && sudo apt-get autoremove -y
```

Then run the two NodeSource commands above, and `hash -r` so the shell finds the new `node`.

Quick check:

```bash
docker version && minikube version && kubectl version --client && pulumi version && node --version
```

`node --version` should print v20 or newer.

## 2. Start minikube

```bash
minikube start --driver=docker --cpus=4 --memory=6144
```

If you're running as root (the default in a lot of WSL setups), minikube refuses the Docker driver unless you add
`--force`. If your machine is short on memory, `--cpus=2 --memory=4096` also works, just more slowly.

```bash
kubectl config current-context   # should say minikube
kubectl get nodes                # Ready
```

Pulumi deploys to whatever context kubectl points at, so check this before going further.

## 3. Get the code

```bash
git clone https://github.com/SuyashKadam/pulumi-guestbook-monitoring.git
cd pulumi-guestbook-monitoring
npm install
npx tsc --noEmit                 # prints nothing if the code compiles
```

## 4. Pulumi stack

```bash
pulumi login --local
export PULUMI_CONFIG_PASSPHRASE="pick-something"
pulumi stack init dev
```

`--local` keeps the state in `~/.pulumi`, so you don't need a Pulumi account. The passphrase encrypts secrets in that
state (the Grafana password among them). Every new shell where you run a `pulumi` command needs the same passphrase exported again.

You don't need to configure anything for minikube. `isMinikube` defaults to true.

## 5. Deploy

```bash
pulumi preview
pulumi up
```

The preview should list about 16 resources: two namespaces, the random password, the Helm release, 3 deployments,
4 services, 2 configmaps and 2 ServiceMonitors. There's also one read of the Grafana service, which Pulumi uses for the URL output.

`pulumi up` spends most of its time waiting for the kube-prometheus-stack pods to become ready. For me it took about
5 minutes the first time. At the end it prints:

```
Outputs:
    frontendPortForward : "kubectl -n guestbook port-forward svc/frontend 8080:80"
    frontendUrl         : "http://localhost:8080"
    grafanaAdminPassword: [secret]
    grafanaAdminUser    : "admin"
    grafanaNodePort     : 3xxxx
    grafanaPortForward  : "kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80"
    grafanaUrl          : "http://localhost:3000"
    prometheusService   : "monitoring/monitoring-kube-prometheus-prometheus"
```

If it fails partway through, usually because of an image pull timeout, fix the cause and run `pulumi up` again. It only
creates what's missing.

## 6. Check the pods

```bash
kubectl -n guestbook get pods
```

You should see 5 pods, all `2/2 Running`: 3 frontend, redis-leader and redis-replica. The second container in each pod is the exporter.

```bash
kubectl -n monitoring get pods
```

Everything here should be Running. The Grafana pod is `3/3`, because it runs Grafana plus two sidecars that load
dashboards and datasources.

## 7. Open Grafana and the guestbook

Get the login:

```bash
pulumi stack output grafanaAdminPassword --show-secrets
```

In a second tab, port-forward Grafana:

```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
```

Open http://localhost:3000 and log in as `admin`.

In a third tab, port-forward the guestbook:

```bash
kubectl -n guestbook port-forward svc/frontend 8080:80
```

Open http://localhost:8080 and post a couple of messages.

## 8. Generate traffic

In a fourth tab:

```bash
kubectl -n guestbook run load-generator --rm -it --restart=Never --image=curlimages/curl -- \
  sh -c "while true; do curl -s -o /dev/null -G http://frontend/guestbook.php -d cmd=get -d key=messages; sleep 0.2; done"
```

It prints nothing while it runs. Ctrl+C stops it, and the pod gets deleted.

## 9. Check that Prometheus is scraping

In a fifth tab:

```bash
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Go to http://localhost:9090/targets and filter on `guestbook`. You want to see `guestbook-frontend` at 3/3 up and
`guestbook-backend` at 2/2 up.

From the command line:

```bash
curl -s localhost:9090/api/v1/targets \
  | jq -r '.data.activeTargets[] | select(.labels.namespace=="guestbook") | "\(.labels.service) \(.labels.pod) \(.health)"'
```

That should print 5 lines, all ending in `up`.

Then run a few queries on http://localhost:9090/query:

- `up{namespace="guestbook"}` should return 5 series, all with value 1.
- `sum(rate(apache_accesses_total{namespace="guestbook"}[1m]))` should be around 5 req/s while the load generator runs.
- `sum by (service) (rate(redis_commands_processed_total{namespace="guestbook"}[1m]))` shows Redis ops/s.

## 10. Dashboard

In Grafana, go to Dashboards and open **Guestbook Application**. With the load generator running, the request rate,
Redis ops and CPU panels should all show data. Each frontend pod handles about a third of the traffic.

## Cleanup

Stop the port-forwards and the load generator, then run:

```bash
pulumi destroy
pulumi stack rm dev
minikube delete
```

## Things that went wrong for me, or might for you

- **`SyntaxError: Unexpected token '.'` on preview:** Node is too old. See step 1.
- **`passphrase must be set`:** export `PULUMI_CONFIG_PASSPHRASE` again in this shell, with the same value.
- **`ImagePullBackOff` with a 429 in `kubectl describe pod`:** you've hit Docker Hub's rate limit. Wait a bit and rerun
  `pulumi up`. Or run `docker login`, then `docker pull redis` and `minikube image load redis`, and do the same for the two
  `pulumi/guestbook-*` images.
- **Pods stuck in `Pending`:** minikube doesn't have enough CPU or memory. Delete it and start it again with more.
- **A target shows as down in Prometheus:** check the exporter logs with
  `kubectl -n guestbook logs <pod> -c apache-exporter` (or `-c redis-exporter`).
- **Dashboard says "No data":** check the targets page first, then make sure the load generator is running.
- **A port-forward stopped working:** Ctrl+C it and run it again. If the port is taken, use another one, for example `3001:80`.
