import math

import pytest

from supplypilot_worker.reorder import (
    LeadTime,
    ReorderInput,
    ReorderInputError,
    calculate,
    demand_stats,
    round_order_qty,
    z_for,
)

# 14 days, mean 10, sample std dev 2 (alternating 8 and 12, n - 1 = 13).
STEADY_14 = [8, 12] * 7


def make(**overrides):
    values = dict(daily_demand=STEADY_14, lead_time=LeadTime(9, 0), on_hand=200)
    values.update(overrides)
    return ReorderInput(**values)


def test_z_values_match_tables():
    assert z_for(0.5) == pytest.approx(0, abs=1e-12)
    assert z_for(0.9) == pytest.approx(1.2816, abs=1e-4)
    assert z_for(0.95) == pytest.approx(1.6449, abs=1e-4)
    assert z_for(0.99) == pytest.approx(2.3263, abs=1e-4)


@pytest.mark.parametrize("level", [0.49, 1.0, 0.9991, float("nan")])
def test_z_rejects_out_of_range_service_levels(level):
    with pytest.raises(ReorderInputError) as err:
        z_for(level)
    assert err.value.field == "serviceLevel"


def test_demand_stats_uses_sample_std_dev():
    mean, sd = demand_stats(STEADY_14)
    assert mean == 10
    assert sd == pytest.approx(math.sqrt(4 * 14 / 13))
    assert demand_stats([5]) == (5, 0)


@pytest.mark.parametrize("bad", [[], [1, -1], [1, float("inf")]])
def test_demand_stats_rejects_bad_series(bad):
    with pytest.raises(ReorderInputError):
        demand_stats(bad)


def test_hand_worked_example_demand_uncertainty_only():
    # d = 10, sd_d = 2.0755, L = 9, sd_L = 0, z(0.95) = 1.6449
    # sigma = sqrt(9 * 2.0755^2) = 6.2264, SS = ceil(10.2418) = 11, ROP = 90 + 11 = 101
    result = calculate(make(on_hand=100))
    assert result.lead_time_demand == 90
    assert result.lead_time_demand_std_dev == pytest.approx(3 * math.sqrt(56 / 13))
    assert result.safety_stock == 11
    assert result.reorder_point == 101
    assert result.order_up_to == 101
    assert result.should_reorder is True
    assert result.raw_order_qty == 1
    assert result.suggested_order_qty == 1
    assert result.days_of_cover == 10


def test_lead_time_uncertainty_dominates():
    # Constant demand of 10/day, L = 9 +- 3 days: sigma = 10 * 3 = 30, SS = ceil(49.35) = 50.
    result = calculate(make(daily_demand=[10] * 30, lead_time=LeadTime(9, 3), on_hand=500))
    assert result.demand_std_dev == 0
    assert result.lead_time_demand_std_dev == pytest.approx(30)
    assert result.safety_stock == 50
    assert result.reorder_point == 140
    assert result.should_reorder is False
    assert result.suggested_order_qty == 0


def test_more_variable_supplier_needs_more_safety_stock():
    steady = calculate(make(lead_time=LeadTime(9, 0.5)))
    erratic = calculate(make(lead_time=LeadTime(9, 6)))
    assert erratic.safety_stock > steady.safety_stock
    assert erratic.reorder_point > steady.reorder_point


def test_higher_service_level_never_lowers_the_reorder_point():
    points = [calculate(make(service_level=level)).reorder_point
              for level in (0.5, 0.8, 0.9, 0.95, 0.99, 0.999)]
    assert points == sorted(points)
    assert calculate(make(service_level=0.5)).safety_stock == 0


def test_review_period_raises_the_order_up_to_level_only():
    base = calculate(make(on_hand=50))
    weekly = calculate(make(on_hand=50, review_period_days=7))
    assert weekly.reorder_point == base.reorder_point
    assert weekly.order_up_to == base.order_up_to + 70
    assert weekly.raw_order_qty == weekly.order_up_to - 50


