// Textos legales de DEMOSTRACIÓN (D-041, D-024). No son un texto legal definitivo:
// un abogado debe revisarlos y sustituirlos antes de producción.
export interface LegalSection {
  id: string;
  title: string;
  paragraphs: string[];
}
export interface LegalDoc {
  title: string;
  description: string;
  updated: string; // ISO yyyy-mm-dd
  sections: LegalSection[];
}

export const demoNotice =
  'Texto de demostración: no constituye un documento legal definitivo y será revisado por un abogado antes de la publicación.';

export const privacy: LegalDoc = {
  title: 'Política de privacidad',
  description: 'Cómo Valmont trata tus datos personales conforme a la Ley 29733 (texto de demostración).',
  updated: '2026-10-01',
  sections: [
    {
      id: 'responsable',
      title: 'Responsable del tratamiento',
      paragraphs: [
        'Valmont es responsable del banco de datos donde se almacenan tus datos personales, conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su reglamento.',
        'Puedes escribirnos al correo de contacto indicado en la página de Nosotros para cualquier consulta sobre esta política.',
      ],
    },
    {
      id: 'datos',
      title: 'Datos que tratamos y su finalidad',
      paragraphs: [
        'Nombre completo y correo electrónico: crear y gestionar tu cuenta, e identificarte en tus compras.',
        'Fecha de nacimiento: verificar que eres mayor de edad para comprar. No se usa con fines comerciales.',
        'Dirección y datos de entrega: preparar y enviar tus pedidos.',
        'Pagos: el pago es simulado. Solo se trata el nombre del titular y los últimos 4 dígitos de la tarjeta; nunca guardamos el número completo ni el código de seguridad.',
      ],
    },
    {
      id: 'cookies',
      title: 'Cookies',
      paragraphs: [
        'Usamos únicamente cookies de sesión, de tipo httpOnly, necesarias para mantener tu sesión iniciada. No usamos cookies de publicidad.',
      ],
    },
    {
      id: 'derechos',
      title: 'Tus derechos',
      paragraphs: [
        'Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición (ARCO) en cualquier momento, escribiendo a nuestro correo de contacto. Responderemos dentro de los plazos que fija la ley.',
      ],
    },
    {
      id: 'plazo',
      title: 'Plazo de conservación',
      paragraphs: [
        'Conservamos tus datos mientras mantengas tu cuenta y, después, durante el tiempo que exijan las obligaciones legales aplicables. Luego se eliminan o se anonimizan.',
      ],
    },
  ],
};

export const terms: LegalDoc = {
  title: 'Términos y condiciones',
  description: 'Condiciones de uso de la tienda en línea de Valmont (texto de demostración).',
  updated: '2026-10-01',
  sections: [
    {
      id: 'uso',
      title: 'Uso del sitio',
      paragraphs: [
        'Al crear una cuenta o comprar aceptas estos términos. Debes ser mayor de edad para registrarte y comprar.',
        'Eres responsable de la confidencialidad de tus credenciales y de la actividad de tu cuenta.',
      ],
    },
    {
      id: 'precios',
      title: 'Precios, disponibilidad y pedidos',
      paragraphs: [
        'Los precios y la disponibilidad que ves son los vigentes en el momento de la consulta y los confirma siempre el servidor al realizar el pedido. Si una pieza deja de estar disponible, te lo indicaremos antes de cobrar.',
      ],
    },
    {
      id: 'pagos',
      title: 'Pagos simulados',
      paragraphs: [
        'Esta tienda es una demostración: los pagos son simulados y no se realiza ningún cargo real. Solo se conservan los últimos 4 dígitos de la tarjeta.',
      ],
    },
    {
      id: 'cambios',
      title: 'Cambios en estos términos',
      paragraphs: ['Podemos actualizar estos términos; la fecha de la última versión figura al inicio de la página.'],
    },
  ],
};
