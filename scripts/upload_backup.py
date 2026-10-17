"""Upload one backup to the private OCI backup bucket; emit a checksum manifest."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

import oci

path = Path(sys.argv[1])
signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
client = oci.object_storage.ObjectStorageClient({}, signer=signer)
namespace = os.environ["OCI_NAMESPACE"]
bucket = os.getenv("OCI_BACKUP_BUCKET") or os.environ["OCI_ARTIFACT_BUCKET"]
key = "backups/" + path.name
with path.open("rb") as source:
    digest = hashlib.file_digest(source, "sha256").hexdigest()
with path.open("rb") as source:
    client.put_object(namespace, bucket, key, source)
metadata = {"created_at": datetime.now(timezone.utc).isoformat(), "sha256": digest, "byte_size": path.stat().st_size, "object_key": key, "format": "postgresql-custom-dump"}
client.put_object(namespace, bucket, key + ".json", json.dumps(metadata).encode(), content_type="application/json")
print(json.dumps(metadata))
