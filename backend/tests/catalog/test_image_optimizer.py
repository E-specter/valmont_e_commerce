"""PillowImageOptimizer (T-018i, D-047/D-048): WebP optimizado y sin metadatos desde datos no
confiables. Las imágenes se generan con Pillow en cada prueba; la ausencia de metadatos se
comprueba además recorriendo los fragmentos RIFF a mano (`image_helpers.riff_chunks`).
"""

import ast
import io
import logging
from collections.abc import Callable
from importlib import metadata
from pathlib import Path

import pytest
from PIL import (
    Image,
    ImageFile,
    JpegImagePlugin,
    MpoImagePlugin,
    PngImagePlugin,
    WebPImagePlugin,
    features,
)

import valmont
from tests.catalog.catalog_helpers import tiny_png
from tests.catalog.image_helpers import (
    SECRETS,
    animated,
    assert_clean_webp,
    assert_no_metadata_when_reopened,
    corrupt_samples,
    encode,
    gradient,
    jpeg_declaring,
    jpeg_with_metadata,
    mpo_two_frames,
    png_declaring,
    png_with_alpha,
    png_with_metadata,
    reopen,
    riff_chunks,
    srgb_profile,
    to_srgb,
    webp_with_metadata,
    wide_gamut_profile,
)
from valmont.modules.catalog import application, domain
from valmont.modules.catalog.adapters.image_optimizer import PillowImageOptimizer
from valmont.modules.catalog.application import OptimizedImage
from valmont.modules.catalog.domain import (
    IMAGE_MAX_BYTES,
    IMAGE_MAX_PIXELS,
    IMAGE_MAX_SIDE,
    AnimatedImage,
    ImageDimensionsExceeded,
    InvalidImage,
)

Pixel = tuple[int, ...]


def optimize(data: bytes) -> OptimizedImage:
    return PillowImageOptimizer().optimize(data)


def rgba(data: bytes, xy: tuple[int, int]) -> Pixel:
    return reopen(data).convert("RGBA").getpixel(xy)  # type: ignore[return-value]


def near(actual: Pixel, expected: Pixel, tolerance: int = 10) -> bool:
    return all(abs(a - e) <= tolerance for a, e in zip(actual, expected, strict=False))


def assert_valid_output(result: OptimizedImage) -> Image.Image:
    """Lo que toda salida cumple: WebP limpio, tipo, tamaño y dimensiones coherentes."""
    assert isinstance(result.data, bytes) and result.content_type == "image/webp"
    assert_clean_webp(result.data)
    image = assert_no_metadata_when_reopened(result.data)
    assert (result.width, result.height) == image.size
    assert max(image.size) <= IMAGE_MAX_SIDE and len(result.data) <= IMAGE_MAX_BYTES
    return image


# --- Política del dominio y dependencia (casos 12 y 17) ---


def test_policy_constants_and_error_types_match_the_package() -> None:
    assert (IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, domain.IMAGE_EXTENSION) == (25_000_000, 2000, "webp")
    for error in (InvalidImage, ImageDimensionsExceeded, AnimatedImage):
        # Exception y no ValueError: Pydantic convertiría un ValueError en un 422 genérico.
        assert issubclass(error, Exception) and not issubclass(error, ValueError)
    assert len({InvalidImage, ImageDimensionsExceeded, AnimatedImage}) == 3
    assert not issubclass(InvalidImage, ImageDimensionsExceeded | AnimatedImage)


def test_pillow_is_pinned_to_13_0_0_with_webp_and_littlecms() -> None:
    assert metadata.version("pillow") == "13.0.0"
    assert features.check("webp") and features.check("littlecms2")
    assert features.check("jpg") and features.check("zlib")
    pyproject = Path(valmont.__file__).parents[2] / "pyproject.toml"
    assert '"pillow==13.0.0"' in pyproject.read_text(encoding="utf-8")


def _imports_pil(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):  # también las importaciones dentro de funciones
        if isinstance(node, ast.Import) and any(a.name.split(".")[0] == "PIL" for a in node.names):
            return True
        if isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "PIL":
            return True
        if isinstance(node, ast.Constant) and node.value in {"PIL", "PIL.Image"}:
            return True  # importlib.import_module("PIL")
    return False


