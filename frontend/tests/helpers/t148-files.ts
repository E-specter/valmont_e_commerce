// Archivos de imagen de prueba de T-148, generados con bytes (sin Pillow ni lienzo): válidos, inválidos y de borde. Los comparten
// las pruebas unitarias y el E2E (que los importa como `helpers/admin.ts` importa `supabase-live`). Nada se escribe en disco.
import { crc32, deflateSync } from 'node:zlib';

const KIB = 1024;
const MIB_FACTOR = 1024;
const FIVE = 5;
const SIX = 6;
export const MIB = KIB * MIB_FACTOR;
export const FIVE_MIB = FIVE * MIB;
export const SIX_MIB = SIX * MIB;
const PNG_SIGNATURE = Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex'));
const LEN_FIELD = 4; // longitud del fragmento
const TYPE_END = 8; // longitud + tipo
const CHUNK_OVERHEAD = 12; // longitud (4) + tipo (4) + CRC (4)
const IHDR_LENGTH = 13;
const IHDR_HEIGHT_AT = 4;
const IHDR_DEPTH_AT = 8;
const IHDR_COLOR_AT = 9;
const BYTE = 256;
const BIT_DEPTH = 8;
const COLOR_GRAY = 0;
const COLOR_RGB = 2;
const RGB_CHANNELS = 3;
const DEFAULT_SIDE = 64;
const DEFLATE_BEST = 9;
const PRIVATE_CHUNK = 'prVt'; // ancilar, privado, reservado, copiable: cualquier lector lo ignora
export const RGB_BLUE = Uint8Array.from(Buffer.from('285aa0', 'hex'));
const DEFAULT_RGB = RGB_BLUE;
const CORRUPT_RGB = Uint8Array.from(Buffer.from('c83c3c', 'hex'));
const IDAT_DATA_AT = 8; // primer byte de datos tras longitud y tipo
const FLIP = 0xff;

// Muestras generadas con Pillow 13 y verificadas contra el optimizador del backend (T-018i).
const B64 = {
  jpeg:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDmaKKK8g/RAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/9k=',
  webp: 'UklGRk4AAABXRUJQVlA4IEIAAACwAwCdASpAADAAPp1Ook0lpCMiIqgAsBOJZwDTjoAAFRppT6x4YAD+34A/w/v41R//i0OtDrQw/Y/QLXLWSqAAAAA=',
  webpAnimated:
    'UklGRt4AAABXRUJQVlA4WAoAAAACAAAAHwAAHwAAQU5JTQYAAAAAAAAAAABBTk1GWAAAAAAAAAAAAB8AAB8AAGQAAAJWUDggQAAAAFADAJ0BKiAAIAA+bTSWR6QjIiEoCACADYllAHYABMUOHaMAAP7x3I//+uA/+cB/84D+Zb//G83mta3/lvIAAABBTk1GUgAAAAAAAAAAAB8AAB8AAGQAAABWUDggOgAAALQCAJ0BKiAAIAA+bTSWR4KAgAAA2JZQACQp1pR4AAD+8CqD//2tD//a0P/9rQ/lu/52rY+z7/cwAAA=',
  gif: 'R0lGODdhEAAQAIEAAAoKCgAAAAAAAAAAACwAAAAAEAAQAEAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBADs=',
  apng:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAgAAAAIAAAAAAAAAAAAAEACgAAmicj6gAAADtJREFUeJzt0UENADAIBMGjQqqk/oOsSlg+/HYEHMlS93U2ndX1eGDAHyATIRMhEyETIRMhEyETIROFfEpTAWKDh6qrAAAAGmZjVEwAAAABAAAAIAAAACAAAAAAAAAAAAABAAoAAAFUyT4AAAA+ZmRBVAAAAAJ4nO3RQREAQAjDwB5Czr8UZCEhfPhlBZSZ8Lp/LtXpejyw4A+QiZCJkImQiZCJkImQiZCJQgbsaQHuxyn/SwAAAABJRU5ErkJggg==',
};
type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (b64: string): Bytes => new Uint8Array(Buffer.from(b64, 'base64'));

