from datetime import date

import pytest

from supplypilot_worker.lead_times import summarize
from supplypilot_worker.proposals import (ABOVE_REORDER_POINT, NO_DEMAND, NO_LEAD_TIME_HISTORY,
                                          NO_PREFERRED_SUPPLIER, SUPPLIER_ARCHIVED,
                                          CandidateParams, StockPosition, demand_series,
                                          plan_candidates)

LAST_DAY = date(2026, 6, 30)
PARAMS = CandidateParams(demand_window_days=30, service_level=0.95, review_period_days=7)
SUPPLIER = "sup-steady"
STATS = {SUPPLIER: summarize([6, 7, 6, 7, 6])}


def position(sku="sku-1", warehouse="wh-1", supplier=SUPPLIER, archived=False, on_hand=10,
             on_order=0):
    return StockPosition(sku_id=sku, sku_code=sku.upper(), warehouse_id=warehouse,
                         warehouse_code=warehouse.upper(), supplier_id=supplier,
                         supplier_archived=archived, on_hand=on_hand, on_order=on_order)


def steady_issues(units=4):
    return {date(2026, 6, day): units for day in range(1, 31)}


def test_demand_series_fills_quiet_days_with_zero():
    series = demand_series({date(2026, 6, 28): 5, date(2026, 6, 30): 2, date(2026, 5, 1): 99},
                           LAST_DAY, 4)
    # 27th, 28th, 29th, 30th; the May issue is outside the window.
    assert series == [0.0, 5.0, 0.0, 2.0]


def test_low_stock_becomes_a_candidate_with_the_calculator_result():
    issues = {("sku-1", "wh-1"): steady_issues()}
    candidates, skipped = plan_candidates([position(on_hand=10)], issues, STATS, PARAMS, LAST_DAY)
    assert skipped == []
    [candidate] = candidates
    result = candidate.result
    # 4 units a day, no spread in demand; lead time 6.4 ± 0.55 days.
    assert result.mean_daily_demand == 4 and result.demand_std_dev == 0
    assert result.demand_days == 30
    assert result.reorder_point == 26 + result.safety_stock
    assert result.inventory_position == 10
    assert result.suggested_order_qty == result.order_up_to - 10
    assert candidate.lead_time.sample_count == 5


def test_open_orders_count_towards_the_position():
    issues = {("sku-1", "wh-1"): steady_issues()}
    candidates, skipped = plan_candidates([position(on_hand=10, on_order=200)], issues, STATS,
                                          PARAMS, LAST_DAY)
    assert candidates == []
    assert [s.reason for s in skipped] == [ABOVE_REORDER_POINT]


@pytest.mark.parametrize("pos, stats, reason", [
    (position(supplier=None), STATS, NO_PREFERRED_SUPPLIER),
    (position(archived=True), STATS, SUPPLIER_ARCHIVED),
    (position(), {}, NO_LEAD_TIME_HISTORY),
    (position(), {SUPPLIER: summarize([])}, NO_LEAD_TIME_HISTORY),
    (position(sku="sku-quiet", on_hand=0), STATS, NO_DEMAND),
])
def test_pairs_that_cannot_or_need_not_be_reordered_are_skipped(pos, stats, reason):
    issues = {("sku-1", "wh-1"): steady_issues()}
    candidates, skipped = plan_candidates([pos], issues, stats, PARAMS, LAST_DAY)
    assert candidates == []
    assert [(s.position, s.reason) for s in skipped] == [(pos, reason)]


def test_demand_is_kept_per_warehouse():
    issues = {("sku-1", "wh-1"): steady_issues()}
    candidates, skipped = plan_candidates(
        [position(warehouse="wh-1", on_hand=0), position(warehouse="wh-2", on_hand=0)],
        issues, STATS, PARAMS, LAST_DAY)
    assert [c.position.warehouse_id for c in candidates] == ["wh-1"]
    assert [(s.position.warehouse_id, s.reason) for s in skipped] == [("wh-2", NO_DEMAND)]


def test_single_lead_time_sample_is_used_without_spread():
    issues = {("sku-1", "wh-1"): steady_issues()}
    stats = {SUPPLIER: summarize([5])}
    [candidate], _ = plan_candidates([position(on_hand=0)], issues, stats, PARAMS, LAST_DAY)
    assert candidate.result.lead_time_days == 5
    assert candidate.result.lead_time_std_dev == 0
    assert candidate.result.safety_stock == 0


def test_rejects_demand_windows_out_of_range():
    with pytest.raises(ValueError):
        plan_candidates([], {}, {}, CandidateParams(demand_window_days=7), LAST_DAY)
