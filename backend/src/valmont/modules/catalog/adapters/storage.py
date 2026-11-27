"""ImageStorage sobre la API de Supabase Storage (D-019), con la clave de servicio del backend."""

import logging
from collections.abc import Iterator
from datetime import datetime
from urllib.parse import quote

import httpx

from valmont.modules.catalog.application import StorageUnavailable, StoredFile

logger = logging.getLogger(__name__)

# Sin timeout, una subida colgada retendría la solicitud (y el bloqueo del producto) sin límite.
TIMEOUT = httpx.Timeout(10.0, connect=3.0)
LIST_PAGE = 100


class SupabaseImageStorage:
    def __init__(
        self,
        supabase_url: str,
        service_key: str,
        bucket: str = "products",
        transport: httpx.BaseTransport | None = None,  # las pruebas pasan un MockTransport
    ) -> None:
        self._base = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}"
        self._list_url = f"{supabase_url.rstrip('/')}/storage/v1/object/list/{bucket}"
        # La clave salta RLS: solo viaja en estas cabeceras hacia Storage, nunca a un log.
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
            timeout=TIMEOUT,
            follow_redirects=False,  # una redirección no se sigue: es un fallo
            transport=transport,
        )

    def put(self, path: str, data: bytes, content_type: str) -> None:
        self._send("POST", path, data, {"Content-Type": content_type})

    def delete(self, path: str) -> None:
        self._send("DELETE", path)

    def list_files(self) -> Iterator[StoredFile]:
        """Archivos del bucket: raíz y una carpeta por producto. Las carpetas no traen `id`."""
        for entry in self._list(""):
            if entry.get("id") is None:  # carpeta
                for inner in self._list(entry["name"]):
                    yield from self._file(inner, f"{entry['name']}/")
            else:
                yield from self._file(entry, "")

    @staticmethod
    def _file(entry: dict, prefix: str) -> Iterator[StoredFile]:
        # Sin `id` (carpeta anidada) o sin fecha no hay gracia segura: no se considera archivo.
        if entry.get("id") is not None and entry.get("created_at"):
            yield StoredFile(prefix + entry["name"], datetime.fromisoformat(entry["created_at"]))

    def _list(self, prefix: str) -> Iterator[dict]:
        offset = 0
        while True:
            body = {"prefix": prefix, "limit": LIST_PAGE, "offset": offset}
            try:
                response = self._client.post(self._list_url, json=body)
            except httpx.HTTPError as exc:
                logger.warning("Supabase Storage inalcanzable (LIST %s)", type(exc).__name__)
                raise StorageUnavailable from None
            if not response.is_success:
                logger.warning("Supabase Storage respondió %s a LIST", response.status_code)
                raise StorageUnavailable
            page = response.json()
            yield from page
            if len(page) < LIST_PAGE:
                return
            offset += LIST_PAGE

    def _send(
        self,
        method: str,
        path: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        url = f"{self._base}/{quote(path)}"
        try:
            response = self._client.request(method, url, content=data, headers=headers)
        except httpx.HTTPError as exc:
            logger.warning("Supabase Storage inalcanzable (%s %s)", method, type(exc).__name__)
            raise StorageUnavailable from None
        if not response.is_success:  # el cuerpo de Storage no se registra ni se devuelve
            logger.warning("Supabase Storage respondió %s a %s", response.status_code, method)
            raise StorageUnavailable
