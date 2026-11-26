from enum import StrEnum

WISHLIST_MAX_ITEMS = 50  # WISH-R4: tope blando, lo impone el caso de uso


class WishlistFull(Exception):
    """La lista ya tiene el máximo de artículos."""


class WishlistItemStatus(StrEnum):
    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
