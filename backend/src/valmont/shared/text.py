"""Filtro común del texto de entrada (T-018d): sin controles, bidi ni invisibles."""

import unicodedata

# Rellenos que se ven como vacío pero no son Cf ni Z*: Braille en blanco, Hangul, Khmer, CGJ.
_INVISIBLE_FILL = frozenset("\u2800\u3164\uffa0\u115f\u1160\u17b4\u17b5\u034f")


def has_unsafe_chars(text: str, allow: str = "") -> bool:
    """Cc (NUL rompe un text de PostgreSQL), Cs (no es UTF-8), Cf (bidi, ancho cero) o relleno.

    `allow` exime caracteres concretos, p. ej. "\n" en notas y descripciones.
    """
    return any(
        c not in allow and (unicodedata.category(c) in ("Cc", "Cs", "Cf") or c in _INVISIBLE_FILL)
        for c in text
    )


def has_visible_char(text: str) -> bool:
    """Hay algún carácter que no es espacio (Z*), control (C*) ni relleno invisible."""
    return any(unicodedata.category(c)[0] not in "ZC" and c not in _INVISIBLE_FILL for c in text)
