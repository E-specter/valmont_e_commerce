"""Optimizador de imágenes con Pillow (T-018i, D-047, D-048): WebP sin metadatos."""

import io

from PIL import Image, ImageCms, ImageFile, ImageOps, UnidentifiedImageError

from valmont.modules.catalog.application import OptimizedImage
from valmont.modules.catalog.domain import (
    IMAGE_MAX_PIXELS,
    IMAGE_MAX_SIDE,
    AnimatedImage,
    ImageDimensionsExceeded,
    InvalidImage,
)

_FORMATS = ("JPEG", "PNG", "WEBP")
_QUALITY = 82
_METHOD = 4  # method=6 ahorra ~3 % a ~3x de CPU en una subida síncrona
_ALPHA_MODES = {"RGBA", "LA", "PA"}
_SRGB = ImageCms.createProfile("sRGB")
_DECODE_ERRORS = (UnidentifiedImageError, OSError, SyntaxError, ValueError, EOFError)


def _to_srgb(im: Image.Image) -> Image.Image:
    """Con ICC no sRGB convierte al espacio sRGB; un perfil roto se trata como sRGB."""
    alpha = im.mode in _ALPHA_MODES or "transparency" in im.info
    target = "RGBA" if alpha else "RGB"
    icc = im.info.get("icc_profile")
    if icc and im.mode not in ("L", "LA", "P", "PA"):
        try:
            profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            if im.mode in ("RGB", "RGBA", "CMYK"):
                return ImageCms.profileToProfile(im, profile, _SRGB, outputMode=im.mode).convert(
                    target
                )
        except ImageCms.PyCMSError, OSError:  # ICC roto: se asume sRGB
            pass
    return im.convert(target)


class PillowImageOptimizer:
    def optimize(self, data: bytes) -> OptimizedImage:
        # Pillow no ofrece tope de tiempo y su mensaje no se expone ni se registra (R-7).
        if ImageFile.LOAD_TRUNCATED_IMAGES:  # nadie debe activarlo: una truncada es 422
            ImageFile.LOAD_TRUNCATED_IMAGES = False
        try:
            Image.open(io.BytesIO(data), formats=_FORMATS).verify()
            with Image.open(io.BytesIO(data), formats=_FORMATS) as im:  # verify() lo inutiliza
                width, height = im.size
                if width * height > IMAGE_MAX_PIXELS:  # solo cabecera, sin decodificar
                    raise ImageDimensionsExceeded
                if im.format not in ("JPEG", "MPO") and getattr(im, "n_frames", 1) > 1:
                    raise AnimatedImage
                im.load()
                im = ImageOps.exif_transpose(im)
                im = _to_srgb(im)
                im.thumbnail((IMAGE_MAX_SIDE, IMAGE_MAX_SIDE), Image.Resampling.LANCZOS, 2.0)
                clean = Image.new(im.mode, im.size)  # solo píxeles: sin info, EXIF, ICC ni XMP
                clean.paste(im)
                out = io.BytesIO()
                clean.save(out, "WEBP", quality=_QUALITY, method=_METHOD, alpha_quality=100)
                return OptimizedImage(out.getvalue(), clean.width, clean.height)
        except ImageDimensionsExceeded, AnimatedImage:
            raise
        except Image.DecompressionBombError:
            raise ImageDimensionsExceeded from None
        except (*_DECODE_ERRORS, ImageCms.PyCMSError):
            raise InvalidImage from None
