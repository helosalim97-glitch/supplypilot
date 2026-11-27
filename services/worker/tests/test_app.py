from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from supplypilot_worker.app import create_app
from supplypilot_worker.lead_times import OrderDelivery
from supplypilot_worker.proposals import StockPosition
from supplypilot_worker.repository import Supplier
from supplypilot_worker.settings import Settings

TOKEN = "t" * 40
ORG = "0d6f1a52-6a0e-4a43-9d2b-1f6a7c1e0001"
OTHER_ORG = "0d6f1a52-6a0e-4a43-9d2b-1f6a7c1e0002"
STEADY = "5b8e0c1e-3f55-4b8e-8a40-000000000001"
ERRATIC = "5b8e0c1e-3f55-4b8e-8a40-000000000002"
NEW = "5b8e0c1e-3f55-4b8e-8a40-000000000003"
OLD = "5b8e0c1e-3f55-4b8e-8a40-000000000004"
FOREIGN = "5b8e0c1e-3f55-4b8e-8a40-000000000005"
AS_OF = datetime(2026, 6, 30, tzinfo=timezone.utc)
WH = "7c1d2e3f-0000-4000-8000-000000000001"
SKU_LOW = "9a0b1c2d-0000-4000-8000-000000000001"
SKU_FULL = "9a0b1c2d-0000-4000-8000-000000000002"
SKU_NEW = "9a0b1c2d-0000-4000-8000-000000000003"
SKU_ORPHAN = "9a0b1c2d-0000-4000-8000-000000000004"
SKU_FOREIGN = "9a0b1c2d-0000-4000-8000-000000000005"


class FakeSource:
    def __init__(self):
        self.calls = []
        self.orgs = {ORG: [Supplier(STEADY, "SUP-STEADY", "Steady Synthetic Co", False),
                           Supplier(ERRATIC, "SUP-ERRATIC", "Erratic Synthetic Co", False),
                           Supplier(NEW, "SUP-NEW", "New Synthetic Co", False),
                           Supplier(OLD, "SUP-OLD", "Archived Synthetic Co", True)],
                     OTHER_ORG: [Supplier(FOREIGN, "SUP-X", "Other Tenant Co", False)]}
        self.rows = []
        start = datetime(2026, 4, 1, 8, tzinfo=timezone.utc)
        for i, days in enumerate([6, 7, 6, 7, 6]):
            self.add(ORG, STEADY, i, start + timedelta(days=7 * i), days,
                     expected=(start + timedelta(days=7 * i + 6)).date())
        for i, days in enumerate([2, 15, 4, 20, -1]):
            self.add(ORG, ERRATIC, 10 + i, start + timedelta(days=7 * i), days)
        self.add(OTHER_ORG, FOREIGN, 99, start, 3)
        self.positions = {
            ORG: [StockPosition(SKU_LOW, "SKU-LOW", WH, "WH-MAIN", STEADY, False, 10, 0),
                  StockPosition(SKU_FULL, "SKU-FULL", WH, "WH-MAIN", STEADY, False, 500, 0),
                  StockPosition(SKU_NEW, "SKU-NEW", WH, "WH-MAIN", NEW, False, 0, 0),
                  StockPosition(SKU_ORPHAN, "SKU-ORPHAN", WH, "WH-MAIN", None, False, 0, 0)],
            OTHER_ORG: [StockPosition(SKU_FOREIGN, "SKU-X", WH, "WH-X", FOREIGN, False, 0, 0)],
        }
        self.issues = {(org, sku): {date(2026, 6, day): 4 for day in range(1, 31)}
                       for org, sku in [(ORG, SKU_LOW), (ORG, SKU_FULL), (ORG, SKU_NEW),
                                        (OTHER_ORG, SKU_FOREIGN)]}
        self.issue_calls = []

    def add(self, org, supplier, n, approved, days, expected=None):
        self.rows.append((org, OrderDelivery(f"po-{n}", f"PO-{n:06d}", supplier, approved,
                                             approved + timedelta(days=days), expected)))

    def organization_exists(self, organization_id):
        return organization_id in self.orgs

    def stock_positions(self, organization_id):
        return list(self.positions.get(organization_id, []))

    def daily_issues(self, organization_id, occurred_from, occurred_to):
        self.issue_calls.append((organization_id, occurred_from, occurred_to))
        return {(sku, WH): days for (org, sku), days in self.issues.items()
                if org == organization_id}

    def suppliers(self, organization_id):
        return list(self.orgs.get(organization_id, []))

    def deliveries(self, organization_id, received_from, received_to, supplier_id=None):
        self.calls.append((organization_id, received_from, received_to, supplier_id))
        return [d for org, d in self.rows
                if org == organization_id and received_from <= d.first_received_at <= received_to
                and (supplier_id is None or d.supplier_id == supplier_id)]


