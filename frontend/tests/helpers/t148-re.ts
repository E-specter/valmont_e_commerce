// Expresiones regulares de las pruebas de T-148. Cada una con lo que acepta, un caso que casa, otro que no y un enlace de prueba.

// Acepta cada UUID en minúsculas dentro de un texto: "a1111111-1111-4111-8111-111111111111"; rechaza "a1111111-1111".
// https://regex101.com/?regex=%5B0-9a-f%5D%7B8%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B4%7D-%5B0-9a-f%5D%7B12%7D&testString=a1111111-1111-4111-8111-111111111111
export const RE_UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Acepta una etiqueta <img> viva con atributo de evento: "<img src=x onerror=alert(1)>"; rechaza "&lt;img src=x onerror=alert(1)&gt;".
// https://regex101.com/?regex=%3Cimg%5B%5E%3E%5D*onerror&testString=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E
export const RE_LIVE_IMG_EVENT = /<img[^>]*onerror/i;

// Acepta la palabra "imágenes" con o sin tilde: "Este producto aún no tiene imágenes."; rechaza "Sin fotos".
// https://regex101.com/?regex=im%5Ba%C3%A1%5Dgenes&testString=Este%20producto%20a%C3%BAn%20no%20tiene%20im%C3%A1genes
export const RE_IMAGES_WORD = /im[aá]genes/i;

// Acepta un aviso de tope: "Se alcanzó el máximo de imágenes"; rechaza "Sube una imagen".
// https://regex101.com/?regex=m%5Ba%C3%A1%5Dximo%7Cl%5Bi%C3%AD%5Dmite&testString=Se%20alcanz%C3%B3%20el%20m%C3%A1ximo
export const RE_MAX_WORD = /m[aá]ximo|l[ií]mite/i;

// Acepta el verbo que confirma el borrado: "Eliminar"; rechaza "Volver".
// https://regex101.com/?regex=eliminar%7Cborrar&testString=Eliminar
export const RE_CONFIRM_WORD = /eliminar|borrar/i;

// Acepta el botón que descarta el diálogo: "Volver"; rechaza "Eliminar".
// https://regex101.com/?regex=volver%7Ccancelar&testString=Volver
export const RE_BACK_WORD = /volver|cancelar/i;

// Acepta un dígito (la posición en el nombre accesible): "Subir imagen 2"; rechaza "Subir imagen".
// https://regex101.com/?regex=%5Cd&testString=Subir%20imagen%202
export const RE_HAS_DIGIT = /\d/;

// Acepta el anuncio de aria-live con la posición N: "Imagen movida a la posición 2"; rechaza "Imagen movida".
// https://regex101.com/?regex=Imagen%20movida%20a%20la%20posici%C3%B3n%20(%5Cd%2B)&testString=Imagen%20movida%20a%20la%20posici%C3%B3n%202
export const RE_POSITION_MSG = /Imagen movida a la posición (\d+)/;

// Acepta el límite de tamaño dicho en el mensaje: "El archivo supera los 5 MiB"; rechaza "El archivo es grande".
// https://regex101.com/?regex=5%20MiB&testString=El%20archivo%20supera%20los%205%20MiB
export const RE_TOO_BIG_MSG = /5 MiB/;

// Acepta los formatos admitidos en el mensaje: "Formato no admitido: usa JPEG, PNG o WebP"; rechaza "Formato no admitido".
// https://regex101.com/?regex=JPEG%2C%20PNG%20o%20WebP&testString=Formato%20no%20admitido%3A%20usa%20JPEG%2C%20PNG%20o%20WebP
export const RE_TYPE_MSG = /JPEG, PNG o WebP/;

// Acepta el amarillo del anillo de foco: "rgb(255, 217, 0)"; rechaza "rgb(0, 0, 0)".
// https://regex101.com/?regex=rgb%5C(255%2C%20217%2C%200%5C)&testString=rgb(255%2C%20217%2C%200)
export const RE_FOCUS_YELLOW = /rgb\(255, 217, 0\)/;

