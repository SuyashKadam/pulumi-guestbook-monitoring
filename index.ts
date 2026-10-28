import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { deployGuestbook } from "./guestbook";
import { deployMonitoring } from "./monitoring";

// minikube/kind have no LoadBalancer implementation: there the frontend is ClusterIP and Grafana NodePort.
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? true;

const guestbookNs = new k8s.core.v1.Namespace("guestbook", { metadata: { name: "guestbook" } });
const monitoringNs = new k8s.core.v1.Namespace("monitoring", { metadata: { name: "monitoring" } });

const guestbook = deployGuestbook({ namespace: guestbookNs.metadata.name, isMinikube });
const monitoring = deployMonitoring({
    namespace: monitoringNs,
    guestbookNamespace: guestbookNs.metadata.name,
    isMinikube,
});

export const frontendUrl = guestbook.frontendUrl;
export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = monitoring.grafanaAdminUser;
export const grafanaAdminPassword = monitoring.grafanaAdminPassword; // `pulumi stack output grafanaAdminPassword --show-secrets`
export const prometheusService = monitoring.prometheusService;

// On minikube there is no external load balancer: these are the commands that make the URLs above work.
export const grafanaNodePort = isMinikube ? monitoring.grafanaNodePort : undefined;
export const grafanaPortForward = isMinikube ? "kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80" : undefined;
export const frontendPortForward = isMinikube ? "kubectl -n guestbook port-forward svc/frontend 8080:80" : undefined;
