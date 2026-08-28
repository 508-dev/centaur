from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

import client as centaur_client
from client import (
    CentaurInvestigatorClient,
    _current_thread_key,
    _database_url_with_name,
    _postgres_database_name,
    _record_to_dict,
    parse_slack_reference,
)

WORKFLOW_RUN_ID = "018f47a2-4b16-7c21-8c30-123456789abc"
HISTORICAL_WORKFLOW_RUN_ID = "018f47a2-4b16-7c21-8c30-abcdefabcdef"


class _FakeRecord:
    """Match asyncpg.Record: iteration yields values while keys() yields column names."""

    def __init__(self, **values) -> None:
        self._values = values

    def __iter__(self):
        return iter(self._values.values())

    def keys(self):
        return self._values.keys()

    def __getitem__(self, key):
        return self._values[key]


def test_record_to_dict_uses_asyncpg_record_column_names() -> None:
    created_at = dt.datetime(2026, 8, 11, 12, 0, tzinfo=dt.UTC)
    row = _FakeRecord(thread_key="slack:C123:123.456", created_at=created_at)

    assert _record_to_dict(row) == {
        "thread_key": "slack:C123:123.456",
        "created_at": created_at.isoformat(),
    }


def test_database_url_with_name_appends_database_to_base_dsn() -> None:
    assert (
        _database_url_with_name("postgresql://user:pass@proxy:5432", "ai_v2")
        == "postgresql://user:pass@proxy:5432/ai_v2"
    )
    assert (
        _database_url_with_name("postgresql://user:pass@proxy:5432/other", "ai_v2")
        == "postgresql://user:pass@proxy:5432/other"
    )
    assert (
        _database_url_with_name("postgresql://user:pass@proxy:5432?sslmode=require", "ai_v2")
        == "postgresql://user:pass@proxy:5432/ai_v2?sslmode=require"
    )


def test_postgres_database_name_defaults_to_ai_v2(monkeypatch) -> None:
    monkeypatch.delenv("CENTAUR_INVESTIGATOR_POSTGRES_DATABASE", raising=False)

    assert _postgres_database_name() == "ai_v2"


def test_postgres_database_name_can_be_overridden(monkeypatch) -> None:
    monkeypatch.setenv("CENTAUR_INVESTIGATOR_POSTGRES_DATABASE", "centaur")

    assert _postgres_database_name() == "centaur"


def test_postgres_database_name_uses_default_for_blank_override(monkeypatch) -> None:
    monkeypatch.setenv("CENTAUR_INVESTIGATOR_POSTGRES_DATABASE", " ")

    assert _postgres_database_name() == "ai_v2"


def test_current_thread_key_uses_session_scoped_environment(monkeypatch) -> None:
    monkeypatch.setenv("CENTAUR_THREAD_KEY", "  discord:111:222:333  ")

    assert _current_thread_key() == "discord:111:222:333"


