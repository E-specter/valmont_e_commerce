// Contenido editorial de la portada. DEMO (P-9, D-041): texto de ejemplo redactado para la demo,
// no es contenido de marca confirmado; se retira o se confirma antes de producción.
export const home = {
  hero: {
    title: 'Donde la tradición relojera se encuentra con la innovación mecánica.',
    ctaLabel: 'Explorar',
    ctaHref: '/relojes',
    imageAlt: 'Reloj mecánico de pulsera con esfera esqueletada, fotografiado de cerca sobre la muñeca.',
  },
  manifesto: {
    text: 'VALMONT es una boutique de alta relojería que reúne piezas mecánicas elegidas por su precisión, su diseño y su legado.',
    linkLabel: 'Conoce nuestra historia',
    linkHref: '/nosotros',
  },
  featuredBadge: 'Novedad',
  featuredCta: 'Ver reloj',
  collections: { cta: 'Explorar colección', allLabel: 'Ver todos los relojes', allHref: '/relojes' },
  stores: {
    title: 'Descubre la excelencia de VALMONT. Visítanos y vive una experiencia de alta relojería a tu medida.',
    text: 'Te atendemos con cita previa para que conozcas cada pieza con calma.',
    linkLabel: 'Contáctanos',
    linkHref: '/nosotros#contacto',
  },
} as const;
