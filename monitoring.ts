// Prometheus + Grafana via the kube-prometheus-stack Helm chart, plus the ServiceMonitors that tell
// Prometheus to scrape the Guestbook, and a Grafana dashboard for the Guestbook.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as fs from "fs";
import * as path from "path";
import { metricsLabel } from "./guestbook";

const KUBE_PROMETHEUS_STACK_VERSION = "92.0.0";
const RELEASE_NAME = "monitoring";

export interface MonitoringArgs {
    namespace: k8s.core.v1.Namespace;
    guestbookNamespace: pulumi.Input<string>;
    isMinikube: boolean;
}

export function deployMonitoring(args: MonitoringArgs) {
    const namespace = args.namespace.metadata.name;

    const grafanaAdminUser = "admin";
    const grafanaAdminPassword = new random.RandomPassword("grafana-admin-password", {
        length: 20,
        special: false,
    });

    // kube-prometheus-stack = Prometheus Operator + Prometheus + Grafana + kube-state-metrics + node-exporter.
    // The kubelet/cAdvisor scrape it configures out of the box provides pod CPU/memory usage.
    const stack = new k8s.helm.v3.Release("kube-prometheus-stack", {
        name: RELEASE_NAME,
        namespace,
        chart: "kube-prometheus-stack",
        version: KUBE_PROMETHEUS_STACK_VERSION,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        timeout: 900,
        values: {
            // Alerting is out of scope for this assignment; keeps the footprint small.
            alertmanager: { enabled: false },
            prometheus: {
                prometheusSpec: {
                    // By default Prometheus only picks up ServiceMonitors carrying `release: monitoring`.
                    // Select every ServiceMonitor instead, so the Guestbook ones are discovered.
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    scrapeInterval: "15s",
                },
            },
            grafana: {
                adminUser: grafanaAdminUser,
                adminPassword: grafanaAdminPassword.result,
                service: { type: args.isMinikube ? "NodePort" : "LoadBalancer" },
            },
            // On local clusters (Docker-based nodes) mounting the host root filesystem into node-exporter can fail
            // to start; it is not needed here, since pod CPU/memory comes from the kubelet (cAdvisor).
            ...(args.isMinikube ? { "prometheus-node-exporter": { hostRootFsMount: { enabled: false } } } : {}),
        },
    }, { dependsOn: [args.namespace] });

    // One ServiceMonitor per tier. Each selects the Services labelled `monitoring: enabled` in the guestbook
    // namespace for that tier and scrapes their port named "metrics" every 15s.
    const serviceMonitor = (name: string, tier: string) =>
        new k8s.apiextensions.CustomResource(name, {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { name, namespace: args.guestbookNamespace },
            spec: {
                selector: { matchLabels: { tier, ...metricsLabel } },
                endpoints: [{ port: "metrics", path: "/metrics", interval: "15s" }],
            },
        }, { dependsOn: [stack] }); // the ServiceMonitor CRD is installed by the chart

    serviceMonitor("guestbook-frontend", "frontend");
    serviceMonitor("guestbook-backend", "backend");

    // Stretch goal: Grafana's dashboard sidecar auto-imports ConfigMaps labelled grafana_dashboard=1.
    new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: { name: "guestbook-dashboard", namespace, labels: { grafana_dashboard: "1" } },
        data: {
            "guestbook.json": fs.readFileSync(path.join(__dirname, "dashboards", "guestbook.json"), "utf8"),
        },
    }, { dependsOn: [stack] });

    // Read back the Grafana Service created by the chart to get its external address.
    const grafanaService = k8s.core.v1.Service.get(
        "grafana",
        pulumi.interpolate`${stack.status.namespace}/${stack.status.name}-grafana`,
        { dependsOn: [stack] },
    );

    // minikube: the NodePort isn't reachable from the host with every driver, so Grafana is opened through
    // `kubectl port-forward` (see the grafanaPortForward output).
    // Cloud: the Helm release waits until the LoadBalancer has an address, reported as an IP or a hostname (EKS).
    const grafanaUrl = args.isMinikube
        ? pulumi.output("http://localhost:3000")
        : grafanaService.status.loadBalancer.ingress.apply(ing => `http://${ing[0].hostname ?? ing[0].ip}`);

    return {
        grafanaUrl,
        grafanaAdminUser,
        grafanaAdminPassword: grafanaAdminPassword.result, // secret output
        grafanaNodePort: grafanaService.spec.ports.apply(ports => ports[0].nodePort),
        prometheusService: pulumi.interpolate`${stack.status.namespace}/${stack.status.name}-kube-prometheus-prometheus`,
    };
}