def test_open_orders_count_towards_the_position():
    result = calculate(make(on_hand=40, on_order=80, review_period_days=7))
    assert result.inventory_position == 120
    assert result.should_reorder is False
    short = calculate(make(on_hand=40, on_order=20, review_period_days=7))
    assert short.inventory_position == 60
    assert short.raw_order_qty == short.order_up_to - 60


def test_reorders_exactly_at_the_reorder_point():
    rop = calculate(make()).reorder_point
    at = calculate(make(on_hand=rop, review_period_days=7))
    above = calculate(make(on_hand=rop + 1, review_period_days=7))
    assert at.should_reorder is True
    assert above.should_reorder is False


@pytest.mark.parametrize(("raw", "moq", "multiple", "expected"), [
    (0, 50, 12, 0),
    (-5, 1, 1, 0),
    (1, 1, 1, 1),
    (13, 1, 12, 24),
    (24, 1, 12, 24),
    (5, 50, 1, 50),
    (5, 50, 12, 60),    # MOQ itself rounded up to whole packs
    (70, 50, 12, 72),
])
def test_rounding(raw, moq, multiple, expected):
    assert round_order_qty(raw, moq, multiple) == expected


def test_suggested_quantity_respects_packs_and_minimum():
    result = calculate(make(on_hand=60, review_period_days=7, min_order_qty=100,
                            order_multiple=24))
    assert result.raw_order_qty == result.order_up_to - 60
    assert result.suggested_order_qty % 24 == 0
    assert result.suggested_order_qty >= max(result.raw_order_qty, 100)


def test_no_demand_never_reorders():
    result = calculate(make(daily_demand=[0] * 30, on_hand=0))
    assert result.reorder_point == 0
    assert result.should_reorder is False
    assert result.days_of_cover is None
    assert result.warnings == ("no_demand", "out_of_stock")


def test_warnings_for_thin_evidence():
    result = calculate(make(daily_demand=[3, 4, 5], lead_time=LeadTime(10, 0, "nominal")))
    assert result.warnings == ("short_demand_history", "nominal_lead_time")
    assert calculate(make()).warnings == ()


def test_deterministic_and_order_of_days_irrelevant():
    series = [0, 3, 9, 4, 0, 12, 7, 5, 6, 2, 8, 0, 11, 4, 6]
    a = calculate(make(daily_demand=series, lead_time=LeadTime(6.5, 1.8)))
    b = calculate(make(daily_demand=list(reversed(series)), lead_time=LeadTime(6.5, 1.8)))
    assert a.safety_stock == b.safety_stock and a.reorder_point == b.reorder_point
    assert a == calculate(make(daily_demand=series, lead_time=LeadTime(6.5, 1.8)))


def test_float_noise_does_not_add_a_unit():
    # 0.1 * 3 * 40 = 12.000000000000002 in binary floating point.
    result = calculate(make(daily_demand=[0.3] * 20, lead_time=LeadTime(40, 0), on_hand=500,
                            service_level=0.5))
    assert result.lead_time_demand == pytest.approx(12)
    assert result.reorder_point == 12


@pytest.mark.parametrize(("overrides", "field"), [
    ({"on_hand": -1}, "onHand"),
    ({"on_order": -1}, "onOrder"),
    ({"min_order_qty": 0}, "minOrderQty"),
    ({"order_multiple": 0}, "orderMultiple"),
    ({"review_period_days": -1}, "reviewPeriodDays"),
    ({"review_period_days": 91}, "reviewPeriodDays"),
    ({"lead_time": LeadTime(-1)}, "leadTime.meanDays"),
    ({"lead_time": LeadTime(400)}, "leadTime.meanDays"),
    ({"lead_time": LeadTime(5, float("nan"))}, "leadTime.stdDevDays"),
    ({"lead_time": LeadTime(5, 1, "guess")}, "leadTime.source"),
    ({"daily_demand": [1] * 1096}, "dailyDemand"),
    ({"service_level": 1.0}, "serviceLevel"),
])
def test_rejects_invalid_input(overrides, field):
    with pytest.raises(ReorderInputError) as err:
        calculate(make(**overrides))
    assert err.value.field == field
