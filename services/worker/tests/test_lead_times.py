from datetime import date, datetime, timedelta, timezone

import pytest

from supplypilot_worker.lead_times import (
    OrderDelivery,
    build_samples,
    classify,
    percentile,
    summarize,
    summarize_samples,
    to_sample,
)

T0 = datetime(2026, 3, 2, 9, 0, tzinfo=timezone.utc)


def delivery(n, days, expected_on=None, approved=T0):
    return OrderDelivery(order_id=f"po-{n}", order_number=f"PO-{n:06d}", supplier_id="sup",
                         approved_at=approved, first_received_at=approved + timedelta(days=days),
                         expected_on=expected_on)


def test_known_values():
    stats = summarize([5, 7, 6, 8, 4])
    assert stats.sample_count == 5
    assert stats.mean_days == 6
    assert stats.std_dev_days == pytest.approx(1.5811388, rel=1e-6)  # sample std dev (n - 1)
    assert (stats.min_days, stats.max_days) == (4, 8)
    assert stats.p50_days == 6
    assert stats.p90_days == pytest.approx(7.6)
    assert stats.coefficient_of_variation == pytest.approx(0.2635231, rel=1e-6)
    assert stats.reliability == "variable"


def test_order_does_not_matter():
    assert summarize([3, 9, 4, 12, 5]) == summarize([12, 5, 9, 3, 4])


def test_empty_and_single_sample():
    empty = summarize([])
    assert empty.sample_count == 0 and empty.mean_days is None and empty.reliability == "insufficient_data"
    one = summarize([6.5])
    assert one.mean_days == one.p50_days == one.p90_days == 6.5
    assert one.std_dev_days is None and one.coefficient_of_variation is None
    assert one.reliability == "insufficient_data"


def test_identical_values_are_consistent():
    stats = summarize([7, 7, 7])
    assert stats.std_dev_days == 0 and stats.coefficient_of_variation == 0
    assert stats.reliability == "consistent"


def test_zero_mean_has_no_cv():
    stats = summarize([0, 0, 0])
    assert stats.coefficient_of_variation is None
    assert stats.reliability == "insufficient_data"


@pytest.mark.parametrize("bad", [-1, float("nan"), float("inf")])
def test_rejects_invalid_values(bad):
    with pytest.raises(ValueError):
        summarize([3, bad])


def test_percentile_interpolates():
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    assert percentile([1, 2, 3, 4], 0) == 1
    assert percentile([1, 2, 3, 4], 1) == 4
    assert percentile([10], 0.9) == 10
    with pytest.raises(ValueError):
        percentile([], 0.5)
    with pytest.raises(ValueError):
        percentile([1], 1.5)


@pytest.mark.parametrize(("n", "cv", "label"), [
    (2, 0.1, "insufficient_data"),
    (3, 0.25, "consistent"),
    (3, 0.2501, "variable"),
    (3, 0.5, "variable"),
    (3, 0.5001, "erratic"),
])
def test_classification_boundaries(n, cv, label):
    assert classify(n, cv) == label


def test_sample_uses_fractional_days_and_utc_due_date():
    late_evening = OrderDelivery("po-1", "PO-000001", "sup", T0,
                                 datetime(2026, 3, 5, 23, 30, tzinfo=timezone(timedelta(hours=-5))),
                                 expected_on=date(2026, 3, 5))
    sample = to_sample(late_evening)
    assert sample.lead_time_days == pytest.approx(3 + 19.5 / 24)
    # 23:30 at UTC-5 is already 6 March in UTC, so the delivery is late.
    assert sample.on_time is False


def test_backdated_receipts_are_excluded_and_counted():
    deliveries = [delivery(1, 4), delivery(2, -1), delivery(3, 6), delivery(4, 0)]
    samples, excluded = build_samples(deliveries)
    assert excluded == 1
    assert [s.order_number for s in samples] == ["PO-000004", "PO-000001", "PO-000003"]
    stats = summarize_samples(samples, excluded)
    assert stats.sample_count == 3 and stats.excluded_count == 1


def test_on_time_rate_ignores_orders_without_expected_date():
    due = T0.date() + timedelta(days=5)
    samples, _ = build_samples([delivery(1, 4, due), delivery(2, 5, due), delivery(3, 9, due),
                                delivery(4, 2)])
    stats = summarize_samples(samples)
    assert stats.on_time_rate == pytest.approx(2 / 3)
    assert stats.late_count == 1


def test_naive_timestamps_are_rejected():
    with pytest.raises(ValueError):
        to_sample(OrderDelivery("po", "PO-000001", "sup", datetime(2026, 1, 1),
                                datetime(2026, 1, 5)))


def test_fixture_erratic_supplier_stands_out():
    fixtures = pytest.importorskip("supplypilot_fixtures.generator")
    data = fixtures.generate()
    org_id = data["organizations"][0]["id"]
    suppliers = [s for s in data["suppliers"] if s["organization_id"] == org_id]
    stats = {}
    for supplier in suppliers:
        days = [lt["lead_time_days"] for lt in data["supplier_lead_times"]
                if lt["supplier_id"] == supplier["id"]]
        stats[supplier["id"]] = summarize(days)
    *steady, erratic = suppliers
    assert all(stats[s["id"]].reliability == "consistent" for s in steady)
    assert stats[erratic["id"]].reliability != "consistent"
    assert stats[erratic["id"]].coefficient_of_variation > max(
        stats[s["id"]].coefficient_of_variation for s in steady)
