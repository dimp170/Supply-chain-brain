"""NVIDIA NIM chat proxy with on-demand SQL tool calling.

Thin wrapper around the OpenAI-compatible endpoint at NVIDIA Endpoints
(https://integrate.api.nvidia.com/v1/chat/completions). The Supply Chain
Brain FastAPI server is the only thing that talks to NVIDIA — the frontend
calls /api/ai/chat and the key never leaves the backend.

Why direct HTTP and not NemoClaw / a Python SDK:
  * The endpoint is OpenAI-compatible, so `httpx` + a small JSON body is all
    we need. No SDK lock-in, no sandbox setup, no WebSocket reconnect logic.
  * Streaming can be added later by flipping `stream: true` and handling the
    SSE response — not needed for the first cut.

How tool calling fits in:
  * One tool is registered: `query_fleet_sql`. The model can call it when a
    user query needs spatial / temporal / filter-heavy reasoning the JSON
    context alone won't reliably answer ("trucks passing through Hamburg in
    the next 2 hours", "ships within 200 km of Singapore").
  * Per turn we run a small loop: send messages → if the model emits a tool
    call, execute it via `fleet_sql.run_query` against an ephemeral SQLite
    snapshot → append the result as a tool message → send again. Capped at
    MAX_TOOL_ROUNDS so a misbehaving model can't infinite-loop.
  * The fleet snapshot is materialized fresh on every tool call from the
    `context.vehicles` array the frontend ships. No persistence, no sync.

System prompt is domain-aware so the model knows it's an AI assistant for a
logistics control tower and not a generic chatbot. The fleet snapshot the
frontend passes in is injected into the system message verbatim so the model
can reason about real vehicle IDs, real scenario names, and real disruptions.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx

from services.fleet_sql import SCHEMA_DOC, run_query as run_fleet_sql

NVIDIA_ENDPOINTS = "https://integrate.api.nvidia.com/v1"

# Model id as listed in the NVIDIA build.nvidia.com catalog. If the catalog
# rotates, update here — the rest of the call stays identical.
# Reverted to Nemotron 3 Super — the smaller Llama-Nemotron 70B model
# we tried wasn't enabled for our NVIDIA account (404 on the function ID).
# Super 120B is slower per round but it's what we KNOW works against this
# API key. The real fix for the multi-round latency is streaming, not a
# model swap. See chat() docstring.
DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"

# Tool-calling loop cap. A reasonable conversation needs at most 1-2 tool
# calls (one SQL query + follow-up if rows need more analysis). 4 leaves
# headroom for the model to self-correct after a bad query.
# Bounded so a confused model can't burn 3+ minutes of NVIDIA round-trips.
# With the system prompt instructing "one comprehensive query", well-formed
# questions land in 2 rounds (1 tool call + 1 final answer).
MAX_TOOL_ROUNDS = 2


# Domain context tells the model what kind of platform it lives in and what
# data it can reason about. Specific facts (Petros fleet size, current
# scenario, recent disruptions) come from the per-request context payload.
SYSTEM_PROMPT = """You are the AI assistant for Supply Chain Brain, a logistics control tower for Petros Transport — a freight operator running 150 vehicles globally: 50 trucks, 50 cargo ships, and 50 cargo planes.

You answer operator questions about the fleet. The per-request context block (delivered as JSON below) gives you everything you need:

  1. dataMode: SIM (simulation only), DEMO (a pre-baked disruption scenario is active), or LIVE (real AIS + Aviation Edge + weather feeds).
  2. activeScenario / activeScenarioName: which pre-baked scenario is currently injecting disruption metadata (DEMO mode only).
  3. availableScenarios: the catalog of scenarios the operator CAN activate — use this to answer hypothetical "what if we ran scenario X?" questions.
  4. selectedVehicleId: which vehicle the operator currently has open in the side panel (null if none). Bias toward this vehicle when the question is ambiguous about WHICH vehicle.
  5. fleetSummary: aggregate counts (total, moving, delayed, stopped, byType, withDisruptions).
  6. vehicles: full per-vehicle records — id, name, type, company, status, position [lat,lng], speed (km/h), heading, cargo, destination, remainingKm, remainingMin. Ships also carry destPort, callSign, imo, lengthM, draughtM, optional destRisk/destIncident. Planes also carry flight, airline, dep, arr, altM. Trucks have no extra fields beyond the base.
  7. disruptions: the structured list of weather / geopolitical / port-congestion events affecting specific vehicles right now, with source authority, severity, and recommended impact.

