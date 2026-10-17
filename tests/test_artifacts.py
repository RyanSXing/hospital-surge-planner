"""OCI client reuse avoids metadata-network work without freezing credentials."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import oci
import pytest
from surge_api import artifacts


@pytest.fixture
def oci_store(monkeypatch, tmp_path):
    artifacts._reset_oci_clients_after_fork()
    monkeypatch.setenv("ARTIFACT_BACKEND", "oci")
    monkeypatch.setenv("ARTIFACT_LOCAL_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("OCI_NAMESPACE", "test-namespace")
    monkeypatch.setenv("OCI_ARTIFACT_BUCKET", "test-bucket")
    monkeypatch.setenv("OCI_AUTH", "instance_principal")
    yield
    artifacts._reset_oci_clients_after_fork()


def test_concurrent_stores_share_refreshing_signer_and_client(oci_store, monkeypatch):
    signers, clients = [], []

    def signer_factory():
        signer = SimpleNamespace(token="original")
        signers.append(signer)
        return signer

    def client_factory(config, *, signer):
        client = SimpleNamespace(signer=signer)
        clients.append(client)
        return client

    monkeypatch.setattr(oci.auth.signers, "InstancePrincipalsSecurityTokenSigner", signer_factory)
    monkeypatch.setattr(oci.object_storage, "ObjectStorageClient", client_factory)
    with ThreadPoolExecutor(max_workers=8) as executor:
        stores = list(executor.map(lambda _: artifacts.ArtifactStore(), range(24)))
    assert len(signers) == len(clients) == 1
    assert all(store.client is clients[0] for store in stores)
    # The SDK refreshes this same signer internally; reuse must not snapshot its token.
    signers[0].token = "refreshed"
    assert artifacts.ArtifactStore().client.signer.token == "refreshed"
    artifacts._reset_oci_clients_after_fork()
    assert artifacts.ArtifactStore().client is not clients[0]


def test_profile_config_and_key_rotation_invalidate_client(oci_store, monkeypatch, tmp_path):
    key_file = tmp_path / "key.pem"
    key_file.write_text("first-key")
    monkeypatch.setenv("OCI_AUTH", "config")
    monkeypatch.setenv("OCI_CONFIG_PROFILE", "FIRST")
    monkeypatch.setattr(
        oci.config,
        "from_file",
        lambda profile_name: {"profile": profile_name, "key_file": str(key_file)},
    )
    monkeypatch.setattr(
        oci.object_storage, "ObjectStorageClient", lambda config: SimpleNamespace(config=config)
    )
    first = artifacts.ArtifactStore().client
    assert artifacts.ArtifactStore().client is first
    monkeypatch.setenv("OCI_CONFIG_PROFILE", "SECOND")
    second = artifacts.ArtifactStore().client
    assert second is not first and second.config["profile"] == "SECOND"
    key_file.write_text("rotated-private-key")
    assert artifacts.ArtifactStore().client is not second


def test_failed_client_construction_can_retry(oci_store, monkeypatch):
    attempts = []
    monkeypatch.setattr(oci.auth.signers, "InstancePrincipalsSecurityTokenSigner", lambda: object())

    def construct(config, signer):
        attempts.append(True)
        if len(attempts) == 1:
            raise ConnectionError("Transient metadata dependency failure")
        return object()

    monkeypatch.setattr(oci.object_storage, "ObjectStorageClient", construct)
    with pytest.raises(ConnectionError):
        artifacts.ArtifactStore()
    successful = artifacts.ArtifactStore().client
    assert artifacts.ArtifactStore().client is successful
    assert len(attempts) == 2
