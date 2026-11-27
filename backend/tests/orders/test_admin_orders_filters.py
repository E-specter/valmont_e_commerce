"""Filtros, orden y paginación de `GET /api/v1/orders/admin` con la app real y PostgreSQL (T-078;
CA-ORDERS-16; SPEC §4 R17 y §7 "Listado de administración"): `status`, `q` por número (con y sin
`VAL-`) y por nombre del destinatario sin distinguir mayúsculas, comodines escapados, fechas de
`America/Lima` inclusivas con sus bordes, combinación de filtros, paginación y su orden, entradas
inválidas (422) y entradas hostiles (nunca 500). Cada prueba usa una etiqueta propia en el nombre
del destinatario para no depender de otras filas de la BD de pruebas. Datos ficticios."""

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text

from tests.orders import orders_http_helpers as helpers
from tests.orders.orders_admin_helpers import (
    admin_list,
    admin_of,
    admin_page,
    named_order,
    set_created_at,
    tag,
)
from tests.orders.orders_http_helpers import OrderShop
from tests.orders.orders_read_helpers import ALL_STATUSES, ids_of, statuses_of
from valmont.modules.orders.domain import Order, format_order_number

pytestmark = pytest.mark.integration

shop = helpers.shop

# Lima es UTC-5 todo el año (sin horario de verano, SPEC §4 R5).
LIMA = timedelta(hours=-5)


def lima(day: str, clock: str = "00:00:00", micro: int = 0) -> datetime:
    """Instante UTC de una hora de pared de Lima."""
    local = datetime.fromisoformat(f"{day}T{clock}").replace(microsecond=micro)
    return (local - LIMA).replace(tzinfo=UTC)


def found(page: dict[str, Any], *orders: Order) -> bool:
    return set(ids_of(page)) == {str(o.id) for o in orders} and page["total"] == len(orders)


def error_422(response: Any, field: str) -> None:
    assert response.status_code == 422, response.text
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    assert any(d["loc"][0] == "query" and d["loc"][-1] == field for d in body["details"]), body
    assert "Traceback" not in response.text