export const jpegBytes = (): Bytes => bytes(B64.jpeg);
export const webpBytes = (): Bytes => bytes(B64.webp);
export const animatedWebpBytes = (): Bytes => bytes(B64.webpAnimated);
export const gifBytes = (): Bytes => bytes(B64.gif);
export const apngBytes = (): Bytes => bytes(B64.apng);
/** Texto plano (un «.png» falso). */
export const textBytes = (): Bytes => new Uint8Array(Buffer.from('esto no es una imagen\n'));

function chunk(type: string, data: Uint8Array): Bytes {
  const out = Buffer.alloc(CHUNK_OVERHEAD + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, LEN_FIELD, 'ascii');
  Buffer.from(data).copy(out, TYPE_END);
  out.writeUInt32BE(crc32(out.subarray(LEN_FIELD, TYPE_END + data.length)), TYPE_END + data.length);
  return new Uint8Array(out);
}

const concat = (parts: Uint8Array[]): Bytes => new Uint8Array(Buffer.concat(parts));

/** PNG sin animación. Con `rgb`, color sólido; sin él, gris 0 (un PNG enorme comprime a unos KiB). */
export function pngBytes(opts: { width?: number; height?: number; rgb?: Uint8Array } = {}): Bytes {
  const { width = DEFAULT_SIDE, height = DEFAULT_SIDE, rgb } = opts;
  const channels = rgb ? RGB_CHANNELS : 1;
  const ihdr = Buffer.alloc(IHDR_LENGTH);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, IHDR_HEIGHT_AT);
  ihdr[IHDR_DEPTH_AT] = BIT_DEPTH;
  ihdr[IHDR_COLOR_AT] = rgb ? COLOR_RGB : COLOR_GRAY;
  const row = Buffer.alloc(1 + width * channels); // filtro 0 + píxeles
  Array.from({ length: width }).forEach((_, x) => (rgb ?? []).forEach((v, i) => (row[1 + x * channels + i] = v % BYTE)));
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: DEFLATE_BEST })), chunk('IEND', new Uint8Array())]);
}

/** El PNG con un fragmento ancilar de relleno justo antes de `IEND`, para que pese exactamente `total` bytes y siga siendo válido. */
export function padPng(png: Uint8Array, total: number): Bytes {
  const need = total - png.length - CHUNK_OVERHEAD;
  if (need < 0) throw new Error(`el PNG ya pesa más de ${total} bytes`);
  const cut = png.length - CHUNK_OVERHEAD; // IEND ocupa 12 bytes
  return concat([png.subarray(0, cut), chunk(PRIVATE_CHUNK, new Uint8Array(need)), png.subarray(cut)]);
}

/** PNG válido de exactamente `total` bytes. */
export const pngOfSize = (total: number): Bytes => padPng(pngBytes({ rgb: DEFAULT_RGB }), total);

/** PNG con la cabecera intacta y un byte de los datos cambiado (el CRC falla): para el backend es `invalid_image`. */
export function corruptPng(): Bytes {
  const png = Uint8Array.from(pngBytes({ rgb: CORRUPT_RGB }));
  const idat = Buffer.from(png).indexOf('IDAT');
  png[idat + IDAT_DATA_AT] ^= FLIP;
  return new Uint8Array(png);
}

/** PNG gris de `width × height` píxeles (cabecera real; comprime a pocos KiB aunque tenga decenas de megapíxeles). */
export const bigPng = (width: number, height: number): Bytes => pngBytes({ width, height });

/** Un `File` de la API web con esos bytes. */
export const asFile = (data: Bytes, name: string, type: string): File => new File([data], name, { type });

const RIFF_AT = 0;
const WEBP_AT = 8;
const TAG = 4;
/** El contenedor es WebP (RIFF…WEBP): lo que el backend guarda tras convertir (T-018i). */
export const isWebp = (data: Uint8Array): boolean =>
  Buffer.from(data.subarray(RIFF_AT, RIFF_AT + TAG)).toString('ascii') === 'RIFF' &&
  Buffer.from(data.subarray(WEBP_AT, WEBP_AT + TAG)).toString('ascii') === 'WEBP';
