"""Valores de T-018c compartidos por las pruebas de `Idempotency-Key` (orders y payments).

El patrón se repite aquí a propósito: si el código cambia el suyo sin pasar por el contrato
(SPEC de orders §7 y de payments §7), las pruebas de contrato fallan."""

IDEMPOTENCY_KEY_PATTERN = r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"
VALID_UUID = "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c"

# Valores que no son un UUID: un PAN y sus variantes, vacío, sin guiones, con prefijo, espacios.
# Los números de tarjeta son los de prueba públicos de las pasarelas.
PAN = "4111111111111111"
BAD_KEYS: dict[str, str] = {
    "pan-16": PAN,
    "pan-con-guiones": "4111-1111-1111-1111",
    "16-caracteres": "abcdefghijklmnop",
    "vacia": "",
    "sin-guiones": "3f2b8c1e5a4d4e7b9c061d2e3f4a5b6c",
    "urn": "urn:uuid:3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c",
    "llaves": "{3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c}",
    "espacio-al-final": "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c ",
    "espacio-al-inicio": " 3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c",
    "espacio-dentro": "3f2b8c1e 5a4d-4e7b-9c06-1d2e3f4a5b6c",
    "37-caracteres": "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6c0",
    "35-caracteres": "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6",
    "no-hex": "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6g",
    "guion-bajo": "3f2b8c1e_5a4d_4e7b_9c06_1d2e3f4a5b6c",
    "agrupado-distinto": "3f2b8c1e5-a4d-4e7b-9c06-1d2e3f4a5b6c",
    "salto-de-linea": "3f2b8c1e-5a4d-4e7b-9c06-1d2e3f4a5b6\n",
    "sql": "'; DROP TABLE app.orders; --------",
}