@pytest.fixture
def source():
    return FakeSource()


@pytest.fixture
def client(source):
    return TestClient(create_app(Settings(database_url=None, service_token=TOKEN), source))


AUTH = {"authorization": f"Bearer {TOKEN}"}
LIST = f"/v1/organizations/{ORG}/supplier-lead-times"


def test_health_needs_no_token(client):
    assert client.get("/health").json() == {"status": "ok", "configured": True}


@pytest.mark.parametrize("headers", [{}, {"authorization": "Bearer wrong"},
                                     {"authorization": f"Basic {TOKEN}"}])
def test_rejects_missing_or_wrong_token(client, headers):
    res = client.get(LIST, headers=headers)
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "unauthorized"
    assert TOKEN not in res.text


def test_unconfigured_worker_refuses_requests(source):
    client = TestClient(create_app(Settings(database_url=None, service_token=None), source))
    res = client.get(LIST, headers=AUTH)
    assert res.status_code == 503
    assert res.json()["error"]["code"] == "service_unavailable"
    assert client.get("/health").json()["configured"] is False


def test_lists_supplier_lead_times(client):
    res = client.get(LIST, params={"asOf": AS_OF.isoformat(), "windowDays": 180}, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["organizationId"] == ORG
    assert body["window"] == {"from": "2026-01-01T00:00:00Z", "to": "2026-06-30T00:00:00Z", "days": 180}
    by_code = {s["supplierCode"]: s for s in body["suppliers"]}
    # Archived suppliers without history in the window are left out.
    assert list(by_code) == ["SUP-STEADY", "SUP-ERRATIC", "SUP-NEW"]

    steady = by_code["SUP-STEADY"]["leadTime"]
    assert steady == {"sampleCount": 5, "excludedCount": 0, "meanDays": 6.4, "stdDevDays": 0.55,
                      "minDays": 6.0, "maxDays": 7.0, "p50Days": 6.0, "p90Days": 7.0,
                      "coefficientOfVariation": 0.086, "onTimeRate": 0.6, "lateCount": 2,
                      "reliability": "consistent"}
    erratic = by_code["SUP-ERRATIC"]["leadTime"]
    assert erratic["sampleCount"] == 4 and erratic["excludedCount"] == 1
    assert erratic["reliability"] == "erratic"
    assert erratic["onTimeRate"] is None
    assert by_code["SUP-NEW"]["leadTime"]["reliability"] == "insufficient_data"


def test_window_limits_the_samples(client, source):
    res = client.get(LIST, params={"asOf": "2026-04-20T00:00:00Z", "windowDays": 10}, headers=AUTH)
    body = res.json()
    counts = {s["supplierCode"]: s["leadTime"]["sampleCount"] for s in body["suppliers"]}
    assert counts == {"SUP-STEADY": 1, "SUP-ERRATIC": 1, "SUP-NEW": 0}
    org, start, end, supplier = source.calls[-1]
    assert (org, supplier) == (ORG, None)
    assert end - start == timedelta(days=10)


def test_supplier_detail_lists_recent_samples_first(client):
    res = client.get(f"/v1/organizations/{ORG}/suppliers/{STEADY}/lead-time",
                     params={"asOf": AS_OF.isoformat()}, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["supplierName"] == "Steady Synthetic Co"
    assert body["leadTime"]["sampleCount"] == 5
    numbers = [s["orderNumber"] for s in body["samples"]]
    assert numbers == ["PO-000004", "PO-000003", "PO-000002", "PO-000001", "PO-000000"]
    first = body["samples"][-1]
    assert first == {"orderId": "po-0", "orderNumber": "PO-000000",
                     "approvedAt": "2026-04-01T08:00:00Z", "firstReceivedAt": "2026-04-07T08:00:00Z",
                     "leadTimeDays": 6.0, "expectedOn": "2026-04-07", "onTime": True}


def test_other_tenants_supplier_is_not_found(client, source):
    res = client.get(f"/v1/organizations/{ORG}/suppliers/{FOREIGN}/lead-time", headers=AUTH)
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"
    assert all(call[0] == ORG for call in source.calls)


def test_unknown_organization_is_not_found(client):
    res = client.get("/v1/organizations/0d6f1a52-6a0e-4a43-9d2b-1f6a7c1e0999/supplier-lead-times",
                     headers=AUTH)
    assert res.status_code == 404


@pytest.mark.parametrize(("path", "params"), [
    ("/v1/organizations/not-a-uuid/supplier-lead-times", {}),
    (LIST, {"windowDays": 0}),
    (LIST, {"windowDays": 2000}),
    (LIST, {"asOf": "yesterday"}),
    (LIST, {"asOf": "2026-06-30T00:00:00"}),
])
def test_validation_errors_use_the_envelope(client, path, params):
    res = client.get(path, params=params, headers={**AUTH, "x-request-id": "req-12345678"})
    assert res.status_code == 422
    error = res.json()["error"]
    assert error["code"] == "validation_failed"
    assert error["requestId"] == "req-12345678"
    assert res.headers["x-request-id"] == "req-12345678"


def test_unsafe_request_id_is_replaced(client):
    res = client.get("/health", headers={"x-request-id": "bad id\n"})
    assert res.headers["x-request-id"] != "bad id\n"
    assert len(res.headers["x-request-id"]) == 36


def test_unexpected_errors_hide_details(source):
    def boom(*args, **kwargs):
        raise RuntimeError("connection to secret-host failed")

    source.deliveries = boom
    client = TestClient(create_app(Settings(database_url=None, service_token=TOKEN), source),
                        raise_server_exceptions=False)
    res = client.get(LIST, headers=AUTH)
    assert res.status_code == 500
    assert res.json()["error"]["code"] == "internal_error"
    assert "secret-host" not in res.text


def test_short_service_token_is_refused(monkeypatch):
    monkeypatch.setenv("WORKER_SERVICE_TOKEN", "short")
    with pytest.raises(ValueError):
        Settings.from_env()



CALC = "/v1/reorder-calculations"
CALC_BODY = {"dailyDemand": [8, 12] * 7, "leadTime": {"meanDays": 9, "stdDevDays": 0},
             "onHand": 60, "onOrder": 10, "reviewPeriodDays": 7, "minOrderQty": 50,
             "orderMultiple": 24}


def test_reorder_calculation_returns_quantity_and_evidence(client):
    res = client.post(CALC, json=CALC_BODY, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    # d = 10, L = 9, R = 7, SS = 11 -> ROP 101, order-up-to 171, position 70, raw 101 -> 5 packs
    assert body["reorderPoint"] == 101
    assert body["safetyStock"] == 11
    assert body["orderUpTo"] == 171
    assert body["inventoryPosition"] == 70
    assert body["shouldReorder"] is True
    assert body["suggestedOrderQty"] == 120
    assert body["daysOfCover"] == 6.0
    assert body["warnings"] == []
    evidence = body["evidence"]
    assert evidence["meanDailyDemand"] == 10
    assert evidence["z"] == 1.6449
    assert evidence["leadTimeDemand"] == 90
    assert evidence["rawOrderQty"] == 101
    assert evidence["leadTimeSource"] == "observed"


def test_reorder_calculation_needs_the_token_but_no_database():
    client = TestClient(create_app(Settings(database_url=None, service_token=TOKEN), None))
    assert client.post(CALC, json=CALC_BODY).status_code == 401
    assert client.post(CALC, json=CALC_BODY, headers=AUTH).status_code == 200
    # Lead-time routes still need the database.
    assert client.get(LIST, headers=AUTH).status_code == 503


@pytest.mark.parametrize(("patch", "field"), [
    ({"serviceLevel": 1.0}, "serviceLevel"),
    ({"reviewPeriodDays": 120}, "reviewPeriodDays"),
    ({"leadTime": {"meanDays": 500}}, "leadTime.meanDays"),
    ({"dailyDemand": [1, -2]}, "dailyDemand"),
    ({"dailyDemand": []}, "dailyDemand"),
    ({"onHand": -1}, "onHand"),
    ({"orderMultiple": 0}, "orderMultiple"),
    ({"leadTime": {"meanDays": 5, "source": "guess"}}, "leadTime.source"),
    ({"unexpected": True}, "unexpected"),
])
def test_reorder_calculation_validation(client, patch, field):
    res = client.post(CALC, json={**CALC_BODY, **patch}, headers=AUTH)
    assert res.status_code == 422
    error = res.json()["error"]
    assert error["code"] == "validation_failed"
    assert any(d["field"].startswith(field) for d in error["details"])


CANDIDATES = f"/v1/organizations/{ORG}/reorder-candidates"
RUN = {"asOf": "2026-06-30T18:00:00Z", "demandWindowDays": 30}


def test_reorder_candidates_need_the_token(client):
    assert client.post(CANDIDATES, json=RUN).status_code == 401


def test_reorder_candidates_list_low_stock_with_evidence(client, source):
    res = client.post(CANDIDATES, json=RUN, headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["organizationId"] == ORG
    assert body["asOf"] == "2026-06-30T18:00:00Z"
    assert body["parameters"] == {
        "demandWindowDays": 30, "demandFrom": "2026-06-01T00:00:00Z",
        "leadTimeWindowDays": 365, "leadTimeFrom": "2025-06-30T18:00:00Z",
        "serviceLevel": 0.95, "reviewPeriodDays": 7.0,
    }
    # Demand is read for whole UTC days, up to the run time.
    assert source.issue_calls[-1] == (ORG, datetime(2026, 6, 1, tzinfo=timezone.utc),
                                      datetime(2026, 6, 30, 18, tzinfo=timezone.utc))

    [candidate] = body["candidates"]
    assert candidate["skuId"] == SKU_LOW and candidate["supplierId"] == STEADY
    assert (candidate["onHand"], candidate["onOrder"]) == (10, 0)
    assert candidate["leadTime"]["sampleCount"] == 5
    calc = candidate["calculation"]
    assert calc["shouldReorder"] is True
    assert calc["evidence"]["meanDailyDemand"] == 4.0
    assert calc["evidence"]["leadTimeDays"] == 6.4
    assert calc["suggestedOrderQty"] == calc["orderUpTo"] - 10
    assert len(candidate["digest"]) == 64

    reasons = {s["skuCode"]: s["reason"] for s in body["skipped"]}
    assert reasons == {"SKU-FULL": "above_reorder_point", "SKU-NEW": "no_lead_time_history",
                       "SKU-ORPHAN": "no_preferred_supplier"}
    assert SKU_FOREIGN not in res.text


def test_digest_ignores_the_run_time_but_follows_the_facts(client, source):
    first = client.post(CANDIDATES, json=RUN, headers=AUTH).json()["candidates"][0]["digest"]
    later = {**RUN, "asOf": "2026-06-30T23:00:00Z"}
    assert client.post(CANDIDATES, json=later, headers=AUTH).json()["candidates"][0]["digest"] == first

    source.positions[ORG][0] = StockPosition(SKU_LOW, "SKU-LOW", WH, "WH-MAIN", STEADY, False, 9, 0)
    changed = client.post(CANDIDATES, json=RUN, headers=AUTH).json()["candidates"][0]
    assert changed["onHand"] == 9 and changed["digest"] != first


@pytest.mark.parametrize("body, field", [
    ({"serviceLevel": 0.4}, "serviceLevel"),
    ({"demandWindowDays": 7}, "demandWindowDays"),
    ({"reviewPeriodDays": 91}, "reviewPeriodDays"),
    ({"leadTimeWindowDays": 0}, "leadTimeWindowDays"),
    ({"skuIds": []}, "skuIds"),
])
def test_reorder_candidates_validate_the_settings(client, body, field):
    res = client.post(CANDIDATES, json=body, headers=AUTH)
    assert res.status_code == 422
    assert [d["field"] for d in res.json()["error"]["details"]] == [field]


def test_reorder_candidates_need_an_offset_and_a_known_organization(client):
    res = client.post(CANDIDATES, json={"asOf": "2026-06-30T18:00:00"}, headers=AUTH)
    assert res.status_code == 422
    unknown = "0d6f1a52-6a0e-4a43-9d2b-1f6a7c1e0099"
    res = client.post(f"/v1/organizations/{unknown}/reorder-candidates", json=RUN, headers=AUTH)
    assert res.status_code == 404
