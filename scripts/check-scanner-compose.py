"""Check the rendered ordinary Compose security/resource contract in isolated CI."""
import json
import sys

compose = json.load(open(sys.argv[1]))
service = compose["services"]["scanner"]
assert set(compose["services"]) == {"scanner"}
assert service["image"] == "clamav/clamav:1.5.4@sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6"
# compose-go UnitBytes.MarshalJSON emits decimal byte strings; older CLI output may use integers.
# https://github.com/compose-spec/compose-go/blob/main/types/bytes.go
for key in ("mem_limit", "memswap_limit"):
    value = service[key]
    assert type(value) in (int, str) and str(value) == "4294967296", f"{key} must be exactly 4294967296 bytes"
assert not any(service.get(key) for key in ("ports", "privileged", "build", "command", "entrypoint", "healthcheck"))
assert service["environment"] == {"FRESHCLAM_CHECKS": "12", "TZ": "Etc/UTC"}
assert service["logging"] == {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}
assert len(service["volumes"]) == 1
mount = service["volumes"][0]
assert mount["type"] == "volume" and mount["source"] == "signatures" and mount["target"] == "/var/lib/clamav"
assert set(service["networks"]) == {"app", "default"}
assert service["networks"]["app"]["aliases"] == ["opendiscord-private-scanner"]
assert compose["networks"]["app"]["external"] is True
assert compose["networks"]["app"]["name"] == "isolated-scanner-fixture"
assert not compose["networks"]["default"].get("internal")
print("Private scanner Compose contract passed; no daemon started")
