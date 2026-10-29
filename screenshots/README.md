# Screenshots

Taken from a run on minikube (Ubuntu on WSL2).

| File | What it shows |
|---|---|
| `01-pulumi-outputs.png` | `pulumi up` result: 16 resources created, and the stack outputs (Grafana URL, NodePort, admin user; password kept secret) |
| `02-pods.png` | Guestbook pods at `2/2` (app + exporter sidecar) and the monitoring stack pods |
| `03-servicemonitors-and-grafana-svc.png` | ServiceMonitors, guestbook services with metrics ports, and Grafana as a NodePort service |
| `04a-prometheus-targets-frontend.png` | Prometheus targets: `guestbook-frontend` 3/3 up |
| `04b-prometheus-targets-backend.png` | Prometheus targets: `guestbook-backend` 2/2 up |
| `05-prometheus-request-rate.png` | `sum(rate(apache_accesses_total{namespace="guestbook"}[1m]))` while the load generator runs |
| `06-grafana-dashboard.png` | The "Guestbook Application" Grafana dashboard |