class _FakeConnection:
    def __init__(self) -> None:
        self.execute_calls: list[str] = []
        self.fetch_calls: list[tuple[str, tuple]] = []
        self.fetchrow_calls: list[tuple[str, tuple]] = []
        self.closed = False
        self.now = dt.datetime(2026, 6, 17, 12, 0, tzinfo=dt.UTC)

    async def execute(self, query: str) -> None:
        self.execute_calls.append(query)

    async def fetchrow(self, query: str, *args):
        self.fetchrow_calls.append((query, args))
        if "current_setting('role'" in query:
            return {
                "session_user": "centaur",
                "current_user": "centaur_diagnostics_reader",
                "active_role": "centaur_diagnostics_reader",
            }
        if "FROM centaur_diagnostics.slack_sync_channels" in query:
            return {
                "channel_id": "C123",
                "channel_name": "eng",
                "is_archived": False,
                "is_syncable": True,
                "member_count": 42,
                "first_seen_at": self.now,
                "last_seen_at": self.now,
                "updated_at": self.now,
            }
        if "FROM centaur_diagnostics.slack_sync_checkpoints" in query:
            return {
                "channel_id": "C123",
                "watermark_ts": "1778000000.000000",
                "last_run_id": "run_1",
                "last_success_at": self.now,
                "has_error": False,
                "created_at": self.now,
                "updated_at": self.now,
            }
        return None

    async def fetch(self, query: str, *args):
        self.fetch_calls.append((query, args))
        if "FROM centaur_diagnostics.sessions" in query and "BETWEEN" not in query:
            return [
                {
                    "thread_key": "slack:C123:1777910337.403889",
                    "sandbox_id": "asbx_1",
                    "harness_type": "codex",
                    "harness_thread_id": "harness_1",
                    "persona_id": "default",
                    "status": "idle",
                    "source": "slack",
                    "platform": "slack",
                    "external_thread_id": "1777910337.403889",
                    "created_at": self.now,
                    "updated_at": self.now,
                }
            ]
        if "FROM centaur_diagnostics.session_executions" in query:
            return [
                {
                    "execution_id": "exe_1",
                    "thread_key": "slack:C123:1777910337.403889",
                    "status": "completed",
                    "model": "gpt-test",
                    "workflow_name": "sync_records",
                    "workflow_task_id": "task_1",
                    "workflow_run_id": WORKFLOW_RUN_ID,
                    "workflow_context_phase": "agent_turn",
                    "created_at": self.now,
                    "started_at": self.now,
                    "completed_at": self.now,
                    "duration_seconds": 42.0,
                }
            ]
        if "FROM centaur_diagnostics.workflow_runs" in query:
            reference = args[0] if args else ""
            if isinstance(reference, list) and not reference:
                return []
            return [
                {
                    "queue_name": "centaur_workflows",
                    "run_id": WORKFLOW_RUN_ID,
                    "task_id": "task_1",
                    "task_name": "workflow_task",
                    "workflow_name": "sync_records",
                    "harness_type": "codex",
                    "state": "failed",
                    "attempts": 3,
                    "max_attempts": 3,
                    "created_at": self.now,
                    "first_started_at": self.now,
                    "started_at": self.now,
                    "completed_at": None,
                    "failed_at": self.now,
                    "available_at": None,
                    "claimed": False,
                    "cancelled_at": None,
                }
            ]
        if "FROM centaur_diagnostics.session_messages" in query:
            return [
                {
                    "message_id": "msg_1",
                    "thread_key": "slack:C123:1777910337.403889",
                    "role": "user",
                    "part_count": 1,
                    "part_types": ["text"],
                    "source": "slack",
                    "platform": "slack",
                    "created_at": self.now,
                }
            ]
        if "FROM centaur_diagnostics.session_events" in query:
            return [
                {
                    "event_id": 1,
                    "thread_key": "slack:C123:1777910337.403889",
                    "execution_id": "exe_1",
                    "event_type": "session.execution_completed",
                    "payload_type": "result",
                    "payload_keys": ["type", "status"],
                    "has_error": False,
                    "created_at": self.now,
                }
            ]
        if "FROM centaur_diagnostics.slack_sync_messages" in query:
            return [
                {
                    "channel_id": "C123",
                    "message_ts": "1777910337.403889",
                    "thread_ts": "1777910337.403889",
                    "is_thread_root": True,
                    "user_id": "U123",
                    "message_type": "message",
                    "reply_count": 2,
                    "updated_at": self.now,
                }
            ]
        if "FROM centaur_diagnostics.slack_sync_message_attachments" in query:
            return [
                {
                    "channel_id": "C123",
                    "message_ts": "1777910337.403889",
                    "slack_file_id": "F123",
                    "mimetype": "text/plain",
                    "size_bytes": 100,
                    "download_status": "metadata_only",
                    "has_content_hash": False,
                    "updated_at": self.now,
                }
            ]
        if "FROM centaur_diagnostics.slack_sync_backfill_jobs" in query:
            return []
        if "FROM centaur_diagnostics.slack_sync_runs" in query:
            return []
        if "FROM centaur_diagnostics.sessions" in query and "BETWEEN" in query:
            return []
        if "FROM centaur_diagnostics.agent_runtime_assignments" in query:
            raise RuntimeError("relation does not exist")
        if "FROM centaur_diagnostics.agent_execution_requests" in query:
            raise RuntimeError("relation does not exist")
        if "FROM centaur_diagnostics.sandbox_sessions" in query:
            raise RuntimeError("relation does not exist")
        if "FROM centaur_diagnostics.thread_traces" in query:
            raise RuntimeError("relation does not exist")
        return []

    async def close(self) -> None:
        self.closed = True


