import { describe, expect, test } from 'vitest';
import {
  createProduct,
  deleteImage,
  getAdminAttributes,
  getAdminProduct,
  listAdminCategories,
  listAdminProducts,
  publishProduct,
  reorderImages,
  unpublishProduct,
  updateImageAlt,
  updateProduct,
  uploadProductImage,
  type ProductInput,
} from '../../src/lib/api/admin-catalog';
import { cleanQuery, IMAGE_ID, IMAGE_ID_2, MONEY, PRODUCT_ID, recorder, wire } from '../helpers/t144';

// T-144 · lib/api/admin-catalog.ts (STATUS ui §10.5 3.7; catalog SPEC §7). Transporte simulado: método, ruta, consulta y cuerpo exactos.
const BASE = '/catalog/admin';
const PRODUCT = `${BASE}/products/${PRODUCT_ID}`;
const PAGE_TWO = 2;
const PAGE_SIZE = 48;
const KILO = 1024;
const PRICE_ODD = { amount: 125050, currency: 'PEN' } as const;
const CATEGORY_ID = '5e0b1c8d-4a6c-4b0d-8f09-0123456789cd';

const input: ProductInput = {
  sku: 'VAL-0001',
  name: 'Valmont Aurelia',
  description: 'Reloj automático.',
  category_id: CATEGORY_ID,
  price: MONEY,
  order_policy: 'stock',
  specs: [{ label: 'Calibre', value: 'VM-01' }],
};

describe('listAdminProducts', () => {
  test('GET /catalog/admin/products sin cuerpo ni consulta por omisión', async () => {
    const { transport, last } = recorder();
    await listAdminProducts(transport);
    expect(last()).toMatchObject({ method: 'GET', path: `${BASE}/products` });
    expect(last().body).toBeUndefined();
    expect(cleanQuery(last().query)).toEqual({});
  });

  test('envía q, status, page y page_size, y descarta lo demás', async () => {
    const { transport, last } = recorder();
    await listAdminProducts(transport, { q: 'aurelia', status: 'draft', page: PAGE_TWO, page_size: PAGE_SIZE, user_id: 'u', category: 'x' } as never);
    expect(cleanQuery(last().query)).toEqual({ q: 'aurelia', status: 'draft', page: PAGE_TWO, page_size: PAGE_SIZE });
  });
});

describe('lecturas', () => {
  test('getAdminProduct: GET con el id codificado en la ruta', async () => {
    const { transport, last } = recorder();
    await getAdminProduct(transport, PRODUCT_ID);
    expect(last()).toMatchObject({ method: 'GET', path: PRODUCT });
    expect(last().body).toBeUndefined();
    await getAdminProduct(transport, 'a/../b?x#y');
    expect(last().path).toBe(`${BASE}/products/${encodeURIComponent('a/../b?x#y')}`);
  });

  test('listAdminCategories y getAdminAttributes: GET sin consulta ni cuerpo', async () => {
    const { transport, seen } = recorder();
    await listAdminCategories(transport);
    await getAdminAttributes(transport);
    expect(seen.map((r) => [r.method, r.path])).toEqual([
      ['GET', `${BASE}/categories`],
      ['GET', `${BASE}/attributes`],
    ]);
    seen.forEach((r) => {
      expect(r.body).toBeUndefined();
      expect(cleanQuery(r.query)).toEqual({});
    });
  });

  test('devuelven lo recibido sin transformarlo', async () => {
    const attrs = { movements: [], case_materials: [] };
    await expect(getAdminAttributes(recorder(() => attrs).transport)).resolves.toEqual(attrs);
  });
});

describe('createProduct', () => {
  test('POST /catalog/admin/products con el cuerpo recibido, sin añadir claves', async () => {
    const { transport, last } = recorder();
    await createProduct(transport, input);
    expect(last()).toMatchObject({ method: 'POST', path: `${BASE}/products` });
    expect(wire(last().body)).toEqual(input);
  });

  test('el precio viaja como Money en céntimos enteros, tal cual lo recibió', async () => {
    const { transport, last } = recorder();
    await createProduct(transport, input);
    const body = wire(last().body) as { price: { amount: unknown; currency: unknown } };
    expect(body.price).toEqual(MONEY);
    expect(Number.isInteger(body.price.amount)).toBe(true);
  });

  test('case_diameter_mm viaja como cadena decimal (el servidor la acepta, sin pasar por float)', async () => {
    const { transport, last } = recorder();
    await createProduct(transport, { ...input, case_diameter_mm: '40.5' });
    expect((wire(last().body) as { case_diameter_mm: unknown }).case_diameter_mm).toBe('40.5');
  });

  test('no muta el objeto de entrada', async () => {
    const copy = structuredClone(input);
    await createProduct(recorder().transport, copy);
    expect(copy).toEqual(input);
  });
});