def test_domain_and_application_do_not_import_pil_or_the_adapter() -> None:
    catalog = Path(domain.__file__).parent
    for name in ("domain.py", "application.py"):
        path = catalog / name
        assert not _imports_pil(path), f"{name} importa PIL (rompe la capa hexagonal)"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        modules = [n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
        assert not any("adapters" in m for m in modules), f"{name} importa un adaptador"


def test_only_the_adapter_imports_pil_in_the_whole_backend() -> None:
    root = Path(valmont.__file__).parent
    importers = {p.relative_to(root).as_posix() for p in root.rglob("*.py") if _imports_pil(p)}

    assert "modules/catalog/adapters/image_optimizer.py" in importers
    # Los compositores (admin_http, seed_dev) importan el adaptador, no PIL; se tolera si lo hacen.
    allowed = {
        "modules/catalog/adapters/image_optimizer.py",
        "modules/catalog/adapters/admin_http.py",
        "scripts/seed_dev.py",
    }
    assert importers <= allowed, f"PIL fuera de su sitio: {importers - allowed}"


def test_the_optimizer_satisfies_the_port() -> None:
    assert callable(getattr(application.ImageOptimizer, "optimize"))  # noqa: B009
    result = optimize(tiny_png())
    assert isinstance(result, OptimizedImage) and result.content_type == "image/webp"
    with pytest.raises(AttributeError):  # frozen dataclass
        result.width = 99  # type: ignore[misc]


# --- Metadatos y orientación (casos 1, 2 y 4) ---


def test_jpeg_with_gps_orientation_6_comes_out_rotated_and_without_any_metadata() -> None:
    source = jpeg_with_metadata((300, 200), orientation=6)

    result = optimize(source)

    image = assert_valid_output(result)
    assert image.size == (200, 300)  # lados intercambiados
    # La esquina roja (arriba a la izquierda en el archivo) queda arriba a la derecha al girar 90°.
    assert near(rgba(result.data, (160, 40)), (255, 0, 0, 255), 25)
    assert near(rgba(result.data, (40, 40)), (0, 0, 255, 255), 25)
    assert near(rgba(result.data, (100, 250)), (0, 0, 255, 255), 25)
    assert all(secret not in result.data for secret in SECRETS)
    assert source not in result.data and result.data != source  # el original no se conserva


@pytest.mark.parametrize("orientation", range(1, 9))
def test_every_exif_orientation_is_applied_and_dropped(orientation: int) -> None:
    result = optimize(jpeg_with_metadata((300, 200), orientation=orientation))

    expected = (200, 300) if orientation >= 5 else (300, 200)
    assert assert_valid_output(result).size == expected


SOURCES = {
    "jpeg": lambda: jpeg_with_metadata(),
    "png-text-exif-icc": png_with_metadata,
    "webp-exif-xmp-icc": webp_with_metadata,
    "png-alpha": png_with_alpha,
    "mpo": mpo_two_frames,
    "tiny-png": tiny_png,
}


@pytest.mark.parametrize("make", SOURCES.values(), ids=SOURCES.keys())
def test_output_never_carries_exif_xmp_icc_or_text_chunks(make: Callable[[], bytes]) -> None:
    assert_valid_output(optimize(make()))


def test_png_exif_orientation_is_honoured_and_text_chunks_are_dropped() -> None:
    result = optimize(png_with_metadata())  # 40×30 con orientación 6 en eXIf

    assert assert_valid_output(result).size == (30, 40)


def test_an_already_optimized_webp_is_re_encoded_without_its_metadata() -> None:
    source = webp_with_metadata((120, 80))
    assert {b"EXIF", b"XMP ", b"ICCP"} <= set(riff_chunks(source))

    result = optimize(source)

    assert assert_valid_output(result).size == (120, 80)  # no se exige que pese menos


def test_optimizing_twice_is_stable_and_still_clean() -> None:
    again = optimize(optimize(jpeg_with_metadata()).data)

    assert assert_valid_output(again).size == (200, 300)


def test_an_opaque_photo_is_lossy_rgb_and_gets_no_alpha_chunk() -> None:
    result = optimize(encode(gradient(300, 200), "JPEG", quality=90))

    ids = assert_clean_webp(result.data)
    assert b"VP8 " in ids and b"ALPH" not in ids  # con pérdida y sin transparencia
    assert reopen(result.data).mode == "RGB"


# --- Transparencia (caso 3) ---


def test_png_with_alpha_keeps_a_transparent_and_an_opaque_pixel() -> None:
    result = optimize(png_with_alpha((64, 48)))

    ids = assert_clean_webp(result.data)
    assert b"ALPH" in ids and b"VP8X" in ids
    assert reopen(result.data).mode == "RGBA"
    assert rgba(result.data, (4, 24))[3] <= 8  # mitad izquierda transparente
    assert near(rgba(result.data, (60, 24)), (255, 0, 0, 255), 10)


def test_palette_png_with_transparency_keeps_the_alpha() -> None:
    image = Image.new("P", (32, 32), 0)
    image.putpalette([0, 0, 0, 255, 0, 0, 0, 0, 255] + [0] * 759)
    image.paste(1, (16, 0, 32, 32))
    result = optimize(encode(image, "PNG", transparency=0))  # el índice 0 es transparente

    assert assert_valid_output(result) and rgba(result.data, (4, 16))[3] <= 8
    assert rgba(result.data, (28, 16))[3] >= 247


def test_rgb_png_with_a_color_key_transparency_keeps_the_alpha() -> None:
    image = Image.new("RGB", (32, 32), (0, 0, 255))
    image.paste((255, 0, 0), (0, 0, 16, 32))
    result = optimize(encode(image, "PNG", transparency=(255, 0, 0)))

    assert assert_valid_output(result)
    assert rgba(result.data, (4, 16))[3] <= 8 and rgba(result.data, (28, 16))[3] >= 247


def test_gray_with_alpha_png_keeps_the_alpha() -> None:
    image = Image.new("LA", (32, 32), (120, 255))
    image.paste((120, 0), (0, 0, 16, 32))
    result = optimize(encode(image, "PNG"))

    assert assert_valid_output(result)
    assert rgba(result.data, (4, 16))[3] <= 8 and rgba(result.data, (28, 16))[3] >= 247


@pytest.mark.parametrize("mode", ["L", "1", "RGB", "RGBA", "LA", "P", "I;16"])
def test_png_in_any_common_mode_is_accepted(mode: str) -> None:
    image = Image.new(mode, (24, 18))
    result = optimize(encode(image, "PNG"))

    assert assert_valid_output(result).size == (24, 18)


def test_cmyk_jpeg_without_profile_is_converted_to_rgb() -> None:
    cyan = Image.new("CMYK", (32, 32), (255, 0, 0, 0))
    white = Image.new("CMYK", (32, 32), (0, 0, 0, 0))

    cyan_out, white_out = (
        optimize(encode(cyan, "JPEG", quality=95)),
        optimize(encode(white, "JPEG")),
    )

    assert assert_valid_output(cyan_out) and assert_valid_output(white_out)
    assert reopen(cyan_out.data).mode == "RGB"
    assert near(rgba(cyan_out.data, (16, 16)), (0, 255, 255, 255), 25)
    assert near(rgba(white_out.data, (16, 16)), (255, 255, 255, 255), 12)


# --- Color (caso 11) ---


def flat(color: tuple[int, int, int], profile: bytes | None, fmt: str = "JPEG") -> bytes:
    options: dict[str, object] = {"icc_profile": profile} if profile else {}
    if fmt == "JPEG":
        options["quality"] = 95
    return encode(Image.new("RGB", (64, 64), color), fmt, **options)


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "WEBP"])
def test_a_wide_gamut_icc_is_converted_to_srgb_and_not_written(fmt: str) -> None:
    profile, color = wide_gamut_profile(), (200, 100, 50)
    expected = to_srgb(color, profile)
    assert (
        max(abs(a - b) for a, b in zip(expected, color, strict=True)) > 15
    )  # la prueba discrimina

    result = optimize(flat(color, profile, fmt))

    assert assert_valid_output(result)
    assert near(rgba(result.data, (32, 32))[:3], expected, 12), "no se convirtió a sRGB"
    assert not near(rgba(result.data, (32, 32))[:3], color, 8), "solo se descartó el perfil"
    assert b"ICCP" not in riff_chunks(result.data)


