// Buzón de Mailpit del stack local (supabase/config.toml, puerto 54324). Solo lectura de correos de prueba.
const BASE = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54324';

export type Mail = { id: string; to: string[]; subject: string; text: string; html: string };

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`Mailpit ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Espera el correo más reciente enviado a `to` (hasta `timeoutMs`). Cada ejecución usa un correo único. */
export async function waitForMail(to: string, timeoutMs = 15_000): Promise<Mail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await json<{ messages: { ID: string }[] }>(
      `/api/v1/search?query=${encodeURIComponent(`to:${to}`)}&limit=1`,
    );
    if (list.messages.length > 0) {
      const m = await json<{ ID: string; To: { Address: string }[]; Subject: string; Text: string; HTML: string }>(
        `/api/v1/message/${list.messages[0].ID}`,
      );
      return { id: m.ID, to: m.To.map((a) => a.Address), subject: m.Subject, text: m.Text, html: m.HTML };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Sin correo para ${to} tras ${timeoutMs} ms`);
}

/** Primer enlace http(s) del cuerpo (p. ej. el de confirmación). */
export function firstLink(mail: Mail): string {
  const m = /https?:\/\/[^\s"'<>]+/.exec(mail.text || mail.html);
  if (!m) throw new Error('El correo no trae enlaces');
  return m[0].replace(/&amp;/g, '&');
}
