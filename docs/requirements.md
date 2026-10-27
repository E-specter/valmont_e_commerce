# Requisitos — Valmont_E_Commerce

> Fuente canónica de objetivos, alcance, requisitos funcionales (RF), no funcionales (RNF) y reglas de negocio (RN).
> Origen: [prompt_maestro.md](prompt_maestro.md) §2, §5, §6, §7. Si este documento y el prompt maestro discrepan, prevalece el prompt maestro salvo decisión registrada en [decisions.md](decisions.md).

## Reglas de edición (vinculantes para todos los agentes)

1. **Identificadores estables.** `RFnn` es el grupo; `RFnn.mm` es un requisito atómico. Nunca se renumera. Lo nuevo recibe el siguiente número libre del grupo.
2. **No se borra:** un requisito obsoleto pasa a estado `RETIRADO` con motivo.
3. **Un requisito = una capacidad verificable.** Casos de borde como "Si <condición>, entonces <comportamiento>".
4. **Referencias cruzadas por ID** (`según RN-05`), sin copiar texto.
5. Estados: `PROPUESTO` · `APROBADO` · `IMPLEMENTADO` · `VERIFICADO` · `RETIRADO`. Prioridad: `MVP` · `POSTERIOR`.
6. Todo cambio se anota en el [registro de cambios](#registro-de-cambios).
7. La skill de usuario `actualizar-requerimientos-rf` **no aplica** a este proyecto (dominio de cobranzas y renumera; ver D-003).

## 1. Objetivos

| ID | Objetivo |
|---|---|
| OE01 | Catálogo virtual para consultar, buscar y filtrar relojes por sus características. |
| OE02 | Automatizar la compra: carrito, pedido, modalidad de entrega y registro de pagos. |
| OE03 | Panel administrativo de productos, inventario, pedidos y reportes básicos. |
| OE04 | Asistente inteligente que recomiende relojes disponibles según presupuesto, estilo y preferencias. |
| OE05 | Seguridad, integridad y trazabilidad de las operaciones comerciales. |
| OE06 | Arquitectura modular, mantenible, comprobable y extensible. |
| OE07 | Continuidad mediante documentación persistente y coordinación multiagente. |
| OE08 | Control de calidad verificable, pruebas automatizadas y gestión de cambios. |

## 2. Alcance

**MVP:** RF01–RF14 con prioridad `MVP`; pagos **simulados**; un único asistente con tres modos.

**Fuera del alcance inicial** (salvo decisión posterior): pagos monetarios reales, integración con operadores logísticos, automatización de marketing, app móvil nativa, microservicios desplegados por separado, entrenamiento de modelos propios, infraestructura distribuida.

## 3. Glosario

| Término | Significado |
|---|---|
| Cliente | Usuario registrado con rol `customer`. |
| Visitante | Usuario sin sesión. |
| Administrador | Usuario con rol `admin` (u otros roles administrativos que se aprueben). |
| Producto | Reloj comercializable con atributos técnicos y estéticos. |
| Compra | Proceso de checkout que **origina** un pedido; no es una entidad propia (RN-01). |
| Pedido | Registro de una compra confirmada con sus líneas, entrega y estado. |
| Línea de pedido | Producto + cantidad + instantánea comercial (nombre, SKU, precio, descuento). |
| Artículo seleccionado | Artículo del carrito marcado para la compra actual (RN-05). |
| Intento de pago | Registro de un intento de cobro (simulado en el MVP) asociado a un pedido. |
| Modo del asistente | Una de las tres funciones del asistente (RF08.01–RF08.03). |

## 4. Requisitos funcionales

### RF01 — Gestión de usuarios · módulo `identity`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF01.01 | Permitir que un visitante registre una cuenta de cliente. | MVP | PROPUESTO |
| RF01.02 | Permitir que un usuario registrado inicie sesión. | MVP | PROPUESTO |
| RF01.03 | Permitir cerrar la sesión activa. | MVP | PROPUESTO |
| RF01.04 | Permitir recuperar el acceso a la cuenta (mecanismo según D-009). | POSTERIOR | PROPUESTO |
| RF01.05 | Validar la sesión en el backend en cada solicitud protegida. | MVP | PROPUESTO |
| RF01.06 | Permitir que el cliente consulte y edite sus datos básicos de perfil. | MVP | PROPUESTO |

### RF02 — Catálogo · módulo `catalog`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF02.01 | Listar los productos publicados con paginación. | MVP | PROPUESTO |
| RF02.02 | Buscar productos por texto. | MVP | PROPUESTO |
| RF02.03 | Filtrar por categoría, tipo de movimiento, material, diámetro, resistencia al agua, rango de precio y disponibilidad (lista ampliable). | MVP | PROPUESTO |
| RF02.04 | Ordenar por precio, novedad y relevancia. | MVP | PROPUESTO |
| RF02.05 | Mostrar la ficha de producto: características técnicas y estéticas, precio vigente, disponibilidad e imágenes. | MVP | PROPUESTO |
| RF02.06 | Mostrar productos relacionados. | MVP | PROPUESTO |
| RF02.07 | Admitir atributos de relojería opcionales por producto. Si un atributo no aplica, no se muestra. | MVP | PROPUESTO |

### RF03 — Carrito · módulo `cart`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF03.01 | Agregar un producto disponible al carrito. | MVP | PROPUESTO |
| RF03.02 | Modificar la cantidad de un artículo cuando el producto lo permita. | MVP | PROPUESTO |
| RF03.03 | Retirar un artículo del carrito. | MVP | PROPUESTO |
| RF03.04 | Marcar o desmarcar un artículo como seleccionado para la compra (RN-05). | MVP | PROPUESTO |
| RF03.05 | Mostrar subtotales y total calculados en el servidor sobre los artículos seleccionados (RN-09). | MVP | PROPUESTO |
| RF03.06 | Validar la disponibilidad al agregar y al confirmar la compra. Si no hay stock suficiente, informar y no crear el pedido. | MVP | PROPUESTO |
| RF03.07 | Mantener un único carrito activo por cliente (RN-02). | MVP | PROPUESTO |

### RF04 — Pedidos · módulo `orders`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF04.01 | Crear un pedido con los artículos seleccionados de un carrito validado (RN-05, RN-06). | MVP | PROPUESTO |
| RF04.02 | Guardar por línea una instantánea comercial: nombre, SKU, precio unitario y descuento aplicado (RN-04). | MVP | PROPUESTO |
| RF04.03 | Registrar la modalidad de entrega y los datos que exija. | MVP | PROPUESTO |
| RF04.04 | Permitir que el cliente cancele un pedido propio si su estado lo admite (RN-08). | MVP | PROPUESTO |
| RF04.05 | Calcular y validar el importe en el servidor (RN-09). | MVP | PROPUESTO |
| RF04.06 | Si un pedido sigue sin pagar 30 minutos después de crearse, pasa a `expirado` y su reserva deja de contar (RN-06). | MVP | APROBADO |

### RF05 — Pagos · módulo `payments`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF05.01 | Registrar intentos de pago simulados asociados a un pedido. | MVP | PROPUESTO |
| RF05.02 | Registrar el resultado de cada intento y actualizar el estado de pago del pedido. | MVP | PROPUESTO |
| RF05.03 | Hacer idempotente el registro del resultado: el mismo resultado repetido no duplica efectos. | MVP | PROPUESTO |
| RF05.04 | No almacenar datos sensibles de tarjetas (RN-11). | MVP | PROPUESTO |
| RF05.05 | Registrar un reembolso simulado cuando un administrador cancela un pedido pagado (RN-08). | MVP | APROBADO |

### RF06 — Productos e inventario · módulos `catalog`, `inventory`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF06.01 | Permitir al administrador crear, editar, publicar y despublicar productos. | MVP | PROPUESTO |
| RF06.02 | Gestionar categorías y atributos de producto. | MVP | PROPUESTO |
| RF06.03 | Gestionar imágenes y recursos de producto. | MVP | PROPUESTO |
| RF06.04 | Registrar entradas y ajustes de stock con motivo y actor (RF14.01). | MVP | PROPUESTO |
| RF06.05 | Reservar o descontar stock al confirmar un pedido según RN-06. | MVP | PROPUESTO |
| RF06.06 | Impedir que el stock quede por debajo de cero (RN-06). | MVP | PROPUESTO |

### RF07 — Reportes · módulo `reports`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF07.01 | Generar un reporte de ventas por período. | MVP | PROPUESTO |
| RF07.02 | Generar un reporte de productos más vendidos. | MVP | PROPUESTO |
| RF07.03 | Generar un reporte de pedidos por estado. | MVP | PROPUESTO |
| RF07.04 | Calcular los períodos de los reportes en la zona horaria `America/Lima`; las ventas cuentan lo pagado menos lo reembolsado (D-015, D-016). | MVP | APROBADO |

### RF08 — Asistente inteligente · módulo `assistant`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF08.01 | Modo `/acerca_de_un_producto_específico`: responder sobre productos con datos recuperados del catálogo. Si falta información, decirlo y no inventar. | MVP | PROPUESTO |
| RF08.02 | Modo `/acerca_de_mi_pedido`: responder solo sobre pedidos del usuario autenticado; la identidad sale del contexto validado por el backend, nunca del mensaje. | MVP | PROPUESTO |
| RF08.03 | Modo `/recomendaciones_guiadas_inferencial`: hacer preguntas progresivas e inferir preferencias, distinguiendo las confirmadas de las inferidas. | MVP | PROPUESTO |
| RF08.04 | Explicar por qué se recomienda cada producto. | MVP | PROPUESTO |
| RF08.05 | Recomendar solo productos existentes y disponibles (RN-14). | MVP | PROPUESTO |
| RF08.06 | Permitir que el usuario corrija las preferencias inferidas. | MVP | PROPUESTO |
| RF08.07 | Si el proveedor de IA no está disponible, responder con un modo degradado sin bloquear la navegación ni la compra. | MVP | PROPUESTO |
| RF08.08 | No inferir características sensibles ni construir perfiles personales innecesarios. | MVP | PROPUESTO |

### RF09 — Promociones · módulo `promotions`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF09.01 | Permitir al administrador crear, editar y desactivar promociones con vigencia. | MVP | PROPUESTO |
| RF09.02 | Aplicar las promociones vigentes al precio mostrado y al importe calculado en el servidor. | MVP | PROPUESTO |

### RF10 — Lista de deseos · módulo `wishlist`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF10.01 | Agregar un producto a la lista de deseos. | MVP | PROPUESTO |
| RF10.02 | Retirar un producto de la lista de deseos. | MVP | PROPUESTO |
| RF10.03 | Consultar los productos guardados. | MVP | PROPUESTO |
| RF10.04 | Evitar duplicados por cliente y producto (RN-03). | MVP | PROPUESTO |

### RF11 — Perfil e historial · módulos `identity`, `orders`, `wishlist`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF11.01 | Mostrar el historial de pedidos propios. | MVP | PROPUESTO |
| RF11.02 | Gestionar preferencias de estilo y presupuesto que el asistente puede usar. | MVP | PROPUESTO |
| RF11.03 | Dar acceso al asistente desde el perfil. | MVP | PROPUESTO |

### RF12 — Seguimiento de pedidos · módulo `orders`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF12.01 | Consultar el detalle y el historial de estados de un pedido propio. | MVP | PROPUESTO |
| RF12.02 | Registrar cada cambio de estado con fecha, actor y estado anterior y nuevo. | MVP | PROPUESTO |

### RF13 — Autorización y operaciones administrativas · módulo `identity` + módulos afectados

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF13.01 | Definir como mínimo los roles `customer` y `admin`. | MVP | PROPUESTO |
| RF13.02 | Proteger en el backend todo endpoint administrativo; ocultar controles en el frontend no cuenta como autorización. | MVP | PROPUESTO |
| RF13.03 | Permitir al administrador consultar pedidos y cambiar su estado solo por transiciones válidas (RN-07). | MVP | PROPUESTO |
| RF13.04 | Permitir al administrador consultar clientes según los permisos de su rol. | MVP | PROPUESTO |

### RF14 — Auditoría · módulo `audit`

| ID | Requisito | Prioridad | Estado |
|---|---|---|---|
| RF14.01 | Registrar las operaciones críticas (precio, stock, estado de pedido, pagos, roles) con actor, fecha, entidad, valor anterior y nuevo. | MVP | PROPUESTO |
| RF14.02 | Hacer los registros de auditoría de solo inserción: no editables ni borrables desde la aplicación. | MVP | PROPUESTO |

## 5. Requisitos no funcionales

Los umbrales son **propuestas** pendientes de validación por el usuario; no son requisitos aprobados.

| ID | Requisito | Umbral propuesto | Estado |
|---|---|---|---|
| RNF01 | Usabilidad | Checkout en ≤ 3 pantallas desde el carrito. | PROPUESTO |
| RNF02 | Seguridad | Referencia OWASP ASVS nivel 1; secretos fuera del repositorio; autorización en el backend. | PROPUESTO |
| RNF03 | Rendimiento | API de lectura p95 < 300 ms con datos de prueba; LCP < 2,5 s en catálogo y ficha. | PROPUESTO |
| RNF04 | Compatibilidad | Últimas 2 versiones de Chrome, Edge, Firefox y Safari; ancho móvil desde 360 px. | PROPUESTO |
| RNF05 | Mantenibilidad | Arquitectura hexagonal por módulo; lint y formato sin errores; sin importaciones de dominio entre módulos. | PROPUESTO |
| RNF06 | Disponibilidad | Sin SLA en el MVP (decisión pendiente para producción). | PENDIENTE |
| RNF07 | Accesibilidad | WCAG 2.2 nivel AA. | PROPUESTO |
| RNF08 | Integridad de datos | Restricciones en BD y transacciones en pedidos, stock y pagos. | PROPUESTO |
| RNF09 | Observabilidad | Logs estructurados con id de solicitud; endpoint `/health`. | PROPUESTO |
| RNF10 | Datos personales | Minimización; datos mínimos al proveedor de IA; cumplimiento de la Ley 29733 y su reglamento (Perú, D-015). | APROBADO |
| RNF11 | Testabilidad | Dominio comprobable sin BD ni red; reglas críticas con pruebas unitarias. | PROPUESTO |
| RNF12 | Recuperación ante fallos | Copias de PostgreSQL y procedimiento de restauración probado antes de producción. | PROPUESTO |

## 6. Reglas de negocio

| ID | Regla | Estado |
|---|---|---|
| RN-01 | Un cliente puede tener múltiples pedidos. "Compra" es el proceso que origina un pedido, no otra entidad. | PROPUESTO (H-01) |
| RN-02 | Un cliente tiene como máximo un carrito activo. En el MVP el carrito exige sesión; el visitante solo navega el catálogo. | PROPUESTO (H-02) |
| RN-03 | La lista de deseos no admite duplicados (cliente, producto). | PROPUESTO |
| RN-04 | Un pedido contiene una o más líneas con su instantánea comercial; cambios posteriores del catálogo no alteran pedidos existentes. | PROPUESTO |
| RN-05 | Cada artículo del carrito tiene el indicador `seleccionado` (por defecto verdadero). Solo los seleccionados entran al pedido. Al crearse el pedido se retiran del carrito los seleccionados; los no seleccionados permanecen. | PROPUESTO |
| RN-06 | El stock nunca es negativo. Al crear el pedido, cada línea se reserva con una única sentencia condicional (`UPDATE … WHERE disponible >= cantidad`); si no actualiza filas, no hay stock y el pedido no se crea. La reserva vence a los 30 minutos (RF04.06) y la disponibilidad solo cuenta reservas vigentes. Al pagar, la reserva se convierte en descuento de stock; si el pedido se cancela o vence, se libera. | APROBADO (D-017) |
| RN-07 | Un pedido solo cambia de estado por transiciones definidas en la especificación de `orders`. | PROPUESTO |
| RN-08 | El cliente solo puede cancelar pedidos en `pendiente_pago`. Un administrador puede cancelar un pedido pagado antes del envío; esa cancelación registra un reembolso simulado (RF05.05). | APROBADO (D-016) |
| RN-09 | Los importes se calculan en el servidor; el cliente nunca envía precios ni totales. | PROPUESTO |
| RN-10 | Un cliente solo accede a sus propios datos, pedidos y recomendaciones. | PROPUESTO |
| RN-11 | No se almacenan datos sensibles de tarjetas; en el MVP los pagos son simulados. | PROPUESTO |
| RN-12 | Hay una sola interfaz de asistente con tres modos; no son tres agentes de IA independientes. | PROPUESTO |
| RN-13 | Un cliente puede recibir múltiples recomendaciones; se registran para trazabilidad. | PROPUESTO |
| RN-14 | Precio, stock, disponibilidad y estado de pedidos se obtienen siempre de la fuente de datos autorizada, nunca de la memoria del modelo. | PROPUESTO |
| RN-15 | Los importes se expresan en soles (PEN) como enteros en céntimos. | APROBADO (D-015) |

### Hipótesis abiertas

| ID | Hipótesis conservadora | Impacto si cambia |
|---|---|---|
| H-01 | Compra = proceso; Pedido = entidad. | Modelo de datos de `orders`. |
| H-02 | Carrito solo con sesión en el MVP. | Requeriría carrito de invitado y su fusión al iniciar sesión. |
| H-03 | ~~Reserva de stock al crear el pedido (no al pagar).~~ **Resuelta por D-017.** | — |

## Registro de cambios

- **2026-10-26 — v0.2 (claude-leader):** decisiones del usuario D-015, D-016 y D-017. Nuevos: RF04.06, RF07.04 y RN-15. Modificados: RN-06 (reserva atómica con vencimiento), RN-08 (quién cancela), RF05.05 (POSTERIOR → MVP, reembolso simulado) y RNF10 (Ley 29733). H-03 resuelta. Ningún ID cambió de número.
- **2026-10-26 — v0.1 (claude-leader):** documento creado desde cero a partir del prompt maestro. RF01–RF14 desglosados en requisitos atómicos, RNF01–RNF12 con umbrales propuestos, RN-01–RN-14 y H-01–H-03. Todo en estado `PROPUESTO`.