For spatial, temporal, or filter-heavy queries — "trucks passing through Hamburg in the next 2 hours", "5 ships closest to Singapore", "vessels arriving within 6 hours", "vehicles within 100 km of a disruption" — use the `query_fleet_sql` tool. It runs SELECT-only SQL against a fresh SQLite snapshot of the current fleet. Always prefer SQL over manual reasoning for such queries — it's more accurate and you can scan all 150 vehicles in one shot.

The snapshot ALSO exposes a `shipments` table — one row per individual Bill of Lading (ship), CMR consignment (truck) or Air Waybill (plane). JOIN `shipments s ON v.id = s.vehicle_id` to answer cargo-aware questions: "what's the total value of hazmat shipments transiting Hormuz?", "which vehicles carry pharmaceuticals?", "total tonnes of grain heading to Asia?". The shipments table includes hazmat flags (UN number, IMDG/ADR/DGR class), reefer flags + temperature setpoints, commodity descriptions, HS codes and declared value per shipment.

For simple aggregate questions ("how many planes are moving?") you can read fleetSummary directly from the inline context.

**Per-vehicle / per-cargo questions ALWAYS go through `query_fleet_sql`** — including single-vehicle lookups like "where is PT Pacific Star?" (use `SELECT * FROM vehicles WHERE name LIKE '%Pacific Star%'`). The full vehicle and shipment data is NOT in the inline JSON — only the SQL snapshot has it. Don't apologise for using the SQL tool; it's the right tool every time.

**Filter to the relevant vehicle type first.** A maritime question — canal closures, port congestion, ocean weather, ship chokepoints — only affects ships, so `WHERE v.type = 'ship'` is mandatory. Air corridor / SIGMET / airport questions: filter to `'plane'`. Road / border / overland questions: `'truck'`. Don't waste a round scanning irrelevant fleets.

**Prefer one comprehensive SQL query** over multiple sequential ones. Use JOINs + aggregations to fetch location-filtered vehicles, their summed cargo value, hazmat counts, and reefer counts in a single call. Each extra tool round costs the user 5-15 seconds of latency.

Limit yourself to at most 3 SQL queries per answer. Design your queries to cover as much ground as possible in a single pass — use ORDER BY, LIMIT, and multi-condition WHERE clauses rather than issuing sequential single-purpose queries. Once you have sufficient data from the tool results, write your final text response immediately — do not issue further SQL calls. If you have partial data and have already used 2–3 queries, synthesise from what you have rather than querying again.

When you reference a vehicle, use its EXACT name (e.g. "PT Suez Express", not "the Suez ship"). When you cite a disruption source, use the exact sourceAuthority + sourceCitation.

**Two-tier rule for numbers:**

  1. **Fleet-specific facts** (positions, IDs, manifest contents, container counts, declared values, hazmat flags, route ETAs): NEVER estimate or invent. These come from the snapshot or the SQL tool — full stop. If a field isn't in the record, say so.

  2. **Industry knowledge** (fuel consumption rates, bunker prices, charter rates, demurrage, Cape vs Suez transit penalties, IATA SHC handling fees, ADR routing constraints, port turnaround norms): you SHOULD use these to estimate operational and financial impact when the user asks for it. Reviewers want hybrid reasoning — "here's what the data tells us; here's what industry norms suggest about cost / delay / risk." Without this you sound like a glorified SQL viewer.