class _RetriedWorkflowConnection(_FakeConnection):
    async def fetch(self, query: str, *args):
        if "FROM centaur_diagnostics.workflow_runs" in query:
            self.fetch_calls.append((query, args))
            reference = args[0] if args else ""
            if reference == HISTORICAL_WORKFLOW_RUN_ID:
                return []
            return [
                {
                    "queue_name": "centaur_workflows",
                    "run_id": WORKFLOW_RUN_ID,
                    "task_id": "task_1",
                    "task_name": "workflow_task",
                    "workflow_name": "sync_records",
                    "harness_type": "codex",
                    "state": "completed",
                    "attempts": 2,
                    "max_attempts": 3,
                    "created_at": self.now,
                    "first_started_at": self.now,
                    "started_at": self.now,
                    "completed_at": self.now,
                    "failed_at": None,
                    "available_at": None,
                    "claimed": False,
                    "cancelled_at": None,
                }
            ]
        if "FROM centaur_diagnostics.session_executions" in query:
            self.fetch_calls.append((query, args))
            run_ids = set(args[0])
            task_ids = set(args[1])
            rows = []
            if HISTORICAL_WORKFLOW_RUN_ID in run_ids:
                rows.append(
                    {
                        "execution_id": "exe_failed_attempt",
                        "thread_key": "discord:111:222:333",
                        "status": "failed",
                        "model": "gpt-test",
                        "workflow_name": "sync_records",
                        "workflow_task_id": "task_1",
                        "workflow_run_id": HISTORICAL_WORKFLOW_RUN_ID,
                        "workflow_context_phase": "agent_turn",
                        "created_at": self.now,
                        "started_at": self.now,
                        "completed_at": self.now,
                        "duration_seconds": 12.0,
                    }
                )
            if WORKFLOW_RUN_ID in run_ids or "task_1" in task_ids:
                rows.insert(
                    0,
                    {
                        "execution_id": "exe_successful_retry",
                        "thread_key": "discord:111:222:333",
                        "status": "completed",
                        "model": "gpt-test",
                        "workflow_name": "sync_records",
                        "workflow_task_id": "task_1",
                        "workflow_run_id": WORKFLOW_RUN_ID,
                        "workflow_context_phase": "agent_turn",
                        "created_at": self.now,
                        "started_at": self.now,
                        "completed_at": self.now,
                        "duration_seconds": 10.0,
                    },
                )
            return rows
        return await super().fetch(query, *args)


def test_parse_slack_permalink_prefers_thread_ts_query() -> None:
    result = parse_slack_reference(
        "Investigate https://example.slack.com/archives/C123/p1777910338403889"
        "?thread_ts=1777910337.403889&cid=C123"
    )

    assert result["status"] == "ok"
    assert result["kind"] == "slack_permalink"
    assert result["channel_id"] == "C123"
    assert result["message_ts"] == "1777910338.403889"
    assert result["thread_ts"] == "1777910337.403889"
    assert result["thread_key_candidates"] == [
        "slack:C123:1777910337.403889",
        "chat:C123:1777910337.403889",
    ]
    assert result["thread_key_like"] == "%:C123:1777910337.403889"


def test_parse_slack_thread_key_with_team() -> None:
    result = parse_slack_reference("slack:T0AQQ46PL4C:C0B0XS7BLA3:1780035646.228899")

    assert result["status"] == "ok"
    assert result["team_id"] == "T0AQQ46PL4C"
    assert result["channel_id"] == "C0B0XS7BLA3"
    assert result["thread_key_candidates"][:4] == [
        "slack:T0AQQ46PL4C:C0B0XS7BLA3:1780035646.228899",
        "chat:T0AQQ46PL4C:C0B0XS7BLA3:1780035646.228899",
        "slack:C0B0XS7BLA3:1780035646.228899",
        "chat:C0B0XS7BLA3:1780035646.228899",
    ]


