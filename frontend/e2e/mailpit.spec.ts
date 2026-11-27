import { expect, test } from '@playwright/test';
import { firstLink, waitForMail } from './helpers/mailpit';

// T-130: los ayudantes leen el buzón de Mailpit (requiere el stack local: `npm run db:start`).
const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

test('waitForMail encuentra un correo enviado a un destinatario único y firstLink extrae el enlace', async ({ request }, info) => {
  const to = `t130-${Date.now()}-${info.project.name}@example.com`;
  const send = await request.post(`${MAILPIT}/api/v1/send`, {
    data: {
      From: { Email: 'prueba@example.com' },
      To: [{ Email: to }],
      Subject: 'Prueba T-130',
      Text: 'Abre https://example.com/confirmar?token=abc&next=%2Fcuenta ahora',
    },
  });
  expect(send.ok()).toBe(true);
  const mail = await waitForMail(to);
  expect(mail.to).toEqual([to]);
  expect(mail.subject).toBe('Prueba T-130');
  expect(firstLink(mail)).toBe('https://example.com/confirmar?token=abc&next=%2Fcuenta');
});

test('waitForMail falla si no hay correo', async () => {
  await expect(waitForMail('nadie-escribe-a-este-correo@example.invalid', 1_000)).rejects.toThrow(/Sin correo/);
});