# --------------------------------------------------------------------------------------------
# status
def test_status_filters_to_that_state_for_each_of_the_eight(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    by_status = {
        status: named_order(shop, shop.user(), f"Ana {label}", status=status, minutes_ago=5)
        for status in ALL_STATUSES
    }

    for status, order in by_status.items():
        page = admin_page(shop, admin, ("q", label), ("status", status))
        assert found(page, order), status
        assert statuses_of(page) == [status]


def test_without_status_every_state_is_listed(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    for status in ALL_STATUSES:
        named_order(shop, shop.user(), f"Ana {label}", status=status, minutes_ago=5)

    page = admin_page(shop, admin, ("q", label), ("page_size", 50))

    assert sorted(statuses_of(page)) == sorted(ALL_STATUSES) and page["total"] == 8


@pytest.mark.parametrize("bad", ["foo", "PAGADO", "pendiente pago", "1", "pagado;--"])
def test_an_unknown_status_is_422_with_the_query_location(shop: OrderShop, bad: str) -> None:
    error_422(admin_list(shop, admin_of(shop), ("status", bad)), "status")


def test_a_repeated_status_is_never_a_server_error(shop: OrderShop) -> None:
    # §7: "`status` admite un solo valor". Qué hace con dos (422 o el último) no está fijado.
    response = admin_list(shop, admin_of(shop), ("status", "pagado"), ("status", "cancelado"))

    assert response.status_code in (200, 422)


# --------------------------------------------------------------------------------------------
# q por número
def test_q_finds_by_number_with_the_val_prefix_and_without_it(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    target = named_order(shop, shop.user(), f"Ana {label}")
    named_order(shop, shop.user(), f"Ana {label}")  # otro número
    number = target.number or 0

    for q in (
        format_order_number(number),
        format_order_number(number).lower(),
        str(number),
        f"{number:06d}",
        f"VAL-{number}",
        f"val-{number}",
    ):
        page = admin_page(shop, admin, ("q", q))
        assert str(target.id) in ids_of(page), q


def test_q_by_number_is_exact_not_a_prefix_or_a_substring(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    order = named_order(shop, shop.user(), f"Ana {label}")
    number = order.number or 0
    near = [f"{number}0", f"{number}9", f"{number + 1}0000000"]

    for q in near:
        page = admin_page(shop, admin, ("q", f"VAL-{q}"))
        assert str(order.id) not in ids_of(page), q


def test_q_by_number_does_not_match_other_orders_of_the_same_customer(shop: OrderShop) -> None:
    admin, user, label = admin_of(shop), shop.user(), tag()
    first = named_order(shop, user, f"Ana {label}", minutes_ago=90)
    second = named_order(shop, user, f"Ana {label}", minutes_ago=30)

    page = admin_page(shop, admin, ("q", format_order_number(second.number or 0)))

    assert str(second.id) in ids_of(page) and str(first.id) not in ids_of(page)


def test_q_with_only_the_prefix_is_not_an_error(shop: OrderShop) -> None:
    assert admin_list(shop, admin_of(shop), ("q", "VAL-")).status_code == 200


# --------------------------------------------------------------------------------------------
# q por nombre del destinatario
def test_q_finds_by_recipient_name_ignoring_case_and_any_part_of_it(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    ana = named_order(shop, shop.user(), f"Rosa {label}")
    named_order(shop, shop.user(), f"Luis {label}")

    for q in (f"rosa {label}", f"ROSA {label.upper()}", f"RoSa {label}", "osa " + label, label):
        page = admin_page(shop, admin, ("q", q))
        assert str(ana.id) in ids_of(page), q
    only = admin_page(shop, admin, ("q", f"rosa {label}"))
    assert found(only, ana)


def test_q_matches_the_recipient_and_not_the_customer_account(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    # el destinatario del pedido es otra persona que quien lo compró (regalo)
    order = named_order(shop, shop.user(), f"Regalo {label}")

    assert found(admin_page(shop, admin, ("q", f"regalo {label}")), order)
    assert admin_page(shop, admin, ("q", str(order.user_id)))["total"] == 0  # no busca por user_id


def test_q_is_trimmed_and_an_empty_or_blank_q_means_no_filter(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    order = named_order(shop, shop.user(), f"Rosa {label}")
    unfiltered = admin_page(shop, admin, ("page_size", 50))

    assert found(admin_page(shop, admin, ("q", f"  rosa {label}  ")), order)
    for blank in ("", " ", "     "):
        page = admin_page(shop, admin, ("q", blank), ("page_size", 50))
        assert page == unfiltered, repr(blank)
    assert str(order.id) in ids_of(unfiltered) or unfiltered["total"] > 50


def test_q_that_matches_nothing_gives_an_empty_page_with_total_zero(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    named_order(shop, shop.user(), f"Rosa {label}")

    assert admin_page(shop, admin, ("q", tag())) == {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 20,
    }


# --------------------------------------------------------------------------------------------
# comodines escapados
def test_an_underscore_in_q_is_a_literal_not_any_one_character(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    literal = named_order(shop, shop.user(), f"{label}_x")
    other = named_order(shop, shop.user(), f"{label}Zx")

    page = admin_page(shop, admin, ("q", f"{label}_"))

    assert found(page, literal) and str(other.id) not in ids_of(page)


def test_a_percent_in_q_is_a_literal_not_any_sequence(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    literal = named_order(shop, shop.user(), f"{label}%x")
    other = named_order(shop, shop.user(), f"{label}Zx")

    assert found(admin_page(shop, admin, ("q", f"{label}%")), literal)
    assert found(admin_page(shop, admin, ("q", f"{label}%x")), literal)
    assert str(other.id) not in ids_of(admin_page(shop, admin, ("q", f"{label}%x")))


def test_a_lone_percent_or_underscore_only_matches_names_that_contain_it(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    with_percent = named_order(shop, shop.user(), f"{label}%x")
    with_underscore = named_order(shop, shop.user(), f"{label}_x")
    plain = named_order(shop, shop.user(), f"{label}Zx")

    percent = admin_page(shop, admin, ("q", "%"), ("page_size", 50))
    underscore = admin_page(shop, admin, ("q", "_"), ("page_size", 50))

    assert str(with_percent.id) in ids_of(percent) and str(plain.id) not in ids_of(percent)
    assert str(with_underscore.id) in ids_of(underscore)
    assert str(plain.id) not in ids_of(underscore)
    for item in percent["items"]:
        assert "%" in item["recipient_name"]
    for item in underscore["items"]:
        assert "_" in item["recipient_name"]


def test_a_backslash_in_q_is_a_literal_and_does_not_break_the_escape(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    literal = named_order(shop, shop.user(), f"{label}\\x")
    plain = named_order(shop, shop.user(), f"{label}Zx")

    page = admin_page(shop, admin, ("q", f"{label}\\"))

    assert found(page, literal) and str(plain.id) not in ids_of(page)
    for lone in ("\\", "\\\\", "%\\", "_\\%"):
        assert admin_list(shop, admin, ("q", lone)).status_code == 200


# --------------------------------------------------------------------------------------------
# entradas hostiles: nunca 500, nunca filas de más
HOSTILE = [
    "' OR '1'='1",
    "'; DROP TABLE app.orders; --",
    "%' OR 1=1 --",
    '" OR ""="',
    "\\' OR 1=1 --",
    "1 OR 1=1",
    "VAL-1 OR 1=1",
    "1); DELETE FROM app.orders; --",
    "' UNION SELECT user_id, user_id FROM app.orders --",
    "<script>alert(1)</script>",
    "${jndi:ldap://x}",
    "𝟙𝟚𝟛",  # dígitos no ASCII: `isdigit()` los da por buenos, el número no
    "٣٤٥",
]


@pytest.mark.parametrize("payload", HOSTILE)
def test_hostile_q_is_a_plain_literal_search_that_finds_nothing(
    shop: OrderShop, payload: str
) -> None:
    admin, label = admin_of(shop), tag()
    named_order(shop, shop.user(), f"Rosa {label}")
    count = "SELECT count(*) FROM app.orders"
    before = shop.session.execute(text(count)).scalar_one()

    response = admin_list(shop, admin, ("q", payload))

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 0 and response.json()["items"] == []
    assert shop.session.execute(text(count)).scalar_one() == before  # nada borrado


@pytest.mark.parametrize("number", ["9" * 19, "9" * 20, "9" * 40, "VAL-" + "9" * 30, "0" * 50])
def test_a_number_beyond_bigint_is_an_empty_search_not_a_database_error(
    shop: OrderShop, number: str
) -> None:
    response = admin_list(shop, admin_of(shop), ("q", number))

    assert response.status_code == 200, response.text
    assert "Traceback" not in response.text


@pytest.mark.parametrize("control", ["a\x00b", "a\nb", "a\tb", "\x1f", "\x7f", "a\r\nb"])
def test_a_control_character_in_q_is_422_with_the_query_location(
    shop: OrderShop, control: str
) -> None:
    error_422(admin_list(shop, admin_of(shop), ("q", control)), "q")


def test_a_q_with_accents_symbols_emoji_and_inner_spaces_is_accepted(shop: OrderShop) -> None:
    admin = admin_of(shop)

    for q in ("José  Ñandú", "Ana-María", "O'Brien", "李雷", "🙂", "a b"):
        assert admin_list(shop, admin, ("q", q)).status_code == 200, q


def test_q_accepts_exactly_100_characters_and_rejects_101(shop: OrderShop) -> None:
    admin = admin_of(shop)

    assert admin_list(shop, admin, ("q", "a" * 100)).status_code == 200
    error_422(admin_list(shop, admin, ("q", "a" * 101)), "q")


# --------------------------------------------------------------------------------------------
# fechas de Lima, inclusivas
@pytest.fixture
def dated(shop: OrderShop) -> dict[str, Any]:
    """Pedidos pagados con `created_at` en los bordes del día de Lima 2026-12-01."""
    label = tag()
    spec = {
        "before": lima("2026-11-30", "23:59:59"),
        "start": lima("2026-12-01", "00:00:00"),
        "late_utc_day": datetime(2026, 12, 2, 3, 0, tzinfo=UTC),  # 22:00 del 1 en Lima
        "end": lima("2026-12-01", "23:59:59", 999_999),
        "after": lima("2026-12-02", "00:00:00"),
    }
    orders = {}
    for key, created in spec.items():
        order = named_order(shop, shop.user(), f"Ana {label}")
        set_created_at(shop.session, order.id, created)
        orders[key] = order
    return {"label": label, "orders": orders, "admin": admin_of(shop), "shop": shop}


def dates(env: dict[str, Any], *params: tuple[str, str]) -> set[str]:
    page = admin_page(env["shop"], env["admin"], ("q", env["label"]), ("page_size", 50), *params)
    return set(ids_of(page))


def ids(env: dict[str, Any], *keys: str) -> set[str]:
    return {str(env["orders"][k].id) for k in keys}


def test_created_from_and_to_are_inclusive_and_use_the_lima_day(dated: dict[str, Any]) -> None:
    day = "2026-12-01"

    got = dates(dated, ("created_from", day), ("created_to", day))

    assert got == ids(dated, "start", "late_utc_day", "end")


def test_midnight_in_lima_starts_a_day_and_one_second_before_belongs_to_the_previous(
    dated: dict[str, Any],
) -> None:
    assert ids(dated, "start") <= dates(dated, ("created_from", "2026-12-01"))
    assert ids(dated, "before") & dates(dated, ("created_from", "2026-12-01")) == set()
    assert dates(dated, ("created_to", "2026-11-30")) == ids(dated, "before")
    assert dates(dated, ("created_from", "2026-11-30"), ("created_to", "2026-11-30")) == ids(
        dated, "before"
    )


def test_the_last_microsecond_of_the_day_is_in_and_the_next_midnight_is_out(
    dated: dict[str, Any],
) -> None:
    assert ids(dated, "end") <= dates(dated, ("created_to", "2026-12-01"))
    assert ids(dated, "after") & dates(dated, ("created_to", "2026-12-01")) == set()
    assert dates(dated, ("created_from", "2026-12-02"), ("created_to", "2026-12-02")) == ids(
        dated, "after"
    )


def test_an_order_late_in_the_lima_day_but_next_day_in_utc_counts_for_the_lima_day(
    dated: dict[str, Any],
) -> None:
    assert ids(dated, "late_utc_day") <= dates(dated, ("created_to", "2026-12-01"))
    assert ids(dated, "late_utc_day") & dates(dated, ("created_from", "2026-12-02")) == set()


def test_open_ranges_work_with_only_one_bound(dated: dict[str, Any]) -> None:
    assert dates(dated, ("created_from", "2026-12-01")) == ids(
        dated, "start", "late_utc_day", "end", "after"
    )
    assert dates(dated, ("created_to", "2026-12-01")) == ids(
        dated, "before", "start", "late_utc_day", "end"
    )
    assert dates(dated) == ids(dated, "before", "start", "late_utc_day", "end", "after")


def test_the_range_covers_several_days_and_total_matches(dated: dict[str, Any]) -> None:
    shop = dated["shop"]

    page = admin_page(
        shop,
        dated["admin"],
        ("q", dated["label"]),
        ("created_from", "2026-11-30"),
        ("created_to", "2026-12-02"),
    )

    assert page["total"] == 5 and len(page["items"]) == 5


def test_an_inverted_range_is_200_with_an_empty_page(dated: dict[str, Any]) -> None:
    response = admin_list(
        dated["shop"],
        dated["admin"],
        ("q", dated["label"]),
        ("created_from", "2026-12-05"),
        ("created_to", "2026-12-01"),
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "total": 0, "page": 1, "page_size": 20}


@pytest.mark.parametrize(
    "bad", ["2026-13-01", "2026-02-30", "31-12-2026", "12/31/2026", "abc", "2026-1-1x", "9999999"]
)
@pytest.mark.parametrize("field", ["created_from", "created_to"])
def test_an_invalid_date_is_422_with_the_query_location(
    shop: OrderShop, field: str, bad: str
) -> None:
    error_422(admin_list(shop, admin_of(shop), (field, bad)), field)


# --------------------------------------------------------------------------------------------
# filtros combinados
def test_status_q_and_dates_combine_with_and(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    day = lima("2026-12-01", "10:00:00")
    other_day = lima("2026-12-05", "10:00:00")
    hit = named_order(shop, shop.user(), f"Ana {label}", status="pagado")
    wrong_status = named_order(shop, shop.user(), f"Ana {label}", status="cancelado")
    wrong_day = named_order(shop, shop.user(), f"Ana {label}", status="pagado")
    wrong_name = named_order(shop, shop.user(), f"Luis {label}", status="pagado")
    for order, when in ((hit, day), (wrong_status, day), (wrong_day, other_day), (wrong_name, day)):
        set_created_at(shop.session, order.id, when)

    page = admin_page(
        shop,
        admin,
        ("status", "pagado"),
        ("q", f"ana {label}"),
        ("created_from", "2026-12-01"),
        ("created_to", "2026-12-01"),
    )

    assert found(page, hit)


def test_a_number_and_a_status_combine_with_and(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    order = named_order(shop, shop.user(), f"Ana {label}", status="pagado")
    number = format_order_number(order.number or 0)

    assert found(admin_page(shop, admin, ("q", number), ("status", "pagado")), order)
    assert admin_page(shop, admin, ("q", number), ("status", "cancelado"))["total"] == 0


# --------------------------------------------------------------------------------------------
# paginación y orden
def five(shop: OrderShop, label: str) -> list[Order]:
    """Cinco pedidos pagados, del más antiguo al más reciente."""
    return [
        named_order(shop, shop.user(), f"Ana {label}", minutes_ago=300 - 40 * n) for n in range(5)
    ]


def test_pages_split_the_list_newest_first_with_the_real_total(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    orders = five(shop, label)
    newest_first = [str(o.id) for o in reversed(orders)]

    pages = [
        admin_page(shop, admin, ("q", label), ("page", n), ("page_size", 2)) for n in (1, 2, 3)
    ]

    assert [ids_of(p) for p in pages] == [newest_first[0:2], newest_first[2:4], newest_first[4:5]]
    assert [p["total"] for p in pages] == [5, 5, 5]
    assert [(p["page"], p["page_size"]) for p in pages] == [(1, 2), (2, 2), (3, 2)]


def test_a_page_beyond_the_last_is_empty_with_the_real_total(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    five(shop, label)

    page = admin_page(shop, admin, ("q", label), ("page", 4), ("page_size", 2))

    assert page == {"items": [], "total": 5, "page": 4, "page_size": 2}
    assert admin_page(shop, admin, ("q", label), ("page", 1000))["items"] == []


def test_equal_creation_times_are_ordered_by_id_descending_and_pages_do_not_overlap(
    shop: OrderShop,
) -> None:
    admin, label = admin_of(shop), tag()
    orders = [named_order(shop, shop.user(), f"Ana {label}") for _ in range(5)]
    same = datetime(2026, 12, 1, 15, 0, tzinfo=UTC)
    for order in orders:
        set_created_at(shop.session, order.id, same)
    expected = [str(i) for i in sorted((o.id for o in orders), reverse=True)]

    whole = ids_of(admin_page(shop, admin, ("q", label)))
    paged = [
        i
        for n in (1, 2, 3)
        for i in ids_of(admin_page(shop, admin, ("q", label), ("page", n), ("page_size", 2)))
    ]

    assert whole == expected and paged == expected


def test_the_defaults_are_page_1_and_20_items_and_50_is_the_largest_page(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    for _ in range(22):
        named_order(shop, shop.user(), f"Ana {label}")

    default = admin_page(shop, admin, ("q", label))
    large = admin_page(shop, admin, ("q", label), ("page_size", 50))
    smallest = admin_page(shop, admin, ("q", label), ("page_size", 1))

    assert (default["page"], default["page_size"], len(default["items"])) == (1, 20, 20)
    assert (large["page_size"], len(large["items"]), large["total"]) == (50, 22, 22)
    assert len(smallest["items"]) == 1 and smallest["total"] == 22


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("page", "0"),
        ("page", "-1"),
        ("page", "1001"),
        ("page", "abc"),
        ("page", "1.5"),
        ("page_size", "0"),
        ("page_size", "51"),
        ("page_size", "-5"),
        ("page_size", "100000"),
        ("page_size", "abc"),
    ],
)
def test_page_and_page_size_out_of_range_are_422(shop: OrderShop, field: str, value: str) -> None:
    error_422(admin_list(shop, admin_of(shop), (field, value)), field)


def test_a_huge_page_number_is_422_and_cannot_force_a_large_offset(shop: OrderShop) -> None:
    error_422(admin_list(shop, admin_of(shop), ("page", "9" * 30)), "page")


def test_the_filters_do_not_change_the_order_or_leak_other_customers(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    mine = named_order(shop, shop.user(), f"Ana {label}", minutes_ago=100)
    newer = named_order(shop, shop.user(), f"Ana {label}", minutes_ago=10)
    named_order(shop, shop.user(), f"Luis {label}", minutes_ago=50)

    page = admin_page(shop, admin, ("q", f"ana {label}"))

    assert ids_of(page) == [str(newer.id), str(mine.id)] and page["total"] == 2


def test_undeclared_query_parameters_do_not_filter(shop: OrderShop) -> None:
    admin, label = admin_of(shop), tag()
    order = named_order(shop, shop.user(), f"Ana {label}")
    bogus: UUID = UUID(int=0)

    page = admin_page(shop, admin, ("q", label), ("user_id", str(bogus)), ("id", str(bogus)))

    assert found(page, order)