def test_investigation_queries_diagnostics_views_without_message_context(monkeypatch) -> None:
    fake = _FakeConnection()

    async def fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr(centaur_client.asyncpg, "connect", fake_connect)

    result = CentaurInvestigatorClient("postgresql://example").investigate_slack_thread(
        "https://example.slack.com/archives/C123/p1777910337403889",
        include_observability=False,
    )

    assert result["status"] == "ok"
    assert result["postgres"]["status"] == "ok"
    assert result["postgres"]["role"] == "centaur_diagnostics_reader"
    assert (
        result["postgres"]["connection"]["row"]["current_user"]
        == "centaur_diagnostics_reader"
    )
    assert result["analysis"]["primary_source"] == "postgres_diagnostics_views"
    assert fake.execute_calls == []
    assert fake.closed is True

    all_queries = "\n".join(query for query, _args in fake.fetch_calls + fake.fetchrow_calls)
    assert "SELECT *" not in all_queries
    assert "FROM centaur_diagnostics.sessions" in all_queries
    assert "FROM centaur_diagnostics.session_messages" in all_queries
    assert "FROM centaur_diagnostics.slack_sync_messages" in all_queries
    assert "FROM centaur_diagnostics.workflow_runs" in all_queries
    assert "FROM public." not in all_queries
    assert "metadata ->>" not in all_queries
    assert "payload_json" not in all_queries
    assert "jsonb_typeof(parts)" not in all_queries

    assert "raw_payload" not in str(result)
    assert "url_private" not in str(result)
    assert "content_bytes" not in str(result)
    assert "secret user message" not in str(result)


def test_diagnose_defaults_to_current_discord_thread(monkeypatch) -> None:
    fake = _FakeConnection()

    async def fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr(centaur_client.asyncpg, "connect", fake_connect)
    monkeypatch.setenv("CENTAUR_THREAD_KEY", "discord:111:222:333")

    result = CentaurInvestigatorClient("postgresql://example").diagnose(include_observability=False)

    assert result["status"] == "ok"
    assert result["parsed"]["thread_key"] == "discord:111:222:333"
    assert result["postgres"]["role"] == "centaur_diagnostics_reader"
    assert result["postgres"]["workflow_runs"]["rows"][0]["run_id"] == WORKFLOW_RUN_ID
    assert fake.closed is True


def test_diagnose_workflow_run_uses_sanitized_diagnostics_view(monkeypatch) -> None:
    fake = _FakeConnection()

    async def fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr(centaur_client.asyncpg, "connect", fake_connect)

    result = CentaurInvestigatorClient("postgresql://example").diagnose(
        f"diagnose workflow {WORKFLOW_RUN_ID}",
        include_observability=False,
    )

    assert result["status"] == "ok"
    assert result["kind"] == "workflow_run"
    assert result["analysis"]["outcome"] == "failed"
    assert result["postgres"]["role"] == "centaur_diagnostics_reader"
    assert result["workflow_run_ids"] == [WORKFLOW_RUN_ID]
    assert "failure_reason" not in str(result)
    assert "raw_payload" not in str(result)
    assert "secret user message" not in str(result)

    all_queries = "\n".join(query for query, _args in fake.fetch_calls)
    assert "FROM centaur_diagnostics.workflow_runs" in all_queries
    assert "FROM public." not in all_queries
    assert "SELECT *" not in all_queries
    assert fake.execute_calls == []
    assert fake.closed is True


