import { expect, test } from '@playwright/test';
import { liveEnv, type LiveEnv } from '../tests/helpers/supabase-live';
import { createQaUser, deleteQaUser, type QaUser } from './helpers/admin';

// T-146 · errores del detalle de pedido que NO necesitan pedidos: un id que no es UUID y un pedido inexistente (GET y POST) dan 404,
// con un administrador real. Va aparte de `t146-order-detail.spec.ts` para que un fallo aquí no detenga el recorrido de pedidos reales.
const PORT = process.env.E2E_PORT ?? '4321';
const BASE = `http://localhost:${PORT}`;
const HOOK_TIMEOUT = 120_000;
const NOT_FOUND = 404;
const FOUND = 302;
const FORBIDDEN = 403;
const RANDOM_UUID = '11111111-2222-4333-8444-555555555555';
const BAD_IDS = ['abc', '123', '..%2F..', `${RANDOM_UUID}x`, `x${RANDOM_UUID}`, '%00'];

let env: LiveEnv;
let admin: QaUser;
let customer: QaUser;

test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop', 'usa usuarios reales: se ejecuta una vez (escritorio)'));
test.beforeAll(async ({}, info) => {
  if (info.project.name !== 'desktop') return;
  info.setTimeout(HOOK_TIMEOUT);
  const e = liveEnv();
  if (!e) throw new Error('Supabase local no disponible (npm run db:start)');
  env = e;
  admin = await createQaUser(env, 't146e-admin', 'admin');
  customer = await createQaUser(env, 't146e-cust', 'customer');
});
test.afterAll(async ({}, info) => {
  if (info.project.name !== 'desktop') return;
  info.setTimeout(HOOK_TIMEOUT);
  await deleteQaUser(env, admin);
  await deleteQaUser(env, customer);
});

const opts = { maxRedirects: 0, failOnStatusCode: false } as const;

test.describe('identificador del pedido', () => {
  BAD_IDS.forEach((id) =>
    test(`GET con id «${id}» (no UUID) → 404`, async ({ request }) => {
      expect((await request.get(`${BASE}/admin/pedidos/${id}`, { headers: { cookie: admin.cookie }, ...opts })).status()).toBe(NOT_FOUND);
    }),
  );

  BAD_IDS.forEach((id) =>
    test(`POST con id «${id}» (no UUID) → 404`, async ({ request }) => {
      const res = await request.post(`${BASE}/admin/pedidos/${id}`, { headers: { cookie: admin.cookie, origin: BASE }, form: { _action: 'transition', to: 'cancelado', note: 'x' }, ...opts });
      expect(res.status()).toBe(NOT_FOUND);
    }),
  );

  test('un pedido inexistente (UUID válido) → 404 en GET', async ({ request }) => {
    expect((await request.get(`${BASE}/admin/pedidos/${RANDOM_UUID}`, { headers: { cookie: admin.cookie }, ...opts })).status()).toBe(NOT_FOUND);
  });

  test('un pedido inexistente → 404 también en POST (nunca 500)', async ({ request }) => {
    const res = await request.post(`${BASE}/admin/pedidos/${RANDOM_UUID}`, { headers: { cookie: admin.cookie, origin: BASE }, form: { _action: 'transition', to: 'en_preparacion' }, ...opts });
    expect(res.status()).toBe(NOT_FOUND);
  });

  test('un cliente que prueba un pedido inexistente recibe 403 (no distingue entre existentes e inexistentes)', async ({ request }) => {
    const get = await request.get(`${BASE}/admin/pedidos/${RANDOM_UUID}`, { headers: { cookie: customer.cookie }, ...opts });
    expect(get.status()).toBe(FORBIDDEN);
    const post = await request.post(`${BASE}/admin/pedidos/${RANDOM_UUID}`, { headers: { cookie: customer.cookie, origin: BASE }, form: { _action: 'transition', to: 'cancelado', note: 'x' }, ...opts });
    expect(post.status()).toBe(FORBIDDEN);
  });

  test('sin sesión, un id cualquiera lleva al ingreso (no revela si existe)', async ({ request }) => {
    expect((await request.get(`${BASE}/admin/pedidos/${RANDOM_UUID}`, opts)).status()).toBe(FOUND);
    expect((await request.get(`${BASE}/admin/pedidos/abc`, opts)).status()).toBe(FOUND);
  });
});