// Acepta una URL con esquema javascript: "JavaScript:alert(1)"; rechaza "https://x.test/a.webp".
// https://regex101.com/?regex=%5Ejavascript%3A&testString=javascript%3Aalert(1)
export const RE_JS_SCHEME = /^javascript:/i;

// Acepta una URL que termina en .webp: "http://s/x/a1.webp"; rechaza "http://s/x/a1.png".
// https://regex101.com/?regex=%5C.webp%24&testString=http%3A%2F%2Fs%2Fx%2Fa1.webp
export const RE_WEBP_URL = /\.webp$/i;

// Acepta trozos de mensajes técnicos del backend (en inglés): "String should have at most 150 characters"; rechaza "El texto es demasiado largo".
// https://regex101.com/?regex=String%20should%7CField%20required%7Cvalue_error%7Cvalidation_error%7CInput%20should&testString=String%20should%20have%20at%20most%20150%20characters
export const RE_BACKEND_ENGLISH = /String should|Field required|value_error|validation_error|Input should/;

// Acepta la acción "Reintentar": "Reintentar"; rechaza "Volver".
// https://regex101.com/?regex=reintentar&testString=Reintentar
export const RE_RETRY = /reintentar/i;

// Acepta un color hexadecimal literal: "color: #ff0000"; rechaza "color: var(--x)".
// https://regex101.com/?regex=%23%5B0-9a-fA-F%5D%7B3%2C8%7D%5Cb&testString=color%3A%20%23ff0000
export const RE_HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;

