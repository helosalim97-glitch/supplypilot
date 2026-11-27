"""Reorder-point calculator.

Classic continuous-review model with uncertain demand and uncertain lead time:

    safety stock  = z * sqrt(L * sd_d^2 + d^2 * sd_L^2)
    reorder point = d * L + safety stock
    order-up-to   = d * (L + R) + safety stock

where d / sd_d are the mean and sample standard deviation of daily demand,
L / sd_L the mean and standard deviation of the supplier's lead time in days,
R the review period in days and z the standard normal quantile for the target
cycle service level.

When the inventory position (on hand + on order) is at or below the reorder
point, the suggested quantity tops the position up to the order-up-to level,
then rounds up to the supplier's order multiple and minimum order quantity.

Everything here is pure and deterministic. Every intermediate value is returned
as evidence so a reviewer can redo the arithmetic by hand.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from statistics import NormalDist

MIN_SERVICE_LEVEL = 0.5
MAX_SERVICE_LEVEL = 0.999
# Fewer days of history than this and the demand spread is a guess.
MIN_DEMAND_DAYS = 14
MAX_DEMAND_DAYS = 1095
MAX_REVIEW_DAYS = 90
MAX_LEAD_TIME_DAYS = 365


class ReorderInputError(ValueError):
    """Raised for inputs the calculator can't work with. `field` names the culprit."""

    def __init__(self, field_name: str, message: str) -> None:
        super().__init__(f"{field_name}: {message}")
        self.field = field_name
        self.message = message


@dataclass(frozen=True)
class LeadTime:
    """Lead time in days. `std_dev_days` is 0 when only a nominal value is known."""

    mean_days: float
    std_dev_days: float = 0.0
    # Where the numbers came from: "observed" (supplier history) or "nominal".
    source: str = "observed"


@dataclass(frozen=True)
class ReorderInput:
    # Units issued per day, oldest first, zero-demand days included.
    daily_demand: Sequence[float]
    lead_time: LeadTime
    on_hand: int
    on_order: int = 0
    service_level: float = 0.95
    review_period_days: float = 0.0
    min_order_qty: int = 1
    order_multiple: int = 1


@dataclass(frozen=True)
class ReorderResult:
    demand_days: int
    mean_daily_demand: float
    demand_std_dev: float
    lead_time_days: float
    lead_time_std_dev: float
    lead_time_source: str
    service_level: float
    z: float
    lead_time_demand: float
    # sqrt(L * sd_d^2 + d^2 * sd_L^2): std dev of demand over the lead time.
    lead_time_demand_std_dev: float
    safety_stock: int
    reorder_point: int
    order_up_to: int
    inventory_position: int
    should_reorder: bool
    # Before rounding to the order multiple and minimum order quantity.
    raw_order_qty: int
    suggested_order_qty: int
    days_of_cover: float | None
    warnings: tuple[str, ...] = field(default_factory=tuple)


def z_for(service_level: float) -> float:
    """Standard normal quantile for a cycle service level (0.95 -> 1.6449)."""
    _check_service_level(service_level)
    return NormalDist().inv_cdf(service_level)


def demand_stats(daily_demand: Sequence[float]) -> tuple[float, float]:
    """Mean and sample standard deviation (n - 1) of daily demand."""
    n = len(daily_demand)
    if n == 0:
        raise ReorderInputError("dailyDemand", "needs at least one day")
    for value in daily_demand:
        if not math.isfinite(value) or value < 0:
            raise ReorderInputError("dailyDemand", "values must be finite and not negative")
    mean = math.fsum(daily_demand) / n
    if n < 2:
        return mean, 0.0
    variance = math.fsum((v - mean) ** 2 for v in daily_demand) / (n - 1)
    return mean, math.sqrt(variance)


def round_order_qty(raw: int, min_order_qty: int, order_multiple: int) -> int:
    """Rounds a positive need up to the order multiple, then up to the minimum order quantity.

    The minimum is itself rounded up to the multiple, so the result is always a
    whole number of packs.
    """
    if raw <= 0:
        return 0
    qty = _ceil_to_multiple(raw, order_multiple)
    return max(qty, _ceil_to_multiple(min_order_qty, order_multiple))


