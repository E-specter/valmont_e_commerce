"""Imágenes de prueba para T-018i, generadas con Pillow en cada prueba (ninguna foto real).

Los marcadores de metadatos ("secret") son textos reconocibles: si aparecen en la salida, el
metadato se coló, sin importar qué lea Pillow. `riff_chunks` recorre el contenedor WebP a mano,
independiente de Pillow.
"""

import io
import struct
import zlib
from dataclasses import dataclass

from PIL import ExifTags, Image, ImageCms, PngImagePlugin

from valmont.modules.catalog.application import OptimizedImage

ALLOWED_CHUNKS = {b"VP8X", b"VP8 ", b"VP8L", b"ALPH"}
FORBIDDEN_CHUNKS = {b"EXIF", b"XMP ", b"ICCP", b"ANIM", b"ANMF"}
# Textos que cada fixture escribe en sus metadatos; ninguno puede sobrevivir en la salida.
SECRETS = (b"ValmontCam", b"cmt-secret", b"xmp-secret", b"desc-secret", b"autor-secret")


# --- Contenedor WebP, sin Pillow ---


def riff_chunks(data: bytes) -> list[bytes]:
    """Identificadores de los fragmentos de un WebP. Valida el RIFF y los tamaños."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "no es un contenedor RIFF/WEBP"
    assert struct.unpack("<I", data[4:8])[0] == len(data) - 8, "tamaño RIFF incoherente"
    ids, pos = [], 12
    while pos < len(data):
        assert pos + 8 <= len(data), "fragmento truncado"
        size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        ids.append(data[pos : pos + 4])
        pos += 8 + size + (size & 1)  # el relleno de un byte si el tamaño es impar
    assert pos == len(data), "los fragmentos no cuadran con el tamaño del archivo"
    return ids


def assert_clean_webp(data: bytes) -> list[bytes]:
    """Un WebP sin metadatos ni animación: solo VP8X, VP8 , VP8L y ALPH. Devuelve los fragmentos."""
    ids = riff_chunks(data)
    assert ids, "WebP sin fragmentos"
    assert set(ids) <= ALLOWED_CHUNKS, f"fragmentos no permitidos: {set(ids) - ALLOWED_CHUNKS}"
    assert not set(ids) & FORBIDDEN_CHUNKS
    assert any(i in ids for i in (b"VP8 ", b"VP8L")), "sin datos de imagen"
    for secret in SECRETS:
        assert secret not in data, f"el marcador {secret!r} sobrevive en la salida"
    assert b"Exif" not in data and b"<x:xmpmeta" not in data and b"JFIF" not in data
    return ids


def reopen(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


def assert_no_metadata_when_reopened(data: bytes) -> Image.Image:
    image = reopen(data)
    assert image.format == "WEBP"
    assert len(image.getexif()) == 0
    assert "icc_profile" not in image.info and "xmp" not in image.info and "exif" not in image.info
    return image


# --- Perfiles de color ---


def srgb_profile() -> bytes:
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def _s15(value: float) -> bytes:
    return struct.pack(">i", round(value * 65536))


def _xyz(x: float, y: float, z: float) -> bytes:
    return b"XYZ \0\0\0\0" + _s15(x) + _s15(y) + _s15(z)


def wide_gamut_profile() -> bytes:
    """Perfil ICC v2 de matriz y gamma 2,2 con las primarias de Display P3 (adaptadas a D50)."""
    primaries = [(0.5151, 0.2412, -0.0011), (0.2920, 0.6922, 0.0419), (0.1571, 0.0666, 0.7841)]
    curve = b"curv\0\0\0\0" + struct.pack(">IH", 1, round(2.2 * 256)) + b"\0\0"
    name = b"Prueba P3"
    description = b"desc\0\0\0\0" + struct.pack(">I", len(name) + 1) + name + b"\0" + b"\0" * 78
    tags = {
        b"desc": description,
        b"wtpt": _xyz(0.9642, 1.0, 0.8249),
        b"rXYZ": _xyz(*primaries[0]),
        b"gXYZ": _xyz(*primaries[1]),
        b"bXYZ": _xyz(*primaries[2]),
        b"rTRC": curve,
        b"gTRC": curve,
        b"bTRC": curve,
        b"cprt": b"text\0\0\0\0Prueba\0",
    }
    offset, table, body = 128 + 4 + 12 * len(tags), b"", b""
    for signature, tag in tags.items():
        table += signature + struct.pack(">II", offset + len(body), len(tag))
        body += tag + b"\0" * (-len(tag) % 4)
    header = struct.pack(
        ">I4sI4s4s4s", offset + len(body), b"lcms", 0x02400000, b"mntr", b"RGB ", b"XYZ "
    )
    header += (
        b"\0" * 12 + b"acsp" + b"\0" * 28
    )  # firma, plataforma, indicadores, fabricante, modelo, atributos, intención
    header += _s15(0.9642) + _s15(1.0) + _s15(0.8249) + b"\0" * 48  # iluminante D50, creador, id
    assert len(header) == 128
    return header + struct.pack(">I", len(tags)) + table + body


def to_srgb(pixel: tuple[int, int, int], profile: bytes) -> tuple[int, int, int]:
    """Lo que debería dar `pixel` al pasar de `profile` a sRGB (oráculo con littleCMS)."""
    source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
    converted = ImageCms.profileToProfile(
        Image.new("RGB", (4, 4), pixel), source, ImageCms.createProfile("sRGB")
    )
    return converted.getpixel((1, 1))  # type: ignore[return-value]


# --- Generadores ---


def gradient(width: int, height: int, noise: int = 12) -> Image.Image:
    """Degradado con ruido suave: se comprime como una foto, sin pasar de unos pocos MiB."""
    red = Image.linear_gradient("L").resize((width, height))
    green = Image.linear_gradient("L").rotate(90).resize((width, height))
    return Image.merge("RGB", (red, green, Image.effect_noise((width, height), noise)))


def encode(image: Image.Image, fmt: str, **options: object) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, fmt, **options)
    return buffer.getvalue()


def exif_with_secrets(orientation: int = 6) -> Image.Exif:
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "ValmontCam"  # Make
    exif[0x010E] = "desc-secret"  # ImageDescription
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[1], gps[2], gps[3], gps[4] = "S", (12.0, 3.0, 4.0), "W", (77.0, 1.0, 2.0)
    return exif


def jpeg_with_metadata(
    size: tuple[int, int] = (300, 200), orientation: int = 6, icc: bytes | None = None
) -> bytes:
    """JPEG con EXIF (GPS, Make, descripción, orientación), comentario, XMP e ICC.

    Esquina superior izquierda roja (80×80) y el resto azul: sirve para ver hacia dónde gira.
    """
    image = Image.new("RGB", size, (0, 0, 255))
    image.paste((255, 0, 0), (0, 0, 80, 80))
    data = encode(
        image,
        "JPEG",
        quality=95,
        exif=exif_with_secrets(orientation),
        comment=b"cmt-secret",
        xmp=b"<x:xmpmeta>xmp-secret</x:xmpmeta>",
        icc_profile=icc or srgb_profile(),
    )
    source = Image.open(io.BytesIO(data))
    assert source.getexif().get_ifd(ExifTags.IFD.GPSInfo), "el fixture perdió el GPS"
    assert source.getexif()[0x0112] == orientation and b"ValmontCam" in data
    assert b"cmt-secret" in data and b"xmp-secret" in data and "icc_profile" in source.info
    return data


def png_with_alpha(size: tuple[int, int] = (64, 48)) -> bytes:
    """RGBA: mitad izquierda transparente, mitad derecha roja opaca."""
    image = Image.new("RGBA", size, (255, 0, 0, 255))
    image.paste((0, 0, 0, 0), (0, 0, size[0] // 2, size[1]))
    return encode(image, "PNG")


def png_with_metadata() -> bytes:
    info = PngImagePlugin.PngInfo()
    info.add_text("Author", "autor-secret")
    return encode(
        Image.new("RGB", (40, 30), (10, 120, 200)),
        "PNG",
        pnginfo=info,
        exif=exif_with_secrets(),
        icc_profile=srgb_profile(),
    )


def webp_with_metadata(size: tuple[int, int] = (120, 80)) -> bytes:
    data = encode(
        gradient(*size),
        "WEBP",
        quality=80,
        exif=exif_with_secrets(1),
        xmp=b"<x:xmpmeta>xmp-secret</x:xmpmeta>",
        icc_profile=srgb_profile(),
    )
    assert {b"EXIF", b"XMP ", b"ICCP"} <= set(riff_chunks(data)), "el fixture perdió metadatos"
    return data


def mpo_two_frames(size: tuple[int, int] = (64, 48)) -> bytes:
    """JPEG MPO de dos imágenes como el de un móvil: primer fotograma rojo, segundo azul."""
    first, second = Image.new("RGB", size, (255, 0, 0)), Image.new("RGB", size, (0, 0, 255))
    data = encode(first, "MPO", save_all=True, append_images=[second])
    probe = Image.open(io.BytesIO(data))
    assert data.startswith(b"\xff\xd8\xff") and probe.format == "MPO" and probe.n_frames == 2
    return data


def _frames(size: tuple[int, int] = (64, 48)) -> tuple[Image.Image, list[Image.Image]]:
    colors = [(255, 0, 0), (0, 255, 0), (0, 0, 255)]
    first, *rest = (Image.new("RGB", size, color) for color in colors)
    return first, rest


def animated(fmt: str) -> bytes:
    first, rest = _frames()
    return encode(first, fmt, save_all=True, append_images=rest, duration=100, loop=0)


def png_declaring(width: int, height: int) -> bytes:
    """PNG gris de 8 bits válido, todo ceros: unos KiB que declaran `width`×`height` píxeles."""

    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(kind + payload)
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    compressor, row = zlib.compressobj(9), bytes(width + 1)  # filtro 0 + píxeles a cero
    pixels = b"".join(compressor.compress(row) for _ in range(height)) + compressor.flush()
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", pixels) + chunk(b"IEND", b"")
    )


def jpeg_declaring(width: int, height: int) -> bytes:
    """JPEG minúsculo cuya cabecera (SOF) se reescribe para declarar `width`×`height`."""
    data = bytearray(encode(Image.new("RGB", (16, 16), (90, 90, 90)), "JPEG"))
    sof = data.index(b"\xff\xc0")  # SOF0: marca, longitud(2), precisión(1), alto(2), ancho(2)
    data[sof + 5 : sof + 9] = struct.pack(">HH", height, width)
    return bytes(data)


def corrupt_samples() -> dict[str, bytes]:
    good_png, good_jpeg = encode(gradient(200, 150), "PNG"), encode(gradient(200, 150), "JPEG")
    return {
        "jpeg-header-plus-garbage": b"\xff\xd8\xff\xe0" + b"basura sin estructura" * 50,
        "jpeg-only-signature": b"\xff\xd8\xff",
        "jpeg-truncated": good_jpeg[: len(good_jpeg) // 2],
        "png-truncated": good_png[: len(good_png) // 2],
        "png-only-signature": b"\x89PNG\r\n\x1a\n",
        "png-bad-crc": good_png[:40] + b"\x00\x00\x00\x00" + good_png[44:],
        "webp-header-plus-garbage": b"RIFF\x20\x00\x00\x00WEBPVP8 " + b"\xaa" * 40,
        "webp-truncated": encode(gradient(200, 150), "WEBP")[:60],
    }


# --- Fakes del puerto ImageOptimizer ---


@dataclass
class PassthroughOptimizer:
    """Devuelve la entrada tal cual como si fuera WebP: para las pruebas que no son de Pillow."""

    def optimize(self, data: bytes) -> OptimizedImage:
        return OptimizedImage(data, 1, 1)


class RecordingOptimizer:
    """Anota cada llamada (en un registro compartido si se le da uno) y devuelve `result`."""

    def __init__(
        self,
        calls: list[tuple[object, ...]] | None = None,
        result: OptimizedImage | None = None,
        error: Exception | None = None,
    ) -> None:
        self.calls: list[tuple[object, ...]] = calls if calls is not None else []
        self.inputs: list[bytes] = []
        self.result = result or OptimizedImage(b"RIFF\x04\x00\x00\x00WEBP", 1, 1)
        self.error = error

    def optimize(self, data: bytes) -> OptimizedImage:
        self.calls.append(("optimizer.optimize",))
        self.inputs.append(data)
        if self.error:
            raise self.error
        return self.result
