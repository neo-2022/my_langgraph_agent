from fastapi.testclient import TestClient
import pytest

from react_agent import ui_proxy


@pytest.fixture
def client():
    return TestClient(ui_proxy.app)


@pytest.fixture
def fake_action(monkeypatch):
    calls = []

    def _fake(action, params):
        calls.append((action, params))
        return {"ok": True}

    monkeypatch.setattr(ui_proxy, "_call_art_action", _fake)
    return calls


def test_ui_proxy_service_actions(client, fake_action):
    resp = client.post("/ui/ui-proxy/start")
    assert resp.status_code == 200 and resp.json()["ok"]
    resp = client.post("/ui/ui-proxy/restart")
    assert resp.status_code == 200 and resp.json()["ok"]
    resp = client.post("/ui/ui-proxy/stop")
    assert resp.status_code == 200 and resp.json()["ok"]
    expected = [
        ("service_control", {"service": "my_langgraph_ui_proxy.service", "command": "start"}),
        ("service_control", {"service": "my_langgraph_ui_proxy.service", "command": "restart"}),
        ("service_control", {"service": "my_langgraph_ui_proxy.service", "command": "stop"}),
    ]
    assert fake_action == expected


def test_ui_proxy_status_uses_action(monkeypatch, client):
    monkeypatch.setattr(
        ui_proxy,
        "_systemd_user_service_status",
        lambda svc: {"name": svc, "active": True, "enabled": True, "error": ""},
    )
    resp = client.get("/ui/ui-proxy/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["systemd_user_service"]["active"] is True
    assert body["systemd_user_service"]["enabled"] is True