def test_diagnose_historical_attempt_recovers_latest_retry_state(monkeypatch) -> None:
    fake = _RetriedWorkflowConnection()

    async def fake_connect(*args, **kwargs):
        return fake

    monkeypatch.setattr(centaur_client.asyncpg, "connect", fake_connect)

    result = CentaurInvestigatorClient("postgresql://example").diagnose(
        HISTORICAL_WORKFLOW_RUN_ID,
        include_observability=False,
    )

    assert result["status"] == "ok"
    assert result["analysis"]["outcome"] == "completed"
    assert result["workflow_run_ids"] == [
        WORKFLOW_RUN_ID,
        HISTORICAL_WORKFLOW_RUN_ID,
    ]
    assert {row["execution_id"] for row in result["postgres"]["session_executions"]["rows"]} == {
        "exe_failed_attempt",
        "exe_successful_retry",
    }

    all_queries = "\n".join(query for query, _args in fake.fetch_calls)
    assert "WHERE task_id = ANY" in all_queries
    assert "ORDER BY event_id DESC" in all_queries
    assert "ORDER BY event_id ASC" not in all_queries
    assert fake.closed is True


def test_workflow_summary_treats_pending_retry_with_history_as_queued() -> None:
    historical_start = dt.datetime(2026, 6, 17, 11, 0, tzinfo=dt.UTC)
    summary = CentaurInvestigatorClient._summarize_workflow_run(
        workflow_runs={
            "rows": [
                {
                    "queue_name": "centaur_workflows",
                    "run_id": "retry_run",
                    "task_id": "retry_task",
                    "task_name": "workflow_task",
                    "state": "pending",
                    "attempts": 1,
                    "max_attempts": 3,
                    "first_started_at": historical_start.isoformat(),
                    "started_at": None,
                    "failed_at": historical_start.isoformat(),
                    "claimed": False,
                }
            ]
        },
        executions={"rows": []},
        events={"rows": []},
    )

    assert summary["outcome"] == "queued"
    assert "available worker" in summary["next_checks"][0]


def test_diagnose_without_reference_or_current_thread_fails_closed(monkeypatch) -> None:
    monkeypatch.delenv("CENTAUR_THREAD_KEY", raising=False)

    result = CentaurInvestigatorClient("postgresql://example").diagnose()

    assert result["status"] == "error"
    assert "CENTAUR_THREAD_KEY" in result["error"]


def test_observability_never_requests_raw_log_context(monkeypatch) -> None:
    fake = _FakeConnection()

    async def fake_connect(*args, **kwargs):
        return fake

    class FakeVlogs:
        def hits(self, query: str, step: str | None = None) -> dict:
            return {"query": query, "step": step, "hits": []}

        def field_values(self, field: str, query: str = "*", limit: int = 100) -> list[str]:
            if field == "event":
                return ["message_stored", "execute_completed"]
            return ["api"]

        def tool_usage_by_thread(
            self,
            thread_key: str = "",
            start: str = "24h",
            limit: int = 200,
        ) -> list[dict]:
            return [
                {
                    "_time": "2026-06-17T00:00:00Z",
                    "tool_name": "github",
                    "tool_method": "search",
                    "duration_ms": "42",
                    "success": "true",
                }
            ]

        def thread_trace(self, *args, **kwargs):
            raise AssertionError("raw thread trace should not be requested")

        def errors(self, *args, **kwargs):
            raise AssertionError("raw error logs should not be requested")

        def execution_timeline(self, *args, **kwargs):
            raise AssertionError("raw execution logs should not be requested")

    def fake_load_module(module_name: str, path: Path):
        if "vlogs" in str(path):
            return SimpleNamespace(VictoriaLogsClient=FakeVlogs)
        return None

    monkeypatch.setattr(centaur_client.asyncpg, "connect", fake_connect)
    monkeypatch.setattr(centaur_client, "_safe_load_module", fake_load_module)

    result = CentaurInvestigatorClient("postgresql://example").investigate_slack_thread(
        "https://example.slack.com/archives/C123/p1777910337403889",
        include_observability=True,
    )

    assert result["status"] == "ok"
    assert result["observability"]["vlogs"]["status"] == "ok"
    assert "thread_trace" not in str(result["observability"])
    assert "execution_logs" not in str(result["observability"])
    assert "raw_payload" not in str(result)