// Acepta un color funcional literal: "rgb(1 2 3)"; rechaza "var(--text-primary)".
// https://regex101.com/?regex=rgba%3F%5C(%7Ccolor-mix%5C(&testString=rgb(1%202%203)
export const RE_COLOR_FN = /rgba?\(|color-mix\(/;

// Acepta una declaración font-family: "font-family: serif"; rechaza "font: inherit".
// https://regex101.com/?regex=font-family%5Cs*%3A&testString=font-family%3A%20serif
export const RE_FONT_FAMILY = /font-family\s*:/;

// Acepta el contenido de cada bloque <style>: "<style>a{}</style>"; rechaza "<script>x</script>".
// https://regex101.com/?regex=%3Cstyle%5B%5E%3E%5D*%3E(%5B%5Cs%5CS%5D*%3F)%3C%5C%2Fstyle%3E&testString=%3Cstyle%3Ea%7B%7D%3C%2Fstyle%3E
export const RE_STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/g;

// Acepta una regla dentro de la capa de componentes: "@layer components {"; rechaza "@layer base {".
// https://regex101.com/?regex=%40layer%5Cs%2Bcomponents&testString=%40layer%20components%20%7B
export const RE_LAYER_COMPONENTS = /@layer\s+components/;

// Acepta una importación de lib/server: "from '../../lib/server/admin'"; rechaza "from '../../lib/admin/messages'".
// https://regex101.com/?regex=lib%5C%2Fserver&testString=from%20'..%2F..%2Flib%2Fserver%2Fadmin'
export const RE_LIB_SERVER = /lib\/server/;

// Acepta una llamada de red desde la isla: "fetch("/api/v1/x")"; rechaza "form.requestSubmit()".
// https://regex101.com/?regex=%5Cbfetch%5C(%7CXMLHttpRequest%7CsendBeacon&testString=fetch(%22%2Fapi%2Fv1%2Fx%22)
export const RE_NETWORK_CALL = /\bfetch\(|XMLHttpRequest|sendBeacon/;

// Acepta un volcado de HTML sin escapar: "el.innerHTML = x"; rechaza "el.textContent = x".
// https://regex101.com/?regex=%5C.innerHTML%5Cs*%3D%7CinsertAdjacentHTML%7Cdocument%5C.write%7C%5Cbeval%5C(&testString=el.innerHTML%20%3D%20x
export const RE_DOM_SINK = /\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/;

// Acepta una directiva set:html: "<p set:html={x} />"; rechaza "<p>{x}</p>".
// https://regex101.com/?regex=set%3Ahtml&testString=%3Cp%20set%3Ahtml%3D%7Bx%7D%20%2F%3E
export const RE_SET_HTML = /set:html/;

// Acepta una URL de imagen guardada con /storage/ en la ruta: "http://s/storage/v1/object/public/products/a.webp"; rechaza "http://s/a.webp".
// https://regex101.com/?regex=%5C%2Fstorage%5C%2Fv1%5C%2Fobject%5C%2Fpublic%5C%2Fproducts%5C%2F&testString=http%3A%2F%2Fs%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fproducts%2Fa.webp
export const RE_STORAGE_PATH = /\/storage\/v1\/object\/public\/products\//;

// Acepta un tamaño de letra en píxeles: "font-size: 14px"; rechaza "font-size: var(--text-caption)".
// https://regex101.com/?regex=font-size%5Cs*%3A%5Cs*%5B%5Cd.%5D%2Bpx&testString=font-size%3A%2014px
export const RE_FONT_PX = /font-size\s*:\s*[\d.]+px/;

// Acepta un registro en consola: "console.log(x)"; rechaza "consoleLike(x)".
// https://regex101.com/?regex=%5Cbconsole%5C.%5Cw%2B%5C(&testString=console.log(x)
export const RE_CONSOLE = /\bconsole\.\w+\(/;

// Acepta una cabecera Content-Type escrita a mano: "'Content-Type': 'multipart/form-data'"; rechaza "contentLength".
// https://regex101.com/?regex=content-type&testString='Content-Type'%3A%20'multipart%2Fform-data'
export const RE_CONTENT_TYPE = /content-type/i;

// Acepta un comentario HTML: "<!-- nota -->"; rechaza "<p>nota</p>".
// https://regex101.com/?regex=%3C!--%5B%5Cs%5CS%5D*%3F--%3E&testString=%3C!--%20nota%20--%3E
export const RE_HTML_COMMENT = /<!--[\s\S]*?-->/g;

// Acepta la etiqueta de un campo de texto alternativo: "Texto alternativo"; rechaza "Descripción".
// https://regex101.com/?regex=texto%20alternativo&testString=Texto%20alternativo
export const RE_ALT_LABEL = /texto alternativo/i;

// Acepta el nombre accesible de «Subir»: "Subir imagen 2"; rechaza "Bajar imagen 2".
// https://regex101.com/?regex=%5Esubir&testString=Subir%20imagen%202
export const RE_UP_BTN = /^subir/i;

// Acepta el nombre accesible de «Bajar»: "Bajar imagen 2"; rechaza "Subir imagen 2".
// https://regex101.com/?regex=%5Ebajar&testString=Bajar%20imagen%202
export const RE_DOWN_BTN = /^bajar/i;

// Acepta el nombre accesible de «Eliminar»: "Eliminar imagen 3"; rechaza "Volver".
// https://regex101.com/?regex=%5Eeliminar&testString=Eliminar%20imagen%203
export const RE_DEL_BTN = /^eliminar/i;

// Acepta el botón que guarda el texto de una imagen: "Guardar texto"; rechaza "Eliminar".
// https://regex101.com/?regex=guardar&testString=Guardar%20texto
export const RE_SAVE_BTN = /guardar/i;

// Acepta la imagen principal de la ficha de la tienda: 'data-gallery-main src="http://s/a.webp"'; rechaza "<img src=x>".
// https://regex101.com/?regex=data-gallery-main%5B%5E%3E%5D*src%3D%22(%5B%5E%22%5D%2B)%22&testString=data-gallery-main%20src%3D%22http%3A%2F%2Fs%2Fa.webp%22
export const RE_GALLERY_MAIN = /data-gallery-main[^>]*src="([^"]+)"|src="([^"]+)"[^>]*data-gallery-main/;

// Acepta cada miniatura de la ficha de la tienda: 'data-gallery-thumb href="http://s/b.webp"'; rechaza '<a href="/x">'.
// https://regex101.com/?regex=data-gallery-thumb%5B%5E%3E%5D*href%3D%22(%5B%5E%22%5D%2B)%22&testString=data-gallery-thumb%20href%3D%22http%3A%2F%2Fs%2Fb.webp%22
export const RE_GALLERY_THUMBS = /data-gallery-thumb[^>]*href="([^"]+)"|href="([^"]+)"[^>]*data-gallery-thumb/g;
