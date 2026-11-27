"""Supplier lead-time statistics.

A lead-time sample is one purchase order: the time from its approval to the
first delivery recorded against it. Later deliveries of a partial order don't
add samples, because they say more about how the order was split than about
how long the supplier takes to ship.

Everything here is pure and deterministic, so the reorder-point calculator and
the tests can use it without a database.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timezone

SECONDS_PER_DAY = 86_400

# Fewer samples than this and the spread isn't meaningful yet.
MIN_SAMPLES = 3
# Coefficient of variation (std dev / mean) limits for the reliability label.
CONSISTENT_MAX_CV = 0.25
VARIABLE_MAX_CV = 0.5


@dataclass(frozen=True)
class OrderDelivery:
    """One approved purchase order and its first recorded delivery."""

    order_id: str
    order_number: str
    supplier_id: str
    approved_at: datetime
    first_received_at: datetime
    expected_on: date | None = None


@dataclass(frozen=True)
class LeadTimeSample:
    order_id: str
    order_number: str
    approved_at: datetime
    first_received_at: datetime
    lead_time_days: float
    expected_on: date | None
    # None when the order had no expected date.
    on_time: bool | None


@dataclass(frozen=True)
class LeadTimeStats:
    sample_count: int
    # Deliveries recorded before the order's approval (backdated receipts).
    # They can't be real lead times, so they are left out and counted here.
    excluded_count: int
    mean_days: float | None
    std_dev_days: float | None
    min_days: float | None
    max_days: float | None
    p50_days: float | None
    p90_days: float | None
    coefficient_of_variation: float | None
    on_time_rate: float | None
    late_count: int
    reliability: str


def to_sample(delivery: OrderDelivery) -> LeadTimeSample | None:
    """Turns a delivery into a sample, or None if it was received before approval."""
    approved = _aware(delivery.approved_at)
    received = _aware(delivery.first_received_at)
    seconds = (received - approved).total_seconds()
    if seconds < 0:
        return None
    on_time = None
    if delivery.expected_on is not None:
        # Delivery dates are compared in UTC; warehouses have no time zone yet.
        on_time = received.astimezone(timezone.utc).date() <= delivery.expected_on
    return LeadTimeSample(
        order_id=delivery.order_id,
        order_number=delivery.order_number,
        approved_at=approved,
        first_received_at=received,
        lead_time_days=seconds / SECONDS_PER_DAY,
        expected_on=delivery.expected_on,
        on_time=on_time,
    )


def build_samples(deliveries: Iterable[OrderDelivery]) -> tuple[list[LeadTimeSample], int]:
    """Returns the valid samples, oldest delivery first, and how many were excluded."""
    samples: list[LeadTimeSample] = []
    excluded = 0
    for delivery in deliveries:
        sample = to_sample(delivery)
        if sample is None:
            excluded += 1
        else:
            samples.append(sample)
    samples.sort(key=lambda s: (s.first_received_at, s.order_number))
    return samples, excluded


def percentile(sorted_values: Sequence[float], fraction: float) -> float:
    """Linear interpolation between closest ranks (numpy's default, Excel PERCENTILE.INC)."""
    if not sorted_values:
        raise ValueError("percentile of an empty sequence")
    if not 0 <= fraction <= 1:
        raise ValueError("fraction must be between 0 and 1")
    position = (len(sorted_values) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(sorted_values[lower])
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def classify(sample_count: int, cv: float | None) -> str:
    if sample_count < MIN_SAMPLES or cv is None:
        return "insufficient_data"
    if cv <= CONSISTENT_MAX_CV:
        return "consistent"
    if cv <= VARIABLE_MAX_CV:
        return "variable"
    return "erratic"


def summarize(days: Sequence[float], *, excluded_count: int = 0,
              on_time: Sequence[bool | None] = ()) -> LeadTimeStats:
    """Summary statistics for a list of lead times in days.

    The standard deviation is the sample standard deviation (n - 1), because the
    deliveries are a sample of how the supplier performs, not the whole story.
    """
    for value in days:
        if not math.isfinite(value) or value < 0:
            raise ValueError("lead times must be finite and not negative")
    known = [flag for flag in on_time if flag is not None]
    on_time_rate = sum(known) / len(known) if known else None
    late_count = sum(1 for flag in known if not flag)

    n = len(days)
    if n == 0:
        return LeadTimeStats(0, excluded_count, None, None, None, None, None, None, None,
                             on_time_rate, late_count, classify(0, None))

    ordered = sorted(days)
    mean = math.fsum(ordered) / n
    std_dev = None
    if n >= 2:
        std_dev = math.sqrt(math.fsum((v - mean) ** 2 for v in ordered) / (n - 1))
    cv = std_dev / mean if std_dev is not None and mean > 0 else None
    return LeadTimeStats(
        sample_count=n,
        excluded_count=excluded_count,
        mean_days=mean,
        std_dev_days=std_dev,
        min_days=ordered[0],
        max_days=ordered[-1],
        p50_days=percentile(ordered, 0.5),
        p90_days=percentile(ordered, 0.9),
        coefficient_of_variation=cv,
        on_time_rate=on_time_rate,
        late_count=late_count,
        reliability=classify(n, cv),
    )


def summarize_samples(samples: Sequence[LeadTimeSample], excluded_count: int = 0) -> LeadTimeStats:
    return summarize([s.lead_time_days for s in samples], excluded_count=excluded_count,
                     on_time=[s.on_time for s in samples])


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("timestamps must carry a time zone")
    return value