describe('updateProduct', () => {
  test('PATCH /catalog/admin/products/{id} con solo lo cambiado', async () => {
    const { transport, last } = recorder();
    await updateProduct(transport, PRODUCT_ID, { name: 'Nuevo nombre' });
    expect(last()).toMatchObject({ method: 'PATCH', path: PRODUCT });
    expect(wire(last().body)).toEqual({ name: 'Nuevo nombre' });
    expect(Object.keys(wire(last().body) as object)).toEqual(['name']);
  });

  test('null se conserva (borra el opcional) y el parche vacío viaja vacío', async () => {
    const { transport, last } = recorder();
    await updateProduct(transport, PRODUCT_ID, { slug: null, movement_code: null, case_diameter_mm: null });
    expect(wire(last().body)).toEqual({ slug: null, movement_code: null, case_diameter_mm: null });
    await updateProduct(transport, PRODUCT_ID, {});
    expect(wire(last().body)).toEqual({});
  });

  test('el precio del parche no se recalcula ni se redondea', async () => {
    const { transport, last } = recorder();
    await updateProduct(transport, PRODUCT_ID, { price: PRICE_ODD });
    expect(wire(last().body)).toEqual({ price: PRICE_ODD });
  });
});

describe('publicar y despublicar', () => {
  test('POST …/publish y …/unpublish sin cuerpo', async () => {
    const { transport, seen } = recorder();
    await publishProduct(transport, PRODUCT_ID);
    await unpublishProduct(transport, PRODUCT_ID);
    expect(seen.map((r) => [r.method, r.path])).toEqual([
      ['POST', `${PRODUCT}/publish`],
      ['POST', `${PRODUCT}/unpublish`],
    ]);
    seen.forEach((r) => expect(r.body).toBeUndefined());
  });
});

describe('imágenes', () => {
  test('uploadProductImage arma un FormData con `file` y `alt`, y nada más', async () => {
    const file = new File([new Uint8Array(KILO)], 'frente.jpg', { type: 'image/jpeg' });
    const { transport, last } = recorder(() => ({ id: IMAGE_ID, url: '/u', alt: 'Frente' }));
    await uploadProductImage(transport, PRODUCT_ID, file, 'Frente del reloj');
    expect(last()).toMatchObject({ method: 'POST', path: `${PRODUCT}/images` });
    const body = last().body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect([...form.keys()].sort()).toEqual(['alt', 'file']);
    expect(form.get('alt')).toBe('Frente del reloj');
    const sent = form.get('file') as File;
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('frente.jpg');
    expect(sent.type).toBe('image/jpeg');
    expect(sent.size).toBe(KILO);
  });

  test('no fija Content-Type a mano (el multipart necesita su boundary)', async () => {
    const { transport, last } = recorder();
    await uploadProductImage(transport, PRODUCT_ID, new File(['x'], 'a.png', { type: 'image/png' }), 'a');
    const names = Object.keys(last().headers ?? {}).map((h) => h.toLowerCase());
    expect(names).not.toContain('content-type');
  });

  test('updateImageAlt: PATCH …/images/{id} con solo {alt}', async () => {
    const { transport, last } = recorder();
    await updateImageAlt(transport, PRODUCT_ID, IMAGE_ID, 'Perfil');
    expect(last()).toMatchObject({ method: 'PATCH', path: `${PRODUCT}/images/${IMAGE_ID}` });
    expect(wire(last().body)).toEqual({ alt: 'Perfil' });
  });

  test('reorderImages: PUT …/images/order con el arreglo de UUID como cuerpo (no un objeto)', async () => {
    const { transport, last } = recorder();
    await reorderImages(transport, PRODUCT_ID, [IMAGE_ID_2, IMAGE_ID]);
    expect(last()).toMatchObject({ method: 'PUT', path: `${PRODUCT}/images/order` });
    expect(Array.isArray(last().body)).toBe(true);
    expect(wire(last().body)).toEqual([IMAGE_ID_2, IMAGE_ID]);
  });

  test('deleteImage: DELETE …/images/{id} sin cuerpo y sin valor de retorno', async () => {
    const { transport, last } = recorder(() => undefined);
    await expect(deleteImage(transport, PRODUCT_ID, IMAGE_ID)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', path: `${PRODUCT}/images/${IMAGE_ID}` });
    expect(last().body).toBeUndefined();
  });

  test('los dos ids se codifican en la ruta (producto e imagen)', async () => {
    const { transport, last } = recorder();
    await deleteImage(transport, 'p/1', 'i?2');
    expect(last().path).toBe(`${BASE}/products/p%2F1/images/i%3F2`);
    await updateImageAlt(transport, 'p/1', 'i#2', 'x');
    expect(last().path).toBe(`${BASE}/products/p%2F1/images/i%232`);
  });
});

describe('seguridad de los cuerpos (RN-09, RN-10)', () => {
  test('ninguna escritura envía user_id, role ni importes calculados por el cliente', async () => {
    const { transport, seen } = recorder();
    await createProduct(transport, input);
    await updateProduct(transport, PRODUCT_ID, { name: 'x' });
    await publishProduct(transport, PRODUCT_ID);
    await updateImageAlt(transport, PRODUCT_ID, IMAGE_ID, 'x');
    await reorderImages(transport, PRODUCT_ID, [IMAGE_ID]);
    const text = JSON.stringify(seen.map((r) => r.body ?? null));
    const BANNED = ['user_id', 'userid', '"role"', 'customer', '"total"', 'subtotal'];
    expect(BANNED.filter((w) => text.toLowerCase().includes(w))).toEqual([]);
  });
});
