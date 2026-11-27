"""Reorder candidates: which SKU at which warehouse should be reordered now.

For every stocked SKU/warehouse pair this module builds the calculator inputs
from facts read elsewhere (current stock, open purchase orders, daily issues,
the preferred supplier's observed lead time), runs the reorder-point
calculator and sorts the pair into a candidate or a skipped entry with a
reason. Nothing is written: the API turns candidates into reorder proposals,
and a person decides on each one.

Everything here is pure and deterministic.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta

from .lead_times import LeadTimeStats
from .reorder import LeadTime, ReorderInput, ReorderResult, calculate

MIN_DEMAND_WINDOW_DAYS = 14
MAX_DEMAND_WINDOW_DAYS = 365

# Why a pair produced no candidate.
NO_PREFERRED_SUPPLIER = "no_preferred_supplier"
SUPPLIER_ARCHIVED = "supplier_archived"
NO_LEAD_TIME_HISTORY = "no_lead_time_history"
NO_DEMAND = "no_demand"
ABOVE_REORDER_POINT = "above_reorder_point"


@dataclass(frozen=True)
class StockPosition:
    """Current stock of one active SKU at one active warehouse."""

    sku_id: str
    sku_code: str
    warehouse_id: str
    warehouse_code: str
    supplier_id: str | None
    supplier_archived: bool
    on_hand: int
    # Units still outstanding on open purchase orders (draft to partially received).
    on_order: int


@dataclass(frozen=True)
class CandidateParams:
    demand_window_days: int
    service_level: float = 0.95
    review_period_days: float = 7.0


@dataclass(frozen=True)
class Candidate:
    position: StockPosition
    lead_time: LeadTimeStats
    result: ReorderResult


@dataclass(frozen=True)
class Skipped:
    position: StockPosition
    reason: str


def demand_series(issued_by_day: Mapping[date, int], last_day: date, days: int) -> list[float]:
    """Units issued per day for the `days` days ending on `last_day`, oldest first.

    Days without issues count as zero demand, so quiet days lower the mean and
    widen the spread as they should.
    """
    first_day = last_day - timedelta(days=days - 1)
    return [float(issued_by_day.get(first_day + timedelta(days=i), 0)) for i in range(days)]


def plan_candidates(
    positions: Iterable[StockPosition],
    issues: Mapping[tuple[str, str], Mapping[date, int]],
    lead_times: Mapping[str, LeadTimeStats],
    params: CandidateParams,
    last_day: date,
) -> tuple[list[Candidate], list[Skipped]]:
    """Splits the positions into reorder candidates and skipped pairs.

    `issues` maps (sku id, warehouse id) to units issued per UTC day;
    `lead_times` maps supplier id to its observed lead-time statistics.
    """
    if not MIN_DEMAND_WINDOW_DAYS <= params.demand_window_days <= MAX_DEMAND_WINDOW_DAYS:
        raise ValueError("demand_window_days is out of range")

    candidates: list[Candidate] = []
    skipped: list[Skipped] = []
    for position in positions:
        if position.supplier_id is None:
            skipped.append(Skipped(position, NO_PREFERRED_SUPPLIER))
            continue
        if position.supplier_archived:
            skipped.append(Skipped(position, SUPPLIER_ARCHIVED))
            continue
        stats = lead_times.get(position.supplier_id)
        if stats is None or stats.sample_count == 0 or stats.mean_days is None:
            skipped.append(Skipped(position, NO_LEAD_TIME_HISTORY))
            continue

        demand = demand_series(issues.get((position.sku_id, position.warehouse_id), {}),
                               last_day, params.demand_window_days)
        result = calculate(ReorderInput(
            daily_demand=demand,
            lead_time=LeadTime(stats.mean_days, stats.std_dev_days or 0.0, "observed"),
            on_hand=position.on_hand,
            on_order=position.on_order,
            service_level=params.service_level,
            review_period_days=params.review_period_days,
        ))
        if result.mean_daily_demand == 0:
            skipped.append(Skipped(position, NO_DEMAND))
        elif not result.should_reorder:
            skipped.append(Skipped(position, ABOVE_REORDER_POINT))
        else:
            candidates.append(Candidate(position, stats, result))
    return candidates, skipped
