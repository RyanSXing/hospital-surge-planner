"""Read-only OCI inventory and access checks. Never provisions resources."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path

import oci
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
config = oci.config.from_file(profile_name=os.getenv("OCI_CONFIG_PROFILE", "DEFAULT"))
if not config.get("tenancy"):
    raise SystemExit("The selected OCI profile has no tenancy. Set OCI_CONFIG_PROFILE to your configured API-key profile, then rerun; no credentials were printed.")
compartment = os.getenv("OCI_COMPARTMENT_ID") or config["tenancy"]
identity = oci.identity.IdentityClient(config)
compute = oci.core.ComputeClient(config)
network = oci.core.VirtualNetworkClient(config)
storage = oci.object_storage.ObjectStorageClient(config)
checks = {}


def check(name, callback, transform=lambda value: value):
    try:
        value = callback()
        checks[name] = {"ok": True, "value": transform(value)}
        return value
    except Exception as error:
        checks[name] = {"ok": False, "error_type": type(error).__name__, "status": getattr(error, "status", None), "code": getattr(error, "code", None)}
        return None


check("region_subscriptions", lambda: identity.list_region_subscriptions(config["tenancy"]).data, lambda rows: [{"region": row.region_name, "status": row.status} for row in rows])
check("compartments", lambda: oci.pagination.list_call_get_all_results(identity.list_compartments, config["tenancy"], compartment_id_in_subtree=True, access_level="ACCESSIBLE").data, lambda rows: [{"name": row.name, "state": row.lifecycle_state} for row in rows if row.lifecycle_state == "ACTIVE"])
check("instances", lambda: oci.pagination.list_call_get_all_results(compute.list_instances, compartment).data, lambda rows: [{"name": row.display_name, "state": row.lifecycle_state, "shape": row.shape} for row in rows])
check("vcns", lambda: oci.pagination.list_call_get_all_results(network.list_vcns, compartment).data, lambda rows: [{"name": row.display_name, "state": row.lifecycle_state} for row in rows])
namespace = check("object_storage_namespace", lambda: storage.get_namespace().data)
if namespace:
    check("buckets", lambda: oci.pagination.list_call_get_all_results(storage.list_buckets, namespace, compartment).data, lambda rows: [{"name": row.name} for row in rows])
limits = oci.limits.LimitsClient(config)
for limit in ("standard-a1-core-count", "standard-a1-memory-count", "standard-e4-core-count"):
    check(limit, lambda limit=limit: oci.pagination.list_call_get_all_results(limits.list_limit_values, config["tenancy"], "compute", name=limit).data, lambda rows: [{"availability_domain": row.availability_domain, "value": row.value} for row in rows])
report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "region": config["region"], "mode": "read_only", "provisioned": False, "checks": checks, "remaining": ["Select and authorize region/shape/storage budget", "Provision network, VM, private buckets and scoped instance identity", "Configure public URL/TLS and hosted login", "Deploy and record an actual engine run plus artifact round trip", "Measure accepted performance and restore a backup"]}
path = ROOT / "evidence/oci-readiness.json"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"region": config["region"], "checks": {name: value["ok"] for name, value in checks.items()}, "report": str(path), "provisioned": False}, indent=2))
