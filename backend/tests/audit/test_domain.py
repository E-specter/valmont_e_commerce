from uuid import uuid4

import pytest

from valmont.modules.audit.domain import AuditEntry

VALID = {"action": "catalog.price_changed", "entity_type": "product", "entity_id": "p-1"}


def test_entry_keeps_all_its_fields() -> None:
    actor_id = uuid4()

    entry = AuditEntry(**VALID, actor_id=actor_id, actor_role="admin", before={"a": 1}, after={})

    assert (entry.actor_id, entry.actor_role, entry.before, entry.after) == (
        actor_id,
        "admin",
        {"a": 1},
        {},
    )


@pytest.mark.parametrize("changes", [{"after": {"a": 1}}, {"before": {"a": 1}}])
def test_creation_has_only_after_and_removal_only_before(changes: dict[str, object]) -> None:
    entry = AuditEntry(**VALID, **changes)

    assert entry.actor_id is None  # AUDIT-R5: sistema


def test_entry_needs_before_or_after() -> None:
    with pytest.raises(ValueError):
        AuditEntry(**VALID)


@pytest.mark.parametrize(
    "action",
    [
        "",
        "catalog",
        "Catalog.price_changed",
        "catalog.",
        ".changed",
        "a.b.c",
        "catalog.price_changed\n",
    ],
)
def test_action_must_be_module_dot_past_verb(action: str) -> None:
    with pytest.raises(ValueError):
        AuditEntry(**{**VALID, "action": action}, after={"a": 1})


@pytest.mark.parametrize(("field", "max_length"), [("entity_type", 60), ("entity_id", 120)])
def test_entity_fields_have_1_to_max_characters(field: str, max_length: int) -> None:
    assert AuditEntry(**{**VALID, field: "x" * max_length}, after={"a": 1})
    for value in ("", "x" * (max_length + 1)):
        with pytest.raises(ValueError):
            AuditEntry(**{**VALID, field: value}, after={"a": 1})
