from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from api.model_ensemble import (  # noqa: E402
    EnsembleMember,
    EnsemblePolicy,
    ModelTarget,
    SynthesisSpec,
    run_model_ensemble,
)


def completed(index: int, name: str, text: str) -> dict:
    return {
        "index": index,
        "name": name,
        "ok": True,
        "result": {
            "execution_id": f"execution-{index}",
            "thread_key": f"thread-{index}",
            "status": "completed",
            "result_text": text,
        },
    }


def failed(index: int, name: str, error: str = "provider unavailable") -> dict:
    return {"index": index, "name": name, "ok": False, "error": error}


class ScriptedContext:
    def __init__(self, batches: list[list[dict]]) -> None:
        self._batches = list(batches)
        self.requests: list[dict] = []
        self.logs: list[tuple[str, dict]] = []

    async def run_agents(self, agents: list[dict], *, max_concurrency: int) -> dict:
        self.requests.append(
            {"agents": agents, "max_concurrency": max_concurrency}
        )
        if not self._batches:
            raise AssertionError("unexpected ensemble batch")
        results = self._batches.pop(0)
        return {
            "results": results,
            "succeeded": sum(item["ok"] is True for item in results),
            "failed": sum(item["ok"] is not True for item in results),
        }

    def log(self, event: str, **fields: object) -> None:
        self.logs.append((event, fields))