def test_an_srgb_icc_leaves_the_color_unchanged_and_is_not_written() -> None:
    color = (200, 100, 50)

    result = optimize(flat(color, srgb_profile()))

    assert assert_valid_output(result)
    assert near(rgba(result.data, (32, 32))[:3], color, 10)


def test_an_image_without_icc_is_assumed_srgb() -> None:
    color = (30, 140, 220)

    result = optimize(flat(color, None, "PNG"))

    assert near(rgba(result.data, (32, 32))[:3], color, 10)


@pytest.mark.parametrize("fmt", ["JPEG", "PNG"])
def test_a_corrupt_icc_does_not_break_the_upload_and_is_assumed_srgb(fmt: str) -> None:
    color = (200, 100, 50)

    result = optimize(flat(color, b"no soy un perfil icc" * 8, fmt))

    assert assert_valid_output(result)
    assert near(rgba(result.data, (32, 32))[:3], color, 10)


# --- Tamaño (casos 9 y 10) ---


@pytest.mark.parametrize(
    ("size", "expected"),
    [
        ((4000, 3000), (2000, 1500)),
        ((3000, 4000), (1500, 2000)),
        ((2000, 1000), (2000, 1000)),  # justo en el tope: no se toca
        ((2000, 2000), (2000, 2000)),
        ((800, 600), (800, 600)),  # nunca se amplía
        ((1, 1), (1, 1)),
        ((30, 2000), (30, 2000)),
    ],
)
def test_large_images_are_reduced_to_2000_px_and_small_ones_are_not_enlarged(
    size: tuple[int, int], expected: tuple[int, int]
) -> None:
    result = optimize(encode(gradient(*size, noise=8), "JPEG", quality=80))

    assert (result.width, result.height) == expected
    assert assert_valid_output(result).size == expected


