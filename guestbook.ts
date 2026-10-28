// The Guestbook application from https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple
// (redis-leader, redis-replica, frontend), extended so that every tier exposes Prometheus metrics:
//
//   * Backend  (Redis)  -> a redis_exporter sidecar in each Redis pod, metrics on port 9121
//   * Frontend (Apache) -> an apache_exporter sidecar that reads Apache's mod_status page, metrics on port 9117
//
// Each metrics port is published through a ClusterIP Service (port name "metrics"), which is what the
// ServiceMonitors in monitoring.ts select. Metrics are never exposed on the public frontend LoadBalancer.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

const REDIS_EXPORTER_IMAGE = "quay.io/oliver006/redis_exporter:v1.80.0";
const APACHE_EXPORTER_IMAGE = "quay.io/lusitaniae/apache-exporter:v1.0.10";

// Label put on every Service that serves a "metrics" port; the ServiceMonitors match on it.
export const metricsLabel = { monitoring: "enabled" };

const exporterResources = { requests: { cpu: "10m", memory: "16Mi" }, limits: { memory: "64Mi" } };

// redis_exporter sidecar: talks to Redis over localhost inside the same pod.
function redisExporter(): k8s.types.input.core.v1.Container {
    return {
        name: "redis-exporter",
        image: REDIS_EXPORTER_IMAGE,
        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
        ports: [{ name: "metrics", containerPort: 9121 }],
        resources: exporterResources,
    };
}

export interface GuestbookArgs {
    namespace: pulumi.Input<string>;
    isMinikube: boolean;
}

export function deployGuestbook(args: GuestbookArgs) {
    const namespace = args.namespace;

    //
    // REDIS LEADER (backend)
    //
    const redisLeaderLabels = { app: "redis-leader", tier: "backend" };
    new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace, labels: redisLeaderLabels },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-leader",
                            image: "redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporter(),
                    ],
                },
            },
        },
    });
    new k8s.core.v1.Service("redis-leader", {
        metadata: { name: "redis-leader", namespace, labels: { ...redisLeaderLabels, ...metricsLabel } },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: 6379 },
                { name: "metrics", port: 9121, targetPort: "metrics" },
            ],
            selector: redisLeaderLabels,
        },
    });

    //
    // REDIS REPLICA (backend)
    //
    const redisReplicaLabels = { app: "redis-replica", tier: "backend" };
    new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace, labels: redisReplicaLabels },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "pulumi/guestbook-redis-replica",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporter(),
                    ],
                },
            },
        },
    });
    new k8s.core.v1.Service("redis-replica", {
        metadata: { name: "redis-replica", namespace, labels: { ...redisReplicaLabels, ...metricsLabel } },
        spec: {
            ports: [
                { name: "redis", port: 6379, targetPort: 6379 },
                { name: "metrics", port: 9121, targetPort: "metrics" },
            ],
            selector: redisReplicaLabels,
        },
    });

    //
    // FRONTEND
    //

    // Apache config dropped into conf-enabled/: makes sure mod_status is loaded and serves /server-status,
    // restricted to requests from inside the pod (the exporter sidecar uses 127.0.0.1), so users hitting the
    // public frontend get 403 on /server-status.
    const apacheStatusConfig = new k8s.core.v1.ConfigMap("frontend-apache-status", {
        metadata: { namespace },
        data: {
            "server-status.conf": [
                "<IfModule !status_module>",
                "    LoadModule status_module /usr/lib/apache2/modules/mod_status.so",
                "</IfModule>",
                "ExtendedStatus On",
                "<Location \"/server-status\">",
                "    SetHandler server-status",
                "    Require local",
                "</Location>",
                "",
            ].join("\n"),
        },
    });

    const frontendLabels = { app: "frontend", tier: "frontend" };
    new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace, labels: frontendLabels },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "frontend",
                            image: "pulumi/guestbook-php-redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ containerPort: 80 }],
                            volumeMounts: [{
                                name: "apache-status",
                                mountPath: "/etc/apache2/conf-enabled/server-status.conf",
                                subPath: "server-status.conf",
                            }],
                        },
                        {
                            name: "apache-exporter",
                            image: APACHE_EXPORTER_IMAGE,
                            args: ["--scrape_uri=http://127.0.0.1/server-status?auto"],
                            ports: [{ name: "metrics", containerPort: 9117 }],
                            resources: exporterResources,
                        },
                    ],
                    volumes: [{ name: "apache-status", configMap: { name: apacheStatusConfig.metadata.name } }],
                },
            },
        },
    });

    // Public entry point of the app (HTTP only, no metrics port here).
    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: { name: "frontend", namespace, labels: frontendLabels },
        spec: {
            type: args.isMinikube ? "ClusterIP" : "LoadBalancer",
            ports: [{ name: "http", port: 80 }],
            selector: frontendLabels,
        },
    });

    // Internal-only Service used by Prometheus to scrape the frontend exporters.
    new k8s.core.v1.Service("frontend-metrics", {
        metadata: { name: "frontend-metrics", namespace, labels: { ...frontendLabels, ...metricsLabel } },
        spec: {
            type: "ClusterIP",
            ports: [{ name: "metrics", port: 9117, targetPort: "metrics" }],
            selector: frontendLabels,
        },
    });

    // Cloud load balancers report either an IP (GKE/AKS) or a hostname (EKS).
    const frontendUrl = args.isMinikube
        ? pulumi.output("http://localhost:8080") // via `kubectl port-forward` (see frontendPortForward output)
        : frontendService.status.loadBalancer.ingress.apply(ing => `http://${ing[0].hostname ?? ing[0].ip}`);

    return { frontendUrl };
}