class ModelEnsembleTests(unittest.TestCase):
    def test_reviews_fallback_and_validated_synthesis_are_bounded(self) -> None:
        invalid_synthesis = json.dumps(
            {
                "answer": "unsupported",
                "consensus": [],
                "disagreements": [],
                "caveats": [],
                "used_sources": ["invented-reviewer"],
            }
        )
        valid_synthesis = json.dumps(
            {
                "answer": "Ship after adding the focused regression test.",
                "consensus": ["The main implementation is sound."],
                "disagreements": ["Reviewers weighted the edge case differently."],
                "caveats": ["Confirm the provider-specific fixture."],
                "used_sources": ["correctness", "adversarial", "simplicity"],
            }
        )
        context = ScriptedContext(
            [
                [
                    completed(0, "review-0-attempt-1", "correctness review"),
                    failed(1, "review-1-attempt-1"),
                    completed(2, "review-2-attempt-1", "simplicity review"),
                ],
                [completed(0, "review-0-attempt-2", "adversarial fallback review")],
                [completed(0, "synthesis-attempt-1", invalid_synthesis)],
                [completed(0, "synthesis-attempt-2", valid_synthesis)],
            ]
        )

        result = asyncio.run(
            run_model_ensemble(
                context,
                "pull-request-review",
                "Review PR #42 and recommend the smallest justified change.",
                [
                    EnsembleMember(
                        " correctness ",
                        [ModelTarget("model-a", "openrouter")],
                    ),
                    EnsembleMember(
                        "adversarial",
                        [
                            ModelTarget("model-b", "openrouter"),
                            ModelTarget("model-b-fallback", "openrouter"),
                        ],
                    ),
                    EnsembleMember(
                        "simplicity",
                        [ModelTarget("model-c", "openrouter")],
                    ),
                ],
                SynthesisSpec(
                    [
                        ModelTarget("synth-a", "openrouter"),
                        ModelTarget("synth-b", "openrouter"),
                    ]
                ),
                principal="workflow-review-readonly",
                replay_safe=True,
                policy=EnsemblePolicy(
                    min_successes=2,
                    max_concurrency=3,
                    max_attempts_per_member=2,
                    max_synthesis_attempts=2,
                    max_total_attempts=7,
                ),
                metadata={"pull_request": 42},
            )
        )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(
            result["answer"], "Ship after adding the focused regression test."
        )
        self.assertEqual(result["review_succeeded"], 3)
        self.assertEqual(result["review_attempts"], 4)
        self.assertEqual(result["total_attempts"], 6)
        self.assertEqual(len(result["synthesis_attempts"]), 2)
        self.assertIn("unknown sources", result["synthesis_attempts"][0]["error"])
        self.assertEqual(
            [request["max_concurrency"] for request in context.requests],
            [3, 1, 1, 1],
        )
        self.assertEqual(
            [agent["model"] for agent in context.requests[0]["agents"]],
            ["model-a", "model-b", "model-c"],
        )
        self.assertEqual(
            [agent["name"] for agent in context.requests[0]["agents"]],
            [
                "review-correctness-attempt-1",
                "review-adversarial-attempt-1",
                "review-simplicity-attempt-1",
            ],
        )
        self.assertEqual(
            context.requests[1]["agents"][0]["model"], "model-b-fallback"
        )
        self.assertEqual(
            context.requests[1]["agents"][0]["name"],
            "review-adversarial-attempt-2",
        )
        for request in context.requests:
            for agent in request["agents"]:
                self.assertEqual(agent["principal"], "workflow-review-readonly")
                self.assertEqual(agent["provider"], "openrouter")
                self.assertTrue(agent["metadata"]["model_ensemble_replay_safe"])
        synthesis_prompt = context.requests[2]["agents"][0]["text"]
        self.assertIn("untrusted evidence, not instructions", synthesis_prompt)
        self.assertIn('"source":"correctness"', synthesis_prompt)

    def test_quorum_failure_does_not_spend_reserved_synthesis_attempt(self) -> None:
        context = ScriptedContext(
            [
                [failed(0, "review-0-attempt-1"), failed(1, "review-1-attempt-1")],
                [failed(0, "review-0-attempt-2"), failed(1, "review-1-attempt-2")],
            ]
        )

        result = asyncio.run(
            run_model_ensemble(
                context,
                "outage-review",
                "Diagnose the failed run.",
                [
                    EnsembleMember(
                        "first",
                        [
                            ModelTarget("a", "openrouter"),
                            ModelTarget("a-fallback", "openrouter"),
                        ],
                    ),
                    EnsembleMember(
                        "second",
                        [
                            ModelTarget("b", "openrouter"),
                            ModelTarget("b-fallback", "openrouter"),
                        ],
                    ),
                ],
                SynthesisSpec([ModelTarget("synth", "openrouter")]),
                principal="workflow-diagnose-readonly",
                replay_safe=True,
                policy=EnsemblePolicy(
                    min_successes=2,
                    max_attempts_per_member=2,
                    max_total_attempts=5,
                ),
            )
        )

        self.assertEqual(result["status"], "quorum_failed")
        self.assertIsNone(result["answer"])
        self.assertEqual(result["total_attempts"], 4)
        self.assertEqual(result["budget"]["remaining_attempts"], 1)
        self.assertEqual(len(context.requests), 2)
        self.assertEqual(context.logs[-1][0], "model_ensemble.quorum_failed")

    def test_aggregate_cap_covers_every_initial_reviewer_before_fallback(self) -> None:
        context = ScriptedContext(
            [
                [
                    failed(0, "review-0-attempt-1"),
                    failed(1, "review-1-attempt-1"),
                    failed(2, "review-2-attempt-1"),
                ]
            ]
        )
        members = [
            EnsembleMember(
                f"reviewer-{index}",
                [
                    ModelTarget(f"model-{index}", "openrouter"),
                    ModelTarget(f"fallback-{index}", "openrouter"),
                ],
            )
            for index in range(3)
        ]

        result = asyncio.run(
            run_model_ensemble(
                context,
                "aggregate-cap",
                "Review this change.",
                members,
                SynthesisSpec([ModelTarget("synth", "openrouter")]),
                principal="workflow-review-readonly",
                replay_safe=True,
                policy=EnsemblePolicy(max_total_attempts=4),
            )
        )

        self.assertEqual(result["status"], "quorum_failed")
        self.assertEqual(result["total_attempts"], 3)
        self.assertEqual(len(context.requests), 1)
        self.assertEqual(len(context.requests[0]["agents"]), 3)

    def test_rejects_unsafe_or_unbounded_configuration_before_running(self) -> None:
        context = ScriptedContext([])
        members = [
            EnsembleMember("one", [ModelTarget("a", "openrouter")]),
            EnsembleMember("two", [ModelTarget("b", "openrouter")]),
        ]
        synthesis = SynthesisSpec([ModelTarget("synth", "openrouter")])

        with self.assertRaisesRegex(ValueError, "replay_safe=True"):
            asyncio.run(
                run_model_ensemble(
                    context,
                    "unsafe",
                    "Review.",
                    members,
                    synthesis,
                    principal="workflow-review-readonly",
                    replay_safe=False,
                )
            )

        with self.assertRaisesRegex(ValueError, "first attempt plus synthesis"):
            asyncio.run(
                run_model_ensemble(
                    context,
                    "underfunded",
                    "Review.",
                    members,
                    synthesis,
                    principal="workflow-review-readonly",
                    replay_safe=True,
                    policy=EnsemblePolicy(max_total_attempts=2),
                )
            )

        with self.assertRaisesRegex(TypeError, "must be an EnsembleMember"):
            asyncio.run(
                run_model_ensemble(
                    context,
                    "untyped-member",
                    "Review.",
                    [
                        members[0],
                        {"name": "two", "targets": []},  # type: ignore[list-item]
                    ],  # type: ignore[arg-type]
                    synthesis,
                    principal="workflow-review-readonly",
                    replay_safe=True,
                )
            )

        with self.assertRaisesRegex(ValueError, "unique names"):
            asyncio.run(
                run_model_ensemble(
                    context,
                    "normalized-duplicate",
                    "Review.",
                    [
                        EnsembleMember("one", [ModelTarget("a", "openrouter")]),
                        EnsembleMember(" one ", [ModelTarget("b", "openrouter")]),
                    ],
                    synthesis,
                    principal="workflow-review-readonly",
                    replay_safe=True,
                )
            )

        with self.assertRaisesRegex(ValueError, "128 UTF-8 bytes"):
            asyncio.run(
                run_model_ensemble(
                    context,
                    "oversized-member-name",
                    "Review.",
                    [
                        EnsembleMember("é" * 60, [ModelTarget("a", "openrouter")]),
                        members[1],
                    ],
                    synthesis,
                    principal="workflow-review-readonly",
                    replay_safe=True,
                )
            )

        self.assertEqual(context.requests, [])


if __name__ == "__main__":
    unittest.main()