def test_a_very_wide_image_keeps_its_proportion() -> None:
    result = optimize(png_declaring(20000, 1000))  # 20 MP, bajo el tope

    assert (result.width, result.height) == (2000, 100)


def test_the_limit_applies_after_rotating() -> None:
    result = optimize(jpeg_with_metadata((3000, 2000), orientation=6))

    assert abs(result.width - 1333) <= 1 and result.height == 2000
    assert_valid_output(result)


def test_a_q95_jpeg_comes_out_smaller_than_it_went_in() -> None:
    source = encode(gradient(3000, 2000), "JPEG", quality=95)
    assert len(source) < IMAGE_MAX_BYTES

    result = optimize(source)

    assert_valid_output(result)
    assert len(result.data) < len(source)


# --- JPEG MPO (caso 8) ---


def test_a_phone_mpo_jpeg_is_accepted_with_its_first_frame_only() -> None:
    result = optimize(mpo_two_frames())

    image = assert_valid_output(result)
    assert image.size == (64, 48) and getattr(image, "n_frames", 1) == 1
    assert near(rgba(result.data, (32, 24)), (255, 0, 0, 255), 12)  # primer fotograma, no el azul


# --- Animadas (caso 8) ---


@pytest.mark.parametrize("fmt", ["PNG", "WEBP"], ids=["apng", "animated-webp"])
def test_an_animated_png_or_webp_is_animated_image(fmt: str) -> None:
    source = animated(fmt)
    assert Image.open(io.BytesIO(source)).n_frames > 1  # el fixture sí es animado

    with pytest.raises(AnimatedImage):
        optimize(source)


def test_a_gif_never_reaches_the_decoder_even_if_it_gets_to_the_optimizer() -> None:
    # La puerta es image_format (415); además, `formats=` cierra el paso a Pillow.
    with pytest.raises(InvalidImage):
        optimize(animated("GIF"))


@pytest.mark.parametrize("fmt", ["BMP", "TIFF", "GIF", "PPM", "ICO", "TGA"])
def test_formats_outside_jpeg_png_webp_are_not_decoded(fmt: str) -> None:
    with pytest.raises(InvalidImage):
        optimize(encode(Image.new("RGB", (16, 16), (1, 2, 3)), fmt))


# --- Archivos corruptos (caso 6) ---