When you use industry-knowledge estimates, label them explicitly: "**Industry estimate:**", "**Typical figures:**", "Based on a notional [X] of [Y]…", "Assumes [assumption]…". Cite the rate you used so the operator can sanity-check ("~6.25 t/h fuel burn × $600/t × 2 160 h ≈ $8 M"). Never present an estimate as fleet data.

Be concise. Ops controllers scan, they don't read. Short paragraphs, tight bulleted lists. Never invent fleet facts; freely augment with labelled industry context where it makes the answer actionable.

""" + "\n--- SQL TOOL SCHEMA ---\n" + SCHEMA_DOC + """
Example tool calls:

  -- "How many trucks are within 100 km of Frankfurt (50.11, 8.68)?"
  SELECT COUNT(*) AS n FROM vehicles
   WHERE type='truck'
     AND haversine_km(lat, lng, 50.11, 8.68) < 100;

  -- "Trucks passing through Hamburg (53.55, 9.99) in the next 2 hours"
  SELECT name, speed, remaining_min,
         haversine_km(lat, lng, 53.55, 9.99) AS km_to_hamburg
    FROM vehicles
   WHERE type='truck'
     AND status='moving'
     AND km_to_hamburg < 50
     AND remaining_min IS NOT NULL
     AND remaining_min <= 120
   ORDER BY km_to_hamburg;

  -- "5 vessels with the highest disruption count"
  SELECT name, type, disruption_count
    FROM vehicles
   WHERE has_disruption = 1
   ORDER BY disruption_count DESC
   LIMIT 5;

