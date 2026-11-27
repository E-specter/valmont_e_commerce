import type { ProductDetail, ProductImage } from '../../src/lib/api/catalog';

// T-125 · datos de prueba de `ProductDetail` (catalog §7). Los valores son ficticios; ninguno imita un secreto (N-5).
const PRICE = 8450000;
const ORIGINAL = 9900000;
const DISCOUNT = 1450000;
const DIAMETER_MM = 40;
const WATER_M = 100;

export const pen = (amount: number): { amount: number; currency: 'PEN' } => ({ amount, currency: 'PEN' });

export const image = (n: number, alt = `Reloj, vista ${n}`): ProductImage => ({
  id: `img-${n}`,
  url: `https://img.example.test/watch-${n}.jpg`,
  alt,
});

export const detail = (over: Partial<ProductDetail> = {}): ProductDetail => ({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'tourbillon-aurora',
  sku: 'TA-0001',
  name: 'Tourbillon Aurora',
  category: { slug: 'clasica', name: 'Clásica' },
  price: pen(PRICE),
  original_price: null,
  discount_amount: null,
  movement: { code: 'automatic', label: 'Automático' },
  case_material: { code: 'gold', label: 'Oro Amarillo 18K' },
  case_diameter_mm: DIAMETER_MM,
  water_resistance_m: WATER_M,
  main_image: image(1, 'Tourbillon Aurora, vista frontal'),
  availability: { status: 'in_stock', lead_time_days: null },
  description: 'Un reloj de alta relojería.\nMovimiento automático.',
  specs: [{ label: 'Calibre', value: 'V-100' }],
  images: [image(1, 'Tourbillon Aurora, vista frontal')],
  related: [],
  ...over,
});

export const promo = (over: Partial<ProductDetail> = {}): ProductDetail =>
  detail({ original_price: pen(ORIGINAL), discount_amount: pen(DISCOUNT), ...over });