def calculate(data: ReorderInput) -> ReorderResult:
    _validate(data)
    warnings: list[str] = []
    days = len(data.daily_demand)
    if days < MIN_DEMAND_DAYS:
        warnings.append("short_demand_history")
    if data.lead_time.source != "observed":
        warnings.append("nominal_lead_time")

    d, sd_d = demand_stats(data.daily_demand)
    if d == 0:
        warnings.append("no_demand")
    lead, sd_lead = data.lead_time.mean_days, data.lead_time.std_dev_days
    z = z_for(data.service_level)

    lead_time_demand = d * lead
    sigma = math.sqrt(lead * sd_d ** 2 + d ** 2 * sd_lead ** 2)
    # Rounded up: a fractional unit of cover still needs a whole unit on the shelf.
    # The tiny tolerance keeps 12.000000000001 from becoming 13.
    safety_stock = _ceil(max(z * sigma, 0.0))
    reorder_point = _ceil(lead_time_demand) + safety_stock
    order_up_to = _ceil(d * (lead + data.review_period_days)) + safety_stock

    position = data.on_hand + data.on_order
    should_reorder = d > 0 and position <= reorder_point
    raw_qty = max(order_up_to - position, 0) if should_reorder else 0
    suggested = round_order_qty(raw_qty, data.min_order_qty, data.order_multiple)
    if should_reorder and raw_qty == 0:
        # Position sits exactly on the order-up-to level: nothing to top up.
        should_reorder = False
    if data.on_hand <= 0:
        warnings.append("out_of_stock")

    return ReorderResult(
        demand_days=days,
        mean_daily_demand=d,
        demand_std_dev=sd_d,
        lead_time_days=lead,
        lead_time_std_dev=sd_lead,
        lead_time_source=data.lead_time.source,
        service_level=data.service_level,
        z=z,
        lead_time_demand=lead_time_demand,
        lead_time_demand_std_dev=sigma,
        safety_stock=safety_stock,
        reorder_point=reorder_point,
        order_up_to=order_up_to,
        inventory_position=position,
        should_reorder=should_reorder,
        raw_order_qty=raw_qty,
        suggested_order_qty=suggested,
        days_of_cover=data.on_hand / d if d > 0 else None,
        warnings=tuple(warnings),
    )


def _validate(data: ReorderInput) -> None:
    if len(data.daily_demand) > MAX_DEMAND_DAYS:
        raise ReorderInputError("dailyDemand", f"at most {MAX_DEMAND_DAYS} days")
    _check_service_level(data.service_level)
    lead = data.lead_time
    if not math.isfinite(lead.mean_days) or not 0 <= lead.mean_days <= MAX_LEAD_TIME_DAYS:
        raise ReorderInputError("leadTime.meanDays", f"must be between 0 and {MAX_LEAD_TIME_DAYS}")
    if not math.isfinite(lead.std_dev_days) or not 0 <= lead.std_dev_days <= MAX_LEAD_TIME_DAYS:
        raise ReorderInputError("leadTime.stdDevDays",
                                f"must be between 0 and {MAX_LEAD_TIME_DAYS}")
    if lead.source not in ("observed", "nominal"):
        raise ReorderInputError("leadTime.source", "must be observed or nominal")
    if (not math.isfinite(data.review_period_days)
            or not 0 <= data.review_period_days <= MAX_REVIEW_DAYS):
        raise ReorderInputError("reviewPeriodDays", f"must be between 0 and {MAX_REVIEW_DAYS}")
    if data.on_hand < 0:
        raise ReorderInputError("onHand", "must not be negative")
    if data.on_order < 0:
        raise ReorderInputError("onOrder", "must not be negative")
    if data.min_order_qty < 1:
        raise ReorderInputError("minOrderQty", "must be at least 1")
    if data.order_multiple < 1:
        raise ReorderInputError("orderMultiple", "must be at least 1")


def _check_service_level(level: float) -> None:
    if not math.isfinite(level) or not MIN_SERVICE_LEVEL <= level <= MAX_SERVICE_LEVEL:
        raise ReorderInputError("serviceLevel",
                                f"must be between {MIN_SERVICE_LEVEL} and {MAX_SERVICE_LEVEL}")


def _ceil(value: float) -> int:
    return math.ceil(value - 1e-9)


def _ceil_to_multiple(value: int, multiple: int) -> int:
    return -(-value // multiple) * multiple