Use lowercase, real city/port coordinates from your world knowledge."""


# Tool definition — OpenAI-compatible function schema. Nemotron 3 Super's
# tool-calling pathway uses this exact shape.
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "query_fleet_sql",
            "description": (
                "Run a SELECT-only SQL query against the current fleet "
                "snapshot. Use this for any question that needs spatial "
                "filtering (distance from a point), temporal filtering "
                "(arrivals within N hours), aggregation, or ordering "
                "across the full 150-vehicle fleet. Always prefer this "
                "tool over manual reasoning for these query types."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": (
                            "A single SELECT (or WITH ... SELECT) statement "
                            "against the `vehicles` table. The "
                            "haversine_km(lat1, lng1, lat2, lng2) function is "
                            "available for spatial queries. No INSERT/UPDATE/"
                            "DELETE/DROP/PRAGMA — those will be rejected."
                        ),
                    },
                },
                "required": ["sql"],
            },
        },
    },
]


def _api_key() -> str:
    key = os.environ.get("NVIDIA_API_KEY", "")
    if not key:
        raise RuntimeError(
            "NVIDIA_API_KEY is not set. Add it to .env.local at the repo root "
            "(same key you pasted into the NemoClaw setup wizard)."
        )
    return key


def _build_context_block(context: Optional[dict[str, Any]]) -> str:
    """Render the per-request context as a structured block the model can parse.

    **Design**: the inline JSON intentionally OMITS the bulky fleet payload
    (`vehicles` and `shipments`). Both are loaded into the SQL tool's
    snapshot — the model accesses them with `query_fleet_sql` calls. We
    keep the small, contextually-important pieces inline:
      * dataMode + activeScenario + activeScenarioName
      * fleetSummary aggregates (totals, status breakdown, disruption count)
      * disruptions (one entry per affected vehicle — small, ops-critical)
      * availableScenarios + selectedVehicleId

    **Why strip the bulk**: With 150 vehicles × ~300 B + 700 shipments ×
    ~250 B, serialising the lot into the system prompt costs ~220 KB —
    that consumes most of Nemotron's 128 K-token window, leaving the model
    no room to think through multi-step tool-call answers. Stripping
    fleets keeps the prompt around 8-10 KB; the model uses SQL JOINs
    (which return tightly-scoped results) for fleet questions instead.
    Tradeoff: trivial single-vehicle questions now require one tool call
    instead of an inline lookup, adding ~5s. Worth it.
    """
    if not context:
        return ""
    OMIT = {"vehicles", "shipments"}
    try:
        slim = {k: v for k, v in context.items() if k not in OMIT}
        n_vehicles = len(context.get("vehicles") or [])
        n_shipments = len(context.get("shipments") or [])
        rendered = json.dumps(slim, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        return ""
    footer_lines = []
    if n_vehicles:
        footer_lines.append(
            f"{n_vehicles} vehicle rows are loaded into the `vehicles` SQL table."
        )
    if n_shipments:
        footer_lines.append(
            f"{n_shipments} shipment rows are loaded into the `shipments` SQL table."
        )
    if footer_lines:
        footer_lines.append("Use `query_fleet_sql` for any per-vehicle / per-cargo question.")
        footer = "\n\n" + " ".join(footer_lines)
    else:
        footer = ""
    return f"\n\nCurrent platform state:\n```json\n{rendered}\n```{footer}"


def _execute_tool_call(
    name: str,
    arguments: dict[str, Any],
    context: Optional[dict[str, Any]],
) -> str:
    """Run one tool call and return the JSON-stringified result.

    On error, returns a JSON object with an "error" field — the model gets
    this back as a tool response and can self-correct (rewrite the SQL,
    try a different approach, or fall back to prose).
    """
    if name != "query_fleet_sql":
        return json.dumps({"error": f"unknown tool: {name}"})

    sql = arguments.get("sql", "") if isinstance(arguments, dict) else ""
    if not isinstance(sql, str) or not sql.strip():
        return json.dumps({"error": "sql argument is required"})

    vehicles = (context or {}).get("vehicles") or []
    disruptions = (context or {}).get("disruptions") or []
    shipments = (context or {}).get("shipments") or []

    print(f"[ai] SQL: {sql.strip()[:300]}", flush=True)

    try:
        result = run_fleet_sql(vehicles, disruptions, sql, shipments=shipments)
    except ValueError as exc:
        # Forbidden query — give the model a clear correction signal.
        print(f"[ai] SQL rejected: {exc}", flush=True)
        return json.dumps({"error": str(exc)})
    except Exception as exc:
        print(f"[ai] SQL error: {type(exc).__name__}: {exc}", flush=True)
        return json.dumps({"error": f"{type(exc).__name__}: {exc}"})

    print(
        f"[ai] SQL returned {result['row_count']} rows "
        f"({'truncated' if result['truncated'] else 'full'})",
        flush=True,
    )
    return json.dumps(result, default=str)


async def _call_endpoint(
    client: httpx.AsyncClient,
    api_key: str,
    *,
    messages: list[dict[str, Any]],
    model: str,
    temperature: float,
    max_tokens: int,
    tools: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"

    response = await client.post(
        f"{NVIDIA_ENDPOINTS}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=body,
    )
    response.raise_for_status()
    return response.json()


async def chat(
    messages: list[dict[str, str]],
    context: Optional[dict[str, Any]] = None,
    *,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
    max_tokens: int = 1024,
) -> dict[str, Any]:
    """Send a chat completion request to NVIDIA Endpoints.

    Multi-round flow:
      1. Send system + caller messages with the SQL tool registered.
      2. If the model emits one or more tool calls, execute each against
         the fleet snapshot, append the results as tool messages, and
         send again.
      3. Loop until the model emits a final text response (no tool calls)
         or MAX_TOOL_ROUNDS is hit.

    Args:
      messages: OpenAI-compatible message list. Caller passes only user/
        assistant turns; we prepend our own system message with domain
        context. The caller never crafts the system message itself.
      context: Per-request structured snapshot (mode, fleet summary,
        vehicles, disruptions) the frontend assembles from useVehicleStore.
        Injected into the system message AND used as the data source for
        the SQL tool.
      model: NVIDIA model id. Override if the catalog rotates.
      temperature: 0.3 by default — controllers want consistency, not flair.
      max_tokens: Response cap. 1024 is generous for ops Q&A.

    Returns:
      {
        "message": {"role": "assistant", "content": "..."},
        "usage": {...},                # last-round usage; total burned may be higher
        "model": "<model-id-as-reported>",
        "tool_rounds": int,            # number of tool calls the model made
      }
    """
    api_key = _api_key()

    system_message = {
        "role": "system",
        "content": SYSTEM_PROMPT + _build_context_block(context),
    }

    conversation: list[dict[str, Any]] = [system_message, *messages]
    tool_rounds = 0
    last_usage: dict[str, Any] = {}
    reported_model = model

    # 180s gives meaningful headroom for multi-tool-round questions (e.g.
    # "what's my Panama Canal exposure?" — the model issues 2-3 SQL JOINs
    # plus final synthesis). Each round is one NVIDIA round-trip at 5-15s
    # plus local SQL execution. 90 s was tight when more than 2 rounds
    # were needed; 180 s gives room without locking the UI indefinitely.
    import time
    chat_start = time.monotonic()
    prompt_chars = len(system_message["content"])
    print(
        f"[chat] start · model={model} · prompt={prompt_chars:,} chars · "
        f"max_rounds={MAX_TOOL_ROUNDS}",
        flush=True,
    )
    async with httpx.AsyncClient(timeout=180.0) as client:
        for round_idx in range(MAX_TOOL_ROUNDS + 1):
            round_start = time.monotonic()
            data = await _call_endpoint(
                client,
                api_key,
                messages=conversation,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=TOOLS,
            )
            round_elapsed = time.monotonic() - round_start
            print(
                f"[chat] round {round_idx} done in {round_elapsed:.1f}s "
                f"(total {time.monotonic() - chat_start:.1f}s)",
                flush=True,
            )

            choices = data.get("choices") or []
            if not choices:
                raise RuntimeError(f"NVIDIA Endpoints returned no choices: {data}")

            assistant_message = choices[0].get("message") or {}
            last_usage = data.get("usage", {}) or {}
            reported_model = data.get("model", model)

            tool_calls = assistant_message.get("tool_calls") or []
            if not tool_calls:
                # Final text answer.
                return {
                    "message": assistant_message,
                    "usage": last_usage,
                    "model": reported_model,
                    "tool_rounds": tool_rounds,
                }

            # Append the assistant message verbatim so the model sees its
            # own tool call list on the next turn.
            conversation.append(assistant_message)

            # Execute each tool call and append a tool message per id.
            for tc in tool_calls:
                tool_rounds += 1
                fn = tc.get("function") or {}
                name = fn.get("name") or ""
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except json.JSONDecodeError:
                    args = {}

                tool_result = _execute_tool_call(name, args, context)
                conversation.append({
                    "role": "tool",
                    "tool_call_id": tc.get("id"),
                    "content": tool_result,
                })

        # Loop exhausted — model kept issuing tool calls without producing a
        # text answer. One final call with tools disabled forces it to
        # synthesise from everything it has gathered so far.
        print(
            f"[ai] tool-call loop hit {MAX_TOOL_ROUNDS} rounds — "
            "forcing final text answer (tools disabled)",
            flush=True,
        )
        data = await _call_endpoint(
            client,
            api_key,
            messages=conversation,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=None,  # no tools → model must produce text
        )
        choices = data.get("choices") or []
        if choices:
            assistant_message = choices[0].get("message") or {}
            if assistant_message.get("content"):
                return {
                    "message": assistant_message,
                    "usage": data.get("usage", {}) or {},
                    "model": data.get("model", model),
                    "tool_rounds": tool_rounds,
                }

    raise RuntimeError(
        f"Tool-calling loop exceeded {MAX_TOOL_ROUNDS} rounds without a final answer"
    )
