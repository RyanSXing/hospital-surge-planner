# OCI deployment plan and provisioning record

Read-only inventory was checked on 2026-10-17. The account is subscribed to `us-chicago-1`; the inspected root scope has no VCN, instance or bucket and no active child compartment. OCI API access works. Subscription/credit retrieval through `oci.osub_subscription.SubscriptionClient.list_subscriptions` returned HTTP401; **available credits and actual billing discounts are unknown**.

## Proposed reference host

| Component | Concrete proposal |
|---|---|
| Region | `us-chicago-1` |
| Shape | `VM.Standard.A1.Flex`, 8 OCPUs, 16 GiB RAM; A1 OCPU is one vCPU |
| Shape availability signal | `list_shapes` returns A1 in AD1; quota lists 41 A1 cores and 277 GiB per AD; launch capacity is not yet reserved or proven |
| Image | `Canonical-Ubuntu-24.04-aarch64-2026.09.18-0`, state AVAILABLE, native/paravirtualized ARM64 |
| Image OCID | `ocid1.image.oc1.us-chicago-1.aaaaaaaadcv3pphkgnnwsulixcq3glryb4ljkgxnijfocsxarbg6fnru5sjq` |
| Durable disks | 50 GiB boot plus 100 GiB attached data volume, Balanced 10 VPU/GB; mount persistent data volume before starting containers |
| VCN/subnet | New project VCN `10.42.0.0/16`, public subnet `10.42.1.0/24`, internet gateway and default route |
| Ingress | TCP443 from internet; TCP22 only from the approved administration address/path; UDP443 optional |
| Outbound | HTTPS for image/package/OCI/certificate endpoints, DNS to VCN resolver, OS time/update access as required |
| Identity | Instance-specific dynamic group and bucket-specific object access; no laptop credentials in images |
| Storage | Separate private artifact and backup buckets; seven-day backup lifecycle prefix, application retention policies for transient/export objects |
| Runtime | Existing Compose stack, immutable release tag, 2 worker processes initially; benchmark and tune |
| Public URL | An approved DNS hostname pointed at the VM, HTTPS via Caddy TLS-ALPN challenge on443 |

A1 is chosen because it matches the specification's eight-vCPU reference on a supported ARM stack and is returned by the current account's shape discovery. E4 core quota is zero in this account, so that is not an immediately usable alternative. The current laptop is ARM64 and the chosen Python package wheels installed successfully; container build still needs verification.

## Cost estimate

Oracle's current [Ampere page](https://www.oracle.com/cloud/compute/arm/) lists A1 at $0.01/OCPU-hour plus $0.0015/GB-hour. Therefore **8 OCPUs +16 GiB is $0.104/hour, about $75.92 for730 hours**, before any entitlement/discount/tax. This is arithmetic from list rates, not the account's billed amount. [Oracle's price list](https://www.oracle.com/cloud/price-list/) describes separate boot/block-volume charges.

For a planning envelope, 150 GiB Balanced storage at approximately $0.0425/GB-month is about $6.38/month; 25 GB Standard Object Storage at $0.0255/GB-month is about $0.64/month, before free allocations and request/egress charges. These storage figures must be rechecked in the provisioning cost estimator: the current price-list HTML omits dynamically populated rate cells, while Oracle's published [storage pricing explainer](https://www.oracle.com/a/ocom/docs/cloud-training-pricing-billing.pdf) and [Object Storage FAQ](https://www.oracle.com/apac/cloud/storage/archive-storage/faq/) provide those rates. **Approximate gross envelope: $83/month plus variable requests/egress/tax/domain, or about $2.75/day while continuously running.** No free-tier deduction is assumed; no credit balance has been established.

Provision only the chosen project resources after local correctness smoke succeeds and the parent confirms the intended deployment scope. Set a budget alert, record actual IDs/tags and expected costs, and retain the stop/delete instructions. Compute stop does not remove persistent storage charges. A budget alert is notification, not a hard spending cap.

## Provisioning order and proof

1. Select/create the project compartment and cost alert; record the region, shape, volume sizes and tags.
2. Create the VCN, gateway, route, restricted security rules and subnet.
3. Create the ARM Ubuntu VM with a new project SSH public key and secure admin access; record fingerprint through trusted instance setup.
4. Attach and mount durable data storage; configure Docker's data root or reviewed bind mounts there. Keep database data outside the ephemeral container layer.
5. Create private buckets, instance dynamic group and least-privilege policies; verify SDK workload identity.
6. Point approved DNS at the VM, deploy images/config, apply migrations, start health-checked services and obtain HTTPS certificate.
7. Run authenticated forecast/compare/update/replay/export workflows; prove private OCI object write/read with checksum and run IDs.
8. Run measured 10/100-replication and 365-day benchmarks, failure recovery, daily backup and isolated PostgreSQL restore verification. Attach evidence before marking F26 complete.

The original proposal above explains the approved budget. Actual resource IDs and provisioning state are recorded in `evidence/oci-provisioning.json`.

## Actual capacity fallback — 2026-10-17

The user approved the approximately $83/month deployment. A1 with eight OCPUs returned `OutOfHostCapacity` in all three Chicago availability domains; capacity reports also rejected four-OCPU A1 in all three. A2 was available and the chosen Ubuntu ARM image explicitly supports it. We provisioned one **VM.Standard.A2.Flex with four OCPUs, eight vCPUs, and 16 GiB RAM** in AD1. The OCI instance response confirms eight vCPUs. No additional VM was created.

Oracle's [A2 announcement](https://blogs.oracle.com/cloud-infrastructure/introducing-oci-ampere-a2-arm-cloud-compute) and [USD global price list](https://www.oracle.com/apac/a/ocom/docs/corporate/pricing/oracle-paas-and-iaas-global-price-list.pdf) give $0.014/OCPU-hour and $0.002/GiB-hour; A2 supplies two physical cores per OCPU. Compute is therefore `(4 × 0.014 + 16 × 0.002) × 730 = $64.24/month`. With the original 150-GiB disk and 25-GB object-storage envelope, the estimate is about **$71.25/month**, before request/egress/tax changes or account credits. The compartment has an $83 monthly OCI budget for cost tracking; this is not a hard spending cap and no notification recipient was invented.

The host IP is `131.186.0.156`; `hospital-surge.131.186.0.156.sslip.io` resolves to it. Public ingress is TCP443, plus TCP22 restricted to the verified deployment workstation address obtained from the user's OCI Audit records. PostgreSQL, Redis, API and nginx8080 are not publicly published. A dedicated SSH key is in ignored `data/deployment/`; the host key was authenticated through OCI serial-console retrieval before strict SSH connection.

The 100-GiB data volume is mounted at `/mnt/hospital-data`; Docker's data root and named volumes live there. OCI encrypts disks at rest. This A2/image combination rejects optional paravirtualized link encryption; the attachment uses the supported default. Private buckets are `hospital-surge-artifacts` and `hospital-surge-backups`; the instance identity has object access only to those buckets. A regional Object Storage service policy scoped to the backup bucket enables its seven-day `backups/` lifecycle.

Host initialization verified eight CPUs, 15,949 MiB visible RAM, Docker29.1.3, Compose2.40.3 and the mounted data disk. Public TLS, application workflows, private artifact round trips and hosted performance remain separate gates until their evidence is recorded.
