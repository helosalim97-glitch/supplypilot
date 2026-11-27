"""HTTP interface of the forecasting worker.

The worker is internal: the API calls it with a shared service token and does
the per-user permission checks itself. Errors use the API's envelope,
`{"error": {"code", "message", "details"?, "requestId"}}`.
"""

# No `from __future__ import annotations` here: FastAPI resolves the route
# signatures' Annotated aliases, which are local to create_app().
import hmac
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .lead_times import LeadTimeSample, LeadTimeStats, build_samples, summarize_samples
from .reorder import (MAX_DEMAND_DAYS, LeadTime, ReorderInput, ReorderInputError,
                      ReorderResult, calculate)
from .repository import LeadTimeSource, PostgresLeadTimeSource, Supplier, read_only_connection
from .settings import Settings

logger = logging.getLogger("supplypilot_worker")

REQUEST_ID_HEADER = "x-request-id"
SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,128}$")
DEFAULT_WINDOW_DAYS = 365
MAX_WINDOW_DAYS = 1095
MAX_SAMPLES_RETURNED = 100

HTTP_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
              405: "method_not_allowed", 422: "validation_failed", 503: "service_unavailable"}


class LeadTimeBody(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mean_days: float = Field(alias="meanDays", ge=0)
    std_dev_days: float = Field(0, alias="stdDevDays", ge=0)
    source: str = Field("observed", pattern="^(observed|nominal)$")


class ReorderCalculationBody(BaseModel):
    """Explicit inputs for one SKU at one warehouse; nothing is read from the database."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    daily_demand: list[float] = Field(alias="dailyDemand", min_length=1,
                                      max_length=MAX_DEMAND_DAYS)
    lead_time: LeadTimeBody = Field(alias="leadTime")
    on_hand: int = Field(alias="onHand", ge=0)
    on_order: int = Field(0, alias="onOrder", ge=0)
    service_level: float = Field(0.95, alias="serviceLevel")
    review_period_days: float = Field(0, alias="reviewPeriodDays")
    min_order_qty: int = Field(1, alias="minOrderQty", ge=1)
    order_multiple: int = Field(1, alias="orderMultiple", ge=1)


class WorkerError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _envelope(request: Request, status: int, code: str, message: str,
              details: list | None = None) -> JSONResponse:
    error = {"code": code, "message": message, "requestId": request.state.request_id}
    if details:
        error["details"] = details
    return JSONResponse({"error": error}, status_code=status)


def create_app(settings: Settings | None = None, source: LeadTimeSource | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if source is None and settings.database_url:
        source = PostgresLeadTimeSource(read_only_connection(settings.database_url))

    app = FastAPI(title="SupplyPilot worker", version="0.1.0", docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        incoming = request.headers.get(REQUEST_ID_HEADER)
        request.state.request_id = (incoming if incoming and SAFE_REQUEST_ID.match(incoming)
                                    else str(uuid.uuid4()))
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request.state.request_id
        return response

    @app.exception_handler(WorkerError)
    async def worker_error(request: Request, exc: WorkerError):
        return _envelope(request, exc.status, exc.code, exc.message)

    @app.exception_handler(ReorderInputError)
    async def reorder_input_error(request: Request, exc: ReorderInputError):
        return _envelope(request, 422, "validation_failed", "Request validation failed",
                         [{"field": exc.field, "message": exc.message}])

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]}
                   for e in exc.errors()]
        return _envelope(request, 422, "validation_failed", "Request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException):
        code = HTTP_CODES.get(exc.status_code, "request_error")
        message = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return _envelope(request, exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def unexpected(request: Request, exc: Exception):
        # Logged with the request id; the message never reaches the client.
        logger.error("unhandled error request_id=%s type=%s", request.state.request_id,
                     type(exc).__name__, exc_info=exc)
        return _envelope(request, 500, "internal_error", "Internal server error")

    def require_token(request: Request) -> None:
        if not settings.service_token:
            raise WorkerError(503, "service_unavailable", "Worker is not configured")
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(
                token.strip().encode(), settings.service_token.encode()):
            raise WorkerError(401, "unauthorized", "Missing or invalid service token")

    def require_service(request: Request) -> LeadTimeSource:
        require_token(request)
        if source is None:
            raise WorkerError(503, "service_unavailable", "Worker is not configured")
        return source

    Source = Annotated[LeadTimeSource, Depends(require_service)]
    Token = Annotated[None, Depends(require_token)]
    WindowDays = Annotated[int, Query(alias="windowDays", ge=1, le=MAX_WINDOW_DAYS)]
    AsOf = Annotated[datetime | None, Query(alias="asOf")]

    def window(window_days: int, as_of: datetime | None) -> tuple[datetime, datetime]:
        if as_of is None:
            as_of = datetime.now(timezone.utc)
        elif as_of.tzinfo is None:
            raise WorkerError(422, "validation_failed", "asOf must include a time zone offset")
        return as_of - timedelta(days=window_days), as_of

    def org_or_404(src: LeadTimeSource, organization_id: uuid.UUID) -> str:
        org = str(organization_id)
        if not src.organization_exists(org):
            raise WorkerError(404, "not_found", "Organization not found")
        return org

    @app.get("/health")
    def health():
        return {"status": "ok", "configured": bool(settings.service_token and source)}

    @app.get("/v1/organizations/{organization_id}/supplier-lead-times")
    def supplier_lead_times(organization_id: uuid.UUID, src: Source,
                            window_days: WindowDays = DEFAULT_WINDOW_DAYS, as_of: AsOf = None):
        start, end = window(window_days, as_of)
        org = org_or_404(src, organization_id)
        by_supplier: dict[str, list] = {}
        for delivery in src.deliveries(org, start, end):
            by_supplier.setdefault(delivery.supplier_id, []).append(delivery)

        suppliers = []
        for supplier in src.suppliers(org):
            deliveries = by_supplier.get(supplier.id, [])
            # Archived suppliers stay listed only while they have history in the window.
            if supplier.archived and not deliveries:
                continue
            samples, excluded = build_samples(deliveries)
            suppliers.append({**_supplier_json(supplier),
                              "leadTime": _stats_json(summarize_samples(samples, excluded))})
        return {"organizationId": org, "window": _window_json(start, end, window_days),
                "suppliers": suppliers}

    @app.get("/v1/organizations/{organization_id}/suppliers/{supplier_id}/lead-time")
    def supplier_lead_time(organization_id: uuid.UUID, supplier_id: uuid.UUID, src: Source,
                           window_days: WindowDays = DEFAULT_WINDOW_DAYS, as_of: AsOf = None):
        start, end = window(window_days, as_of)
        org = org_or_404(src, organization_id)
        supplier = next((s for s in src.suppliers(org) if s.id == str(supplier_id)), None)
        if supplier is None:
            raise WorkerError(404, "not_found", "Supplier not found")
        samples, excluded = build_samples(src.deliveries(org, start, end, supplier.id))
        recent = samples[-MAX_SAMPLES_RETURNED:][::-1]
        return {"organizationId": org, "window": _window_json(start, end, window_days),
                **_supplier_json(supplier),
                "leadTime": _stats_json(summarize_samples(samples, excluded)),
                "samples": [_sample_json(s) for s in recent]}

    @app.post("/v1/reorder-calculations")
    def reorder_calculation(body: ReorderCalculationBody, _: Token):
        # Stateless: needs the service token but no database.
        result = calculate(ReorderInput(
            daily_demand=body.daily_demand,
            lead_time=LeadTime(body.lead_time.mean_days, body.lead_time.std_dev_days,
                               body.lead_time.source),
            on_hand=body.on_hand, on_order=body.on_order, service_level=body.service_level,
            review_period_days=body.review_period_days, min_order_qty=body.min_order_qty,
            order_multiple=body.order_multiple))
        return _reorder_json(result)

    return app


def _reorder_json(result: ReorderResult) -> dict:
    return {
        "shouldReorder": result.should_reorder,
        "suggestedOrderQty": result.suggested_order_qty,
        "reorderPoint": result.reorder_point,
        "safetyStock": result.safety_stock,
        "orderUpTo": result.order_up_to,
        "inventoryPosition": result.inventory_position,
        "daysOfCover": _round(result.days_of_cover, 1),
        "warnings": list(result.warnings),
        "evidence": {
            "demandDays": result.demand_days,
            "meanDailyDemand": _round(result.mean_daily_demand, 3),
            "demandStdDev": _round(result.demand_std_dev, 3),
            "leadTimeDays": _round(result.lead_time_days),
            "leadTimeStdDev": _round(result.lead_time_std_dev),
            "leadTimeSource": result.lead_time_source,
            "serviceLevel": result.service_level,
            "z": _round(result.z, 4),
            "leadTimeDemand": _round(result.lead_time_demand),
            "leadTimeDemandStdDev": _round(result.lead_time_demand_std_dev, 3),
            "rawOrderQty": result.raw_order_qty,
        },
    }


def _round(value: float | None, digits: int = 2) -> float | None:
    return None if value is None else round(value, digits)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _window_json(start: datetime, end: datetime, days: int) -> dict:
    return {"from": _iso(start), "to": _iso(end), "days": days}


def _supplier_json(supplier: Supplier) -> dict:
    return {"supplierId": supplier.id, "supplierCode": supplier.code,
            "supplierName": supplier.name, "archived": supplier.archived}


def _stats_json(stats: LeadTimeStats) -> dict:
    return {
        "sampleCount": stats.sample_count,
        "excludedCount": stats.excluded_count,
        "meanDays": _round(stats.mean_days),
        "stdDevDays": _round(stats.std_dev_days),
        "minDays": _round(stats.min_days),
        "maxDays": _round(stats.max_days),
        "p50Days": _round(stats.p50_days),
        "p90Days": _round(stats.p90_days),
        "coefficientOfVariation": _round(stats.coefficient_of_variation, 3),
        "onTimeRate": _round(stats.on_time_rate, 3),
        "lateCount": stats.late_count,
        "reliability": stats.reliability,
    }


def _sample_json(sample: LeadTimeSample) -> dict:
    return {
        "orderId": sample.order_id,
        "orderNumber": sample.order_number,
        "approvedAt": _iso(sample.approved_at),
        "firstReceivedAt": _iso(sample.first_received_at),
        "leadTimeDays": _round(sample.lead_time_days),
        "expectedOn": sample.expected_on.isoformat() if sample.expected_on else None,
        "onTime": sample.on_time,
    }
