// Contenido editorial de "Nosotros". DEMO (P-9, D-041): texto ficticio redactado para la demostración;
// no copia el prototipo de Figma. Se retira o se confirma antes de producción (grep data-demo-content).
const DEMO_YEAR = 2026;
export const about = {
  demoLabel: 'Contenido de demostración',
  hero: {
    kicker: 'Nosotros',
    title: 'VALMONT reúne en un solo lugar piezas mecánicas elegidas por su precisión, su diseño y su legado.',
    text: 'Somos una boutique de alta relojería con atención cercana: te acompañamos a elegir con calma, sin prisa y con información clara sobre cada reloj.',
  },
  awards: {
    title: 'Nuestros compromisos',
    items: [
      { year: DEMO_YEAR, title: 'Curaduría independiente', description: 'Cada pieza se selecciona por su calibre y su acabado.' },
      { year: DEMO_YEAR, title: 'Atención con cita previa', description: 'Conoce los relojes con tiempo y sin presión.' },
      { year: DEMO_YEAR, title: 'Información transparente', description: 'Precio, disponibilidad y plazos siempre claros.' },
    ],
  },
  placeholder: 'Lima, Perú',
} as const;