PILLOW_WORDS = ("PIL", "Pillow", "cannot identify", "BytesIO", "truncated", "broken", "\\x")


@pytest.mark.parametrize("name", list(corrupt_samples()))
def test_corrupt_or_truncated_files_are_invalid_image_without_leaking_pillow_text(
    name: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    with pytest.raises(InvalidImage) as raised:
        optimize(corrupt_samples()[name])

    texts = [str(raised.value), *(r.getMessage() for r in caplog.records)]
    for text in texts:
        assert not any(word in text for word in PILLOW_WORDS), text
    assert ImageFile.LOAD_TRUNCATED_IMAGES is False  # una truncada no se "tolera"


def test_random_bytes_and_empty_input_are_rejected_not_crashed() -> None:
    for junk in (b"", b"\x00" * 64, b"RIFF", b"\x89PNG", bytes(range(256))):
        with pytest.raises(InvalidImage):
            optimize(junk)


def test_a_valid_header_with_trailing_garbage_is_still_accepted() -> None:
    # Basura tras el final del archivo (IEND/EOI): no es una imagen corrupta ni llega a la salida.
    for source in (tiny_png(), encode(gradient(64, 48), "JPEG")):
        assert_valid_output(optimize(source + b"\x00garbage-after-end" * 100))


# --- Bomba de píxeles (caso 7) ---


class LoadSpy:
    """Cuenta las llamadas a `load()` de las clases de Pillow que decodifican."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls = 0
        classes = (
            Image.Image,
            ImageFile.ImageFile,
            PngImagePlugin.PngImageFile,
            JpegImagePlugin.JpegImageFile,
            MpoImagePlugin.MpoImageFile,
            WebPImagePlugin.WebPImageFile,
        )
        for cls in classes:
            monkeypatch.setattr(cls, "load", self._wrap(cls.load))

    def _wrap(self, original: Callable[..., object]) -> Callable[..., object]:
        def spy(image: object, *args: object, **kwargs: object) -> object:
            self.calls += 1
            return original(image, *args, **kwargs)

        return spy


def test_the_load_spy_sees_a_normal_decode(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LoadSpy(monkeypatch)

    optimize(tiny_png())

    assert spy.calls > 0  # sin esto, «0 llamadas» en la bomba no probaría nada


@pytest.mark.parametrize(
    "make",
    [
        lambda: png_declaring(5000, 6000),  # 30 MP, unos KiB
        lambda: png_declaring(5001, 5000),  # un píxel-columna por encima del tope
        lambda: png_declaring(20000, 10000),  # 200 MP: DecompressionBombError del propio Pillow
        lambda: jpeg_declaring(8000, 8000),  # 64 MP declarados en la cabecera
        lambda: jpeg_declaring(65535, 65535),  # 4 GP
    ],
    ids=["png-30mp", "png-over-by-5000px", "png-200mp", "jpeg-64mp", "jpeg-4gp"],
)
def test_a_pixel_bomb_is_rejected_without_decoding_it(
    make: Callable[[], bytes], monkeypatch: pytest.MonkeyPatch
) -> None:
    source = make()
    assert len(source) < IMAGE_MAX_BYTES  # cabe en los 5 MiB: sin esta puerta pasaría
    spy = LoadSpy(monkeypatch)
    limit = Image.MAX_IMAGE_PIXELS

    with pytest.raises(ImageDimensionsExceeded):
        optimize(source)

    assert spy.calls == 0, "se decodificó la imagen antes de comprobar su tamaño"
    assert Image.MAX_IMAGE_PIXELS == limit  # el ajuste global de Pillow no se toca


def test_exactly_25_megapixels_is_accepted() -> None:
    result = optimize(png_declaring(5000, 5000))

    assert IMAGE_MAX_PIXELS == 5000 * 5000
    assert (result.width, result.height) == (2000, 2000)
    assert_valid_output(result)


def test_process_wide_pillow_limits_are_left_as_they_were() -> None:
    limit = Image.MAX_IMAGE_PIXELS

    optimize(tiny_png())
    with pytest.raises(InvalidImage):
        optimize(corrupt_samples()["png-truncated"])

    assert Image.MAX_IMAGE_PIXELS == limit and ImageFile.LOAD_TRUNCATED_IMAGES is False
